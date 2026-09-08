import { t as tr, localeTag } from './i18n.mjs';
import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import './composer-permissions.css';

export function ComposerPermissions({ permissions, demo, busy, onChange, onManage }) {
  const id = useId(), trigger = useRef(null), popup = useRef(null);
  const [open, setOpen] = useState(false);
  const available = Boolean(permissions?.sandboxAvailable);
  const mode = available ? permissions?.mode || 'auto' : 'ask';
  const label = demo ? tr("演示模式") : mode === 'auto' ? tr("项目内自动") : tr("逐次询问");
  const position = () => {
    if (!popup.current?.matches(':popover-open')) return;
    const box = trigger.current.getBoundingClientRect();
    const width = Math.min(300, innerWidth - 24);
    const above = box.top - 12, below = innerHeight - box.bottom - 12;
    const up = above >= Math.min(popup.current.scrollHeight, 280) || above > below;
    Object.assign(popup.current.style, {
      width: `${width}px`, left: `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`,
      top: up ? 'auto' : `${box.bottom + 8}px`, bottom: up ? `${innerHeight - box.top + 8}px` : 'auto',
      maxHeight: `${Math.max(60, (up ? above : below) - 8)}px`,
    });
  };
  const close = () => { popup.current?.hidePopover(); trigger.current?.focus(); };
  useEffect(() => {
    const element = popup.current;
    const toggle = () => { const visible = element.matches(':popover-open'); setOpen(visible); if (visible) position(); };
    const reposition = event => { if (!element.contains(event.target)) position(); };
    element.addEventListener('toggle', toggle);
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
    return () => { element.removeEventListener('toggle', toggle); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, []);
  return <div className="composer-permissions">
    <button ref={trigger} type="button" className="permission-chip" aria-label={tr("权限模式：{0}", label)} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-disabled={busy}
      onClick={() => { if (busy) return; if (popup.current.matches(':popover-open')) close(); else { popup.current.showPopover(); position(); } }}>
      <ShieldCheck size={14}/><span>{label}</span><ChevronDown size={12}/>
    </button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-label={tr("权限模式")} className="composer-permission-popup"
      onKeyDown={event => { if (event.key === 'Enter' && event.target.matches('input[type=radio]')) { event.preventDefault(); event.target.click(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="permission-popup-heading">{tr("权限模式")}</div>
      {demo ? <p className="permission-popup-note">{tr("仅操作示例目录，不调用付费模型。")}</p> : <>
        <div role="radiogroup" aria-label={tr("项目命令审批")}>
          {[{ value: 'auto', title: tr("项目内自动"), description: tr("项目内命令自动执行，联网时询问。") },
            { value: 'ask', title: tr("逐次询问"), description: tr("每条命令执行前由你批准。") }].map(option =>
            <label className="permission-mode-option" key={option.value}>
              <input type="radio" name={id} value={option.value} checked={mode === option.value} disabled={busy || (!available && option.value === 'auto')}
                onChange={() => { onChange({ mode: option.value }); close(); }}/>
              <span><strong>{option.title}</strong><small>{option.description}</small></span>
            </label>)}
        </div>
        <p className="permission-popup-note">{available ? tr("仅当前项目 · 解除沙箱需单次批准") : tr("当前系统未启用沙箱，命令仍需逐次批准。")}</p>
        <button type="button" className="permission-manage" onClick={() => { close(); onManage(); }}>
          <span>{tr("管理授权")}{permissions?.grants?.length ? ` · ${permissions.grants.length}` : ''}</span><ChevronRight size={14}/>
        </button>
      </>}
    </div>
  </div>;
}
