import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiCapabilities, codexCapabilities } from './model-capabilities.mjs';
import { defaults, validateSettings, credentialId } from './settings.mjs';

const local = url => Boolean(url) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
export const legacyProfileId = c => `legacy-${credentialId(c)}-${c.keyStorage}`;
export class ModelProfiles {
  constructor(dir, crypto, settings) { this.file = path.join(dir, 'model-profiles.json'); this.crypto = crypto; this.settings = settings; this.data = { version: 1, profiles: [] }; this.keys = new Map(); this.queue = Promise.resolve(); }
  async load() {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    this.catalog = await ModelRuntime.create({ authPath: path.join(path.dirname(this.file), 'catalog-auth.json'), modelsPath: null, modelsStorePath: path.join(path.dirname(this.file), 'catalog-models.json'), refreshOnCreate: false });
    try { const data = JSON.parse(await fs.readFile(this.file, 'utf8')); if (data.version !== 1 || !Array.isArray(data.profiles)) throw Error('模型服务配置格式无效'); this.data = data; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async persist(data) { await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); await fs.writeFile(`${this.file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(`${this.file}.tmp`, this.file); this.data = data; }
  serialized(fn) { const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job; }
  cacheChatGPT(models) { return this.serialized(async () => {
    const chatgptModels = models.filter(m => typeof m.id === 'string' && m.id.length <= 160).map(m => ({ id: m.id, name: typeof m.name === 'string' ? m.name.slice(0, 160) : m.id, isDefault: Boolean(m.isDefault), ...codexCapabilities(m) }));
    await this.persist({ ...this.data, chatgptModels });
  }); }
  async importLegacy(config) {
    if (config.mode !== 'pi' || config.connection !== 'api') return;
    return this.serialized(async () => {
      const id = legacyProfileId(config), found = this.data.profiles.find(p => p.id === id);
      if (found?.models.includes(config.model)) return;
      const profile = found ? { ...found, models: [...found.models, config.model] } : { id, name: `${config.provider === 'custom' ? '兼容服务' : config.provider}（已有连接）`, provider: config.provider, baseUrl: config.baseUrl, keyStorage: config.keyStorage, models: [config.model], legacy: true };
      await this.persist({ ...this.data, profiles: [...this.data.profiles.filter(p => p.id !== id), profile] });
    });
  }
  hasKey(profile) { return profile.legacy ? profile.keyStorage === 'session' ? Boolean(this.settings.sessionKeys.get(this.settings.data)?.get(credentialId(profile))) : Boolean(this.settings.data.encryptedKeys[credentialId(profile)]) : profile.keyStorage === 'session' ? this.keys.has(profile.id) : Boolean(profile.encryptedKey); }
  public() { return this.data.profiles.map(p => ({ id: p.id, name: p.name, provider: p.provider, baseUrl: p.baseUrl, models: p.models, keyStorage: p.keyStorage, legacy: Boolean(p.legacy), hasApiKey: this.hasKey(p), available: this.hasKey(p) || local(p.baseUrl) })); }
  options() { return this.public().flatMap(p => p.models.map(model => ({ profileId: p.id, model, label: model, provider: p.name, connection: 'api', available: p.available, ...apiCapabilities(p.provider, model, this.catalog) }))); }
  save(input) { return this.serialized(async () => {
    const old = input.id ? this.data.profiles.find(p => p.id === input.id) : null;
    if (input.id && !old) throw Error('模型服务不存在');
    if (old?.legacy) throw Error('已有项目连接请在项目默认连接中修改，或添加新的模型服务');
    if (!['openai', 'anthropic', 'custom'].includes(input.provider)) throw Error('请选择 OpenAI、Anthropic 或兼容服务');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw Error('请填写服务名称');
    const models = [...new Set((typeof input.models === 'string' ? input.models.split(/[\n,]/) : input.models || []).map(m => typeof m === 'string' ? m.trim() : ''))].filter(Boolean);
    if (!models.length || models.length > 50 || models.some(m => m.length > 160 || /\s/.test(m))) throw Error('请填写有效模型 ID，每行一个，最多 50 个');
    const clean = validateSettings({ ...defaults, provider: input.provider, baseUrl: input.baseUrl || '', keyStorage: input.keyStorage, apiKey: input.apiKey });
    if (input.provider === 'custom' && !clean.baseUrl) throw Error('请填写兼容服务地址');
    if (old && (old.provider !== clean.provider || old.baseUrl !== clean.baseUrl)) throw Error('服务厂商和地址不能原地替换，请添加新连接以保留旧任务的模型归属');
    const profile = { id: old?.id || randomUUID(), name: input.name.trim(), provider: clean.provider, baseUrl: clean.baseUrl, models, keyStorage: clean.keyStorage };
    let key = input.apiKey?.trim();
    if (!key && old) key = old.keyStorage === 'session' ? this.keys.get(old.id) : old.encryptedKey ? await this.crypto.decrypt(Buffer.from(old.encryptedKey, 'base64')) : '';
    if (!key && !local(profile.baseUrl)) throw Error('请填写此服务的 API Key');
    if (key && profile.keyStorage === 'encrypted') {
      try { if (!(await this.crypto.available())) throw Error(); const encrypted = await this.crypto.encrypt(key); if (await this.crypto.decrypt(encrypted) !== key) throw Error(); profile.encryptedKey = encrypted.toString('base64'); }
      catch { throw Error('系统安全存储失败，密钥未保存。可选择仅本次运行后重试。'); }
    }
    await this.persist({ ...this.data, profiles: [...this.data.profiles.filter(p => p.id !== profile.id), profile] });
    if (profile.keyStorage === 'session' && key) this.keys.set(profile.id, key); else this.keys.delete(profile.id);
    return this.public();
  }); }
  remove(id) { return this.serialized(async () => { const p = this.data.profiles.find(p => p.id === id); if (!p || p.legacy) throw Error('此连接不能在这里删除'); await this.persist({ ...this.data, profiles: this.data.profiles.filter(p => p.id !== id) }); this.keys.delete(id); return this.public(); }); }
  async resolve(selection) {
    const profile = this.data.profiles.find(p => p.id === selection.profileId);
    if (!profile || !profile.models.includes(selection.model)) throw Error('任务所选模型已移除，请选择其他模型');
    const apiKey = profile.legacy ? await this.settings.secret(this.settings.forProject({ ...defaults, ...profile })) : profile.keyStorage === 'session' ? this.keys.get(profile.id) || '' : profile.encryptedKey ? await this.crypto.decrypt(Buffer.from(profile.encryptedKey, 'base64')) : '';
    if (!apiKey && !local(profile.baseUrl)) throw Error('任务所选厂商缺少密钥，请在设置中补充');
    return { connection: 'api', provider: profile.provider, model: selection.model, baseUrl: profile.baseUrl, apiKey, api: profile.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions' };
  }
}
