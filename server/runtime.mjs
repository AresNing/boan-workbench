import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { DemoBackend } from './demo.mjs';
import { CodexBackend } from './codex.mjs';
import { PiBackend } from './pi.mjs';
import { ClaudeBackend } from './claude.mjs';
import { ModelRouter } from './model-routing.mjs';
import { createServer } from './http.mjs';
import {acquireRuntimeLease} from './runtime-lease.mjs';

export async function startRuntime(input) {
  const config = { maxTurns: 30, maxRepairs: 2, runTimeoutMs: 3600000, ...input };
  if (!['demo', 'pi'].includes(config.mode)) throw new Error('执行模式无效');
  if (!path.isAbsolute(config.dataDir) || !path.isAbsolute(config.projectPath)) throw new Error('项目和状态目录必须使用绝对路径');
  for (const n of [config.maxTurns, config.runTimeoutMs]) if (!Number.isFinite(n) || n <= 0) throw new Error('运行预算必须为正数');
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (config.mode === 'demo') fs.mkdirSync(config.projectPath, { recursive: true });
  if (!fs.statSync(config.projectPath).isDirectory()) throw new Error('项目路径不是目录');
  config.projectPath = fs.realpathSync(config.projectPath);
  const lease=await acquireRuntimeLease(config),release=()=>lease.release();
  config.commandLifecycle=lease;
  let engine, server;
  try {
    const store = new Store(config.dataDir, { id: config.workspaceId, name: config.mode === 'demo' ? 'Acme · 产品工作区' : path.basename(config.projectPath), path: config.projectPath, mode: config.mode, connection: config.connection || 'api', model: config.mode === 'demo' ? '本地演示' : config.connection === 'chatgpt' ? (config.chatgptModel || 'Codex 默认模型') : config.model });
    engine = new Engine(store, config.mode === 'demo' ? new DemoBackend(config) : config.resolveModel ? new ModelRouter(config) : config.connection === 'chatgpt' ? new CodexBackend(config) : config.connection==='claude'?new ClaudeBackend(config):new PiBackend(config), config);
    server = createServer(store, engine, config);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    engine.seed(); engine.tick();
    let closing;
    return { store, engine, server, config, url: `http://127.0.0.1:${server.address().port}`,
      close() {
        return closing ??= (async () => {
          await engine.close(); server.closeStreams();
          await new Promise(resolve => {
            server.close(resolve);
            // Electron may still have in-flight requests when a project exits.
            // The engine is already stopped; close those connections before releasing the lock.
            server.closeAllConnections();
          });
          release(); process.off('exit', release);
        })();
      } };
  } catch (err) { await engine?.close(); server?.close(); release(); process.off('exit', release); throw err; }
}
