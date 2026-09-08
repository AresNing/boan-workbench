import { test, expect } from '@playwright/test';

test('执行过程默认隐藏，实时更新、任务隔离、保留展开和阅读位置，键盘返回', async ({ page }) => {
  const original = await (await page.request.get('/api/state')).json();
  const task = { ...original.tasks[0], id: 'timeline-test', title: '整理项目迭代清单', status: 'running', summary: '正在检查已有实现。', decision: null };
  const at = '2026-09-07T00:00:00Z';
  const state = { ...original, tasks: [task], attentionIds: [], events: [
    { id: 'start', taskId: task.id, kind: 'run', text: '开始执行', at },
    { id: 'msg', taskId: task.id, kind: 'progress', text: '进度更新', detail: '我会先检查已有文档，再整理可核实的迭代项。', at },
    { id: 'read', taskId: task.id, kind: 'activity', text: '读取文件', tool: 'read_file', path: 'README.md', status: 'completed', output: '4200 个字符已读取', durationMs: 52, at },
    { id: 'cmd', taskId: task.id, kind: 'activity', text: '执行命令', tool: 'run_command', command: 'node test.mjs', status: 'running', output: '检查中…', at },
    { id: 'other', taskId: 'other-task', kind: 'progress', detail: '其他任务内容不应出现', at },
  ] };
  state.events.splice(3, 0, ...Array.from({ length: 8 }, (_, i) => ({ id: `read-${i}`, taskId: task.id, kind: 'activity', text: '读取文件', tool: 'read_file', path: `docs/guide-${i}.md`, status: 'completed', output: '已读取', at })));
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.addInitScript(state => {
    window.EventSource = class {
      constructor() { window.__pushExecution = data => this.onmessage?.({ data: JSON.stringify(data) }); setTimeout(() => window.__pushExecution(state), 20); }
      close() {}
    };
  }, state);
  await page.goto('/');
  await expect(page.locator('.execution-dialog')).toHaveCount(0);
  const draft = page.getByRole('textbox', { name: '交代工作或补充要求' });
  await draft.fill('保留未发送的要求');
  await page.getByRole('button', { name: '查看执行过程', exact: true }).first().click();
  const dialog = page.getByRole('complementary',{name:'任务背景'});
  await expect(dialog).toContainText('我会先检查已有文档');
  await expect(dialog).not.toContainText('其他任务内容不应出现');
  const group = dialog.locator('.execution-group').first();
  await expect(group.locator('summary')).toContainText('读取 9 次');
  await expect(group).not.toHaveAttribute('open');
  await expect(group.locator('.execution-group-item').first()).not.toBeVisible();
  await group.locator('summary').click();
  await expect(group.locator('.execution-group-item')).toHaveCount(9);
  state.events.splice(11, 0, { id: 'read-new', taskId: task.id, kind: 'activity', tool: 'read_file', path: 'docs/last.md', status: 'completed', output: '已读取', at });
  await page.evaluate(state => window.__pushExecution(state), state);
  await expect(group).toHaveAttribute('open');
  await expect(group.locator('.execution-group-item')).toHaveCount(10);
  await group.locator('summary').click();
  await dialog.locator('summary').filter({ hasText: 'node test.mjs' }).click();
  await expect(dialog.locator('details[open] pre')).toHaveText('检查中…');
  state.events.find(e => e.id === 'cmd').output = '<script>unsafe()</script>\n断言失败';
  state.events.find(e => e.id === 'cmd').status = 'failed';
  state.events.find(e => e.id === 'cmd').exitCode = 1;
  await page.evaluate(state => window.__pushExecution(state), state);
  await expect(dialog.locator('details[open] pre')).toContainText('<script>unsafe()</script>');
  await expect(dialog.locator('.execution-entry.failed')).toContainText('退出码 1');
  await page.screenshot({ path: 'docs/screenshots/execution-grouped.png' });
  for (let i = 0; i < 24; i++) state.events.push({ id: `progress-${i}`, taskId: task.id, kind: 'progress', detail: `执行进展 ${i}：正在检查并整理项目。`, at });
  await page.evaluate(state => window.__pushExecution(state), state);
  const scroll = dialog.locator('.execution-scroll');
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(60);
  await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(dialog.getByRole('button', { name: '回到最新' })).toBeVisible();
  state.events.push({ id: 'last', taskId: task.id, kind: 'progress', detail: '最新进展', at });
  await page.evaluate(state => window.__pushExecution(state), state);
  expect(await scroll.evaluate(el => el.scrollTop)).toBe(0);
  await dialog.getByRole('button', { name: '回到最新' }).click();
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(60);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden(); await expect(draft).toHaveValue('保留未发送的要求');
  await page.getByRole('button', { name: '查看执行过程', exact: true }).first().click();
  await expect(dialog).toContainText('最新进展');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
