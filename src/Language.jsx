import React,{useState,useSyncExternalStore} from 'react';
import {Select} from './Select.jsx';
import { t as tr,setLanguage,subscribeLanguage,languagePreference} from './i18n.mjs';
export function Language(){
 const value=useSyncExternalStore(subscribeLanguage,languagePreference),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function change(language){setBusy(true);setError('');try{if(window.desktop?.savePreferences)await window.desktop.savePreferences({language});setLanguage(language);}catch{setError(tr('语言设置未能保存，请重试。'));}finally{setBusy(false);}}
 return <div className="settings-field">{tr('语言')}<Select label={tr('语言')} value={value} disabled={busy} onChange={change} options={[{value:'zh',label:'简体中文'},{value:'en',label:'English'},{value:'system',label:tr('跟随系统')}]}/>{error&&<p role="alert">{error}</p>}</div>;
}
