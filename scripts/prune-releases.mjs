import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const releaseRoot = fileURLToPath(new URL('../release/', import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function newestFirst(a, b) {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
  return 0;
}

export async function pruneReleases({ root = releaseRoot, apply = false, runningPaths } = {}) {
  root = path.resolve(root);
  try { if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('拒绝清理符号链接形式的 release 目录'); }
  catch (e) { if (e.code === 'ENOENT') return { keep: [], remove: [], deleted: [] }; throw e; }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const groups = new Map();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const version = entry.isDirectory() && versionPattern.test(entry.name) ? entry.name
      : entry.isFile() ? entry.name.match(/^Boan-Workbench-(\d+\.\d+\.\d+)-mac-(?:arm64|x64)\.(?:zip|dmg)(?:\.blockmap)?$/)?.[1] : null;
    if (!version || !versionPattern.test(version)) continue;
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version).push(entry.name);
  }
  const versions = [...groups.keys()].sort(newestFirst);
  const keep = versions.slice(0, 3), remove = versions.slice(3).flatMap(v => groups.get(v));
  if (!apply || !remove.length) return { keep, remove, deleted: [] };
  // Fail closed if process inspection is unavailable. Never remove a running bundle.
  runningPaths ??= execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').map(s => s.trim());
  const realRoot = await fs.realpath(root);
  for (const name of remove) {
    const target = path.join(root, name), realTarget = path.join(realRoot, name);
    if (runningPaths.some(p => p === target || p.startsWith(target + path.sep) || p === realTarget || p.startsWith(realTarget + path.sep))) throw new Error(`历史版本仍在运行，暂不清理：${name}`);
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error(`目录已变为链接，停止清理：${name}`);
  }
  const deleted = [];
  for (const name of remove) { await fs.rm(path.join(root, name), { recursive: true }); deleted.push(name); }
  return { keep, remove, deleted };
}

// Called by electron-builder only after all requested artifacts build successfully.
export default async function afterAllArtifactBuild() {
  try { console.log('[版本保留]', JSON.stringify(await pruneReleases({ apply: true }))); }
  catch (e) { console.warn(`[版本保留] 清理未完成：${e.message}。请稍后运行 npm run release:prune -- --apply。`); }
  return [];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('仅支持 --apply；默认只预览');
  console.log(JSON.stringify(await pruneReleases({ apply: process.argv.includes('--apply') }), null, 2));
}
