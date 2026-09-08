import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
export function codexExecutable() {
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
  const pkg = require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
  return path.join(path.dirname(pkg), 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}
export const safeError = error => String(error?.message || error || 'Codex 连接失败').replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]').replace(/(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '[已隐藏凭据]').slice(0, 1500);
// Stdio never exposes an unauthenticated local HTTP/WebSocket control endpoint.
export class CodexClient extends EventEmitter {
  constructor({ home, executable, credentialStore = 'keyring', spawnProcess = spawn }) { super(); if (!['keyring', 'auto', 'file', 'ephemeral'].includes(credentialStore)) throw new Error('不支持此凭据存储方式'); this.credentialStore = credentialStore; this.home = home; this.executable = executable; this.spawnProcess = spawnProcess; this.pending = new Map(); this.nextId = 0; }
  async start() {
    if (this.starting) return this.starting;
    return this.starting = this.initialize();
  }
  async initialize() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.home)).isDirectory()) throw new Error('登录数据目录不能是文件链接');
    await fs.chmod(this.home, 0o700);
    // Tighten legacy file permissions before Codex can read or refresh credentials.
    const authFile = path.join(this.home, 'auth.json');
    try {
      const stat = await fs.lstat(authFile);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('登录凭据必须是独立的本机文件');
      await fs.chmod(authFile, 0o600);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    this.child = this.spawnProcess(this.executable || codexExecutable(), ['app-server', '--listen', 'stdio://', '-c', `cli_auth_credentials_store="${this.credentialStore}"`, '-c', 'forced_login_method="chatgpt"', '-c', 'web_search="disabled"', '-c', 'features.shell_tool=false', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.memory_tool=false', '-c', 'features.view_image=false', '-c', 'features.image_generation=false', '-c', 'features.code_mode=false', '-c', 'features.js_repl=false', '-c', 'features.skill_search=false', '-c', 'features.skip_host_skill_discovery=true', '-c', 'skills.bundled.enabled=false', '-c', 'skills.include_instructions=false', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'features.hooks=false', '-c', 'features.codex_hooks=false'], { cwd: this.home, env: { ...env, CODEX_HOME: this.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {}); // Auth URLs and internal logs stay out of application logs.
    this.child.stdin.on('error', () => {});
    const failed = error => { const e = new Error(safeError(error)); this.fail(e); this.emit('closed', e); };
    this.child.on('error', failed);
    this.child.on('exit', () => failed(new Error('Codex 服务已关闭，请重新连接。')));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { this.close(); return; }
      if (msg.method && msg.id !== undefined) void this.answer(msg);
      else if (msg.method) this.emit('notification', msg.method, msg.params);
      else { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(safeError(msg.error))) : p.resolve(msg.result); } }
    });
    try {
      await this.request('initialize', { clientInfo: { name: 'boan_workbench', title: '泊岸工作台', version: '0.6.4' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      this.send({ method: 'initialized', params: {} });
      return this;
    } catch (e) { this.close(); throw e; }
  }
  send(message) { if (!this.child?.stdin.writable) throw new Error('Codex 尚未连接'); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async answer(msg) {
    try {
      // Only host-provided dynamic tools are callable. Native approval requests fail closed.
      if (msg.method !== 'item/tool/call' || !this.onToolCall) throw new Error('此操作未获工作台授权，请使用工作台提供的工具。');
      const result = await this.onToolCall(msg.params);
      this.send({ id: msg.id, result });
    } catch (e) { try { this.send({ id: msg.id, error: { code: -32603, message: safeError(e) } }); } catch {} }
  }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  close() { this.fail(new Error('Codex 连接已结束')); this.lines?.close(); this.child?.stdin.end(); this.child?.kill(); }
}
