import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {importAttachment,attachmentText} from '../server/attachments.mjs';
import {createServer} from '../server/http.mjs';
test('参考文件导入不覆盖源文件，凭据与越界拒绝，附带路径真实送入任务',async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-attachments-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));const config={projectPath:dir,mode:'demo',dataDir:dir+'/data'};
 const payload={name:'reference.txt',base64:Buffer.from('参考内容').toString('base64')};
 const a=await importAttachment(config,payload),b=await importAttachment(config,payload);assert.notEqual(a.path,b.path);assert.equal(await fs.readFile(path.join(dir,a.path),'utf8'),'参考内容');
 for(const name of ['auth.json','credentials.json','model-profiles.json','../escape.txt','.env'])await assert.rejects(importAttachment(config,{...payload,name}));
 await fs.symlink('/tmp',dir+'/outside');await assert.rejects(attachmentText(config,[{path:'outside/test.txt'}]));await assert.rejects(attachmentText(config,[{path:'../test.txt'}]));
 const store=new EventEmitter();store.data={tasks:[]};let received;const engine={message:async text=>{received=text;return {reply:'received'};}};
 const server=createServer(store,engine,config);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'整理参考资料',attachments:[a]})});assert.equal(response.status,200);assert.ok(received.includes(a.path));assert.ok(received.includes('参考内容'));
});
test('成果接口限制任务归属与秘密路径，二进制图片使用正确编码',async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-artifact-http-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));const bytes=Buffer.from([137,80,78,71,0,255]);await fs.writeFile(dir+'/image.png',bytes);await fs.writeFile(dir+'/.env','secret');
 const store=new EventEmitter();store.task=id=>{if(id!=='a')throw Error('任务不存在');return{id,artifacts:['image.png','.env']};};
 const server=createServer(store,{}, {projectPath:dir,dataDir:dir+'/data',mode:'demo'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}/api/artifact?taskId=a&path=`;
 const json=await(await fetch(base+'image.png')).json();assert.equal(json.mime,'image/png');assert.deepEqual(Buffer.from(json.base64,'base64'),bytes);
 assert.equal((await fetch(base+'other.txt')).status,404);assert.equal((await fetch(base+'.env')).status,400);
});
