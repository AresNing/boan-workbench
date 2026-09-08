import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandboxLaunch } from './sandbox.mjs';

// Resolve the nearest existing ancestor so symlink escapes are also rejected for new files.
export async function scopedPath(root, requested, { write = false, protectedRoots = [] } = {}) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) throw new Error('文件路径无效');
  const base = await fs.realpath(root);
  const target = path.resolve(base, requested);
  const protectedPaths = await Promise.all(protectedRoots.filter(Boolean).map(p => fs.realpath(p).catch(() => path.resolve(p))));
  const guard = file => { if (protectedPaths.some(p => file === p || file.startsWith(p + path.sep))) throw new Error('应用数据不在 Agent 可访问范围内'); };
  guard(target);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能访问项目内的文件');
  if (rel.split(path.sep).some(part => {const p=part.toLowerCase();return ['.git', '.workbench', '.ssh', '.env', '.npmrc', 'auth.json', 'credentials.json', '.credentials.json'].includes(p) || p.startsWith('.env.');})) throw new Error('此文件不在 Agent 可访问范围内');
  let ancestor = target;
  while (true) {
    try {
      const resolved = await fs.realpath(ancestor);
      guard(resolved);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('文件链接指向项目外部');
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // A dangling symlink must not be treated as a new regular file.
      try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('不能访问失效的文件链接'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      ancestor = path.dirname(ancestor);
    }
  }
  if (write && /(^|\/)node_modules\//.test(rel)) throw new Error('不能直接修改依赖目录');
  return target;
}

export async function listFiles(root, subdir = '.', {exclude = []} = {}) {
  const start = subdir === '.' ? root : await scopedPath(root, subdir);
  const out = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (out.length >= 400) return;
      if (e.name.startsWith('.') || ['node_modules', 'dist', ...exclude].includes(e.name) || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full); else out.push(path.relative(root, full));
    }
  }
  await walk(start); return out;
}

export async function runCommand(root, command, { signal, timeout = 90_000, onOutput, onSpawn, onSettled, sandbox = false, network = false, runtimeBin, protectedRoots = [] } = {}) {
  const launch = sandbox ? await sandboxLaunch(root, { network, runtimeBin, protectedRoots }) : null;
  try { return await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('执行已中止'));
    // Do not pass model/API credentials to project commands.
    const env = launch?.env || Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SHELL', 'SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    // Gate command execution until its process group has a durable owner record.
    const script=onSpawn?'IFS= read -r boan_start || exit 125; [ "$boan_start" = start ] || exit 125; exec /bin/sh -c "$1"':command;
    const child = spawn(launch?.executable || '/bin/sh', [...(launch?.prefix || []), ...(launch ? ['/bin/sh'] : []), '-c', script,...(onSpawn?['boan-command',command]:[])], { cwd: root, env, detached: true, stdio: [onSpawn?'pipe':'ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false, killTimer, spawnError;
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if(onSpawn){
      child.stdin.on('error',()=>{});
      child.once('spawn',()=>{try{if(signal?.aborted)throw Error('执行已中止');onSpawn(child.pid);child.stdin.end('start\n');}catch(e){spawnError=e;child.stdin.end();stop();}});
    }
    let outputTimer;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', d => {
      output = (output + d.toString()).slice(-24000);
      if (onOutput && !outputTimer) outputTimer = setTimeout(() => { outputTimer = null; onOutput(output); }, 250);
    });
    const clean = () => { clearTimeout(outputTimer); clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    child.on('error', err => { clean(); reject(err); });
    child.on('close', (code, terminatedBy) => { clean();try{onSettled?.(child.pid);}catch(e){spawnError??=e;}if(spawnError){reject(spawnError);return;}if (!output && terminatedBy) output = `进程被 ${terminatedBy} 中止。`; resolve({ command, processGroup:child.pid, exitCode: code ?? -1, output, passed: code === 0 && !timedOut && !signal?.aborted, timedOut, aborted: !!signal?.aborted, sandboxed: !!launch, network: !!launch && network, at: new Date().toISOString() }); });
  }); } finally { await launch?.cleanup(); }
}
