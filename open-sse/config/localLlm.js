// The Studio's native DeepSeek checkpoint, served by oMLX through an SSH tunnel.
export const LOCAL_LLM_MODEL = 'deepseek-v4.1-flash-native';
export const LOCAL_LLM_ROUTE = `local/${LOCAL_LLM_MODEL}`;
export const LOCAL_LLM_EFFORTS = ['none', 'low', 'high', 'max'];
export const LOCAL_LLM_CONTEXT = 65536;
export const isLocalLlm = (provider, model) => String(provider || '').startsWith('openai-compatible-') && model === LOCAL_LLM_MODEL;
export const LOCAL_LLM_CAPABILITIES = { reasoning: true, tools: true, vision: true,
  thinkingFormat: 'openai', thinkingCanDisable: true, contextWindow: LOCAL_LLM_CONTEXT, maxOutput: 8192 };

export function normalizeLocalLlmRequest(provider, model, body) {
  if (!isLocalLlm(provider, model)) return body;
  const effort = body.reasoning_effort;
  if (effort != null && !LOCAL_LLM_EFFORTS.includes(effort)) {
    throw new Error(`Local DeepSeek supports thinking: ${LOCAL_LLM_EFFORTS.join(', ')}`);
  }
  // The native encoder validates effort even with thinking disabled. Keep its
  // valid default and independently switch to chat mode for an Off request.
  if (effort === 'none') return { ...body, reasoning_effort: 'high',
    chat_template_kwargs: { ...body.chat_template_kwargs, enable_thinking: false, thinking_mode: 'chat', reasoning_effort: 'high' } };
  return body;
}
