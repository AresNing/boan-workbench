// Only explicit public progress is recorded; never serialize tool arguments or model reasoning.
export function publicText(value, secret = '') {
  let text = String(value ?? '');
  if (secret) text = text.split(secret).join('[已隐藏密钥]');
  return text.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏密钥]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[已隐藏令牌]')
    .replace(/((?:access_token|refresh_token|api_key|password)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[已隐藏]')
    .slice(0, 12000);
}

export function activityRecorder(store, taskId, secret) {
  return (id, values) => {
    const fields = {};
    for (const key of ['text', 'tool', 'path', 'command', 'output', 'status']) if (values[key] !== undefined) fields[key] = publicText(values[key], secret);
    for (const key of ['exitCode', 'durationMs']) if (Number.isFinite(values[key])) fields[key] = values[key];
    if (id) { store.updateEvent(taskId, id, fields); return id; }
    return store.event(taskId, 'activity', fields.text || '执行操作', '', fields);
  };
}
