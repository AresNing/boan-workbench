import {randomUUID} from 'node:crypto';
import {fingerprint,handoff} from './task-lifecycle.mjs';
export function validateReplacement(task,data){
  if(!Number.isInteger(data.expectedVersion)||data.expectedVersion!==task.stateVersion)throw Error('会话替换需要最新任务状态版本');
  if(!['unavailable','context','engine','isolation'].includes(data.replacementCause)||typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>12000)throw Error('会话替换需要有效原因和具体交接说明');
  if(task.decision&&task.decision.kind!=='command')throw Error('先处理当前决定，不能通过替换会话绕过决定或恢复核对');
}

export async function replaceExecutionSession(engine,task,data){
  const id=data.operationId||randomUUID(),digest=fingerprint({taskId:task.id,...data,operationId:undefined});
  const previous=engine.ledger.replay({id,type:'replace_session',taskId:task.id,digest});
  if(previous)return structuredClone(previous.result);
  validateReplacement(task,data);
  if(!engine.backend.replaceSession)throw Error('当前执行引擎不支持显式会话替换');
  if(engine.replacing.has(task.id))throw Error('正在等待旧执行停止并交接');
  const marker={cancelled:false},initialStatus=task.status,version=task.requirementVersion;
  const record=engine.ledger.propose({id,digest,type:'replace_session',taskId:task.id,expectedVersion:data.expectedVersion,requirementVersion:version,replacementCause:data.replacementCause,reason:data.reason});
  engine.ledger.start(record);engine.replacing.set(task.id,marker);
  const superseded=()=>marker.cancelled||engine.closing||task.requirementVersion!==version;
  const finish=status=>engine.ledger.finish(record,status,engine.ledger.receipt(task,{handoffId:record.handoffId}));
  try{
    const scheduling=engine.scheduling?.id===task.id?engine.scheduling:null;
    if(scheduling){scheduling.controller.abort();await scheduling.promise;}
    const active=engine.active?.id===task.id?engine.active:null;
    if(active){
      engine.store.patch(task.id,{status:'stopping',summary:'正在停止当前执行，准备交接。'});
      active.controller.abort();engine.rejectPending(task.id,'执行上下文将替换，旧审批已失效');
      await active.promise;
    }
    if(superseded())return finish('superseded');
    // Old work is actually stopped before recording the handoff and releasing its worker.
    engine.grants.delete(task.id);task.generation++;
    const entry=handoff(task,data.reason);record.handoffId=entry.id;
    if(task.currentSession)task.currentSession.status='replaced';
    engine.store.save();
    await engine.backend.replaceSession(task.id);
    if(superseded())return finish('superseded');
    const status=['queued','running','verifying','stopping','blocked'].includes(initialStatus)?'queued':initialStatus;
    engine.store.patch(task.id,{status,decision:null,...(status==='queued'?{summary:'交接已保存，将核对现有文件并继续。'}:{})});
    engine.store.event(task.id,'handoff','执行上下文已交接',data.reason);
    return finish('completed');
  }catch(e){record.error=e.message;finish('uncertain');if(!['review','done'].includes(task.status))engine.store.patch(task.id,{status:'paused',summary:'交接结果待核对，请检查执行记录后恢复。'});throw e;}
  finally{engine.replacing.delete(task.id);engine.tick();}
}
