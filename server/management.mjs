import {randomUUID} from 'node:crypto';
import {fingerprint} from './task-lifecycle.mjs';
import {captureManagementContext,assertCurrentDocuments,contextReferences} from './management-context.mjs';
import {OperationLedger} from './operations.mjs';
import {validateAuxiliary} from './auxiliary.mjs';

export const taskActionAliases = {create_task:'create',revise_task:'amend',pause_task:'pause',resume_task:'resume'};
export const eventOperations = {
  task_ready:['dispatch_task','request_decision','pause_task','delegate_work'],
  execution_result:['request_verification','request_decision','dispatch_task','pause_task','delegate_work'],
  auxiliary_result:['dispatch_task','request_decision','pause_task','delegate_work'],
  verification_result:['submit_delivery','dispatch_task','request_decision','pause_task','observe'],
  session_unavailable:['replace_session','request_decision','pause_task'],
};
const labels={delegate_work:'安排辅助工作',observe:'已记录执行结果',request_verification:'安排独立验证',submit_delivery:'提交最新成果',dispatch_task:'安排继续执行',request_decision:'需要你的决定',pause_task:'暂停任务',replace_session:'交接执行上下文'};
export function defaultEventOperation(event) {
  const type=['task_ready','auxiliary_result'].includes(event.type)?'dispatch_task':event.type==='execution_result'?'request_verification':event.type==='session_unavailable'?'replace_session':event.payload.evidence.passed?'submit_delivery':event.payload.repairBudgetRemaining===0?'observe':'dispatch_task';
  return {type,taskId:event.taskId,expectedVersion:event.stateVersion};
}

// The manager proposes; this durable boundary validates and records actual effects.
export class ProjectManager {
  constructor(store,backend,config) {this.store=store;this.ledger=new OperationLedger(store);this.backend=backend;this.config=config;store.data.management??={events:[],operations:{}};}
  async decide(type,task,payload,signal) {
    if(!eventOperations[type])throw Error('未知管理事件');
    const context=await captureManagementContext(this.store,this.config);
    const event={context:contextReferences(context.managementContext),id:randomUUID(),type,taskId:task.id,stateVersion:task.stateVersion,requirementVersion:task.requirementVersion,payload:structuredClone(payload),status:'proposing',at:new Date().toISOString()};
    this.store.data.management.events.push(event);this.store.save();
    const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,this.config.managementTimeoutMs||90000);
    try {
      if(signal.aborted)throw Error('管理安排已中止');
      const operation=this.config.mode==='demo'||!this.backend.coordinate
        ? defaultEventOperation(event)
        : await this.backend.coordinate(structuredClone(event),context,controller.signal,task.modelSelection);
      if(controller.signal.aborted)throw Error('管理安排已中止或超时');
      await assertCurrentDocuments(context.managementContext,this.config);
      this.validate(event,operation,task);
      const id=`${event.id}:0`,record=this.ledger.propose({...operation,id,eventId:event.id,digest:fingerprint(operation)});
      event.operationId=id;event.status='proposed';this.store.save();
      return { ...operation, operationId:id, apply: effect => {
        if(record.status==='completed')return structuredClone(record.result);
        if(record.status!=='proposed')throw Error('管理操作已经执行，不能重复应用');
        try{this.ledger.start(record,()=>{this.validate(event,operation,task);if(signal.aborted)throw Error('管理安排已中止');});}
        catch(e){record.status=event.status=e.code==='STALE_MANAGEMENT'?'superseded':'cancelled';record.error=e.message;this.store.save();throw e;}
        try {
          const result=effect();
          if(result?.then)throw Error('管理状态提交必须同步完成');
          event.status='completed';this.ledger.finish(record,'completed',this.ledger.receipt(task,operation.type==='delegate_work'?{auxiliaryIds:task.auxiliary.filter(w=>w.id.startsWith(id+':')).map(w=>w.id)}:{}));
          this.store.event(task.id,'management',labels[operation.type],`要求 v${event.requirementVersion} · ${operation.type}`);
          return result;
        }catch(e){event.status='uncertain';this.ledger.finish(record,'uncertain',undefined,e);throw e;}
      }};
    }catch(e){event.status=signal.aborted?'cancelled':e.code==='STALE_MANAGEMENT'||task.requirementVersion!==event.requirementVersion||task.stateVersion!==event.stateVersion?'superseded':'failed';event.error=e.message;this.store.save();throw e;}
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  validate(event,operation,task) {
    if(!operation||!eventOperations[event.type].includes(operation.type))throw Error('管理操作不符合当前事件，不能代替用户验收或跳过验证');
    if(operation.taskId!==task.id||operation.expectedVersion!==event.stateVersion)throw Error('管理安排引用的任务或预期版本不正确');
    if(task.stateVersion!==event.stateVersion||task.requirementVersion!==event.requirementVersion)throw Object.assign(Error('管理安排已过期，请按最新任务事实重新安排'),{code:'STALE_MANAGEMENT'});
    if(operation.type==='delegate_work')validateAuxiliary(task,operation.work);
    if(operation.type==='observe'&&(event.payload.evidence?.passed||event.payload.repairBudgetRemaining!==0))throw Error('仅在失败修复预算用尽时记录后停止');
    if(event.type==='verification_result'&&!event.payload.evidence?.passed&&event.payload.repairBudgetRemaining===0&&operation.type!=='observe')throw Error('自动修复预算已用尽，必须保留证据并停止');
    if(operation.type==='submit_delivery'&&!event.payload.evidence?.passed)throw Error('验证未通过，不能提交交付');
    if(operation.type==='dispatch_task'&&event.payload.repairBudgetRemaining===0)throw Error('自动修复预算已用尽');
    if(operation.type==='replace_session'&&event.payload.replacementBudgetRemaining===0)throw Error('自动替换会话预算已用尽');
    if(operation.type==='request_verification'&&operation.command!==undefined&&(typeof operation.command!=='string'||!operation.command.trim()||operation.command.length>12000))throw Error('验证命令无效');
    if(operation.permission!==undefined&&!['workspace','network','local'].includes(operation.permission))throw Error('验证权限范围无效');
    if(operation.type==='request_decision'&&(typeof operation.question!=='string'||!operation.question.trim()||operation.question.length>12000||!Array.isArray(operation.options)||operation.options.length<2||operation.options.length>3||operation.options.some(o=>typeof o!=='string'||!o.trim()||o.length>12000)))throw Error('请提供具体问题和二至三个选项');
  }
}
