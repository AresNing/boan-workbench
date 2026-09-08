import { groupExecutionEvents } from './execution-groups.mjs';

export function historyDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Keep interleaved work in its actual time order; never infer message ownership.
export function groupHistory(events, messages, taskId) {
  const entries = [...events, ...messages.map(m => ({ ...m, kind: m.role }))]
    .filter(e => !taskId || e.taskId === taskId)
    .sort((a, b) => a.at.localeCompare(b.at));
  const groups = [];
  for (const entry of entries) {
    const owner = entry.taskId || null, day = historyDay(entry.at), last = groups.at(-1);
    if (last && last.taskId === owner && last.day === day && Date.parse(entry.at) - Date.parse(last.end) <= 30 * 60_000) {
      last.items.push(entry); last.end = entry.at;
    } else groups.push({ id: entry.id, taskId: owner, day, start: entry.at, end: entry.at, items: [entry] });
  }
  return groups.reverse().map(group => ({ ...group, entries: groupExecutionEvents(group.items.map(e => ({ ...e, taskId: e.taskId || null })), group.taskId).reverse() }));
}
