import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaults } from '../../desktop/settings.mjs';

test('桌面 ChatGPT 登录入口、内置 Codex、取消、模型列表、退出和 API 切换', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp('/tmp/boan-chatgpt-ui-');
  const executablePath = process.env.BOAN_TEST_EXECUTABLE;
  const env = { ...process.env, BOAN_BACKGROUND_TEST:'1', BOAN_USER_DATA: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.resolve('.')] }), env });
  t.after(async () => { await app.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.desktop-app');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '真实项目' }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '项目模型' }).click();
  await page.getByRole('button', { name: 'ChatGPT 登录', exact: false }).click();
  // This calls the actual bundled native binary using a new isolated CODEX_HOME.
  const status = await page.evaluate(() => window.desktop.chatgptStatus()); assert.equal(status.loggedIn, false);
  assert.equal(await page.getByLabel('API Key', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '保存并应用' }).isDisabled(), true);
  await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'账号与服务'}).click();
  const storageChoice = page.getByRole('combobox', { name: '登录凭据保存方式' });
  assert.match(await storageChoice.innerText(), /系统钥匙串/);
  await storageChoice.click();
  assert.equal(await page.getByRole('option').count(), 3);
  await storageChoice.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 1);
  await storageChoice.click();
  await page.getByRole('option', { name: '保存到本机文件（重启后保持登录）', exact: true }).click();
  await page.getByText('保存在项目外的应用数据目录', { exact: false }).waitFor();
  await storageChoice.click();
  await page.getByRole('option', { name: '仅本次运行登录（退出后需重新登录）', exact: true }).click();
  // Exercise the real OAuth start/cancel without opening an account page or using credentials.
  await app.evaluate(({ shell }) => { globalThis.boanOpenedOfficialLogin = false; shell.openExternal = async url => { globalThis.boanOpenedOfficialLogin = new URL(url).hostname === 'auth.openai.com'; }; });
  await page.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).click();
  await page.getByText('等待浏览器完成登录，完成后这里会自动更新。').waitFor();
  assert.equal(await app.evaluate(() => globalThis.boanOpenedOfficialLogin), true);
  assert.equal((await page.evaluate(() => window.desktop.chatgptStatus())).storage, 'session');
  assert.equal((await page.evaluate(() => window.desktop.getSettings())).chatgptStorage, 'session');
  assert.equal(await storageChoice.isDisabled(), true);
  await page.getByRole('button', { name: '取消登录', exact: true }).click();
  await page.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).waitFor();
  // UI-only account fixture: no token is generated, stored, imported, or sent.
  await app.evaluate(({ ipcMain }) => {
    let loggedIn = false, storage = 'session';
    const state = () => ({ loggedIn, storage, effectiveStorage: loggedIn ? 'file' : null, fallback: loggedIn && storage === 'keyring', email: loggedIn ? 'fixture@example.test' : null, plan: loggedIn ? 'pro' : null, pending: false, error: '' });
    for (const name of ['status', 'login', 'logout', 'models']) ipcMain.removeHandler(`desktop:chatgpt-${name}`);
    ipcMain.handle('desktop:chatgpt-status', state);
    ipcMain.handle('desktop:chatgpt-login', (_event, selected) => { storage = selected; loggedIn = true; return state(); });
    ipcMain.handle('desktop:chatgpt-logout', () => { loggedIn = false; return state(); });
    ipcMain.handle('desktop:chatgpt-models', () => [{ id: 'fixture-model', name: 'Fixture Model', isDefault: true }]);
  });
  await storageChoice.click();
  await page.getByRole('option', { name: '系统钥匙串（失败后自动保存到本机文件）', exact: true }).click();
  await page.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).click();
  await page.getByText('已登录 · fixture@example.test · pro').waitFor();
  await page.getByText('已自动降级：登录凭据已保存到本机文件，重启后可继续使用。').waitFor();
  await page.getByText('登录凭据与存储', { exact: true }).click();
  assert.equal(await storageChoice.isDisabled(), true);
  await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'项目模型'}).click();
  await page.getByRole('combobox', { name: 'Codex 模型' }).click();
  await page.getByRole('option', { name: 'Fixture Model（默认）', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '保存并应用' }).isEnabled(), true);
  await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'账号与服务'}).click();
  await page.screenshot({ path: 'docs/screenshots/desktop-chatgpt-fixture.png' });
  await page.getByRole('button', { name: '退出 ChatGPT 登录', exact: true }).click();
  await storageChoice.click();
  await page.getByRole('option', { name: '保存到本机文件（重启后保持登录）', exact: true }).click();
  await page.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).click();
  await page.getByText('登录凭据已保存到本机文件，重启后可继续使用。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '退出 ChatGPT 登录', exact: true }).click();
  await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'项目模型'}).click();
  await page.getByRole('button', { name: 'API Key', exact: false }).click();
  await page.getByLabel('API Key', { exact: true }).waitFor();
  await assert.rejects(fs.access(path.join(dir, 'codex', 'auth.json')));
});

test('桌面文件登录：真实 Codex 离线读取、退出应用后恢复、退出账号清除', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp('/tmp/boan-chatgpt-restart-ui-');
  const home = path.join(dir, 'codex'); await fs.mkdir(home, { mode: 0o700 });
  // Invalid public fixture; only account/read is used, never a model or token refresh.
  const claims = { email: 'offline@example.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'public-offline-fixture' } };
  const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.public-invalid`;
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: token, access_token: 'public-invalid-access', refresh_token: 'public-invalid-refresh', account_id: 'public-offline-fixture' }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'desktop-settings.json'), JSON.stringify({ version: 1, settings: { ...defaults, chatgptStorage: 'file' }, encryptedKeys: {} }), { mode: 0o600 });
  let app;
  const launch = async () => {
    const executablePath = process.env.BOAN_TEST_EXECUTABLE;
    const env = { ...process.env, BOAN_BACKGROUND_TEST:'1', BOAN_USER_DATA: dir }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.resolve('.')] }), env });
    const page = await app.firstWindow(); await page.waitForSelector('.desktop-app'); return page;
  };
  t.after(async () => { await app?.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  let page = await launch();
  const status = await page.evaluate(() => window.desktop.chatgptStatus());
  assert.equal(status.loggedIn, true); assert.equal(status.effectiveStorage, 'file');
  assert.equal(status.email, 'offline@example.test'); assert.ok(!JSON.stringify(status).includes('public-invalid'));
  await app.close(); app = null;
  page = await launch();
  assert.equal((await page.evaluate(() => window.desktop.chatgptStatus())).loggedIn, true);
  assert.equal((await page.evaluate(() => window.desktop.chatgptLogout())).loggedIn, false);
  await assert.rejects(fs.access(path.join(home, 'auth.json')));
  await app.close(); app = null;
  page = await launch();
  assert.equal((await page.evaluate(() => window.desktop.chatgptStatus())).loggedIn, false);
});
