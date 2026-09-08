import {coordinationForPrompt} from './helpers/coordination.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexClient } from '../server/codex-client.mjs';
import { CodexBackend } from '../server/codex.mjs';
import { ChatGPTLogin } from '../desktop/chatgpt.mjs';
import { DesktopSettings, defaults } from '../desktop/settings.mjs';
import { Store } from '../server/store.mjs';
import { ModelRouter } from '../server/model-routing.mjs';
import { Engine } from '../server/engine.mjs';
import {defaultEventOperation} from '../server/management.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const deadline = Date.now() + 5000; while (!fn()) { if (Date.now() > deadline) throw new Error('等待执行超时'); await delay(10); } }

class FixtureClient extends EventEmitter {
  async start() { return this; }
  close() { this.emit('closed', new Error('closed')); }
  async request(method, p) {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' } };
    if (method === 'thread/start') { assert.deepEqual(p.environments, []); assert.equal(p.sandbox, 'workspace-write'); assert.equal(p.approvalPolicy, 'on-request'); this.tools = p.dynamicTools; return { thread: { id: 'test-thread' } }; }
    if (method === 'turn/start') {
      assert.deepEqual(p.environments, []);
      const manager = this.tools.some(t => t.name === 'submit_plan');
      setImmediate(async () => {
        let sequence=0;const call = (tool, args) => this.onToolCall({ threadId: 'test-thread', callId: `${tool}-${sequence++}-${this.turns=(this.turns||0)+1}`, namespace: null, tool, arguments: args });
        if (this.tools.some(t=>t.name==='submit_coordination'))await call('submit_coordination',coordinationForPrompt(p.input[0].text));
        else if (manager) await call('submit_plan', { reply: '已安排', actions: [{ type: 'create', text: '生成问候文件', title: 'Codex 任务' }] });
        else {
          this.emit('notification', 'item/completed', { threadId: 'test-thread', item: { type: 'reasoning', text: 'private reasoning fixture' } });
          this.emit('notification', 'item/completed', { threadId: 'test-thread', item: { type: 'agentMessage', text: '先检查项目，再生成文件。' } });
          await assert.rejects(call('write_file', { path: 'missing-content' }), /参数无效/);
          const denied = await call('write_file', { path: '../outside.txt', content: 'denied' }); assert.equal(denied.success, false);
          const write = await call('write_file', { path: 'hello.mjs', content: 'console.log("hello codex");\n' }); assert.equal(write.success, true);
          if(this.testReadImage){const image = await call('read_image', {path:'reference.png'});assert.equal(image.success,true);assert.equal(image.contentItems[0].type,'inputImage');assert.ok(image.contentItems[0].imageUrl.startsWith('data:image/png;base64,'));}
          await call('run_command', { command: 'node hello.mjs', reason: '检查输出' });
          await call('submit_result', { summary: '文件已生成', verificationCommand: 'node hello.mjs' });
        }
        this.emit('notification', 'turn/completed', { threadId: 'test-thread', turn: { id: 'turn', status: 'completed' } });
      });
      return { turn: { id: 'turn' } };
    }
    throw new Error(method);
  }
}

test('Codex 协议辅助会话使用独立 thread 与工具白名单，主执行者审阅后交付',async t=>{
  const dir=await fs.mkdtemp('/tmp/boan-codex-aux-'),projectPath=path.join(dir,'project');await fs.mkdir(projectPath);await fs.writeFile(path.join(projectPath,'source.txt'),'source');
  let clients=0,delegated=false;const auxThreads=[];
  class AuxiliaryClient extends FixtureClient {
    constructor(){super();this.id=`thread-${++clients}`;}
    async request(method,p){
      if(method==='thread/start'){this.tools=p.dynamicTools;assert.deepEqual(p.environments,[]);return {thread:{id:this.id}};}
      if(method!=='turn/start')return super.request(method,p);
      setImmediate(async()=>{
        let sequence=0;const call=async(tool,args)=>{const r=await this.onToolCall({threadId:this.id,callId:`call-${sequence++}`,tool,arguments:args});assert.equal(r.success,true,JSON.stringify(r));return r;};
        try{
          const input=JSON.parse(p.input[0].text);
          if(input.managementEvent){const e=input.managementEvent;let op=defaultEventOperation(e);if(e.type==='task_ready'&&!delegated){delegated=true;op={...op,type:'delegate_work',work:[{goal:'检查来源',output:'提交来源摘要',mode:'read_only',readPaths:['source.txt'],writePaths:[],budget:{maxTurns:5,maxCalls:5,timeoutMs:3000,maxOutputBytes:10000}}]};}await call('submit_coordination',op);}
          else if(input.work){auxThreads.push(this.id);assert.deepEqual(this.tools.map(t=>t.name),['read_file','submit_auxiliary']);await assert.rejects(this.onToolCall({threadId:this.id,callId:'forbidden',tool:'run_command',arguments:{command:'true'}}),/工具或参数无效/);await call('read_file',{path:'source.txt'});await call('submit_auxiliary',{summary:'已核对来源，尚未验证主任务'});}
          else{for(const r of input.task.auxiliary){await call('read_auxiliary_result',{id:r.id});await call('integrate_auxiliary',{id:r.id,decision:'reviewed',reason:'已核对独立来源'});}await call('submit_result',{summary:'已整合',verificationCommand:'true'});}
          this.emit('notification','turn/completed',{threadId:this.id,turn:{id:'turn',status:'completed'}});
        }catch(e){this.emit('notification','turn/completed',{threadId:this.id,turn:{id:'turn',status:'failed',error:{message:e.message}}});}
      });return {turn:{id:'turn'}};
    }
  }
  const config={mode:'pi',projectPath,dataDir:path.join(dir,'data'),codexHome:path.join(dir,'codex'),maxTurns:10,maxRepairs:0,runTimeoutMs:10000,codexClientFactory:()=>new AuxiliaryClient()};
  const store=new Store(config.dataDir,{path:projectPath,mode:'pi'}),engine=new Engine(store,new CodexBackend(config),config);t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});
  const task=store.add('Codex 辅助检查');engine.tick();await until(()=>['review','failed'].includes(task.status));assert.equal(task.status,'review',task.summary);assert.equal(auxThreads.length,1);assert.notEqual(task.currentSession.id,auxThreads[0]);assert.equal(task.sessions.length,1);assert.equal(task.auxiliary[0].integration.decision,'reviewed');
});

test('Codex 通道复用管理、文件边界、命令逐次审批、独立验证和验收持久化', async t => {
  const dir = await fs.mkdtemp('/tmp/boan-codex-engine-'), projectPath = path.join(dir, 'project'); await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath,'reference.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=','base64'));
  const config = { mode: 'pi', permissionMode: 'ask', connection: 'chatgpt', codexHome: path.join(dir, 'codex'), dataDir: path.join(dir, 'data'), projectPath, maxTurns: 10, maxRepairs: 1, runTimeoutMs: 10000, codexClientFactory: () => Object.assign(new FixtureClient(),{testReadImage:true}) };
  const store = new Store(config.dataDir, { name: 'Codex Test', mode: 'pi', path: projectPath });
  const engine = new Engine(store, new CodexBackend(config), config);
  t.after(async () => { await engine.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const preparationStages = []; store.on('change', () => { if (engine.preparation) preparationStages.push(engine.preparation.percent); });
  await engine.message('生成问候文件'); const task = store.data.tasks[0];
  assert.deepEqual([...new Set(preparationStages)], [0, 20, 40, 60, 80, 100]);
  await until(() => task.decision); assert.equal(task.status, 'blocked'); assert.equal(task.evidence.length, 0);
  await assert.rejects(fs.access(path.join(dir, 'outside.txt')));
  const progress = store.data.events.filter(e => e.taskId === task.id);
  assert.ok(progress.some(e => e.kind === 'progress' && e.detail === '先检查项目，再生成文件。'));
  assert.ok(!JSON.stringify(progress).includes('private reasoning fixture'));
  assert.ok(progress.some(e => e.tool === 'write_file' && e.status === 'failed'));
  assert.ok(progress.some(e => e.tool === 'write_file' && e.status === 'completed' && e.path === 'hello.mjs'));
  assert.ok(progress.some(e => e.tool === 'run_command' && e.status === 'waiting'));
  const first = task.decision.id;
  await engine.action(task.id, 'decision', { decisionId: first, answer: '允许本次执行' });
  await until(() => task.decision && task.decision.id !== first);
  assert.equal(task.evidence.length, 0); // Verification is a separate approval.
  await engine.action(task.id, 'decision', { decisionId: task.decision.id, answer: '允许本次执行' });
  await until(() => task.status === 'review'); assert.equal(task.evidence[0].passed, true); assert.match(task.evidence[0].output, /hello codex/);
  const activities = store.data.events.filter(e => e.kind === 'activity');
  for (const tool of ['run_command', 'verification']) {
    const entry = activities.find(e => e.tool === tool);
    assert.equal(entry.status, 'completed'); assert.equal(entry.exitCode, 0); assert.match(entry.output, /hello codex/);
  }
  await engine.action(task.id, 'accept'); assert.equal(task.status, 'done');
  while(engine.active)await delay(5);const sessionId=task.currentSession.id;
  await engine.action(task.id,'amend',{text:'保留问候文件'});await until(()=>task.decision);await engine.action(task.id,'decision',{decisionId:task.decision.id,answer:'本任务内允许项目命令'});await until(()=>task.status==='review'||task.status==='failed');assert.equal(task.status,'review',task.summary);assert.equal(task.currentSession.id,sessionId);assert.equal(task.sessions.length,1);assert.equal(task.deliveries.at(-1).version,2);

});

test('Codex stdio 请求对应响应、拒绝原生审批、服务退出释放等待且隔离环境', async t => {
  const home = await fs.mkdtemp('/tmp/boan-codex-rpc-'); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('exit', 0);
  let seenOptions; const sent = [];
  child.stdin.on('data', buf => { const m = JSON.parse(buf); sent.push(m); if (m.method === 'initialize') child.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n'); });
  const client = new CodexClient({ home, executable: '/fixture/codex', spawnProcess: (_exe, args, opts) => { assert.ok(args.includes('cli_auth_credentials_store="keyring"')); seenOptions = opts; return child; } });
  await client.start(); assert.equal(seenOptions.env.CODEX_HOME, home); assert.equal(seenOptions.env.OPENAI_API_KEY, undefined); assert.equal(seenOptions.cwd, home);
  child.stdout.write(JSON.stringify({ id: 100, method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  await until(() => sent.some(m => m.id === 100)); assert.equal(sent.find(m => m.id === 100).error.code, -32603);
  const one = client.request('one', {}), two = client.request('two', {});
  for (const name of ['two', 'one']) { const m = sent.find(m => m.method === name); child.stdout.write(JSON.stringify({ id: m.id, result: name }) + '\n'); }
  assert.deepEqual(await Promise.all([one, two]), ['one', 'two']);
  const pending = client.request('pending', {}); client.close(); await assert.rejects(pending, /结束/);
});

test('ChatGPT 登录取消、完成、退出和浏览器 URL 校验，不向页面返回令牌或授权 URL', async () => {
  const client = new EventEmitter(); let account = null, requests = [], opened;
  client.start = async () => client;
  client.request = async (method, p) => { requests.push([method, p]);
    if (method === 'account/read') return { account };
    if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'fixture', authUrl: 'https://auth.openai.com/oauth/authorize?state=public-fixture' };
    if (method === 'account/logout') account = null;
    return {};
  };
  const login = new ChatGPTLogin({ home: '/unused', clientFactory: () => client, openExternal: async url => { opened = url; } });
  assert.equal((await login.login()).pending, true); assert.match(opened, /^https:\/\/auth.openai.com\//);
  await login.login(); assert.equal(requests.filter(([m]) => m === 'account/login/start').length, 1);
  assert.equal((await login.cancel()).pending, false);
  await login.login();
  client.emit('notification', 'account/login/completed', { loginId: 'fixture', success: false, error: 'Login server error: Sign-in completed but credentials could not be saved locally.' });
  assert.match((await login.status()).error, /仅本次运行登录/); assert.equal((await login.status()).storage, 'keyring');
  await login.login(); account = { type: 'chatgpt', email: 'test@example.test', planType: 'pro', accessToken: 'never-expose' };
  client.emit('notification', 'account/login/completed', { loginId: 'fixture', success: true });
  const state = await login.status(); assert.equal(state.loggedIn, true); assert.equal(state.pending, false); assert.ok(!JSON.stringify(state).includes('never-expose')); assert.ok(!JSON.stringify(state).includes('authUrl'));
  assert.equal((await login.logout()).loggedIn, false);
  client.request = async m => m === 'account/login/start' ? { type: 'chatgpt', loginId: 'bad', authUrl: 'https://example.test/' } : { account: null };
  await assert.rejects(login.login(), /未通过校验/);
});

test('ChatGPT 设置无需 API Key，保留 API 通道配置且不读取凭据', async t => {
  const dir = await fs.mkdtemp('/tmp/boan-chatgpt-settings-'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settings = new DesktopSettings(dir, { available() { throw new Error('不应访问'); } });
  await settings.commit(await settings.prepare({ ...defaults, mode: 'pi', permissionMode: 'ask', connection: 'chatgpt', projectPath: dir }));
  assert.equal(settings.public().connection, 'chatgpt'); assert.equal(settings.public().hasApiKey, false);
  assert.ok(!JSON.stringify(settings.data).includes('accessToken'));
});

test('内置官方 Codex 0.153.4 与本地 Responses 服务真实完成动态工具往返，原生命令和文件工具关闭', { timeout: 30000 }, async t => {
  const { default: http } = await import('node:http');
  const home = await fs.mkdtemp('/tmp/boan-native-codex-'); let calls = 0, invoked = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const names = body.tools.flatMap(t => [t.name, ...(t.tools || []).map(x => x.name)]);
    assert.ok(names.includes('submit_plan'));
    for (const name of ['exec_command', 'shell', 'apply_patch', 'view_image', 'spawn_agent', 'request_user_input']) assert.ok(!names.includes(name), name);
    if (calls) assert.ok(body.input.some(i => i.type === 'function_call_output'));
    const item = !calls++ ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'submit_plan', arguments: '{"reply":"native tools work"}' }
      : { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of [{ type: 'response.created', response: { id: `resp_${calls}`, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `resp_${calls}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = new CodexClient({ home });
  t.after(async () => { client.close(); await new Promise(r => server.close(r)); await fs.rm(home, { recursive: true, force: true }); });
  await client.start(); assert.equal((await client.request('account/read', { refreshToken: false })).account, null);
  const { attachCodexWorker, WorkerCodexClient } = await import('../desktop/codex-bridge.mjs');
  const parent = new EventEmitter(), worker = new EventEmitter(); parent.connected = worker.connected = true;
  parent.send = m => queueMicrotask(() => worker.emit('message', structuredClone(m)));
  worker.send = m => queueMicrotask(() => parent.emit('message', structuredClone(m)));
  const detach = attachCodexWorker(parent, client), proxy = new WorkerCodexClient(worker);
  t.after(() => { proxy.close(); detach(); });
  const { thread } = await proxy.request('thread/start', { cwd: home, environments: [], ephemeral: true, sandbox: 'workspace-write', approvalPolicy: 'on-request', model: 'gpt-5.4', modelProvider: 'fixture', config: { 'model_providers.fixture': { name: 'Fixture', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', requires_openai_auth: false } }, baseInstructions: 'Use submit_plan.', dynamicTools: [{ type: 'function', name: 'submit_plan', description: 'Submit plan', inputSchema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] } }] });
  proxy.onToolCall = async p => { assert.equal(p.threadId, thread.id); assert.equal(p.tool, 'submit_plan'); assert.equal(p.arguments.reply, 'native tools work'); invoked = true; return { success: true, contentItems: [{ type: 'inputText', text: 'recorded' }] }; };
  const completed = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Native turn timeout')), 15000); proxy.on('notification', (m, p) => { if (m === 'turn/completed') { clearTimeout(timer); resolve(p.turn); } }); });
  await proxy.request('turn/start', { threadId: thread.id, environments: [], input: [{ type: 'text', text: 'fixture', text_elements: [] }] });
  assert.equal((await completed).status, 'completed'); assert.equal(invoked, true); assert.equal(calls, 2);
});

test('官方 Codex 内存凭据存储：同进程可用，重启后消失，测试凭据不落盘', async t => {
  const { spawn } = await import('node:child_process');
  const home = await fs.mkdtemp('/tmp/boan-ephemeral-auth-');
  const fixture = 'public-boan-ephemeral-auth-fixture';
  const make = () => new CodexClient({ home, credentialStore: 'ephemeral', spawnProcess: (exe, args, options) => spawn(exe, [...args, '-c', 'forced_login_method="api"'], options) });
  let client = make();
  t.after(async () => { client.close(); await fs.rm(home, { recursive: true, force: true }); });
  await client.start(); await client.request('account/login/start', { type: 'apiKey', apiKey: fixture });
  assert.equal((await client.request('account/read', { refreshToken: false })).account.type, 'apiKey');
  client.close(); client = make(); await client.start();
  assert.equal((await client.request('account/read', { refreshToken: false })).account, null);
  await assert.rejects(fs.access(path.join(home, 'auth.json')));
  async function scan(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) await scan(file); else if (e.isFile()) assert.ok(!(await fs.readFile(file)).includes(Buffer.from(fixture)), file); } }
  await scan(home);
});

test('共享 Codex 连接跨工作会话保留登录，后台不能退出账号，关闭会话会中断执行', async () => {
  const { attachCodexWorker, WorkerCodexClient } = await import('../desktop/codex-bridge.mjs');
  const parent = new EventEmitter(), worker = new EventEmitter(); parent.connected = worker.connected = true;
  parent.send = m => queueMicrotask(() => worker.emit('message', structuredClone(m)));
  worker.send = m => queueMicrotask(() => parent.emit('message', structuredClone(m)));
  const native = new EventEmitter(); const calls = []; let count = 0;
  native.request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'public@example.test', planType: 'pro' } };
    if (method === 'thread/start') return { thread: { id: `thread-${++count}` } };
    return {};
  };
  const detach = attachCodexWorker(parent, native);
  const first = new WorkerCodexClient(worker), second = new WorkerCodexClient(worker);
  try {
    assert.equal((await first.request('account/read', {})).account.type, 'chatgpt');
    const { thread } = await first.request('thread/start', {});
    await assert.rejects(second.request('turn/start', { threadId: thread.id }), /不属于/);
    await assert.rejects(first.request('account/logout', {}), /不允许/);
    first.onToolCall = async p => ({ success: true, contentItems: [{ type: 'inputText', text: p.arguments.text }] });
    assert.equal((await native.onToolCall({ threadId: thread.id, tool: 'test', arguments: { text: 'bridge works' } })).contentItems[0].text, 'bridge works');
    native.emit('notification', 'turn/started', { threadId: thread.id, turn: { id: 'active-turn' } });
    first.close(); await until(() => calls.some(([m]) => m === 'turn/interrupt'));
    assert.equal((await second.request('account/read', {})).account.type, 'chatgpt');
    const next = await second.request('thread/start', {});
    second.onToolCall = () => new Promise(() => {});
    const pending = native.onToolCall({ threadId: next.thread.id });
    parent.emit('disconnect'); await assert.rejects(pending, /工作进程已关闭/);
  } finally { first.close(); second.close(); detach(); }
});

test('Codex 工具请求排队，审批等待期间不会被后续调用的步数上限或提前完成通知打断', async () => {
  const { Type } = await import('@sinclair/typebox');
  const client = new EventEmitter(); let release, started = false, completed = false;
  client.start = async () => {};
  client.close = () => {};
  client.request = async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : method === 'thread/start' ? { thread: { id: 'queue-thread' } } : { turn: { id: 'queue-turn' } };
  const gate = new Promise(r => { release = r; });
  const backend = new CodexBackend({ projectPath: '/tmp', maxTurns: 1, codexClientFactory: () => client });
  const handle = await backend.session('queue', [{ name: 'hold', description: 'fixture', parameters: Type.Object({}), execute: async () => { started = true; await gate; return { content: [{ type: 'text', text: 'approved' }] }; } }], '', new AbortController().signal);
  const prompt = handle.session.prompt('fixture').finally(() => { completed = true; });
  const failure = assert.rejects(prompt, /步数上限/);
  const call = () => client.onToolCall({ threadId: 'queue-thread', tool: 'hold', callId: 'fixture', arguments: {} });
  const first = call(); const second = call(); const rejected = assert.rejects(second, /步数/);
  client.emit('notification', 'turn/completed', { threadId: 'queue-thread', turn: { status: 'completed' } });
  await until(() => started); await delay(40); assert.equal(completed, false);
  release(); assert.equal((await first).success, true);
  await failure; await rejected; handle.close();
});


test('任务路由可从 API 默认项目选择 ChatGPT 模型，模型传入 Codex 并完成宿主验证', async t => {
 const dir=await fs.mkdtemp('/tmp/boan-chatgpt-routing-'),projectPath=path.join(dir,'project');await fs.mkdir(projectPath);
 const selected={profileId:'chatgpt',model:'fixture-codex',label:'Fixture Codex',provider:'ChatGPT',connection:'chatgpt',available:true,efforts:['high'],speeds:[{value:'fast'}],effort:'high',speed:'fast'},seen=[],turns=[];
 const config={mode:'pi',connection:'api',provider:'openai',dataDir:path.join(dir,'data'),projectPath,maxTurns:10,maxRepairs:0,runTimeoutMs:10000,modelOptions:[selected],defaultModel:selected,resolveModel:async value=>({connection:'chatgpt',chatgptModel:value.model}),codexClientFactory:()=>{const client=new FixtureClient(),request=client.request.bind(client);client.request=async(method,params)=>{if(method==='thread/start')seen.push(params.model);if(method==='turn/start')turns.push(params);return request(method,params);};return client;}};
 const store=new Store(config.dataDir,{name:'Routing',path:projectPath,mode:'pi'}),engine=new Engine(store,new ModelRouter(config),config);t.after(async()=>{await engine.close();await fs.rm(dir,{recursive:true,force:true});});
 await engine.message('生成文件',null,undefined,selected);await until(()=>['review','failed'].includes(store.data.tasks[0].status));assert.equal(store.data.tasks[0].status,'review',store.data.tasks[0].summary);assert.deepEqual(seen,Array(5).fill('fixture-codex'));assert.equal(turns.length,5);assert.ok(turns.every(t=>t.effort==='high'&&t.serviceTierForTurn==='fast'));assert.equal(store.data.tasks[0].modelSelection.profileId,'chatgpt');assert.equal(store.data.tasks[0].evidence[0].passed,true);
});
