import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {Store} from '../server/store.mjs';import {Engine} from '../server/engine.mjs';import {ProjectManager} from '../server/management.mjs';
import {coordinationForPrompt} from './helpers/coordination.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<800;n++){if(fn())return;await sleep(10);}throw Error('management timeout');}
function gate(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:(...args)=>resolve(...args)};}
const propose=e=>coordinationForPrompt(JSON.stringify({managementEvent:e}));
async function fixture(t,coordinate) {
  const dir=await fs.mkdtemp('/tmp/boan-management-'),projectPath=path.join(dir,'project');await fs.mkdir(projectPath);
  const config={mode:'pi',projectPath,dataDir:path.join(dir,'data'),maxRepairs:1,maxTurns:6,runTimeoutMs:10000,managementTimeoutMs:5000};
  const store=new Store(config.dataDir,{path:projectPath,mode:'pi'}),seen=[];
  const backend={manage:async()=>({reply:'已安排',actions:[{type:'create_task',text:'测试目标'}]}),execute:async(task,ctx)=>{ctx.session(`main-${task.id}`);return {summary:'候选成果',verificationCommand:'true'};},coordinate:async(e,state,signal)=>{seen.push(e);return coordinate?coordinate(e,state,signal):propose(e);}};
  const engine=new Engine(store,backend,config);t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});return {store,engine,backend,seen,config};
}

test('管理 Agent 选择验证命令及有界修复，事件与实际操作回执持久化',async t=>{
  let executions=0;
  const {engine,store,seen}=await fixture(t,e=>e.type==='execution_result'?{...propose(e),command:++executions===1?'false':'true'}:propose(e));
  await engine.message('安排工作',null,'one-input');const task=store.data.tasks[0];await until(()=>task.status==='review');
  assert.deepEqual(seen.map(e=>e.type),['task_ready','execution_result','verification_result','execution_result','verification_result']);
  assert.equal(task.evidence[0].passed,false);assert.equal(task.evidence[1].passed,true);assert.equal(task.attempts,2);assert.equal(task.deliveries.length,1);assert.equal(task.acceptedAt,undefined);
  assert.ok(Object.values(store.data.management.operations).every(o=>o.status==='completed'&&o.expectedVersion>0&&o.result.stateVersion>0));
  const saved=JSON.parse(await fs.readFile(store.file,'utf8'));assert.equal(saved.management.events[0].type,'user_input');assert.equal(saved.management.events[0].status,'completed');
  await engine.message('安排工作',null,'one-input');assert.equal(store.data.tasks.length,1);
});

test('等待管理安排时追加要求，旧回复失效，只验证和交付最新版本',async t=>{
  const entered=gate(),release=gate();let held=false;
  const {engine,store}=await fixture(t,async e=>{if(e.type==='execution_result'&&!held){held=true;entered.resolve();await release.promise;}return propose(e);});
  const task=store.add('目标');engine.tick();await entered.promise;await engine.action(task.id,'amend',{text:'新要求'});release.resolve();await until(()=>task.status==='review'||task.status==='failed');
  assert.equal(task.status,'review',task.summary);assert.equal(task.deliveries[0].version,2);assert.equal(task.evidence.length,1);assert.equal(task.evidence[0].requirementVersion,2);
  assert.ok(store.data.management.events.some(e=>e.status==='superseded'));assert.equal(task.sessions.length,1);
});

test('管理模型不能跳过验证或把失败证据提交为成果',async t=>{
  const {engine,store}=await fixture(t,e=>e.type==='execution_result'?{...propose(e),type:'submit_delivery'}:propose(e));
  const task=store.add('越权交付');engine.tick();await until(()=>task.status==='failed');assert.equal(task.deliveries.length,0);assert.equal(task.evidence.length,0);
  assert.match(task.summary,/不能代替用户验收或跳过验证/);
});

test('预算用尽的验证事件仍被记录，模型不得安排无限修复',async t=>{
  const {engine,store,backend,seen,config}=await fixture(t,e=>e.type==='verification_result'?{...propose(e),type:'dispatch_task'}:propose(e));config.maxRepairs=0;
  backend.execute=async()=>({summary:'未通过',verificationCommand:'false'});const task=store.add('预算边界');engine.tick();await until(()=>task.status==='failed');
  assert.equal(task.attempts,1);assert.equal(task.evidence.length,1);assert.match(task.summary,/预算已用尽/);assert.ok(seen.some(e=>e.type==='verification_result'));assert.equal(task.deliveries.length,0);
});

test('管理模型提出越界验证命令，宿主仍要求单次批准；拒绝后文件不产生',async t=>{
  const {engine,store,config}=await fixture(t,e=>e.type==='execution_result'?{...propose(e),command:'touch forbidden',permission:'local'}:propose(e));
  const task=store.add('权限边界');engine.tick();await until(()=>task.decision?.kind==='command');assert.equal(task.decision.scope,'local');assert.equal(task.evidence.length,0);
  await engine.action(task.id,'decision',{decisionId:task.decision.id,answer:'拒绝并暂停'});await until(()=>task.status==='paused');await assert.rejects(fs.access(path.join(config.projectPath,'forbidden')));
});

test('暂停传播到正在等待的管理模型，不再启动任务执行',async t=>{
  const entered=gate();let cancelled=false,executed=0;
  const {engine,store,backend}=await fixture(t,async(e,_s,signal)=>{entered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(Error('aborted'));},{once:true}));});
  backend.execute=async()=>{executed++;};const task=store.add('暂停调度');engine.tick();await entered.promise;await engine.action(task.id,'pause');await until(()=>!engine.scheduling);
  assert.equal(cancelled,true);assert.equal(executed,0);assert.equal(task.status,'paused');
});

test('必要业务决定保留在原任务，确认后复用主执行上下文',async t=>{
  let asked=false;
  const {engine,store}=await fixture(t,e=>{if(e.type==='execution_result'&&!asked){asked=true;return {...propose(e),type:'request_decision',question:'导出哪些字段？',options:['公开字段','全部业务字段']};}return propose(e);});
  const task=store.add('业务决定');engine.tick();await until(()=>task.status==='blocked');await until(()=>!engine.active);assert.equal(task.rounds[0].status,'blocked');
  await engine.action(task.id,'decision',{decisionId:task.decision.id,answer:'公开字段'});await until(()=>task.status==='review');assert.equal(task.sessions.length,1);assert.equal(task.decisions[0].answer,'公开字段');
});

test('持久操作回执防止重复应用，过期效果拒绝，崩溃中的安排不自动重放',async t=>{
  const {store,config}=await fixture(t),task=store.add('持久安排'),signal=new AbortController().signal;
  const manager=new ProjectManager(store,{coordinate:async e=>propose(e)},config);let effects=0;
  const op=await manager.decide('task_ready',task,{},signal);op.apply(()=>{effects++;store.patch(task.id,{summary:'安排已保存'});});op.apply(()=>{effects++;});assert.equal(effects,1);
  const stale=await manager.decide('task_ready',task,{},signal);store.patch(task.id,{priority:'high'});assert.throws(()=>stale.apply(()=>{effects++;}),/已过期/);assert.equal(effects,1);
  const interrupted=await manager.decide('task_ready',task,{},signal);assert.ok(interrupted);
  const restored=new Store(config.dataDir,{path:config.projectPath,mode:'pi'});assert.equal(restored.task(task.id).status,'paused');assert.ok(Object.values(restored.data.management.operations).some(o=>o.status==='uncertain'));
});

test('输入安排执行到一半时重启，已修改的原任务也先暂停核对',async t=>{
  const {store,config}=await fixture(t),task=store.add('已有任务');
  store.data.requests.partial={status:'applying',plan:{actions:[{type:'amend',taskId:task.id,text:'已保存但安排未完成'}]}};store.save();
  const restored=new Store(config.dataDir,{path:config.projectPath,mode:'pi'});assert.equal(restored.task(task.id).status,'paused');assert.equal(restored.data.requests.partial.status,'uncertain');
});
