import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export function claudeExecutable() {
  const root = path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
  return path.resolve(root, `../claude-agent-sdk-${process.platform}-${process.arch}/claude`).replace('/app.asar/', '/app.asar.unpacked/');
}
export function claudeEnv(home, source = process.env) {
  const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','SHELL','SYSTEMROOT'].filter(k=>source[k]).map(k=>[k,source[k]]));
  return { ...env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', DISABLE_AUTOUPDATER:'1', BROWSER:'/usr/bin/true' };
}
export function claudeOptions(config) {
  const env = claudeEnv(config.claudeHome);
  return { pathToClaudeCodeExecutable: config.claudeExecutable || claudeExecutable(), env,
    cwd: config.projectPath, tools: [], settingSources: [], strictMcpConfig: true, persistSession: false,
    permissionMode:'default', settings: { disableAllHooks:true, disableClaudeAiMcp:true, claudeAiSkillsSync:false, claudeAiPluginsSync:false, fastMode: config.speed==='fast', fastModePerSessionOptIn:true },
    ...(config.claudeModel ? {model:config.claudeModel} : {}), ...(config.effort ? {effort:config.effort} : {}),
    spawnClaudeCodeProcess: options => spawn(options.command, options.args, { cwd:options.cwd, env, stdio:['pipe','pipe','pipe'], signal:options.signal }),
  };
}
