import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {revise} from '../server/task-lifecycle.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function gate(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:(...a)=>resolve(...a)};}
async function fixture(t){
  const dir=await fs.mkdtemp('/tmp/boan-delivery-');
  const config={mode:'demo',projectPath:dir,dataDir:path.join(dir,'data'),updateDeliveryTimeoutMs:100};
  const store=new Store(config.dataDir,{path:dir,mode:'demo'}),backend={};
  const engine=new Engine(store,backend,config);engine.tick=()=>{};
  const task=store.add('保持原任务'),update=revise(task,{text:'已保存的新要求'});store.patch(task.id,{status:'running'});
  task.currentSession={id:'original',status:'ready'};
  engine.active={id:task.id,controller:new AbortController()};
  t.after(async()=>{engine.active?.controller.abort();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,config,store,engine,backend,task,update,data:{expectedVersion:task.stateVersion,updateId:update.id,operationId:'explicit-delivery'}};
}

test('显式投递只发送已保存要求；重投同一操作和已投递要求均不重复发送',async t=>{
  const {store,engine,backend,task,update,data,config}=await fixture(t);let calls=0;
  backend.steer=async(id,text)=>{calls++;assert.equal(id,task.id);assert.equal(JSON.parse(text).update.id,update.id);return true;};
  await engine.action(task.id,'deliver_update',data);
  assert.equal(update.status,'delivered');assert.equal(task.requirementVersion,2);assert.equal(task.rounds.length,0);assert.equal(task.sessions.length,0);assert.equal(store.data.tasks.length,1);
  await engine.action(task.id,'deliver_update',data);
  await engine.action(task.id,'deliver_update',{...data,operationId:'second-id'});assert.equal(calls,1);
  const record=store.data.management.operations[data.operationId];assert.equal(record.result.status,'delivered');assert.equal(record.type,'deliver_update');assert.equal(record.expectedVersion,data.expectedVersion);
  const restored=new Store(config.dataDir,{path:config.projectPath,mode:'demo'});assert.equal(restored.data.management.operations[data.operationId].result.status,'delivered');
});

test('未运行或运输层未发送时保持已保存；模型不能宣称已接收',async t=>{
  const {engine,backend,task,update,data}=await fixture(t);backend.steer=async()=>false;
  backend.manage=async()=>({reply:'执行者已完全接收并处理',actions:[{type:'deliver_update',taskId:task.id,...data}]});
  const result=await engine.message('投递已保存要求',task.id,'input-delivery');
  assert.equal(update.status,'saved');assert.match(result.reply,/等待执行者读取/);assert.doesNotMatch(result.reply,/已完全接收/);
  engine.active=null;backend.steer=async()=>{throw Error('不得启动执行');};
  await engine.action(task.id,'deliver_update',{...data,operationId:'no-executor'});assert.equal(update.status,'saved');
});

test('投递前拒绝错误目标要求与过期版本，不产生运输调用',async t=>{
  const {engine,backend,task,update,data}=await fixture(t);let calls=0;backend.steer=async()=>{calls++;};
  await assert.rejects(engine.action(task.id,'deliver_update',{...data,expectedVersion:0}),/最新任务状态版本/);
  await assert.rejects(engine.action(task.id,'deliver_update',{...data,updateId:'another-task-update'}),/最新要求/);
  revise(task,{text:'更晚的要求'});
  await assert.rejects(engine.action(task.id,'deliver_update',data),/最新要求/);assert.equal(calls,0);assert.equal(update.status,'saved');
});

test('投递中的重复请求拒绝，执行者更换后的迟到回执不能标为已投递',async t=>{
  const {engine,backend,store,task,update,data}=await fixture(t),entered=gate(),release=gate();
  backend.steer=async()=>{entered.resolve();return release.promise;};
  const sending=engine.action(task.id,'deliver_update',data);await entered.promise;
  await assert.rejects(engine.action(task.id,'deliver_update',{...data,operationId:'duplicate'}),/正在投递/);
  task.generation++;task.currentSession={id:'replacement'};release.resolve(true);await sending;
  assert.equal(update.status,'saved');assert.equal(store.data.management.operations[data.operationId].status,'superseded');
});

test('运输超时保留不确定回执，重启与迟到完成均不自动重发或伪造接收',async t=>{
  const {engine,backend,store,task,update,data,config}=await fixture(t),release=gate();let calls=0;
  backend.steer=async()=>{calls++;return release.promise;};
  await assert.rejects(engine.action(task.id,'deliver_update',data),/超时/);
  assert.equal(store.data.management.operations[data.operationId].status,'uncertain');
  release.resolve(true);await sleep(10);assert.equal(update.status,'saved');
  await assert.rejects(engine.action(task.id,'deliver_update',data),/待核对/);assert.equal(calls,1);
  const restored=new Store(config.dataDir,{path:config.projectPath,mode:'demo'});assert.equal(restored.task(task.id).status,'paused');assert.equal(restored.data.management.operations[data.operationId].status,'uncertain');
});

test('已记录的接收状态优先于较晚的运输回执，暂停不冒充投递成功',async t=>{
  const {engine,backend,store,task,update,data}=await fixture(t),entered=gate(),release=gate();
  backend.steer=async()=>{entered.resolve();return release.promise;};
  const sending=engine.action(task.id,'deliver_update',data);await entered.promise;
  update.status='received';update.receivedAt=new Date().toISOString();store.save();release.resolve(true);await sending;
  assert.equal(update.status,'received');assert.equal(store.data.management.operations[data.operationId].result.status,'received');
  const next=revise(task,{text:'暂停边界的新要求'});backend.steer=async()=>new Promise(()=>{});
  const stopped=engine.action(task.id,'deliver_update',{operationId:'stop',updateId:next.id,expectedVersion:task.stateVersion});
  engine.active.controller.abort();await assert.rejects(stopped,/停止/);assert.equal(next.status,'saved');assert.equal(store.data.management.operations.stop.status,'uncertain');
});
