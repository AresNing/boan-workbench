import { t as tr, localeTag } from './i18n.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { Select } from './Select.jsx';
import { FolderOpen, Loader2, ShieldCheck, ExternalLink, SlidersHorizontal, Bot } from 'lucide-react';

import './settings-layout.css';
import { ClaudeConnection } from './ClaudeConnection.jsx';
import { Language } from './Language.jsx';
import { Appearance } from './Appearance.jsx';
import { ProviderSettings } from './ProviderSettings.jsx';

export function DesktopSettings({ adding = false, permissionsPanel, initialSection, onClose, registerCloseGuard }) {
  const original=useRef(null),providerSave=useRef(null),pendingClose=useRef(null);
  const [confirmClose,setConfirmClose]=useState(false),[providerDirty,setProviderDirty]=useState(false);
  const [claudeReady,setClaudeReady] = useState(false),[claudeModels,setClaudeModels]=useState([]);
  useEffect(()=>{if(claudeReady)window.desktop.claudeModels?.().then(setClaudeModels).catch(e=>setError(e.message));},[claudeReady]);
  const [tab, setTab] = useState(initialSection || 'project');
  const [config, setConfig] = useState(null), [apiKey, setApiKey] = useState(''), [clearApiKey, setClearApiKey] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false), pickerActive = useRef(false);
  const [account, setAccount] = useState(null), [models, setModels] = useState([]), [authBusy, setAuthBusy] = useState(false);
  useEffect(() => { window.desktop.getSettings().then(saved => { const next=adding ? { ...saved, mode: 'pi', projectPath: '' } : saved;original.current=next;setConfig(next); if (!adding && (saved.needsClaudeLogin || saved.needsChatGPTLogin || (saved.mode === 'pi' && saved.connection === 'api' && saved.keyStorage === 'session' && !saved.hasApiKey))) setTab(saved.connection==='api'?'model':'accounts'); }).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (config?.connection !== 'chatgpt' && tab !== 'accounts') return;
    let disposed = false, timer, loaded = false;
    const refresh = async () => {
      try {
        const status = await window.desktop.chatgptStatus();
        if (disposed) return;
        setAccount(status);
        if ((status.loggedIn || status.pending) && status.storage) setConfig(c => ({ ...c, chatgptStorage: status.storage }));
        if (status.loggedIn && !loaded) {
          loaded = true;
          window.desktop.refreshModels?.().catch(() => {});
          try { const list = await window.desktop.chatgptModels(); if (!disposed) setModels(list); }
          catch { if (!disposed) setError(tr("模型列表暂时无法获取，可使用账号默认模型。")); }
        }
        if (!status.loggedIn) { loaded = false; setModels([]); }
      } catch (e) { if (!disposed) setAccount({ loggedIn: false, error: e.message }); }
      if (!disposed) timer = setTimeout(refresh, 2000);
    };
    void refresh(); return () => { disposed = true; clearTimeout(timer); };
  }, [config?.connection,tab]);
  async function authenticate(action) {
    setAuthBusy(true); setError('');
    try { setAccount(await window.desktop[action](action === 'chatgptLogin' ? config.chatgptStorage : undefined)); } catch (e) { setError(e.message); } finally { setAuthBusy(false); }
  }
  const set = (key, value) => setConfig(c => ({ ...c, [key]: value }));
  async function choose() {
    if (pickerActive.current || busy) return;
    pickerActive.current = true; setChoosing(true);
    try { const selected = await window.desktop.chooseProject(); if (selected) set('projectPath', selected); }
    catch (e) { setError(e.message); }
    finally { pickerActive.current = false; setChoosing(false); }
  }
  const projectDirty=Boolean(config && original.current && (Object.keys(original.current).some(key=>!['notifications','chatgptStorage','language'].includes(key) && original.current[key]!==config[key]) || apiKey || clearApiKey));
  const dirty=projectDirty || providerDirty;
  const finishClose=()=>{const next=pendingClose.current;pendingClose.current=null;if(next)next();else onClose?.();};
  useEffect(()=>{registerCloseGuard?.(next=>{if(busy||authBusy)return;pendingClose.current=next || null;if(dirty)setConfirmClose(true);else finishClose();});return()=>registerCloseGuard?.(null);},[dirty,busy,authBusy,onClose]);
  async function save(event,closeAfter=false) {
    event?.preventDefault();
    if (busy || pickerActive.current) return;
    if(providerDirty && providerSave.current && !(await providerSave.current())){setTab('accounts');return;}
    if(closeAfter && !projectDirty){finishClose();return;}
    if (config.mode === 'pi' && !config.projectPath) { setTab('project'); setError(tr("请选择项目文件夹。")); return; }
    if (config.mode === 'pi' && config.connection === 'api' && (!config.model || (config.provider === 'custom' && !config.baseUrl))) { setTab('model'); setError(tr("请填写模型名称和服务地址。")); return; }
    setBusy(true); setError('');
    try { await window.desktop.saveSettings({ ...config, apiKey, clearApiKey }); setApiKey('');original.current=config;setConfirmClose(false);setBusy(false);if(closeAfter)finishClose(); }
    catch (e) { setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); setBusy(false); }
  }
  if (!config) return <p role="status">{error || tr("正在加载设置…")}</p>;
  const sections = [{ id: 'project', label: tr("项目"), icon: FolderOpen }, { id: 'model', label: tr("项目模型"), icon: Bot }, ...(!adding ? [{ id: 'permissions', label: tr("权限"), icon: ShieldCheck },{ id:'accounts',label:tr("账号与服务"),icon:Bot }, { id: 'general', label: tr("通用"), icon: SlidersHorizontal }] : [])];
  const chatgptConnection = (<div className="chatgpt-connection">
        <div className="key-storage-note"><ShieldCheck size={15}/><span>{tr("使用 ChatGPT 套餐中的 Codex 额度，无需 API 余额。")}</span></div>
        <p role="status">{account?.loggedIn ? tr("已登录 · {0} · {1}", account.email || tr("ChatGPT 账号"), account.plan || '') : account?.pending ? tr("等待浏览器完成登录，完成后这里会自动更新。") : tr("尚未登录 ChatGPT")}</p>
        {account?.loggedIn && account.effectiveStorage && <p role="status">{account.fallback ? tr("已自动降级：登录凭据已保存到本机文件，重启后可继续使用。") : { keyring: tr("登录凭据已保存到系统钥匙串。"), file: tr("登录凭据已保存到本机文件，重启后可继续使用。"), session: tr("登录凭据仅保留在本次运行内存中。") }[account.effectiveStorage]}</p>}
        {account?.error && <div className="error-banner" role="alert">{account.error}</div>}
        <p className="key-storage-note">{tr("ChatGPT 登录由所有项目共用；退出登录会停止各项目使用此账号的执行。")}</p>
        <div className="settings-auth-actions">{account?.loggedIn
          ? <button type="button" className="button secondary" disabled={authBusy || busy} onClick={() => authenticate('chatgptLogout')}>{tr("退出 ChatGPT 登录")}</button>
          : account?.pending
            ? <button type="button" className="button secondary" disabled={authBusy} onClick={() => authenticate('chatgptCancel')}>{tr("取消登录")}</button>
            : <button type="button" className="button primary" disabled={authBusy} onClick={() => authenticate('chatgptLogin')}>{authBusy ? tr("正在打开登录…") : tr("使用 ChatGPT 登录")}<ExternalLink size={14}/></button>}</div>
        <details className="settings-advanced" open={!account?.loggedIn}><summary>{tr("登录凭据与存储")}</summary>
        <div className="settings-field">{tr("登录凭据保存方式")}<Select label={tr("登录凭据保存方式")} value={config.chatgptStorage} disabled={authBusy || busy || account?.loggedIn || account?.pending} onChange={value => set('chatgptStorage', value)} options={[
          { value: 'keyring', label: tr("系统钥匙串（失败后自动保存到本机文件）") },
          { value: 'file', label: tr("保存到本机文件（重启后保持登录）") },
          { value: 'session', label: tr("仅本次运行登录（退出后需重新登录）") },
        ]}/></div>
        <div className="key-storage-note">{config.chatgptStorage === 'session' ? tr("登录凭据仅由本次运行的 Codex 进程保留在内存，不写入钥匙串或磁盘。关闭窗口不会退出；⌘Q 退出后清除。") : config.chatgptStorage === 'file' ? tr("保存在项目外的应用数据目录，仅当前系统用户可读写。文件未额外加密，不随项目提交或应用打包上传；退出登录时清除。") : tr("优先使用系统钥匙串；保存失败后自动存入项目外的应用数据目录，无需再次授权。本机文件未额外加密，仅当前系统用户可读写，不随项目上传。")}</div>
        </details>
</div>);
  return <form className="desktop-settings settings-layout" onSubmit={save}>
    <nav className="settings-nav" aria-label={adding ? tr("添加项目步骤") : tr("设置分类")}>
      {sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} disabled={busy} onClick={() => setTab(id)}><Icon size={16}/>{label}</button>)}
    </nav>
    <div className="settings-main">
    <div className="settings-section">
    <h3>{sections.find(section => section.id === tab)?.label}</h3><p className="settings-scope">{['accounts','general'].includes(tab) ? tr("应用设置 · 所有项目共用") : tr("当前项目设置")}</p>
    {tab === 'project' && <>
    {!adding &&
    <div className="mode-options" role="group" aria-label={tr("工作方式")}>
      <button type="button" className={config.mode === 'demo' ? 'mode-option active' : 'mode-option'} onClick={() => set('mode', 'demo')}><strong>{tr("本地演示")}</strong><span>{tr("示例项目，无需登录")}</span></button>
      <button type="button" className={config.mode === 'pi' ? 'mode-option active' : 'mode-option'} onClick={() => set('mode', 'pi')}><strong>{tr("真实项目")}</strong><span>{tr("使用本机项目文件夹")}</span></button>
    </div>}
    {config.mode === 'pi' && <>
      <label className="settings-field">{tr("项目文件夹")}<div className="folder-picker"><input aria-label={tr("项目文件夹")} value={config.projectPath} readOnly placeholder={tr("选择本机项目目录")}/><button type="button" className="button secondary" disabled={choosing || busy} onClick={choose}><FolderOpen size={15}/>{tr("选择文件夹")}</button></div></label>
      <p className="settings-description">{tr("任务在此文件夹中执行，切换项目不会暂停其他项目。")}</p>
      <details className="settings-advanced"><summary>{tr("高级设置")}</summary><label className="settings-field">{tr("默认验证命令 ")}<span className="field-optional">{tr("可选")}</span><input aria-label={tr("默认验证命令")} value={config.verifyCommand} onChange={e => set('verifyCommand', e.target.value)} placeholder={tr("例如 npm test；留空自动选择")}/></label></details>
      {!adding && <button type="button" className="text-button" onClick={() => window.desktop.revealProject()}>{tr("在 Finder 中打开当前项目 ")}<ExternalLink size={13}/></button>}
    </>}
    {config.mode === 'demo' && <p className="settings-description">{tr("示例项目，无需登录。选择真实项目后可使用本机文件夹。")}</p>}
    </>}
    {tab === 'model' && (config.mode === 'pi' ? <>
      <h4 className="settings-default-label">{tr("项目默认连接")}</h4>
      <div className="mode-options" role="group" aria-label={tr("模型连接方式")}>
        <button type="button" className={config.connection === 'chatgpt' ? 'mode-option active' : 'mode-option'} onClick={() => set('connection', 'chatgpt')}><strong>{tr("ChatGPT 登录")}</strong><span>{tr("使用 ChatGPT 订阅中的 Codex")}</span></button>
        <button type="button" className={config.connection === 'claude' ? 'mode-option active' : 'mode-option'} onClick={() => set('connection', 'claude')}><strong>{tr("Claude 登录")}</strong><span>{tr("使用 Claude 账号订阅")}</span></button>
        <button type="button" className={config.connection === 'api' ? 'mode-option active' : 'mode-option'} onClick={() => set('connection', 'api')}><strong>API Key</strong><span>{tr("按模型服务的 API 用量计费")}</span></button>
      </div>
      {config.connection === 'claude' ? <>{adding ? <ClaudeConnection value={config.claudeModel} onChange={v=>set('claudeModel',v)} onStatus={setClaudeReady}/> : <><button type="button" className="text-button" onClick={()=>setTab('accounts')}>{tr("管理 Claude 账号")}</button><div className="settings-field">{tr("Claude 模型")}<Select label={tr("Claude 模型")} value={config.claudeModel||''} onChange={v=>set('claudeModel',v)} options={[{value:'',label:tr("账号默认模型")},...(config.claudeModel&&!claudeModels.some(m=>m.id===config.claudeModel)?[{value:config.claudeModel,label:config.claudeModel}]:[]),...claudeModels.filter(m=>m.id!=='default').map(m=>({value:m.id,label:m.name}))]}/></div></>}</> : config.connection === 'chatgpt' ? <>{adding ? chatgptConnection : <button type="button" className="text-button" onClick={()=>setTab('accounts')}>{tr("管理 ChatGPT 账号")}</button>}        <div className="settings-field">{tr("Codex 模型")}<Select label={tr("Codex 模型")} value={config.chatgptModel || ''} onChange={value => set('chatgptModel', value)} options={[{ value: '', label: tr("自动选择账号默认模型") }, ...(config.chatgptModel && !models.some(m => m.id === config.chatgptModel) ? [{ value: config.chatgptModel, label: config.chatgptModel }] : []), ...models.map(m => ({ value: m.id, label: m.name + (m.isDefault ? tr("（默认）") : '') }))]}/></div></> : <>
      <div className="settings-grid"><div className="settings-field">{tr("模型供应商")}<Select label={tr("模型供应商")} value={config.provider} onChange={value => set('provider', value)} options={[{ value: 'anthropic', label: 'Anthropic' }, { value: 'openai', label: 'OpenAI' }, { value: 'google', label: 'Google' }, { value: 'custom', label: tr("自定义兼容服务") }]}/></div>
      <label className="settings-field">{tr("模型名称")}<input aria-label={tr("模型名称")} value={config.model} onChange={e => set('model', e.target.value)} required placeholder={tr("填写服务支持的模型 ID")}/></label></div>
      <label className="settings-field">{tr("服务地址 ")}<span className="field-optional">{config.provider === 'custom' ? tr("必填") : tr("可选，留空使用供应商默认地址")}</span><input aria-label={tr("服务地址")} value={config.baseUrl} onChange={e => set('baseUrl', e.target.value)} placeholder="https://example.com/v1" required={config.provider === 'custom'}/></label>
      <label className="settings-field">API Key<input aria-label="API Key" type="password" autoComplete="off" value={apiKey} onChange={e => { setApiKey(e.target.value); setClearApiKey(false); }} placeholder={config.hasApiKey ? tr("已提供；留空保留本次可用密钥") : tr("填写模型服务的密钥")}/></label>
      <label className="settings-check"><input type="checkbox" checked={config.keyStorage === 'session'} onChange={e => set('keyStorage', e.target.checked ? 'session' : 'encrypted')}/>{tr("仅本次运行使用密钥（退出后需重新填写）")}</label>
      {config.hasApiKey && <label className="settings-check"><input type="checkbox" checked={clearApiKey} onChange={e => setClearApiKey(e.target.checked)}/>{tr("清除当前供应商已保存的密钥")}</label>}
      <div className="key-storage-note"><ShieldCheck size={15}/><span>{config.keyStorage === 'session' ? tr("密钥只保留在运行内存，不写入配置文件。保存后会移除当前服务原有的密文；关闭窗口仍可继续，⌘Q 退出后需重新填写。") : tr("通过 macOS 钥匙串保护的加密存储保存，界面不会回显已保存的密钥。")}</span></div>
      </>}
      <p className="settings-description">{tr("应用模型配置会暂停当前项目任务，其他项目不受影响。")}</p>
    </> : <p className="settings-description">{tr("演示项目无需连接模型。请先在「项目」中选择真实项目。")}</p>)}
    <div hidden={tab !== 'accounts'} className="account-services"><h4>ChatGPT</h4>{chatgptConnection}<h4>Claude</h4>{window.desktop.claudeStatus && <ClaudeConnection hideModel value={config.claudeModel} onChange={v=>set('claudeModel',v)} onStatus={setClaudeReady}/>}<p className="settings-description">{tr("账号登录、退出和服务保存立即生效。项目默认模型在「项目模型」中应用。")}</p>{window.desktop.getModelProfiles && <ProviderSettings onDirtyChange={setProviderDirty} registerSave={fn=>{providerSave.current=fn;}}/>}</div>
    {tab === 'permissions' && (permissionsPanel || <p className="settings-description">{tr("演示项目仅操作示例目录，无需配置权限。")}</p>)}
    {tab === 'general' && <>
    <Appearance/><Language/><label className="settings-check"><input type="checkbox" checked={config.notifications} onChange={async e => {const notifications=e.target.checked;try{await window.desktop.savePreferences({notifications});set('notifications',notifications);}catch(err){setError(err.message);}}}/>{tr("任务需要处理时通知我")}</label>
    <p className="desktop-lifecycle-note">{tr("关闭窗口后继续执行；⌘Q 退出并保存进度。")}</p>
    <div className="settings-links"><button type="button" className="text-button" onClick={() => window.desktop.revealData()}>{tr("打开应用数据目录 ")}<ExternalLink size={13}/></button></div>
    <div className="settings-about"><strong>Boan Workbench</strong><span>macOS · {config.version}</span></div>
    </>}
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {confirmClose && <section className="settings-unsaved" role="alert" aria-label={tr("未保存修改")}><strong>{tr("有尚未保存的修改")}</strong><p>{tr("保存后关闭，或放弃本次修改。")}</p><div><button type="button" className="button primary" disabled={busy} onClick={e=>save(e,true)}>{tr("保存后关闭")}</button><button type="button" className="button secondary" disabled={busy} onClick={finishClose}>{tr("放弃修改")}</button><button type="button" className="button secondary" onClick={()=>{pendingClose.current=null;setConfirmClose(false);}}>{tr("继续编辑")}</button></div></section>}
    <div className="settings-save-row"><span>{['permissions','accounts','general'].includes(tab) ? tr("更改立即生效") : adding ? tr("添加后即可交代任务") : tr("配置将在应用后生效")}</span>{!['permissions','accounts','general'].includes(tab) && (adding && tab === 'project' ? <button type="button" className="button primary" disabled={!config.projectPath || choosing || busy} onClick={() => setTab('model')}>{tr("下一步")}</button> : <button className="button primary" disabled={busy || authBusy || choosing || (config.mode === 'pi' && ((config.connection === 'chatgpt' && !account?.loggedIn) || (config.connection === 'claude' && !claudeReady)))}>{busy && <Loader2 size={14} className="spin"/>}{busy ? tr("正在保存…") : tr("保存并应用")}</button>)}</div>
    </div>
  </form>;
}
