import { t as tr, localeTag, systemText } from './i18n.mjs';
import React from 'react';
export function TaskProgress({ task, events }) {
  const latest = events.filter(e=>e.taskId===task.id && (e.kind==='progress'||e.kind==='activity')).at(-1);
  if (!latest) return null;
  const status = latest.status === 'failed' ? tr("未完成") : latest.status === 'completed' ? tr("已完成") : latest.status === 'waiting' ? tr("等待授权") : tr("进行中");
  return <div className="task-live-progress"><span>{latest.kind==='progress' ? latest.detail || latest.text : `${systemText(latest.text)} · ${status}`}</span><time dateTime={latest.at}>{tr("更新于 ")}{new Date(latest.at).toLocaleTimeString(localeTag(),{hour:'2-digit',minute:'2-digit'})}</time></div>;
}
