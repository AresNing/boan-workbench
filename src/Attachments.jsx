import { t as tr, localeTag } from './i18n.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, Folder, X } from 'lucide-react';
import { Select } from './Select.jsx';
const load = key => { try { return JSON.parse(localStorage.getItem(key)||'[]'); } catch { return []; } };
export function useAttachments(key, api, onError) {
  const importing=useRef(false);
  const [record,setRecord]=useState(()=>({key,items:load(key)})),[uploading,setUploading]=useState(false);
  const items=record.key===key?record.items:load(key),current=useRef(key);current.current=key;
  useEffect(()=>{setRecord({key,items:load(key)});},[key]);
  const write=(target,items)=>{localStorage.setItem(target,JSON.stringify(items));if(current.current===target)setRecord({key:target,items});};
  const add=async files=>{
    if(importing.current)return;const target=key;importing.current=true;setUploading(true);
    try {
      if(load(target).length+files.length>8)throw Error(tr("每次最多附带 8 个文件"));
      for(const file of files){
        if(file.size>8_000_000)throw Error(tr("{0} 超过 8 MB", file.name));
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error(tr("文件无法读取")));reader.readAsDataURL(file);});
        const item=await api('/api/attachments',{name:file.name,base64});write(target,[...load(target),item]);
      }
    }catch(e){onError(e.message);}finally{importing.current=false;setUploading(false);}
  };
  return {items,uploading,add,remove:path=>write(key,items.filter(i=>i.path!==path)),clear:()=>write(key,[]),reference:path=>{if(items.length>=8){onError(tr("每次最多附带 8 个文件"));return;}if(!items.some(i=>i.path===path))write(key,[...items,{path,name:path.split('/').at(-1)}]);},
    onPaste:e=>{const files=[...e.clipboardData.files];if(files.length){e.preventDefault();void add(files);}},onDrop:e=>{e.preventDefault();void add([...e.dataTransfer.files]);}};
}
export function Attachments({value,api,disabled,onError}) {
  const input=useRef(null),[files,setFiles]=useState(null);
  return <div className="attachments">
    {value.items.length>0&&<div className="attachment-list" aria-label={tr("本次附带文件")}>{value.items.map(file=><span key={file.path} title={file.path}><Paperclip size={13}/><span>{file.name}</span><button type="button" disabled={disabled} aria-label={tr("移除附件 {0}", file.name)} onClick={()=>value.remove(file.path)}><X size={13}/></button></span>)}</div>}
    <div className="attachment-tools"><input type="file" ref={input} hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.rs,.html,.css,.svg,.diff,.patch" onChange={e=>{void value.add([...e.target.files]);e.target.value='';}}/>
      <button type="button" disabled={disabled||value.uploading} onClick={()=>input.current.click()} title={tr("添加图片或文本文件，也可拖入或粘贴截图")}><Paperclip size={14}/>{tr("添加文件")}</button>
      <button type="button" disabled={disabled||value.uploading} onClick={()=>api('/api/files').then(result=>setFiles(result.files)).catch(e=>onError(e.message))}><Folder size={14}/>{tr("引用项目文件")}</button>
      {value.uploading&&<span role="status">{tr("正在导入文件…")}</span>}
      {files&&<Select label={tr("选择项目文件")} value="" options={[{value:'',label:tr("选择项目文件")},...files.map(path=>({value:path,label:path}))]} onChange={path=>{if(path)value.reference(path);setFiles(null);}}/>}
    </div>
  </div>;
}
