import english from './en.json' with { type: 'json' };
export const languages = ['zh', 'en', 'system'];
export function resolveLanguage(preference, system = 'zh-CN') {
  return preference === 'system' ? (/^zh\b/i.test(system) ? 'zh' : 'en') : preference === 'en' ? 'en' : 'zh';
}
export function translate(language, key, ...values) {
  if (typeof key !== 'string') return key;
  const text = language === 'en' ? english[key] ?? key : key;
  return values.length ? text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match) : text;
}
// Only call for application-owned messages. User-authored text is never passed here.
const patterns = Object.entries(english).filter(([key])=>/\{\d+\}/.test(key)).map(([key,value])=>{
  const slots=[];let at=0,source='^';for(const m of key.matchAll(/\{(\d+)\}/g)){source+=key.slice(at,m.index).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(.*?)';slots.push(Number(m[1]));at=m.index+m[0].length;}
  source+=key.slice(at).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';return {regex:new RegExp(source,'s'),slots,value};
});
export function translateSystem(language, text) {
  if(language !== 'en' || typeof text !== 'string')return text;
  if(Object.hasOwn(english,text))return english[text];
  for(const {regex,slots,value} of patterns){const match=text.match(regex);if(match){const values=[];slots.forEach((slot,i)=>values[slot]=match[i+1]);return value.replace(/\{(\d+)\}/g,(m,i)=>values[i]??m);}}
  return text;
}
