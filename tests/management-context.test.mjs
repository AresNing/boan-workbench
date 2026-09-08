import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {Store} from '../server/store.mjs';import {Engine} from '../server/engine.mjs';import {PiBackend} from '../server/pi.mjs';
import {managementContext,projectDocuments} from '../server/management-context.mjs';
async function fixture(t){
  const root=await fs.mkdtemp('/tmp/boan-facts-'),projectPath=path.join(root,'project');await fs.mkdir(projectPath);
  const config={mode:'pi',projectPath,dataDir:path.join(root,'data')},project={path:projectPath,mode:'pi'},store=new Store(config.dataDir,project);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,config,store,project};
}
function delivered(store){
  const task=store.add('明确成果',{acceptance:['只验证公开字段']});task.status='done';
  task.decisions=[{id:'business',kind:'business',question:'哪些字段',answer:'公开字段',at:'2026-09-08',requirementVersion:1},{id:'permission',kind:'command',answer:'本任务内允许联网'}];
  task.sessions=[{id:'private-session-transcript'}];task.operations=[{command:'never-share-command'}];
  task.deliveries=[{id:'delivery',version:1,summary:'公开结果',artifacts:['public.txt'],acceptedAt:'2026-09-08',evidence:{passed:true,requirementVersion:1}}];store.save();return task;
}

test('共享事实保留来源和验收范围，权限和会话不跨任务传播，旧成果立即失效',async t=>{
  const {store,config,project}=await fixture(t),task=delivered(store);store.add('另一项任务');
  const facts=managementContext(store.snapshot()),source=facts.tasks[0];
  assert.deepEqual(source.acceptance,['只验证公开字段']);assert.equal(source.confirmedDecisions.length,1);
  assert.equal(source.confirmedDecisions[0].scope.taskId,task.id);assert.equal(source.confirmedDecisions[0].source.decisionId,'business');
  assert.equal(facts.tasks[1].confirmedDecisions.length,0);assert.equal(facts.projectFacts.sharedDeliveries[0].source.deliveryId,'delivery');
  assert.equal(facts.projectFacts.sharedDeliveries[0].verified,true);assert.equal(facts.projectFacts.sharedDeliveries[0].accepted,true);
  assert.ok(!JSON.stringify(facts).includes('private-session-transcript'));assert.ok(!JSON.stringify(facts).includes('never-share-command'));assert.ok(!JSON.stringify(facts).includes('本任务内允许联网'));
  task.requirementVersion++;task.acceptance=['新的标准'];store.save();
  const refreshed=managementContext(new Store(config.dataDir,project).snapshot());
  assert.equal(refreshed.projectFacts.sharedDeliveries.length,0);assert.equal(refreshed.tasks[0].latestDelivery.verified,false);assert.equal(refreshed.tasks[0].latestDelivery.scope.acceptance,null);
});

test('用户输入与执行事件使用同一套实际模型提示，保留当前决定和验收标准',async t=>{
  const {store,config}=await fixture(t);delivered(store);await fs.writeFile(path.join(config.projectPath,'AGENTS.md'),'保留现有接口');
  const prompts=[];
  class Capture extends PiBackend{async session(_key,tools){const session={messages:[],prompt:async text=>{const data=JSON.parse(text);prompts.push(data);
    const coord=tools.find(t=>t.name==='submit_coordination');await (coord||tools[0]).execute('one',coord?{type:'dispatch_task',taskId:data.managementEvent.taskId,expectedVersion:data.managementEvent.stateVersion}:{reply:'根据当前事实回答',actions:[]});
  }};return {session,close:()=>{}};}}
  const engine=new Engine(store,new Capture(config),config);engine.tick=()=>{};t.after(()=>engine.close());
  await engine.message('询问进度',null,'facts-input');const task=store.data.tasks[0];
  await engine.manager.decide('task_ready',task,{},new AbortController().signal);
  assert.deepEqual(prompts[0].tasks,prompts[1].tasks);assert.deepEqual(prompts[0].projectFacts,prompts[1].projectFacts);
  assert.equal(prompts[0].projectFacts.documents[0].text,'保留现有接口');assert.equal(prompts[0].tasks[0].confirmedDecisions[0].answer,'公开字段');
  const disk=JSON.parse(await fs.readFile(store.file,'utf8'));
  assert.ok(disk.management.events.every(e=>e.context?.digest&&e.context.documents[0].hash));
  assert.ok(!JSON.stringify(disk.management.events).includes('保留现有接口'));
});

test('规划期间项目规则变化时拒绝旧创建和旧执行安排',async t=>{
  const {store,config}=await fixture(t),file=path.join(config.projectPath,'AGENTS.md');await fs.writeFile(file,'原规则');
  const task=store.add('原任务');const backend={manage:async()=>{await fs.writeFile(file,'新规则');return {reply:'过期',actions:[{type:'create_task',text:'旧安排'}]};},coordinate:async e=>{await fs.writeFile(file,'更新规则');return {type:'dispatch_task',taskId:e.taskId,expectedVersion:e.stateVersion};}};
  const engine=new Engine(store,backend,config);engine.tick=()=>{};t.after(()=>engine.close());
  await assert.rejects(engine.message('安排新任务',null,'stale-doc'),/项目资料已变化/);assert.equal(store.data.tasks.length,1);
  await assert.rejects(engine.manager.decide('task_ready',task,{},new AbortController().signal),/项目资料已变化/);
  assert.equal(Object.keys(store.data.management.operations).length,0);
});

test('项目资料读取排除越界链接、秘密与超大文件，缺失和不完整均明确标注',async t=>{
  const {root,config}=await fixture(t);await fs.writeFile(path.join(config.dataDir,'hidden.txt'),'private');
  await fs.symlink(path.join(config.dataDir,'hidden.txt'),path.join(config.projectPath,'AGENTS.md'));
  await fs.writeFile(path.join(config.projectPath,'README.md'),'api_key=sk-public-test\n项目背景');
  let docs=await projectDocuments(config);assert.equal(docs[0].status,'unavailable');assert.ok(!JSON.stringify(docs).includes('private'));assert.ok(!JSON.stringify(docs).includes('sk-public-test'));
  await fs.rm(path.join(config.projectPath,'README.md'));docs=await projectDocuments(config);assert.equal(docs[1].status,'missing');
  await fs.writeFile(path.join(config.projectPath,'README.md'),'x'.repeat(65000));docs=await projectDocuments(config);assert.equal(docs[1].status,'too_large');assert.equal(docs[1].complete,false);assert.equal(docs[1].text,undefined);
});
