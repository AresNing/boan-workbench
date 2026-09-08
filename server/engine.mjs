import { activityRecorder } from './activity.mjs';
import { randomUUID } from 'node:crypto';
import { runCommand, scopedPath, listFiles } from './files.mjs';
import { ACTIVE, now, overview } from './store.mjs';
import { sandboxAvailable } from './sandbox.mjs';
import { initializeTask, revise, handoff, fingerprint, modelIdentity, validateParents } from './task-lifecycle.mjs';
import { dependencyOrder, dependencyState, validateDependencies, invalidateDependencyResult } from './dependencies.mjs';
import {inspectWorkspace} from './workspace-inspection.mjs';
import {captureManagementContext,assertCurrentDocuments,contextReferences} from './management-context.mjs';
import {OperationLedger} from './operations.mjs';
import {ProjectManager,taskActionAliases} from './management.mjs';
import {deliverRequirements,validateDelivery} from './requirement-delivery.mjs';
import {replaceExecutionSession,validateReplacement} from './session-replacement.mjs';
import {reserveAuxiliary,runAuxiliaryBatch,cancelAuxiliary,auxiliaryResult,integrateAuxiliary,assertAuxiliaryIntegrated} from './auxiliary.mjs';

export class Engine {
  constructor(store, backend, config) {
    this.store = store; this.backend = backend; this.config = config;
    this.commandQueue = Promise.resolve(); this.commandCount=0; this.grants = new Map();
    this.active = null; this.pending = new Map(); this.managerBusy = false; this.closing = false;
    this.ledger = new OperationLedger(store);
    this.manager = new ProjectManager(store,backend,config);
    this.delivering = new Set();
    this.replacing = new Map();
    this.auxiliaryJobs = new Map();
  }
  seed() {
    if (this.config.mode !== 'demo' || this.store.data.tasks.length) return;
    this.store.add('修复订单导出中的 CSV 字段转义', { title: '修复订单导出', demoKind: 'export', priority: 'high', acceptance: ['普通字段、逗号、引号和空输入均通过测试'], constraints: ['保留现有导出接口', '只在演示目录运行'] });
    this.store.add('增加 GitHub 登录，保留现有账号表', { title: '增加 GitHub 登录', demoKind: 'login', constraints: ['不修改现有账号表'], acceptance: ['确认账号关联规则，并保留决定'] });
    this.store.message('assistant', '已接下导出和登录两项工作。先验证导出，登录遇到必要取舍时再交给你。');
  }
  preparationStep(percent, title, detail) {
    this.preparation = { ...this.preparation, percent, title, detail, updatedAt: now() };
    this.store.emit('change', this.store.snapshot());
  }
  async message(text, focusId, requestId = randomUUID(), selectedModel) {
    const digest=fingerprint({text,focusId,selectedModel}), previous=this.store.data.requests[requestId];
    if(previous){if(previous.digest!==digest)throw Error('请求标识已用于其他输入');if(previous.status==='completed')return previous.result;if(previous.status==='failed')delete this.store.data.requests[requestId];else throw Error(previous.status==='uncertain'?'上次安排结果待核对，不能自动重放。':'这条要求正在处理或已失败，请检查工作记录。');}
    const selection = this.backend.select?.(selectedModel || (focusId ? this.store.task(focusId).modelSelection : undefined));
    if (this.managerBusy) throw new Error('正在整理上一条要求，请稍后再发。');
    this.store.data.requests[requestId]={digest,status:'pending',at:now()}; this.store.save();
    const managementInput={id:`input:${requestId}:${randomUUID()}`,type:'user_input',taskId:focusId||null,requestId,status:'proposing',at:now()};
    this.store.data.management.events.push(managementInput);this.store.save();
    this.managerBusy = true;
    this.preparation = { requestId, startedAt: now(), status: 'running' };
    this.preparationStep(0, '接收要求', '正在保存你的输入并整理当前项目上下文。');
    this.managerController = new AbortController();
    if(!previous)this.store.message('user', text, focusId);
    const timer = setTimeout(() => this.managerController.abort(), 90_000);
    try {
      const context = await captureManagementContext(this.store,this.config);
      managementInput.context=contextReferences(context.managementContext);this.store.save();
      this.preparationStep(20, '连接模型', `已整理 ${context.tasks.length} 项任务与最近沟通，正在建立模型会话。`);
      const plan = await this.backend.manage(text, context, focusId, this.managerController.signal, stage => {
        if (this.managerController.signal.aborted) return;
        if (stage === 'connected') this.preparationStep(40, '理解要求', '模型正在结合项目上下文，判断是新任务、补充要求还是询问，并生成安排。');
        if (stage === 'planned') this.preparationStep(60, '接收任务安排', '已收到模型安排，正在等待本轮回复结束。');
      }, selection);
      await assertCurrentDocuments(context.managementContext,this.config);
      if (this.closing || this.managerController.signal.aborted) throw new Error('管理请求已中止，请重试。');
      if (!Array.isArray(plan.actions) || plan.actions.length > 8 || typeof plan.reply !== 'string') throw new Error('管理返回无效');
      for(const a of plan.actions)a.type=taskActionAliases[a.type]||a.type;
      const references = new Map(), proposed = [];
      for (const a of plan.actions.filter(a => a.type === 'create')) {
        a.createdTaskId = randomUUID();
        if (a.ref !== undefined) {
          if (typeof a.ref !== 'string' || !/^[\w-]{1,64}$/.test(a.ref) || references.has(a.ref) || context.tasks.some(t=>t.id===a.ref)) throw Error('新任务引用标识无效或重复');
          references.set(a.ref, a.createdTaskId);
        }
        proposed.push(initializeTask({ id:a.createdTaskId, goal:a.text, constraints:a.constraints || [], acceptance:a.acceptance || [], status:'queued', feedback:[], evidence:[], artifacts:[], sessions:[] }));
      }
      // Reserve task IDs before validating the entire graph, but persist no tasks yet.
      const plannedTasks = [...context.tasks, ...proposed];
      for (const a of plan.actions) {
        a.taskId = references.get(a.taskId) || a.taskId;
        if(a.type==='create'&&a.parentTaskId){a.parentTaskId=references.get(a.parentTaskId)||a.parentTaskId;proposed.find(t=>t.id===a.createdTaskId).parentTaskId=a.parentTaskId;}
        if (Array.isArray(a.dependencies)) for (const edge of a.dependencies) edge.taskId = references.get(edge.taskId) || edge.taskId;
      }
      validateParents(plannedTasks);
      const dependencyPlan = structuredClone(plannedTasks);
      for (const a of plan.actions) {
        if(focusId&&a.type==='create'&&a.independentGoal!==true)throw Error('当前输入用于补充任务；独立新目标需要明确标识。');
        if(a.type==='accept')throw Error('成果验收请使用任务上的确认完成按钮');
        if(a.type==='create'&&a.expectedVersion!==undefined&&a.expectedVersion!==context.projectVersion)throw Error('项目状态已变化，请按最新状态重新安排');
        if(a.type!=='create')a.expectedVersion ??= plannedTasks.find(t=>t.id===a.taskId)?.stateVersion;
        if (a.type === 'set_dependency' && Array.isArray(a.dependencies)) {
          for (const edge of a.dependencies) edge.expectedVersion ??= plannedTasks.find(t=>t.id===edge.taskId)?.stateVersion;
          const edges = validateDependencies(dependencyPlan, a.taskId, a.dependencies);
          const target = dependencyPlan.find(t => t.id === a.taskId);
          if (!target) throw Error('任务不存在');
          target.dependencies = edges;
        }
        this.validate(a, plannedTasks);
      }
      // Parents created in this plan must exist before their children are persisted.
      const creates=[],remaining=plan.actions.filter(a=>a.type==='create');
      while(remaining.length){
        const index=remaining.findIndex(a=>!remaining.some(parent=>parent.createdTaskId===a.parentTaskId));
        if(index<0)throw Error('子任务关系不能成环');creates.push(...remaining.splice(index,1));
      }
      plan.actions = [...creates, ...plan.actions.filter(a=>a.type!=='create')];
      plan.actions.forEach((a,index)=>{a.operationId=`${requestId}:${index}`;});
      this.store.data.requests[requestId].status='applying';this.store.data.requests[requestId].plan=plan;this.store.save();
      this.preparationStep(80, '保存任务安排', plan.actions.length ? `已检查 ${plan.actions.length} 项操作，正在保存目标、约束与执行安排。` : '已检查回复，正在保存本次沟通结果。');
      const receipts = [];
      const knownVersions = new Map(plannedTasks.map(t=>[t.id,t.stateVersion]));
      let knownProjectVersion=context.projectVersion;
      for (const a of plan.actions) {
        const beforeVersions = new Map(this.store.data.tasks.map(t=>[t.id,t.stateVersion]));
        if (a.type === 'create') {
          a.expectedVersion=knownProjectVersion;
          const record=this.ledger.propose({...a,id:a.operationId,taskId:a.createdTaskId,target:{kind:'project',id:this.store.data.project.path},digest:fingerprint(a)},{legacy:true});
          this.ledger.start(record,()=>{
            if(a.parentTaskId&&this.store.task(a.parentTaskId).stateVersion!==knownVersions.get(a.parentTaskId))throw Object.assign(Error('父任务状态已变化，请按最新任务事实重新安排'),{code:'STALE_MANAGEMENT'});
          });
          try{
            const task = this.store.add(a.text, { id:a.createdTaskId, createdBy:a.operationId, ...(a.parentTaskId?{parentTaskId:a.parentTaskId}:{}), ...(selection ? { modelSelection: selection } : {}), title: a.title || a.text.slice(0, 48), constraints: a.constraints || [], acceptance: a.acceptance || [], priority: a.priority || 'normal' });
            knownProjectVersion=this.store.data.projectVersion;knownVersions.set(task.id,task.stateVersion);
            this.ledger.finish(record,'completed',this.ledger.receipt(task,{projectVersion:knownProjectVersion}));receipts.push(`已建立「${task.title}」`);
          }catch(e){this.ledger.finish(record,'uncertain',undefined,e);throw e;}
        } else {
          if (selection && selectedModel && a.taskId === focusId && a.type === 'amend') a.modelSelection = selection;
          a.expectedVersion = knownVersions.get(a.taskId);
          for (const edge of a.dependencies || []) edge.expectedVersion = knownVersions.get(edge.taskId);
          const operation = this.action(a.taskId, a.type, a);
          // action applies synchronously. Account for our own changes before yielding;
          // subsequent external execution changes must still fail the version check.
          for (const task of this.store.data.tasks) if (beforeVersions.get(task.id) !== task.stateVersion) knownVersions.set(task.id,task.stateVersion);
          await operation;
          if(a.type==='replace_session'){
            const receipt=this.store.data.management.operations[a.operationId];
            if(receipt.status!=='completed')throw Error('执行上下文交接已被新要求或暂停取代，剩余安排未执行');
            knownVersions.set(a.taskId,receipt.result.stateVersion);
          }
        }
      }
      if(plan.actions.some(a=>a.type==='amend'))plan.reply=plan.actions.map(a=>a.type==='amend'?`「${this.store.task(a.taskId).title}」要求已保存，接收状态见执行记录。`:a.type==='create'?`已建立「${a.title||a.text.slice(0,48)}」`:'安排已保存。').join('\n');
      else if(plan.actions.some(a=>['deliver_update','replace_session'].includes(a.type)))plan.reply=plan.actions.map(a=>{
        if(a.type==='replace_session'){
          const record=this.store.data.management.operations[a.operationId],task=this.store.task(a.taskId);
          return `「${task.title}」${record?.status==='completed'?'交接已保存，任务与成果保留':'任务要求或状态已变化，本次交接已停止'}。`;
        }
        if(a.type!=='deliver_update')return '安排已保存。';
        const task=this.store.task(a.taskId),update=task.updates.find(u=>u.id===a.updateId);
        return `「${task.title}」${update?.status==='received'?'执行者已接收要求':update?.status==='delivered'?'要求已投递，等待执行者接收':'要求已保存，等待执行者读取'}。`;
      }).join('\n');
      this.store.message('assistant', plan.reply);
      this.preparation.status = 'complete';
      this.preparationStep(100, '准备完成', plan.actions.length ? '任务安排已保存，可在工作台查看后续进展。' : '回复已保存，本次没有新增任务。');
      const result={reply:plan.reply};Object.assign(this.store.data.requests[requestId],{status:'completed',result});managementInput.status='completed';managementInput.operations=plan.actions.map(a=>a.operationId);this.store.save();
      this.tick(); return result;
    } catch (err) { this.store.data.requests[requestId].status=this.store.data.requests[requestId].status==='applying'?'uncertain':'failed';managementInput.status=this.store.data.requests[requestId].status;this.preparation.status = 'failed'; this.preparationStep(this.preparation.percent, '准备未完成', '本次准备已停止，请查看错误提示；输入内容仍保留。'); this.store.message('assistant', `未能完成这次安排：${err.message}`); throw err; }
    finally { clearTimeout(timer); this.managerBusy = false; this.store.emit('change', this.store.snapshot()); this.tick(); }
  }
  validate(a, tasks = this.store.data.tasks) {
    if (!['create', 'pause', 'resume', 'priority', 'amend', 'accept', 'set_dependency', 'deliver_update','replace_session'].includes(a.type)) throw new Error('不支持的任务操作');
    if (a.type === 'create') { if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 12000) throw new Error('任务目标无效'); return; }
    const task = tasks.find(t => t.id === a.taskId); if (!task) throw Error('任务不存在');
    if(a.type==='deliver_update')validateDelivery(task,a);
    if(a.type==='replace_session')validateReplacement(task,a);
    if(a.expectedVersion!==undefined && a.expectedVersion!==task.stateVersion)throw Error('任务状态已变化，请按最新状态重新安排');
    if(a.type==='set_dependency') { if(a.expectedVersion===undefined)throw Error('调整依赖需要预期任务版本'); validateDependencies(tasks, task.id, a.dependencies); }
    if (a.type === 'accept' && task.status !== 'review') throw new Error('只有通过验证的交付可以验收');
    if (a.type === 'resume' && !['paused', 'failed'].includes(task.status)) throw new Error('这项任务不需要恢复；待决问题请先处理');
    if (a.type === 'priority' && !['high', 'normal'].includes(a.priority)) throw new Error('优先级无效');
    if (a.type === 'amend') {if(typeof a.text!=='string'||!a.text.trim()||a.text.length>12000)throw Error('请填写有效补充要求');revise(structuredClone(task),a);}
  }
  async action(id, type, data = {}) {
    const t = this.store.task(id);
    if(type==='deliver_update'){await deliverRequirements(this,t,data);return this.store.snapshot();}
    if(type==='replace_session'){await replaceExecutionSession(this,t,data);return this.store.snapshot();}
    const replacement=this.replacing.get(id);
    if(replacement&&!['pause','amend'].includes(type))throw Error('正在停止并交接执行，请稍后重试');
    const operationId=data.operationId || randomUUID(), digest=fingerprint({id,type,data:{...data,operationId:undefined}});
    if(this.ledger.replay({id:operationId,type,taskId:id,digest}))return this.store.snapshot();
    if(data.expectedVersion!==undefined&&data.expectedVersion!==t.stateVersion)throw Error('任务状态已变化，请刷新后重试');
    if (['pause', 'resume', 'priority', 'amend', 'accept', 'set_dependency'].includes(type)) this.validate({ ...data, type, taskId: id });
    const record=this.ledger.propose({id:operationId,digest,type,taskId:id,expectedVersion:data.expectedVersion??t.stateVersion},{legacy:true});
    this.ledger.start(record);
    try{
    switch (type) {
      case 'set_dependency': {
        const dependencies = validateDependencies(this.store.data.tasks, id, data.dependencies);
        if (fingerprint(dependencies) !== fingerprint(t.dependencies)) {
          // Preserve the old binding until refresh can invalidate any consumed result.
          t.dependencyObserved ??= dependencyState(t, this.store.data.tasks).signature;
          this.store.patch(id, { dependencies });
        }
        break;
      }
      case 'pause': {
        cancelAuxiliary(this,id);
        if(replacement){replacement.cancelled=true;if(this.active?.id===id)this.active.requeue=false;}
        if(this.scheduling?.id===id)this.scheduling.controller.abort();
        if (this.active?.id === id) {
          this.store.patch(id, { status: 'stopping', summary: '正在中止执行，等待实际停止。' });
          this.active.controller.abort(); this.rejectPending(id, '用户暂停了执行');
        } else if (['queued', 'blocked', 'failed'].includes(t.status)) this.store.patch(id, { status: 'paused', decision: null, summary: '已暂停，目标和约束已保留。' });
        else if(!replacement)throw new Error('当前状态无需暂停');
        break;
      }
      case 'resume': this.store.patch(id, { status: 'queued', decision: null, summary: '已安排恢复，将重新检查现有文件。' }); break;
      case 'priority': this.store.patch(id, { priority: data.priority }); break;
      case 'model': {
        if (!this.backend.select) throw Error('当前模式不支持切换模型');
        if (this.active?.id === id || ['queued', 'running', 'verifying', 'stopping'].includes(t.status)) throw Error('请先暂停任务，再切换模型');
        this.store.patch(id, { modelSelection: this.backend.select(data.modelSelection) });
        break;
      }
      case 'amend': {
        cancelAuxiliary(this,id);
        if(replacement){replacement.cancelled=true;if(this.active?.id===id)this.active.requeue=true;}
        const changedModel=data.modelSelection && modelIdentity(t.modelSelection)!==modelIdentity(data.modelSelection);
        if (data.modelSelection) t.modelSelection = this.backend.select(data.modelSelection);
        const update=revise(t,data);delete t.acceptedAt;
        if (this.active?.id === id) {
          this.store.patch(id,{...(t.decision?.kind==='command'?{status:'running'}:{}),summary:'要求已保存，等待执行者接收。',decision:null});
          // A direction change cancels the affected tool; additive updates wait at its boundary.
          if(data.change==='replace'||data.change==='revoke'||data.impact==='conflict'||t.status==='verifying'||this.pending.size||changedModel){
            this.grants.delete(id);for(const c of this.active.tools.values())c.abort();this.rejectPending(id,'要求已更新，旧授权不再适用');
          }
          if(changedModel){this.active.requeue=true;this.active.controller.abort();}
          else void deliverRequirements(this,t,{updateId:update.id,expectedVersion:t.stateVersion,operationId:`${operationId}:delivery`}).catch(()=>{});
        } else this.store.patch(id, { status: 'queued', summary: '要求已保存，等待继续执行。', decision: null });
        break;
      }
      case 'accept': if(t.deliveries.length && t.deliveries.at(-1).version!==t.requirementVersion)throw Error('要求已更新，旧交付不能验收');if(t.deliveries.length)t.deliveries.at(-1).acceptedAt=now();this.store.patch(id, { status: 'done', summary: '你已验收这项成果。', acceptedAt: now() }); break;
      case 'defer': this.store.patch(id, { deferredUntil: new Date(Date.now() + 30 * 60_000).toISOString() }); break;
      case 'decision': {
        if (t.status !== 'blocked' || !t.decision || data.decisionId !== t.decision.id) throw new Error('该问题已变化，请刷新后重试');
        const decision = t.decision;
        if (!decision.options.includes(data.answer)) throw new Error('请选择此问题提供的选项');
        if (decision.kind === 'command' && !this.pending.has(decision.id)) throw new Error('原执行已结束，请恢复任务后重新申请');
        t.decisions ??= []; t.decisions.push({ ...decision, answer: data.answer, requirementVersion:t.requirementVersion, at: now() });
        if (decision.kind === 'command') {
          const pending = this.pending.get(decision.id);
          if (!pending) throw new Error('原执行已结束，请暂停后恢复');
          this.pending.delete(decision.id);
          const approved = data.answer !== '拒绝并暂停';
          if (approved && data.answer === '本任务内允许联网') this.grants.set(id, { ...this.grants.get(id), network: true });
          if (approved && data.answer === '本任务内允许项目命令') this.grants.set(id, { ...this.grants.get(id), workspace: true });
          this.store.patch(id, { status: approved ? pending.previousStatus : 'stopping', summary: approved ? pending.previousStatus === 'verifying' ? '正在独立验证。' : '正在执行。' : '正在停止执行。', decision: null, deferredUntil: null });
          this.resumeDeadline();
          if (approved) pending.resolve(pending.permission); else { this.active?.controller.abort(); pending.reject(new Error('用户拒绝了命令')); }
        } else if(decision.kind==='recovery'){if(data.answer!=='保持暂停')for(const op of t.operations)if(op.status==='uncertain')op.status='reconciled';this.store.patch(id,{status:data.answer==='保持暂停'?'paused':'queued',decision:null,summary:'已记录核对结果，继续前将检查当前文件。'});}
        else this.store.patch(id, { status: 'queued', decision: null, deferredUntil: null, summary: `已采用「${data.answer}」，继续推进。` });
        break;
      }
      default: throw new Error('不支持的操作');
    }
    this.ledger.finish(record,'completed',this.ledger.receipt(t));
    }catch(e){this.ledger.finish(record,'uncertain',this.ledger.receipt(t),e);throw e;}
    this.store.event(id, type, { set_dependency: '任务依赖已更新', model: '任务模型已更新', pause: '已请求暂停', resume: '已安排恢复', priority: '优先级已更新', amend: '要求已更新', accept: '成果已验收', defer: '稍后提醒，任务阻塞状态保留', decision: '决定已记录' }[type]);
    this.tick(); return this.store.snapshot();
  }
  rejectPending(id, message) {
    for (const [key, p] of this.pending) if (p.taskId === id) { this.pending.delete(key); p.reject(new Error(message)); }
  }
  permissions() {
    return { mode: this.store.data.permissions?.mode || this.config.permissionMode || 'auto', sandboxAvailable,
      grants: [...this.grants].map(([taskId, grants]) => ({ taskId, ...grants })) };
  }
  setPermissions({ mode, revokeTaskId } = {}) {
    if (mode !== undefined && !['auto', 'ask'].includes(mode)) throw new Error('权限模式无效');
    if (revokeTaskId !== undefined) this.store.task(revokeTaskId);
    if (mode !== undefined) { this.store.data.permissions = { mode }; this.grants.clear(); }
    if (revokeTaskId) this.grants.delete(revokeTaskId);
    this.store.event(revokeTaskId || null, 'permission', revokeTaskId ? '已撤销任务授权，后续命令重新检查' : '已更新项目命令权限');
    return this.permissions();
  }
  pauseDeadline() {
    if (!this.deadline || this.deadline.paused) return;
    clearTimeout(this.deadline.timer);
    this.deadline.remaining -= Date.now() - this.deadline.started;
    this.deadline.paused = true;
  }
  resumeDeadline() {
    if (!this.deadline || this.pending.size) return;
    clearTimeout(this.deadline.timer);
    this.deadline.paused = false; this.deadline.started = Date.now();
    this.deadline.timer = setTimeout(() => {
      if (this.active) { this.active.timedOut = true; this.active.controller.abort(); this.rejectPending(this.active.id, '执行超时'); }
    }, Math.max(1, this.deadline.remaining));
  }
  async approve(taskId, command, reason, requested = 'workspace') {
    if (!['workspace', 'network', 'local'].includes(requested)) throw new Error('命令权限范围无效');
    if (typeof command !== 'string' || !command.trim() || command.length > 12000) throw new Error('命令内容无效');
    if (this.active?.controller.signal.aborted) throw new Error('执行已中止');
    const permission = { sandbox: sandboxAvailable && requested !== 'local', network: requested === 'network' };
    const grants = this.grants.get(taskId) || {};
    if (permission.sandbox && (this.permissions().mode === 'auto' || grants.workspace || requested === 'network' && grants.network) && (requested === 'workspace' || grants.network)) {
      if (requested === 'network') this.store.event(taskId, 'permission', '使用本任务的联网授权', command);
      return permission;
    }
    const id = randomUUID();
    const options = ['允许本次执行'];
    if (permission.sandbox) options.push(requested === 'network' ? '本任务内允许联网' : '本任务内允许项目命令');
    options.push('拒绝并暂停');
    const recommendation = !permission.sandbox
      ? '本次命令将以你的本机权限执行，可访问项目外文件和网络。仅此一次，不记住授权。'
      : requested === 'network'
        ? '允许命令联网；文件仍限制在项目与临时目录。任务授权持续到本次执行结束，可随时撤销。'
        : '文件与命令限制在项目与临时目录，禁止联网。任务授权持续到本次执行结束，可随时撤销。';
    this.pauseDeadline();
    return new Promise((resolve, reject) => {
      const previousStatus = this.store.task(taskId).status;
      this.pending.set(id, { taskId, resolve, reject, previousStatus, permission });
      this.store.patch(taskId, { status: 'blocked', summary: '需要命令授权。', decision: { id, kind: 'command', scope: permission.sandbox ? requested : 'local', question: reason || '执行这条命令？', command, recommendation, options } });
    });
  }
  command(taskId, command, reason, requested = 'workspace', options = {}) {
    // Shell calls are serialized so two pending requests cannot replace each other.
    const result = this.commandQueue.then(async () => {
      if (options.signal?.aborted) throw new Error('执行已中止');
      const permission = this.config.mode === 'demo' ? {} : await this.approve(taskId, command, reason, requested);
      if (options.signal?.aborted) throw new Error('执行已中止');
      options.onApproved?.();
      const running=[...this.active?.tools||[]].find(([,controller])=>controller.signal===options.signal);
      const operation=running&&this.store.task(taskId).operations.find(o=>o.id===running[0]);if(operation){operation.executedAt=now();this.store.save();}
      const lifecycle=this.config.commandLifecycle;
      this.commandCount++;try{return await runCommand(this.config.projectPath, command, { ...options, ...permission, runtimeBin: this.config.runtimeBin, protectedRoots: [this.config.dataDir, this.config.appDataDir, this.config.codexHome,lifecycle?.root],...(lifecycle?{
        onSpawn:pid=>{lifecycle.commandStarted(pid);if(operation){operation.processGroup=pid;this.store.save();}},
        onSettled:pid=>lifecycle.commandSettled(pid),
      }:{}) });}finally{this.commandCount--;}
    });
    this.commandQueue = result.catch(() => {});
    return result;
  }
  refreshDependencies() {
    for (const task of dependencyOrder(this.store.data.tasks)) {
      if (!task.dependencies.length && task.dependencyObserved === undefined) continue;
      const state = dependencyState(task, this.store.data.tasks);
      const changed = task.dependencyObserved !== undefined && task.dependencyObserved !== state.signature;
      if (changed && (task.attempts || task.deliveries.length)) {
        invalidateDependencyResult(task, '上游成果或依赖已变化，需按最新来源重新检查并验证。');
        if (this.active?.id === task.id) {
          task.generation++;
          this.active.requeue = task.status !== 'stopping';
          this.active.controller.abort();
          for (const controller of this.active.tools.values()) controller.abort();
          this.rejectPending(task.id, '依赖已变化，旧授权失效');
          this.grants.delete(task.id);
        } else if (!['paused', 'failed'].includes(task.status)) task.status = 'queued';
        task.decision = null;
        task.summary = ['paused','failed'].includes(task.status) ? '依赖已变化，恢复后需重新检查并验证。' : '依赖已变化，等待重新检查并验证。';
      }
      const summary = task.status === 'queued'
        ? state.waiting.join('；') || (task.dependencyWait?.length ? '依赖成果已就绪，等待执行。' : task.summary)
        : task.summary;
      if (changed || task.dependencyObserved === undefined || summary !== task.summary) {
        this.store.patch(task.id, { dependencyObserved: state.signature, dependencyContext: state.sources, dependencyWait: state.waiting, summary });
        if (changed) this.store.event(task.id, 'dependency', state.waiting.length ? '等待上游成果' : '依赖成果已就绪', state.waiting.join('；') || state.sources.map(s => `${s.title} · v${s.requirementVersion}`).join('\n'));
      }
    }
  }
  tick() {
    if (this.closing) return;
    this.refreshDependencies();
    if (this.active || this.scheduling || this.replacing.size || this.closing || this.managerBusy) return;
    const next = this.store.data.tasks.filter(t => t.status === 'queued' && !t.dependencyWait?.length).sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return;
    const controller = new AbortController();
    const scheduling=this.scheduling={id:next.id,controller};
    scheduling.promise=this.coordinate('task_ready',next,{},controller.signal).then(operation=>{
      if(operation.type==='request_decision'){this.managementStop(operation,next);return;}
      if(operation.type==='pause_task'){operation.apply(()=>this.store.patch(next.id,{status:'paused',summary:'已暂停，等待继续安排。'}));return;}
      operation.apply(()=>{
        if(next.status!=='queued'||next.dependencyWait?.length)throw Error('任务尚不符合执行条件');
        this.active={id:next.id,controller,requeue:false,tools:new Map(),toolPromises:new Set()};
        this.active.promise=this.run(next.id,controller.signal).finally(()=>{this.active=null;if(!this.closing)queueMicrotask(()=>this.tick());});
      });
    }).catch(e=>{if(!controller.signal.aborted&&e.code!=='STALE_MANAGEMENT'&&next.status==='queued')this.store.patch(next.id,{status:'failed',summary:e.message});})
      .finally(()=>{this.scheduling=null;if(!this.closing)queueMicrotask(()=>this.tick());});
  }
  async coordinate(type,task,payload,signal) {
    const version=task.requirementVersion;
    if(['task_ready','execution_result'].includes(type))payload={...payload,availableFiles:await listFiles(this.config.projectPath)};
    for(let batches=0;batches<7;batches++){
      let operation;
      for(let attempt=0;attempt<2;attempt++)try{operation=await this.manager.decide(type,task,{...payload,auxiliaryBudgetRemaining:6-(task.auxiliary?.length||0)},signal);break;}catch(e){if(attempt||e.code!=='STALE_MANAGEMENT'||signal.aborted||task.requirementVersion!==version)throw e;}
      if(operation.type!=='delegate_work')return operation;
      if(!this.backend.auxiliary)throw Error('当前执行引擎不支持辅助工作');
      let records;operation.apply(()=>{records=reserveAuxiliary(this,task,operation.work,operation.operationId);});
      const results=await runAuxiliaryBatch(this,task,records,signal);
      type='auxiliary_result';payload={results};
    }
    throw Error('辅助执行预算已用尽');
  }
  async run(id, signal) {
    const start=Date.now(), task=this.store.task(id), activity=activityRecorder(this.store,id,this.config.apiKey);
    this.deadline={remaining:this.config.runTimeoutMs,paused:true};this.resumeDeadline();
    let repairs=0, updates=0, replacements=0;
    try {
      while(true) {
        if(signal.aborted)throw Error('执行已中止');
        if(++updates>(this.config.maxTurns||30))throw Error('本轮续接次数已用尽，请检查进展后恢复');
        const uncertain=task.operations.filter(o=>o.status==='uncertain');
        if(uncertain.length){
          this.store.patch(id,{status:'blocked',summary:'上次操作结果尚未确认，请先检查实际文件或外部结果。',decision:{id:randomUUID(),kind:'recovery',question:'上次操作可能已经生效，请核对后决定是否继续。',recommendation:uncertain.map(o=>`${o.tool}: ${o.path||o.command||o.id}`).join('\n'),options:['已核对结果，继续检查并执行','保持暂停']}});return;
        }
        if(!task.modelSelection&&this.backend.select)this.store.patch(id,{modelSelection:this.backend.select()});
        this.grants.delete(id);
        const generation=++task.generation, firstVersion=task.requirementVersion;
        const round={id:randomUUID(),generation,version:firstVersion,status:'running',startedAt:now(),dependencies:structuredClone(task.dependencyContext || [])};task.rounds.push(round);
        let received=0, offered=firstVersion, report;
        const owns=()=>{if(signal.aborted||task.generation!==generation)throw Error('旧执行者已失效');};
        const acknowledge=version=>{owns();if(version!==task.requirementVersion||offered!==version)throw Error('请先读取完整的最新要求，再确认版本');if(task.operations.some(o=>o.status==='started'&&o.generation===generation))throw Error('请等待在途操作结束后接收新要求');received=version;round.version=version;for(const u of task.updates)if(u.version<=version&&u.status!=='received'){u.status='received';u.receivedAt=now();u.deliveredAt??=u.receivedAt;u.sessionId=task.currentSession?.id;this.store.event(id,'requirements','执行者已接收最新要求',`v${version}`);}this.store.save();return '最新要求已接收';};
        const guard=()=>{owns();if(!received&&firstVersion===task.requirementVersion)acknowledge(firstVersion);if(received!==task.requirementVersion)throw Error(`要求已更新到 v${task.requirementVersion}。请调用 read_requirements，再 acknowledge_requirements 确认最新版本。`);};
        const ctx={signal,activity,event:(kind,text,detail)=>{if(!signal.aborted&&task.generation===generation)this.store.event(id,kind,text,detail);},
          sessionLost:()=>{if(this.active?.id===id&&task.generation===generation){for(const c of this.active.tools.values())c.abort();this.rejectPending(id,'执行连接已失效');}},
          guard, acknowledge, currentVersion:()=>received,
          readRequirements:()=>{owns();offered=task.requirementVersion;for(const u of task.updates)if(u.status==='saved'){u.status='delivered';u.deliveredAt=now();}this.store.save();return structuredClone(task);},
          readAuxiliary:auxId=>{guard();const value=auxiliaryResult(task,auxId,generation);this.store.save();return value;},
          integrateAuxiliary:(p,opSignal)=>integrateAuxiliary(this,task,p.id,p.decision,p.reason,generation,guard,opSignal),
          tool:async(callId,name,params,fn)=>{
            owns();if(typeof callId!=='string'||!callId)throw Error('工具请求缺少稳定标识');if(!received&&firstVersion===task.requirementVersion)acknowledge(firstVersion);
            if(!['read_requirements','acknowledge_requirements'].includes(name))guard();
            if(name==='submit_result')assertAuxiliaryIntegrated(task);
            const mutates=['write_file','run_command','submit_result','request_decision','integrate_auxiliary'].includes(name);
            const key=`${task.currentSession?.id||generation}:${callId}`, digest=fingerprint({name,params});
            let record=mutates&&task.operations.find(o=>o.id===key);
            if(record){if(record.digest!==digest)throw Error('工具操作标识冲突');if(record.status==='completed')return record.result;throw Error('此操作已执行或结果不确定，不能自动重放');}
            const controller=new AbortController(), abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});this.active.tools.set(key,controller);
            if(mutates){record={id:key,digest,tool:name,path:params.path,command:params.command,version:received,generation,status:'started',at:now()};task.operations.push(record);this.store.save();}
            const operationPromise=Promise.resolve().then(()=>fn(controller.signal));this.active.toolPromises.add(operationPromise);
            try{const value=await operationPromise;owns();if(record){record.status='completed';record.result=value;record.finishedAt=now();this.store.save();}return value;}
            catch(e){if(record){record.status=name==='run_command'&&record.executedAt&&controller.signal.aborted?'uncertain':'failed';record.error=e.message;this.store.save();}throw e;}
            finally{signal.removeEventListener('abort',abort);this.active?.tools.delete(key);this.active?.toolPromises.delete(operationPromise);}
          },
          artifact:file=>{owns();if(!task.artifacts.includes(file))task.artifacts.push(file);this.store.save();},
          session:(sessionId,file)=>{if(signal.aborted||task.generation!==generation)return;const old=task.currentSession;if(old?.id!==sessionId){if(old&&old.status!=='replaced'){handoff(task,'原会话不可复用或执行引擎已切换');this.store.event(id,'handoff','已交接给新的执行会话');}task.sessions.push({id:sessionId,file,at:now(),modelSelection:task.modelSelection});}task.currentSession={id:sessionId,file,status:'ready',generation};round.sessionId=sessionId;this.store.save();},
          hasDecision:()=>!!task.decision,
          decision:d=>{guard();if(this.pending.size)throw Error('请先等待命令审批完成');return this.store.patch(id,{status:'blocked',summary:'需要你的决定，其余任务会继续。',decision:{...d,id:randomUUID(),kind:'business'}});},
          approve:(command,reason,scope)=>{guard();return this.approve(id,command,reason,scope);},
          command:(command,reason,scope,options)=>{guard();return this.command(id,command,reason,scope,{...options,signal:options?.signal||signal});},
        };
        this.store.patch(id,{status:'running',decision:null,attempts:task.attempts+1,summary:repairs?'正在根据验证证据修复。':'正在执行。'});
        this.store.event(id,'run','开始执行',`要求版本 v${firstVersion}`);
        this.store.save();
        try {
          if(task.handoffs.length){
            task.workspaceInspection=await inspectWorkspace(this.config,task,signal);owns();
            const latest=task.handoffs.at(-1);if(!latest.workspaceInspection)latest.workspaceInspection=structuredClone(task.workspaceInspection);
            this.store.save();
          }
          report=await this.backend.execute(structuredClone(task),ctx);
        }catch(e){
          if(!signal.aborted&&e.code==='SESSION_UNAVAILABLE'&&replacements<1){
            const arrangement=await this.coordinate('session_unavailable',task,{roundId:round.id,reason:e.message,replacementBudgetRemaining:1-replacements},signal);
            if(this.managementStop(arrangement,task))return;
            arrangement.apply(()=>{replacements++;handoff(task,'执行连接失效，核对现场后接手');if(task.currentSession)task.currentSession.status='unavailable';round.status='replaced';this.store.save();});continue;
          }
          if(signal.aborted||task.requirementVersion===firstVersion)throw e;
        }
        owns();
        await Promise.allSettled([...this.active.toolPromises,this.commandQueue]);owns();
        // A model response to this round confirms receipt in the demo adapter too.
        if(!received&&report&&firstVersion===task.requirementVersion)acknowledge(firstVersion);
        if(task.decision?.kind==='command')throw Error('执行连接已结束，请恢复后重新申请授权');
        if(task.decision){round.status='blocked';this.store.save();return;}
        if(!report || received!==task.requirementVersion || (report.requirementVersion!==undefined&&report.requirementVersion!==task.requirementVersion)){
          round.status='superseded';this.store.save();if(task.requirementVersion!==firstVersion)continue;throw Error('执行者未提交对应最新要求的成果');
        }
        const version=received;
        assertAuxiliaryIntegrated(task);
        for(const artifact of task.artifacts)await scopedPath(this.config.projectPath,artifact,{protectedRoots:this.config.mode==='demo'?[]:[this.config.dataDir,this.config.appDataDir,this.config.codexHome,this.config.commandLifecycle?.root]});
        this.store.patch(id,{summary:'正在检查成果并安排验证。'});
        let arrangement;
        try {arrangement=await this.coordinate('execution_result',task,{roundId:round.id,report,repairBudgetRemaining:this.config.maxRepairs-repairs},signal);}
        catch(e){if(!signal.aborted&&task.requirementVersion!==version){round.status='superseded';this.store.save();continue;}throw e;}
        if(this.managementStop(arrangement,task))return;
        if(arrangement.type==='dispatch_task'){arrangement.apply(()=>{round.status='continued';this.store.save();});continue;}
        const command=this.config.verifyCommand||arrangement.command||report.verificationCommand;
        if(!command)throw Error('执行者未提供验证命令，不能交付');
        arrangement.apply(()=>this.store.patch(id,{status:'verifying',summary:'正在按最新要求独立验证。'}));
        const entry=activity(null,{text:'独立验证',tool:'verification',command,status:this.config.mode==='demo'?'running':'waiting'});
        const verificationStart=Date.now();let evidence;
        try{evidence=await ctx.tool(`verification-${round.id}`,'run_command',{command},opSignal=>this.command(id,command,'独立验证',arrangement.permission||report.verificationPermission||'workspace',{signal:opSignal,timeout:this.config.verifyTimeoutMs||90000,onApproved:()=>activity(entry,{status:'running'}),onOutput:output=>activity(entry,{output})}));}
        catch(e){if(signal.aborted||version===task.requirementVersion)throw e;evidence={passed:false,aborted:true,output:e.message};}
        Object.assign(evidence,{requirementVersion:version,roundId:round.id,applicability:version===task.requirementVersion?'current':'superseded'});task.evidence.push(evidence);
        activity(entry,{status:evidence.aborted?'interrupted':evidence.passed?'completed':'failed',output:evidence.output,exitCode:evidence.exitCode,durationMs:Date.now()-verificationStart});
        owns();
        if(version!==task.requirementVersion){round.status='superseded';this.store.save();continue;}
        this.store.event(id,'verification',evidence.passed?'独立验证通过':'独立验证未通过',evidence.output);
        this.store.patch(id,{summary:'正在核对验证结果。'});
        let next;
        try{next=await this.coordinate('verification_result',task,{roundId:round.id,evidence,report,repairBudgetRemaining:this.config.maxRepairs-repairs},signal);}
        catch(e){if(!signal.aborted&&task.requirementVersion!==version){round.status='superseded';this.store.save();continue;}throw e;}
        if(this.managementStop(next,task))return;
        if(next.type==='observe'){next.apply(()=>{round.status='verification_failed';this.store.save();});throw Error(`自动修复 ${this.config.maxRepairs} 次后验证仍未通过，请查看证据。`);}
        if(next.type==='submit_delivery'){
          next.apply(()=>{
          round.status='review';round.finishedAt=now();
          task.deliveries.push({id:randomUUID(),version,roundId:round.id,sessionId:round.sessionId,summary:report.summary,acceptance:[...task.acceptance],artifacts:[...task.artifacts],evidence:structuredClone(evidence),dependencies:structuredClone(round.dependencies),at:now()});
          this.store.patch(id,{status:'review',summary:report.summary,completedAt:now(),durationMs:Date.now()-start,deferredUntil:null});
          this.store.event(id,'delivery','成果已准备好，等待验收',`要求版本 v${version}`);});return;
        }
        next.apply(()=>{round.status='verification_failed';repairs++;this.store.save();});
      }
    } catch(err){
      const requeue=this.active?.requeue&&!this.closing;
      if(this.active){for(const c of this.active.tools.values())c.abort();this.rejectPending(id,'执行已停止');await Promise.allSettled([...this.active.toolPromises,this.commandQueue]);}
      for(const r of task.rounds)if(r.status==='running')r.status=signal.aborted?'interrupted':'failed';
      this.store.patch(id,{status:requeue?'queued':signal.aborted?'paused':'failed',decision:null,summary:requeue?'已按最新要求重新排队。':signal.aborted?'执行已停止，进度已保留。':err.message});
      this.store.event(id,signal.aborted?'paused':'error',signal.aborted?'执行已停止':'执行需要处理',err.message);
    } finally{
      if(this.active&&(this.active.tools.size||this.pending.size||this.commandCount)){this.active.controller.abort();this.rejectPending(id,'执行已结束');await Promise.allSettled([...this.active.toolPromises,this.commandQueue]);}
      for(const e of this.store.data.events)if(e.taskId===id&&e.kind==='activity'&&['running','waiting'].includes(e.status))activity(e.id,{status:'interrupted'});
      clearTimeout(this.deadline?.timer);this.deadline=null;this.grants.delete(id);this.rejectPending(id,'执行已结束');this.store.save();
    }
  }
  managementStop(operation,task) {
    if(operation.type==='request_decision') {operation.apply(()=>{const round=task.rounds.at(-1);if(round?.status==='running')round.status='blocked';return this.store.patch(task.id,{status:'blocked',summary:'需要你的决定。',decision:{id:randomUUID(),kind:'business',question:operation.question,recommendation:operation.recommendation||'',options:operation.options}});});return true;}
    if(operation.type==='pause_task'){operation.apply(()=>this.store.patch(task.id,{status:'stopping',summary:'正在停止执行。'}));this.active.controller.abort();throw Error('管理安排暂停');}
    return false;
  }
  async close() {
    this.closing = true; this.managerController?.abort();
    if(this.scheduling){this.scheduling.controller.abort();await this.scheduling.promise;}
    if (this.active) { this.active.controller.abort(); this.rejectPending(this.active.id, '服务关闭'); await this.active.promise; }
    await this.backend.close?.();
  }
}
