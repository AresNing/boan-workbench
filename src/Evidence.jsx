import { t as tr, localeTag, systemText } from './i18n.mjs';
import React from 'react';
export function Evidence({ task }) {
  return <section className="evidence-details" aria-label={tr("验证详情")}>
    {!task.evidence.length && <p>{tr("尚无验证记录。")}</p>}
    {task.evidence.map((e,i)=><details key={i} open={i===task.evidence.length-1}><summary>{e.applicability==='superseded'?tr("已过时"):e.passed?tr("通过"):tr("未通过")}{tr(" · 第 ")}{i+1}{tr(" 次验证 · 退出码 ")}{e.exitCode}</summary><pre>{e.command}{'\n\n'}{e.output}</pre></details>)}
  </section>;
}
