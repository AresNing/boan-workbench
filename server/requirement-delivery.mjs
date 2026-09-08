import {randomUUID} from 'node:crypto';
import {fingerprint} from './task-lifecycle.mjs';

const now=()=>new Date().toISOString();
export function validateDelivery(task,data) {
  if(!Number.isInteger(data.expectedVersion)||data.expectedVersion!==task.stateVersion)throw Error('投递要求需要最新任务状态版本');
  const update=task.updates.find(u=>u.id===data.updateId);
  if(!update||update.version!==task.requirementVersion)throw Error('只能投递已保存的最新要求');
  return update;
}

// A transport acknowledgement is not evidence that the executor understood the update.
// Only read_requirements + acknowledge_requirements can advance it to received.
export async function deliverRequirements(engine,task,data) {
  const id=data.operationId||randomUUID(), digest=fingerprint({taskId:task.id,...data,operationId:undefined});
  const previous=engine.ledger.replay({id,type:'deliver_update',taskId:task.id,digest});
  if(previous)return structuredClone(previous.result);
  const update=validateDelivery(task,data),active=engine.active?.id===task.id?engine.active:null;
  const key=`${task.id}:${update.id}`;
  if(engine.delivering.has(key))throw Error('这条要求正在投递，请等待实际回执');
  const record=engine.ledger.propose({id,digest,type:'deliver_update',taskId:task.id,expectedVersion:data.expectedVersion,requirementVersion:update.version,updateId:update.id});
  engine.ledger.start(record);
  const complete=()=>{
    engine.ledger.finish(record,'completed',engine.ledger.receipt(task,{updateId:update.id,status:update.status}));
    engine.store.event(task.id,'requirements',update.status==='received'?'执行者已接收要求':update.status==='delivered'?'要求已投递，等待接收':'要求已保存，等待执行者读取',`v${update.version} · ${id}`);
    return structuredClone(record.result);
  };
  if(update.status!=='saved'||!active||active.controller.signal.aborted||['paused','stopping'].includes(task.status)||!engine.backend.steer)return complete();
  const generation=task.generation,sessionId=task.currentSession?.id,signal=active.controller.signal;
  let timer,abort;
  engine.delivering.add(key);
  try {
    const interrupted=new Promise((_,reject)=>{
      abort=()=>reject(Object.assign(Error('执行已停止，投递结果待核对'),{code:'DELIVERY_INTERRUPTED'}));
      signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>reject(Error('要求投递超时，结果待核对')),engine.config.updateDeliveryTimeoutMs||15000);
    });
    const sent=await Promise.race([Promise.resolve().then(()=>{
      if(signal.aborted)throw Error('执行已停止，未发起投递');
      return engine.backend.steer(task.id,JSON.stringify({update:structuredClone(update),instruction:'调用 read_requirements 读取最新要求，再 acknowledge_requirements 确认版本；旧版本不能继续写入或交付。'}));
    }),interrupted]);
    if(signal.aborted||engine.active!==active||task.generation!==generation||task.currentSession?.id!==sessionId||task.requirementVersion!==update.version){
      return engine.ledger.finish(record,'superseded',engine.ledger.receipt(task,{status:'superseded',updateId:update.id}));
    }
    if(sent&&update.status==='saved'){update.status='delivered';update.deliveredAt=now();update.sessionId=sessionId;}
    return complete();
  }catch(e){
    // Timeout/interruption does not prove that a transport message was never sent.
    // A later executor acknowledgement remains authoritative, but we never retry here.
    engine.ledger.finish(record,'uncertain',engine.ledger.receipt(task,{updateId:update.id}),e);throw e;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);engine.delivering.delete(key);}
}
