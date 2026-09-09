// Official Chat Completions endpoint and stable model IDs, checked 2026-09-09.
// https://api-docs.deepseek.com/
export const deepseekBaseUrl = 'https://api.deepseek.com';
export const deepseekModels = ['deepseek-v4-flash', 'deepseek-v4-pro'];
export const deepseekCompat = {
  supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
  requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek',
};
