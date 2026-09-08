import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Type} from '@sinclair/typebox';
import {scopedPath} from './files.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const stamp=()=>new Date().toISOString();
const statusText={completed:'已完成',failed:'失败',cancelled:'已取消',timed_out:'超时',superseded:'要求已更新'};
const relative=p=>typeof p==='string'&&p.length>0&&p.length<=512&&!path.isAbsolute(p)&&!p.includes('\\')&&!p.includes('\0')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..');
export const auxiliarySchema=Type.Array(Type.Object({
  goal:Type.String({minLength:1,maxLength:4000}),output:Type.String({minLength:1,maxLength:2000}),
  mode:Type.Union(['read_only','isolated_write'].map(v=>Type.Literal(v))),
  readPaths:Type.Array(Type.String(),{maxItems:30}),writePaths:Type.Array(Type.String(),{maxItems:20}),
  budget:Type.Object({maxTurns:Type.Integer({minimum:1,maximum:20}),maxCalls:Type.Integer({minimum:1,maximum:40}),timeoutMs:Type.Integer({minimum:100,maximum:120000}),maxOutputBytes:Type.Integer({minimum:100,maximum:500000})}),
}),{minItems:1,maxItems:3});
export function validateAuxiliary(task,work){
  if(!Array.isArray(work)||!work.length||work.length>3)throw Error('每批辅助工作限一至三项');
  if((task.auxiliary?.length||0)+work.length>6)throw Error('此任务的辅助执行预算已用尽');
  for(const w of work){
    if(!w||!['read_only','isolated_write'].includes(w.mode)||typeof w.goal!=='string'||!w.goal.trim()||w.goal.length>4000||typeof w.output!=='string'||!w.output.trim()||w.output.length>2000)throw Error('辅助工作需要具体目标、产出及模式');
    if(!Array.isArray(w.readPaths)||w.readPaths.length>30||!Array.isArray(w.writePaths)||w.writePaths.length>20||[...w.readPaths,...w.writePaths].some(p=>!relative(p)))throw Error('辅助文件范围必须是明确的项目相对文件路径');
    if(w.mode==='read_only'&&w.writePaths.length||w.mode==='isolated_write'&&!w.writePaths.length)throw Error('辅助写入范围与模式不一致');
    for(const [key,min,max] of [['maxTurns',1,20],['maxCalls',1,40],['timeoutMs',100,120000],['maxOutputBytes',100,500000]])if(!Number.isInteger(w.budget?.[key])||w.budget[key]<min||w.budget[key]>max)throw Error('辅助工作预算无效或超出上限');
  }
}
export function reserveAuxiliary(engine,task,work,operationId){
  validateAuxiliary(task,work);task.auxiliary??=[];
  const records=work.map((w,i)=>({...structuredClone(w),id:`${operationId}:${i}`,taskId:task.id,requirementVersion:task.requirementVersion,status:'queued',at:stamp(),sources:[],changes:[],calls:0}));
  task.auxiliary.push(...records);engine.store.save();return records;
}
function roots(engine){return [engine.config.dataDir,engine.config.appDataDir,engine.config.codexHome,engine.config.claudeHome,engine.config.commandLifecycle?.root];}
async function readSource(engine,name){
  const file=await scopedPath(engine.config.projectPath,name,{protectedRoots:roots(engine)});
  const stat=await fs.stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!stat)return null;if(!stat.isFile()||stat.size>500000)throw Error('辅助输入必须是小于 500 KB 的普通文件');
  return fs.readFile(file);
}
export function cancelAuxiliary(engine,taskId){for(const job of engine.auxiliaryJobs.values())if(job.taskId===taskId)job.controller.abort();}
export async function runAuxiliaryBatch(engine,task,records,signal){
  const outcomes=await Promise.all(records.map(async record=>{
    const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const job={taskId:task.id,controller};engine.auxiliaryJobs.set(record.id,job);
    let timedOut=false,root;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},record.budget.timeoutMs);
    const guard=()=>{if(controller.signal.aborted||task.requirementVersion!==record.requirementVersion)throw Error('辅助执行已停止或要求已变化');};
    try{
      guard();record.status='running';engine.store.event(task.id,'auxiliary','正在执行辅助工作',`${record.goal}\n${record.mode==='read_only'?'只读调查':'隔离副本修改'}\n读取：${record.readPaths.join('、')||'无'}\n可修改：${record.writePaths.join('、')||'无'}\n预期产出：${record.output}\n预算：${record.budget.maxTurns} 轮、${record.budget.maxCalls} 次工具调用、${record.budget.timeoutMs/1000} 秒、${record.budget.maxOutputBytes} 字节输出`);
      root=await fs.mkdtemp(path.join(engine.config.dataDir,'auxiliary-'));record.workspaceDir=path.basename(root);engine.store.save();await fs.chmod(root,0o700);
      let total=0;
      for(const name of new Set([...record.readPaths,...record.writePaths])){
        guard();const content=await readSource(engine,name);if(content===null&&record.readPaths.includes(name))throw Error(`辅助输入文件不存在：${name}`);
        if(content){total+=content.length;if(total>2000000)throw Error('辅助输入总量超过 2 MB');const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content,{mode:0o600});}
        record.sources.push({path:name,hash:content===null?null:hash(content)});
      }
      engine.store.save();const changed=new Map();
      const call=async(name,params)=>{
        guard();if(++record.calls>record.budget.maxCalls){controller.abort();throw Error('辅助工具调用预算已用尽');}engine.store.save();
        if(name==='read_file'){
          if(!record.readPaths.includes(params.path)&&!record.writePaths.includes(params.path))throw Error('文件不在辅助读取范围内');
          const value=await fs.readFile(path.join(root,params.path),'utf8');guard();return value;
        }
        if(name==='write_file'){
          if(record.mode!=='isolated_write'||!record.writePaths.includes(params.path))throw Error('文件不在辅助写入范围内');
          if(typeof params.content!=='string')throw Error('辅助文件内容无效');
          const next=new Map(changed);next.set(params.path,params.content);
          if([...next.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)>record.budget.maxOutputBytes)throw Error('辅助输出超过预算');
          const file=path.join(root,params.path);await fs.mkdir(path.dirname(file),{recursive:true});guard();await fs.writeFile(file,params.content,{mode:0o600,signal:controller.signal});guard();changed.set(params.path,params.content);return '已保存在隔离副本，尚未修改项目';
        }
        if(name==='submit_auxiliary'){
          if(typeof params.summary!=='string'||!params.summary.trim()||Buffer.byteLength(params.summary)+[...changed.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)>record.budget.maxOutputBytes)throw Error('辅助总结为空或输出超过预算');
          return params.summary;
        }
        throw Error('辅助执行不能调用此工具');
      };
      const result=await engine.backend.auxiliary(structuredClone(task),structuredClone(record),{root,signal:controller.signal,call,guard,session:id=>{guard();record.sessionId=id;engine.store.save();}});
      guard();if(typeof result!=='string'||!result.trim())throw Error('辅助执行未提交结果');
      // Adapters cannot bypass the same output limit as their submit tool.
      if(Buffer.byteLength(result)+[...changed.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)>record.budget.maxOutputBytes)throw Error('辅助输出超过预算');
      record.summary=result;record.changes=[...changed].map(([file,content])=>({path:file,content,baseHash:record.sources.find(s=>s.path===file).hash}));record.status='completed';
    }catch(e){record.status=task.requirementVersion!==record.requirementVersion?'superseded':timedOut?'timed_out':controller.signal.aborted?'cancelled':'failed';record.error=e.message;record.changes=[];}
    finally{controller.abort();clearTimeout(timer);signal.removeEventListener('abort',abort);engine.auxiliaryJobs.delete(record.id);if(root)await fs.rm(root,{recursive:true,force:true});delete record.workspaceDir;record.finishedAt=stamp();engine.store.event(task.id,'auxiliary',record.status==='completed'?'辅助结果已准备好，等待主执行者整合':'辅助执行已结束',`${record.goal} · ${statusText[record.status]||record.status}\n${record.summary||record.error||''}\n来源：${record.sources.map(s=>`${s.path} (${s.hash?.slice(0,12)||'新文件'})`).join('、')}\n修改副本：${record.changes.map(c=>c.path).join('、')||'无'}\n辅助结果未经独立验证；${record.calls} 次工具调用。`);}
    return {id:record.id,goal:record.goal,status:record.status,summary:record.summary,error:record.error,sources:record.sources,changes:record.changes.map(c=>c.path),verified:false};
  }));
  if(signal.aborted||records.some(r=>r.requirementVersion!==task.requirementVersion))throw Object.assign(Error('辅助安排已中止或过期'),{code:'STALE_MANAGEMENT'});
  return outcomes;
}
export function auxiliaryResult(task,id,generation){
  const record=task.auxiliary?.find(r=>r.id===id&&r.requirementVersion===task.requirementVersion);
  if(!record||['queued','running','superseded'].includes(record.status))throw Error('没有对应最新要求的辅助结果');
  record.readBy={generation,version:task.requirementVersion};return {...structuredClone(record),verified:false};
}
export function assertAuxiliaryIntegrated(task){
  if(task.auxiliary?.some(r=>r.requirementVersion===task.requirementVersion&&r.status!=='superseded'&&!r.integration))throw Error('请读取并整合辅助结果，或说明不采用原因，再提交主任务成果');
}
export async function integrateAuxiliary(engine,task,id,decision,reason,generation,guard,signal){
  guard();const record=task.auxiliary?.find(r=>r.id===id&&r.requirementVersion===task.requirementVersion);
  if(!record||record.readBy?.generation!==generation||record.readBy?.version!==task.requirementVersion)throw Error('先读取当前辅助结果再决定如何整合');
  if(record.integration)throw Error('辅助结果已处理，不能重复整合');
  if(!['adopt','reviewed','discard'].includes(decision)||typeof reason!=='string'||!reason.trim()||reason.length>4000)throw Error('请说明辅助结果的整合决定与原因');
  if(decision==='adopt'&&(record.status!=='completed'||record.mode!=='isolated_write'))throw Error('仅可采用已完成的隔离修改');
  if(decision==='reviewed'&&record.changes.length)throw Error('隔离修改需要明确采用或放弃');
  if(decision==='adopt'){
    const expected=new Map(record.sources.map(s=>[s.path,s.hash]));
    const checkSources=async()=>{for(const [name,digest] of expected){const content=await readSource(engine,name);if((content===null?null:hash(content))!==digest)throw Error(`项目文件已变化，不能采用旧副本结果：${name}`);}};
    await checkSources();
    for(const change of record.changes){
      guard();if(signal.aborted)throw Error('整合已停止');
      const file=await scopedPath(engine.config.projectPath,change.path,{write:true,protectedRoots:roots(engine)});
      await checkSources();
      await fs.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.boan-${randomUUID()}.tmp`,mode=await fs.stat(file).then(s=>s.mode&0o777).catch(()=>0o644);
      try{await fs.writeFile(temp,change.content,{flag:'wx',mode,signal});await checkSources();guard();if(signal.aborted)throw Error('整合已停止');await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
      expected.set(change.path,hash(change.content));
      if(!task.artifacts.includes(change.path))task.artifacts.push(change.path);record.appliedPaths??=[];record.appliedPaths.push(change.path);engine.store.save();
    }
  }
  record.integration={decision,reason,generation,version:task.requirementVersion,at:stamp()};engine.store.event(task.id,'auxiliary','主执行者已处理辅助结果',`${record.goal} · ${decision} · ${reason}`);return '整合决定已保存，主任务仍需独立验证';
}
