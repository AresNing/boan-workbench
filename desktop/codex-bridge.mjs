import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { safeError } from '../server/codex-client.mjs';

const routers = new WeakMap();
function routerFor(client) {
  let router = routers.get(client);
  if (!router) {
    router = new Map(); routers.set(client, router);
    client.onToolCall = params => { const route = router.get(params.threadId); if (!route) throw new Error('执行会话已关闭'); return route(params); };
  }
  return router;
}

// One official App Server owns authentication in memory. Workers receive only
// account metadata and task RPC, never OAuth tokens or credential files.
export function attachCodexWorker(channel, client) {
  const router = routerFor(client);
  const threads = new Map(), pending = new Map(), released = new Set();
  let disposed = false;
  const send = msg => { if (!disposed && channel.connected) channel.send(msg); };
  const release = async id => {
    released.add(id);
    for (const [threadId, state] of threads) if (state.owner === id) {
      threads.delete(threadId); router.delete(threadId);
      if (state.turnId) await client.request('turn/interrupt', { threadId, turnId: state.turnId }).catch(() => {});
      await client.request('thread/unsubscribe', { threadId }).catch(() => {});
    }
    for (const [key, p] of pending) if (p.owner === id) { pending.delete(key); clearTimeout(p.timer); p.reject(new Error('执行会话已关闭')); }
  };
  const notification = (method, params) => {
    const thread = threads.get(params?.threadId); if (!thread) return;
    if (method === 'turn/started') thread.turnId = params.turn.id;
    if (method === 'turn/completed') thread.turnId = null;
    send({ type: 'codex-event', owner: thread.owner, method, params });
  };
  const toolCall = params => new Promise((resolve, reject) => {
    const owner = threads.get(params.threadId)?.owner;
    if (!owner || disposed) return reject(new Error('执行会话已关闭'));
    const id = randomUUID();
    // The worker owns execution timeouts and excludes human approval waits.
    const timer = undefined;
    pending.set(id, { owner, resolve, reject, timer });
    send({ type: 'codex-tool', owner, id, params });
  });
  client.on('notification', notification);
  const closed = e => { send({ type: 'codex-closed', error: safeError(e) }); dispose(); };
  client.on('closed', closed);
  const message = async m => {
    if (m.type === 'codex-release') { await release(m.owner); return; }
    if (m.type === 'codex-tool-result') {
      const p = pending.get(m.id); if (!p || p.owner !== m.owner) return;
      pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(safeError(m.error))) : p.resolve(m.result); return;
    }
    if (m.type !== 'codex-request') return;
    try {
      if (!['account/read', 'thread/start', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(m.method)) throw new Error('工作进程不允许此 Codex 操作');
      if (m.method.startsWith('turn/') && threads.get(m.params.threadId)?.owner !== m.owner) throw new Error('会话不属于此执行者');
      const result = await client.request(m.method, m.params);
      if (m.method === 'thread/start') {
        router.set(result.thread.id, toolCall);
        threads.set(result.thread.id, { owner: m.owner, turnId: null });
        if (disposed || released.has(m.owner)) { await release(m.owner); return; }
      }
      send({ type: 'codex-response', owner: m.owner, id: m.id, result });
    } catch (e) { send({ type: 'codex-response', owner: m.owner, id: m.id, error: safeError(e) }); }
  };
  channel.on('message', message);
  function dispose() {
    if (disposed) return; disposed = true;
    channel.off('message', message); client.off('notification', notification); client.off('closed', closed);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('工作进程已关闭')); } pending.clear();
    for (const owner of new Set([...threads.values()].map(t => t.owner))) void release(owner);
  }
  channel.once('exit', dispose); channel.once('disconnect', dispose);
  return dispose;
}

export class WorkerCodexClient extends EventEmitter {
  constructor(channel = process) {
    super(); this.channel = channel; this.owner = randomUUID(); this.pending = new Map();
    this.receive = async m => {
      if (m.type === 'codex-closed') { this.emit('closed', new Error(m.error)); this.close(); return; }
      if (m.owner !== this.owner) return;
      if (m.type === 'codex-response') { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
      if (m.type === 'codex-event') this.emit('notification', m.method, m.params);
      if (m.type === 'codex-tool') {
        try { this.send({ type: 'codex-tool-result', id: m.id, result: await this.onToolCall(m.params) }); }
        catch (e) { this.send({ type: 'codex-tool-result', id: m.id, error: safeError(e) }); }
      }
    };
    channel.on('message', this.receive);
  }
  async start() { return this; }
  send(m) { if (!this.closed && this.channel.connected) this.channel.send({ ...m, owner: this.owner }); }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('执行会话已关闭'));
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时')); }, 30000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ type: 'codex-request', id, method, params });
    });
  }
  close() {
    if (this.closed) return;
    this.send({ type: 'codex-release' }); this.closed = true; this.channel.off('message', this.receive);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('执行会话已关闭')); } this.pending.clear();
  }
}
