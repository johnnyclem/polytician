/**
 * Runs the real entrypoint (src/index.ts via tsx) in a child process with a
 * throwaway HOME and data directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENTRY = join(import.meta.dirname, '..', 'src', 'index.ts');
const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function exitOf(child: ChildProcess, timeoutMs: number): Promise<number | null | 'timeout'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('polytician process lifecycle', () => {
  let home: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'polytician-proc-'));
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    child = null;
    rmSync(home, { recursive: true, force: true });
  });

  function start(args: string[], env: Record<string, string> = {}): ChildProcess {
    child = spawn(TSX, [ENTRY, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        POLYTICIAN_DATA_DIR: join(home, 'data'),
        LOG_LEVEL: 'error',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return child;
  }

  async function initialized(proc: ChildProcess): Promise<void> {
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'lifecycle', version: '1.0.0' },
        },
      }) + '\n'
    );
    let out = '';
    for await (const chunk of proc.stdout!) {
      out += String(chunk);
      if (out.includes('"id":1')) return;
    }
  }

  it('exits when the MCP client closes stdin instead of lingering as an orphan', async () => {
    // The opt-in health server (like any timer or socket) would keep an orphan alive.
    const proc = start([], { POLYTICIAN_HEALTH_PORT: String(await freePort()) });
    await initialized(proc);
    proc.stdin!.end();
    expect(await exitOf(proc, 10_000)).toBe(0);
  }, 30_000);

  it('serves MCP over HTTP with --http and health on the same port', async () => {
    const port = await freePort();
    const proc = start(['--http'], {
      POLYTICIAN_HTTP_PORT: String(port),
      POLYTICIAN_HTTP_TOKEN: 'k'.repeat(43),
    });
    let ready = false;
    for (let i = 0; i < 100 && !ready && proc.exitCode === null; i++) {
      ready = await fetch(`http://127.0.0.1:${port}/health`).then(
        r => r.ok,
        () => false
      );
      if (!ready) await new Promise(r => setTimeout(r, 200));
    }
    expect(ready).toBe(true);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    expect(unauthorized.status).toBe(401);

    proc.kill('SIGTERM');
    expect(await exitOf(proc, 10_000)).toBe(0);
  }, 40_000);
});
