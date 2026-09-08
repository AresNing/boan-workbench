import { CodexClient, safeError } from '../server/codex-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const stores = { keyring: 'auto', file: 'file', session: 'ephemeral' };

export class ChatGPTLogin {
  constructor({ home, openExternal, clientFactory }) { this.home = home; this.storage = 'keyring'; this.openExternal = openExternal; this.clientFactory = clientFactory; this.pending = null; this.error = ''; }
  async connect() {
    if (!this.connecting) this.connecting = (async () => {
      // Codex auto falls back during the same OAuth save, without a second login.
      const options = { home: this.home, credentialStore: stores[this.storage] };
      const client = this.clientFactory?.(options) || new CodexClient(options);
      this.client = client;
      client.on('closed', () => { if (this.client === client) { this.connecting = null; this.client = null; this.pending = null; } });
      client.on('notification', (method, p) => {
        if (this.client !== client) return;
        if (method === 'account/login/completed' && (!this.pending || this.pending === p.loginId)) { this.pending = null; this.error = p.success ? '' : /keyring|persist_failed|secure storage|credentials could not be saved locally/i.test(String(p.error)) ? '登录凭据未能保存。请检查应用数据目录的写入权限，或选择「仅本次运行登录」重试。' : safeError(p.error || '登录未完成，请重试。'); }
      });
      await client.start(); return client;
    })().catch(e => { this.connecting = null; throw e; });
    return this.connecting;
  }
  async status() {
    const client = await this.connect();
    const { account } = await client.request('account/read', { refreshToken: false });
    const loggedIn = account?.type === 'chatgpt';
    let fileSaved = false;
    if (loggedIn && this.storage !== 'session') {
      try { fileSaved = (await fs.lstat(path.join(this.home, 'auth.json'))).isFile(); }
      catch (e) { if (e.code !== 'ENOENT') throw new Error('无法确认登录凭据的保存位置，请检查应用数据目录权限。'); }
    }
    const effectiveStorage = loggedIn ? (this.storage === 'session' ? 'session' : fileSaved ? 'file' : 'keyring') : null;
    return { storage: this.storage, effectiveStorage, fallback: this.storage === 'keyring' && effectiveStorage === 'file', loggedIn, email: loggedIn ? account.email : null, plan: loggedIn ? account.planType : null, pending: !!this.pending, error: this.error };
  }
  async login(storage = this.storage) {
    if (!Object.hasOwn(stores, storage)) throw new Error('请选择有效的登录保存方式');
    if (this.loggingIn) throw new Error('正在打开登录，请稍候。');
    this.loggingIn = true;
    try {
      if (storage !== this.storage) {
        const status = await this.status();
        if (status.loggedIn || status.pending) throw new Error('请先退出或取消当前登录，再更换保存方式。');
        const old = this.client; this.client = null; this.connecting = null; old?.close(); this.storage = storage;
      }
      const client = await this.connect();
      if (this.pending) return this.status();
      this.error = '';
      const result = await client.request('account/login/start', { type: 'chatgpt' });
      if (result.type !== 'chatgpt') throw new Error('未获得 ChatGPT 登录入口。');
      this.pending = result.loginId;
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) { await this.cancel(); throw new Error('登录地址未通过校验。'); }
      try { await this.openExternal(result.authUrl); }
      catch { await this.cancel(); throw new Error('无法打开浏览器，请重试登录。'); }
      return this.status();
    } finally { this.loggingIn = false; }
  }
  async cancel() { if (this.pending) { await (await this.connect()).request('account/login/cancel', { loginId: this.pending }); this.pending = null; } this.error = ''; return this.status(); }
  async logout() {
    await this.cancel();
    try { await (await this.connect()).request('account/logout', {}); }
    catch {
      // Codex auto may fail on keyring deletion before reaching its fallback file.
      // Clear the local file and the process anyway, but never claim keyring removal.
      try { await fs.rm(path.join(this.home, 'auth.json'), { force: true }); }
      finally { const client = this.client; this.client = null; this.connecting = null; client?.close(); }
      this.error = '本机文件和本次运行登录已清除，但系统钥匙串清理失败，请重试退出登录。';
      throw new Error(this.error);
    }
    await fs.rm(path.join(this.home, 'auth.json'), { force: true });
    return this.status();
  }
  async models() {
    if (!(await this.status()).loggedIn) return [];
    const result = await (await this.connect()).request('model/list', { includeHidden: false });
    return result.data.map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault, efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort), speeds: (m.serviceTiers || []).map(t => ({ value: t.id, label: t.name })) }));
  }
  close() { this.client?.close(); }
}
