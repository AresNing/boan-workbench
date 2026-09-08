import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, attention } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { DemoBackend } from '../server/demo.mjs';
import { scopedPath, runCommand } from '../server/files.mjs';
import { createServer } from '../server/http.mjs';

export async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-test-'));
  const config = { mode: 'demo', dataDir: path.join(dir, 'data'), projectPath: path.join(dir, 'project'), distDir: path.resolve('dist'), demoDelay: 5, maxRepairs: 2, runTimeoutMs: 30000, maxTurns: 12, ...overrides };
  await fs.mkdir(config.projectPath);
  const project = { name: 'Test', path: config.projectPath, mode: config.mode };
  const store = new Store(config.dataDir, project), engine = new Engine(store, new DemoBackend(config), config);
  t.after(async () => { await engine.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { config, store, engine, project };
}
export async function until(fn, timeout = 15000) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end) throw new Error('等待状态超时'); await delay(20); } }

test('真实示例验证失败后自动修复，业务决定只阻塞相关任务，验收持久保存', async t => {
  const { engine, store, config, project } = await fixture(t);
  engine.seed(); engine.tick();
  await until(() => store.data.tasks.some(t => t.status === 'blocked'));
  const [exp, login] = store.data.tasks;
  assert.equal(exp.status, 'review'); assert.deepEqual(exp.evidence.map(e => e.passed), [false, true]);
  assert.equal(login.status, 'blocked');
  assert.match(await fs.readFile(path.join(config.projectPath, exp.artifacts[0]), 'utf8'), /replaceAll/);
  await engine.action(login.id, 'decision', { decisionId: login.decision.id, answer: login.decision.options[0] });
  await until(() => login.status === 'review');
  await engine.action(exp.id, 'accept');
  const restored = new Store(config.dataDir, project);
  assert.equal(restored.task(exp.id).status, 'done'); assert.equal(restored.task(login.id).decisions.length, 1);
});

test('统一输入可建立多任务并在管理完成后启动调度', async t => {
  const { engine, store } = await fixture(t);
  await engine.message('完成一个演示；再完成第二个演示');
  assert.equal(store.data.tasks.length, 2);
  await until(() => store.data.tasks.every(t => t.status === 'review'));
  assert.ok(store.data.tasks.every(t => t.evidence[0].passed));
});

test('补充要求保持任务执行，旧版本成果失效并按新要求验证', async t => {
  const { engine, store } = await fixture(t, { demoDelay: 250 });
  const task = store.add('一个演示'); engine.tick();
  await until(() => task.status === 'running');
  await engine.action(task.id, 'amend', { text: '不要改已有接口' });
  assert.equal(task.status, 'running');
  await until(() => task.status === 'review');
  assert.deepEqual(task.constraints, ['不要改已有接口']); assert.equal(task.attempts, 2);
  assert.ok(task.evidence.at(-1).passed);
});

test('暂停确认后才显示已暂停，恢复沿用同一任务', async t => {
  const { engine, store } = await fixture(t, { demoDelay: 200 });
  const task = store.add('暂停测试'); engine.tick();
  await engine.action(task.id, 'pause');
  await until(() => task.status === 'paused');
  assert.equal(task.evidence.length, 0);
  await engine.action(task.id, 'resume');
  await until(() => task.status === 'review'); assert.equal(store.data.tasks.length, 1);
});

test('重启中断状态恢复为暂停，保留任务事实，不能伪造验收', async t => {
  const { store, engine, config, project } = await fixture(t);
  const task = store.add('重启恢复', { status: 'verifying', constraints: ['不要改接口'] });
  const restored = new Store(config.dataDir, project);
  assert.equal(restored.task(task.id).status, 'paused'); assert.deepEqual(restored.task(task.id).constraints, ['不要改接口']);
  await assert.rejects(engine.action(task.id, 'accept'), /只有通过验证/);
});

test('关注顺序尊重优先级和稍后处理，延期不解除阻塞', async t => {
  const { store, engine } = await fixture(t);
  const blocked = store.add('决定', { status: 'blocked' });
  const review = store.add('紧急交付', { status: 'review', priority: 'high' });
  assert.equal(attention(store.data.tasks)[0].id, review.id);
  await engine.action(blocked.id, 'defer');
  assert.equal(blocked.status, 'blocked'); assert.equal(attention(store.data.tasks).length, 1);
  assert.equal(attention(store.data.tasks, Date.now() + 31 * 60000).length, 2);
});

test('项目路径拒绝越界、秘密文件和符号链接绕过', async t => {
  const { config } = await fixture(t);
  await fs.symlink(os.tmpdir(), path.join(config.projectPath, 'outside'));
  await fs.symlink(path.join(os.tmpdir(), 'does-not-exist-wb'), path.join(config.projectPath, 'dangling'));
  for (const file of ['../secret.txt', '.env', '.env.local', '.git/config', 'outside/foo', 'dangling/foo']) await assert.rejects(scopedPath(config.projectPath, file, { write: true }));
  assert.equal(await scopedPath(config.projectPath, 'src/new.txt', { write: true }), path.join(await fs.realpath(config.projectPath), 'src/new.txt'));
});

test('取消命令会终止进程组且证据不标记成功', async t => {
  const { config } = await fixture(t); const controller = new AbortController();
  const promise = runCommand(config.projectPath, 'sleep 10', { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const evidence = await promise; assert.equal(evidence.passed, false); assert.equal(evidence.aborted, true);
});

test('真实模式验证命令等待逐次审批，旧决定不可重放', async t => {
  const { engine, store } = await fixture(t, { mode: 'pi', permissionMode: 'ask' });
  const task = store.add('需要审批的验证'); engine.tick();
  await until(() => task.decision?.kind === 'command');
  assert.equal(task.evidence.length, 0);
  const decisionId = task.decision.id;
  await engine.action(task.id, 'decision', { decisionId, answer: '允许本次执行' });
  await until(() => task.status === 'review'); assert.ok(task.evidence[0].passed);
  await assert.rejects(engine.action(task.id, 'decision', { decisionId, answer: '允许本次执行' }), /已变化/);
});

test('拒绝命令会停止任务，命令没有执行且不能伪造完成', async t => {
  const { engine, store } = await fixture(t, { mode: 'pi', permissionMode: 'ask' });
  const task = store.add('拒绝验证命令'); engine.tick();
  await until(() => task.decision?.kind === 'command');
  await engine.action(task.id, 'decision', { decisionId: task.decision.id, answer: '拒绝并暂停' });
  await until(() => task.status === 'paused');
  assert.equal(task.evidence.length, 0); assert.equal(task.decision, null);
});

test('重复验证失败在修复上限停止，不会无限运行', async t => {
  const { engine, store } = await fixture(t, { verifyCommand: 'exit 1' });
  const task = store.add('持续失败演示'); engine.tick();
  await until(() => task.status === 'failed');
  assert.equal(task.attempts, 3); assert.equal(task.evidence.length, 3);
  assert.ok(task.evidence.every(e => !e.passed)); assert.match(task.summary, /自动修复 2 次/);
});

test('HTTP 拒绝跨站写请求，提供快照和成果，非法输入不更改状态', async t => {
  const { engine, store, config } = await fixture(t); const server = createServer(store, engine, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeStreams(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const evil = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"text":"create"}' });
  assert.equal(evil.status, 403); assert.equal(store.data.tasks.length, 0);
  const invalid = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }); assert.equal(invalid.status, 400);
  const snap = await (await fetch(`${base}/api/state`)).json(); assert.equal(snap.project.mode, 'demo');
  await engine.message('生成演示'); await until(() => store.data.tasks[0].status === 'review');
  const task = store.data.tasks[0]; const artifact = await (await fetch(`${base}/api/artifact?taskId=${task.id}&path=${encodeURIComponent(task.artifacts[0])}`)).json();
  assert.match(artifact.content, /生成演示/);
});
