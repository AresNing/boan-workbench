import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesktopSettings, defaults, validateSettings, projectId } from '../desktop/settings.mjs';
import { startRuntime } from '../server/runtime.mjs';

test('历史项目路径别名复用原有工作区身份，真实路径与新别名不产生重复项目',async t=>{
  const dir=await fs.mkdtemp('/tmp/boan-settings-alias-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const folder=path.join(dir,'project'),alias=path.join(dir,'alias'),second=path.join(dir,'alias-two');
  await fs.mkdir(folder);await fs.symlink(folder,alias);await fs.symlink(folder,second);
  const settings={...defaults,mode:'pi',connection:'chatgpt',projectPath:alias};
  await fs.writeFile(path.join(dir,'desktop-settings.json'),JSON.stringify({version:1,settings,encryptedKeys:{}}));
  const store=new DesktopSettings(dir,{});await store.load();const id=projectId(alias);
  for(const projectPath of [folder,await fs.realpath(folder),second]){
    await store.commit(await store.prepare({...settings,projectPath}));
    assert.equal(store.data.settings.projectPath,alias);assert.deepEqual(Object.keys(store.data.projects),[id]);
  }
  const restarted=new DesktopSettings(dir,{});await restarted.load();
  assert.equal(projectId(restarted.data.settings.projectPath),id);
});

test('桌面设置只持久化加密密钥，公开接口不回显，跨供应商不复用', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Deterministic test cipher; production uses Electron safeStorage backed by macOS Keychain.
  const crypto = { available: async () => true, encrypt: async s => Buffer.from([...s].reverse().join('')), decrypt: async b => [...b.toString()].reverse().join('') };
  const store = new DesktopSettings(dir, crypto); await store.load();
  const input = { ...defaults, mode: 'pi', projectPath: dir, apiKey: 'test-key-not-a-real-credential' };
  await store.commit(await store.prepare(input));
  assert.equal(store.public().hasApiKey, true); assert.equal('apiKey' in store.public(), false);
  assert.ok(!(await fs.readFile(store.file, 'utf8')).includes(input.apiKey));
  assert.equal(await store.secret(), input.apiKey);
  const restored = new DesktopSettings(dir, crypto); await restored.load(); assert.equal(await restored.secret(), input.apiKey);
  await assert.rejects(store.prepare({ ...input, provider: 'openai', apiKey: '' }), /不会跨供应商/);
  await assert.rejects(store.prepare({ ...input, apiKey: '', clearApiKey: true }), /填写.*密钥/);
  assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
});

test('桌面配置验证路径、远程 HTTPS 和本地免密模型', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-config-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new DesktopSettings(dir, { available: async () => false });
  assert.throws(() => validateSettings({ ...defaults, mode: 'pi', projectPath: 'relative' }), /文件夹/);
  assert.throws(() => validateSettings({ ...defaults, baseUrl: 'http://remote.example/v1' }), /HTTPS/);
  assert.throws(() => validateSettings({ ...defaults, baseUrl: 'https://user:pass@example.com' }), /凭据/);
  await assert.rejects(store.prepare({ ...defaults, apiKey: 'fake' }), /安全存储不可用/);
  const local = await store.prepare({ ...defaults, mode: 'pi', projectPath: dir, provider: 'custom', baseUrl: 'http://127.0.0.1:9999/v1' });
  assert.equal(local.settings.provider, 'custom'); assert.equal(Object.keys(local.encryptedKeys).length, 0);
  assert.notEqual(projectId('/project/a'), projectId('/project/b'));
});

test('加密报告可用但实际失败时不落盘、不修改旧配置，也不自动改为内存模式', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-crypto-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new DesktopSettings(dir, { available: async () => true, encrypt: async () => { throw new Error('native failure'); } });
  const previous = store.data;
  await assert.rejects(store.prepare({ ...defaults, apiKey: 'public-test-value' }), /密钥未保存.*仅本次运行/);
  assert.equal(store.data, previous);
  assert.equal(store.public().keyStorage, 'encrypted');
  await assert.rejects(fs.stat(store.file), /ENOENT/);
});

test('仅本次运行密钥不序列化、按服务隔离，失败回滚保留原密钥，重启后不存在', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-session-key-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new DesktopSettings(dir, { available: async () => { throw new Error('不得调用安全存储'); } });
  const input = { ...defaults, mode: 'pi', projectPath: dir, provider: 'openai', keyStorage: 'session', apiKey: 'public-session-fixture' };
  const next = await store.prepare(input);
  assert.equal(await store.secret(next), input.apiKey);
  assert.ok(!JSON.stringify(next).includes(input.apiKey));
  await store.commit(next);
  assert.equal(store.public().hasApiKey, true);
  assert.ok(!(await fs.readFile(store.file, 'utf8')).includes(input.apiKey));
  assert.equal(Object.keys(store.data.encryptedKeys).length, 0);
  const pending = await store.prepare({ ...input, apiKey: 'public-replacement-fixture' });
  assert.equal(await store.secret(pending), 'public-replacement-fixture');
  assert.equal(await store.secret(), input.apiKey);
  await assert.rejects(store.prepare({ ...input, provider: 'anthropic', apiKey: '' }), /不会跨供应商/);
  await store.commit(await store.prepare({ ...input, apiKey: '' }));
  assert.equal(await store.secret(), input.apiKey);
  const restored = new DesktopSettings(dir, store.crypto); await restored.load();
  assert.equal(restored.public().hasApiKey, false);
  assert.equal(await restored.secret(), '');
});

test('桌面后台使用随机端口和会话令牌，关闭后释放锁并可恢复状态', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-runtime-'));
  let runtime;
  t.after(async () => { await runtime?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const config = { mode: 'demo', dataDir: dir, projectPath: path.join(dir, 'project'), distDir: path.resolve('dist'), accessToken: 'local-test-token', port: 0, demoDelay: 1000 };
  runtime = await startRuntime(config);
  assert.equal((await fetch(`${runtime.url}/api/state`)).status, 401);
  const request = await fetch(`${runtime.url}/api/state`, { headers: { 'x-workbench-token': config.accessToken } });
  assert.equal(request.status, 200); assert.ok(!(await request.text()).includes(config.accessToken));
  await assert.rejects(startRuntime(config), /已有服务/);
  await runtime.close(); await runtime.close();
  await assert.rejects(fs.stat(path.join(dir, 'server.lock')), /ENOENT/);
  runtime = await startRuntime(config);
  assert.equal(runtime.store.data.tasks[0].status, 'paused');
});

test('应用通知配置独立保存，保留项目模型与内存凭据，项目切换沿用全局偏好',async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-preferences-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new DesktopSettings(dir,{});await store.load();
 const original={...store.data.settings};const session=new Map([['fixture','private-in-memory']]);store.sessionKeys.set(store.data,session);
 await store.savePreferences({notifications:true});assert.equal(store.public().notifications,true);assert.equal(store.data.settings.model,original.model);assert.equal(store.sessionKeys.get(store.data),session);
 assert.equal(store.forProject({...original,notifications:false}).settings.notifications,true);
 const disk=await fs.readFile(store.file,'utf8');assert.ok(!disk.includes('private-in-memory'));const restored=new DesktopSettings(dir,{});await restored.load();assert.equal(restored.public().notifications,true);
 await assert.rejects(store.savePreferences({notifications:'yes'}));
});
