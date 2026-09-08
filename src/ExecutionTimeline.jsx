import { t as tr, localeTag, systemText } from './i18n.mjs';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Check, ChevronRight, Circle, Clock3, FileCode2, FolderSearch, Loader2, MessageSquare, Terminal, X } from 'lucide-react';
import './execution.css';
import { groupExecutionEvents, groupSummary } from './execution-groups.mjs';

const states = { queued: '等待执行', running: '正在执行', verifying: '正在验证', stopping: '正在暂停', blocked: '等待你的决定', review: '等待验收', paused: '已暂停', failed: '需要处理', done: '已完成' };
const outcomes = { waiting: '待批准', running: '进行中', completed: '完成', failed: '失败', interrupted: '已中断' };
const time = value => new Date(value).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function iconFor(e) {
  if (e.status === 'running') return <Loader2 size={15} className="spin"/>;
  if (e.status === 'failed' || e.kind === 'error') return <X size={15}/>;
  if (e.status === 'waiting' || e.status === 'interrupted') return <Clock3 size={15}/>;
  if (e.tool === 'run_command' || e.tool === 'verification' || e.kind === 'verification') return <Terminal size={15}/>;
  if (e.tool === 'read_file' || e.tool === 'write_file') return <FileCode2 size={15}/>;
  if (e.tool === 'list_files') return <FolderSearch size={15}/>;
  if (e.kind === 'progress') return <MessageSquare size={15}/>;
  return e.kind === 'delivery' || e.kind === 'accept' ? <Check size={15}/> : <Circle size={12}/>;
}
function OperationGroup({ group }) {
  const files = [...new Set(group.items.map(e => e.path).filter(Boolean))];
  const last = group.items.at(-1);
  return <div className="execution-entry grouped">
    <span className="execution-icon">{group.category === 'write' ? <FileCode2 size={15}/> : <FolderSearch size={15}/>}</span>
    <details className="execution-group">
      <summary><ChevronRight size={14}/><strong>{group.category === 'write' ? tr("更新项目文件") : tr("查看项目资料")}</strong><span className="group-count">{groupSummary(group)}</span><time>{time(last.at)}</time></summary>
      <div className="execution-group-items">{group.items.map(e => <div className="execution-group-item" key={e.id}>
        <div className="group-item-line"><span>{e.tool === 'read_file' ? tr("读取") : e.tool === 'write_file' ? tr("写入") : tr("浏览目录")}</span><span className="group-file">{e.path || tr("项目目录")}</span><small>{e.status === 'completed' ? tr("完成") : tr("历史记录")}</small><time>{time(e.at)}</time></div>
        <p>{e.output || (e.status ? '' : tr("旧版仅记录操作发起，未记录结果。"))}{Number.isFinite(e.durationMs) && e.durationMs >= 1000 ? tr(" · 耗时 {0} 秒", (e.durationMs / 1000).toFixed(1)) : ''}</p>
      </div>)}</div>
    </details>
    {files.length > 0 && <div className="execution-group-preview">{files.slice(0, 3).join('、')}{files.length > 3 ? tr(" 等 {0} 个文件", files.length) : ''}</div>}
  </div>;
}
export function ExecutionTimeline({ task, events, connected, onReturn }) {
  const viewport = useRef(null), follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const entries = events.filter(e => e.taskId === task.id);
  const groups = groupExecutionEvents(events, task.id);
  useLayoutEffect(() => {
    if (follow.current && viewport.current?.clientHeight) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [events]);
  useLayoutEffect(() => {
    const el = viewport.current;
    const observer = new ResizeObserver(() => {
      if (!el.clientHeight) return;
      // Collapsing details can remove the overflow without firing a scroll event.
      // Resume following when everything fits, including after the dialog opens.
      if (el.scrollHeight <= el.clientHeight + 1) { follow.current = true; setFollowing(true); }
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el); observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const bottom = () => { follow.current = true; setFollowing(true); viewport.current.scrollTop = viewport.current.scrollHeight; };
  return <div className="execution-panel">
    <div className="execution-heading"><span className={`execution-status ${connected ? '' : 'offline'}`}><i/>{connected ? task.status === 'queued' && task.dependencyWait?.length ? tr("等待上游成果") : tr(states[task.status]) : tr("连接中断 · 正在重连")}</span><h3>{task.title}</h3><p>{tr("相邻同类操作已合并 · 展开查看明细")}</p></div>
    <div className="execution-scroll" ref={viewport} tabIndex={0} aria-label={tr("执行时间线")} onScroll={() => {
      const el = viewport.current; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; setFollowing(follow.current);
    }}>
      <div className="execution-timeline">
        {!entries.length && <p className="execution-empty">{tr("还没有执行记录。任务开始后会在这里更新。")}</p>}
        {groups.map(e => e.items ? <OperationGroup group={e} key={e.id}/> : <div className={`execution-entry ${e.kind === 'progress' ? 'message' : ''} ${e.status || ''}`} key={e.id}>
          <span className="execution-icon">{iconFor(e)}</span>
          <div className="execution-content">
            {e.kind === 'progress' ? <><div className="execution-meta">Agent <time>{time(e.at)}</time></div><p className="execution-message">{e.detail}</p></> : <>
              <div className="execution-line"><strong>{systemText(e.text)}</strong><span className="execution-outcome">{tr(outcomes[e.status]) || ''}</span><time>{time(e.at)}</time></div>
              {e.path && <div className="execution-path">{e.path}</div>}
              {(e.command || e.output || e.detail) && <details className="execution-detail"><summary><ChevronRight size={13}/><span>{e.command || tr("查看详情")}</span>{Number.isFinite(e.exitCode) && <span className="execution-exit">{tr("退出码 ")}{e.exitCode}</span>}</summary><pre>{e.output || e.detail || (e.status === 'waiting' ? tr("等待批准，尚未执行。") : e.status === 'running' ? tr("命令执行中，尚无输出。") : tr("没有输出。"))}</pre></details>}
              {Number.isFinite(e.durationMs) && <small className="execution-duration">{tr("耗时 ")}{(e.durationMs / 1000).toFixed(1)}{tr(" 秒")}</small>}
            </>}
          </div>
        </div>)}
        {['running', 'verifying', 'stopping'].includes(task.status) && <div className="execution-live"><Loader2 size={14} className="spin"/><span>{tr(states[task.status])}{!entries.some(e => e.status === 'running') && tr(" · 等待下一条进展")}</span></div>}
      </div>
    </div>
    <div className="execution-bottom"><span>{tr("显示最近保留的记录")}</span>{!following && <button onClick={bottom}><ArrowDown size={14}/>{tr("回到最新")}</button>}{task.status === 'blocked' && <button onClick={onReturn}>{tr("返回处理决定")}<ChevronRight size={14}/></button>}</div>
  </div>;
}
