import { t as tr, localeTag } from './i18n.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Select } from './Select.jsx';
import { ModelSelect } from './ModelSelect.jsx';
import { deepseekModels } from '../shared/deepseek.mjs';

const blank = { name: '', provider: 'openai', baseUrl: '', models: '', keyStorage: 'encrypted', apiKey: '' };
export function ProviderSettings({onDirtyChange,registerSave}) {
  const root = useRef(null);
  const [profiles, setProfiles] = useState([]), [editing, setEditing] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { window.desktop.getModelProfiles().then(setProfiles).catch(e => setError(e.message)); }, []);
  useEffect(()=>{onDirtyChange?.(Boolean(editing));},[editing]);
  useEffect(()=>{registerSave?.(save);},[editing,busy]);
  const set = (key, value) => setEditing(p => ({ ...p, [key]: value }));
  async function save() {
    if (busy) return false; setBusy(true);setError('');
    try { setProfiles(await window.desktop.saveModelProfile(editing));setEditing(null); requestAnimationFrame(()=>root.current?.scrollIntoView({block:'start'}));return true; }
    catch(e) {setError(e.message);return false;} finally {setBusy(false);}
  }
  async function remove(id) {
    setBusy(true);setError('');try {setProfiles(await window.desktop.removeModelProfile(id));}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <section ref={root} className="provider-settings" aria-label={tr("模型服务")}>
    <div className="row-between"><h4>{tr("模型服务")}</h4><button type="button" className="button secondary" disabled={busy} onClick={()=>{setEditing({...blank});setError('');}}><Plus size={14}/>{tr("添加厂商")}</button></div>
    <p className="settings-description">{tr("服务由所有项目共用。在任务输入框选择厂商和模型。")}</p>
    {profiles.map(p=><div className="provider-card" key={p.id}>
      <div><strong>{p.name}</strong><small>{p.models.join(' · ')}</small><small>{p.available?tr("可用"):tr("需要填写密钥")}{p.keyStorage==='session'?tr(" · 仅本次运行"):''}</small></div>
      {!p.legacy&&<><button type="button" className="icon-button" aria-label={tr("编辑 {0}", p.name)} disabled={busy} onClick={()=>{setEditing({...p,models:p.models.join('\n'),apiKey:''});setError('');}}><Pencil size={14}/></button><button type="button" className="icon-button" aria-label={tr("移除 {0}", p.name)} disabled={busy} onClick={()=>remove(p.id)}><Trash2 size={14}/></button></>}
    </div>)}
    {editing&&<div className="provider-editor" role="group" aria-label={tr("配置模型服务")} onKeyDown={e=>{if(e.key==='Enter'&&!e.defaultPrevented&&e.target.tagName==='INPUT'){e.preventDefault();void save();}}}>
      <label className="settings-field">{tr("服务名称")}<input aria-label={tr("服务名称")} value={editing.name} onChange={e=>set('name',e.target.value)} placeholder={tr("例如 工作账号")}/></label>
      <div className="settings-field">{tr("厂商")}<Select label={tr("厂商")} value={editing.provider} disabled={busy||Boolean(editing.id)} onChange={v=>setEditing(p=>({...p,provider:v,baseUrl:'',apiKey:'',name:p.name || (v==='deepseek'?'DeepSeek':''),models:v==='deepseek'?deepseekModels.join('\n'):''}))} options={[{value:'openai',label:'OpenAI'},{value:'anthropic',label:'Anthropic'},{value:'deepseek',label:'DeepSeek'},{value:'custom',label:tr("OpenAI 兼容服务")}]}/></div>
      <label className="settings-field">{tr("服务端点")}<input aria-label={tr("服务端点")} value={editing.baseUrl} disabled={Boolean(editing.id)} onChange={e=>set('baseUrl',e.target.value)} placeholder={editing.provider==='deepseek'?tr("留空使用 DeepSeek 官方地址"):editing.provider==='custom'?'https://example.com/v1':editing.provider==='anthropic'?tr("留空使用 Anthropic 官方地址"):tr("留空使用 OpenAI 官方地址")}/></label>
      <div className="settings-field">{tr("模型")}<ModelSelect label={tr("模型")} provider={editing.provider} multiple value={editing.models.split(/[\n,]/).map(v=>v.trim()).filter(Boolean)} onChange={values=>set('models',values.join('\n'))} disabled={busy}/></div>
      <label className="settings-field">{tr("服务 API Key")}<input aria-label={tr("服务 API Key")} type="password" autoComplete="off" value={editing.apiKey} onChange={e=>set('apiKey',e.target.value)} placeholder={editing.hasApiKey?tr("已保存；留空保留原密钥"):tr("填写此厂商的 API Key")}/></label>
      <label className="settings-check"><input type="checkbox" checked={editing.keyStorage==='session'} onChange={e=>set('keyStorage',e.target.checked?'session':'encrypted')}/>{tr("仅本次运行保存服务密钥")}</label>
      <p className="settings-description">{tr("默认使用系统加密存储，密钥保存在项目外，不随项目上传。")}</p>
      <div className="settings-auth-actions"><button type="button" className="button primary" disabled={busy} onClick={save}>{busy?tr("正在保存…"):tr("保存服务")}</button><button type="button" className="button secondary" disabled={busy} onClick={()=>setEditing(null)}>{tr("取消")}</button></div>
    </div>}
    {error&&<div className="error-banner" role="alert">{error}</div>}
  </section>;
}
