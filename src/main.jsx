import { t as tr, localeTag, systemText, setLanguage, subscribeLanguage, languagePreference, languageSnapshot } from './i18n.mjs';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, Circle, Clock3, Code2, FileCode2, Folder, LayoutDashboard, ListFilter, Loader2, MessageSquare, MoreHorizontal, PanelLeft, PanelRightClose, Pause, Play, Plus, Search, Settings2, ShieldCheck, SquareKanban, Terminal, X } from 'lucide-react';
import './styles.css';
import './desktop.css';
import { ExecutionTimeline } from './ExecutionTimeline.jsx';
import { Select } from './Select.jsx';
import { ProjectsOverview } from './ProjectsOverview.jsx';
import { ProjectNavigation, ProjectSwitcher } from './ProjectNavigation.jsx';
import { WorkHistory } from './WorkHistory.jsx';
import { PreparationProgress } from './PreparationProgress.jsx';
import { Permissions } from './Permissions.jsx';
import { ModelPicker } from './ModelPicker.jsx';
import { ComposerPermissions } from './ComposerPermissions.jsx';
import { DesktopSettings } from './DesktopSettings.jsx';
import './workbench-shell.css';
import './design-tokens.css';
import { Language } from './Language.jsx';
import { Appearance } from './Appearance.jsx';
import { Delivery } from './Delivery.jsx';
import { recovery } from './task-presentation.mjs';
import './interaction.css';
import { ResizeHandle } from './ResizeHandle.jsx';
import { TaskProgress } from './TaskProgress.jsx';
import { Attachments, useAttachments } from './Attachments.jsx';

const labels = { queued: '已安排', running: '进行中', verifying: '验证中', stopping: '正在暂停', blocked: '待决定', review: '待验收', paused: '已暂停', failed: '需处理', done: '已完成' };
const working = ['queued', 'running', 'verifying', 'stopping'];
const time = value => new Date(value).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
async function requestApi(url, body, requestProjectId) {
  const response = await fetch(url, { headers: { ...(requestProjectId ? { 'x-workbench-project': requestProjectId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || tr("请求失败")); return data;
}
function IconButton({ label, children, ...props }) { return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>; }
function Status({ status }) { return <span className={`status ${status}`}><i />{tr(labels[status])}</span>; }
class WorkbenchBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="loading-screen"><h1>{tr("页面暂时无法显示")}</h1><p>{tr("任务记录仍保存在本机，请重新加载页面。")}</p><button onClick={() => location.reload()}>{tr("重新加载页面")}</button></div> : this.props.children;
  }
}
function WorkbenchRoot() {
  useSyncExternalStore(subscribeLanguage,languageSnapshot);
  useEffect(()=>{if(window.desktop)window.desktop.getSettings().then(c=>setLanguage(c.language || 'zh')).catch(()=>{});else setLanguage(languagePreference());},[]);
  const [projects, setProjects] = useState(null), [bundle, setBundle] = useState(null);
  const [pending, setPending] = useState(null), [error, setError] = useState('');
  const [destination, setDestination] = useState(null);
  const shown = useRef(null), shownRevision = useRef(0), latestRevision = useRef(0), failed = useRef(null), loading = useRef(null), sequence = useRef(0);
  function load(id, revision = latestRevision.current) {
    if (shown.current === id && shownRevision.current === revision) return Promise.resolve();
    if (loading.current?.id === id && loading.current.revision === revision) return loading.current.promise;
    const generation = ++sequence.current; setPending(id); setError('');
    const promise = requestApi('/api/state', undefined, id).then(state => {
      if (generation !== sequence.current) return;
      shown.current = id; shownRevision.current = revision; failed.current = null; setBundle({id: `${id}:${revision}`, state});
    }).catch(e => { if (generation === sequence.current) { failed.current = `${id}:${revision}`; setError(e.message); } }).finally(() => {
      if (generation === sequence.current) { loading.current = null; setPending(null); }
    });
    loading.current = {id, revision, promise}; return promise;
  }
  useEffect(() => {
    if (!window.desktop?.getProjects) return;
    function receive(snapshot) {
      setProjects(snapshot);
      const revision = snapshot.uiRevision || 0; latestRevision.current = revision;
      if (!shown.current) { shown.current = snapshot.activeId; shownRevision.current = revision; }
      else if (snapshot.activeId && (snapshot.activeId !== shown.current || revision !== shownRevision.current) && failed.current !== `${snapshot.activeId}:${revision}`) void load(snapshot.activeId, revision);
    }
    const unsubscribe = window.desktop.onProjects(receive);
    window.desktop.getProjects().then(receive).catch(e => setError(e.message));
    return unsubscribe;
  }, []);
  async function open(project, taskId) {
    if (pending) return;
    setPending(project.id); setError('');
    try { await window.desktop.selectProject(project.id); await load(project.id); setDestination(taskId ? { projectId: project.id, taskId, nonce: Date.now() } : null); }
    catch(e) { setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setPending(null); }
  }
  return <App key={bundle?.id || 'initial'} initialState={bundle?.state} projects={projects} onOpenProject={open} navigationPending={pending} navigationError={error} destination={destination}/>;
}
function App({initialState, projects, onOpenProject, navigationPending, navigationError, destination}) {
  const projectIdRef = useRef(initialState?.project?.id);
  const api = (url, body) => requestApi(url, body, projectIdRef.current);
  const [state, setState] = useState(initialState || null), [connected, setConnected] = useState(false), [error, setError] = useState('');
  const [view, setView] = useState('workbench'), [focusId, setFocusId] = useState(null), [draft, setDraft] = useState('');
  const [draftModels, setDraftModels] = useState({});
  const settingsCloseGuard=useRef(null);
  const closeModal=()=>{if(modal?.type==='project' && settingsCloseGuard.current)settingsCloseGuard.current();else setModal(null);};
  const [busy, setBusy] = useState(false), [receipt, setReceipt] = useState(''), [modal, setModal] = useState(null);
  useEffect(() => { if (!receipt) return; const timer = setTimeout(() => setReceipt(''), 7000); return () => clearTimeout(timer); }, [receipt]);
  const [query, setQuery] = useState(''), [inputScope, setInputScope] = useState('project');
  const [inputTaskId, setInputTaskId] = useState(null), [taskFilter, setTaskFilter] = useState(null);
  const [switcher, setSwitcher] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => { try { return localStorage.getItem('workbench:sidebar-hidden') === 'true'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('workbench:sidebar-hidden', String(sidebarHidden)); } catch {} }, [sidebarHidden]);
  useEffect(() => {
    if (!window.desktop) return;
    const shortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !modal) {
        event.preventDefault(); setSwitcher(value => !value);
      }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, [modal]);
  const openProject = project => {
    if (project.id === state?.project?.id && projects?.activeId === project.id && project.status === 'ready') { setView('workbench'); setSwitcher(false); return; }
    return onOpenProject(project);
  };
  const openProjectTask = (project, taskId) => {
    if (project.id === state?.project?.id && projects?.activeId === project.id) { setFocusId(taskId); setView('workbench'); setTaskFilter(null); }
    else return onOpenProject(project, taskId);
  };
  useEffect(() => { if (destination && state && destination.projectId === state.project?.id && state.tasks.some(t => t.id === destination.taskId)) { setFocusId(destination.taskId); setView('workbench'); setTaskFilter(null); } }, [destination, state?.project?.id]);
  const [showContext, setShowContext] = useState(false);
  const [contextTab,setContextTab]=useState('overview'),[selectedFile,setSelectedFile]=useState(null),[evidenceOpen,setEvidenceOpen]=useState(false),[boardMode,setBoardMode]=useState('list');
  const openDetails=(tab='overview',file=null,evidence=false)=>{setContextTab(tab);setSelectedFile(file);setEvidenceOpen(evidence);setShowContext(true);};
  useEffect(()=>{if(!showContext)return;const close=e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector(':popover-open')&&!dialogRef.current?.open){e.preventDefault();setShowContext(false);}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[showContext]);
  const [submission, setSubmission] = useState(null);
  useEffect(() => { if (submission?.status !== 'complete') return; const timer = setTimeout(() => setSubmission(null), 5000); return () => clearTimeout(timer); }, [submission?.status]);

  const currentPreparation=state?.preparation?.requestId===submission?.requestId&&Date.parse(state?.preparation?.updatedAt)>=Date.parse(submission?.startedAt);
  const preparation=submission?.status==='complete'?submission:(state?.managerBusy||currentPreparation)?state?.preparation:submission;
  const submitting = busy || state?.managerBusy;
  const pendingSubmission=useRef(null);
  const [sidebarWidth, setSidebarWidth] = useState(244), [contextWidth, setContextWidth] = useState(380);
  const layoutLoaded = useRef(false), restoredFocus = useRef(null), scrollRef = useRef(null), savedScroll = useRef(0);
  useEffect(() => {
    if (!state || layoutLoaded.current) return;
    try { const saved = JSON.parse(localStorage.getItem(`layout:${state.project.path}`) || '{}');
      setSidebarWidth(Math.max(200,Math.min(340,saved.sidebarWidth || 244)));setContextWidth(Math.max(310,Math.min(640,saved.contextWidth || 380)));
      setShowContext(Boolean(saved.showContext));if(['overview','results','execution'].includes(saved.contextTab))setContextTab(saved.contextTab);if(saved.boardMode==='board')setBoardMode('board'); if (['workbench','board'].includes(saved.view)) setView(saved.view);
      restoredFocus.current=state.tasks.find(t=>t.id===saved.focusId)?.id || null;
      if (restoredFocus.current) setFocusId(restoredFocus.current);savedScroll.current=saved.scroll || 0;
      requestAnimationFrame(()=>{if(scrollRef.current)scrollRef.current.scrollTop=savedScroll.current;});
    } catch {} layoutLoaded.current=true;
  }, [state?.project?.path]);
  useEffect(()=>{if(!state || !layoutLoaded.current)return;const save=()=>{try{localStorage.setItem(`layout:${state.project.path}`,JSON.stringify({sidebarWidth,contextWidth,showContext,contextTab,boardMode,view:view==='projects'?'workbench':view,focusId,scroll:savedScroll.current}));}catch{}};save();window.addEventListener('pagehide',save);return()=>{save();window.removeEventListener('pagehide',save);};},[state?.project?.path,sidebarWidth,contextWidth,showContext,contextTab,boardMode,view,focusId]);
  const inputRef = useRef(null), dialogRef = useRef(null), draftLoaded = useRef(false);
  useEffect(() => { window.desktop?.getSettings().then(config => {
    if (config.needsChatGPTLogin || config.needsClaudeLogin || (config.mode === 'pi' && config.connection === 'api' && config.keyStorage === 'session' && !config.hasApiKey)) setModal({ type: 'project' });
  }).catch(() => {}); }, []);
  useEffect(() => window.desktop?.onCommand(command => {
    const perform=()=>{
      if (command === 'open-project') { setSwitcher(false); setModal({ type: 'project', adding: true }); }
      if (command === 'settings') { setSwitcher(false); setModal({ type: 'project' }); }
      if (command === 'new-task') { setModal(null); setSwitcher(false); setView('workbench'); setInputScope('project'); setInputTaskId(null); setTimeout(() => inputRef.current?.focus(), 0); }
    };
    if (modal?.type === 'project' && settingsCloseGuard.current) {
      if(command !== 'settings')settingsCloseGuard.current(()=>{setModal(null);setTimeout(perform,0);});
    } else perform();
  }), [modal]);
  useEffect(() => {
    let stream, disposed = false;
    async function connect() {
      try { const initial = initialState || await api('/api/state'); if (!disposed) { projectIdRef.current = initial.project?.id; setState(initial); } }
      catch (e) { if (!disposed) setError(e.message); }
      if (disposed) return;
      stream = new EventSource(`/api/events${projectIdRef.current ? `?projectId=${encodeURIComponent(projectIdRef.current)}` : ''}`);
      stream.onmessage = e => { try { const data = JSON.parse(e.data); projectIdRef.current = data.project.id; setState(data); setConnected(true); } catch { setError(tr("状态数据格式异常")); } };
      stream.onerror = () => setConnected(false);
    }
    void connect();
    return () => { disposed = true; stream?.close(); };
  }, []);
  useEffect(() => { if (state && !draftLoaded.current) { try { setDraftModels(JSON.parse(localStorage.getItem(`draft-models:${state.project.path}`) || '{}')); setDraft(localStorage.getItem(`draft:${state.project.path}`) || ''); const target = localStorage.getItem(`draft-target:${state.project.path}`); if (state.tasks.some(t=>t.id===target)) { setInputTaskId(target); setInputScope('task'); } } catch { setError(tr("暂时无法读取本机草稿，仍可继续工作。")); } draftLoaded.current = true; } }, [state]);
  useEffect(() => { if (state && draftLoaded.current) { try { localStorage.setItem(`draft:${state.project.path}`, draft); } catch { setError(tr("草稿暂时无法保存，请保留输入内容后重试。")); } } }, [draft]);
  useEffect(() => { if (state && draftLoaded.current) { try { localStorage.setItem(`draft-target:${state.project.path}`, inputScope === 'task' ? inputTaskId || '' : ''); } catch {} } }, [inputScope, inputTaskId]);
  useEffect(() => {
    const completed = event => {
      if (event.detail.path === state?.project?.path && event.detail.target === (inputScope === 'task' ? inputTaskId : null)) setDraft(value => value === event.detail.text ? '' : value);
    };
    window.addEventListener('workbench:submitted', completed);
    return () => window.removeEventListener('workbench:submitted', completed);
  }, [state?.project?.path, inputScope, inputTaskId]);
  useEffect(() => { if (modal && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [modal, Boolean(state)]);
  const tasks = state?.tasks || [], attention = (state?.attentionIds || []).map(id => tasks.find(t => t.id === id)).filter(Boolean);
  // Once focused, never replace a card because a background event arrived.
  useEffect(() => {
    if (!focusId && tasks.length) {
      const next = (destination && destination.projectId === state.project.id ? tasks.find(t => t.id === destination.taskId) : null) || tasks.find(t=>t.id===restoredFocus.current) || attention[0] || tasks.find(t => working.includes(t.status)) || tasks.find(t => t.status === 'paused');
      if (next) setFocusId(next.id);
    }
  }, [state, focusId]);
  const focus = tasks.find(t => t.id === focusId);
  const inputTask = tasks.find(t => t.id === inputTaskId);
  const scopeTask = inputTask || focus;
  const modelTarget = inputScope === 'task' ? inputTaskId : 'project';
  const attachments = useAttachments(`attachments:${state?.project?.path || ''}:${modelTarget}`,api,setError);
  const selectedModel = draftModels[modelTarget] || (inputScope === 'task' ? inputTask?.modelSelection : null) || state?.defaultModel;
  function chooseModel(value) { const next = { ...draftModels, [modelTarget]: value }; setDraftModels(next); try { localStorage.setItem(`draft-models:${state.project.path}`, JSON.stringify(next)); } catch { setError(tr("模型选择暂时无法保存到本机。")); } }
  const waitingOthers = attention.filter(t => t.id !== focusId);
  const choose = (id, open = true) => { savedScroll.current=0; if(scrollRef.current)scrollRef.current.scrollTop=0; setFocusId(id); setTaskFilter(null); if (open) setView('workbench'); };
  const newTask = () => { setView('workbench'); setInputScope('project'); setInputTaskId(null); setTimeout(()=>inputRef.current?.focus(),0); };
  const nextFocus = updated => {
    const ids = updated.attentionIds || [];
    const next = ids.find(id => id !== focusId) || updated.tasks.find(t => t.id !== focusId && working.includes(t.status))?.id;
    setFocusId(next || null);
  };
  async function action(type, extra = {}, id = focusId) {
    if (busy) return; setBusy(true); setError('');
    try {
      const updated = await api(`/api/tasks/${id}/actions`, { type, operationId:crypto.randomUUID(), expectedVersion:tasks.find(t=>t.id===id)?.stateVersion, ...extra }); setState(updated);
      setReceipt({ accept: tr("已完成。"), defer: tr("已暂时收起，30 分钟后重新提醒；仍可从看板查看。"), decision: tr("决定已记录，工作会继续推进。"), pause: tr("已请求暂停，正在等待执行停止。"), resume: tr("已安排恢复，将重新检查现有成果。"), priority: tr("优先级已更新。") }[type] || tr("已更新。"));
      if (['accept', 'defer', 'decision'].includes(type)) nextFocus(updated);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function changePermissions(change) {
    if (busy) return;
    setBusy(true); setError('');
    try { setState(await api('/api/permissions', change)); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function send(event) {
    event?.preventDefault(); if (!draft.trim() || submitting || !connected || attachments.uploading) return;
    const requestKey=`request-draft:${state.project.path}`, signature=JSON.stringify({text:draft,focusId:inputScope==='task'?inputTaskId:null,modelSelection:selectedModel,attachments:attachments.items});
    let saved=pendingSubmission.current;try{saved=JSON.parse(localStorage.getItem(requestKey))||saved;}catch{}
    const requestId=saved?.signature===signature?saved.requestId:crypto.randomUUID(),startedAt=new Date().toISOString();
    pendingSubmission.current={signature,requestId};try{localStorage.setItem(requestKey,JSON.stringify(pendingSubmission.current));}catch{}
    setSubmission({ requestId, startedAt, percent: 0, title: tr("发送要求"), detail: tr("正在将你的要求发送到本机工作台。"), status: 'running' });
    setBusy(true); setError('');
    try {
      const result = await api('/api/messages', { text: draft, attachments:attachments.items, focusId: inputScope === 'task' ? inputTaskId : null, requestId, ...(selectedModel ? { modelSelection: selectedModel } : {}) });
      // Completion may arrive after the user has entered another project's workbench.
      try { const key = `draft:${state.project.path}`; if (localStorage.getItem(key) === draft && (localStorage.getItem(`draft-target:${state.project.path}`) || '') === (inputScope === 'task' ? inputTaskId || '' : '')) { localStorage.removeItem(key); localStorage.removeItem(`draft-target:${state.project.path}`); } }
      catch { setError(tr("本次要求已提交，但本机草稿清理失败。")); }
      window.dispatchEvent(new CustomEvent('workbench:submitted', {detail:{path:state.project.path,text:draft,target:inputScope === 'task' ? inputTaskId : null}}));
      pendingSubmission.current=null;try{if(JSON.parse(localStorage.getItem(requestKey))?.requestId===requestId)localStorage.removeItem(requestKey);}catch{}
      setReceipt(result.reply); setDraft(''); attachments.clear();
      setSubmission({ requestId, startedAt, updatedAt: new Date().toISOString(), percent: 100, status: 'complete', title: tr("准备完成"), detail: tr("本次安排与回复已保存，可在工作台查看。") });
    } catch (e) { setError(e.message); setSubmission({ requestId, startedAt, updatedAt: new Date().toISOString(), percent: 0, status: 'failed', title: tr("准备未完成"), detail: tr("请查看错误提示，输入内容已保留，可再次发送。") }); } finally { setBusy(false); }
  }
  function artifact(file) { openDetails('results',file); }
  if (!state) return <div className="loading-screen"><img className="brand-symbol" src="./boan-mark.svg" alt="Boan"/><p>{error || tr("正在连接你的工作台…")}</p>{error && <button onClick={() => location.reload()}>{tr("重新连接")}</button>}</div>;
  const pendingTasks=tasks.filter(t=>['blocked','failed','review','paused'].includes(t.status));
  const activeCount = tasks.filter(t => working.includes(t.status)).length;
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const lastEvidence = focus?.evidence.at(-1);
  const modify = () => { if(innerWidth<1100)setShowContext(false); setInputScope('task'); setInputTaskId(focus.id); inputRef.current?.focus(); };
  const filteredTasks = taskFilter === 'attention' ? pendingTasks : tasks.filter(t => taskFilter === 'active' ? working.includes(t.status) : t.status === 'done');
  return <div className={`app ${window.desktop ? 'desktop-app' : ''} ${showContext ? 'context-open' : ''} ${sidebarHidden ? 'sidebar-hidden' : ''}`}>
    <aside className="sidebar" style={{'--sidebar-width':`${sidebarWidth}px`}} id="project-sidebar" aria-label={tr("项目工作空间")}>
      <div className="brand"><img className="brand-symbol" src="./boan-mark.svg" alt="Boan" title="Boan"/></div>
      {window.desktop ? <>
        <nav className="workspace-shortcuts" aria-label={tr("工作空间")}><button className="nav-item" onClick={()=>setSwitcher(true)}><Search size={17}/>{tr("快速切换")}<small>⌘ K</small></button><button className={`nav-item ${view==='projects'?'selected':''}`} onClick={()=>setView('projects')}><LayoutDashboard size={17}/>{tr("所有项目")}{projects?.projects.some(p=>p.attention || p.status==='error') && <b>{projects.projects.reduce((n,p)=>n+p.attention+(p.status==='error'?1:0),0)}</b>}</button></nav>
        <ProjectNavigation snapshot={projects} currentId={state.project.id} view={view} taskCount={tasks.length} onOpen={openProject} onView={setView} onHistory={()=>setModal({type:'history'})} onAdd={()=>setModal({type:'project',adding:true})} onSearch={()=>setSwitcher(true)} pending={navigationPending}/>
      </> : <>
      <button className="project-switch" onClick={() => window.desktop ? setView('projects') : setModal({ type: 'project' })}><span className="project-avatar">A</span><span>{state.project.name.split(' · ')[0]}<small>{tr("项目工作区")}</small></span><ChevronDown size={15}/></button>
      <div className="nav-label">{tr("工作空间")}</div>
      <nav>

        <button className={view === 'workbench' ? 'nav-item selected' : 'nav-item'} onClick={() => setView('workbench')}><LayoutDashboard size={18}/>{tr("工作台")}{attention.length > 0 && <b>{attention.length}</b>}</button>
        <button className={view === 'board' ? 'nav-item selected' : 'nav-item'} onClick={() => setView('board')}><SquareKanban size={18}/>{tr("项目看板")}<span className="nav-count">{tasks.length}</span></button>
        <button className="nav-item" onClick={() => setModal({ type: 'history' })}><Clock3 size={18}/>{tr("工作记录")}</button>
      </nav>
      <div className="sidebar-separator"/>
      <div className="nav-label row-between">{tr("当前项目 ")}<MoreHorizontal size={15}/></div>
      <div className="project-tree"><Folder size={16}/><span>{state.project.mode === 'demo' ? 'product-workspace' : state.project.name}</span></div>
      <div className="project-tree-child"><i/>{activeCount ? tr("{0} 项工作在推进", activeCount) : tr("没有正在执行的工作")}</div>
      </>}
      <div className="sidebar-bottom">
        <Appearance/>
        <button className="nav-item" onClick={() => setModal({ type: 'project' })}><Settings2 size={17}/>{tr("设置")}</button>
      </div>
      <ResizeHandle label={tr("调整项目导航宽度")} value={sidebarWidth} min={200} max={340} onChange={setSidebarWidth}/>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><IconButton label={sidebarHidden ? tr("展开项目导航") : tr("收起项目导航")} aria-expanded={!sidebarHidden} aria-controls="project-sidebar" onClick={()=>setSidebarHidden(value=>!value)}><PanelLeft size={17}/></IconButton>{window.desktop ? <button className="project-context-button" aria-label={tr("{0} 项目工作区", state.project.name)} onClick={()=>setSwitcher(true)}><Folder size={14}/><span>{state.project.name}</span><ChevronDown size={13}/></button> : <span>{state.project.name.split(' · ')[0]}</span>}<ChevronRight size={14}/><strong>{view === 'projects' ? tr("所有项目") : view === 'workbench' ? tr("工作台") : tr("项目看板")}</strong></div><div className="topbar-actions"><IconButton label={tr("查看工作记录")} onClick={() => setModal({ type: 'history' })}><Clock3 size={17}/></IconButton><IconButton label={tr("切换任务背景面板")} aria-expanded={showContext} aria-controls="task-context" onClick={() => setShowContext(!showContext)}><PanelRightClose size={17}/></IconButton></div></header>
      {!connected && <div className="connection-warning workspace-connection-warning" role="status">{tr("连接中断，正在重连。未发送的内容已保存在本机。")}</div>}
      {navigationPending && <div className="navigation-pending" role="status"><Loader2 size={14} className="spin"/>{tr("正在打开 ")}{projects?.projects.find(p=>p.id===navigationPending)?.name || tr("项目")}{tr(" 工作台")}</div>}
      {navigationError && <div className="error-banner navigation-error" role="alert">{navigationError}</div>}
      {view === 'projects' ? <ProjectsOverview onOpenTask={openProjectTask} onOpen={openProject} pending={navigationPending} externalError={error} snapshot={projects} onAdd={() => setModal({ type: 'project', adding: true })} onCurrent={() => setView('workbench')}/> : view === 'workbench' ? <div className="workbench-layout"><main className="main-panel">
        <div className="main-scroll" ref={scrollRef} onScroll={e=>{savedScroll.current=e.currentTarget.scrollTop;}}>

          <div className="page-title-row"><h1>{tr("工作台")}</h1><button className="button primary" onClick={newTask} disabled={Boolean(submitting)} title={tr("新建任务 · ⌘N")}><Plus size={15}/>{tr("新建任务")}</button></div>

          <div className="summary-line task-filters" aria-label={tr("任务状态")}>
            <button aria-pressed={taskFilter==='attention'} onClick={()=>setTaskFilter(taskFilter==='attention'?null:'attention')}><i className="dot amber"/>{tr("待处理 ")}<b>{pendingTasks.length}</b></button>
            <button aria-pressed={taskFilter==='active'} onClick={()=>setTaskFilter(taskFilter==='active'?null:'active')}><i className="dot green"/>{tr("进行中 ")}<b>{activeCount}</b></button>
            <button aria-pressed={taskFilter==='done'} onClick={()=>setTaskFilter(taskFilter==='done'?null:'done')}><Check size={14}/>{tr("已完成 ")}<b>{doneCount}</b></button>
            <button className="all-tasks-link" onClick={()=>setView('board')}>{tr("全部任务")}<ChevronRight size={13}/></button>
          </div>
          {taskFilter && <section className="task-quick-list" aria-label={tr("筛选任务")}><div className="row-between"><strong>{{attention:tr("待处理"),active:tr("进行中"),done:tr("已完成")}[taskFilter]}</strong><IconButton label={tr("收起任务列表")} onClick={()=>setTaskFilter(null)}><X size={14}/></IconButton></div>{filteredTasks.length ? filteredTasks.map(t=><button className="task-quick-row" key={t.id} onClick={()=>choose(t.id)}><span>{t.title}</span><Status status={t.status}/><ChevronRight size={13}/></button>) : <p>{tr("暂无任务")}</p>}</section>}
          {focus ? <article className={`focus-card ${focus.status}`}>
            <div className="card-top"><span className="card-type">{focus.status === 'queued' && focus.dependencyWait?.length ? <Clock3 size={17}/> : focus.status === 'review' ? <CheckCheck size={17}/> : focus.status === 'blocked' ? <MessageSquare size={17}/> : working.includes(focus.status) ? <Loader2 size={17} className="spin"/> : <Circle size={17}/>} {focus.status === 'queued' && focus.dependencyWait?.length ? tr("等待依赖") : focus.status === 'review' ? tr("待验收") : focus.status === 'blocked' ? tr("待决定") : focus.status === 'failed' ? tr("执行失败") : focus.status === 'done' ? tr("已完成") : focus.status === 'paused' ? tr("已暂停") : tr(labels[focus.status])}</span>{focus.priority === 'high' && <span className="priority-label">{tr("优先")}</span>}</div>
            <h2>{focus.title}</h2>{focus.modelSelection && <div className="task-model">{focus.modelSelection.provider} · {focus.modelSelection.label || focus.modelSelection.model}{focus.modelSelection.effort && tr(" · 思考：{0}", {none:tr("关闭"),minimal:tr("最低"),low:tr("低"),medium:tr("中"),high:tr("高"),xhigh:tr("很高"),max:tr("最高"),ultra:tr("极高")}[focus.modelSelection.effort] || focus.modelSelection.effort)}{focus.modelSelection.speed && focus.modelSelection.speed !== 'standard' && ` · ${focus.modelSelection.speed === 'fast' ? tr("快速") : focus.modelSelection.speed}`}</div>}
            <details className="task-goal" key={`goal-${focus.id}`}><summary>{tr("查看任务目标")}<ChevronDown size={13}/></summary><p className="goal-intro">{focus.goal}</p></details>
            {focus.status !== 'review' && <div className="outcome"><span className="outcome-label">{focus.decision?.kind === 'command' ? ({ workspace: tr("项目命令"), network: tr("允许联网"), local: tr("本机执行 · 无沙箱") }[focus.decision.scope] || tr("命令授权")) : focus.decision ? tr("需要决定") : tr("目前进展")}</span><p>{focus.status === 'failed' ? systemText(recovery(focus).title) : focus.decision?.question || systemText(focus.summary)}</p>{focus.status === 'failed' && <><p>{systemText(recovery(focus).detail)}</p><details><summary>{tr("错误详情")}</summary><pre>{focus.summary}</pre></details></>}{focus.decision && <div className="recommendation"><MessageSquare size={15} aria-hidden="true"/><span>{focus.decision.recommendation}</span></div>}{focus.decision?.command && <pre className="command-preview">{focus.decision.command}</pre>}</div>}
            {working.includes(focus.status) && <TaskProgress task={focus} events={state.events}/>}
            <div className="task-resource-bar">{focus.status !== 'review' && focus.artifacts.map(file=><button key={file} title={file} onClick={()=>artifact(file)}><FileCode2 size={14}/><span>{file.split('/').at(-1)}</span><ArrowUpRight size={13}/></button>)}<button onClick={()=>openDetails('overview')}><PanelRightClose size={14}/>{tr("任务详情")}<ChevronRight size={13}/></button></div>
            <button className="execution-entry-link" onClick={() => openDetails('execution')}><Terminal size={14}/>{tr("查看执行过程")}<ChevronRight size={13}/></button>
            {focus.status === 'review' && (!showContext || contextTab !== 'results') && <Delivery key={`delivery-${focus.id}`} task={focus} api={api} busy={busy} connected={connected} onAccept={()=>action('accept')} onModify={modify}/>}

            <div className="card-footer"><div className="primary-actions">
              {focus.status === 'blocked' && focus.decision?.options.map((option, i) => <button className={`button ${i === 0 ? 'primary' : 'secondary'}`} key={option} disabled={busy || !connected} onClick={() => action('decision', { decisionId: focus.decision.id, answer: option })}>{option}</button>)}
              {focus.status === 'paused' && <><button className="button primary" disabled={busy || !connected} onClick={() => action('resume')}><Play size={15}/>{tr("继续执行")}</button><button className="button secondary" onClick={modify}>{tr("补充要求")}</button></>}
              {focus.status === 'failed' && <><button className="button primary" disabled={busy || !connected} onClick={() => { const kind = recovery(focus).kind; if (kind === 'settings') setModal({type:'project',section:'accounts'}); else if (kind === 'evidence') openDetails('results',null,true); else action('resume'); }}>{systemText(recovery(focus).action)}</button>{recovery(focus).kind !== 'retry' && <button className="button secondary" disabled={busy || !connected} onClick={()=>action('resume')}>{tr("重试")}</button>}<button className="button secondary" onClick={modify}>{tr("补充要求")}</button></>}
              {working.includes(focus.status) && <><button className="button secondary" onClick={modify}>{tr("补充要求")}</button><button className="text-button" disabled={busy || focus.status === 'stopping'} onClick={() => action('pause')}><Pause size={14}/>{focus.status === 'stopping' ? tr("正在暂停") : tr("暂停")}</button></>}
              {focus.status === 'done' && <button className="button secondary" onClick={modify}>{tr("补充要求")}</button>}
            </div>{['review', 'blocked', 'failed'].includes(focus.status) && <button className="defer-button" disabled={busy} onClick={() => action('defer')} title={tr("30 分钟后提醒，可随时从看板打开")}>{tr("稍后处理")}</button>}</div>
          </article> : <article className="empty-card"><div className="clear-symbol"><Check size={28}/></div><h2>{tasks.length ? tr("暂无待处理任务") : tr("暂无任务")}</h2><p>{tr("在下方输入任务描述，提交后自动执行。")}</p></article>}
          {!focus && doneCount > 0 && <section className="recent-outcomes" aria-label={tr("最近成果")}><div className="recent-outcomes-heading">{tr("最近成果")}<button className="text-button" onClick={()=>setView('board')}>{tr("查看全部")}<ChevronRight size={13}/></button></div>{tasks.filter(t=>t.status==='done').sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).slice(0,3).map(t=><button className="recent-outcome" key={t.id} onClick={()=>choose(t.id)}><Check size={15}/><span>{t.title}</span><small>{tr("已验收")}</small><ChevronRight size={14}/></button>)}</section>}
          {waitingOthers.length > 0 && <button className="next-item" onClick={() => choose(waitingOthers[0].id)}><span className="next-icon"><Clock3 size={17}/></span><span><strong>{tr("其他待处理任务 · ")}{waitingOthers.length}</strong><small>{tr("下一件：")}{waitingOthers[0].title}</small></span><ChevronRight size={17}/></button>}
          {receipt && <div className="receipt" role="status"><Check size={15}/><span>{receipt}</span></div>}
        </div>
        <div className="composer-wrap">
          {error && <div className="error-banner" role="alert"><span>{systemText(error)}</span><IconButton label={tr("关闭提示")} onClick={() => setError('')}><X size={14}/></IconButton></div>}
          <form className="composer" onSubmit={send} onDragOver={e=>e.preventDefault()} onDrop={e=>{if(!submitting)attachments.onDrop(e);else e.preventDefault();}}>
            <div className="composer-scope"><MessageSquare size={14} aria-hidden="true"/><Select label={tr("沟通范围")} disabled={Boolean(submitting)} compact value={inputScope} onChange={value=>{setInputScope(value);setInputTaskId(value==='task'?scopeTask?.id:null);}} options={[{ value: 'project', label: tr("新任务") }, ...(scopeTask ? [{ value: 'task', label: tr("补充要求 · {0}", scopeTask.title) }] : [])]}/></div>
            {inputScope === 'task' && <div className="composer-target" role="status"><span>{tr("补充至：")}<strong>{inputTask?.title || tr("任务不可用")}</strong></span>{focusId !== inputTaskId && inputTask && <button type="button" onClick={() => choose(inputTaskId)}>{tr("返回该任务")}</button>}</div>}
            <textarea onPaste={e=>{if(!submitting)attachments.onPaste(e);}} ref={inputRef} aria-label={tr("交代工作或补充要求")} placeholder={inputScope === 'task' ? tr("输入补充要求…") : tr("描述要完成的任务…")} value={draft} readOnly={Boolean(submitting)} maxLength={12000} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}/>
            <Attachments value={attachments} api={api} disabled={Boolean(submitting)} onError={setError}/>
            {state.modelOptions?.length > 0 && preparation?.status === 'complete' && !draft && <span className="preparation-ready model-submitted" role="status">{tr("已提交")}</span>}{preparation && <PreparationProgress progress={preparation} connected={connected}/>}<div className="composer-bottom"><ComposerPermissions permissions={state.permissions} demo={state.project.mode === 'demo'} busy={busy || Boolean(submitting) || !connected} onChange={changePermissions} onManage={() => setModal({type: 'permissions'})}/>{state.project.mode !== 'demo' && state.modelOptions?.length ? <ModelPicker options={state.modelOptions} value={selectedModel} disabled={Boolean(submitting) || !connected} onChange={chooseModel} onRefresh={()=>window.desktop?.refreshModels?.().catch(()=>{})} onConfigure={()=>setModal({type:'project',section:'accounts'})}/> : preparation?.status === 'complete' && !draft ? <span className="preparation-ready composer-submit-status" role="status"><Check size={13}/>{tr("已提交")}</span> : <span className="composer-submit-status">{submitting ? tr("正在准备任务…") : inputScope === 'task' ? tr("发送给：{0}", inputTask?.title || scopeTask?.title || tr("所选任务")) : tr("提交后自动推进")}</span>}<button aria-label={tr("发送要求")} title={inputScope === 'task' ? tr("发送补充至：{0}", inputTask?.title || tr("任务不可用")) : tr("新建任务 · {0}", state.project.name)} className="send-button" disabled={!draft.trim() || submitting || attachments.uploading || !connected || (inputScope === 'task' && !inputTask)}>{submitting ? <Loader2 size={18} className="spin"/> : <ArrowUp size={19}/>}</button></div>
          </form><div className="composer-caption"><span>{tr("Enter 发送 · Shift + Enter 换行")}</span></div>
        </div>
      </main>
      <aside className="context-panel" style={{'--context-width':`${contextWidth}px`}} id="task-context" aria-label={tr("任务背景")}><ResizeHandle label={tr("调整任务详情宽度")} value={contextWidth} min={310} max={640} reverse onChange={setContextWidth}/><div className="context-header"><span>{tr("任务详情")}</span><Status status={focus?.status || 'queued'}/><IconButton label={tr("收起任务背景")} onClick={()=>setShowContext(false)}><X size={16}/></IconButton></div>{focus ? <>
        <div className="detail-tabs" role="tablist" aria-label={tr("任务详情视图")}>{[['overview',tr("概览")],['results',tr("成果")],['execution',tr("执行记录")]].map(([id,label],i)=><button key={id} role="tab" id={`detail-tab-${id}`} aria-controls={`detail-panel-${id}`} aria-selected={contextTab===id} tabIndex={contextTab===id?0:-1} onClick={()=>setContextTab(id)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const next=['overview','results','execution'][(i+(e.key==='ArrowRight'?1:2))%3];setContextTab(next);document.getElementById(`detail-tab-${next}`)?.focus();}}}>{label}</button>)}</div>
        <div className="detail-panel" id="detail-panel-overview" role="tabpanel" aria-labelledby="detail-tab-overview" hidden={contextTab!=='overview'}>
        <div className="context-section"><div className="context-eyebrow">{tr("任务目标")}</div><h3>{focus.title}</h3><p>{focus.goal}</p></div>
        {(focus.parentTaskId || tasks.some(t=>t.parentTaskId===focus.id)) && <div className="context-section"><div className="context-eyebrow">{tr("相关任务")}</div>{tasks.filter(t=>t.id===focus.parentTaskId||t.parentTaskId===focus.id).map(t=><button className="file-row" key={t.id} onClick={()=>choose(t.id)}><Folder size={16}/><span>{t.title}<small>{t.id===focus.parentTaskId?tr("父任务"):tr("子任务")} · {labels[t.status]}</small></span><ChevronRight size={13}/></button>)}</div>}
        {focus.dependencies?.length > 0 && <div className="context-section"><div className="context-eyebrow">{tr("依赖任务")}</div>{focus.dependencies.map(edge => {const source=tasks.find(t=>t.id===edge.taskId);return <button className="file-row" key={edge.taskId} disabled={!source} onClick={()=>choose(edge.taskId)}><Folder size={16}/><span>{source?.title || tr("任务不存在")}<small>{edge.mode==='accepted'?tr("等待确认完成"):tr("使用已验证成果")}</small></span><ChevronRight size={13}/></button>;})}{focus.dependencyWait?.length > 0 && <p className="muted">{focus.dependencyWait.join('；')}</p>}</div>}
        <div className="context-section"><div className="context-eyebrow">{tr("约束 ")}<span>{focus.constraints.length}</span></div>{focus.constraints.length ? <ul className="constraint-list">{focus.constraints.map((c, i) => <li key={i}><ShieldCheck size={14}/><span>{c}</span></li>)}</ul> : <p className="muted">{tr("尚无额外约束")}</p>}</div>
        {focus.acceptance.length > 0 && <div className="context-section"><div className="context-eyebrow">{tr("验收标准")}</div><ul className="plain-list">{focus.acceptance.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
        {focus.decisions?.length > 0 && <div className="context-section"><div className="context-eyebrow">{tr("已确认的决定")}</div>{focus.decisions.filter(d => d.kind === 'business').map(d => <p key={d.id}><Check size={13}/> {d.answer}</p>)}</div>}
        <div className="context-section"><div className="context-eyebrow">{tr("成果 ")}<span>{focus.artifacts.length}</span></div>{focus.artifacts.length ? focus.artifacts.map(file => <button className="file-row" key={file} onClick={() => artifact(file)}><FileCode2 size={17}/><span>{file.split('/').at(-1)}<small>{file.split('/').slice(0, -1).join('/').slice(0, 18)}</small></span><ArrowUpRight size={13}/></button>) : <p className="muted">{tr("暂无成果")}</p>}</div>
        <div className="context-section"><div className="context-eyebrow">{tr("验证证据")}</div>{lastEvidence ? <button className="evidence-box" onClick={() => openDetails('results',null,true)}><span className={lastEvidence.passed && lastEvidence.applicability!=='superseded' ? 'green-text' : 'amber-text'}><ShieldCheck size={16}/>{lastEvidence.applicability==='superseded' ? tr("要求已变化，需重新验证") : lastEvidence.passed ? tr("本地验证通过") : tr("验证发现问题")}</span><small>{focus.evidence.length}{tr(" 次验证记录 ")}<ChevronRight size={13}/></small></button> : <p className="muted">{tr("尚未运行验证")}</p>}</div>
        <div className="context-bottom"><button className="text-button" onClick={() => openDetails('execution')}>{tr("查看执行过程")}<Terminal size={14}/></button><button className="text-button" disabled={busy} onClick={() => action('priority', { priority: focus.priority === 'high' ? 'normal' : 'high' })}>{focus.priority === 'high' ? tr("取消优先") : tr("设为优先")}<ArrowUpRight size={14}/></button><button className="text-button" onClick={() => openDetails('execution')}>{tr("查看完整工作记录")}<Clock3 size={14}/></button></div>
        </div>
        <div className="detail-panel" id="detail-panel-results" role="tabpanel" aria-labelledby="detail-tab-results" hidden={contextTab!=='results'}>{<Delivery key={`delivery-${focus.id}`} task={focus} api={api} busy={busy} connected={connected} selectedFile={selectedFile} evidenceOpen={evidenceOpen} onAccept={()=>action('accept')} onModify={modify}/>}</div>
        <div className="detail-panel detail-execution" id="detail-panel-execution" role="tabpanel" aria-labelledby="detail-tab-execution" hidden={contextTab!=='execution'}>{<><ExecutionTimeline key={focus.id} task={focus} events={state.events} connected={connected} onReturn={()=>{setShowContext(false);inputRef.current?.focus();}}/><details className="task-history"><summary>{tr("要求与工作记录")}</summary><WorkHistory events={state.events} messages={state.messages} tasks={tasks} taskId={focus.id}/></details></>}</div>
      </> : <div className="context-section"><p className="muted">{tr("选择任务查看详情。")}</p></div>}</aside></div> : <main className="board-view">
        <div className="page-title-row"><h1>{tr("项目看板")}</h1><button className="button secondary" onClick={() => setView('workbench')}>{tr("返回工作台 ")}<ArrowUpRight size={15}/></button></div>
        <div className="board-toolbar"><div className="search-box"><Search size={16}/><input aria-label={tr("搜索任务")} placeholder={tr("搜索任务…")} value={query} onChange={e => setQuery(e.target.value)}/></div><span>{tasks.length}{tr(" 项任务 · ")}{doneCount}{tr(" 项已完成")}</span><div className="task-view-switch" aria-label={tr("任务展示方式")}><button aria-pressed={boardMode==='list'} onClick={()=>setBoardMode('list')}>{tr("列表")}</button><button aria-pressed={boardMode==='board'} onClick={()=>setBoardMode('board')}>{tr("看板")}</button></div></div>
        <div className={boardMode==='list'?'kanban task-list-view':'kanban three-columns'}>{[
          ['attention',tr("待处理"),['blocked','failed','review','paused']], ['running',tr("进行中"),['queued','running','verifying','stopping']], ['done',tr("已完成"),['done']],
        ].map(([key, title, statuses]) => { const items = tasks.filter(t => statuses.includes(t.status) && (t.title + t.goal).toLowerCase().includes(query.toLowerCase())); return <section className="kanban-column" key={key}><h3><span className={`column-dot ${key}`}/>{title}<b>{items.length}</b></h3><div className="kanban-items">{items.map(t => <button className="kanban-card" key={t.id} onClick={() => choose(t.id)}><div className="row-between"><span className="task-id">TASK {String(tasks.indexOf(t) + 1).padStart(2, '0')}</span>{t.priority === 'high' && <span className="priority-label">{tr("优先")}</span>}</div><h4>{t.title}</h4><p>{t.summary}</p><div className="kanban-card-bottom"><Status status={t.status}/><span>{time(t.updatedAt)}</span></div></button>)}{!items.length && <div className="column-empty">{tr("暂无任务")}</div>}</div></section>; })}</div>
      </main>}
    </div>
    {switcher && <ProjectSwitcher snapshot={projects} currentId={state.project.id} pending={navigationPending} error={navigationError} onOpen={openProject} onClose={()=>setSwitcher(false)} onAdd={()=>setModal({type:'project',adding:true})}/>}
    {modal && <dialog className={modal.type === 'project' && window.desktop ? 'settings-dialog' : undefined} ref={dialogRef} onCancel={e => {e.preventDefault();closeModal();}} onClick={e => { if (e.target === dialogRef.current) closeModal(); }}><div className="dialog-heading"><h2>{{ permissions: tr("权限"), history: tr("工作记录"), project: modal.adding ? tr("添加项目") : tr("设置") }[modal.type]}</h2><IconButton label={tr("关闭面板")} onClick={closeModal}><X size={20}/></IconButton></div><div className="dialog-body">
      {modal.type === 'history' && <WorkHistory events={state.events} messages={state.messages} tasks={tasks} taskId={modal.taskId}/>}
      {(modal.type === 'permissions' || modal.type === 'project' && !modal.adding && !window.desktop) && state.project.mode !== 'demo' && <Permissions permissions={state.permissions} tasks={tasks} busy={busy} onChange={changePermissions}/>}
      {modal.type === 'project' && window.desktop && <DesktopSettings onClose={()=>setModal(null)} registerCloseGuard={fn=>{settingsCloseGuard.current=fn;}} adding={modal.adding} initialSection={modal.section} permissionsPanel={!modal.adding && state.project.mode !== 'demo' ? <Permissions permissions={state.permissions} tasks={tasks} busy={busy} onChange={changePermissions}/> : null}/>}
      {modal.type === 'project' && !window.desktop && <div className="settings-content"><Language/><span className="mode-tag">{state.project.mode === 'demo' ? tr("无需账号的本地演示") : tr("pi 真实执行")}</span><h3>{state.project.name}</h3><p>{tr("当前项目目录")}</p><pre>{state.project.path}</pre><p>{tr("执行方式：")}{state.project.model}</p><p>{state.project.mode === 'demo' ? tr("演示会生成示例文件并运行真实测试。自然语言使用有限规则解析；真实项目由 pi 管理与执行。") : tr("新任务会修改上方目录。默认在项目沙箱中执行；联网和项目外访问按需授权。")}</p><p>{tr("切换到真实项目：按项目 README 配置 .env 中的项目路径与模型，然后使用 npm start 启动。两种模式的任务和文件独立保存。")}</p><p className="muted">{tr("第一版每个服务管理一个项目，执行任务顺序推进；管理入口可在后台执行期间响应。刷新页面不会丢失任务。")}</p></div>}
    </div></dialog>}
  </div>;
}

createRoot(document.getElementById('root')).render(<WorkbenchBoundary><WorkbenchRoot/></WorkbenchBoundary>);
