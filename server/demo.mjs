import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { overview } from './store.mjs';

export class DemoBackend {
  constructor(config) { this.config = config; }
  async manage(text, state, focusId) {
    const named = state.tasks.filter(t => (text.includes('导出') && t.title.includes('导出')) || (text.includes('登录') && t.title.includes('登录')) || text.includes(t.title));
    const focus = named[0] || state.tasks.find(t => t.id === focusId);
    const taskId = focus?.id;
    if (/进度|怎么样|状态|现在如何/.test(text)) return { reply: overview(state.tasks), actions: [] };
    if (/暂停|停一下|先停/.test(text)) return taskId ? { reply: '已请求暂停，执行结束后会保留进度。', actions: [{ type: 'pause', taskId }] } : { reply: '请先选中要暂停的任务，或在输入中带上任务名称。', actions: [] };
    if (/继续|恢复/.test(text) && taskId) return { reply: '已安排继续，会先检查现有结果。', actions: [{ type: 'resume', taskId }] };
    if (/优先|更急|最急/.test(text) && taskId) return { reply: '已提高优先级，当前执行会先安全收尾。', actions: [{ type: 'priority', taskId, priority: 'high' }] };
    if (/验收|接受成果/.test(text) && taskId) return { reply: '请使用任务上的确认完成按钮验收成果。', actions: [] };
    if (/改成|不要|约束|补充|需要改|修改/.test(text) && taskId) return { reply: '补充要求已保存，会重新执行并验证。', actions: [{ type: 'amend', taskId, text }] };
    const goals = text.split(/\n|[；;]|，?再(?:帮我)?|，?顺便/).map(s => s.trim()).filter(Boolean).slice(0, 4);
    return { reply: `已接下 ${goals.length} 项演示任务，将在示例目录生成文件并验证。`, actions: goals.map(goal => ({ type: 'create', text: goal, title: goal.slice(0, 40) })) };
  }
  async execute(task, ctx) {
    await delay(this.config.demoDelay ?? 700, undefined, { signal: ctx.signal });
    ctx.session(`demo-${task.id}-${task.attempts}`);
    if (task.demoKind === 'login' && !task.decisions?.length) {
      ctx.decision({ question: 'GitHub 账号与现有账号如何关联？', recommendation: '建议由用户登录后手动绑定，保留现有账号表。', options: ['登录后手动绑定', '本版仅支持独立登录'] }); return null;
    }
    const dir = path.join(this.config.projectPath, task.id);
    await fs.mkdir(dir, { recursive: true });
    if (task.demoKind === 'export') {
      const quote = task.attempts > 1 ? "const cell = v => /[,\"\\n]/.test(String(v)) ? '\"' + String(v).replaceAll('\"', '\"\"') + '\"' : String(v);" : 'const cell = v => String(v);';
      await fs.writeFile(path.join(dir, 'export.mjs'), `${quote}\nexport const exportCsv = rows => rows.map(row => row.map(cell).join(',')).join('\\n');\n`);
      await fs.writeFile(path.join(dir, 'export.test.mjs'), `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {exportCsv} from './export.mjs';\ntest('普通字段',()=>assert.equal(exportCsv([['a','b']]),'a,b'));\ntest('逗号转义',()=>assert.equal(exportCsv([['a,b']]),'"a,b"'));\ntest('引号转义',()=>assert.equal(exportCsv([['a"b']]),'"a""b"'));\ntest('空输入',()=>assert.equal(exportCsv([]),''));\n`);
      ctx.artifact(`${task.id}/export.mjs`); ctx.artifact(`${task.id}/export.test.mjs`);
      ctx.event('implementation', '示例代码已生成，交给独立验证');
      return { summary: 'CSV 导出示例已实现，逗号和引号等边界场景通过本地测试。这里验证的是演示代码，未修改你的业务项目。', verificationCommand: `node --test ${task.id}/export.test.mjs` };
    }
    const receipt = { goal: task.goal, constraints: task.constraints, feedback: task.feedback, decisions: task.decisions || [], mode: 'demo' };
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(receipt, null, 2));
    await fs.writeFile(path.join(dir, 'result.test.mjs'), `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\ntest('演示成果保留目标和约束',()=>{const data=JSON.parse(fs.readFileSync(new URL('./result.json',import.meta.url)));assert.equal(data.goal,${JSON.stringify(task.goal)});assert.equal(data.mode,'demo');assert.deepEqual(data.constraints,${JSON.stringify(task.constraints)});});\n`);
    ctx.artifact(`${task.id}/result.json`); ctx.artifact(`${task.id}/result.test.mjs`);
    return { summary: '演示成果已生成，目标、约束和决定已写入结果文件并通过测试。真实需求实现需要切换到 pi 模式。', verificationCommand: `node --test ${task.id}/result.test.mjs` };
  }
  async steer() {}
}
