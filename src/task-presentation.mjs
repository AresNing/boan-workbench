export function recovery(task) {
  const reason = task?.summary || '';
  if (/登录|凭据|unauthoriz|authentication|token.*expir|401/i.test(reason)) return { title: '模型登录需要更新', detail: '重新连接账号后，返回此任务重试。', action: '重新登录', kind: 'settings' };
  if (/quota|余额|额度|rate.?limit|429/i.test(reason)) return { title: '模型额度或请求频率受限', detail: '检查模型账号，或稍后重试。', action: '检查模型账号', kind: 'settings' };
  if (/验证|test.*fail/i.test(reason)) return { title: '成果验证未通过', detail: '查看验证结果，可补充修复要求或重试。', action: '查看验证结果', kind: 'evidence' };
  if (/network|fetch|timeout|timed out|连接|超时|网络/i.test(reason)) return { title: '连接暂时未完成', detail: '检查网络后重试，已有进度会保留。', action: '重试', kind: 'retry' };
  return { title: '任务执行未完成', detail: '已有进度已保留。可查看错误详情，重试或补充要求。', action: '重试', kind: 'retry' };
}
