import { test, expect } from '@playwright/test';

test('三栏主流程：验收、决定、修改、看板和刷新恢复', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认完成', exact: true })).toBeVisible();
  await expect(page.locator('.focus-card h2')).toHaveText('修复订单导出');
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).tasks.some(t => t.status === 'blocked')).toBe(true);
  await expect(page.locator('.focus-card h2')).toHaveText('修复订单导出');
  await page.screenshot({ path: 'docs/screenshots/workbench.png', fullPage: true });
  await page.getByRole('button', { name: '查看验证详情', exact: false }).click();
  await expect(page.getByRole('region',{name:'验证详情'})).toContainText('退出码 0');
  await page.getByRole('button', { name: '查看验证详情' }).click();
  await page.getByRole('button', { name: '确认完成', exact: true }).click();
  await expect(page.locator('.focus-card h2')).toHaveText('增加 GitHub 登录');
  await page.getByRole('button', { name: '登录后手动绑定', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认完成', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提出修改', exact: true }).click();
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('补充：不要改已有接口');
  await page.getByRole('button', { name: '发送要求', exact: true }).click();
  await expect(page.locator('.constraint-list')).toContainText('不要改已有接口');
  await expect.poll(async () => {
    const state = await (await page.request.get('/api/state')).json();
    const login = state.tasks.find(t => t.title === '增加 GitHub 登录');
    return login.status === 'review' && login.evidence.length >= 2;
  }).toBe(true);
  await expect(page.getByRole('button', { name: '确认完成', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('这是一条尚未发送的草稿');
  await page.getByRole('button', { name: /项目看板/ }).click();
  await expect(page.locator('.kanban-column')).toHaveCount(3);
  await expect(page.locator('.kanban-card')).toHaveCount(2);
  await page.screenshot({ path: 'docs/screenshots/kanban.png', fullPage: true });
  await page.getByRole('button', { name: /返回工作台/ }).click();
  await expect(page.getByRole('textbox', { name: '交代工作或补充要求' })).toHaveValue('这是一条尚未发送的草稿');
  await page.reload();
  await expect(page.locator('.constraint-list')).toContainText('不要改已有接口');
  await expect(page.getByRole('textbox', { name: '交代工作或补充要求' })).toHaveValue('这是一条尚未发送的草稿');
  expect(errors).toEqual([]);
});

test('移动端可提交新任务，页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('combobox', { name: '沟通范围' }).click();
  await page.getByRole('option', { name: '新任务', exact: true }).click();
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('生成一个移动端演示结果');
  await page.getByRole('button', { name: '发送要求', exact: true }).click();
  await expect(page.locator('.receipt')).toContainText('演示任务');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
});
