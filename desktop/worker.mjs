import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerCodexClient } from './codex-bridge.mjs';
import { workerModels } from './model-bridge.mjs';
import { startRuntime } from '../server/runtime.mjs';

let runtime, closing = false;
const send = message => { if (process.connected) process.send(message); };
async function stop() {
  if (closing) return; closing = true;
  try { await runtime?.close(); } finally { process.exit(0); }
}
process.on('message', async message => {
  if (message.type === 'model-options' && runtime) { runtime.config.modelOptions = message.options; runtime.store.emit('change', runtime.store.snapshot()); return; }
  if (message.type === 'stop') return stop();
  if (message.type !== 'start' || runtime) return;
  try {
    // A private shim makes `node` available to demo checks even on a Mac without Node installed.
    const bin = path.join(message.config.dataDir, 'runtime-bin');
    await fs.mkdir(bin, { recursive: true, mode: 0o700 });
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await fs.writeFile(path.join(bin, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(message.nodeExecutable)} "$@"\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
    runtime = await startRuntime({ ...message.config, runtimeBin: bin, codexClientFactory: () => new WorkerCodexClient(), ...(message.config.modelOptions ? { resolveModel: workerModels() } : {}) });
    const known = new Map(runtime.store.data.tasks.map(t => [t.id, t.status]));
    const summary = state => ({ tasks: state.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, deferredUntil: t.deferredUntil, connection: t.modelSelection?.connection || runtime.config.connection })), active: state.tasks.filter(t => ['queued', 'running', 'verifying', 'stopping'].includes(t.status)).length, attention: state.tasks.filter(t => ['review', 'blocked', 'failed'].includes(t.status)).length, done: state.tasks.filter(t => t.status === 'done').length, managerBusy: runtime.engine.managerBusy });
    runtime.store.on('change', state => {
      send({ type: 'summary', summary: summary(state) });
      for (const task of state.tasks) {
        const previous = known.get(task.id); known.set(task.id, task.status);
        if (task.status !== previous && ['review', 'blocked', 'failed'].includes(task.status)) send({ type: 'attention', taskId: task.id, title: task.title, status: task.status });
      }
      send({ type: 'badge', count: state.tasks.filter(t => ['review', 'blocked', 'failed'].includes(t.status)).length });
    });
    send({ type: 'summary', summary: summary(runtime.store.data) });
    send({ type: 'ready', url: runtime.url, projectPath: runtime.config.projectPath });
  } catch (error) { send({ type: 'error', message: error.message }); await stop(); }
});
process.on('disconnect', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('uncaughtException', error => { send({ type: 'error', message: error.message }); void stop(); });
