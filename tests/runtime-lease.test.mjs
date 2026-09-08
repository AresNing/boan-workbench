import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';import {once} from 'node:events';
import {acquireRuntimeLease} from '../server/runtime-lease.mjs';import {startRuntime} from '../server/runtime.mjs';import {runCommand} from '../server/files.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){const dir=await fs.mkdtemp('/tmp/boan-lease-test-'),projectPath=path.join(dir,'project'),dataDir=path.join(dir,'data');await fs.mkdir(projectPath);await fs.mkdir(dataDir);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,projectPath,dataDir};}
function child(config,script){
 const code=`import {acquireRuntimeLease} from ${JSON.stringify(pathToFileURL(path.resolve('server/runtime-lease.mjs')).href)};import {runCommand} from ${JSON.stringify(pathToFileURL(path.resolve('server/files.mjs')).href)};const config=JSON.parse(process.argv[1]);const lease=await acquireRuntimeLease(config);${script}`;
 const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.ELECTRON_RUN_AS_NODE='1';
 const processChild=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify(config)],{stdio:['ignore','pipe','pipe','ipc'],env});
 let errors='';processChild.stderr.on('data',b=>{errors+=b;});processChild.errors=()=>errors;return processChild;
}
async function message(c){return Promise.race([once(c,'message').then(([m])=>m),once(c,'exit').then(([code])=>{throw Error(`child exited ${code}: ${c.errors()}`);})]);}
async function kill(c){if(c.exitCode!==null||c.signalCode!==null)return;const ended=once(c,'exit');c.kill('SIGKILL');await ended;}

test('真实项目路径互斥不受状态目录或符号链接影响，失败启动不改原状态',async t=>{
 let runtime;t.after(()=>runtime?.close());const config=await fixture(t);runtime=await startRuntime({...config,mode:'demo',distDir:path.resolve('dist'),demoDelay:10000});
 while(!runtime.engine.active)await delay(5);
 const before=await fs.readFile(path.join(config.dataDir,'state.json'),'utf8'),other=path.join(config.dir,'other');await fs.mkdir(other);const alias=path.join(config.dir,'alias');await fs.symlink(config.projectPath,alias);
 await assert.rejects(startRuntime({...config,dataDir:other,projectPath:alias,mode:'demo',distDir:path.resolve('dist')}),/已有服务/);
 assert.equal(await fs.readFile(path.join(config.dataDir,'state.json'),'utf8'),before);
 await runtime.close();const next=await startRuntime({...config,mode:'demo',distDir:path.resolve('dist'),demoDelay:10000});await next.close();
});

test('持有者崩溃后内核释放锁，多个竞争者中只有一个可以接管',async t=>{
 const config=await fixture(t),owner=child(config,'process.send({ready:true});setInterval(()=>{},1000);');t.after(()=>kill(owner));await message(owner);await kill(owner);
 const script='process.send({ready:true});process.on("message",()=>{lease.release();process.exit(0)});';
 const contenders=[child(config,script),child(config,script)];t.after(async()=>{for(const c of contenders)await kill(c);});
 const results=await Promise.allSettled(contenders.map(message));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const winner=contenders[results.findIndex(r=>r.status==='fulfilled')];const exited=once(winner,'exit');winner.send('close');await exited;
 const fresh=await acquireRuntimeLease(config);fresh.release();
});

test('宿主崩溃后存活的命令进程组阻止接管，实际停止后才恢复',async t=>{
 const config=await fixture(t);
 const owner=child(config,`void runCommand(config.projectPath,'sleep 30; touch late.txt',{onSpawn:pid=>{lease.commandStarted(pid);process.send({group:pid});},onSettled:pid=>lease.commandSettled(pid)});`);
 t.after(()=>kill(owner));const {group}=await message(owner);t.after(()=>{try{process.kill(-group,'SIGKILL');}catch{}});await delay(30);await kill(owner);
 await assert.rejects(acquireRuntimeLease(config),/进程组仍存活/);
 process.kill(-group,'SIGKILL');let lease;
 for(let n=0;n<150;n++){try{lease=await acquireRuntimeLease(config);break;}catch(e){if(!/进程组仍存活/.test(e.message))throw e;await delay(20);}}
 assert.ok(lease,'停止后的进程组应不再占用项目');lease.release();await assert.rejects(fs.access(path.join(config.projectPath,'late.txt')));
});

test('命令必须先持久登记才能执行，不向命令暴露内核锁描述符',async t=>{
 const config=await fixture(t),lease=await acquireRuntimeLease(config);t.after(()=>lease.release());let recorded=false;
 const result=await runCommand(config.projectPath,'test ! -e /dev/fd/3 && touch allowed.txt',{onSpawn:pid=>{lease.commandStarted(pid);recorded=true;},onSettled:pid=>lease.commandSettled(pid)});
 assert.equal(recorded,true);assert.equal(result.passed,true);
 await assert.rejects(runCommand(config.projectPath,'touch forbidden.txt',{onSpawn:()=>{throw Error('登记失败');}}),/登记失败/);await assert.rejects(fs.access(path.join(config.projectPath,'forbidden.txt')));
});
