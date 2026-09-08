import { t as tr, localeTag } from './i18n.mjs';
import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Select } from './Select.jsx';

export function Permissions({ permissions, tasks, busy, onChange }) {
  if (!permissions) return null;
  return <section className="permission-settings" aria-label={tr("命令权限")}>
    <h3><ShieldCheck size={17}/>{tr("命令权限")}</h3>
    <Select label={tr("审批模式")} value={permissions.mode} disabled={busy} onChange={mode => onChange({ mode })} options={[
      { value: 'auto', label: tr("项目内自动执行（推荐）") }, { value: 'ask', label: tr("每条命令询问") },
    ]}/>
    <p className="muted">{permissions.sandboxAvailable ? tr("可读写项目和独立临时目录；出站联网需授权，访问项目外文件需单次批准。系统工具只读，登录凭据不传给命令。") : tr("此系统尚未启用项目沙箱，命令仍需逐次批准，以本机权限运行。")}</p>
    <p className="muted">{tr("设置仅对当前项目生效。等待你审批的时间不计入执行时限。")}</p>
    <div className="permission-grants">
      <h4>{tr("本次任务授权")}</h4>
      {permissions.grants.length ? permissions.grants.map(grant => <div className="permission-grant" key={grant.taskId}>
        <div><strong>{tasks.find(t => t.id === grant.taskId)?.title || tr("任务")}</strong><span>{[grant.workspace && tr("项目命令"), grant.network && tr("联网")].filter(Boolean).join('、')}</span></div>
        <button type="button" className="button secondary" disabled={busy} onClick={() => onChange({ revokeTaskId: grant.taskId })}>{tr("撤销")}</button>
      </div>) : <p className="muted">{tr("暂无临时授权")}</p>}
      <p className="muted">{tr("任务执行结束、暂停或重启后失效。撤销对后续命令生效；停止正在运行的命令请暂停任务。")}</p>
    </div>
  </section>;
}
