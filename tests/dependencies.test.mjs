import {coordinationForPrompt} from './helpers/coordination.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { PiBackend } from '../server/pi.mjs';
import { currentDelivery } from '../server/dependencies.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 800; n++) { if (check()) return; await sleep(10); } throw Error('dependency timeout'); }
async function fixture(t, script) {
  const dir = await fs.mkdtemp('/tmp/boan-dependencies-'), projectPath = path.join(dir, 'project'); await fs.mkdir(projectPath);
  const config = { mode:'demo', projectPath, dataDir:path.join(dir,'data'), maxRepairs:0, maxTurns:8, runTimeoutMs:8000 };
  const project = {path:projectPath,mode:'demo'}, store = new Store(config.dataDir,project);
  class Scripted extends PiBackend {
    async coordinate(event){return coordinationForPrompt(JSON.stringify({managementEvent:event}));}
    async session(key, tools) {
      let turn = 0;
      const session = {sessionId:key,messages:[],prompt:async text => {
        const task = JSON.parse(text).task, n = ++turn;
        await script(task, (name, args = {}) => tools.find(t => t.name === name).execute(`${n}:${name}`,args), config);
      }};
      return {session,exhausted:()=>false,interrupt:async()=>{},close:()=>{}};
    }
  }
  const backend = new Scripted(config), engine = new Engine(store,backend,config);
  t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});
  return {store,engine,backend,config,project};
}
async function set(engine, store, target, sources, mode = 'verified', operationId) {
  return engine.action(target.id,'set_dependency',{expectedVersion:target.stateVersion,operationId,
    dependencies:sources.map(source=>({taskId:source.id,expectedVersion:store.task(source.id).stateVersion,mode}))});
}
async function complete(task, call) {
  await call('write_file',{path:`${task.title}.txt`,content:JSON.stringify({version:task.requirementVersion,sources:task.dependencyContext || []})});
  await call('submit_result',{summary:task.title,verificationCommand:`test -f '${task.title}.txt'`});
}

test('上游最新验证成果自动解锁高优先级下游，执行轮次保留来源而非共享会话', async t => {
  const order = [], {store,engine} = await fixture(t,async(task,call)=>{order.push(task.title);await complete(task,call);});
  const downstream = store.add('B',{priority:'high'}), upstream = store.add('A');
  await set(engine,store,downstream,[upstream]);
  await until(()=>downstream.status==='review');
  assert.deepEqual(order,['A','B']); assert.equal(upstream.status,'review');
  assert.notEqual(upstream.sessions[0].id,downstream.sessions[0].id);
  assert.equal(downstream.deliveries[0].dependencies[0].deliveryId,upstream.deliveries[0].id);
  assert.equal(downstream.deliveries[0].dependencies[0].verified,true);
  assert.equal(downstream.deliveries[0].dependencies[0].scope,'上游任务的验收标准');
});

test('明确等待用户验收的依赖不会以模型完成或仅验证通过解锁',async t=>{
  const {store,engine} = await fixture(t,complete), b=store.add('B'),a=store.add('A');
  await set(engine,store,b,[a],'accepted'); await until(()=>a.status==='review'&&!engine.active);
  assert.equal(b.attempts,0);assert.match(b.summary,/确认完成/);
  await engine.action(a.id,'accept');await until(()=>b.status==='review');assert.equal(b.dependencyContext[0].accepted,true);
});

test('拒绝自身依赖、成环、过期来源和同一管理计划中的联合成环，失败前不写入依赖',async t=>{
  const {store,engine,backend}=await fixture(t,complete),a=store.add('A',{status:'paused'}),b=store.add('B',{status:'paused'});
  await assert.rejects(set(engine,store,a,[a]),/自身/);
  await set(engine,store,b,[a]);await assert.rejects(set(engine,store,a,[b]),/成环/);
  await assert.rejects(engine.action(a.id,'set_dependency',{expectedVersion:a.stateVersion,dependencies:[{taskId:b.id,expectedVersion:0}]}),/上游任务状态/);
  await set(engine,store,b,[]);
  backend.manage=async()=>({reply:'安排',actions:[{type:'set_dependency',taskId:a.id,dependencies:[{taskId:b.id}]},{type:'set_dependency',taskId:b.id,dependencies:[{taskId:a.id}]}]});
  await assert.rejects(engine.message('相互依赖',null,'cycle-plan'),/成环/);
  assert.deepEqual(a.dependencies,[]);assert.deepEqual(b.dependencies,[]);
});

test('上游更新级联撤销下游证据适用性，重新执行和验证，保留历史验收',async t=>{
  const {store,engine}=await fixture(t,complete), a=store.add('A',{status:'paused'}),b=store.add('B'),c=store.add('C');
  engine.managerBusy=true;await set(engine,store,b,[a]);await set(engine,store,c,[b]);engine.managerBusy=false;
  await engine.action(a.id,'resume');await until(()=>c.status==='review'&&!engine.active);
  await engine.action(b.id,'accept');await engine.action(c.id,'accept');const oldB=b.deliveries[0],oldC=c.deliveries[0];
  engine.managerBusy=true;await engine.action(a.id,'amend',{text:'改用新输入'});
  assert.equal(b.status,'queued');assert.equal(c.status,'queued');assert.equal(oldB.applicability,'superseded');assert.equal(oldC.applicability,'superseded');
  assert.ok(oldB.acceptedAt);assert.ok(oldC.acceptedAt);assert.equal(b.acceptedAt,undefined);assert.equal(currentDelivery(c),null);
  engine.managerBusy=false;engine.tick();await until(()=>c.status==='review'&&!engine.active);
  assert.equal(b.deliveries.length,2);assert.equal(c.deliveries.length,2);assert.equal(b.sessions.length,1);
  assert.equal(c.deliveries[1].dependencies[0].deliveryId,b.deliveries[1].id);
  assert.equal(b.deliveries[1].dependencies[0].requirementVersion,2);
});

test('依赖变化中止下游真实在途命令，清除旧审批，独立任务继续推进',async t=>{
  let running=false;
  const {store,engine,config}=await fixture(t,async(task,call)=>{
    if(task.title==='B') {running=true;await call('run_command',{command:'sleep 0.7; touch obsolete',reason:'隔离测试'});}
    await complete(task,call);
  });
  const a=store.add('A'),b=store.add('B'),c=store.add('C');await set(engine,store,b,[a]);
  await until(()=>running&&b.operations.some(o=>o.executedAt));
  engine.managerBusy=true;await engine.action(a.id,'amend',{text:'上游变化'});await engine.action(a.id,'pause');engine.managerBusy=false;
  await until(()=>c.status==='review'&&!engine.active);
  assert.equal(b.status,'queued');assert.ok(b.dependencyWait.length);assert.equal(b.deliveries.length,0);assert.equal(b.decision,null);
  await assert.rejects(fs.access(path.join(config.projectPath,'obsolete')));
});

test('依赖持久恢复、同标识操作重投不重复失效；移除依赖自动推进',async t=>{
  const {store,engine,config,project}=await fixture(t,complete),a=store.add('A',{status:'paused'}),b=store.add('B');
  const input={expectedVersion:b.stateVersion,operationId:'edge-once',dependencies:[{taskId:a.id,expectedVersion:a.stateVersion}]};
  await engine.action(b.id,'set_dependency',input);const version=b.stateVersion;
  await engine.action(b.id,'set_dependency',input);assert.equal(b.stateVersion,version);assert.equal(b.attempts,0);
  const restored=new Store(config.dataDir,project);assert.equal(restored.task(b.id).dependencies[0].taskId,a.id);assert.ok(restored.task(b.id).dependencyWait.length);
  await set(engine,store,b,[]);await until(()=>b.status==='review');assert.equal(a.status,'paused');
});

test('上游验证失败不解锁下游，管理模型可通过结构化计划调整依赖',async t=>{
  const {store,engine,backend}=await fixture(t,async(task,call)=>{
    if(task.title==='A')await call('submit_result',{summary:'模型自称完成',verificationCommand:'false'});else await complete(task,call);
  });
  const a=store.add('A'),b=store.add('B');
  backend.manage=async()=>({reply:'已安排',actions:[{type:'set_dependency',taskId:b.id,expectedVersion:b.stateVersion,dependencies:[{taskId:a.id,mode:'verified'}]}]});
  await engine.message('B 需要 A 的成果',null,'dependency-plan');await until(()=>a.status==='failed'&&!engine.active);
  assert.equal(b.attempts,0);assert.equal(b.status,'queued');assert.match(b.summary,/最新成果/);assert.equal(currentDelivery(a),null);
});

test('依赖失效撤销正在等待的权限，旧审批不能重新授权',async t=>{
  const {store,engine,config}=await fixture(t,async(task,call)=>{
    if(task.title==='B')await call('run_command',{command:'touch forbidden',reason:'审批测试'});
    await complete(task,call);
  });
  const a=store.add('A');engine.tick();await until(()=>a.status==='review'&&!engine.active);
  config.mode='pi';config.permissionMode='ask';const b=store.add('B');await set(engine,store,b,[a]);
  await until(()=>b.decision?.kind==='command');const old=b.decision.id;
  engine.managerBusy=true;await engine.action(a.id,'amend',{text:'更新上游'});await engine.action(a.id,'pause');
  await until(()=>!engine.active);engine.managerBusy=false;engine.tick();
  assert.equal(engine.pending.size,0);assert.equal(b.decision,null);assert.equal(b.status,'queued');
  await assert.rejects(engine.action(b.id,'decision',{decisionId:old,answer:'允许本次执行'}),/变化/);
  await assert.rejects(fs.access(path.join(config.projectPath,'forbidden')));
});

test('一条输入创建三级依赖链，宿主自己的状态变化不会误判为外部冲突',async t=>{
  const order=[],{store,engine,backend}=await fixture(t,async(task,call)=>{order.push(task.title);await complete(task,call);});
  backend.manage=async()=>({reply:'创建链',actions:[
    {type:'create',ref:'c',text:'C',priority:'high'},{type:'create',ref:'b',text:'B'},{type:'create',ref:'a',text:'A'},
    {type:'set_dependency',taskId:'b',dependencies:[{taskId:'a'}]},
    {type:'set_dependency',taskId:'c',dependencies:[{taskId:'b'}]},
  ]});
  await engine.message('创建依赖链',null,'chain');await until(()=>store.data.tasks.every(t=>t.status==='review'));
  assert.deepEqual(order,['A','B','C']);
  await engine.message('创建依赖链',null,'chain');assert.equal(store.data.tasks.length,3);
});

test('新建任务的依赖计划成环时不留下部分任务',async t=>{
  const {store,engine,backend}=await fixture(t,complete);
  backend.manage=async()=>({reply:'无效安排',actions:[{type:'create',ref:'a',text:'A'},{type:'create',ref:'b',text:'B'},
    {type:'set_dependency',taskId:'a',dependencies:[{taskId:'b'}]},{type:'set_dependency',taskId:'b',dependencies:[{taskId:'a'}]}]});
  await assert.rejects(engine.message('建立任务',null,'bad-new-chain'),/成环/);assert.equal(store.data.tasks.length,0);
});
