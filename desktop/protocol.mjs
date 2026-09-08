import fs from 'node:fs/promises';
import path from 'node:path';

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
const json = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

export function workbenchProtocol({ distDir, getBackend, accessToken, fetchBackend }) {
  return async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'workbench' || url.port || url.username || url.password) return json(403, '不允许访问此地址');
    if (url.pathname.startsWith('/api/')) {
      // A request belongs to the backend selected when it began, never a later project.
      const backend = getBackend(request.headers.get('x-workbench-project') || url.searchParams.get('projectId'));
      if (!backend) return json(503, '工作区正在切换，请稍后重新连接。');
      try {
        const requestHeaders = { 'x-workbench-token': accessToken };
        if (request.headers.has('content-type')) requestHeaders['content-type'] = request.headers.get('content-type');
        const options = { method: request.method, headers: requestHeaders, redirect: 'error', signal: request.signal };
        if (!['GET', 'HEAD'].includes(request.method)) options.body = await request.arrayBuffer();
        return await fetchBackend(`${backend.url}${url.pathname}${url.search}`, options);
      } catch { return json(503, '后台连接暂时中断，请重新连接。任务记录仍保存在本机。'); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json(405, '不支持的请求方式');
    try {
      // UI assets are bundled with the app and must not depend on a restarting worker.
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const root = await fs.realpath(distDir);
      const target = path.resolve(root, relative);
      if (!target.startsWith(root + path.sep)) return json(403, '路径无效');
      const resolved = await fs.realpath(target);
      if (!resolved.startsWith(root + path.sep)) return json(403, '路径无效');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }[path.extname(resolved)];
      if (!type) return json(404, '页面资源不存在');
      return new Response(request.method === 'HEAD' ? null : await fs.readFile(resolved), { headers: { ...headers, 'Content-Type': `${type}; charset=utf-8` } });
    } catch { return json(404, '页面资源无法读取，请重新打开应用。'); }
  };
}
