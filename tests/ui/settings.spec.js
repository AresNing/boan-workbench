import { test, expect } from '@playwright/test';
import { defaults } from '../../desktop/settings.mjs';

test('设置按分类展示，保留未保存字段，添加项目仅两步，保存栏始终可见', async ({ page, request }) => {
  const base = await (await request.get('/api/state')).json();
  const state = { ...base, project: { ...base.project, mode: 'pi' }, permissions: { mode: 'auto', sandboxAvailable: true, grants: [] } };
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.addInitScript(({ state, defaults }) => {
    window.savedSettings = [];
    window.desktop = {
      getSettings: async () => ({ ...defaults, mode: 'pi', projectPath: '/workspace/my-project', version: '0.4.8', hasApiKey: true }),
      onCommand: callback => { window.settingsCommand = callback; return () => {}; },
      chooseProject: async () => '/workspace/new-project',
      savePreferences: async settings => { window.savedPreferences=settings; },
      saveSettings: async settings => { window.savedSettings.push(settings); throw Error('测试保存失败，保留输入'); },
      chatgptStatus: async () => ({ loggedIn: true, email: 'example@example.test', plan: 'pro', storage: 'file', effectiveStorage: 'file' }),
      chatgptModels: async () => [],
    };
    window.EventSource = class { constructor() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(state) })); } close() {} };
  }, { state, defaults });
  await page.goto('/');
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('工作台草稿');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '设置分类' });
  await expect(nav.getByRole('button')).toHaveCount(5);
  await expect(page.getByLabel('项目文件夹', { exact: true })).toBeVisible();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveCount(0);
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('默认验证命令', { exact: true }).fill('npm test');
  await nav.getByRole('button', { name: '项目模型', exact: true }).click();
  await page.getByLabel('模型名称', { exact: true }).fill('new-model');
  await page.getByLabel('API Key', { exact: true }).fill('public-settings-fixture');
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await page.getByLabel('任务需要处理时通知我').check();await expect.poll(()=>page.evaluate(()=>window.savedPreferences?.notifications)).toBe(true);
  await nav.getByRole('button', { name: '权限', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '审批模式' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存并应用' })).toHaveCount(0);
  await nav.getByRole('button', { name: '项目模型', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('public-settings-fixture');
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('new-model');
  await page.setViewportSize({ width: 960, height: 720 });
  await page.screenshot({ path: 'docs/screenshots/settings-light.png' });
  await page.getByRole('button', { name: '保存并应用' }).click();
  await expect(page.getByRole('alert')).toContainText('测试保存失败');
  const saved = await page.evaluate(() => window.savedSettings[0]);
  expect(saved).toMatchObject({ model: 'new-model', apiKey: 'public-settings-fixture', verifyCommand: 'npm test', notifications: true });
  await page.getByRole('button', { name: 'ChatGPT 登录', exact: false }).click();
  await nav.getByRole('button',{name:'账号与服务',exact:true}).click();
  await expect(page.getByText('已登录 · example@example.test · pro')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '登录凭据保存方式' })).toBeHidden();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'docs/screenshots/settings-dark.png' });
  await page.setViewportSize({ width: 600, height: 620 });
  await nav.getByRole('button',{name:'项目模型',exact:true}).click();
  await expect(page.getByRole('button', { name: '保存并应用' })).toBeInViewport();
  await expect(nav.getByRole('button', { name: '通用', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'docs/screenshots/settings-narrow.png' });
  await page.getByRole('button', { name: '关闭面板' }).click();
  await expect(page.getByRole('alert',{name:'未保存修改'})).toBeVisible();
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Codex 模型',exact:true})).toBeVisible();
  await page.evaluate(()=>window.settingsCommand('new-task'));
  await expect(page.getByRole('alert',{name:'未保存修改'})).toBeVisible();
  await page.getByRole('button',{name:'放弃修改',exact:true}).click();
  await expect(page.getByRole('textbox', { name: '交代工作或补充要求' })).toHaveValue('工作台草稿');
  await page.evaluate(() => window.settingsCommand('open-project'));
  await expect(page.getByRole('heading', { name: '添加项目', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '添加项目步骤' }).getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByLabel('模型名称', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '添加项目步骤' }).getByRole('button', { name: '项目', exact: true }).click();
  await expect(page.getByLabel('项目文件夹', { exact: true })).toHaveValue('/workspace/new-project');
});
