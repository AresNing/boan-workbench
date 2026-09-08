import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelService } from './helpers/model-service.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startRuntime } from '../server/runtime.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));

test('同项目任务分别经 OpenAI 与 Anthropic 原生协议执行，模型归属持久化且补充沿用', {timeout:45000}, async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boan-routing-'));const project=path.join(dir,'project');await fs.mkdir(project);
 const { mock, requests } = modelService();
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${mock.address().port}`;
 const options=[{profileId:'a',provider:'OpenAI',model:'model-a',label:'Model A',connection:'api',available:true,efforts:['low','medium','high'],speeds:[{value:'priority'},{value:'fast'}]},{profileId:'b',provider:'Anthropic',model:'model-b',label:'Model B',connection:'api',available:true,efforts:['low','medium','high'],speeds:[{value:'priority'},{value:'fast'}]}];
 const config={mode:'pi',connection:'api',provider:'openai',model:'model-a',projectPath:project,dataDir:path.join(dir,'data'),distDir:path.resolve('dist'),maxTurns:10,maxRepairs:0,runTimeoutMs:20000,modelOptions:options,defaultModel:options[0],resolveModel:async choice=>({connection:'api',provider:choice.profileId==='b'?'anthropic':'openai',api:choice.profileId==='b'?'anthropic-messages':'openai-completions',model:choice.model,baseUrl:choice.profileId==='b'?url:url+'/v1',apiKey:choice.profileId==='b'?'public-key-b':'public-key-a'})};
 let runtime=await startRuntime(config);t.after(async()=>{await runtime?.close();await new Promise(r=>mock.close(r));await fs.rm(dir,{recursive:true,force:true});});
 for(const [index,option] of options.entries()){
  const choice={...option,effort:index?'medium':'high',speed:index?'fast':'priority'};
  await runtime.engine.message('写入文件',null,undefined,choice);
  const task=runtime.store.data.tasks.at(-1);
  for(let i=0;!['review','failed','paused'].includes(task.status)&&i<300;i++)await delay(30);
  assert.equal(task.status,'review',task.summary);assert.equal(task.modelSelection.profileId,choice.profileId);assert.equal(task.modelSelection.model,choice.model);
  assert.equal(await fs.readFile(path.join(project,choice.model+'.txt'),'utf8'),choice.model);
 }
 assert.ok(requests.some(r=>r.model==='model-a'&&r.path==='/v1/chat/completions'&&r.auth==='Bearer public-key-a'));
 assert.ok(requests.some(r=>r.model==='model-b'&&new URL(r.path,'http://local').pathname==='/v1/messages'&&r.auth==='public-key-b'), JSON.stringify(requests));
 assert.ok(requests.filter(r=>r.model==='model-a').every(r=>r.effort==='high'&&r.tier==='priority'));
 assert.ok(requests.filter(r=>r.model==='model-b').every(r=>r.thinking?.type==='enabled'&&r.thinking.budget_tokens>0&&r.speed==='fast'&&r.beta.includes('fast-mode-2026-02-01')));
 assert.ok(!JSON.stringify(runtime.store.snapshot()).includes('public-key-'));
 const ids=runtime.store.data.tasks.map(t=>t.id);await runtime.close();runtime=await startRuntime({...config,defaultModel:options[1]});
 assert.equal(runtime.store.task(ids[0]).modelSelection.effort,'high');assert.equal(runtime.store.task(ids[1]).modelSelection.speed,'fast');
 assert.equal(runtime.store.task(ids[0]).modelSelection.profileId,'a');assert.equal(runtime.store.task(ids[1]).modelSelection.profileId,'b');
 await runtime.engine.action(ids[0],'model',{modelSelection:options[1]});assert.equal(runtime.store.task(ids[0]).modelSelection.profileId,'b');
 assert.equal(runtime.store.task(ids[1]).modelSelection.profileId,'b');
 await assert.rejects(runtime.engine.message('无效选择',null,undefined,{profileId:'missing',model:'other'}),/不可用/);
 await assert.rejects(runtime.engine.message('错误参数',null,undefined,{...options[0],effort:'ultra'}),/不支持所选思考/);
 await assert.rejects(runtime.engine.message('错误参数',null,undefined,{...options[0],speed:'turbo'}),/不支持所选速度/);
 assert.equal(runtime.engine.managerBusy,false);
});
