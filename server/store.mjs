import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { initializeTask, handoff } from './task-lifecycle.mjs';
import {restoreOperations} from './operations.mjs';

export const ACTIVE = ['running', 'verifying', 'stopping'];
export const now = () => new Date().toISOString();
export class Store extends EventEmitter {
  constructor(dir, project) {
    super();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'state.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      version: 1, project, tasks: [], messages: [], events: [], revision: 0,
    };
    if (this.data.project.path !== project.path || this.data.project.mode !== project.mode) throw new Error('状态目录对应另一个项目或运行模式，请设置独立的 WORKBENCH_DATA_DIR。');
    this.data.project = project;
    this.data.projectVersion ??= 1;
    this.data.requests ??= {}; this.data.actions ??= {};
    this.data.management ??= {events:[],operations:{}};
    for(const event of this.data.management.events)if(['proposing','proposed','applying'].includes(event.status))event.status='uncertain';
    restoreOperations(this.data);
    for (const t of this.data.tasks) {
      initializeTask(t);
      for(const work of t.auxiliary)if(['queued','running'].includes(work.status)){work.status='interrupted';work.error='服务已恢复，原辅助执行不再存活；结果需重新核对';work.changes=[];if(t.status==='queued'){t.status='paused';t.summary='辅助执行已中断，请核对后恢复。';}}
      for(const work of t.auxiliary)if(/^auxiliary-[A-Za-z0-9]{6}$/.test(work.workspaceDir||'')){
        const root=path.join(dir,work.workspaceDir);
        // Only reclaim the exact recorded private copy; never follow a replacement symlink.
        try{const stat=fs.lstatSync(root);if(stat.isDirectory()&&!stat.isSymbolicLink())fs.rmSync(root,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
        delete work.workspaceDir;
      }
      if(t.status==='queued'&&Object.values(this.data.management.operations).some(o=>o.taskId===t.id&&o.status==='uncertain')){t.status='paused';t.summary='上次管理安排结果待核对，请检查记录后恢复。';}
      for(const op of t.operations) if(op.status==='started') op.status='uncertain';
      if(t.currentSession){handoff(t, '服务恢复：原主执行者已失效');t.currentSession.status='unavailable';t.generation++;}
      for(const round of t.rounds)if(round.status==='running')round.status='interrupted';
      if (ACTIVE.includes(t.status) || t.decision?.kind === 'command') {
        t.status = 'paused'; t.decision = null; t.summary = '服务重启前的执行已中断。恢复时会重新检查文件并验证。';
      }
    }
    for (const e of this.data.events) if (e.kind === 'activity' && ['running', 'waiting'].includes(e.status)) e.status = 'interrupted';
    for(const [id,r] of Object.entries(this.data.requests))if(['pending','applying'].includes(r.status)){r.status='uncertain';for(const t of this.data.tasks)if((t.createdBy?.startsWith(id+':')||r.plan?.actions?.some(a=>a.taskId===t.id))&&t.status==='queued'){t.status='paused';t.summary='上次安排未完成，请核对目标后恢复。';}this.data.events.push({id:randomUUID(),taskId:null,kind:'recovery',at:now(),text:'上次输入的安排结果待核对',detail:'已保留输入与现有任务，没有自动重放。请核对工作记录后继续。'});}
    this.save();
  }
  save() {
    this.data.revision++;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.emit('change', this.snapshot());
  }
  snapshot() { return structuredClone(this.data); }
  task(id) { const t = this.data.tasks.find(t => t.id === id); if (!t) throw new Error('任务不存在'); return t; }
  add(goal, extra = {}) {
    const t = { id: randomUUID(), title: goal.slice(0, 48), goal, constraints: [], acceptance: [], status: 'queued', priority: 'normal', summary: '已接下这项工作，等待安排。', createdAt: now(), updatedAt: now(), attempts: 0, evidence: [], artifacts: [], sessions: [], deferredUntil: null, decision: null, feedback: [], ...extra };
    initializeTask(t);
    this.data.tasks.push(t); this.data.projectVersion++; this.event(t.id, 'created', '已建立任务'); return t;
  }
  patch(id, changes) { const t = this.task(id); Object.assign(t, changes, { updatedAt: now(), stateVersion: t.stateVersion + 1 }); this.save(); return t; }
  event(taskId, kind, text, detail = '', fields = {}) {
    const event = { ...fields, id: randomUUID(), taskId, kind, text, detail, at: now() };
    this.data.events.push(event);
    this.data.events = this.data.events.slice(-600); this.save(); return event.id;
  }
  updateEvent(taskId, id, fields) {
    const event = this.data.events.find(e => e.id === id && e.taskId === taskId);
    if (event) { Object.assign(event, fields); this.save(); }
  }
  message(role, text, taskId = null) {
    this.data.messages.push({ id: randomUUID(), role, text, taskId, at: now() });
    this.data.messages = this.data.messages.slice(-120); this.save();
  }
}

export function attention(tasks, at = Date.now()) {
  return tasks.filter(t => ['blocked', 'review', 'failed'].includes(t.status) && (!t.deferredUntil || Date.parse(t.deferredUntil) <= at))
    .sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || ({ blocked: 0, failed: 1, review: 2 }[a.status] - { blocked: 0, failed: 1, review: 2 }[b.status]) || a.createdAt.localeCompare(b.createdAt));
}

export function overview(tasks) {
  if (!tasks.length) return '把目标交给我，我们从第一件事开始。';
  const count = s => tasks.filter(t => s.includes(t.status)).length;
  const parts = [];
  if (count(['review'])) parts.push(`${count(['review'])} 项成果可验收`);
  if (count(['blocked', 'failed'])) parts.push(`${count(['blocked', 'failed'])} 件事需要你处理`);
  if (count(['running', 'verifying', 'queued', 'stopping'])) parts.push(`${count(['running', 'verifying', 'queued', 'stopping'])} 项工作在推进`);
  if (!parts.length && count(['paused'])) return '工作已暂停，随时可以继续。';
  return parts.length ? `${parts.join('，')}。` : '所有成果已验收，可以开始新的工作。';
}
