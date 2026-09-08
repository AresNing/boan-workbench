import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {fingerprint} from '../server/task-lifecycle.mjs';

async function fixture(t){
  const dir=await fs.mkdtemp('/tmp/boan-operations-'),project={path:dir,mode:'demo'};
  const config={projectPath:dir,dataDir:path.join(dir,'data'),mode:'demo'},store=new Store(config.dataDir,project);
  const backend={manage:async()=>({reply:'已安排',actions:[]}),replaceSession:async()=>{}};
  const engine=new Engine(store,backend,config);engine.tick=()=>{};
  t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});
  return {store,engine,backend,config,project};
}

test('新建、修订、暂停、投递和替换共享操作身份、目标与实际回执',async t=>{
  const {engine,store,backend,config,project}=await fixture(t);
  backend.manage=async()=>({reply:'已安排',actions:[{type:'create_task',text:'目标'}]});
  await engine.message('目标',null,'create-input');const task=store.data.tasks[0];
  await engine.action(task.id,'amend',{operationId:'revise',text:'增加约束'});
  await engine.action(task.id,'deliver_update',{operationId:'deliver',expectedVersion:task.stateVersion,updateId:task.updates.at(-1).id});
  await engine.action(task.id,'pause',{operationId:'pause'});
  await engine.action(task.id,'replace_session',{operationId:'replace',expectedVersion:task.stateVersion,replacementCause:'context',reason:'核对当前文件'});
  const records=Object.values(store.data.management.operations);
  assert.deepEqual(records.map(r=>r.type),['create_task','revise_task','deliver_update','pause_task','replace_session']);
  assert.ok(records.every(r=>r.status==='completed'&&r.expectedVersion>0&&r.target.id&&r.result.stateVersion>0&&r.finishedAt));
  assert.equal(records[0].target.kind,'project');assert.equal(records[0].result.projectVersion,2);
  assert.equal(records[2].result.status,'saved');assert.equal(records[3].result.status,'paused');
  assert.equal(store.data.actions.revise,store.data.management.operations.revise);
  await assert.rejects(engine.action(task.id,'deliver_update',{operationId:'revise',expectedVersion:task.stateVersion,updateId:task.updates.at(-1).id}),/标识冲突/);
  const restored=new Store(config.dataDir,project),second=new Engine(restored,backend,config);second.tick=()=>{};
  await second.action(task.id,'amend',{operationId:'revise',text:'增加约束'});
  assert.equal(restored.task(task.id).requirementVersion,2);assert.equal(restored.data.actions.revise,restored.data.management.operations.revise);
  await second.close();
});

test('规划期间其他任务加入时拒绝旧创建安排，不产生第二份任务',async t=>{
  const {engine,store,backend}=await fixture(t);
  backend.manage=async()=>{store.add('并发建立');return {reply:'旧安排',actions:[{type:'create_task',text:'不应建立'}]};};
  await assert.rejects(engine.message('创建任务',null,'stale-project'),/已过期/);
  assert.equal(store.data.tasks.length,1);assert.equal(store.data.tasks[0].goal,'并发建立');
  assert.equal(store.data.management.operations['stale-project:0'].status,'superseded');
  const disk=JSON.parse(await fs.readFile(store.file,'utf8'));
  assert.equal(disk.requests['stale-project'].plan.actions[0].operationId,'stale-project:0');
  await assert.rejects(engine.message('创建任务',null,'stale-project'),/待核对/);assert.equal(store.data.tasks.length,1);
});

test('规划期间父任务已变更时拒绝旧子任务，父子倒序计划按真实父对象落地',async t=>{
  const {engine,store,backend}=await fixture(t),parent=store.add('父任务');
  backend.manage=async()=>{store.patch(parent.id,{summary:'父任务已改'});return {reply:'创建子任务',actions:[{type:'create_task',text:'过期子任务',parentTaskId:parent.id}]};};
  await assert.rejects(engine.message('子任务',null,'stale-parent'),/父任务状态已变化/);assert.equal(store.data.tasks.length,1);
  backend.manage=async()=>({reply:'父子任务',actions:[{type:'create_task',text:'子任务',ref:'child',parentTaskId:'parent'},{type:'create_task',text:'新父任务',ref:'parent'}]});
  await engine.message('父子任务',null,'family');
  const newParent=store.data.tasks.find(t=>t.goal==='新父任务'),child=store.data.tasks.find(t=>t.goal==='子任务');
  assert.equal(child.parentTaskId,newParent.id);
  const records=Object.values(store.data.management.operations).filter(r=>r.id.startsWith('family:'));
  assert.deepEqual(records.map(r=>r.expectedVersion),[2,3]);assert.equal(store.data.projectVersion,4);
});

test('历史独立操作恢复到统一记录：保留幂等成功，不重放未完成修改',async t=>{
  const {store,engine,config,project}=await fixture(t),task=store.add('已有任务');
  const data={operationId:'legacy-success',text:'已保存'},digest=fingerprint({id:task.id,type:'amend',data:{...data,operationId:undefined}});
  store.data.actions['legacy-success']={id:task.id,type:'amend',digest,status:'completed'};
  store.data.actions['legacy-pending']={id:task.id,type:'amend',digest:'pending-digest',status:'pending'};store.save();
  const restored=new Store(config.dataDir,project),second=new Engine(restored,{},config);second.tick=()=>{};
  assert.equal(restored.task(task.id).status,'paused');assert.equal(restored.data.management.operations['legacy-pending'].status,'uncertain');
  assert.equal(restored.data.management.operations['legacy-success'].expectedVersion,null);
  await second.action(task.id,'amend',data);assert.equal(restored.task(task.id).requirementVersion,1);
  await assert.rejects(second.action(task.id,'amend',{operationId:'legacy-pending',text:'不要重放'}),/标识冲突/);
  await second.close();
});

test('交接期间用户暂停后停止剩余旧安排，不能把新的状态当作旧计划授权',async t=>{
  const {engine,store,backend}=await fixture(t),task=store.add('正在执行');store.patch(task.id,{status:'running'});
  let stop,entered;const stopping=new Promise(r=>{entered=r;});
  const controller=new AbortController();controller.signal.addEventListener('abort',()=>entered());
  engine.active={id:task.id,controller,tools:new Map(),toolPromises:new Set(),promise:new Promise(r=>{stop=r;})};
  backend.manage=async()=>({reply:'交接后调整',actions:[{type:'replace_session',taskId:task.id,replacementCause:'context',reason:'核对现场'},{type:'priority',taskId:task.id,priority:'high'}]});
  const plan=engine.message('继续处理',task.id,'interrupted-plan');await stopping;
  await engine.action(task.id,'pause');store.patch(task.id,{status:'paused'});engine.active=null;stop();
  await assert.rejects(plan,/剩余安排未执行/);assert.equal(task.status,'paused');assert.equal(task.priority,'normal');
  assert.equal(store.data.management.operations['interrupted-plan:0'].status,'superseded');
  assert.equal(store.data.management.operations['interrupted-plan:1'],undefined);
});
