import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {Store} from '../server/store.mjs';import {Engine} from '../server/engine.mjs';import {defaultEventOperation} from '../server/management.mjs';import {reserveAuxiliary,validateAuxiliary} from '../server/auxiliary.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:(...a)=>resolve(...a)};};
async function until(fn){for(let n=0;n<1000;n++){if(fn())return;await sleep(10);}throw Error('auxiliary timeout');}
const work=(goal,mode='read_only',writePaths=[])=>({goal,output:'提交具体发现与未验证事项',mode,readPaths:['source.txt'],writePaths,budget:{maxTurns:8,maxCalls:10,timeoutMs:3000,maxOutputBytes:20000}});
async function fixture(t,items=[]){
 const dir=await fs.mkdtemp('/tmp/boan-auxiliary-test-'),projectPath=path.join(dir,'project');await fs.mkdir(projectPath);await fs.writeFile(path.join(projectPath,'source.txt'),'original');
 const config={mode:'pi',projectPath,dataDir:path.join(dir,'data'),maxRepairs:0,maxTurns:10,runTimeoutMs:10000},project={path:projectPath,mode:'pi'},store=new Store(config.dataDir,project);let delegated=false;
 const backend={coordinate:async e=>{if(!delegated&&items.length&&e.type==='task_ready'){delegated=true;return {...defaultEventOperation(e),type:'delegate_work',work:items};}return defaultEventOperation(e);},auxiliary:async(_t,w,ctx)=>{ctx.session(`aux-${w.id}`);await ctx.call('read_file',{path:'source.txt'});return ctx.call('submit_auxiliary',{summary:'已读取来源，尚未验证'});},execute:async(task,ctx)=>{ctx.session(`main-${task.id}`);for(const r of task.auxiliary.filter(r=>r.requirementVersion===task.requirementVersion&&!r.integration)){ctx.readAuxiliary(r.id);await ctx.tool(`integrate-${r.id}`,'integrate_auxiliary',{id:r.id},s=>ctx.integrateAuxiliary({id:r.id,decision:r.changes.length?'adopt':'reviewed',reason:'主执行者已核对结果及来源'},s));}return {summary:'主任务成果',verificationCommand:'true'};}};
 const engine=new Engine(store,backend,config);t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});return {store,engine,backend,config,project};
}

test('两项辅助并行运行在独立副本，主执行者整合后才修改项目并独立验证',async t=>{
 const {store,engine,backend,config}=await fixture(t,[work('只读调查'),work('隔离修改','isolated_write',['source.txt'])]);const release=gate(),both=gate();let starts=0,mainStarts=0;
 backend.auxiliary=async(_task,w,ctx)=>{ctx.session(w.id);if(++starts===2)both.resolve();assert.equal(await ctx.call('read_file',{path:'source.txt'}),'original');if(w.mode==='isolated_write')await ctx.call('write_file',{path:'source.txt',content:'staged'});else await assert.rejects(ctx.call('write_file',{path:'source.txt',content:'forbidden'}),/写入范围/);await release.promise;return ctx.call('submit_auxiliary',{summary:'结果尚未独立验证'});};
 const execute=backend.execute;backend.execute=async(...a)=>{mainStarts++;return execute(...a);};
 const task=store.add('调查后完成修改');engine.tick();await both.promise;assert.equal(mainStarts,0);assert.equal(await fs.readFile(path.join(config.projectPath,'source.txt'),'utf8'),'original');assert.equal(task.auxiliary.filter(r=>r.status==='running').length,2);
 release.resolve();await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);assert.equal(mainStarts,1);assert.equal(task.sessions.length,1);assert.equal(store.data.tasks.length,1);assert.equal(await fs.readFile(path.join(config.projectPath,'source.txt'),'utf8'),'staged');assert.ok(task.auxiliary.every(r=>r.integration&&r.sessionId&&r.sources[0].hash));assert.equal(task.deliveries[0].evidence.passed,true);
 assert.ok(store.data.management.events.some(e=>e.type==='auxiliary_result'));assert.equal((await fs.readdir(config.dataDir)).filter(n=>n.startsWith('auxiliary-')).length,0);
});

test('同文件隔离修改发生冲突时不覆盖，主执行者明确放弃另一份结果',async t=>{
 const {store,engine,backend,config}=await fixture(t,[work('版本 A','isolated_write',['source.txt']),work('版本 B','isolated_write',['source.txt'])]);
 backend.auxiliary=async(_t,w,ctx)=>{await ctx.call('write_file',{path:'source.txt',content:w.goal});return ctx.call('submit_auxiliary',{summary:w.goal});};
 backend.execute=async(task,ctx)=>{ctx.session('main');const [a,b]=task.auxiliary;ctx.readAuxiliary(a.id);await ctx.integrateAuxiliary({id:a.id,decision:'adopt',reason:'采用 A'},ctx.signal);ctx.readAuxiliary(b.id);await assert.rejects(ctx.integrateAuxiliary({id:b.id,decision:'adopt',reason:'尝试 B'},ctx.signal),/文件已变化/);await ctx.integrateAuxiliary({id:b.id,decision:'discard',reason:'已采用另一份修改，避免覆盖'},ctx.signal);return {summary:'A',verificationCommand:'true'};};
 const task=store.add('处理冲突');engine.tick();await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);assert.equal(await fs.readFile(path.join(config.projectPath,'source.txt'),'utf8'),'版本 A');assert.equal(task.auxiliary[1].integration.decision,'discard');
});

test('只读输入变化也使隔离产出过期，即使输出文件仍未存在也不能采用',async t=>{
 const {store,engine,backend,config}=await fixture(t,[work('派生文件','isolated_write',['derived.txt'])]);
 backend.auxiliary=async(_t,_w,ctx)=>{await ctx.call('write_file',{path:'derived.txt',content:'based on original'});return ctx.call('submit_auxiliary',{summary:'按旧来源派生'});};
 backend.execute=async(task,ctx)=>{const r=task.auxiliary[0];ctx.readAuxiliary(r.id);await fs.writeFile(path.join(config.projectPath,'source.txt'),'new source');await assert.rejects(ctx.integrateAuxiliary({id:r.id,decision:'adopt',reason:'尝试采用'},ctx.signal),/项目文件已变化/);await ctx.integrateAuxiliary({id:r.id,decision:'discard',reason:'来源已更新，旧产出不再适用'},ctx.signal);return {summary:'已拒绝过期产出',verificationCommand:'test ! -f derived.txt'};};
 const task=store.add('来源检查');engine.tick();await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);await assert.rejects(fs.access(path.join(config.projectPath,'derived.txt')));
});

test('工具调用、耗时与输出预算由宿主执行，失败结果也需要主执行者审阅',async t=>{
 const items=[work('调用次数'),work('耗时'),work('输出')];items[0].budget.maxCalls=1;items[1].budget.timeoutMs=100;items[2].budget.maxOutputBytes=100;
 const {store,engine,backend}=await fixture(t,items);
 backend.auxiliary=async(_t,w,ctx)=>{if(w.goal==='调用次数'){await ctx.call('read_file',{path:'source.txt'});return ctx.call('submit_auxiliary',{summary:'超出第二次调用'});}if(w.goal==='耗时')return new Promise((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(Error('模型已停止')),{once:true}));return ctx.call('submit_auxiliary',{summary:'长'.repeat(100)});};
 const task=store.add('预算检查');engine.tick();await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);assert.deepEqual(task.auxiliary.map(r=>r.status),['cancelled','timed_out','failed']);assert.ok(task.auxiliary.every(r=>r.integration.decision==='reviewed'));assert.equal(engine.auxiliaryJobs.size,0);
});

test('辅助运行中更新要求，取消旧副本操作，原任务按新版本继续',async t=>{
 const entered=gate(),release=gate();const {store,engine,backend}=await fixture(t,[work('过期修改','isolated_write',['source.txt'])]);
 backend.auxiliary=async(_t,_w,ctx)=>{entered.resolve();await release.promise;await assert.rejects(ctx.call('write_file',{path:'source.txt',content:'stale'}),/停止|变化/);return '旧结果';};
 const task=store.add('原目标');engine.tick();await entered.promise;await engine.action(task.id,'amend',{text:'新的方向'});release.resolve();await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);assert.equal(task.auxiliary[0].status,'superseded');assert.equal(task.deliveries[0].version,2);assert.equal(store.data.tasks.length,1);
});

test('不允许跳过辅助整合直接交付，不允许读取范围外文件或凭据',async t=>{
 const {store,engine,backend,config}=await fixture(t,[work('读取范围')]);
 await fs.writeFile(path.join(config.projectPath,'other.txt'),'outside scope');
 backend.auxiliary=async(_t,_w,ctx)=>{await assert.rejects(ctx.call('read_file',{path:'other.txt'}),/读取范围/);await assert.rejects(ctx.call('run_command',{command:'true'}),/不能调用/);return ctx.call('submit_auxiliary',{summary:'范围受限'});};
 backend.execute=async()=>({summary:'跳过整合',verificationCommand:'true'});const task=store.add('不可跳过');engine.tick();await until(()=>task.status==='failed');assert.match(task.summary,/整合辅助/);assert.equal(task.deliveries.length,0);
 assert.throws(()=>validateAuxiliary(task,[{...work('越界'),readPaths:['../outside']}]),/相对文件路径/);
 const another=store.add('凭据读取');engine.tick=()=>{};const records=reserveAuxiliary(engine,another,[{...work('秘密'),readPaths:['.env']}],'secret');
 await fs.writeFile(path.join(config.projectPath,'.env'),'PUBLIC_TEST_ONLY');const {runAuxiliaryBatch}=await import('../server/auxiliary.mjs');await runAuxiliaryBatch(engine,another,records,new AbortController().signal);assert.equal(records[0].status,'failed');assert.match(records[0].error,/不在 Agent 可访问范围/);
 for(const name of ['.ENV','.credentials.json']){const denied=reserveAuxiliary(engine,another,[{...work('凭据边界'),readPaths:[name]}],`secret-${name}`);await runAuxiliaryBatch(engine,another,denied,new AbortController().signal);assert.equal(denied[0].status,'failed');assert.match(denied[0].error,/不在 Agent 可访问范围/);}
});

test('管理模型不能无限委派；重启不重放辅助工作并保留主任务',async t=>{
 const {store,engine,backend,config,project}=await fixture(t);backend.coordinate=async e=>({...defaultEventOperation(e),type:'delegate_work',work:[work('有限调查')]});const task=store.add('限制委派');engine.tick();await until(()=>task.status==='failed');assert.equal(task.auxiliary.length,6);assert.match(task.summary,/辅助执行预算/);
 const other=store.add('恢复辅助',{status:'queued'});other.auxiliary=[{id:'old',status:'running',changes:[],requirementVersion:1,workspaceDir:'auxiliary-ABC123'}];await fs.mkdir(path.join(config.dataDir,'auxiliary-ABC123'));await fs.writeFile(path.join(config.dataDir,'auxiliary-ABC123','staged.txt'),'private copy');store.save();const restored=new Store(config.dataDir,project);assert.equal(restored.task(other.id).status,'paused');assert.equal(restored.task(other.id).auxiliary[0].status,'interrupted');await assert.rejects(fs.access(path.join(config.dataDir,'auxiliary-ABC123')));
});

test('独立子任务具有自己的成果与验收，父子关系不隐式改变依赖或状态',async t=>{
 const {store,engine,backend}=await fixture(t);backend.manage=async()=>({reply:'建立独立交付',actions:[{type:'create_task',text:'总目标',ref:'parent'},{type:'create_task',text:'独立文档',ref:'child',parentTaskId:'parent',acceptance:['文档可读取']},{type:'set_dependency',taskId:'parent',dependencies:[{taskId:'child'}]}]});
 await engine.message('拆出独立文档',null,'children');await until(()=>store.data.tasks.every(t=>t.status==='review'));const [parent,child]=store.data.tasks;assert.equal(child.parentTaskId,parent.id);assert.equal(parent.status,'review');assert.equal(child.status,'review');assert.notEqual(parent.currentSession.id,child.currentSession.id);
 await engine.action(child.id,'accept');assert.equal(child.status,'done');assert.equal(parent.status,'review');
 backend.manage=async()=>({reply:'错误环',actions:[{type:'create_task',text:'A',ref:'a',parentTaskId:'b'},{type:'create_task',text:'B',ref:'b',parentTaskId:'a'}]});await assert.rejects(engine.message('错误拆分',null,'cycle'),/父子任务关系不能成环/);assert.equal(store.data.tasks.length,2);
});
