import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const defaults = { language: 'zh', mode: 'demo', connection: 'api', claudeModel: '', chatgptModel: '', chatgptStorage: 'keyring', projectPath: '', provider: 'anthropic', model: 'claude-sonnet-4-5', baseUrl: '', verifyCommand: '', notifications: false, keyStorage: 'encrypted' };
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max;
export function validateSettings(input) {
  input = { language: 'zh', keyStorage: 'encrypted', connection: 'api', claudeModel: '', chatgptModel: '', chatgptStorage: 'keyring', ...input };
  if (!['keyring', 'file', 'session'].includes(input.chatgptStorage)) throw new Error('登录保存方式无效');
  if (!['api', 'chatgpt', 'claude'].includes(input.connection) || (!text(input.chatgptModel, 200) || !text(input.claudeModel, 200))) throw new Error('模型连接方式无效');
  if (!input || !['demo', 'pi'].includes(input.mode)) throw new Error('请选择演示或真实项目模式');
  for (const key of ['projectPath', 'provider', 'model', 'baseUrl', 'verifyCommand']) if (!text(input[key])) throw new Error(`${key} 配置无效`);
  if (!['zh','en','system'].includes(input.language)) throw Error('Invalid language preference');
  if (typeof input.notifications !== 'boolean') throw new Error('通知配置无效');
  if (!['encrypted', 'session'].includes(input.keyStorage)) throw new Error('密钥保存方式无效');
  if (input.mode === 'pi' && (!path.isAbsolute(input.projectPath) || (input.connection === 'api' && (!input.provider.trim() || !input.model.trim())))) throw new Error('请选择项目文件夹，并填写供应商与模型名称');
  if (input.mode === 'pi' && input.connection === 'api' && input.provider === 'custom' && !input.baseUrl.trim()) throw new Error('请填写自定义服务地址');
  if (input.baseUrl) {
    let url; try { url = new URL(input.baseUrl); } catch { throw new Error('服务地址格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址仅支持 HTTP/HTTPS，不可包含凭据、查询参数或片段');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程模型服务请使用 HTTPS；HTTP 仅适用于本机服务');
  }
  if (input.apiKey !== undefined && !text(input.apiKey, 16000)) throw new Error('模型密钥无效');
  return Object.fromEntries(Object.keys(defaults).map(k => [k, typeof input[k] === 'string' ? input[k].trim() : input[k]]));
}
export const credentialId = s => createHash('sha256').update(`${s.provider}\n${s.baseUrl}`).digest('hex');
export const projectId = projectPath => createHash('sha256').update(projectPath).digest('hex').slice(0, 24);

export class DesktopSettings {
  // Secret values are deliberately outside serializable settings, including pending saves.
  sessionKeys = new WeakMap();
  constructor(dir, crypto) { this.dir = dir; this.file = path.join(dir, 'desktop-settings.json'); this.crypto = crypto; this.data = { version: 1, settings: { ...defaults }, encryptedKeys: {} }; }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.encryptedKeys || typeof saved.encryptedKeys !== 'object') throw new Error('桌面设置格式无效');
      this.data = { ...saved, settings: validateSettings(saved.settings), projects: {} };
      for (const config of Object.values(saved.projects || {})) { const valid = validateSettings(config); if (valid.mode === 'pi') this.data.projects[projectId(valid.projectPath)] = valid; }
      if (this.data.settings.mode === 'pi') this.data.projects[projectId(this.data.settings.projectPath)] = this.data.settings;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this.public();
  }
  public() {
    const id = credentialId(this.data.settings);
    return { ...this.data.settings, hasApiKey: this.data.settings.keyStorage === 'session' ? !!this.sessionKeys.get(this.data)?.get(id) : !!this.data.encryptedKeys[id], dataDir: this.dir };
  }
  async prepare(input) {
    const settings = validateSettings({...input,language:this.data.settings.language});
    if (settings.mode === 'pi') {
      if (!(await fs.stat(settings.projectPath)).isDirectory()) throw new Error('请选择有效的项目文件夹');
      settings.projectPath = await fs.realpath(settings.projectPath);
      // An older saved path may be an alias (/tmp, a symlink, or a renamed mount).
      // Keep its workspace identity so selecting the same real directory does not
      // start a second worker or abandon its existing state and drafts.
      const known=[this.data.settings,...Object.values(this.data.projects||{})];
      for(const config of known){
        if(config.mode!=='pi')continue;
        let real;try{real=await fs.realpath(config.projectPath);}catch{continue;}
        if(real===settings.projectPath){settings.projectPath=config.projectPath;break;}
      }
    }
    const projects = { ...this.data.projects };
    if (this.data.settings.mode === 'pi') projects[projectId(this.data.settings.projectPath)] = this.data.settings;
    if (settings.mode === 'pi') projects[projectId(settings.projectPath)] = settings;
    const next = { version: 1, settings, encryptedKeys: { ...this.data.encryptedKeys }, projects };
    const id = credentialId(settings);
    const session = new Map(this.sessionKeys.get(this.data));
    if (settings.connection === 'api' && input.clearApiKey) { delete next.encryptedKeys[id]; session.delete(id); }
    if (settings.connection !== 'api') {
      // Switching channels preserves existing API credentials without reading them.
    } else if (settings.keyStorage === 'session') {
      delete next.encryptedKeys[id];
      if (input.apiKey?.trim()) session.set(id, input.apiKey.trim());
    } else {
      session.delete(id);
      if (input.apiKey?.trim()) {
        const unavailable = '系统安全存储不可用，密钥未保存。请检查 macOS 钥匙串访问和应用签名，或主动选择「仅本次运行使用密钥」后重试。';
        try {
          if (!(await this.crypto.available())) throw new Error();
          const encrypted = await this.crypto.encrypt(input.apiKey.trim());
          // Availability can report true even when encryption fails in local signed builds.
          if (await this.crypto.decrypt(encrypted) !== input.apiKey.trim()) throw new Error();
          next.encryptedKeys[id] = encrypted.toString('base64');
        } catch { throw new Error(unavailable); }
      }
    }
    const hasKey = settings.keyStorage === 'session' ? session.has(id) : !!next.encryptedKeys[id];
    if (settings.mode === 'pi' && settings.connection === 'api' && !hasKey && !['localhost', '127.0.0.1', '[::1]'].includes(settings.baseUrl ? new URL(settings.baseUrl).hostname : '')) throw new Error('请填写这个供应商的模型密钥；密钥不会跨供应商自动复用。');
    this.sessionKeys.set(next, session);
    return next;
  }
  async commit(next) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); await fs.rename(tmp, this.file);
    this.data = next; return this.public();
  }
  async rememberChatGPTStorage(chatgptStorage) {
    const next = { ...this.data, settings: validateSettings({ ...this.data.settings, chatgptStorage }) };
    this.sessionKeys.set(next, this.sessionKeys.get(this.data));
    return this.commit(next);
  }
  async savePreferences(input) {
    const {notifications=this.data.settings.notifications,language=this.data.settings.language}=input;
    if(!['zh','en','system'].includes(language))throw Error('Invalid language preference');
    if (typeof notifications !== 'boolean') throw Error('通知配置无效');
    const next={...this.data,settings:{...this.data.settings,notifications,language},projects:Object.fromEntries(Object.entries(this.data.projects||{}).map(([id,value])=>[id,{...value,notifications,language}]))};
    this.sessionKeys.set(next,this.sessionKeys.get(this.data));
    return this.commit(next);
  }
  forProject(config) {
    const data = { ...this.data, settings: { ...config, notifications:this.data.settings.notifications, language:this.data.settings.language } };
    this.sessionKeys.set(data, this.sessionKeys.get(this.data));
    return data;
  }
  async select(config) { return this.commit(this.forProject(config)); }
  async secret(data = this.data) {
    if (data.settings.keyStorage === 'session') return this.sessionKeys.get(data)?.get(credentialId(data.settings)) || '';
    const encrypted = data.encryptedKeys[credentialId(data.settings)];
    return encrypted ? this.crypto.decrypt(Buffer.from(encrypted, 'base64')) : '';
  }
}
