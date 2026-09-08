import { t as tr, localeTag } from './i18n.mjs';
import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Settings2 } from 'lucide-react';
import './model-picker.css';
import { Select } from './Select.jsx';

export function ModelPicker({ options = [], value, disabled, onChange, onConfigure, onRefresh }) {
  const id = useId(), button = useRef(null), popup = useRef(null), search = useRef(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const parameterButton=useRef(null),parameterPopup=useRef(null);
  const openParameters=()=>{const element=parameterPopup.current;if(element.matches(':popover-open')){element.hidePopover();return;}element.showPopover();const box=parameterButton.current.getBoundingClientRect();Object.assign(element.style,{left:`${Math.max(12,Math.min(box.right-300,innerWidth-312))}px`,bottom:`${innerHeight-box.top+8}px`,maxHeight:`${Math.max(100,box.top-24)}px`});};
  const selected = options.find(o => o.profileId === value?.profileId && o.model === value?.model);
  const label = selected?.label || value?.label || value?.model || tr("选择模型");
  const effortNames = { minimal: tr("最低"), low: tr("低"), medium: tr("中"), high: tr("高"), xhigh: tr("很高"), max: tr("最高"), ultra: tr("极高"), none: tr("关闭") };
  const effortOptions = [{value:'',label:tr("默认思考")}, ...(selected?.efforts || []).map(e => ({value:e,label:effortNames[e] || e}))];
  const speedOptions = selected?.speeds?.length ? selected.speeds : [{value:'standard',label:tr("标准")}];
  useEffect(() => { onRefresh?.(); }, []);
  const groups = Map.groupBy(options.filter(o => `${o.label} ${o.model} ${o.provider}`.toLowerCase().includes(query.toLowerCase())), o => o.provider);
  const close = () => { popup.current.hidePopover(); button.current.focus(); };
  const position = () => {
    if (!popup.current.matches(':popover-open')) return;
    const box = button.current.getBoundingClientRect(), width = Math.min(340, innerWidth - 24);
    const up = box.top > innerHeight - box.bottom;
    Object.assign(popup.current.style, { width: `${width}px`, left: `${Math.max(12, Math.min(box.right - width, innerWidth - width - 12))}px`, top: up ? 'auto' : `${box.bottom+8}px`, bottom: up ? `${innerHeight-box.top+8}px` : 'auto', maxHeight: `${Math.min(440, (up ? box.top : innerHeight-box.bottom)-20)}px` });
  };
  useEffect(() => {
    const element = popup.current;
    const toggle = () => { const visible = element.matches(':popover-open'); setOpen(visible); if (visible) { position(); search.current.focus(); } };
    element.addEventListener('toggle', toggle); window.addEventListener('resize', position);
    return () => { element.removeEventListener('toggle', toggle); window.removeEventListener('resize', position); };
  }, []);
  return <div className="model-controls"><div className="model-picker">
    <button ref={button} type="button" className="model-picker-trigger" aria-label={tr("任务模型：{0}", label)} aria-haspopup="dialog" aria-controls={id} aria-expanded={open} disabled={disabled}
      onClick={() => { if (popup.current.matches(':popover-open')) close(); else { setQuery(''); popup.current.showPopover(); position(); onRefresh?.(); } }}>
      <span>{label}</span><ChevronDown size={13}/>
    </button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-label={tr("选择任务模型")} className="model-picker-popup" onKeyDown={e => { if(e.key==='Escape'){ e.preventDefault();e.stopPropagation();close(); } if(e.key==='Enter' && e.target===search.current)e.preventDefault(); }}>
      <label className="model-search"><Search size={15}/><input ref={search} aria-label={tr("搜索模型或厂商")} placeholder={tr("搜索模型或厂商")} value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <div className="model-picker-list">
        {[...groups].map(([provider, models]) => <section key={provider}><h4>{provider}</h4>{models.map(option => <button type="button" key={`${option.profileId}:${option.model}`} className="model-picker-option" disabled={!option.available} aria-pressed={selected?.profileId===option.profileId&&selected?.model===option.model}
          onClick={()=>{onChange({profileId:option.profileId,model:option.model,label:option.label,provider:option.provider,connection:option.connection});close();}}>
          <span>{option.label}<small>{option.available ? option.label!==option.model ? option.model : '' : tr("需要配置或登录")}</small></span>{selected?.profileId===option.profileId&&selected?.model===option.model&&<Check size={14}/>}</button>)}</section>)}
        {!groups.size&&<p className="model-picker-empty">{tr("没有匹配的模型")}</p>}
      </div>
      <button type="button" className="model-configure" onClick={()=>{close();onConfigure();}}><Settings2 size={14}/>{tr("管理模型服务")}</button>
    </div>
  </div>
    {(effortOptions.length>1 || speedOptions.length>1) && <div className="model-parameters"><button type="button" ref={parameterButton} className="parameter-trigger" disabled={disabled} aria-label={tr("任务参数")} aria-haspopup="dialog" onClick={openParameters}>{tr("思考：")}{effortNames[value?.effort] || tr("默认")}{tr(" · 速度：")}{speedOptions.find(o=>o.value===(value?.speed||'standard'))?.label || tr("标准")}<ChevronDown size={12}/></button>
      <div ref={parameterPopup} popover="auto" className="parameter-popup" role="dialog" aria-label={tr("任务参数")} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();parameterPopup.current.hidePopover();parameterButton.current.focus();}}}>
        <h4>{tr("任务参数")}</h4>
        {effortOptions.length>1 && <div className="parameter-field">{tr("思考强度")}<Select label={tr("思考强度（effort）")} value={value?.effort || ''} options={effortOptions} disabled={disabled} onChange={effort => onChange({...value,effort})}/></div>}
        {speedOptions.length>1 && <div className="parameter-field">{tr("速度")}<Select label={tr("速度（speed）")} value={value?.speed || 'standard'} options={speedOptions} disabled={disabled} onChange={speed => onChange({...value,speed})}/></div>}
        <p>{tr("仅用于本次提交。快速模式可能增加额度或费用。")}</p>
      </div>
    </div>}

  </div>;
}
