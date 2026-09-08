import { t as tr, localeTag, systemText } from './i18n.mjs';
import React from 'react';
import { ChevronRight, Folder, MessageSquare } from 'lucide-react';
import { groupHistory } from './history-groups.mjs';
import { groupSummary } from './execution-groups.mjs';
import './history.css';

const time = value => new Date(value).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
const outcomes = { running: '进行中', waiting: '待批准', completed: '完成', failed: '失败', interrupted: '已中断' };
const describe = entry => entry.kind === 'user' ? tr("你：") + entry.text : entry.kind === 'assistant' ? tr("工作台：") + entry.text : entry.kind === 'progress' ? entry.detail || entry.text : systemText(entry.text);
function Record({ entry }) {
  const details = [entry.command, entry.path, entry.output || entry.detail].filter(Boolean).join('\n');
  return <div className={`history-record ${entry.status === 'failed' || entry.kind === 'error' ? 'failed' : ''}`}>
    <div className="history-record-heading"><strong>{entry.kind === 'user' ? tr("你") : entry.kind === 'assistant' ? tr("工作台") : systemText(entry.text)}</strong><span>{tr(outcomes[entry.status])}</span><time dateTime={entry.at}>{time(entry.at)}</time></div>
    {['user', 'assistant'].includes(entry.kind) ? <p>{entry.text}</p> : details && <details className="history-record-detail"><summary>{tr("查看详情")}</summary><pre>{details}</pre></details>}
  </div>;
}
export function WorkHistory({ events, messages, tasks, taskId }) {
  const groups = groupHistory(events, messages, taskId);
  let previousDay;
  return <div className="work-history">
    <p className="history-help">{tr("最近记录")}</p>
    {!groups.length && <p className="history-empty">{tr("暂无工作记录")}</p>}
    {groups.map(group => {
      const showDay = previousDay !== group.day; previousDay = group.day;
      const task = tasks.find(t => t.id === group.taskId);
      const highlights = group.items.filter(e => !['activity', 'tool', 'session'].includes(e.kind));
      const latest = highlights.at(-1) || group.items.at(-1);
      const failures = group.items.filter(e => e.status === 'failed' || e.kind === 'error').length;
      const operations = group.entries.filter(e => e.items).flatMap(e => e.items);
      const stats = operations.length ? groupSummary({ items: operations }) : '';
      return <React.Fragment key={group.id}>
        {showDay && <h3 className="history-day">{group.day}</h3>}
        <details className="history-session" data-history-id={group.id}>
          <summary><span className="history-session-icon">{group.taskId ? <Folder size={16}/> : <MessageSquare size={16}/>}</span><span className="history-session-overview"><span className="history-session-top"><strong>{task?.title || (group.taskId ? tr("任务记录") : tr("项目沟通"))}</strong><time>{time(group.start)}{time(group.start) !== time(group.end) ? `–${time(group.end)}` : ''}</time></span><span className="history-session-preview">{describe(latest)}</span><span className="history-session-meta">{group.items.length}{tr(" 条记录")}{stats && ` · ${stats}`}{failures > 0 && <span className="history-failures"> · {failures}{tr(" 条失败记录")}</span>}</span></span><ChevronRight className="history-chevron" size={15}/></summary>
          <div className="history-session-body">{group.entries.map(entry => entry.items ? <details className="history-operations" key={entry.id}><summary><ChevronRight size={13}/><strong>{entry.category === 'write' ? tr("更新项目文件") : tr("查看项目资料")}</strong><span>{groupSummary(entry)}</span><time>{time(entry.items.at(-1).at)}</time></summary><div>{[...entry.items].reverse().map(item => <Record entry={item} key={item.id}/>)}</div></details> : <Record entry={entry} key={entry.id}/>)}</div>
        </details>
      </React.Fragment>;
    })}
  </div>;
}
