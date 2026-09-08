import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';
import {PiBackend} from '../server/pi.mjs';import {ClaudeBackend} from '../server/claude.mjs';import {Store} from '../server/store.mjs';import {Engine} from '../server/engine.mjs';import {defaultEventOperation} from '../server/management.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function service(){
 const seen=[],counts=new Map();let delegated=false;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  if(!raw||!req.url.match(/messages|chat\/completions/)){res.end('{}');return;}if(req.url.includes('count_tokens')){res.end('{"input_tokens":10}');return;}
  const body=JSON.parse(raw),anthropic=req.url.includes('/messages');
  const inputs=body.messages.flatMap(m=>(typeof m.content==='string'?[m.content]:(m.content||[]).map(c=>c.text)).flatMap(text=>{try{return [JSON.parse(text)];}catch{return [];}}));
  const input=inputs.findLast(v=>v.managementEvent||v.work||v.task);if(!input){res.writeHead(400);res.end('No fixture input');return;}
  const event=input.managementEvent,work=input.work,key=event?event.id:work?work.id:input.task.id,n=counts.get(key)||0;counts.set(key,n+1);
  let calls;
  if(event){
   let op=defaultEventOperation(event);
   if(event.type==='task_ready'&&!delegated){delegated=true;op={...op,type:'delegate_work',work:['inspect','change'].map(goal=>({goal,output:'核对源文件并提出结果',mode:goal==='inspect'?'read_only':'isolated_write',readPaths:['source.txt'],writePaths:goal==='inspect'?[]:['source.txt'],budget:{maxTurns:6,maxCalls:6,timeoutMs:12000,maxOutputBytes:20000}}))};}
   calls=[['submit_coordination',op]];
  }else if(work){
   seen.push({work:work.id,tools:body.tools.map(t=>t.name||t.function.name),model:body.model});
   calls=[['read_file',{path:'source.txt'}],...(work.mode==='isolated_write'?[['write_file',{path:'source.txt',content:'integrated native result'}]]:[]),['submit_auxiliary',{summary:'读取了 source.txt，结果尚未独立验证'}]];
  }else{
   calls=input.task.auxiliary.flatMap(w=>[['read_auxiliary_result',{id:w.id}],['integrate_auxiliary',{id:w.id,decision:w.mode==='isolated_write'?'adopt':'reviewed',reason:'主执行者核对来源与隔离改动'}]]);
   calls.push(['read_file',{path:'source.txt'}],['submit_result',{summary:'已整合并交回宿主验证',verificationCommand:'test "$(cat source.txt)" = "integrated native result"'}]);
  }
  const call=calls[n],name=call&&body.tools.find(t=>(t.name||t.function.name).endsWith(call[0]));
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(anthropic){
   const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
   emit('message_start',{message:{id:`message-${key}-${n}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
   emit('content_block_start',{index:0,content_block:call?{type:'tool_use',id:`call-${n}`,name:name.name,input:{}}:{type:'text',text:''}});
   emit('content_block_delta',{index:0,delta:call?{type:'input_json_delta',partial_json:JSON.stringify(call[1])}:{type:'text_delta',text:'已提交'}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:call?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{});res.end();
  }else{
   const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:`message-${key}-${n}`,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
   chunk(call?{role:'assistant',tool_calls:[{index:0,id:`call-${n}`,type:'function',function:{name:name.function.name,arguments:JSON.stringify(call[1])}}]}:{role:'assistant',content:'已提交'});chunk({},call?'tool_calls':'stop');res.end('data: [DONE]\n\n');
  }
 });return {server,seen};
}
for(const kind of ['Pi','Claude'])test(`真实 ${kind} SDK：模型委派、独立辅助会话、主执行者整合与宿主验证`,{timeout:45000},async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-aux-sdk-'),projectPath=path.join(dir,'project'),claudeHome=path.join(dir,'claude');await fs.mkdir(projectPath);await fs.mkdir(claudeHome);await fs.writeFile(path.join(projectPath,'source.txt'),'original');
 const {server,seen}=service();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config={mode:'pi',projectPath,dataDir:path.join(dir,'data'),claudeHome,maxTurns:15,maxRepairs:0,runTimeoutMs:30000};
 if(kind==='Pi')Object.assign(config,{provider:'custom',model:'fixture',apiKey:'public-test-only',baseUrl:`http://127.0.0.1:${server.address().port}/v1`});
 else{const sdk=await import('@anthropic-ai/claude-agent-sdk');config.claudeModel='claude-sonnet-4-5';config.claudeSdk={...sdk,query:({prompt,options})=>{
   const env={...options.env,ANTHROPIC_API_KEY:'public-test-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`};
   assert.deepEqual(options.tools,[]);assert.deepEqual(options.settingSources,[]);
   return sdk.query({prompt,options:{...options,env,spawnClaudeCodeProcess:o=>spawn(o.command,o.args,{cwd:o.cwd,env,stdio:['pipe','pipe','pipe'],signal:o.signal})}});
 }};}
 const store=new Store(config.dataDir,{path:projectPath,mode:'pi'}),backend=kind==='Pi'?new PiBackend(config):new ClaudeBackend(config),engine=new Engine(store,backend,config);
 t.after(async()=>{await engine.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const task=store.add('使用辅助执行调查并修改源文件');engine.tick();for(let n=0;n<2500&&!['review','failed','paused'].includes(task.status);n++)await sleep(10);
 assert.equal(task.status,'review',task.summary);assert.equal(task.auxiliary.length,2);assert.ok(task.auxiliary.every(w=>w.status==='completed'&&w.integration));assert.equal(task.sessions.length,1);
 assert.equal(new Set([...task.auxiliary.map(w=>w.sessionId),task.currentSession.id]).size,3);assert.equal(await fs.readFile(path.join(projectPath,'source.txt'),'utf8'),'integrated native result');assert.equal(task.evidence[0].passed,true);
 assert.ok(seen.length>=5);assert.ok(seen.every(r=>r.tools.every(name=>['read_file','write_file','submit_auxiliary'].some(t=>name.endsWith(t)))));
});
