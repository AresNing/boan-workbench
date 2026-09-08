import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelProfiles } from '../desktop/model-profiles.mjs';
import { DesktopSettings, defaults } from '../desktop/settings.mjs';
import { modelSelection } from '../server/model-routing.mjs';

const crypto = { available: async () => true, encrypt: async s => Buffer.from([...s].reverse().join('')), decrypt: async b => [...b.toString()].reverse().join('') };
test('多厂商配置各自保存密钥与模型，重启恢复，公开接口不回显，地址不可替换', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boan-profiles-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const settings=new DesktopSettings(dir,crypto);await settings.load();const profiles=new ModelProfiles(dir,crypto,settings);await profiles.load();
 await profiles.save({name:'OpenAI',provider:'openai',models:['model-a','model-b'],keyStorage:'encrypted',apiKey:'public-openai-fixture'});
 await profiles.save({name:'Anthropic',provider:'anthropic',models:'claude-test',keyStorage:'session',apiKey:'public-anthropic-fixture'});
 const [a,b]=profiles.public();assert.equal(a.available,true);assert.equal(b.available,true);
 assert.equal((await profiles.resolve({profileId:a.id,model:'model-b'})).apiKey,'public-openai-fixture');
 assert.equal((await profiles.resolve({profileId:b.id,model:'claude-test'})).api,'anthropic-messages');
 assert.equal((await profiles.resolve({profileId:b.id,model:'claude-test'})).apiKey,'public-anthropic-fixture');
 assert.ok(!JSON.stringify(profiles.public()).includes('fixture'));assert.ok(!(await fs.readFile(profiles.file,'utf8')).includes('fixture'));
 assert.equal((await fs.stat(profiles.file)).mode & 0o777,0o600);
 await assert.rejects(profiles.save({...a,baseUrl:'https://unrelated.example/v1'}),/不能原地替换/);
 await profiles.cacheChatGPT([{id:'account-model',name:'Account model',token:'must-not-persist'}]);
 const restarted=new ModelProfiles(dir,crypto,settings);await restarted.load();assert.equal(restarted.public()[0].available,true);assert.equal(restarted.public()[1].available,false);
 assert.deepEqual(restarted.data.chatgptModels,[{id:'account-model',name:'Account model',isDefault:false,efforts:[],speeds:[{value:'standard',label:'标准'}]}]);
 assert.ok(!(await fs.readFile(profiles.file,'utf8')).includes('must-not-persist'));
 await assert.rejects(restarted.resolve({profileId:b.id,model:'claude-test'}),/缺少密钥/);
 await profiles.remove(a.id);await assert.rejects(profiles.resolve({profileId:a.id,model:'model-b'}),/已移除/);
});
test('旧项目密钥按原凭据标识迁移引用，不改原配置，不复制秘密', async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boan-legacy-models-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const settings=new DesktopSettings(dir,crypto);await settings.load();const config={...defaults,mode:'pi',provider:'openai',model:'old-model',projectPath:dir,apiKey:'public-existing-fixture'};
 await settings.commit(await settings.prepare(config));const before=await fs.readFile(settings.file,'utf8');
 const profiles=new ModelProfiles(dir,crypto,settings);await profiles.load();await profiles.importLegacy(settings.data.settings);
 const choice=profiles.options()[0];assert.equal((await profiles.resolve(choice)).apiKey,config.apiKey);assert.equal(await fs.readFile(settings.file,'utf8'),before);
 assert.ok(!(await fs.readFile(profiles.file,'utf8')).includes(config.apiKey));
 const selected=modelSelection(profiles.options(),{...choice,apiKey:'must-not-persist',baseUrl:'https://attacker.test'});
 assert.equal(selected.apiKey,undefined);assert.equal(selected.baseUrl,undefined);assert.equal(selected.model,'old-model');
});


test('模型能力来源于 SDK 和账号目录，不为不支持的模型显示快速选项', async () => {
 const {apiCapabilities,codexCapabilities}=await import('../desktop/model-capabilities.mjs');
 const catalog={getModel:(p,m)=>m==='reasoner'?{reasoning:true,thinkingLevelMap:{minimal:null,xhigh:'xhigh',max:null}}:undefined};
 assert.deepEqual(apiCapabilities('openai','reasoner',catalog).efforts,['low','medium','high','xhigh']);
 assert.equal(apiCapabilities('custom','unknown',catalog).speeds.length,1);
 assert.equal(apiCapabilities('anthropic','claude-opus-4-6',catalog).speeds.length,1);
 assert.equal(apiCapabilities('anthropic','claude-opus-4-8',catalog).speeds[1].value,'fast');
 assert.deepEqual(codexCapabilities({efforts:['high'],speeds:[{value:'fast',label:'Fast'}]}),{efforts:['high'],speeds:[{value:'standard',label:'标准'},{value:'fast',label:'Fast'}]});
});
