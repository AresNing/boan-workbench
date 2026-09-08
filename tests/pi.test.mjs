import {coordinationHttp} from './helpers/coordination.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiBackend } from '../server/pi.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('真实 Pi 管理计划建立依赖，两项独立会话顺序读取成果并由宿主验证', {timeout:25000}, async t => {
  const dir=await fs.mkdtemp('/tmp/boan-pi-dependency-'),projectPath=path.join(dir,'project');await fs.mkdir(projectPath);
  let upstream,downstream,managerCalls=0;const counts=new Map(),starts=[],received=[];
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);if(coordinationHttp(body,res))return;
    const manager=body.tools?.some(t=>t.function.name==='submit_plan');let call,n;
    if(manager){n=managerCalls++;if(!n)call=['submit_plan',{reply:'按依赖推进',actions:[{type:'create',ref:'downstream',title:'下游',text:'下游',priority:'high'},{type:'create',ref:'upstream',title:'上游',text:'上游'},{type:'set_dependency',taskId:'downstream',dependencies:[{taskId:'upstream',mode:'verified'}]}]}];}
    else {
      const task=body.messages.flatMap(m=>{try{return [JSON.parse(typeof m.content==='string'?m.content:m.content?.map(c=>c.text||'').join('')).task].filter(Boolean);}catch{return [];}}).at(-1);
      assert.ok(task);n=counts.get(task.id)||0;counts.set(task.id,n+1);if(!n){starts.push(task.id);received.push(task);}
      const responses=task.title==='上游'
        ? [['write_file',{path:'upstream.txt',content:'source-v1'}],['submit_result',{summary:'source-v1',verificationCommand:'test -f upstream.txt'}]]
        : [['read_file',{path:'upstream.txt'}],['write_file',{path:'downstream.txt',content:'source-v1'}],['submit_result',{summary:'derived',verificationCommand:'cmp upstream.txt downstream.txt'}]];
      call=responses[n];
    }
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'dep-'+n,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
    chunk(call?{role:'assistant',tool_calls:[{index:0,id:'dep-call-'+n,type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]}:{role:'assistant',content:'已提交'});chunk({},call?'tool_calls':'stop');res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const config={mode:'pi',projectPath,dataDir:path.join(dir,'data'),provider:'custom',model:'fixture',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'public-fixture',maxTurns:8,maxRepairs:0,runTimeoutMs:15000};
  const store=new Store(config.dataDir,{path:projectPath,mode:'pi'}),engine=new Engine(store,new PiBackend(config),config);
  t.after(async()=>{await engine.close();mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  await engine.message('下游使用上游的已验证成果',null,'native-dependency');
  downstream=store.data.tasks.find(t=>t.title==='下游');upstream=store.data.tasks.find(t=>t.title==='上游');
  await engine.message('下游使用上游的已验证成果',null,'native-dependency');assert.equal(store.data.tasks.length,2);
  for(let n=0;n<1200&&!['review','failed','paused'].includes(downstream.status);n++)await delay(10);
  assert.equal(downstream.status,'review',downstream.summary);assert.deepEqual(starts,[upstream.id,downstream.id]);
  assert.equal(received[1].dependencyContext[0].deliveryId,upstream.deliveries[0].id);
  assert.notEqual(upstream.currentSession.id,downstream.currentSession.id);
  assert.equal(downstream.evidence[0].passed,true);assert.equal(await fs.readFile(path.join(projectPath,'downstream.txt'),'utf8'),'source-v1');
});

test('真实 SDK 的模型鉴权错误保留原因并隐藏密钥，不伪装成没有任务安排', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boan-pi-auth-error-'));
  const apiKey = 'public-auth-error-fixture';
  const mock = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${apiKey}`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => mock.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const backend = new PiBackend({ dataDir: dir, projectPath: dir, model: 'test', apiKey, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, maxTurns: 3 });
  await assert.rejects(backend.manage('连接测试', { tasks: [], messages: [] }), error => {
    assert.match(error.message, /模型服务调用失败.*Incorrect API key/);
    assert.ok(!error.message.includes(apiKey));
    assert.ok(!error.message.includes('未给出有效安排'));
    return true;
  });
  t.after(()=>backend.close());
  const task = { id: 'error-fixture', evidence: [] };
  await assert.rejects(backend.execute(task, { signal: new AbortController().signal, session() {}, event() {}, hasDecision: () => false }), /模型服务调用失败.*Incorrect API key/);
});

test('真实 pi SDK 经本地模型服务完成管理、工具写文件、审批、独立验证和交付', { timeout: 45000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-pi-'));
  const projectPath = path.join(dir, 'project'); await fs.mkdir(projectPath);
  let workerCalls = 0, managerCalls = 0;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);if(coordinationHttp(body,res))return;
    const manager = body.tools?.some(t => t.function.name === 'submit_plan');
    const calls = manager ? managerCalls++ : workerCalls++;
    let call;
    if (manager && calls === 0) call = { name: 'submit_plan', arguments: { reply: '已安排生成 greeting.mjs 并验证。', actions: [{ type: 'create', text: '生成 greeting.mjs，输出 hello', title: '生成问候文件' }] } };
    if (!manager && calls % 4 === 0) call = { name: 'list_files', arguments: {} };
    if (!manager && calls % 4 === 1) call = { name: 'write_file', arguments: { path: 'greeting.mjs', content: 'console.log("hello");\n' } };
    if (!manager && calls % 4 === 2) call = { name: 'submit_result', arguments: { summary: '问候文件已生成，并通过独立检查。', verificationCommand: "node greeting.mjs | /usr/bin/grep -x hello" } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (call) {
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${manager ? 'm' : 'w'}_${calls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else { res.write(chunk({ role: 'assistant', content: '已提交。' })); res.write(chunk({}, 'stop')); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const config = { mode: 'pi', permissionMode: 'ask', dataDir: path.join(dir, 'data'), projectPath, provider: 'workbench', model: 'local-test', apiKey: 'local-fixture-only', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, maxTurns: 10, maxRepairs: 1, runTimeoutMs: 20000 };
  const store = new Store(config.dataDir, { name: 'Pi Test', mode: 'pi', path: projectPath });
  const backend = new PiBackend(config), engine = new Engine(store, backend, config);
  t.after(async () => { await engine.close(); await new Promise(resolve => mock.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const preparationStages = []; store.on('change', () => { if (engine.preparation) preparationStages.push(engine.preparation.percent); });
  await engine.message('生成 greeting.mjs，输出 hello');
  assert.deepEqual([...new Set(preparationStages)], [0, 20, 40, 60, 80, 100]);
  assert.equal(store.data.tasks.length, 1);
  const task = store.data.tasks[0];
  const deadline = Date.now() + 15000;
  while (!task.decision && !['failed', 'paused'].includes(task.status)) { if (Date.now() > deadline) throw new Error('pi 没有提交验证'); await delay(30); }
  assert.equal(task.status, 'blocked', task.summary);
  assert.equal(task.decision.kind, 'command');
  assert.equal(task.evidence.length, 0);
  assert.equal(await fs.readFile(path.join(projectPath, 'greeting.mjs'), 'utf8'), 'console.log("hello");\n');
  await engine.action(task.id, 'decision', { decisionId: task.decision.id, answer: '允许本次执行' });
  while (!['review', 'failed', 'paused'].includes(task.status)) { if (Date.now() > deadline) throw new Error('pi 未完成交付'); await delay(30); }
  assert.equal(task.status, 'review', task.summary); assert.equal(task.evidence[0].passed, true);
  assert.match(task.evidence[0].output, /hello/); assert.equal(task.sessions.length, 1);
  assert.ok(workerCalls >= 4); assert.ok(managerCalls >= 2);
  while(engine.active)await delay(10);
  const originalSession=task.currentSession.id;
  await engine.action(task.id,'amend',{text:'保留原接口'});
  while(!task.decision&&!['failed','paused'].includes(task.status))await delay(10);
  assert.equal(task.decision?.kind,'command',task.summary);await engine.action(task.id,'decision',{decisionId:task.decision.id,answer:'允许本次执行'});
  while(!['review','failed','paused'].includes(task.status))await delay(10);
  assert.equal(task.status,'review',task.summary);assert.equal(task.currentSession.id,originalSession);assert.equal(task.sessions.length,1);assert.equal(task.deliveries.at(-1).version,2);assert.ok(workerCalls>=8);

});

test('真实 Pi SDK 在流式执行中接收追加要求，同会话确认新版本并拒绝旧写入', {timeout:20000},async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-pi-steer-'),projectPath=path.join(dir,'project');await fs.mkdir(projectPath);await fs.writeFile(path.join(projectPath,'input.txt'),'context');
 let count=0,release,held;const waiting=new Promise(r=>held=r),gate=new Promise(r=>release=r),bodies=[];
 const responses=[['read_file',{path:'input.txt'}],['write_file',{path:'obsolete.txt',content:'old'}],['read_requirements',{}],['acknowledge_requirements',{version:2}],['write_file',{path:'result.txt',content:'latest'}],['submit_result',{summary:'updated',verificationCommand:'test -f result.txt && test ! -f obsolete.txt'}]];
 const mock=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);if(coordinationHttp(body,res))return;const n=count++;bodies.push(body);if(n===1){held();await gate;}const call=responses[n];res.writeHead(200,{'Content-Type':'text/event-stream'});const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'steer-'+n,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);chunk(call?{role:'assistant',tool_calls:[{index:0,id:'steer-tool-'+n,type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]}:{role:'assistant',content:'完成'});chunk({},call?'tool_calls':'stop');res.end('data: [DONE]\n\n');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));const config={mode:'pi',dataDir:path.join(dir,'data'),projectPath,provider:'custom',model:'fixture',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'public-fixture',maxTurns:12,maxRepairs:0,runTimeoutMs:15000};const store=new Store(config.dataDir,{path:projectPath,mode:'pi'}),engine=new Engine(store,new PiBackend(config),config);t.after(async()=>{release();await engine.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const task=store.add('原目标');engine.tick();await waiting;await engine.action(task.id,'amend',{text:'不要旧文件'});release();for(let i=0;!['review','failed','paused'].includes(task.status)&&i<1000;i++)await delay(10);
 assert.equal(task.status,'review',task.summary);assert.equal(task.sessions.length,1);assert.equal(task.updates[0].status,'received');assert.equal(task.deliveries[0].version,2);assert.ok(bodies.some(b=>JSON.stringify(b.messages).includes('不要旧文件')));await assert.rejects(fs.access(path.join(projectPath,'obsolete.txt')));
});
