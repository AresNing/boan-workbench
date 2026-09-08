import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { attention, overview } from './store.mjs';
import { scopedPath, listFiles } from './files.mjs';
import { importAttachment, attachmentText, boundaries } from './attachments.mjs';
import { artifactChange } from './artifact-changes.mjs';

export function createServer(store, engine, config) {
  const clients = new Set();
  const state = () => ({ ...store.snapshot(), attentionIds: attention(store.data.tasks).map(t => t.id), overview: overview(store.data.tasks), permissions: engine.permissions(), modelOptions: engine.backend.options?.() || [], defaultModel: config.defaultModel || null, managerBusy: engine.managerBusy, preparation: engine.preparation || null });
  const broadcast = () => { const data = `data: ${JSON.stringify(state())}\n\n`; for (const client of clients) client.write(data); };
  store.on('change', broadcast);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (config.accessToken) {
        const provided = Buffer.from(String(req.headers['x-workbench-token'] || ''));
        const expected = Buffer.from(config.accessToken);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(401, { error: '需要桌面应用授权' });
      }
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(403, { error: '仅允许本机访问' });
      if (req.headers.origin && ![`http://${host}`, 'http://127.0.0.1:5173'].includes(req.headers.origin)) return json(403, { error: '不允许跨站请求' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: '不允许跨站请求' });
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state());
      if (req.method === 'GET' && url.pathname === '/api/files') {
        const files=[];
        for(const file of await listFiles(config.projectPath,'.',{exclude:['release','test-results','playwright-report']})) { try { await scopedPath(config.projectPath,file,boundaries(config)); if(!file.startsWith('release/'))files.push(file); } catch {} }
        return json(200,{files});
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(state())}\n\n`); clients.add(res);
        const heartbeat = setInterval(() => res.write(`data: ${JSON.stringify(state())}\n\n`), 15000);
        req.on('close', () => { clients.delete(res); clearInterval(heartbeat); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/artifact') {
        const task = store.task(url.searchParams.get('taskId'));
        const relative = url.searchParams.get('path');
        if (!task.artifacts.includes(relative)) return json(404, { error: '成果不存在' });
        const file = await scopedPath(config.projectPath, relative, { protectedRoots: config.mode === 'demo' ? [] : [config.dataDir, config.appDataDir, config.codexHome,config.commandLifecycle?.root] });
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }[path.extname(file).toLowerCase()];
        if ((await fs.stat(file)).size > (mime ? 8_000_000 : 500000)) return json(413, { error: '文件过大，请在本地查看' });
        if (mime && mime !== 'image/svg+xml') return json(200, { path: relative, mime, base64: (await fs.readFile(file)).toString('base64') });
        const content = await fs.readFile(file, 'utf8');
        return json(200, { path: relative, mime, content, change: await artifactChange(config, task.id, relative, content) });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '请求必须使用 JSON' });
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > (url.pathname === '/api/attachments' ? 11_010_000 : 32000)) return json(413, { error: '输入过长' }); }
        let body; try { body = JSON.parse(raw); } catch { return json(400, { error: '无效的请求内容' }); }
        if(url.pathname === '/api/attachments') return json(200,await importAttachment(config,body));
        if (url.pathname === '/api/permissions') { engine.setPermissions(body); return json(200, state()); }
        if (url.pathname === '/api/messages') {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 12000) return json(400, { error: '请填写有效要求（最多 12000 字）' });
          if (body.focusId) store.task(body.focusId);
          if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[\w-]{1,80}$/.test(body.requestId))) return json(400, { error: '请求标识无效' });
          const materials = await attachmentText(config,body.attachments);
          const reply = await engine.message(body.text.trim()+materials, body.focusId || null, body.requestId, body.modelSelection); return json(200, reply);
        }
        const action = url.pathname.match(/^\/api\/tasks\/([^/]+)\/actions$/);
        if (action) { await engine.action(action[1], body.type, body); return json(200, state()); }
        return json(404, { error: '接口不存在' });
      }
      if (url.pathname.startsWith('/api/')) return json(404, { error: '接口不存在' });
      if (req.method !== 'GET') return json(405, { error: '不支持的请求方式' });
      const relative = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\//, '');
      const file = path.resolve(config.distDir, relative);
      if (!file.startsWith(config.distDir + path.sep)) return json(403, { error: '路径无效' });
      try {
        const data = await fs.readFile(file);
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type }); res.end(data);
      } catch (err) { if (err.code === 'ENOENT') json(404, { error: '页面未构建。请先运行 npm run build。' }); else throw err; }
    } catch (err) { if (!res.headersSent) json(400, { error: err.message }); else res.end(); }
  });
  server.on('close', () => { store.off('change', broadcast); for (const c of clients) c.end(); });
  server.closeStreams = () => { for (const c of clients) c.end(); clients.clear(); };
  return server;
}
