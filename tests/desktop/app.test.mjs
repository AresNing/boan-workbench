import {coordinationHttp} from '../helpers/coordination.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const root = path.resolve('.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error('桌面状态等待超时'); await sleep(100); } }
const readState = page => page.evaluate(() => fetch('/api/state').then(r => r.json()));

test('macOS 桌面应用：独立 Node、设置切换、真实 pi 工具、验收、退出重启', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-desktop-test-'));
  const project = path.join(dir, 'coding-project'); await fs.mkdir(project);
  const errors = [];
  let desktop;
  let managerCalls = 0, workerCalls = 0;
  const mock = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer public-desktop-session-fixture');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);if(coordinationHttp(data,res))return;const manager = data.tools?.some(t => t.function.name === 'submit_plan');
    const count = manager ? managerCalls++ : workerCalls++;
    let call;
    if (manager && count === 0) call = { name: 'submit_plan', arguments: { reply: '已安排问候文件。', actions: [{ type: 'create', text: '生成问候文件并验证', title: '桌面真实执行测试' }] } };
    if (!manager && count === 0) call = { name: 'write_file', arguments: { path: 'greeting.mjs', content: 'console.log("hello from desktop");\n' } };
    if (!manager && count === 1) call = { name: 'submit_result', arguments: { summary: '已生成问候文件。', verificationCommand: 'node greeting.mjs' } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'desktop-fixture', object: 'chat.completion.chunk', created: 1, model: 'desktop-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (call) { res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${manager ? 'm' : 'w'}_${count}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] })); res.write(chunk({}, 'tool_calls')); }
    else { res.write(chunk({ role: 'assistant', content: '已提交。' })); res.write(chunk({}, 'stop')); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  const launch = async () => {
    const executablePath = process.env.BOAN_TEST_EXECUTABLE;
    const env = { ...process.env, BOAN_BACKGROUND_TEST:'1', BOAN_USER_DATA: path.join(dir, 'app-data'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), env, timeout: 30000 });
    const page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('.desktop-app', { timeout: 30000 }); return page;
  };
  t.after(async () => { await desktop?.close().catch(() => {}); await new Promise(resolve => mock.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  let page = await launch();
  assert.equal(page.url(), 'boan://workbench/');
  assert.equal(await page.locator('.brand').innerText(), '');
  await until(() => page.locator('.brand img').evaluate(img => img.complete && img.naturalWidth > 0));
  assert.deepEqual(await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, bridge: !!window.desktop })), { node: 'undefined', process: 'undefined', bridge: true });
  await until(async () => (await readState(page)).tasks.some(t => t.status === 'review'));
  const demo = await readState(page); assert.deepEqual(demo.tasks[0].evidence.map(e => e.passed), [false, true]);
  assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible() || w.isFocused())), false);
  const prefs = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  await fs.mkdir(path.join(root, 'docs/screenshots'), { recursive: true });
  await page.getByRole('combobox', {name:'外观',exact:true}).click();
  await page.getByRole('option', {name:'深色外观',exact:true}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: 'docs/screenshots/desktop-macos.png' });
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === '文件').submenu.items.find(i => i.label === '打开项目…').click());
  await page.getByRole('heading', {name:'添加项目',exact:true}).waitFor();
  await page.getByRole('button', {name:'关闭面板'}).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '真实项目', exact: false }).click();
  // Exercise the native dialog path without interacting with the user's filesystem picker.
  await desktop.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  await page.getByRole('button', { name: '选择文件夹' }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '项目模型' }).click();
  await page.getByRole('combobox', { name: '模型供应商' }).click();
  await page.getByRole('option', { name: '自定义兼容服务', exact: true }).click();
  await page.getByRole('combobox', { name: '模型名称' }).click();await page.getByRole('textbox',{name:'搜索模型',exact:true}).fill('desktop-test');await page.getByRole('option',{name:/desktop-test/}).click();
  await page.getByRole('textbox', { name: '服务地址' }).fill(baseUrl);
  const saveBounds = await page.getByRole('button', { name: '保存并应用' }).boundingBox();
  const dialogBounds = await page.locator('dialog').boundingBox();
  assert.ok(saveBounds.y >= dialogBounds.y && saveBounds.y + saveBounds.height <= dialogBounds.y + dialogBounds.height, '保存按钮应完整显示在设置面板内');
  await page.screenshot({ path: 'docs/screenshots/desktop-settings.png' });
  await page.getByLabel('仅本次运行使用密钥', { exact: false }).check();
  await page.getByLabel('API Key', { exact: true }).fill('public-desktop-session-fixture');
  await page.getByRole('button', { name: '保存并应用' }).click();
  await until(async () => { try { return (await readState(page)).project.mode === 'pi'; } catch { return false; } });
  await page.waitForSelector('dialog', { state: 'detached' });
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('生成问候文件并验证');
  await page.getByRole('button', { name: '发送要求', exact: true }).click();
  try { await until(async () => (await readState(page)).tasks.some(t => t.status === 'review')); }
  catch (error) { const state = await readState(page); throw new Error(JSON.stringify({ reason: error.message, errors, preparation: state.preparation, tasks: state.tasks.map(t => ({ status: t.status, summary: t.summary })), alert: await page.locator('.error-banner').allTextContents() })); }
  assert.equal((await readState(page)).preparation.percent, 100);
  assert.equal(await page.getByRole('progressbar', { name: '前置准备阶段进度' }).count(), 0);
  assert.equal(await page.locator('.preparation-ready').innerText(), '已提交');
  assert.match(await fs.readFile(path.join(project, 'greeting.mjs'), 'utf8'), /hello from desktop/);
  assert.equal((await readState(page)).tasks[0].decisions, undefined);
  assert.equal((await readState(page)).tasks[0].evidence[0].sandboxed, true);
  await until(async () => (await readState(page)).tasks[0].status === 'review');
  const verified = (await readState(page)).tasks[0]; assert.equal(verified.evidence[0].passed, true); assert.match(verified.evidence[0].output, /hello from desktop/);
  await page.getByRole('button', { name: '查看执行过程', exact: true }).first().click();
  await page.getByRole('tab',{name:'执行记录',exact:true}).waitFor();
  const timeline = page.locator('.execution-timeline');
  assert.match(await timeline.innerText(), /更新项目文件/);
  assert.match(await timeline.innerText(), /独立验证/);
  await timeline.locator('summary').filter({ hasText: 'node greeting.mjs' }).click();
  assert.match(await timeline.locator('details[open] pre').innerText(), /hello from desktop/);
  await page.screenshot({ path: 'docs/screenshots/desktop-execution-grouped.png' });
  await page.getByRole('button', { name: '收起任务背景' }).click();
  await page.getByRole('button', { name: '工作记录', exact: true }).click();
  await page.waitForSelector('dialog .history-session');
  assert.ok(await page.locator('dialog .history-session').count() > 0);
  assert.equal(await page.locator('dialog .history-session[open]').count(), 0);
  assert.match(await page.locator('dialog .work-history').innerText(), /桌面真实执行测试/);
  await page.screenshot({ path: 'docs/screenshots/desktop-history-grouped.png' });
  await page.getByRole('button', { name: '关闭面板' }).click();
  await page.getByRole('button', { name: '确认完成', exact: true }).click();
  await until(async () => (await readState(page)).tasks[0].status === 'done');
  await page.getByRole('textbox', { name: '交代工作或补充要求' }).fill('保留桌面草稿');
  await desktop.close(); desktop = null;
  async function assertNoKeyOnDisk(dir) {
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, file.name);
      if (file.isDirectory()) await assertNoKeyOnDisk(full);
      else if (file.isFile()) assert.ok(!(await fs.readFile(full)).includes(Buffer.from('public-desktop-session-fixture')), `密钥不得写入 ${file.name}`);
    }
  }
  await assertNoKeyOnDisk(path.join(dir, 'app-data'));
  page = await launch();
  await page.getByLabel('API Key', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.getSettings())).hasApiKey, false);
  await page.getByLabel('API Key', { exact: true }).fill('public-desktop-session-fixture');
  await page.getByRole('button', { name: '保存并应用' }).click();
  await page.waitForSelector('dialog', { state: 'detached' });
  const restored = await readState(page); assert.equal(restored.project.mode, 'pi'); assert.equal(restored.tasks[0].status, 'done');
  assert.equal(await page.getByRole('textbox', { name: '交代工作或补充要求' }).inputValue(), '保留桌面草稿');
  assert.equal((await page.evaluate(() => window.desktop.getSettings())).hasApiKey, true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await until(async () => (await desktop.windows()).length === 0);
  const nextWindow = desktop.waitForEvent('window');
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '文件').submenu.items[0].click());
  page = await nextWindow; await page.waitForSelector('.desktop-app');
  assert.equal((await readState(page)).tasks[0].status, 'done');
  assert.deepEqual(errors, []);
});
