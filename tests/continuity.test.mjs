import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {Store} from '../server/store.mjs';import {Engine} from '../server/engine.mjs';import {PiBackend} from '../server/pi.mjs';
import {defaultEventOperation} from '../server/management.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await sleep(10);}throw Error('continuity timeout');}
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
class Scripted extends PiBackend {
 constructor(config,script){super(config);this.script=script;this.created=0;this.turn=0;}
 async session(key,tools,_prompt,_signal,onEvent){
  this.created++;let valid=true;this.invalidate=()=>{valid=false;};const session={sessionId:`session-${this.created}`,messages:[],isStreaming:false,prompt:async text=>{session.isStreaming=true;const n=++this.turn;try{await this.script({task:JSON.parse(text).task,n,call:(name,args={},id=`${n}-${name}`)=>tools.find(t=>t.name===name).execute(id,args),backend:this});}finally{session.isStreaming=false;}},steer:async text=>{this.update=JSON.parse(text);}};
  this.sessions.set(key,session);return {session,usable:()=>valid,exhausted:()=>false,interrupt:async()=>{},close:()=>this.sessions.delete(key)};
 }
}
async function fixture(t,script){const dir=await fs.mkdtemp('/tmp/boan-continuity-'),projectPath=path.join(dir,'project');await fs.mkdir(projectPath);const config={mode:'demo',dataDir:path.join(dir,'data'),projectPath,maxRepairs:1,maxTurns:10,runTimeoutMs:10000};const project={path:projectPath,mode:'demo'};const store=new Store(config.dataDir,project),backend=new Scripted(config,script),engine=new Engine(store,backend,config);t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});return {store,backend,engine,config,project};}
const report=call=>call('submit_result',{summary:'ready',verificationCommand:'test -f result.txt'});

test('显式上下文替换等待实际停止，同任务交接并拒绝旧执行者写入',async t=>{
 const entered=gate(),release=gate();let oldCall,handed;
 const {store,engine,backend,config}=await fixture(t,async({task,call,n})=>{
   if(n===1){await call('write_file',{path:'result.txt',content:'preserved'});oldCall=call;entered.resolve();await release.promise;return;}
   handed=task.handoffs.at(-1);const value=(await call('read_file',{path:'result.txt'})).content[0].text;assert.equal(value,'preserved');await report(call);
 });
 const task=store.add('原任务');engine.tick();await entered.promise;
 const data={operationId:'replace-one',expectedVersion:task.stateVersion,replacementCause:'context',reason:'原上下文不适用，保留已完成文件并重新核对'};
 const replacement=engine.action(task.id,'replace_session',data);
 assert.equal(task.status,'stopping');assert.equal(task.handoffs.length,0);assert.equal(backend.created,1);
 await assert.rejects(oldCall('write_file',{path:'late.txt',content:'wrong'}),/失效|中止/);
 release.resolve();await replacement;await until(()=>task.status==='review'||task.status==='failed');
 assert.equal(task.status,'review',task.summary);assert.equal(store.data.tasks.length,1);assert.equal(task.sessions.length,2);assert.equal(backend.created,2);assert.equal(task.requirementVersion,1);assert.ok(handed.artifacts.includes('result.txt'));assert.match(task.handoffs[0].reason,/原上下文不适用/);
 assert.equal(store.data.management.operations['replace-one'].status,'completed');assert.ok(store.data.management.operations['replace-one'].result.handoffId);
 await engine.action(task.id,'replace_session',data);assert.equal(backend.created,2);await assert.rejects(fs.access(path.join(config.projectPath,'late.txt')));
});

test('替换期间的新要求优先，不丢弃原上下文；空闲暂停任务不自行恢复',async t=>{
 const entered=gate(),release=gate();
 const {store,engine,backend}=await fixture(t,async({call,n})=>{if(n===1){entered.resolve();await release.promise;return;}await call('write_file',{path:'result.txt',content:'new'});await report(call);});
 const task=store.add('保留任务');engine.tick();await entered.promise;
 const replacing=engine.action(task.id,'replace_session',{operationId:'replace-change',expectedVersion:task.stateVersion,replacementCause:'isolation',reason:'重新核对工作环境'});
 await engine.action(task.id,'amend',{text:'更优先的新要求'});release.resolve();await replacing;await until(()=>task.status==='review'||task.status==='failed');
 assert.equal(task.status,'review',task.summary);assert.equal(backend.created,1);assert.equal(task.requirementVersion,2);assert.equal(store.data.management.operations['replace-change'].status,'superseded');
 await until(()=>!engine.active);
 await engine.action(task.id,'amend',{text:'再次继续'});await until(()=>!engine.active);
 // An idle paused task must remain paused even when its cached worker is replaced.
 store.patch(task.id,{status:'paused'});
 await engine.action(task.id,'replace_session',{operationId:'replace-paused',expectedVersion:task.stateVersion,replacementCause:'context',reason:'下一次恢复时使用新的上下文'});
 assert.equal(task.status,'paused');assert.equal(task.currentSession.status,'replaced');
});

test('管理模型显式替换待验收上下文，不自动验收、不清空交付；错误版本与决定绕过拒绝',async t=>{
 const {store,engine,backend}=await fixture(t,async({call})=>{await call('write_file',{path:'result.txt',content:'kept'});await report(call);});
 const task=store.add('交付边界');engine.tick();await until(()=>task.status==='review');await until(()=>!engine.active);
 const delivery=structuredClone(task.deliveries[0]);
 backend.manage=async()=>({reply:'下次执行使用新上下文',actions:[{type:'replace_session',taskId:task.id,expectedVersion:task.stateVersion,replacementCause:'engine',reason:'切换执行环境前保存交接'}]});
 await engine.message('保留成果，准备换执行环境',task.id,'replace-plan');assert.equal(task.status,'review');assert.deepEqual(task.deliveries[0],delivery);assert.equal(task.acceptedAt,undefined);assert.equal(backend.created,1);
 await assert.rejects(engine.action(task.id,'replace_session',{expectedVersion:0,replacementCause:'context',reason:'bad'}),/最新任务状态版本/);
 store.patch(task.id,{status:'blocked',decision:{kind:'recovery'}});
 await assert.rejects(engine.action(task.id,'replace_session',{expectedVersion:task.stateVersion,replacementCause:'context',reason:'跳过不确定结果'}),/不能通过替换会话绕过/);
});

test('替换等待旧执行时用户暂停，确认停止后保持暂停，不启动新执行者',async t=>{
 const entered=gate(),release=gate();
 const {store,engine,backend}=await fixture(t,async()=>{entered.resolve();await release.promise;});
 const task=store.add('暂停优先');engine.tick();await entered.promise;
 const replacing=engine.action(task.id,'replace_session',{operationId:'replace-pause',expectedVersion:task.stateVersion,replacementCause:'context',reason:'需要新上下文'});
 await engine.action(task.id,'pause');assert.equal(task.status,'stopping');assert.equal(task.handoffs.length,0);
 release.resolve();await replacing;await until(()=>!engine.active);assert.equal(task.status,'paused');assert.equal(backend.created,1);assert.equal(task.handoffs.length,0);assert.equal(store.data.management.operations['replace-pause'].status,'superseded');
});

test('会话替换取消原命令审批，新执行者必须重新申请，旧批准不可重放',async t=>{
 const {store,engine,backend,config}=await fixture(t,async({call})=>{
   await call('run_command',{command:'touch result.txt',permission:'local',reason:'测试仅本次执行'});await report(call);
 });
 config.mode='pi';backend.coordinate=async e=>defaultEventOperation(e);
 const task=store.add('审批交接');engine.tick();await until(()=>task.decision?.kind==='command');
 const oldDecision=task.decision.id;
 await engine.action(task.id,'replace_session',{operationId:'replace-approval',expectedVersion:task.stateVersion,replacementCause:'context',reason:'停止旧执行并重新核对命令'});
 await until(()=>task.decision?.kind==='command');assert.notEqual(task.decision.id,oldDecision);assert.equal(engine.pending.has(oldDecision),false);assert.equal(engine.grants.has(task.id),false);
 await assert.rejects(engine.action(task.id,'decision',{decisionId:oldDecision,answer:'允许本次执行'}),/已变化/);
 await assert.rejects(fs.access(path.join(config.projectPath,'result.txt')));
 await engine.action(task.id,'decision',{decisionId:task.decision.id,answer:'允许本次执行'});await until(()=>task.status==='review'||task.status==='failed');assert.equal(task.status,'review',task.summary);assert.equal(task.sessions.length,2);
});

test('执行中补充先保存，再投递及确认；复用同一主会话，拒绝旧要求写入',async t=>{
 const started=gate(),next=gate();let writes=0;
 const {store,backend,engine,config}=await fixture(t,async({call})=>{
  await call('read_file',{path:'input.txt'});started.resolve();await next.promise;
  await assert.rejects(call('write_file',{path:'wrong.txt',content:'old'}),/要求已更新/);
  await assert.rejects(call('acknowledge_requirements',{version:2}),/读取完整/);
  const task=JSON.parse((await call('read_requirements')).content[0].text);assert.equal(task.requirementVersion,2);
  await call('acknowledge_requirements',{version:2});
  await call('write_file',{path:'result.txt',content:task.constraints.join('\n')});writes++;await report(call);
 });
 await fs.writeFile(path.join(config.projectPath,'input.txt'),'context');const task=store.add('目标');engine.tick();await started.promise;
 await engine.action(task.id,'amend',{text:'中文文件名',operationId:'update-once'});assert.equal(task.updates[0].status,'saved');
 await until(()=>task.updates[0].status==='delivered');assert.equal(task.status,'running');next.resolve();await until(()=>task.status==='review'||task.status==='failed');
 assert.equal(task.status,'review',task.summary);assert.equal(task.updates[0].status,'received');assert.equal(backend.created,1);assert.equal(task.sessions.length,1);assert.equal(task.deliveries[0].version,2);assert.equal(writes,1);await assert.rejects(fs.access(path.join(config.projectPath,'wrong.txt')));
 await engine.action(task.id,'amend',{text:'中文文件名',operationId:'update-once'});assert.equal(task.requirementVersion,2);assert.equal(task.status,'review');
});

test('待验收后的替代与撤销保留历史交付，三轮复用一个会话',async t=>{
 const {store,engine,backend,config}=await fixture(t,async({task,call})=>{await call('write_file',{path:'result.txt',content:task.constraints.join('\n')});await report(call);});
 const task=store.add('目标',{constraints:['CSV','保留接口']});engine.tick();await until(()=>task.status==='review');const first=task.deliveries[0];await until(()=>!engine.active);
 const csv=task.requirements.find(r=>r.text==='CSV').id;
 await engine.action(task.id,'amend',{text:'Excel',change:'replace',requirementIds:[csv]});await until(()=>task.status==='review');await until(()=>!engine.active);
 assert.equal(task.requirements.find(r=>r.id===csv).status,'replaced');assert.deepEqual(task.constraints,['保留接口','Excel']);assert.equal(first.version,1);assert.equal(task.evidence[0].applicability,'superseded');
 await engine.action(task.id,'amend',{text:'撤销接口约束',change:'revoke',requirementIds:[task.requirements.find(r=>r.text==='保留接口').id]});await until(()=>task.status==='review');
 assert.equal(backend.created,1);assert.equal(task.rounds.length,3);assert.equal(task.deliveries.length,3);assert.equal(await fs.readFile(path.join(config.projectPath,'result.txt'),'utf8'),'Excel');
});

test('旧验证完成不能交付新要求；修复与续接均有上限',async t=>{
 const checking=gate();const {store,engine,backend}=await fixture(t,async({call})=>{await call('write_file',{path:'result.txt',content:'ok'});await call('submit_result',{summary:'ready',verificationCommand:'sleep 0.2; test -f result.txt'});});
 const task=store.add('目标');store.on('change',()=>{if(task.status==='verifying')checking.resolve();});engine.tick();await checking.promise;
 await engine.action(task.id,'amend',{text:'补充验收'});await until(()=>task.status==='review'||task.status==='failed');assert.equal(task.status,'review',task.summary);
 assert.equal(task.deliveries.length,1);assert.equal(task.deliveries[0].version,2);assert.equal(task.evidence[0].applicability,'superseded');assert.equal(backend.created,1);
});

test('工具重复投递不重写文件；旧执行者回调不能在暂停后写入',async t=>{
 const held=gate(),release=gate();let oldCall;
 const {store,engine,config}=await fixture(t,async({call})=>{
  await call('write_file',{path:'result.txt',content:'first'},'same');await fs.writeFile(path.join(config.projectPath,'result.txt'),'external');
  await call('write_file',{path:'result.txt',content:'first'},'same');oldCall=call;held.resolve();await release.promise;
 });
 const task=store.add('目标');engine.tick();await held.promise;await engine.action(task.id,'pause');assert.equal(task.status,'stopping');
 await assert.rejects(oldCall('write_file',{path:'late.txt',content:'stale'},'late'),/失效|中止/);release.resolve();await until(()=>task.status==='paused');
 assert.equal(await fs.readFile(path.join(config.projectPath,'result.txt'),'utf8'),'external');await assert.rejects(fs.access(path.join(config.projectPath,'late.txt')));
});

test('请求幂等、过期状态拒绝，管理模型不能代替用户验收',async t=>{
 const {store,engine,backend}=await fixture(t,async({call})=>{await call('write_file',{path:'result.txt',content:'ok'});await report(call);});
 let calls=0;backend.manage=async()=>{calls++;return {reply:'已安排',actions:[{type:'create',text:'目标'}]};};
 await engine.message('新目标',null,'same-input');await engine.message('新目标',null,'same-input');assert.equal(calls,1);assert.equal(store.data.tasks.length,1);
 const task=store.data.tasks[0];await until(()=>task.status==='review');await assert.rejects(engine.action(task.id,'priority',{priority:'high',expectedVersion:0}),/状态已变化/);
 backend.manage=async()=>({reply:'已验收',actions:[{type:'accept',taskId:task.id}]});await assert.rejects(engine.message('说明进度',task.id,'bad-manager'),/确认完成/);assert.equal(task.status,'review');
});

test('服务恢复保留交接，结果不确定的命令不自动重放，旧审批无效',async t=>{
 const {store,engine,config,project}=await fixture(t,async()=>{});const task=store.add('恢复目标',{status:'running'});
 task.currentSession={id:'previous'};task.artifacts=['result.txt'];task.operations.push({id:'uncertain',tool:'run_command',command:'external operation',status:'started'});task.decision={id:'old',kind:'command'};store.save();
 const restored=new Store(config.dataDir,project), recovered=restored.task(task.id);assert.equal(recovered.status,'paused');assert.equal(recovered.operations[0].status,'uncertain');assert.ok(recovered.handoffs[0].uncertain.length);assert.equal(recovered.decision,null);
 const other=new Engine(restored,{execute(){throw Error('不应执行');}},config);t.after(()=>other.close());await other.action(task.id,'resume');await until(()=>recovered.status==='blocked');assert.equal(recovered.decision.kind,'recovery');await other.action(task.id,'decision',{decisionId:recovered.decision.id,answer:'保持暂停'});assert.equal(recovered.operations[0].status,'uncertain');assert.equal(recovered.status,'paused');await assert.rejects(other.action(task.id,'decision',{decisionId:'old',answer:'允许本次执行'}),/变化/);
});


test('方向改变取消真实在途命令，确认结束后在原会话继续',async t=>{
 const {store,engine,backend,config}=await fixture(t,async({call})=>{
  const result=JSON.parse((await call('run_command',{command:"touch started; sleep 1; touch obsolete",reason:'隔离测试'})).content[0].text);assert.equal(result.aborted,true);
  await call('read_requirements');await call('acknowledge_requirements',{version:2});await call('write_file',{path:'result.txt',content:'new direction'});await report(call);
 });
 const task=store.add('方向',{constraints:['旧方向']});engine.tick();await until(()=>task.operations.some(o=>o.executedAt));
 await engine.action(task.id,'amend',{text:'新方向',change:'replace',requirementIds:[task.requirements.find(r=>r.kind==='constraint').id],impact:'conflict'});
 await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);assert.equal(backend.created,1);await assert.rejects(fs.access(path.join(config.projectPath,'obsolete')));
});

test('会话失效有界交接后自动接手，先核对旧成果；旧执行者不能提交',async t=>{
 let oldCall;
 const {store,engine,backend}=await fixture(t,async({n,call,task,backend})=>{
  if(n===1){await call('write_file',{path:'result.txt',content:'retained'});oldCall=call;backend.invalidate();throw Error('connection lost');}
  assert.ok(task.handoffs.at(-1).artifacts.includes('result.txt'));assert.equal(task.workspaceInspection.artifacts[0].status,'observed');assert.equal(task.workspaceInspection.artifacts[0].size,8);assert.match(task.workspaceInspection.artifacts[0].sha256,/^[a-f0-9]{64}$/);assert.equal(task.workspaceInspection.verified,false);assert.equal(task.handoffs.at(-1).workspaceInspection.artifacts[0].sha256,task.workspaceInspection.artifacts[0].sha256);const result=await call('read_file',{path:'result.txt'});assert.equal(result.content[0].text,'retained');await report(call);
 });
 const task=store.add('失效恢复');engine.tick();await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);assert.equal(backend.created,2);assert.equal(task.sessions.length,2);
 await assert.rejects(oldCall('submit_result',{summary:'stale',verificationCommand:'true'}),/失效|中止/);assert.equal(task.deliveries.length,1);
});

test('验证持续失败达到预算后停止，不无限重试或自动验收',async t=>{
 const {store,engine,backend}=await fixture(t,async({call})=>{await call('write_file',{path:'result.txt',content:'needs repair'});await call('submit_result',{summary:'candidate',verificationCommand:'false'});});
 const task=store.add('失败修复');engine.tick();await until(()=>task.status==='failed');assert.equal(task.attempts,2);assert.equal(task.deliveries.length,0);assert.equal(task.evidence.length,2);assert.equal(backend.created,1);
});


test('旧数据迁移保留已验收交付和旧会话，失败的未执行输入允许同标识重试',async t=>{
 const {store,engine,backend,config,project}=await fixture(t,async({call})=>{await call('write_file',{path:'result.txt',content:'new'});await report(call);});
 let attempts=0;backend.manage=async()=>{if(!attempts++)throw Error('temporary');return {reply:'ok',actions:[{type:'create',text:'retry'}]};};
 await assert.rejects(engine.message('retry',null,'retry-id'),/temporary/);await engine.message('retry',null,'retry-id');assert.equal(store.data.tasks.length,1);assert.equal(store.data.messages.filter(m=>m.role==='user').length,1);await until(()=>store.data.tasks[0].status==='review');await until(()=>!engine.active);
 const old={...store.data.tasks[0],id:'legacy',status:'done',summary:'历史成果',sessions:[{id:'legacy-session'}],acceptedAt:'2026-09-07T00:00:00Z'};for(const k of ['requirements','requirementVersion','stateVersion','rounds','deliveries','currentSession','updates','generation','handoffs','operations'])delete old[k];store.data.tasks=[old];store.save();
 const migrated=new Store(config.dataDir,project).task('legacy');assert.equal(migrated.deliveries[0].summary,'历史成果');assert.equal(migrated.deliveries[0].source,'legacy');assert.equal(migrated.handoffs[0].fromSession,'legacy-session');assert.equal(migrated.status,'done');
});

test('执行者提前退出时，调度必须等待实际在途工具停止后才能运行下一个任务',async t=>{
 const {store,engine}=await fixture(t,async()=>{});let ended=false,started=0;
 engine.backend={execute:async(task,ctx)=>{started++;if(started===1){void ctx.tool('unfinished','run_command',{command:'sleep 1'},async signal=>{try{await sleep(40);if(signal.aborted)throw Error('cancelled');return await ctx.command('sleep 1','test','workspace',{signal});}finally{ended=true;}}).catch(()=>{});return null;}assert.equal(ended,true);return {summary:'next',verificationCommand:'true'};}};
 const first=store.add('提前退出'),second=store.add('下一个任务');engine.tick();await until(()=>second.status==='review');assert.equal(first.status,'failed');assert.equal(ended,true);assert.equal(started,2);
});
