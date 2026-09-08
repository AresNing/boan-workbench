import { t as tr, localeTag } from './i18n.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { Folder, Plus, Search, Check, LayoutDashboard, SquareKanban, Clock3, ArrowUpRight } from 'lucide-react';
import './project-navigation.css';
export function projectProgress(project) {
  if (project.status === 'error') return {text:tr("连接需要处理"),tone:'attention'};
  if (project.status === 'starting') return {text:tr("正在连接"),tone:'running'};
  if (project.status === 'stopped') return {text:tr("尚未连接"),tone:'quiet'};
  if (project.attention) return {text:tr("{0} 项待处理", project.attention),tone:'attention'};
  if (project.managerBusy) return {text:tr("正在整理要求"),tone:'running'};
  if (project.active) return {text:tr("{0} 项推进中", project.active),tone:'running'};
  return {text:tr("空闲"),tone:'quiet'};
}
export function ProjectNavigation({snapshot, currentId, view, taskCount, onOpen, onView, onHistory, onAdd, onSearch, pending}) {
  return <section className="project-navigation" aria-label={tr("项目导航")}>
    <div className="project-navigation-heading"><span>{tr("项目")}</span><div><button aria-label={tr("快速切换项目")} title={tr("快速切换项目 · ⌘K")} onClick={onSearch}><Search size={15}/></button><button aria-label={tr("添加项目")} title={tr("添加项目")} onClick={onAdd}><Plus size={16}/></button></div></div>
    <div className="project-navigation-list">{(snapshot?.projects || []).map(project=>{
      const current=project.id===currentId, progress=projectProgress(project);
      return <div className={`project-navigation-item ${current?'current':''}`} key={project.id}>
        <button className="project-nav-open" aria-label={tr("打开 {0} 工作台", project.name)} aria-current={current ? 'page' : undefined} title={project.path} disabled={Boolean(pending)} onClick={()=>onOpen(project)}><span className="project-nav-icon"><Folder size={17}/></span><span className="project-nav-copy"><strong>{project.name}</strong><small className={progress.tone}><i/>{pending===project.id?tr("正在打开工作台…"):progress.text}</small></span>{current && <span className="project-current-dot"/>}</button>
        {current && <nav className="project-local-nav" aria-label={tr("当前项目视图")}><button className={view==='workbench'?'selected':''} onClick={()=>onView('workbench')}><LayoutDashboard size={14}/>{tr("工作台")}</button><button className={view==='board'?'selected':''} onClick={()=>onView('board')}><SquareKanban size={14}/>{tr("项目看板")}<small>{taskCount}</small></button><button onClick={onHistory}><Clock3 size={14}/>{tr("工作记录")}</button></nav>}
      </div>;
    })}</div>

  </section>;
}
export function ProjectSwitcher({snapshot, currentId, pending, error, onOpen, onClose, onAdd}) {
  const dialog=useRef(null), input=useRef(null), [query,setQuery]=useState(''), [index,setIndex]=useState(0);
  const projects=(snapshot?.projects || []).filter(p=>`${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(()=>{const previous=document.activeElement;dialog.current.showModal();input.current.focus();return ()=>{if(previous?.isConnected)previous.focus();};},[]);
  useEffect(()=>{dialog.current?.querySelector(`[data-project-index="${index}"]`)?.scrollIntoView({block:'nearest'});},[index]);
  const choose=project=>{if(!project || pending)return;onOpen(project);};
  return <dialog ref={dialog} className="project-switcher" aria-label={tr("快速切换项目")} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===dialog.current)onClose();}}>
    <div className="project-switcher-search"><Search size={19}/><input ref={input} role="combobox" aria-label={tr("搜索项目")} aria-controls="project-switcher-list" aria-expanded="true" aria-activedescendant={projects.length?`switch-project-${Math.min(index,projects.length-1)}`:undefined} placeholder={tr("搜索项目名称或目录…")} value={query} onChange={e=>{setQuery(e.target.value);setIndex(0);}} onKeyDown={e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setIndex(i=>projects.length?(i+(e.key==='ArrowDown'?1:-1)+projects.length)%projects.length:0);}if(e.key==='Enter'){e.preventDefault();choose(projects[Math.min(index,projects.length-1)]);}}}/><button onClick={onClose} aria-label={tr("关闭项目切换")}>Esc</button></div>
    <div className="project-switcher-heading">{tr("切换项目")}</div>
    {error && <p className="project-switcher-error" role="alert">{error}</p>}
    <div id="project-switcher-list" className="project-switcher-list" role="listbox" aria-label={tr("项目")}>{projects.map((project,i)=>{const progress=projectProgress(project);return <button role="option" id={`switch-project-${i}`} data-project-index={i} aria-selected={i===Math.min(index,projects.length-1)} tabIndex={-1} key={project.id} disabled={Boolean(pending)} onMouseMove={()=>setIndex(i)} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(project)}><Folder size={19}/><span><strong>{project.name}</strong><small>{project.path || tr("本地演示工作区")}</small></span><em className={progress.tone}>{pending===project.id?tr("正在打开…"):progress.text}</em>{currentId===project.id?<Check size={16}/>:<ArrowUpRight size={14}/>}</button>;})}{!projects.length && <p className="project-switcher-empty">{tr("没有找到项目，可以选择本机目录添加。")}</p>}</div>
    <footer><button onClick={()=>{onClose();onAdd();}}><Plus size={15}/>{tr("添加项目")}</button><span>{tr("↑ ↓ 选择 · Enter 打开")}</span></footer>
  </dialog>;
}
