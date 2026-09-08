import { t as tr, localeTag } from './i18n.mjs';
import React, {useEffect,useState} from 'react';
import {Select} from './Select.jsx';
export function ClaudeConnection({value,onChange,onStatus,hideModel=false}) {
  const [status,setStatus]=useState(null),[models,setModels]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[code,setCode]=useState('');
  useEffect(()=>{let disposed=false,timer,loaded=false;const refresh=async()=>{try{const s=await window.desktop.claudeStatus();if(disposed)return;setStatus(s);onStatus(s.loggedIn);if(s.loggedIn&&!loaded){loaded=true;setModels(await window.desktop.claudeModels());window.desktop.refreshModels?.().catch(()=>{});}if(!s.loggedIn)loaded=false;}catch(e){if(!disposed)setError(e.message);}if(!disposed)timer=setTimeout(refresh,2000);};void refresh();return()=>{disposed=true;clearTimeout(timer);};},[]);
  async function action(name,arg){setBusy(true);setError('');try{const s=await window.desktop[name](arg);if(name==='claudeCode')setCode('');else{setStatus(s);onStatus(Boolean(s.loggedIn));}}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <div className="claude-connection chatgpt-connection">
    <p className="settings-description">{tr("通过 Claude 官方页面登录，使用你账号可用的订阅额度。")}</p>
    <p role="status">{status?.loggedIn?tr("已登录 · {0}{1}", status.email||tr("Claude 账号"), status.plan?' · '+status.plan:''):status?.pending?tr("等待浏览器完成 Claude 登录…"):tr("尚未登录 Claude")}</p>
    {(error||status?.error)&&<p className="error-banner" role="alert">{error||status.error}</p>}
    <div className="settings-auth-actions">{status?.loggedIn?<button type="button" className="button secondary" disabled={busy} onClick={()=>action('claudeLogout')}>{tr("退出 Claude 登录")}</button>:status?.pending?<button type="button" className="button secondary" disabled={busy} onClick={()=>action('claudeCancel')}>{tr("取消 Claude 登录")}</button>:<button type="button" className="button primary" disabled={busy} onClick={()=>action('claudeLogin')}>{tr("使用 Claude 登录")}</button>}</div>
    {status?.pending&&<details className="settings-advanced"><summary>{tr("浏览器显示了授权码")}</summary><label className="settings-field">{tr("授权码")}<input aria-label={tr("Claude 授权码")} type="password" autoComplete="off" value={code} onChange={e=>setCode(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void action('claudeCode',code);}}}/></label><button type="button" className="button secondary" disabled={busy||!code.trim()} onClick={()=>action('claudeCode',code)}>{tr("提交授权码")}</button></details>}
    <p className="key-storage-note">{tr("登录由官方 Claude 组件管理并在本机保留，数据位于项目外的应用目录。Boan 不读取或回显登录凭据。退出登录会停止使用此账号的任务。")}</p>
    {!hideModel && <div className="settings-field">{tr("Claude 模型")}<Select label={tr("Claude 模型")} value={value||''} onChange={onChange} options={[{value:'',label:tr("账号默认模型")},...(value&&!models.some(m=>m.id===value)?[{value,label:value}]:[]),...models.filter(m=>m.id!=='default').map(m=>({value:m.id,label:m.name}))]}/></div>}
  </div>;
}
