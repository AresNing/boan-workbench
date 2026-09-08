import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand, scopedPath } from '../server/files.mjs';
import { Engine } from '../server/engine.mjs';
import { Store } from '../server/store.mjs';
const sh = s => "'" + s.replaceAll("'", "'\\''") + "'";
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('等待状态超时'); await delay(10); } }
async function setup(t, overrides = {}, execute = async () => ({ summary: '完成', verificationCommand: 'printf verified' })) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'boan-permissions-')));
  const root = path.join(dir, 'project'); await fs.mkdir(root);
  const config = { mode: 'pi', projectPath: root, dataDir: path.join(dir, 'data'), maxRepairs: 0, runTimeoutMs: 10000, ...overrides };
  const project = { path: root, mode: 'pi', name: 'Permissions' };
  const store = new Store(config.dataDir, project), engine = new Engine(store, { execute }, config);
  t.after(async () => { await engine.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, root, config, project, store, engine };
}
const mac = { skip: process.platform !== 'darwin' };

test('macOS real sandbox: reads/writes and Node work; outside files, secrets, symlinks and chained escapes are denied', mac, async t => {
  const { root, dir } = await setup(t);
  await fs.writeFile(path.join(dir, 'private.txt'), 'outside-private-fixture');
  await fs.writeFile(path.join(root, '.env'), 'secret-fixture');
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested/auth.json'), 'auth-fixture');
  await fs.symlink(dir, path.join(root, 'escape'));
  const run = command => runCommand(root, command, { sandbox: true });
  assert.equal((await run('printf ok > result.txt; cat result.txt')).output, 'ok');
  const node = await run(`${sh(process.execPath)} -e 'console.log("node works")'`);
  assert.equal(node.passed, true, node.output);
  for (const command of ['cat ../private.txt', 'cat .env', 'cat nested/auth.json', 'ln .env alias.env.txt', 'mv .env renamed.txt', 'cat escape/private.txt', 'printf bad > ../outside.txt', 'printf ok; touch escape/outside.txt', 'touch .git/config', '/bin/sh -c "cat ../private.txt"']) {
    const result = await run(command); assert.equal(result.passed, false, command); assert.doesNotMatch(result.output, /outside-private-fixture|secret-fixture|auth-fixture/);
  }
  await assert.rejects(fs.access(path.join(dir, 'outside.txt')));
  const env = await run('env'); assert.doesNotMatch(env.output, /OPENAI_API_KEY|CODEX_HOME|WORKBENCH_API_KEY/);
});

test('macOS real sandbox: network blocked by default, explicit network access retains file boundary', mac, async t => {
  const { root, dir } = await setup(t); let requests = 0;
  const server = http.createServer((_q,r) => { requests++; r.end('network-fixture'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const command = `/usr/bin/curl --silent --show-error --max-time 2 http://127.0.0.1:${server.address().port}`;
  const denied = await runCommand(root, command, { sandbox: true }); assert.equal(denied.passed, false); assert.equal(requests, 0);
  const allowed = await runCommand(root, command, { sandbox: true, network: true }); assert.equal(allowed.passed, true, allowed.output); assert.equal(allowed.output, 'network-fixture'); assert.equal(requests, 1);
  const outside = await runCommand(root, 'touch ../outside.txt', { sandbox: true, network: true }); assert.equal(outside.passed, false); await assert.rejects(fs.access(path.join(dir, 'outside.txt')));
});

test('auto mode runs worker and independent verification without approvals and still requires acceptance', mac, async t => {
  const { engine, store } = await setup(t, {}, async (_task, ctx) => {
    const run = await ctx.command('printf worker', '运行检查'); assert.equal(run.passed, true);
    return { summary: '完成', verificationCommand: 'printf verified' };
  });
  const task = store.add('自动推进'); engine.tick(); await until(() => task.status === 'review');
  assert.equal(task.evidence[0].sandboxed, true); assert.equal(task.decisions, undefined); assert.equal(engine.pending.size, 0);
  await engine.action(task.id, 'accept'); assert.equal(task.status, 'done');
});

test('task network grant avoids repeats, does not allow local escape, revokes and expires at completion', mac, async t => {
  let step = 0, continueWork;
  const wait = new Promise(r => { continueWork = r; });
  const { engine, store } = await setup(t, {}, async (_task, ctx) => {
    await ctx.command('printf first', '联网检查', 'network'); step++;
    await ctx.command('printf second', '联网检查', 'network'); step++;
    await wait;
    await ctx.command('printf third', '再次联网', 'network'); step++;
    await ctx.command('printf local', '本机执行', 'local'); step++;
    return { summary: '完成', verificationCommand: 'printf verified' };
  });
  const task = store.add('任务授权'); engine.tick(); await until(() => task.decision);
  const first = task.decision.id; assert.equal(task.decision.scope, 'network');
  await engine.action(task.id, 'decision', { decisionId: first, answer: '本任务内允许联网' });
  await until(() => step === 2); assert.equal(task.decision, null); assert.equal(engine.permissions().grants.length, 1);
  engine.setPermissions({ revokeTaskId: task.id }); continueWork(); await until(() => task.decision);
  assert.notEqual(task.decision.id, first);
  await assert.rejects(engine.action(task.id, 'decision', { decisionId: first, answer: '允许本次执行' }));
  await engine.action(task.id, 'decision', { decisionId: task.decision.id, answer: '本任务内允许联网' });
  await until(() => task.decision?.scope === 'local'); assert.deepEqual(task.decision.options, ['允许本次执行', '拒绝并暂停']);
  await engine.action(task.id, 'decision', { decisionId: task.decision.id, answer: '允许本次执行' });
  await until(() => task.status === 'review'); assert.equal(step, 4); assert.equal(engine.permissions().grants.length, 0);
});

test('ask mode grants only project commands for this execution, including verifier; settings persist per project', mac, async t => {
  const { engine, store, config, project } = await setup(t, {}, async (_task, ctx) => {
    await ctx.command('printf one', '检查'); await ctx.command('printf two', '检查');
    return { summary: '完成', verificationCommand: 'printf verified' };
  });
  engine.setPermissions({ mode: 'ask' });
  const task = store.add('谨慎模式'); engine.tick(); await until(() => task.decision);
  await engine.action(task.id, 'decision', { decisionId: task.decision.id, answer: '本任务内允许项目命令' });
  await until(() => task.status === 'review'); assert.equal(task.decisions.length, 1);
  const restored = new Store(config.dataDir, project); assert.equal(restored.data.permissions.mode, 'ask'); assert.equal(restored.data.grants, undefined);
  const other = await setup(t); assert.equal(other.engine.permissions().mode, 'auto'); assert.equal(other.engine.permissions().grants.length, 0);
});

test('approval wait excluded from execution timeout; duplicate clicks do not authorize twice', mac, async t => {
  const { engine, store } = await setup(t, { permissionMode: 'ask', runTimeoutMs: 150 });
  const task = store.add('等待批准'); engine.tick(); await until(() => task.decision);
  const id = task.decision.id; await delay(350); assert.equal(task.status, 'blocked');
  await engine.action(task.id, 'decision', { decisionId: id, answer: '允许本次执行' });
  await assert.rejects(engine.action(task.id, 'decision', { decisionId: id, answer: '允许本次执行' }));
  await until(() => task.status === 'review'); assert.equal(task.decisions.length, 1);
});

test('pending command is cleared on backend termination; stale approval is never recorded', async t => {
  let pending;
  const { engine, store } = await setup(t, {}, async (_task, ctx) => {
    pending = ctx.approve('printf should-not-run', '外部执行', 'local').catch(() => {});
    return null;
  });
  const task = store.add('连接中断'); engine.tick(); await until(() => task.status === 'failed');
  await pending; assert.equal(task.decision, null); assert.equal(engine.pending.size, 0);
  await assert.rejects(engine.action(task.id, 'decision', { decisionId: 'stale', answer: '允许本次执行' }));
  assert.equal(task.decisions, undefined);
});

test('parallel command requests queue without losing approvals; deny stops remaining calls', async t => {
  let results;
  const { engine, store } = await setup(t, {}, async (_task, ctx) => {
    results = await Promise.allSettled([ctx.command('printf first', '第一条', 'local'), ctx.command('printf second', '第二条', 'local')]);
    return { summary: 'unused', verificationCommand: 'true' };
  });
  const task = store.add('并行申请'); engine.tick(); await until(() => task.decision);
  assert.equal(task.decision.command, 'printf first');
  await engine.action(task.id, 'decision', { decisionId: task.decision.id, answer: '拒绝并暂停' });
  await until(() => task.status === 'paused'); assert.ok(results.every(r => r.status === 'rejected')); assert.equal(engine.pending.size, 0);
});

test('sandbox protects application state even if inside project; runtime shim works without granting app data', mac, async t => {
  const { root } = await setup(t);
  const data = path.join(root, 'application-data'); await fs.mkdir(data);
  const bin = path.join(data, 'runtime-bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(data, 'state.json'), 'protected-state-fixture');
  await fs.writeFile(path.join(bin, 'node'), `#!/bin/sh\nexec ${sh(process.execPath)} "$@"\n`, { mode: 0o700 });
  const options = { sandbox: true, runtimeBin: bin, protectedRoots: [data] };
  await assert.rejects(scopedPath(root, 'application-data/state.json', { protectedRoots: [data], write: true }), /应用数据/);
  await fs.symlink(data, path.join(root, 'data-link'));
  await assert.rejects(scopedPath(root, 'data-link/state.json', { protectedRoots: [data] }), /应用数据/);
  const run = await runCommand(root, 'node -e \'console.log("shim works")\'', options); assert.equal(run.passed, true, run.output);
  const blocked = await runCommand(root, 'cat application-data/state.json', options); assert.equal(blocked.passed, false); assert.doesNotMatch(blocked.output, /protected-state-fixture/);
});


test('outbound network grant does not open Unix sockets or listening ports', mac, async t => {
  const { root, dir } = await setup(t); let connections = 0;
  const socket = path.join(dir, 'service.sock');
  const server = net.createServer(client => { connections++; client.end('must-not-reach'); });
  await new Promise(r => server.listen(socket, r));
  t.after(() => new Promise(r => server.close(r)));
  const script = `const s=require("net").connect(${JSON.stringify(socket)});s.on("error",()=>process.exit(3));s.on("data",d=>console.log(String(d)));`;
  const result = await runCommand(root, `${sh(process.execPath)} -e ${sh(script)}`, { sandbox: true, network: true });
  assert.equal(result.passed, false); assert.equal(connections, 0);
  const listen = 'require("net").createServer().on("error",()=>process.exit(3)).listen(0,"127.0.0.1",()=>process.exit(0))';
  assert.equal((await runCommand(root, `${sh(process.execPath)} -e ${sh(listen)}`, { sandbox: true, network: true })).passed, false);
});


test('runtime shutdown closes unfinished HTTP requests before releasing project lock', async t => {
  const { startRuntime } = await import('../server/runtime.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-close-request-'));
  const runtime = await startRuntime({ mode: 'demo', projectPath: path.join(dir, 'project'), dataDir: dir, distDir: path.resolve('dist'), demoDelay: 10 });
  const socket = net.connect(new URL(runtime.url).port, '127.0.0.1');
  t.after(async () => { socket.destroy(); await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(r => socket.once('connect', r));
  socket.write(`POST /api/messages HTTP/1.1\r\nHost: ${new URL(runtime.url).host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await delay(30);
  let timer;
  await Promise.race([runtime.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown hung')), 1500); })]).finally(() => clearTimeout(timer));
  await assert.rejects(fs.access(path.join(dir, 'server.lock')));
});
