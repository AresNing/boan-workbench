import { randomUUID } from 'node:crypto';
import { fingerprint } from './task-lifecycle.mjs';

// Dependencies refer to explicit deliveries, never to another task's conversation.
export function currentDelivery(task, mode = 'verified') {
  if (!task || !['review', 'done'].includes(task.status)) return null;
  const delivery = task.deliveries?.at(-1);
  if (!delivery || delivery.version !== task.requirementVersion || delivery.applicability === 'superseded') return null;
  const evidence = Array.isArray(delivery.evidence) ? delivery.evidence : [delivery.evidence];
  if (!evidence.some(e => e?.passed && e.applicability !== 'superseded' && (e.requirementVersion === delivery.version || delivery.source === 'legacy' && e.requirementVersion === undefined))) return null;
  if (mode === 'accepted' && (!delivery.acceptedAt || task.status !== 'done')) return null;
  return delivery;
}

export function dependencyOrder(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t])), visiting = new Set(), visited = new Set(), ordered = [];
  function visit(task) {
    if (visiting.has(task.id)) throw Error('任务依赖不能成环');
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const edge of task.dependencies || []) {
      const source = byId.get(edge.taskId);
      if (source) visit(source);
    }
    visiting.delete(task.id); visited.add(task.id); ordered.push(task);
  }
  for (const task of tasks) visit(task);
  return ordered;
}

export function validateDependencies(tasks, taskId, input) {
  if (!Array.isArray(input) || input.length > 32) throw Error('任务依赖列表无效');
  const seen = new Set();
  const edges = input.map(edge => {
    if (!edge || typeof edge.taskId !== 'string' || edge.taskId === taskId || seen.has(edge.taskId)) throw Error('依赖不能重复或指向自身');
    const source = tasks.find(t => t.id === edge.taskId);
    if (!source) throw Error('上游任务不存在');
    if (edge.expectedVersion !== source.stateVersion) throw Error('上游任务状态已变化，请按最新状态重新安排');
    const mode = edge.mode || 'verified';
    if (!['verified', 'accepted'].includes(mode)) throw Error('依赖完成条件无效');
    seen.add(edge.taskId);
    return { taskId: edge.taskId, mode };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
  dependencyOrder(tasks.map(t => t.id === taskId ? { ...t, dependencies: edges } : t));
  return edges;
}

export function dependencyState(task, tasks) {
  const sources = [], waiting = [], stamps = [];
  for (const edge of task.dependencies || []) {
    const source = tasks.find(t => t.id === edge.taskId), delivery = currentDelivery(source, edge.mode);
    stamps.push({ ...edge, version: source?.requirementVersion ?? null, deliveryId: delivery?.id ?? null });
    if (!delivery) {
      waiting.push(source ? `等待「${source.title}」${edge.mode === 'accepted' ? '确认完成' : '通过验证并提交最新成果'}` : '上游任务不存在，需调整依赖');
      continue;
    }
    sources.push({ taskId: source.id, title: source.title, requirementVersion: source.requirementVersion, deliveryId: delivery.id,
      summary: delivery.summary, artifacts: [...delivery.artifacts], evidence: structuredClone(delivery.evidence),
      scope: '上游任务的验收标准', acceptance: [...source.acceptance], verified: true, accepted: Boolean(delivery.acceptedAt) });
  }
  return { signature: fingerprint(stamps), sources, waiting };
}

export function invalidateDependencyResult(task, reason) {
  const version = ++task.requirementVersion, at = new Date().toISOString();
  const update = { id: randomUUID(), version, change: 'dependency', text: reason, status: 'saved', savedAt: at };
  task.updates.push(update);
  for (const evidence of task.evidence) evidence.applicability = 'superseded';
  for (const delivery of task.deliveries) delivery.applicability = 'superseded';
  delete task.acceptedAt;
  return update;
}
