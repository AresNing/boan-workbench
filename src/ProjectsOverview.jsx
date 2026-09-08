import { t as tr, localeTag } from './i18n.mjs';
import React from 'react';
import { Folder, Plus, ArrowUpRight, Loader2 } from 'lucide-react';
import './projects.css';
export function ProjectsOverview({ snapshot, onAdd, externalError, onOpen, onOpenTask, pending }) {
  const projects = snapshot?.projects || [];
  const busy = pending;
  const attention = projects.flatMap(project => (project.status === 'ready' ? project.tasks || [] : []).filter(task => ['blocked','failed','review'].includes(task.status) && (!task.deferredUntil || Date.parse(task.deferredUntil) <= Date.now())).map(task => ({project, task})));
  const open = project => onOpen(project);
  return <main className="projects-overview">

    <div className="page-title-row"><h1>{tr("所有项目")}</h1><button className="button primary" onClick={onAdd}><Plus size={15}/>{tr("添加项目")}</button></div>

    <div className="projects-totals"><span>{projects.filter(p=>p.mode==='pi').length}{tr(" 个项目")}</span><span>{projects.reduce((n,p)=>n+p.active,0)}{tr(" 项推进中")}</span><span>{projects.reduce((n,p)=>n+p.attention,0)}{tr(" 项需要关注")}</span></div>
    {externalError && <div className="error-banner" role="alert">{externalError}</div>}
    {!snapshot && <p className="muted">{tr("正在读取项目…")}</p>}
    {attention.length > 0 && <section className="project-attention" aria-label={tr("跨项目待处理")}><h2>{tr("待处理 ")}<small>{attention.length}</small></h2>{attention.map(({project,task}) => <button className="attention-task" key={`${project.id}:${task.id}`} disabled={Boolean(busy) || snapshot.switching} onClick={() => onOpenTask(project,task.id)}><span><strong>{task.title}</strong><small>{project.name}</small></span><span>{{blocked:tr("需要决定"),failed:tr("执行失败"),review:tr("查看成果")}[task.status]}</span><ArrowUpRight size={14}/></button>)}</section>}
    <div className="project-cards">{projects.map(project => <article key={project.id} className={`project-card ${project.selected ? 'selected' : ''}`}>
      <div className="project-card-heading"><span className="project-card-icon"><Folder size={20}/></span><div><h2>{project.name}</h2><p title={project.path}>{project.path || tr("无需账号的示例工作区")}</p></div>{project.selected && <small>{tr("当前")}</small>}</div>
      <div className="project-card-counts"><span>{project.active}{tr(" 推进中")}</span><span className={project.attention ? 'attention' : ''}>{project.attention}{tr(" 需关注")}</span><span>{project.done}{tr(" 已验收")}</span></div>
      {project.managerBusy && <p className="project-service"><Loader2 size={12} className="spin"/>{tr("正在整理新要求")}</p>}
      {project.status !== 'ready' && <p className="project-service">{{starting:tr("正在连接项目…"),stopped:tr("尚未连接，打开项目后恢复工作台"),error:tr("项目连接需要处理")}[project.status]}{project.error && `：${project.error}`}</p>}
      <ul className="project-task-preview">{(project.status === 'ready' ? project.tasks : []).filter(t=>['blocked','failed','review','running','verifying','queued','paused'].includes(t.status)).slice(0,3).map(task=><li key={task.id}><button disabled={Boolean(busy)} onClick={()=>onOpenTask(project,task.id)}><span>{task.title}</span><small>{{blocked:tr("待决定"),failed:tr("需处理"),review:tr("待验收"),running:tr("执行中"),verifying:tr("验证中"),queued:tr("已安排"),paused:tr("已暂停")}[task.status]}</small></button></li>)}</ul>
      <button className="text-button" disabled={Boolean(busy) || snapshot.switching} onClick={()=>open(project)}>{busy===project.id ? tr("正在打开…") : project.attention ? tr("进入处理 {0} 项事项", project.attention) : project.status==='error' ? tr("重新连接项目") : tr("进入项目")}<ArrowUpRight size={14}/></button>
    </article>)}</div>
  </main>;
}
