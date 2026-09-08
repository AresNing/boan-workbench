import { t as tr, localeTag, systemText } from './i18n.mjs';
import React, { useEffect, useState } from 'react';
import { Check, AlertCircle } from 'lucide-react';

export function PreparationProgress({ progress, connected }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    setClock(Date.now());
    if (progress.status !== 'running') return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress.startedAt, progress.status]);
  if (progress.status === 'complete') return null;
  const seconds = Math.max(0, Math.floor(((progress.status === 'running' ? clock : Date.parse(progress.updatedAt || progress.startedAt)) - Date.parse(progress.startedAt)) / 1000));
  return <div className={`preparation-progress ${progress.status}`}>
    <div className="preparation-heading" role="status"><span>{progress.status === 'complete' ? <Check size={14}/> : progress.status === 'failed' ? <AlertCircle size={14}/> : null}{tr("前置准备 · ")}{systemText(progress.title)}</span><strong>{progress.percent}%</strong></div>
    <div className="preparation-track" role="progressbar" aria-label={tr("前置准备阶段进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={`${progress.percent}% · ${systemText(progress.title)}`}><i style={{ width: `${progress.percent}%` }}/></div>
    <p>{!connected && progress.status === 'running' ? tr("连接中断，正在重连以确认后台状态，请勿重复提交。") : systemText(progress.detail)}</p>
    <div className="preparation-footnote"><span>{tr("阶段进度 · 非任务完成度")}</span><span>{progress.status === 'running' ? tr("已等待") : tr("用时")} {seconds}{tr(" 秒")}</span></div>
    {seconds >= 20 && progress.status === 'running' && connected && <p className="preparation-wait">{tr("当前步骤耗时较长，完成后会更新进度；无需重复发送。")}</p>}
  </div>;
}
