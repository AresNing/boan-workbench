import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from './runtime.mjs';
import { deepseekModels } from '../shared/deepseek.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const mode = process.argv.includes('--demo') ? 'demo' : 'pi';
const dataDir = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(root, '.workbench', mode));
const projectPath = mode === 'demo' ? path.join(dataDir, 'project') : process.env.WORKBENCH_PROJECT;
if (!projectPath || !path.isAbsolute(projectPath)) throw new Error('真实执行请设置 WORKBENCH_PROJECT 为项目绝对路径；无需模型账号体验请运行 npm run demo。');
const runtime = await startRuntime({
  mode, dataDir, projectPath, distDir: path.join(root, 'dist'), port: Number(process.env.PORT || 4317),
  provider: process.env.WORKBENCH_PROVIDER || 'anthropic', model: process.env.WORKBENCH_MODEL || (process.env.WORKBENCH_PROVIDER === 'deepseek' ? deepseekModels[0] : 'claude-sonnet-4-5'),
  baseUrl: process.env.WORKBENCH_BASE_URL, apiKey: process.env.WORKBENCH_API_KEY,
  verifyCommand: mode === 'demo' ? undefined : process.env.WORKBENCH_VERIFY_COMMAND,
  maxTurns: Number(process.env.WORKBENCH_MAX_TURNS || 30), runTimeoutMs: Number(process.env.WORKBENCH_RUN_TIMEOUT_MS || 3600000),
});
console.log(`泊岸工作台已启动：${runtime.url}（${mode === 'demo' ? '演示' : 'pi 真实执行'}）`);
let closing = false;
async function close() { if (closing) return; closing = true; await runtime.close(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
