import { describe, expect, it } from 'vitest';
import { enrichSessionResponse, createMetadataStream, loadCatalog } from '../../scripts/studio-kimi-acp.mjs';

const pro = 'moonshot/kimi-k3.1-pro';
const fast = `${pro}-highspeed`;
const thinking = { id: 'thinking', name: 'Thinking', type: 'select', category: 'thought_level', currentValue: 'high', options: ['low', 'high', 'max'].map(value => ({ value, name: `Thinking ${value}` })) };
const response = () => ({ jsonrpc: '2.0', id: 2, result: { sessionId: 'test', configOptions: [
  { id: 'model', category: 'model', type: 'select', currentValue: pro, options: [{ value: pro, name: 'Pro' }, { value: fast, name: 'Highspeed' }] }, thinking,
] } });
const catalog = [pro, fast].map(id => ({ id, capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: true } } } }));

describe('9Router Kimi ACP discovery', () => {
  it('supplies independent Thinking controls for every router-supported native model', () => {
    const input = response();
    const result = enrichSessionResponse(input, catalog);
    expect(result.result.models.currentModelId).toBe(pro);
    for (const model of result.result.models.availableModels) {
      expect(model.modelOptions[0].options.map(x => x.value)).toEqual(['low', 'high', 'max']);
      expect(model.modelOptions[0].currentValue).toBe('high');
    }
    expect(result.result.configOptions).toEqual(input.result.configOptions);
    expect(input.result.models).toBeUndefined();
  });
  it('uses each model capability, without inventing choices for unknown models', () => {
    const entries = [catalog[0], { id: fast, capabilities: { effort: { supported: true, low: { supported: true } } } }];
    expect(enrichSessionResponse(response(), entries).result.models.availableModels[1].modelOptions[0].options.map(x => x.value)).toEqual(['low']);
    expect(enrichSessionResponse(response(), [catalog[0]]).result.models.availableModels[1].modelOptions).toBeUndefined();
    expect(enrichSessionResponse(response(), []).result.models).toBeUndefined();
  });
  it('preserves future vendor model metadata and all non-discovery messages', () => {
    const native = response();
    native.result.models = { currentModelId: pro, availableModels: [{ modelId: pro, modelOptions: [thinking] }] };
    expect(enrichSessionResponse(native, catalog)).toBe(native);
    for (const message of [{ id: 3, result: {} }, { id: 4, error: { code: -32600 } }, { method: 'session/update', params: { text: 'keep me' } }]) {
      expect(enrichSessionResponse(message, catalog)).toBe(message);
    }
  });
  it('does not infer support from generic reasoning or copy unsupported native choices', () => {
    expect(enrichSessionResponse(response(), [{ id: fast, capabilities: { reasoning: true } }])).toEqual(response());
    const input = response();
    input.result.configOptions[1] = { ...thinking, options: [{ value: 'high', name: 'High' }] };
    expect(enrichSessionResponse(input, catalog).result.models.availableModels[1].modelOptions[0].options).toEqual([{ value: 'high', name: 'High' }]);
  });
  it('preserves tool traffic byte-for-byte across chunks, including oversized frames', async () => {
    const stream = createMetadataStream(catalog, { maxFrameBytes: 1024 });
    const chunks = [];
    stream.on('data', x => chunks.push(x));
    const done = new Promise(resolve => stream.on('end', resolve));
    const passthrough = Buffer.from('not json\r\n' + JSON.stringify({ method: 'tool', data: 'x'.repeat(5000) }) + '\n');
    const input = Buffer.concat([passthrough, Buffer.from(JSON.stringify(response()) + '\nunterminated')]);
    for (let i = 0; i < input.length; i += 71) stream.write(input.subarray(i, i + 71));
    stream.end();
    await done;
    const output = Buffer.concat(chunks).toString();
    expect(output.startsWith(passthrough.toString())).toBe(true);
    expect(JSON.parse(output.split('\n')[2]).result.models.availableModels[1].modelOptions).toHaveLength(1);
    expect(output.endsWith('unterminated')).toBe(true);
  });
  it('limits authenticated discovery to loopback and declines redirects/failures', async () => {
    let calls = 0;
    const fetchImpl = async (_url, options) => {
      calls++;
      expect(options.redirect).toBe('error');
      expect(options.headers.Authorization).toBe('Bearer local-test');
      return new Response(JSON.stringify({ data: catalog }));
    };
    expect(await loadCatalog({ token: 'local-test', fetchImpl })).toEqual(catalog);
    expect(await loadCatalog({ token: 'local-test', url: 'https://example.com/v1/models', fetchImpl })).toEqual([]);
    expect(calls).toBe(1);
    expect(await loadCatalog({ token: 'local-test', fetchImpl: async () => new Response('', { status: 401 }) })).toEqual([]);
    expect(await loadCatalog({ token: 'local-test', fetchImpl: async () => { throw new Error('offline'); } })).toEqual([]);
  });
});
