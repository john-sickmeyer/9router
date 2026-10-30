#!/usr/bin/env node
// Bridge 9Router model capabilities to stock ACP clients; the vendor CLI executes everything.
import { spawn } from 'node:child_process';
import { constants, homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export async function loadCatalog({ token, url = 'http://127.0.0.1:20128/v1/models', fetchImpl = fetch } = {}) {
  try {
    const target = new URL(url);
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || target.protocol !== 'http:' || target.username || target.password) return [];
    const response = await fetchImpl(target, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return [];
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) return [];
      chunks.push(chunk);
    }
    const catalog = JSON.parse(Buffer.concat(chunks).toString());
    return Array.isArray(catalog?.data) ? catalog.data : [];
  } catch {
    // Discovery is optional. A router restart must not prevent native CLI startup.
    return [];
  }
}

export function enrichSessionResponse(message, catalog) {
  const result = message?.result;
  if (!result?.sessionId || result.models || !Array.isArray(result.configOptions)) return message;
  const selector = result.configOptions.find(option => option?.id === 'model' && option.type === 'select');
  const thinking = result.configOptions.find(option => option?.id === 'thinking' && option.type === 'select');
  if (!selector?.currentValue || !Array.isArray(selector.options) || !Array.isArray(thinking?.options)) return message;
  const byId = new Map(catalog.filter(model => typeof model?.id === 'string').map(model => [model.id, model]));
  let enriched = false;
  const availableModels = selector.options.filter(option => typeof option?.value === 'string' && typeof option.name === 'string').map(option => {
    const model = { modelId: option.value, name: option.name, ...(option.description ? { description: option.description } : {}) };
    const effort = byId.get(option.value)?.capabilities?.effort;
    if (effort?.supported !== true) return model;
    const options = thinking.options.filter(choice => typeof choice?.value === 'string' && effort[choice.value]?.supported === true);
    if (options.length === 0) return model;
    const currentValue = options.some(choice => choice.value === thinking.currentValue) ? thinking.currentValue : options[0].value;
    enriched = true;
    return { ...model, modelOptions: [{ ...thinking, currentValue, options }] };
  });
  if (!enriched) return message;
  return { ...message, result: { ...result, models: { currentModelId: selector.currentValue, availableModels } } };
}

export function createMetadataStream(catalog, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  let buffered = Buffer.alloc(0);
  let passthrough = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const piece = chunk.subarray(start, newline < 0 ? chunk.length : newline + 1);
        if (passthrough || buffered.length + piece.length > maxFrameBytes) {
          if (buffered.length) this.push(buffered);
          buffered = Buffer.alloc(0);
          this.push(piece);
          passthrough = newline < 0;
        } else {
          buffered = Buffer.concat([buffered, piece]);
          if (newline >= 0) {
            let output = buffered;
            try {
              const original = JSON.parse(buffered.toString());
              const enriched = enrichSessionResponse(original, catalog);
              if (enriched !== original) output = Buffer.from(JSON.stringify(enriched) + '\n');
            } catch { /* Preserve non-JSON diagnostic output. */ }
            this.push(output);
            buffered = Buffer.alloc(0);
          }
        }
        start += piece.length;
      }
      callback();
    },
    flush(callback) {
      if (buffered.length) this.push(buffered);
      callback();
    },
  });
}

async function main() {
  const args = process.argv.slice(2);
  const acp = args[0] === 'acp';
  const command = process.env.STUDIO_KIMI_NATIVE_PATH || resolve(homedir(), '.kimi-code/bin/kimi');
  if (resolve(command) === fileURLToPath(import.meta.url)) throw new Error('Native Kimi path points to the adapter');
  const catalog = acp ? await loadCatalog({ token: process.env.ANTHROPIC_AUTH_TOKEN, url: process.env.STUDIO_KIMI_CATALOG_URL }) : [];
  const child = spawn(command, args, { stdio: acp ? ['pipe', 'pipe', 'inherit'] : 'inherit', detached: acp });
  let killTimer;
  let eofTimer;
  const signalChild = signal => {
    try {
      if (acp) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* Child already exited. */ }
  };
  const stop = (signal = 'SIGTERM') => {
    if (!child.pid) return;
    signalChild(signal);
    killTimer ??= setTimeout(() => signalChild('SIGKILL'), 2000).unref();
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal));
  child.on('error', () => { console.error('[9Router Kimi] Native CLI could not start'); process.exitCode = 1; });
  if (acp) {
    process.stdin.pipe(child.stdin);
    child.stdin.on('error', () => stop());
    process.stdin.on('end', () => {
      eofTimer ??= setTimeout(() => stop(), 2000).unref();
    });
    child.stdout.pipe(createMetadataStream(catalog)).pipe(process.stdout);
    process.stdout.on('error', () => stop());
  }
  child.on('close', (code, signal) => {
    clearTimeout(killTimer);
    clearTimeout(eofTimer);
    process.stdin.unpipe();
    process.stdin.pause();
    process.exitCode = code ?? (128 + (constants.signals[signal] || 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('[9Router Kimi] Adapter could not start'); process.exitCode = 1; });
}
