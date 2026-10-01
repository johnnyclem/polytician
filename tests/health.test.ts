import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { startHealthServer } from '../src/health.js';
import { resetConfig } from '../src/config.js';
import { getAdapter } from '../src/db/client.js';
import type { SqliteAdapter } from '../src/db/sqlite-adapter.js';

async function freePort(): Promise<number> {
  const probe = createNetServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

async function listening(server: Server): Promise<AddressInfo> {
  if (!server.listening) await once(server, 'listening');
  return server.address() as AddressInfo;
}

describe('stdio-mode health server', () => {
  const opened: Array<Server | NetServer> = [];

  beforeEach(() => {
    setupTestDb();
  });

  afterEach(async () => {
    for (const s of opened.splice(0)) {
      await new Promise<void>(resolve => s.close(() => resolve()));
    }
    delete process.env['POLYTICIAN_HEALTH_PORT'];
    delete process.env['POLYTICIAN_HEALTH_HOST'];
    resetConfig();
    teardownTestDb();
  });

  it('is off by default, so several stdio servers can run side by side', () => {
    resetConfig();
    expect(startHealthServer()).toBeNull();
  });

  it('binds 127.0.0.1 when enabled with POLYTICIAN_HEALTH_PORT', async () => {
    process.env['POLYTICIAN_HEALTH_PORT'] = String(await freePort());
    resetConfig();
    const server = startHealthServer()!;
    opened.push(server);
    const address = await listening(server);
    expect(address.address).toBe('127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'ok' }, vector_index: { status: 'ok' } },
    });
  });

  it('logs and carries on when the port is taken instead of crashing the MCP server', async () => {
    const blocker = createNetServer().listen(0, '127.0.0.1');
    opened.push(blocker);
    await once(blocker, 'listening');
    process.env['POLYTICIAN_HEALTH_PORT'] = String((blocker.address() as AddressInfo).port);
    resetConfig();

    const server = startHealthServer()!;
    // Without a listener of its own, the 'error' event would be thrown and kill the process.
    expect(server.listenerCount('error')).toBeGreaterThan(0);
    const [err] = (await once(server, 'error')) as [NodeJS.ErrnoException];
    expect(err.code).toBe('EADDRINUSE');
    expect(server.listening).toBe(false);
  });

  it('reports a failed check without echoing the error to the caller', async () => {
    process.env['POLYTICIAN_HEALTH_PORT'] = String(await freePort());
    resetConfig();
    const server = startHealthServer()!;
    opened.push(server);
    const { port } = await listening(server);

    (getAdapter() as SqliteAdapter).getRawDb().exec('DROP TABLE concepts');
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ status: 'degraded', checks: { database: { status: 'error' } } });
    expect(text).not.toMatch(/no such table/i);
  });

  it('serves a liveness probe that does not depend on the database', async () => {
    process.env['POLYTICIAN_HEALTH_PORT'] = String(await freePort());
    resetConfig();
    const server = startHealthServer()!;
    opened.push(server);
    const { port } = await listening(server);

    (getAdapter() as SqliteAdapter).getRawDb().exec('DROP TABLE concepts');
    const res = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(res.status).toBe(200);
  });
});
