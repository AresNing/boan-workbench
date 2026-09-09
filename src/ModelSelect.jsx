import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { t as tr } from './i18n.mjs';
import './select.css';

export function ModelSelect({ label, provider, value, onChange, multiple = false, disabled = false }) {
  const id = useId(), trigger = useRef(null), popup = useRef(null), input = useRef(null);
  const [catalog, setCatalog] = useState({ provider, models: [] }), [query, setQuery] = useState('');
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [error, setError] = useState('');
  const selected = multiple ? value : value ? [value] : [];
  useEffect(() => {
    let disposed = false;setError('');
    Promise.resolve(window.desktop?.getModelCatalog?.(provider) || []).then(models => {
      if (!disposed) setCatalog({ provider, models });
    }).catch(() => { if (!disposed) setError(tr('模型列表加载失败')); });
    return () => { disposed = true; };
  }, [provider]);
  const models = new Map((catalog.provider === provider ? catalog.models : []).map(m => [m.id, m]));
  for (const value of selected) if (!models.has(value)) models.set(value, { id: value, name: value });
  const filtered = [...models.values()].filter(m => `${m.id} ${m.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  // Compatible endpoints may expose private model IDs absent from the local catalog.
  const custom = provider === 'custom' && /^[^\s,]{1,160}$/.test(query.trim()) && !models.has(query.trim());
  if (custom) filtered.push({ id: query.trim(), name: tr('使用此模型 ID') });
  const position = () => {
    if (!popup.current?.matches(':popover-open')) return;
    const box = trigger.current.getBoundingClientRect(), width = Math.min(Math.max(box.width, 300), innerWidth - 24);
    const below = innerHeight - box.bottom - 16, above = box.top - 16, up = below < 250 && above > below;
    Object.assign(popup.current.style, { width: `${width}px`, maxHeight: `${Math.max(100, Math.min(360, up ? above : below))}px`, left: `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`, top: up ? 'auto' : `${box.bottom + 6}px`, bottom: up ? `${innerHeight - box.top + 6}px` : 'auto' });
  };
  const close = () => popup.current?.hidePopover();
  const show = () => { if (disabled) return;setQuery('');setActive(0);popup.current.showPopover();position();input.current.focus(); };
  const choose = model => {
    if (!model || disabled) return;
    if (multiple) onChange(selected.includes(model.id) ? selected.filter(v => v !== model.id) : [...selected, model.id]);
    else { onChange(model.id);close();trigger.current.focus(); }
  };
  useEffect(() => {
    const node = popup.current;
    const toggle = () => { setOpen(node.matches(':popover-open'));position(); };
    const reposition = event => { if (!node.contains(event.target)) position(); };
    node.addEventListener('toggle', toggle);window.addEventListener('resize', reposition);window.addEventListener('scroll', reposition, true);
    return () => { node.removeEventListener('toggle', toggle);window.removeEventListener('resize', reposition);window.removeEventListener('scroll', reposition, true); };
  }, []);
  useEffect(() => { close(); }, [provider, disabled]);
  useEffect(() => { if (open) popup.current.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  function keyboard(e) {
    if (e.key === 'Escape') { e.preventDefault();e.stopPropagation();close();trigger.current.focus(); }
    if (e.key === 'Tab') close();
    if (e.key === 'Enter') { e.preventDefault();e.stopPropagation();choose(filtered[active]); }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault();e.stopPropagation();setActive(i => filtered.length ? (i + (e.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length : 0); }
  }
  return <div className="boan-select">
    <button ref={trigger} type="button" className="boan-select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" disabled={disabled} onClick={() => open ? close() : show()} onKeyDown={e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault();show(); } }}>
      <span>{selected.length ? selected.join(' · ') : tr('选择模型')}</span><ChevronDown size={15}/>
    </button>
    <div ref={popup} popover="auto" className="boan-select-menu model-select-menu" onKeyDown={keyboard}>
      <input ref={input} className="model-select-search" aria-label={tr('搜索模型')} placeholder={tr('搜索模型')} value={query} aria-controls={id} aria-activedescendant={filtered[active] ? `${id}-${active}` : undefined} onChange={e => { setQuery(e.target.value);setActive(0); }}/>
      <div id={id} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="model-select-options">
        {filtered.map((model, index) => <div key={model.id} id={`${id}-${index}`} role="option" aria-selected={selected.includes(model.id)} data-index={index} className={`boan-select-option ${index === active ? 'active' : ''}`} onPointerMove={() => setActive(index)} onMouseDown={e => e.preventDefault()} onClick={() => choose(model)}>
          <span>{model.id}<small>{model.name !== model.id ? model.name : ''}</small></span><span className="boan-select-check">{selected.includes(model.id) && <Check size={14}/>}</span>
        </div>)}
        {!filtered.length && <p className="model-select-empty">{error || tr('没有匹配的模型')}</p>}
      </div>
      {multiple && <button type="button" className="button secondary" onClick={() => { close();trigger.current.focus(); }}>{tr('完成选择')}</button>}
    </div>
  </div>;
}
