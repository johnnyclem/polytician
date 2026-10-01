import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

vi.mock('@huggingface/transformers', () => {
  const mockPipeline = async (text: string) => {
    const data = new Float32Array(VECTOR_DIMENSION);
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      const h = Array.from(word).reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
      data[h % VECTOR_DIMENSION]! += 1;
    }
    data[VECTOR_DIMENSION - 1]! += 0.01;
    let magnitude = 0;
    for (let i = 0; i < VECTOR_DIMENSION; i++) magnitude += data[i]! * data[i]!;
    magnitude = Math.sqrt(magnitude);
    for (let i = 0; i < VECTOR_DIMENSION; i++) data[i] = data[i]! / magnitude;
    return { data };
  };
  return { pipeline: vi.fn().mockResolvedValue(mockPipeline), env: { cacheDir: '' } };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import {
  loadOrCreateHttpToken,
  startHttpServer,
  type RunningHttpServer,
} from '../src/transport/http.js';
import { getConfig, resetConfig } from '../src/config.js';

const TOKEN = 't'.repeat(43);

/** Raw request, so tests can send Host and Origin headers that fetch() would not let them set. */
function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1.0.0' },
  },
});

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

describe('Streamable HTTP transport', () => {
  let running: RunningHttpServer;

  beforeEach(async () => {
    setupTestDb();
    running = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      allowedHosts: ['127.0.0.1', 'localhost'],
      allowedOrigins: ['https://app.example'],
    });
  });

  afterEach(async () => {
    await running.close();
    teardownTestDb();
  });

  it('serves MCP tools to a client holding the bearer token', async () => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      })
    );
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(
      expect.arrayContaining(['save_concept', 'search_concepts', 'read_concept'])
    );

    const saved = (await client.callTool({
      name: 'save_concept',
      arguments: { markdown: 'shared memory over http' },
    })) as { content: Array<{ text: string }> };
    const { id } = JSON.parse(saved.content[0]!.text) as { id: string };
    const found = (await client.callTool({
      name: 'search_concepts',
      arguments: { query: 'shared memory' },
    })) as { structuredContent: { results: Array<{ id: string }> } };
    expect(found.structuredContent.results[0]!.id).toBe(id);
    await client.close();
  });

  it('refuses requests without the bearer token, or with a wrong one', async () => {
    const missing = await raw(`${running.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: INITIALIZE,
    });
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toMatch(/^Bearer/);

    const wrong = await raw(`${running.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${'x'.repeat(43)}` },
      body: INITIALIZE,
    });
    expect(wrong.status).toBe(401);
  });

  it('refuses a Host header outside the allowlist (DNS rebinding)', async () => {
    const res = await raw(`${running.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}`, Host: 'attacker.example' },
      body: INITIALIZE,
    });
    expect(res.status).toBe(403);
  });

  it('refuses browser requests from origins that are not allowed', async () => {
    const evil = await raw(`${running.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' },
      body: INITIALIZE,
    });
    expect(evil.status).toBe(403);

    const allowed = await raw(`${running.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}`, Origin: 'https://app.example' },
      body: INITIALIZE,
    });
    expect(allowed.status).toBe(200);
  });

  it('serves /health and /health/live on the same port without a token', async () => {
    const ready = await raw(`${running.url}/health`, {});
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({ status: 'ok' });
    expect((await raw(`${running.url}/health/live`, {})).status).toBe(200);
    expect((await raw(`${running.url}/nope`, {})).status).toBe(404);
  });

  it('answers GET and DELETE on /mcp with 405 (stateless server)', async () => {
    const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' };
    expect((await raw(`${running.url}/mcp`, { headers })).status).toBe(405);
    expect((await raw(`${running.url}/mcp`, { method: 'DELETE', headers })).status).toBe(405);
  });
});

describe('HTTP bearer token', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'polytician-token-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['POLYTICIAN_HTTP_TOKEN'];
    resetConfig();
  });

  it('is generated once into an owner-only file and reused', () => {
    const tokenFile = join(dir, 'http-token');
    const first = loadOrCreateHttpToken({ token: null, tokenFile });
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(readFileSync(tokenFile, 'utf-8').trim()).toBe(first);
    if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(loadOrCreateHttpToken({ token: null, tokenFile })).toBe(first);
  });

  it('prefers POLYTICIAN_HTTP_TOKEN and refuses a short one', () => {
    process.env['POLYTICIAN_HTTP_TOKEN'] = 'short';
    resetConfig();
    expect(() => getConfig()).toThrow(/at least 32/);
    process.env['POLYTICIAN_HTTP_TOKEN'] = TOKEN;
    resetConfig();
    expect(loadOrCreateHttpToken(getConfig().http)).toBe(TOKEN);
  });

  it('refuses a token file that other users can read', () => {
    if (process.platform === 'win32') return;
    const tokenFile = join(dir, 'http-token');
    writeFileSync(tokenFile, TOKEN, { mode: 0o644 });
    expect(() => loadOrCreateHttpToken({ token: null, tokenFile })).toThrow(/0600|owner/);
  });
});
