const now=()=>new Date().toISOString();
export const operationType=type=>({create:'create_task',amend:'revise_task',pause:'pause_task',resume:'resume_task'}[type]||type);
const own=(object,key)=>Object.hasOwn(object,key)?object[key]:undefined;

// All management effects share one durable identity namespace. Legacy actions are
// only an alias for old readers; they must never be an independent replay source.
export function restoreOperations(data){
  data.management??={events:[],operations:{}};
  data.actions??={};
  const operations=data.management.operations;
  for(const [id,old] of Object.entries(data.actions)){
    const existing=own(operations,id);
    if(!existing){
      operations[id]={...old,id,type:operationType(old.type),taskId:old.taskId||old.id,
        target:old.type==='create'?{kind:'project',id:data.project.path}:{kind:'task',id:old.taskId||old.id},
        expectedVersion:old.expectedVersion??null,legacy:true};
    }else if(existing.digest!==old.digest||operationType(existing.type)!==operationType(old.type)){
      existing.status='uncertain';existing.identityConflict=true;
    }
    data.actions[id]=operations[id];
  }
  for(const record of Object.values(operations)){
    record.type=operationType(record.type);
    record.target??={kind:'task',id:record.taskId};
    if(['pending','proposed','applying'].includes(record.status))record.status='uncertain';
  }
}

export class OperationLedger {
  constructor(store){this.store=store;}
  replay({id,type,taskId,digest}){
    const record=own(this.store.data.management.operations,id);
    if(!record)return null;
    if(record.identityConflict||record.digest!==digest||record.type!==operationType(type)||record.taskId!==taskId)throw Error('操作标识冲突');
    if(record.status!=='completed')throw Error('上次操作仍在进行或结果待核对，不能重复执行或发送');
    return record;
  }
  propose(input,{legacy=false}={}){
    if(typeof input.id!=='string'||!input.id||input.id.length>250||['__proto__','constructor','prototype'].includes(input.id))throw Error('操作标识无效');
    if(own(this.store.data.management.operations,input.id))throw Error('操作标识已存在，不能重复提出');
    if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)throw Error('操作需要有效的预期状态版本');
    const target=input.target||{kind:'task',id:input.taskId};
    if(!['task','project'].includes(target.kind)||typeof target.id!=='string'||!target.id)throw Error('操作目标无效');
    const record={...structuredClone(input),type:operationType(input.type),target,status:'proposed',at:now()};
    this.store.data.management.operations[record.id]=record;
    if(legacy)this.store.data.actions[record.id]=record;
    this.store.save();return record;
  }
  start(record,validate=()=>{}){
    if(record.status!=='proposed')throw Error('操作已经执行，不能重复应用');
    try{
      const version=record.target.kind==='project'?this.store.data.projectVersion:this.store.task(record.target.id).stateVersion;
      if(version!==record.expectedVersion)throw Object.assign(Error('任务或项目状态已变化，安排已过期，请按最新状态重新安排'),{code:'STALE_MANAGEMENT'});
      validate();
    }catch(e){
      const task=this.store.data.tasks.find(t=>t.id===record.taskId);
      this.finish(record,e.code==='STALE_MANAGEMENT'?'superseded':'cancelled',record.target.kind==='project'?{projectVersion:this.store.data.projectVersion}:task?this.receipt(task):{status:'missing'},e);throw e;
    }
    record.status='applying';record.startedAt=now();this.store.save();
  }
  finish(record,status,result,error){
    record.status=status;record.finishedAt=now();
    if(result!==undefined)record.result=structuredClone(result);
    if(error)record.error=error.message;
    this.store.save();return structuredClone(record.result);
  }
  receipt(task,extra={}){return {taskId:task.id,stateVersion:task.stateVersion,requirementVersion:task.requirementVersion,status:task.status,...extra};}
}
