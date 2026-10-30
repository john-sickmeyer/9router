import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const temporary = [];
const children = [];
const adapter = fileURLToPath(new URL('../../scripts/studio-kimi-acp.mjs', import.meta.url));
function launch(source, args = ['acp']) {
  const dir = mkdtempSync(join(tmpdir(), '9router-kimi-acp-'));
  temporary.push(dir);
  const executable = join(dir, 'kimi');
  writeFileSync(executable, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const current = join(dir, 'current-adapter.mjs');
  symlinkSync(adapter, current);
  const child = spawn(process.execPath, [current, ...args], {
    env: { ...process.env, STUDIO_KIMI_NATIVE_PATH: executable, STUDIO_KIMI_CATALOG_URL: 'http://127.0.0.1:1/v1/models' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGTERM');
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Kimi launcher lifecycle', () => {
  it('delegates non-ACP arguments, stdout, stderr, and exit code', async () => {
    const child = launch("console.log(JSON.stringify(process.argv.slice(2))); console.error('vendor stderr'); process.exit(7);", ['--version']);
    let stdout = '', stderr = '';
    child.stdout.on('data', x => stdout += x);
    child.stderr.on('data', x => stderr += x);
    expect((await once(child, 'close'))[0]).toBe(7);
    expect(JSON.parse(stdout)).toEqual(['--version']);
    expect(stderr).toBe('vendor stderr\n');
  });
  it('passes requests and responses unchanged when discovery is offline', async () => {
    const child = launch("process.stdin.pipe(process.stdout);");
    let output = '';
    child.stdout.on('data', x => output += x);
    const input = '{"jsonrpc":"2.0","id":42,"method":"session/prompt","params":{"text":"hello"}}\n';
    child.stdin.end(input);
    expect((await once(child, 'close'))[0]).toBe(0);
    expect(output).toBe(input);
  });
  it('terminates a native process after client disconnect, even when it ignores SIGTERM', async () => {
    const child = launch("process.on('SIGTERM', () => {}); process.stdin.resume(); console.log(process.pid); setInterval(() => {}, 100);");
    const [data] = await once(child.stdout, 'data');
    const nativePid = Number(data.toString().trim());
    child.stdin.end();
    expect((await once(child, 'close'))[0]).toBe(137);
    expect(() => process.kill(nativePid, 0)).toThrow();
  }, 8000);
  it('forwards termination and leaves no native process behind', async () => {
    const child = launch("process.stdin.resume(); console.log(process.pid); setInterval(() => {}, 100);");
    const [data] = await once(child.stdout, 'data');
    const nativePid = Number(data.toString().trim());
    child.kill('SIGTERM');
    expect((await once(child, 'close'))[0]).toBe(143);
    expect(() => process.kill(nativePid, 0)).toThrow();
  });
});
