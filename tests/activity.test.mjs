import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Store } from '../server/store.mjs';
import { activityRecorder } from '../server/activity.mjs';
import { runCommand } from '../server/files.mjs';

test('执行记录更新和重启恢复，不记录额外参数并隐藏凭据', async t => {
  const dir = await fs.mkdtemp('/tmp/boan-activity-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = { name: 'fixture', path: dir, mode: 'demo' };
  const store = new Store(dir, project), one = store.add('one'), two = store.add('two');
  const record = activityRecorder(store, one.id, 'public-secret-fixture');
  const id = record(null, { text: '执行命令', command: 'echo public-secret-fixture', status: 'waiting', arguments: { password: 'never serialize this' } });
  record(id, { output: 'Bearer fixture-token sk-public-fixture api_key=fixture-value', status: 'running' });
  activityRecorder(store, two.id)(id, { status: 'completed' });
  const entry = store.data.events.find(e => e.id === id);
  assert.equal(entry.status, 'running');
  assert.ok(!JSON.stringify(entry).includes('public-secret-fixture'));
  assert.ok(!JSON.stringify(entry).includes('fixture-token'));
  assert.ok(!JSON.stringify(entry).includes('fixture-value'));
  assert.equal(entry.arguments, undefined);
  const restored = new Store(dir, project).data.events.find(e => e.id === id);
  assert.equal(restored.status, 'interrupted'); assert.equal(restored.id, id);
});

test('长命令结束前可收到输出，最终失败状态与真实退出码一致', async () => {
  let finished = false, streamed = false;
  const result = await runCommand('/tmp', "printf 'first output'; sleep 0.6; exit 7", { onOutput: value => { assert.equal(finished, false); streamed = value.includes('first output'); } });
  finished = true;
  assert.equal(streamed, true); assert.equal(result.exitCode, 7); assert.equal(result.passed, false);
});
