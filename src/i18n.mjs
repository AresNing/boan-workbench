import { translate, translateSystem, resolveLanguage, languages } from '../shared/i18n.mjs';
let preference='zh';try { const saved=globalThis.localStorage?.getItem('workbench:language');if(languages.includes(saved))preference=saved; } catch {}
const subscribers=new Set();
export const languagePreference=()=>preference;
export const currentLanguage=()=>resolveLanguage(preference,globalThis.navigator?.language);
export const languageSnapshot=()=>`${preference}:${currentLanguage()}`;
export const localeTag=()=>currentLanguage()==='en'?'en-US':'zh-CN';
export const t=(key,...values)=>translate(currentLanguage(),key,...values);
export const systemText=text=>translateSystem(currentLanguage(),text);
export const subscribeLanguage=listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);};
export function setLanguage(value) {
  if(!languages.includes(value))throw Error('Invalid language');
  preference=value;try{globalThis.localStorage?.setItem('workbench:language',value);}catch{}
  if(globalThis.document){document.documentElement.lang=localeTag();document.title=t('Boan · Agent 工作台');}
  for(const listener of subscribers)listener();
}
if(globalThis.window)window.addEventListener('languagechange',()=>setLanguage(preference));
