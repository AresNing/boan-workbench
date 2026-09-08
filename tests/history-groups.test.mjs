import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupHistory, historyDay } from '../src/history-groups.mjs';
const event = (id, taskId, at, extra = {}) => ({ id, taskId, at, kind: 'activity', tool: 'read_file', status: 'completed', text: '读取文件', ...extra });
const at = time => `2026-09-07T${time}+08:00`;

test('按连续任务和时间分段，不跨任务或无归属沟通合并，明细不丢失', () => {
  const events = [event('a1','a',at('10:00:00')),event('a2','a',at('10:01:00')),event('b','b',at('10:03:00')),event('a3','a',at('10:04:00'))];
  const messages = [{ id: 'm', role: 'user', text: '查询项目', at: at('10:02:00'), taskId: null }];
  const groups = groupHistory(events,messages);
  assert.deepEqual(groups.map(g=>g.taskId),['a','b',null,'a']);
  assert.deepEqual(groups.flatMap(g=>g.items.map(e=>e.id)).sort(),['a1','a2','a3','b','m']);
  assert.equal(groups.at(-1).entries[0].items.length,2);
  assert.equal(groups[2].entries[0].kind,'user');
});

test('跨本地日期和超过半小时分段，展开组标识随追加保持稳定', () => {
  const local = (day,hour,minute) => new Date(2026,8,day,hour,minute).toISOString();
  const events=[event('old','a',local(6,23,59)),event('new','a',local(7,0,1)),event('gap','a',local(7,1,0))];
  const groups=groupHistory(events,[]);
  assert.deepEqual(groups.map(g=>g.id),['gap','new','old']);
  assert.notEqual(historyDay(events[0].at),historyDay(events[1].at));
  assert.equal(groupHistory([...events,event('append','a',local(7,1,1))],[])[0].id,'gap');
});

test('失败和沟通打断操作合并，单任务过滤兼容历史工具记录', () => {
  const events=[event('old','a',at('10:00:00'),{kind:'tool',tool:undefined,status:undefined,text:'执行 read_file',detail:'{"path":"README.md"}'}),event('fail','a',at('10:01:00'),{status:'failed'}),event('other','b',at('10:02:00')),event('read','a',at('10:03:00'))];
  const messages=[{id:'m',taskId:'a',role:'assistant',text:'继续核查',at:at('10:02:30')}];
  const groups=groupHistory(events,messages,'a');
  assert.equal(groups.length,1); assert.equal(groups[0].items.length,4);
  assert.equal(groups[0].entries[2].status,'failed');
  assert.equal(groups[0].entries.at(-1).items[0].path,'README.md');
  assert.equal(groups[0].entries.at(-1).items[0].status,undefined);
  assert.deepEqual(groupHistory([],[]),[]);
});
