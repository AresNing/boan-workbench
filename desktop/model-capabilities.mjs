// Local SDK metadata; no credentials or network are needed for capability discovery.
export function apiCapabilities(provider, model, catalog) {
  const known = catalog?.getModel(provider, model);
  const efforts = known?.reasoning ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level =>
    known.thinkingLevelMap?.[level] !== null && (['low', 'medium', 'high'].includes(level) || typeof known.thinkingLevelMap?.[level] === 'string')) : [];
  const speeds = [{ value: 'standard', label: '标准' }];
  if (known && provider === 'openai') speeds.push({ value: 'priority', label: '快速 · 优先处理' });
  if (provider === 'anthropic' && ['claude-opus-4-8', 'claude-opus-5'].includes(model)) speeds.push({ value: 'fast', label: '快速' });
  return { efforts, speeds };
}
export function codexCapabilities(model) {
  const efforts = (model?.efforts || []).filter(e => typeof e === 'string' && /^[a-z]+$/.test(e));
  const tiers = model?.speeds || [];
  return { efforts, speeds: [{ value: 'standard', label: '标准' }, ...tiers.filter(t => t.value !== 'standard' && t.value !== 'default' && /^[a-z_-]+$/.test(t.value)).map(t => ({value:t.value,label:t.label || t.value}))] };
}
