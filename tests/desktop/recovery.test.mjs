import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

async function launch(t) {
  const dir = await fs.mkdtemp('/tmp/boan-recovery-test-');
  const env = { ...process.env, BOAN_BACKGROUND_TEST:'1', BOAN_USER_DATA: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.BOAN_TEST_EXECUTABLE;
  const app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.resolve('.')] }), env });
  t.after(async () => { await app.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.desktop-app');
  return { app, page, dir };
}

test('后台连接失败时页面仍可加载，并在重连后保留草稿', { timeout: 30000 }, async t => {
  const { app, page } = await launch(t);
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('recovery draft');
  await app.evaluate(({ net }) => {
    globalThis.originalTestFetch = net.fetch;
    net.fetch = async () => { throw new Error('injected backend transport failure'); };
  });
  await page.reload().catch(() => {});
  await page.getByRole('button', { name: '重新连接', exact: true }).waitFor({ timeout: 5000 });
  await app.evaluate(({ net }) => { net.fetch = globalThis.originalTestFetch; });
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await page.waitForSelector('.desktop-app');
  assert.equal(await page.getByRole('textbox', { name: '交代工作或补充要求' }).inputValue(), 'recovery draft');
});

test('重复选择文件夹只打开一个系统弹窗', { timeout: 30000 }, async t => {
  const { app, page, dir } = await launch(t);
  await app.evaluate(({ dialog }, selected) => {
    globalThis.pickerCalls = 0;
    dialog.showOpenDialog = () => {
      globalThis.pickerCalls++;
      return new Promise(resolve => setTimeout(() => resolve({ canceled: false, filePaths: [selected] }), 150));
    };
  }, dir);
  const selected = await page.evaluate(() => Promise.all([window.desktop.chooseProject(), window.desktop.chooseProject()]));
  assert.deepEqual(selected, [dir, dir]);
  assert.equal(await app.evaluate(() => globalThis.pickerCalls), 1);
});

test('主页面脚本读取失败显示恢复入口，恢复文件读取后可重新加载', { timeout: 30000 }, async t => {
  const { app, page } = await launch(t);
  await app.evaluate(async () => {
    const fs = process.getBuiltinModule('fs/promises');
    globalThis.originalReadFile = fs.readFile;
    fs.readFile = (file, ...args) => String(file).includes('/dist/assets/') && String(file).endsWith('.js')
      ? Promise.reject(new Error('injected bundle read failure')) : globalThis.originalReadFile(file, ...args);
  });
  await page.reload();
  await page.getByRole('button', { name: '重新加载页面', exact: true }).waitFor({ timeout: 10000 });
  await app.evaluate(async () => { process.getBuiltinModule('fs/promises').readFile = globalThis.originalReadFile; });
  await page.getByRole('button', { name: '重新加载页面', exact: true }).click();
  await page.waitForSelector('.desktop-app');
});

test('草稿存储不可用不会让整个页面空白', { timeout: 30000 }, async t => {
  const { page } = await launch(t);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('injected storage failure'); };
    Storage.prototype.setItem = () => { throw new Error('injected storage failure'); };
  });
  await page.reload();
  await page.waitForSelector('.desktop-app');
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('still editable');
  await page.getByText('草稿暂时无法保存，请保留输入内容后重试。').waitFor();
  assert.equal(await page.getByRole('textbox', { name: '交代工作或补充要求' }).inputValue(), 'still editable');
});

test('渲染进程中断后重新加载可恢复项目和草稿', { timeout: 30000 }, async t => {
  const { app, page } = await launch(t);
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('renderer recovery draft');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  const crashed = page.waitForEvent('crash');
  // Playwright's waitForEvent rejects on a crash by design; observe the subsequent
  // navigation directly to test the application's own crash-recovery action.
  const recovered = new Promise(resolve => page.once('domcontentloaded', resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await crashed;
  await recovered;
  // Electron's recovered WebContents can be live while Playwright's old Page
  // remains marked crashed. Read the actual replacement renderer from Electron.
  const deadline = Date.now() + 5000;
  let restored = false;
  while (!restored && Date.now() < deadline) {
    restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`Boolean(document.querySelector('.desktop-app')) && document.querySelector('textarea')?.value === 'renderer recovery draft'`));
    if (!restored) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(restored, true);
});

test('状态渲染异常显示恢复页面，不丢失持久草稿', { timeout: 30000 }, async t => {
  const { app, page } = await launch(t);
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('boundary recovery draft');
  await app.evaluate(({ net }) => {
    globalThis.originalBoundaryFetch = net.fetch;
    net.fetch = async url => new URL(url).pathname === '/api/state'
      ? new Response('{"project":null,"tasks":[]}', { headers: { 'Content-Type': 'application/json' } })
      : new Response('', { status: 503 });
  });
  await page.reload();
  await page.getByRole('heading', { name: '页面暂时无法显示' }).waitFor();
  await app.evaluate(({ net }) => { net.fetch = globalThis.originalBoundaryFetch; });
  await page.getByRole('button', { name: '重新加载页面', exact: true }).click();
  await page.waitForSelector('.desktop-app');
  assert.equal(await page.getByRole('textbox', { name: '交代工作或补充要求' }).inputValue(), 'boundary recovery draft');
});
