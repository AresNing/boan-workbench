import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupExecutionEvents, groupSummary } from '../src/execution-groups.mjs';

test('合并连续文件操作，消息、失败、运行中和不同操作类型保持边界', () => {
  const event = (id, tool, status = 'completed') => ({ id, taskId: 'one', kind: 'activity', tool, status, path: `${id}.txt` });
  const entries = [event('a','read_file'), event('b','list_files'), event('c','read_file'),
    event('failure','read_file','failed'), event('d','read_file'),
    { id:'msg',taskId:'one',kind:'progress',detail:'继续整理' }, event('e','read_file'),
    event('active','read_file','running'), event('w1','write_file'), event('w2','write_file'),
    event('cmd','run_command','waiting'), { ...event('other','read_file'),taskId:'two' }];
  const groups = groupExecutionEvents(entries, 'one');
  assert.equal(groups.length, 8);
  assert.deepEqual(groups[0].items.map(e=>e.id), ['a','b','c']);
  assert.equal(groupSummary(groups[0]), '读取 2 次 · 浏览目录 1 次');
  assert.equal(groups[1].status, 'failed'); assert.equal(groups[3].kind, 'progress');
  assert.equal(groups[5].status, 'running'); assert.equal(groups[6].items.length, 2);
  assert.equal(groups[7].status, 'waiting');
  assert.equal(entries[0].items, undefined);
});

test('旧工具记录归类但不伪造结果，追加操作时分组标识稳定', () => {
  const events = [{ id:'old1',taskId:'one',kind:'tool',text:'执行 read_file',detail:'{"path":"README.md"}' },
    { id:'old2',taskId:'one',kind:'tool',text:'执行 read_file',detail:'invalid json' }];
  let group = groupExecutionEvents(events, 'one')[0];
  assert.equal(group.id, 'old1'); assert.equal(group.items[0].path,'README.md');
  assert.equal(group.items[0].status, undefined); assert.equal(group.items[1].path,undefined);
  events.push({ id:'new',taskId:'one',kind:'activity',tool:'list_files',status:'completed' });
  group = groupExecutionEvents(events,'one')[0];
  assert.equal(group.id,'old1'); assert.equal(group.items.length,3);
});
