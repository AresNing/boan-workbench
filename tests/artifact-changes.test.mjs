import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {rememberChange,artifactChange} from '../server/artifact-changes.mjs';
test('文件变更保留任务基线，外部修改不归因给 Agent，记录隔离并限制权限',async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-changes-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));const config={dataDir:dir};
 await rememberChange(config,'task','result.js','one\ntwo','one\nthree');
 await rememberChange(config,'task','result.js','one\nthree','one\nfour');
 const diff=await artifactChange(config,'task','result.js','one\nfour');assert.match(diff.diff,/-two\n\+four/);assert.equal(await artifactChange(config,'other','result.js','one\nfour'),null);
 assert.deepEqual(await artifactChange(config,'task','result.js','external'),{stale:true});
 await rememberChange(config,'task','result.js','external','final');assert.match((await artifactChange(config,'task','result.js','final')).diff,/-external\n\+final/);
 await rememberChange(config,'task','new.js',null,'new file');const added=await artifactChange(config,'task','new.js','new file');assert.equal(added.added,true);assert.match(added.diff,/@@ -1,0 \+1,1 @@\n\+new file/);
 const [taskDir]=await fs.readdir(dir+'/artifact-changes');const [file]=await fs.readdir(dir+'/artifact-changes/'+taskDir);assert.equal((await fs.stat(dir+'/artifact-changes/'+taskDir+'/'+file)).mode&0o777,0o600);
});
