import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexClient } from '../server/codex-client.mjs';
import { ChatGPTLogin } from '../desktop/chatgpt.mjs';
import { DesktopSettings, defaults, validateSettings } from '../desktop/settings.mjs';

const account = { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' };
// Public, invalid offline fixture: never sent to an authentication or model endpoint.
const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ email: account.email, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'public-fixture' } })).toString('base64url')}.public-fixture`;
const auth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt, access_token: 'public-invalid-access-fixture', refresh_token: 'public-invalid-refresh-fixture', account_id: 'public-fixture' }, last_refresh: new Date().toISOString() };

test('三种保存选择持久恢复，旧钥匙串配置兼容，非法方式拒绝', async t => {
  const dir = await fs.mkdtemp('/tmp/boan-storage-settings-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const chatgptStorage of ['keyring', 'file', 'session']) {
    const settings = new DesktopSettings(dir, {});
    await settings.commit(await settings.prepare({ ...defaults, connection: 'chatgpt', chatgptStorage }));
    const restored = new DesktopSettings(dir, {}); await restored.load();
    assert.equal(restored.public().chatgptStorage, chatgptStorage);
    assert.ok(!(await fs.readFile(settings.file, 'utf8')).includes('tokens'));
  }
  const { chatgptStorage, ...old } = defaults;
  assert.equal(validateSettings(old).chatgptStorage, 'keyring');
  assert.throws(() => validateSettings({ ...defaults, chatgptStorage: 'other' }), /保存方式/);
  const settings = new DesktopSettings(dir, {});
  await settings.commit(await settings.prepare({ ...defaults, keyStorage: 'session', apiKey: 'public-api-session-fixture' }));
  await settings.rememberChatGPTStorage('file');
  assert.equal(await settings.secret(), 'public-api-session-fixture');
  assert.equal(settings.public().connection, 'api');
  const restored = new DesktopSettings(dir, {}); await restored.load();
  assert.equal(restored.public().chatgptStorage, 'file');
  assert.ok(!(await fs.readFile(settings.file, 'utf8')).includes('public-api-session-fixture'));
});

test('钥匙串选择映射官方 auto，同次授权降级后报告文件保存；内存方式忽略磁盘状态', async t => {
  const home = await fs.mkdtemp('/tmp/boan-storage-status-');
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const [storage, expected] of [['keyring', 'auto'], ['file', 'file'], ['session', 'ephemeral']]) {
    await fs.rm(path.join(home, 'auth.json'), { force: true });
    let loggedIn = false, starts = 0;
    const client = new EventEmitter();
    client.start = async () => client; client.close = () => client.emit('closed');
    client.request = async method => {
      if (method === 'account/read') return { account: loggedIn ? { ...account, accessToken: 'never-expose' } : null };
      if (method === 'account/login/start') { starts++; return { type: 'chatgpt', loginId: 'fixture', authUrl: 'https://auth.openai.com/oauth/authorize?state=public' }; }
      if (method === 'account/logout') loggedIn = false;
      return {};
    };
    const login = new ChatGPTLogin({ home, clientFactory: options => { assert.equal(options.credentialStore, expected); return client; }, openExternal: async () => {} });
    login.storage = storage;
    await login.login();
    // Simulate the official backend's completed save, not an additional OAuth retry.
    await fs.writeFile(path.join(home, 'auth.json'), '{}', { mode: 0o600 });
    loggedIn = true; client.emit('notification', 'account/login/completed', { loginId: 'fixture', success: true });
    const status = await login.status();
    assert.equal(status.storage, storage);
    assert.equal(status.effectiveStorage, storage === 'session' ? 'session' : 'file');
    assert.equal(status.fallback, storage === 'keyring'); assert.equal(starts, 1);
    assert.ok(!JSON.stringify(status).includes('never-expose'));
    await assert.rejects(login.login(storage === 'session' ? 'file' : 'session'), /先退出/);
    assert.equal((await login.logout()).loggedIn, false);
    await assert.rejects(fs.access(path.join(home, 'auth.json')));
    login.close();
  }
});

test('官方 Codex 文件登录重启恢复、收紧权限、退出后文件和登录均清除', { timeout: 30000 }, async t => {
  const home = await fs.mkdtemp('/tmp/boan-storage-native-');
  const file = path.join(home, 'auth.json');
  await fs.writeFile(file, JSON.stringify(auth), { mode: 0o644 }); await fs.chmod(home, 0o755);
  let login = new ChatGPTLogin({ home }); login.storage = 'file';
  t.after(async () => { login.close(); await fs.rm(home, { recursive: true, force: true }); });
  const first = await login.status();
  assert.equal(first.loggedIn, true); assert.equal(first.effectiveStorage, 'file');
  assert.equal(first.email, account.email); assert.equal(first.fallback, false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(first).includes('public-invalid'));
  login.close(); login = new ChatGPTLogin({ home }); login.storage = 'file';
  assert.equal((await login.status()).loggedIn, true);
  assert.equal((await login.logout()).loggedIn, false);
  await assert.rejects(fs.access(file));
  login.close(); login = new ChatGPTLogin({ home }); login.storage = 'file';
  assert.equal((await login.status()).loggedIn, false);
});

test('官方 Codex auto 实际保存公开测试值并跨进程恢复，文件降级遵循 0600 权限', { timeout: 30000 }, async t => {
  const home = await fs.mkdtemp('/tmp/boan-storage-auto-');
  const make = () => new CodexClient({ home, credentialStore: 'auto', spawnProcess: (exe, args, options) => spawn(exe, [...args, '-c', 'forced_login_method="api"'], options) });
  let client = make();
  t.after(async () => { client.close(); await fs.rm(home, { recursive: true, force: true }); });
  await client.start();
  await client.request('account/login/start', { type: 'apiKey', apiKey: 'public-boan-auto-storage-fixture' });
  assert.equal((await client.request('account/read', { refreshToken: false })).account.type, 'apiKey');
  const file = await fs.stat(path.join(home, 'auth.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (file) { assert.equal(file.mode & 0o777, 0o600); t.diagnostic('已实际触发官方 auto 的钥匙串失败 → 本机文件降级'); }
  else t.diagnostic('本机钥匙串可用，auto 已保存到钥匙串；未触发失败降级');
  client.close(); client = make(); await client.start();
  assert.equal((await client.request('account/read', { refreshToken: false })).account.type, 'apiKey');
  await client.request('account/logout', {});
  await assert.rejects(fs.access(path.join(home, 'auth.json')));
  assert.equal((await client.request('account/read', { refreshToken: false })).account, null);
});

test('钥匙串删除失败仍清理降级文件和内存进程，并明确报告未完成的清理', async t => {
  const home = await fs.mkdtemp('/tmp/boan-storage-logout-');
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'auth.json'), '{}', { mode: 0o600 });
  const client = new EventEmitter(); let closed = false;
  client.start = async () => client;
  client.close = () => { closed = true; client.emit('closed'); };
  client.request = async method => { if (method === 'account/logout') throw new Error('keyring inaccessible'); return { account }; };
  const login = new ChatGPTLogin({ home, clientFactory: () => client });
  await assert.rejects(login.logout(), /钥匙串清理失败/);
  assert.equal(closed, true); assert.equal(login.client, null);
  await assert.rejects(fs.access(path.join(home, 'auth.json')));
});

test('拒绝凭据符号链接，避免读写项目外其他文件', async t => {
  const home = await fs.mkdtemp('/tmp/boan-storage-link-');
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, 'target'); await fs.writeFile(target, 'public-fixture', { mode: 0o644 });
  await fs.symlink(target, path.join(home, 'auth.json'));
  const client = new CodexClient({ home, credentialStore: 'file' });
  await assert.rejects(client.start(), /独立的本机文件/);
  assert.equal(await fs.readFile(target, 'utf8'), 'public-fixture');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
});
