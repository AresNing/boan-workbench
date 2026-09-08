import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { ProjectRuntimes } from '../desktop/project-runtimes.mjs';
import { DesktopSettings, defaults, projectId } from '../desktop/settings.mjs';
import { attachCodexWorker, WorkerCodexClient } from '../desktop/codex-bridge.mjs';

test('项目后台复用、故障独立、只停止指定项目并关闭全部进程', async () => {
  const stopped=[], starts=[], exits={};
  const pool=new ProjectRuntimes({start:async (data,summary,exit)=>{const name=data.settings.projectPath;starts.push(name);exits[name]=exit;return {name};},stop:async r=>stopped.push(r.name)});
  const data=name=>({settings:{mode:'pi',projectPath:name}});
  const [a,again]=await Promise.all([pool.ensure(data('/a')),pool.ensure(data('/a'))]);
  assert.equal(a,again);const b=await pool.ensure(data('/b'));assert.deepEqual(starts,['/a','/b']);
  exits['/a']('crash');assert.equal(a.status,'error');assert.equal(b.status,'ready');assert.deepEqual(stopped,[]);
  await pool.ensure(data('/a'));await pool.stopOne(b.id);assert.deepEqual(stopped,['/b']);
  await pool.close();assert.deepEqual(stopped,['/b','/a']);
});

test('项目配置持久化、旧配置迁移、切换保留独立模型与内存密钥且不写入秘密', async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-project-registry-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(dir+'/a');await fs.mkdir(dir+'/b');
 const settings=new DesktopSettings(dir,{available:async()=>false});
 const input={...defaults,mode:'pi',projectPath:dir+'/a',provider:'openai',model:'model-a',keyStorage:'session',apiKey:'public-only-fixture'};
 await settings.commit(await settings.prepare(input));
 await settings.commit(await settings.prepare({...input,apiKey:'',projectPath:dir+'/b',model:'model-b'}));
 const configs=Object.values(settings.data.projects);assert.equal(configs.length,2);
 const a=configs.find(c=>c.model==='model-a');await settings.select(a);assert.equal(await settings.secret(),'public-only-fixture');
 const disk=await fs.readFile(settings.file,'utf8');assert.ok(!disk.includes('public-only-fixture'));
 const restored=new DesktopSettings(dir,{});await restored.load();assert.equal(Object.keys(restored.data.projects).length,2);assert.equal(await restored.secret(),'');
 const legacy={version:1,settings:input,encryptedKeys:{}};delete legacy.settings.apiKey;await fs.writeFile(settings.file,JSON.stringify(legacy));
 await restored.load();assert.ok(restored.data.projects[projectId(input.projectPath)]);
});

test('共享 ChatGPT 的多个项目工具与通知独立分发，关闭一个不影响另一个', async ()=>{
 const native=new EventEmitter();let id=0;native.request=async(method)=>method==='thread/start'?{thread:{id:'t'+ ++id}}:{};
 const channels=Array.from({length:2},()=>{const parent=new EventEmitter(),worker=new EventEmitter();parent.connected=worker.connected=true;parent.send=m=>queueMicrotask(()=>worker.emit('message',structuredClone(m)));worker.send=m=>queueMicrotask(()=>parent.emit('message',structuredClone(m)));return {parent,worker};});
 const detach=channels.map(c=>attachCodexWorker(c.parent,native)),clients=channels.map(c=>new WorkerCodexClient(c.worker));
 try {
  const threads=await Promise.all(clients.map(c=>c.request('thread/start',{})));
  clients.forEach((c,i)=>{c.onToolCall=async()=>({project:i});});
  assert.deepEqual(await Promise.all(threads.map(t=>native.onToolCall({threadId:t.thread.id}))),[{project:0},{project:1}]);
  await assert.rejects(clients[1].request('turn/start',{threadId:threads[0].thread.id}),/不属于/);
  let received=0;clients[1].on('notification',()=>received++);native.emit('notification','turn/started',{threadId:threads[1].thread.id,turn:{id:'turn-b'}});await new Promise(r=>setImmediate(r));assert.equal(received,1);
  clients[0].close();detach[0]();assert.deepEqual(await native.onToolCall({threadId:threads[1].thread.id}),{project:1});
 } finally {clients.forEach(c=>c.close());detach.forEach(fn=>fn());}
});
