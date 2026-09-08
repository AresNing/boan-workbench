import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {inspectWorkspace} from '../server/workspace-inspection.mjs';
test('交接现场观察使用当前文件，明确缺失和越界，不冒充验证或沿用旧哈希',async t=>{
  const root=await fs.mkdtemp('/tmp/boan-inspection-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const projectPath=path.join(root,'project'),dataDir=path.join(root,'data');await fs.mkdir(projectPath);await fs.mkdir(dataDir);
  await fs.writeFile(path.join(projectPath,'result.txt'),'before');await fs.writeFile(path.join(dataDir,'secret'),'private fixture');
  await fs.symlink(path.join(dataDir,'secret'),path.join(projectPath,'link.txt'));
  const config={projectPath,dataDir},task={requirementVersion:2,artifacts:['result.txt','missing.txt','link.txt']},signal=new AbortController().signal;
  const first=await inspectWorkspace(config,task,signal);await fs.writeFile(path.join(projectPath,'result.txt'),'after');const second=await inspectWorkspace(config,task,signal);
  assert.notEqual(first.artifacts[0].sha256,second.artifacts[0].sha256);assert.deepEqual(second.artifacts.map(a=>a.status),['observed','missing','unavailable']);
  assert.equal(second.verified,false);assert.equal(second.requirementVersion,2);assert.ok(!JSON.stringify(second).includes('private fixture'));assert.ok(second.files.includes('result.txt'));
  const controller=new AbortController();controller.abort();await assert.rejects(inspectWorkspace(config,task,controller.signal),/中止/);
});
