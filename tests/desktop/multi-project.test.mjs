import {coordinationHttp} from '../helpers/coordination.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { defaults, projectId } from '../../desktop/settings.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) { const deadline=Date.now()+20000; while(!await fn()) {if(Date.now()>deadline)throw new Error('多项目状态超时');await wait(60);} }

test('多项目实际并行：审批隔离、后台推进、项目导航、草稿恢复、重启与全部退出', {timeout:90000}, async t=>{
 const dir=await fs.realpath(await fs.mkdtemp('/tmp/boan-multi-project-')), data=path.join(dir,'data');
 const projects=[path.join(dir,'project-a'),path.join(dir,'project-b')];for(const p of projects)await fs.mkdir(p);
 const calls=new Map();
 const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);if(coordinationHttp(body,res))return;
  const manager=body.tools?.some(t=>t.function.name==='submit_plan'), key=body.model+(manager?'manager':'worker');
  const n=calls.get(key)||0;calls.set(key,n+1);let call;
  if(manager && n===0) call={name:'submit_plan',arguments:{reply:'任务已安排',actions:[{type:'create',text:body.model+' 测试任务',title:body.model+' 测试任务'}]}};
  if(!manager && n===0) call={name:'run_command',arguments:{command:`node -e 'require("fs").writeFileSync("approved.txt", "${body.model}")'`,reason:'仅写入隔离测试项目'}};
  if(!manager && n===1) call={name:'submit_result',arguments:{summary:'已生成测试文件',verificationCommand:`node -e 'if(require("fs").readFileSync("approved.txt","utf8")!=="${body.model}")process.exit(1)'`}};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta,finish_reason=null)=>`data: ${JSON.stringify({id:'multi-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`;
  if(call){res.write(chunk({role:'assistant',tool_calls:[{index:0,id:key+n,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}));res.write(chunk({},'tool_calls'));}
  else {res.write(chunk({role:'assistant',content:'已提交'}));res.write(chunk({},'stop'));}res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 let app,page;const env={...process.env,BOAN_BACKGROUND_TEST:'1',BOAN_USER_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
 async function launch(){app=await electron.launch({...process.env.BOAN_TEST_EXECUTABLE?{executablePath:process.env.BOAN_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]},env});page=await app.firstWindow();page.setDefaultTimeout(10000);await page.waitForSelector('.desktop-app');}
 t.after(async()=>{await app?.close().catch(()=>{});await new Promise(r=>mock.close(r));await fs.rm(dir,{recursive:true,force:true});});
 await launch();
 const config={...defaults,mode:'pi',provider:'custom',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,keyStorage:'encrypted'};
 const read=()=>page.evaluate(()=>fetch('/api/state').then(r=>r.json()));
 const disk=async i=>JSON.parse(await fs.readFile(path.join(data,'workspaces',projectId(projects[i]),'state.json'),'utf8'));
 async function select(i){await page.getByRole('button',{name:`打开 project-${i?'b':'a'} 工作台`,exact:true}).click();await until(async()=>{try{return(await read()).project.path===projects[i]}catch{return false;}});await page.getByRole('button',{name:new RegExp(`project-${i?'b':'a'} 项目工作区`)}).waitFor();}
 async function save(i){await page.evaluate(value=>window.desktop.saveSettings(value),{...config,projectPath:projects[i],model:i?'multi-b':'multi-a'});await until(async()=>{try{return(await read()).project.path===projects[i]}catch{return false;}});await page.getByRole('button',{name:new RegExp(`project-${i?'b':'a'} 项目工作区`)}).waitFor();}
 async function send(text){await page.getByRole('textbox',{name:'交代工作或补充要求'}).fill(text);await page.getByRole('button',{name:'发送要求',exact:true}).click();await until(async()=>Boolean((await read()).tasks[0]?.decision || (await read()).tasks[0]?.status==='review'));}
 async function approve(){await page.getByRole('button',{name:'允许本次执行',exact:true}).click();}
 await save(0);await page.evaluate(()=>fetch('/api/permissions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'ask'})}));await send('启动 A 任务');
 const a=(await read()).tasks[0], aDecision=a.decision.id;
 const pidA=await fs.readFile(path.join(data,'workspaces',projectId(projects[0]),'server.lock'),'utf8');
 await page.getByRole('textbox',{name:'交代工作或补充要求'}).fill('A 的未发送草稿');
 await page.getByRole('button',{name:/^所有项目/}).click();
 await page.locator('.projects-overview').getByRole('button',{name:'添加项目',exact:true}).click();
 await page.getByRole('heading',{name:'添加项目',exact:true}).waitFor();
 assert.equal(await page.getByLabel('项目文件夹',{exact:true}).inputValue(),'');
 await page.getByRole('button',{name:'关闭面板'}).click();
 await save(1);await send('启动 B 任务');
 await assert.rejects(fs.access(path.join(projects[0],'approved.txt')));
 const bad=await page.evaluate(async a=>{const r=await fetch(`/api/tasks/${a.id}/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'decision',decisionId:a.decision.id,answer:'允许本次执行'})});return r.status;},a);assert.equal(bad,400);
 assert.equal((await read()).tasks[0].decisions,undefined);
 assert.equal((await read()).tasks[0].evidence[0].sandboxed,true);
 await until(async()=>(await read()).tasks[0].status==='review');
 assert.equal(await fs.readFile(path.join(projects[1],'approved.txt'),'utf8'),'multi-b');
 assert.equal((await disk(0)).tasks[0].decision.id,aDecision);
 assert.equal(await fs.readFile(path.join(data,'workspaces',projectId(projects[0]),'server.lock'),'utf8'),pidA);
 await page.getByRole('button',{name:/^所有项目/}).click();
 await page.waitForSelector('.projects-overview');
 assert.match(await page.locator('.project-card').filter({has:page.getByRole('heading',{name:'project-a',exact:true})}).innerText(),/1 需关注/);
 assert.match(await page.locator('.project-card').filter({has:page.getByRole('heading',{name:'project-b',exact:true})}).innerText(),/待验收/);
 await page.screenshot({path:'docs/screenshots/multi-projects.png'});
 await page.evaluate(()=>{window.navigationMarker='same-document';});
 await select(0);assert.equal(await page.evaluate(()=>window.navigationMarker),'same-document');assert.equal(await page.getByRole('textbox',{name:'交代工作或补充要求'}).inputValue(),'A 的未发送草稿');
 assert.equal((await read()).tasks[0].decision.id,aDecision);assert.equal((await read()).tasks[0].attempts,1);
 await page.keyboard.press('Meta+k');
 const search=page.getByRole('combobox',{name:'搜索项目'});await search.fill('project-b');
 await page.screenshot({path:'docs/screenshots/desktop-project-switcher.png'});
 await search.press('Enter');await page.getByRole('button',{name:'project-b 项目工作区',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.navigationMarker),'same-document');
 assert.equal((await read()).tasks[0].status,'review');
 await select(0);assert.equal((await read()).tasks[0].decision.id,aDecision);

 await page.getByRole('button',{name:'本任务内允许项目命令',exact:true}).click();await until(async()=>(await read()).tasks[0].status==='review');
 assert.equal((await read()).tasks[0].decisions.length,1);
 assert.equal((await read()).tasks[0].evidence[0].sandboxed,true);
 assert.equal(await fs.readFile(path.join(projects[0],'approved.txt'),'utf8'),'multi-a');
 await page.getByRole('button',{name:'确认完成',exact:true}).click();
 await select(1);await page.getByRole('button',{name:'确认完成',exact:true}).click();
 await until(async()=>(await read()).tasks[0].status==='done');
 await app.close();app=null;
 for(const p of projects) await assert.rejects(fs.access(path.join(data,'workspaces',projectId(p),'server.lock')));
 await launch();await until(async()=>{const s=await page.evaluate(()=>window.desktop.getProjects());return s.projects.filter(p=>p.mode==='pi' && p.status==='ready').length===2;});
 await select(0);assert.equal((await read()).tasks[0].status,'done');assert.equal((await read()).permissions.mode,'ask');assert.equal((await read()).permissions.grants.length,0);
 assert.equal(await page.getByRole('textbox',{name:'交代工作或补充要求'}).inputValue(),'A 的未发送草稿');
 const saved=JSON.parse(await fs.readFile(path.join(data,'desktop-settings.json'),'utf8'));assert.equal(Object.keys(saved.projects).length,2);
});
