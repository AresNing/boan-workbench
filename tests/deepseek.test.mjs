import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelProfiles } from '../desktop/model-profiles.mjs';
import { DesktopSettings, defaults } from '../desktop/settings.mjs';
import { PiBackend } from '../server/pi.mjs';
import { startRuntime } from '../server/runtime.mjs';
import { modelService } from './helpers/model-service.mjs';
import { deepseekBaseUrl, deepseekModels } from '../shared/deepseek.mjs';

const crypto = { available: async()=>true, encrypt: async s=>Buffer.from([...s].reverse().join('')), decrypt: async b=>[...b.toString()].reverse().join('') };
const delay = ms=>new Promise(r=>setTimeout(r,ms));
async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boan-deepseek-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const settings=new DesktopSettings(dir,crypto);await settings.load();
  const profiles=new ModelProfiles(dir,crypto,settings);await profiles.load();
  return {dir,settings,profiles};
}
test('DeepSeek 官方默认地址、凭据隔离、共享服务与项目默认连接重启恢复', async t=>{
  const {dir,settings,profiles}=await setup(t);
  await profiles.save({name:'DeepSeek',provider:'deepseek',models:deepseekModels,keyStorage:'encrypted',apiKey:'public-deepseek-fixture'});
  await profiles.save({name:'OpenAI',provider:'openai',models:['gpt-5'],keyStorage:'session',apiKey:'public-other-fixture'});
  const restarted=new ModelProfiles(dir,crypto,settings);await restarted.load();
  const option=restarted.options().find(o=>o.model===deepseekModels[0]);
  assert.deepEqual(option.efforts,['low','high','max']);assert.equal(option.speeds.length,1);
  const resolved=await restarted.resolve(option);assert.equal(resolved.provider,'deepseek');assert.equal(resolved.api,'openai-completions');assert.equal(resolved.apiKey,'public-deepseek-fixture');
  const backend=new PiBackend({...resolved,dataDir:dir});await backend.initialize();
  assert.equal(backend.model.baseUrl,deepseekBaseUrl);assert.equal(backend.model.compat.thinkingFormat,'deepseek');
  assert.equal(backend.model.contextWindow,1000000);await backend.close();
  assert.ok(!JSON.stringify(restarted.public()).includes('fixture'));
  assert.ok(!(await fs.readFile(profiles.file,'utf8')).includes('public-deepseek-fixture'));
  await assert.rejects(restarted.resolve(restarted.options().find(o=>o.provider==='OpenAI')),/缺少密钥/);
  await settings.commit(await settings.prepare({...defaults,mode:'pi',provider:'deepseek',model:deepseekModels[0],projectPath:dir,apiKey:'public-project-fixture'}));
  const restored=new DesktopSettings(dir,crypto);await restored.load();assert.equal(restored.public().provider,'deepseek');assert.equal(await restored.secret(),'public-project-fixture');
  await restarted.importLegacy(restored.data.settings);assert.equal((await restarted.resolve(restarted.options().find(o=>o.profileId.startsWith('legacy-')))).provider,'deepseek');
});

test('DeepSeek 经真实 SDK 完成管理、流式工具执行、独立验证与重启；思考内容完整回传', {timeout:60000}, async t=>{
  const {dir,profiles}=await setup(t),project=path.join(dir,'project');await fs.mkdir(project);
  const {mock,requests}=modelService({strictDeepseek:true});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  await profiles.save({name:'DeepSeek',provider:'deepseek',baseUrl:`http://127.0.0.1:${mock.address().port}`,models:[...deepseekModels,'deepseek-chat','deepseek-reasoner'],keyStorage:'encrypted',apiKey:'public-deepseek-fixture'});
  const options=profiles.options(),config={mode:'pi',connection:'api',projectPath:project,dataDir:path.join(dir,'data'),distDir:path.resolve('dist'),maxTurns:10,maxRepairs:0,runTimeoutMs:15000,modelOptions:options,defaultModel:options[0],resolveModel:choice=>profiles.resolve(choice)};
  let runtime;t.after(async()=>{await runtime?.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));});
  runtime=await startRuntime(config);
  for(const [index,option] of options.entries()){
    await runtime.engine.message('写入文件',null,undefined,{...option,...(index===1?{effort:'max'}:{})});
    const task=runtime.store.data.tasks.at(-1);
    for(let i=0;!['review','failed','paused'].includes(task.status)&&i<400;i++)await delay(30);
    assert.equal(task.status,'review',task.summary);assert.equal(await fs.readFile(path.join(project,option.model+'.txt'),'utf8'),option.model);
  }
  assert.ok(requests.length>20);
  assert.ok(requests.every(r=>r.auth==='Bearer public-deepseek-fixture'&&r.tier===undefined));
  assert.ok(requests.filter(r=>r.model===deepseekModels[1]).every(r=>r.effort==='max'&&r.thinking.type==='enabled'));
  assert.ok(requests.filter(r=>r.model==='deepseek-chat').every(r=>r.thinking.type==='disabled'));
  assert.ok(requests.some(r=>r.messages.filter(m=>m.role==='assistant'&&m.reasoning_content==='fixture reasoning').length>=2));
  const ids=runtime.store.data.tasks.map(t=>t.id);await runtime.close();runtime=await startRuntime(config);
  assert.equal(runtime.store.task(ids[1]).modelSelection.effort,'max');assert.equal(runtime.store.task(ids[0]).modelSelection.provider,'DeepSeek');
  assert.ok(!JSON.stringify(runtime.store.snapshot()).includes('public-deepseek-fixture'));
});
