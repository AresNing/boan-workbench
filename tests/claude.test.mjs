import {coordinationForPrompt} from './helpers/coordination.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ClaudeLogin} from '../desktop/claude.mjs';
import {ClaudeBackend} from '../server/claude.mjs';
import {claudeEnv} from '../server/claude-client.mjs';
import {Engine} from '../server/engine.mjs';
import {Store} from '../server/store.mjs';
import {defaults,validateSettings} from '../desktop/settings.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('Claude 官方登录：地址校验、取消、状态白名单、订阅选择和环境隔离',async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-claude-login-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));let loggedIn=false,login;const opened=[],calls=[];
 const fakeSpawn=(_exe,args,opts)=>{calls.push({args,env:opts.env});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit('exit',null));};
  queueMicrotask(()=>{if(args[1]==='login'){login=child;child.stdout.write('https://evil.test/oauth/authorize\nhttps://claude.ai/oauth/authorize?state=public-fixture\n');child.stdin.on('data',()=>{loggedIn=true;child.emit('exit',0);});}else{if(args[1]==='logout')loggedIn=false;child.stdout.write(JSON.stringify({loggedIn,authMethod:loggedIn?'claude.ai':'none',email:'test@example.test',subscriptionType:'max',secret:'never-forward'}));child.emit('exit',loggedIn?0:args[1]==='logout'?0:1);}});return child;};
 const auth=new ClaudeLogin(dir,async url=>opened.push(url),{executable:'/fixture/claude',spawn:fakeSpawn});await auth.initialize();assert.equal((await auth.status()).loggedIn,false);
 await auth.login();await delay(0);assert.equal(opened.length,1);assert.equal(new URL(opened[0]).hostname,'claude.ai');assert.ok(calls.some(c=>c.args.includes('--claudeai')));
 auth.submitCode('public-code');await delay(0);assert.equal((await auth.status(true)).loggedIn,true);assert.ok(!JSON.stringify(await auth.status()).includes('never-forward'));
 const restarted=new ClaudeLogin(dir,()=>{}, {spawn:fakeSpawn});await restarted.initialize();assert.equal((await restarted.status()).loggedIn,true);assert.equal((await auth.logout()).loggedIn,false);
 await auth.login();await auth.cancel();assert.equal((await auth.status()).pending,false);await auth.login();await delay(0);assert.equal((await auth.status()).pending,true);assert.equal((await auth.status()).error,'');auth.close();
 const env=claudeEnv(dir,{HOME:dir,ANTHROPIC_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'secret',CLAUDE_CODE_OAUTH_TOKEN:'secret',NODE_OPTIONS:'injected'});assert.equal(env.ANTHROPIC_API_KEY,undefined);assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(env.NODE_OPTIONS,undefined);
 assert.equal(validateSettings({...defaults,mode:'pi',connection:'claude',projectPath:dir}).connection,'claude');
});

test('Claude 登录执行适配：仅宿主工具、effort/speed、真实文件与独立验证，不暴露思考',async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-claude-run-'),project=path.join(dir,'project');await fs.mkdir(project);const optionsSeen=[];
 const sdk={tool:(name,description,inputSchema,handler)=>({name,handler}),createSdkMcpServer:x=>x,query:({options,prompt})=>{
  optionsSeen.push(options);return {close(){},async *[Symbol.asyncIterator](){const tools=options.mcpServers.boan.tools;let requestId=0;const call=async(name,args)=>tools.find(t=>t.name===name).handler(args,{requestId:++requestId});
   yield {type:'system',subtype:'init',session_id:'fixture-claude'};
   if(tools.some(t=>t.name==='submit_coordination')){const first=await prompt[Symbol.asyncIterator]().next();await call('submit_coordination',coordinationForPrompt(first.value.message.content));}
   else if(tools.some(t=>t.name==='submit_plan'))await call('submit_plan',{reply:'已安排',actions:[{type:'create',title:'Claude 测试',text:'写文件'}]});
   else{await call('write_file',{path:'result.txt',content:'claude fixture'});await call('submit_result',{summary:'已写入',verificationCommand:'test -f result.txt'});}
   yield {type:'assistant',message:{content:[{type:'thinking',thinking:'private-fixture'},{type:'text',text:'已完成'}]}};yield{type:'result',is_error:false};
  }};
 }};
 const config={mode:'pi',connection:'claude',projectPath:project,dataDir:path.join(dir,'data'),claudeHome:path.join(dir,'claude'),claudeSdk:sdk,claudeModel:'sonnet',effort:'high',speed:'fast',maxTurns:20,maxRepairs:0,runTimeoutMs:10000};
 const store=new Store(config.dataDir,{path:project,name:'Claude',mode:'pi'}),engine=new Engine(store,new ClaudeBackend(config),config);t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});
 await engine.message('写一个文件');for(let i=0;!['review','failed'].includes(store.data.tasks[0].status)&&i<200;i++)await delay(20);
 assert.equal(store.data.tasks[0].status,'review',store.data.tasks[0].summary);assert.equal(await fs.readFile(path.join(project,'result.txt'),'utf8'),'claude fixture');assert.ok(!JSON.stringify(store.snapshot()).includes('private-fixture'));
 for(const o of optionsSeen){assert.deepEqual(o.tools,[]);assert.deepEqual(o.settingSources,[]);assert.equal(o.strictMcpConfig,true);assert.equal(o.effort,'high');assert.equal(o.settings.fastMode,true);assert.equal(o.env.ANTHROPIC_API_KEY,undefined);assert.equal((await o.canUseTool('Bash',{})).behavior,'deny');}
});


test('官方 Claude SDK 经本地服务实际调用 Boan MCP 工具并完成独立验证', {timeout:30000}, async t=>{
 const {modelService}=await import('./helpers/model-service.mjs'),sdk=await import('@anthropic-ai/claude-agent-sdk'),{spawn}=await import('node:child_process');
 const dir=await fs.mkdtemp('/tmp/boan-claude-native-'),project=path.join(dir,'project'),home=path.join(dir,'claude');await fs.mkdir(project);await fs.mkdir(home);
 const {mock,requests}=modelService();await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 // Test-only public API credential reaches only the loopback fixture. Production login env is tested separately.
 const requestIds=[];const fixtureSdk={...sdk,tool:(name,desc,shape,handler)=>sdk.tool(name,desc,shape,(args,extra)=>{requestIds.push(extra?.requestId);return handler(args,extra);}),query:({prompt,options})=>{const env={...options.env,ANTHROPIC_API_KEY:'public-local-fixture',ANTHROPIC_BASE_URL:`http://127.0.0.1:${mock.address().port}`};return sdk.query({prompt,options:{...options,env,spawnClaudeCodeProcess:o=>spawn(o.command,o.args,{cwd:o.cwd,env,stdio:['pipe','pipe','pipe'],signal:o.signal})}});}};
 const config={mode:'pi',connection:'claude',projectPath:project,dataDir:path.join(dir,'data'),claudeHome:home,claudeSdk:fixtureSdk,claudeModel:'claude-sonnet-4-5',effort:'high',speed:'standard',maxTurns:10,maxRepairs:0,runTimeoutMs:15000};
 const store=new Store(config.dataDir,{path:project,name:'Native Claude',mode:'pi'}),engine=new Engine(store,new ClaudeBackend(config),config);t.after(async()=>{await engine.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));await fs.rm(dir,{recursive:true,force:true});});
 await engine.message('写入文件');for(let i=0;!['review','failed'].includes(store.data.tasks[0].status)&&i<500;i++)await delay(30);
 assert.equal(store.data.tasks[0].status,'review',store.data.tasks[0].summary);const task=store.data.tasks[0],sessionId=task.currentSession.id;while(engine.active)await delay(10);await engine.action(task.id,'amend',{text:'保留已完成文件'});for(let i=0;!['review','failed','paused'].includes(task.status)&&i<500;i++)await delay(30);assert.equal(task.status,'review',task.summary);assert.equal(task.currentSession.id,sessionId);assert.equal(task.sessions.length,1);assert.equal(task.deliveries.at(-1).version,2);assert.ok(requests.length>=6);assert.ok(requestIds.length>=4);assert.ok(requestIds.every(x=>['string','number'].includes(typeof x)));assert.equal(await fs.readFile(path.join(project,'claude-sonnet-4-5.txt'),'utf8'),'claude-sonnet-4-5');
});
