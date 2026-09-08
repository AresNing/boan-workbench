import { publicText } from './activity.mjs';
import {modelIdentity} from './task-lifecycle.mjs';
import { PiBackend } from './pi.mjs';
import { ClaudeBackend } from './claude.mjs';
import { CodexBackend } from './codex.mjs';

// Persist only these public fields. Credentials are resolved over private desktop IPC.
export function modelSelection(options, value) {
  if (!value || typeof value.profileId !== 'string' || typeof value.model !== 'string') throw new Error('请选择可用的厂商和模型');
  const match = options.find(option => option.profileId === value.profileId && option.model === value.model);
  if (!match || match.available === false) throw new Error('此模型连接不可用，请在设置中检查配置');
  if (value.effort && !(match.efforts || []).includes(value.effort)) throw new Error('此模型不支持所选思考强度，请重新选择');
  if (value.speed && value.speed !== 'standard' && !(match.speeds || []).some(s => s.value === value.speed)) throw new Error('此模型不支持所选速度，请重新选择');
  return { ...(value.effort ? { effort: value.effort } : {}), ...(value.speed ? { speed: value.speed } : {}), ...Object.fromEntries(['profileId', 'model', 'label', 'provider', 'connection'].map(key => [key, match[key]])) };
}
export class ModelRouter {
  constructor(config) { this.config = config; this.workers=new Map(); }
  options() { return this.config.modelOptions || []; }
  select(value) { return modelSelection(this.options(), value || this.config.defaultModel); }
  async backend(value) {
    const selected = this.select(value);
    const resolved = await this.config.resolveModel(selected);
    // Never let a connection profile override the project, permission or runtime boundary.
    const allowed = Object.fromEntries(['connection', 'provider', 'model', 'baseUrl', 'apiKey', 'chatgptModel', 'claudeModel', 'api'].map(key => [key, resolved[key]]));
    const config = { ...this.config, ...allowed, effort: selected.effort, speed: selected.speed || 'standard' };
    return config.connection === 'claude' ? new ClaudeBackend(config) : config.connection === 'chatgpt' ? new CodexBackend(config) : new PiBackend(config);
  }
  async manage(text,state,focusId,signal,onProgress,selection){const b=await this.backend(selection);try{return await b.manage(text,state,focusId,signal,onProgress);}finally{await b.close();}}
  async coordinate(event,state,signal,selection){const b=await this.backend(selection);try{return await b.coordinate(event,state,signal);}finally{await b.close();}}
  async auxiliary(task,work,ctx){const b=await this.backend(task.modelSelection);try{return await b.auxiliary(task,work,ctx);}finally{await b.close();}}
  async steer(id,text){return this.workers.get(id)?.backend.steer(id,text);}
  async replaceSession(id){const cached=this.workers.get(id);if(cached){await cached.backend.close();this.workers.delete(id);}}
  async close(){for(const {backend} of this.workers.values())await backend.close();this.workers.clear();}
  async execute(task, ctx) {
    const candidate=await this.backend(task.modelSelection);const c=candidate.config;
    const key=JSON.stringify([modelIdentity(task.modelSelection),c.connection,c.provider,c.model,c.baseUrl,c.apiKey]);let cached=this.workers.get(task.id);
    if(cached&&cached.key!==key){await cached.backend.close();this.workers.delete(task.id);cached=null;}
    if(!cached){cached={key,backend:candidate};this.workers.set(task.id,cached);}
    const backend = cached.backend, clean = value => publicText(value, backend.config.apiKey);
    const result = await backend.execute(task, { ...ctx,
      activity: (id, values) => ctx.activity?.(id, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value]))),
      event: (kind, text, detail) => ctx.event(kind, clean(text), clean(detail)),
    });
    return result ? { ...result, summary: clean(result.summary) } : result;
  }
}
