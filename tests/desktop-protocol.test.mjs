import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workbenchProtocol } from '../desktop/protocol.mjs';

test('桌面页面独立于后台加载，拒绝资源越界和秘密文件，后台失败不泄露内部错误', async t => {
  const dir = await fs.mkdtemp('/tmp/boan-protocol-'), dist = path.join(dir, 'dist');
  await fs.mkdir(dist); await fs.writeFile(path.join(dist, 'index.html'), '<h1>workbench</h1>');
  await fs.writeFile(path.join(dir, 'private.js'), 'public-private-file-fixture');
  await fs.symlink(path.join(dir, 'private.js'), path.join(dist, 'escape.js'));
  await fs.writeFile(path.join(dist, 'auth.json'), 'public-auth-fixture');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let backend = null, calls = 0;
  const handler = workbenchProtocol({ distDir: dist, getBackend: () => backend, accessToken: 'public-host-fixture', fetchBackend: async () => { calls++; throw new Error('secret error detail'); } });
  const get = url => handler(new Request(url));
  const page = await get('boan://workbench/');
  assert.equal(page.status, 200); assert.match(await page.text(), /workbench/);
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(calls, 0);
  for (const url of ['boan://other/', 'boan://workbench/%2e%2e%2fprivate.js', 'boan://workbench/escape.js', 'boan://workbench/auth.json']) assert.ok((await get(url)).status >= 400);
  assert.equal((await get('boan://workbench/api/state')).status, 503);
  backend = { url: 'http://127.0.0.1:9999' };
  const failed = await get('boan://workbench/api/state'); assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('secret')); assert.equal(calls, 1);
});

test('项目切换中已开始的 API 请求固定到原后台，授权头不发送给静态文件', async t => {
  const dist = await fs.mkdtemp('/tmp/boan-protocol-routing-');
  t.after(() => fs.rm(dist, { recursive: true, force: true }));
  let backend = { url: 'http://127.0.0.1:10001' }, release, seen;
  const request = new Request('boan://workbench/api/messages', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  request.arrayBuffer = () => new Promise(resolve => { release = () => resolve(new TextEncoder().encode('{}')); });
  const handler = workbenchProtocol({ distDir: dist, getBackend: () => backend, accessToken: 'public-host-fixture', fetchBackend: async (url, options) => { seen = { url, options }; return new Response('{}'); } });
  const pending = handler(request);
  backend = { url: 'http://127.0.0.1:10002' }; release(); await pending;
  assert.equal(seen.url, 'http://127.0.0.1:10001/api/messages');
  assert.equal(seen.options.headers['x-workbench-token'], 'public-host-fixture');
});

test('切换完成后的旧页面请求仍归属原项目，无效项目不得退回当前项目', async () => {
  const backends = { a: {url: 'http://127.0.0.1:10001'}, b: {url: 'http://127.0.0.1:10002'} }, seen = [];
  const handler = workbenchProtocol({distDir: '/tmp', accessToken: 'fixture', getBackend: id => backends[id || 'b'], fetchBackend: async url => {seen.push(url); return new Response('{}');}});
  await handler(new Request('boan://workbench/api/messages', {method: 'POST', body: '{}', headers: {'x-workbench-project':'a'}}));
  await handler(new Request('boan://workbench/api/state'));
  assert.deepEqual(seen, ['http://127.0.0.1:10001/api/messages', 'http://127.0.0.1:10002/api/state']);
  assert.equal((await handler(new Request('boan://workbench/api/state', {headers:{'x-workbench-project':'missing'}}))).status, 503);
  assert.equal(seen.length, 2);
});
