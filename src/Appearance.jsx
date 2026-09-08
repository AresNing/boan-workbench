import { t as tr, localeTag } from './i18n.mjs';
import React, {useEffect, useLayoutEffect, useState} from 'react';
import {Sun, Moon, Monitor} from 'lucide-react';
import {Select} from './Select.jsx';

export function Appearance() {
  const [appearance,setAppearance]=useState(()=>{try {const value=localStorage.getItem('workbench:appearance');return ['light','dark','system'].includes(value)?value:'system';}catch{return 'system';}});
  useEffect(()=>{const changed=e=>{const value=e.type==='storage'?localStorage.getItem('workbench:appearance'):e.detail;if(['light','dark','system'].includes(value))setAppearance(value);};window.addEventListener('workbench:appearance',changed);window.addEventListener('storage',changed);return()=>{window.removeEventListener('workbench:appearance',changed);window.removeEventListener('storage',changed);};},[]);
  useLayoutEffect(()=>{
    const media=window.matchMedia('(prefers-color-scheme: dark)');
    let firstFrame,secondFrame;
    const update=()=>{const root=document.documentElement;root.classList.add('theme-switching');root.dataset.theme=appearance==='system'?(media.matches?'dark':'light'):appearance;cancelAnimationFrame(firstFrame);cancelAnimationFrame(secondFrame);firstFrame=requestAnimationFrame(()=>{secondFrame=requestAnimationFrame(()=>root.classList.remove('theme-switching'));});};
    update();media.addEventListener('change',update);
    try{localStorage.setItem('workbench:appearance',appearance);}catch{}
    return ()=>{media.removeEventListener('change',update);cancelAnimationFrame(firstFrame);cancelAnimationFrame(secondFrame);document.documentElement.classList.remove('theme-switching');};
  },[appearance]);
  const Icon=appearance==='system'?Monitor:appearance==='dark'?Moon:Sun;
  return <div className="appearance-control"><Icon size={15}/><Select label={tr("外观")} compact value={appearance} onChange={value=>{setAppearance(value);window.dispatchEvent(new CustomEvent('workbench:appearance',{detail:value}));}} options={[{value:'system',label:tr("跟随系统")},{value:'light',label:tr("浅色外观")},{value:'dark',label:tr("深色外观")}]}/></div>;
}
