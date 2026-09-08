import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['server/index.mjs', '--demo'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })];
let stopped = false;
const stop = () => { if (stopped) return; stopped = true; for (const child of children) child.kill('SIGTERM'); };
for (const c of children) c.on('exit', stop);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
