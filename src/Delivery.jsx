import { t as tr, localeTag } from './i18n.mjs';
import React, { useState, useEffect } from 'react';
import { ArtifactPreview } from './ArtifactPreview.jsx';
import { Evidence } from './Evidence.jsx';

export function Delivery({ task, api, busy, connected, onAccept, onModify, selectedFile, evidenceOpen=false }) {
  const [selected, setSelected] = useState(task.artifacts[0] || '');
  const [showEvidence,setShowEvidence]=useState(evidenceOpen);
  useEffect(()=>{if(selectedFile)setSelected(selectedFile);},[selectedFile]);
  useEffect(()=>setShowEvidence(evidenceOpen),[evidenceOpen]);
  const file = task.artifacts.includes(selected) ? selected : task.artifacts[0];
  const evidence = task.evidence.at(-1);
  const verified = evidence?.passed && evidence.applicability !== 'superseded';
  return <section className="delivery" aria-label={tr("成果与验收")}>
    <h3>{tr("成果")}</h3>
    <p>{task.deliveries?.at(-1)?.summary || task.summary}</p>
    {task.artifacts.length > 0 ? <><div className="delivery-files" aria-label={tr("成果文件")}>{task.artifacts.map(path => <button key={path} aria-pressed={file === path} title={path} onClick={() => setSelected(path)}>{path.split('/').at(-1)}</button>)}</div><ArtifactPreview key={file} file={file} taskId={task.id} api={api}/></> : <p className="muted">{tr("此任务没有文件成果，请核对上方结果。")}</p>}
    <div className="delivery-verification"><strong>{verified ? tr("验证通过") : evidence?.applicability === 'superseded' ? tr("要求已更新，需重新验证") : tr("尚未通过验证")}</strong><button aria-expanded={showEvidence} onClick={()=>setShowEvidence(!showEvidence)}>{tr("查看验证详情")}</button></div>
    {showEvidence && <Evidence task={task}/>}
    {task.acceptance.length > 0 && <details><summary>{tr("验收标准 · ")}{task.acceptance.length}{tr(" 项")}</summary><ul>{task.acceptance.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
    {task.status === 'review' && <div className="delivery-actions"><button className="button primary" disabled={busy || !connected || !verified} onClick={onAccept}>{tr("确认完成")}</button><button className="button secondary" onClick={onModify}>{tr("提出修改")}</button></div>}
  </section>;
}
