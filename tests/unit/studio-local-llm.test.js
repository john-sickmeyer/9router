import { describe, it, expect } from 'vitest';
import { applyThinking, validateThinkingIntent } from '../../open-sse/translator/concerns/thinkingUnified.js';
import { DefaultExecutor } from '../../open-sse/executors/default.js';
import { studioModelCatalog } from '../../open-sse/services/studioCatalog.js';
import { LOCAL_LLM_MODEL, LOCAL_LLM_ROUTE, LOCAL_LLM_EFFORTS } from '../../open-sse/config/localLlm.js';
const provider = 'openai-compatible-chat-studio-local';
describe('Studio local DeepSeek', () => {
  it.each(LOCAL_LLM_EFFORTS)('preserves %s through thinking normalization and the executor', effort => {
    const body = { model: LOCAL_LLM_MODEL, messages: [{role:'user',content:'test'}], reasoning_effort: effort };
    applyThinking('openai', LOCAL_LLM_MODEL, body, provider);
    const out = new DefaultExecutor(provider).transformRequest(LOCAL_LLM_MODEL, body, false, {});
    expect(out.reasoning_effort).toBe(effort === 'none' ? 'high' : effort);
    if (effort === 'none') expect(out.chat_template_kwargs).toMatchObject({enable_thinking:false, thinking_mode:'chat',reasoning_effort:'high'});
  });
  it('rejects unsupported effort before inference', () => {
    expect(validateThinkingIntent(provider, LOCAL_LLM_MODEL, {reasoning_effort:'medium'})).toContain('Local DeepSeek');
    expect(validateThinkingIntent(provider, LOCAL_LLM_MODEL, {reasoning_effort:'low'})).toBeNull();
  });
  it('advertises local only when configured and never in the Claude catalog', () => {
    expect(studioModelCatalog([])).toEqual([]);
    const models = [{id: LOCAL_LLM_ROUTE}];
    expect(studioModelCatalog(models)[0]).toMatchObject({display_name:'Deepseek',context_length:65536});
    expect(studioModelCatalog(models,{anthropic:true})).toEqual([]);
  });
  it('does not alter cloud DeepSeek or reject other providers efforts', () => {
    const body={reasoning_effort:'medium'};
    expect(new DefaultExecutor('deepseek').transformRequest(LOCAL_LLM_MODEL,body,false,{})).toBe(body);
    expect(()=>new DefaultExecutor(provider).transformRequest(LOCAL_LLM_MODEL,body,false,{})).toThrow('supports thinking');
  });
});
