import { t } from './i18n.mjs';
const fileTools = new Set(['read_file', 'list_files', 'write_file']);
function operation(event) {
  if (event.kind === 'activity' && fileTools.has(event.tool)) return { ...event };
  // Old versions stored only tool starts. Preserve the absence of a completion result.
  if (event.kind === 'tool') {
    const tool = event.text?.match(/^执行 (read_file|list_files|write_file)$/)?.[1];
    if (tool) {
      let file;
      try { file = JSON.parse(event.detail).path; } catch { if (tool === 'write_file') file = event.detail; }
      return { ...event, tool, path: typeof file === 'string' ? file : undefined };
    }
  }
  return event;
}

export function groupExecutionEvents(events, taskId) {
  const groups = [];
  for (const raw of events) {
    if (raw.taskId !== taskId) continue;
    const event = operation(raw);
    const category = fileTools.has(event.tool) && (!event.status || event.status === 'completed')
      ? event.tool === 'write_file' ? 'write' : 'explore' : null;
    const previous = groups.at(-1);
    if (category && previous?.category === category) previous.items.push(event);
    else if (category) groups.push({ id: event.id, category, items: [event] });
    else groups.push(event);
  }
  return groups;
}

export function groupSummary(group) {
  const count = tool => group.items.filter(e => e.tool === tool).length;
  const parts = [];
  if (count('read_file')) parts.push(t('读取 {0} 次',count('read_file')));
  if (count('list_files')) parts.push(t('浏览目录 {0} 次',count('list_files')));
  if (count('write_file')) parts.push(t('写入 {0} 次',count('write_file')));
  return parts.join(' · ');
}
