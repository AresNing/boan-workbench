import { t as tr, localeTag, systemText } from './i18n.mjs';
import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import './select.css';

export function Select({ label, value, onChange, options, disabled = false, compact = false }) {
  const id = useId(), trigger = useRef(null), menu = useRef(null), search = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  const position = () => {
    const button = trigger.current, popup = menu.current;
    if (!button || !popup?.matches(':popover-open')) return;
    const box = button.getBoundingClientRect(), width = Math.min(Math.max(box.width, compact ? 280 : 260), innerWidth - 24);
    const below = innerHeight - box.bottom - 16, above = box.top - 16;
    const up = compact ? above > 130 : below < Math.min(popup.scrollHeight, 240) && above > below;
    const height = Math.max(60, Math.min(320, up ? above : below));
    Object.assign(popup.style, { width: `${width}px`, maxHeight: `${height}px`, left: `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`, top: 'auto', bottom: 'auto' });
    if (up) popup.style.bottom = `${innerHeight - box.top + 6}px`; else popup.style.top = `${box.bottom + 6}px`;
  };
  const close = () => menu.current?.hidePopover();
  const show = index => {
    if (disabled || !options.length) return;
    setActive(index); menu.current.showPopover(); position();
  };
  const choose = index => { const option = options[index]; if (!option || disabled) return; onChange(option.value); close(); trigger.current.focus(); };
  useEffect(() => {
    const popup = menu.current;
    const toggle = () => { const visible = popup.matches(':popover-open'); setOpen(visible); if (visible) position(); };
    popup.addEventListener('toggle', toggle);
    const reposition = event => { if (!popup.contains(event.target)) position(); };
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
    return () => { popup.removeEventListener('toggle', toggle); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [compact]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => { if (open) menu.current.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  function keyboard(event) {
    const visible = menu.current.matches(':popover-open');
    if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    let next;
    if (event.key === 'ArrowDown') next = visible ? (active + 1) % options.length : Math.max(0, selected);
    if (event.key === 'ArrowUp') next = visible ? (active - 1 + options.length) % options.length : Math.max(0, selected);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (next !== undefined) { event.preventDefault(); visible ? setActive(next) : show(next); return; }
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); visible ? choose(active) : show(Math.max(0, selected)); return; }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      search.current.text = Date.now() - search.current.at < 700 ? search.current.text + event.key : event.key;
      search.current.at = Date.now();
      const index = options.findIndex(o => systemText(o.label).toLowerCase().startsWith(search.current.text.toLowerCase()));
      if (index >= 0) { event.preventDefault(); visible ? setActive(index) : show(index); }
    }
  }
  return <div className={`boan-select ${compact ? 'compact' : ''}`}>
    <button ref={trigger} type="button" className="boan-select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" aria-activedescendant={open ? `${id}-${active}` : undefined} disabled={disabled} onKeyDown={keyboard} onClick={() => menu.current.matches(':popover-open') ? close() : show(Math.max(0, selected))}>
      <span>{systemText(options[selected]?.label) || tr("请选择")}</span><ChevronDown size={compact ? 13 : 15}/>
    </button>
    <div ref={menu} id={id} popover="auto" className="boan-select-menu" role="listbox" aria-label={label}>
      {options.map((option, index) => <div id={`${id}-${index}`} key={option.value} role="option" aria-selected={option.value === value} className={`boan-select-option ${index === active ? 'active' : ''}`} data-index={index} onPointerMove={() => setActive(index)} onMouseDown={e => e.preventDefault()} onClick={() => choose(index)}>
        <span>{systemText(option.label)}</span><span className="boan-select-check">{option.value === value && <Check size={14}/>}</span>
      </div>)}
    </div>
  </div>;
}
