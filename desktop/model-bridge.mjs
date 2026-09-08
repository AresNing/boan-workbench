import { randomUUID } from 'node:crypto';

export function workerModels(channel = process) {
  const pending = new Map();
  channel.on('message', message => {
    if (message.type !== 'model-resolved') return;
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error)) : request.resolve(message.config);
  });
  channel.on('disconnect', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('模型服务连接已关闭')); } pending.clear(); });
  return selection => new Promise((resolve, reject) => {
    if (!channel.connected) return reject(new Error('模型服务连接已关闭'));
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('读取模型配置超时')); }, 30000);
    pending.set(id, { resolve, reject, timer }); channel.send({ type: 'model-resolve', id, selection });
  });
}
