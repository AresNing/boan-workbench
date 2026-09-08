import React, { useRef } from 'react';
export function ResizeHandle({ label, value, min, max, reverse = false, onChange }) {
  const drag = useRef(null);
  const change = next => onChange(Math.round(Math.max(min, Math.min(max, next))));
  return <div className="panel-resize" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    onPointerDown={e => { if(e.button!==0)return;drag.current={x:e.clientX,value};e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={e => { if(drag.current)change(drag.current.value+(e.clientX-drag.current.x)*(reverse?-1:1)); }}
    onPointerUp={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
    onKeyDown={e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();change(value+(e.key==='ArrowRight'?16:-16)*(reverse?-1:1));}}}/>
}
