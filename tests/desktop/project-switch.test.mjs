import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaults } from '../../desktop/settings.mjs';

test('已登录 ChatGPT 连续切换项目，页面加载与各项目草稿恢复', { timeout: 90000 }, async t => {
  const dir = await fs.mkdtemp('/tmp/boan-switch-regression-');
  const data = path.join(dir, 'app-data');
  const home = path.join(data, 'codex');
  const projects = [path.join(dir, 'switch-first'), path.join(dir, 'switch-second')];
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  for (const project of projects) await fs.mkdir(project);
  // Public invalid OAuth fixture, used only by offline account/read. No model call.
  const claims = { email: 'switch@example.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'public-switch-fixture' } };
  const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.public-invalid`;
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: token, access_token: 'public-invalid-access', refresh_token: 'public-invalid-refresh', account_id: 'public-switch-fixture' }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
  const settings = { ...defaults, mode: 'pi', connection: 'chatgpt', chatgptStorage: 'file', projectPath: projects[0] };
  await fs.writeFile(path.join(data, 'desktop-settings.json'), JSON.stringify({ version: 1, settings, encryptedKeys: {} }), { mode: 0o600 });
  const executablePath = process.env.BOAN_TEST_EXECUTABLE;
  const env = { ...process.env, BOAN_BACKGROUND_TEST:'1', BOAN_USER_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.resolve('.')] }), env });
  t.after(async () => { await app.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('.desktop-app');
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('first project draft');
  for (let n = 1; n <= 8; n++) {
    const index = n % 2;
    await page.evaluate(value => window.desktop.saveSettings(value), { ...settings, projectPath: projects[index] });
    await page.getByRole('button', { name: new RegExp(`${path.basename(projects[index])} 项目工作区`) }).waitFor({ timeout: 15000 });
    const input = page.getByRole('textbox', { name: '交代工作或补充要求' });
    if (n === 1) await input.fill('second project draft');
    else assert.equal(await input.inputValue(), index ? 'second project draft' : 'first project draft');
    assert.equal((await page.evaluate(() => window.desktop.chatgptStatus())).loggedIn, true);
  }
  assert.deepEqual(errors, []);
});
