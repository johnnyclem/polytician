import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
    return { data };
  };
  return { pipeline: vi.fn().mockResolvedValue(mockPipeline), env: { cacheDir: '' } };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { resetConfig } from '../src/config.js';
import { getAdapter } from '../src/db/client.js';
import { registerVaultTools } from '../src/integrations/agent-vault/tools/vault-tools.js';
import { AgentVaultConfigSchema } from '../src/integrations/agent-vault/config.js';

interface CallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let client: Client;
let tools: Tool[];
let dataDir: string;

async function connect(server: McpServer): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'typed-output-test', version: '1.0.0' });
  await client.connect(clientTransport);
  // Listing caches each tool's outputSchema in the client, which then
  // validates every structuredContent it receives against it.
  tools = (await client.listTools()).tools;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

/** A successful result: structuredContent present, and the text block is the same JSON. */
async function ok(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  return result.structuredContent!;
}

function errorCode(result: CallResult): string | undefined {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return (JSON.parse(result.content[0]!.text) as { code?: string }).code;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'polytician-typed-'));
  process.env['POLYTICIAN_DATA_DIR'] = dataDir;
  setupTestDb();
  await connect(await createServer());
});

afterEach(() => {
  teardownTestDb();
  delete process.env['POLYTICIAN_DATA_DIR'];
  delete process.env['POLYTICIAN_NAMESPACES'];
  resetConfig();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('tool listing', () => {
  it('gives every tool an object outputSchema and all four annotation hints', () => {
    expect(tools.length).toBeGreaterThanOrEqual(14);
    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe('object');
      const a = tool.annotations ?? {};
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof (a as Record<string, unknown>)[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
    }
  });

  it('marks reads read-only and deletes/replacements destructive', () => {
    const hints = Object.fromEntries(tools.map(t => [t.name, t.annotations]));
    for (const name of [
      'read_concept',
      'list_concepts',
      'search_concepts',
      'embed_text',
      'health_check',
      'get_stats',
      'list_backups',
    ]) {
      expect(hints[name]?.readOnlyHint, name).toBe(true);
    }
    for (const name of [
      'save_concept',
      'batch_save_concepts',
      'delete_concept',
      'convert_concept',
      'reembed_concepts',
      'import_backup',
    ]) {
      expect(hints[name]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(hints['delete_concept']?.idempotentHint).toBe(true);
    expect(hints['save_concept']?.idempotentHint).toBe(false);
    expect(hints['export_backup']).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe('structured results', () => {
  it('returns structuredContent matching the declared outputSchema for every core tool', async () => {
    const saved = await ok('save_concept', { markdown: 'alpha beta gamma', tags: ['t'] });
    const id = saved['id'] as string;
    expect(saved).toMatchObject({ namespace: 'default', version: 1, assertionStatus: null });

    await ok('read_concept', { id });
    await ok('read_concept', { id, representations: ['markdown'] });
    await ok('list_concepts', { tags: ['t'] });
    const batch = await ok('batch_save_concepts', { concepts: [{ markdown: 'delta' }] });
    expect(batch).toMatchObject({ count: 1 });

    const search = await ok('search_concepts', { query: 'alpha', k: 2 });
    expect(Array.isArray(search['results'])).toBe(true);
    expect((search['results'] as Array<{ id: string }>)[0]?.id).toBe(id);

    await ok('convert_concept', { id, from: 'markdown', to: 'vector' });
    await ok('embed_text', { text: 'hello' });
    await ok('reembed_concepts', {});
    await ok('health_check', {});
    await ok('get_stats', {});
    const exported = await ok('export_backup', {});
    await ok('list_backups', {});
    await ok('import_backup', { file: exported['file'] as string });
    expect(await ok('delete_concept', { id })).toEqual({ deleted: id });
  });

  it('still reads rows from 2.x with free-form thoughtforms and unreadable provenance', async () => {
    const saved = await ok('save_concept', { markdown: 'legacy' });
    const id = saved['id'] as string;
    // 2.x stored any JSON as a thoughtform; provenance written by hand or a bug.
    await getAdapter().updateConcept(id, {
      thoughtform: JSON.stringify('a bare string'),
      provenance: JSON.stringify({ markdown: { from: 'thoughtform' }, vector: { origin: 'user' } }),
    });
    const read = await ok('read_concept', { id });
    expect(read['thoughtform']).toBe('a bare string');
    expect(read['provenance']).toEqual({ vector: { origin: 'user' } });
  });
});

describe('error codes', () => {
  it('carries NOT_FOUND, VERSION_CONFLICT and NAMESPACE_DENIED from the service', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(errorCode(await call('read_concept', { id: missing }))).toBe('NOT_FOUND');

    const saved = await ok('save_concept', { markdown: 'x' });
    expect(
      errorCode(
        await call('save_concept', {
          id: saved['id'],
          markdown: 'y',
          expectedVersion: 7,
        })
      )
    ).toBe('VERSION_CONFLICT');

    process.env['POLYTICIAN_NAMESPACES'] = 'work';
    resetConfig();
    expect(errorCode(await call('list_concepts', { namespace: 'other' }))).toBe('NAMESPACE_DENIED');
  });

  it('carries VALIDATION_ERROR when arguments fail the input schema', async () => {
    const result = await call('save_concept', { markdown: 'x', content: 'unknown key' });
    expect(errorCode(result)).toBe('VALIDATION_ERROR');
    expect(result.content[0]!.text).toContain('content');
    expect(errorCode(await call('search_concepts', { query: 'x', k: 0 }))).toBe('VALIDATION_ERROR');
  });

  it('carries NOT_FOUND for a tool the server does not have', async () => {
    expect(errorCode(await call('agentvault_backup', {}))).toBe('NOT_FOUND');
  });

  it('refuses a namespace together with crossNamespace instead of ignoring one of them', async () => {
    process.env['POLYTICIAN_NAMESPACES'] = '*';
    resetConfig();
    expect(
      errorCode(await call('search_concepts', { query: 'x', namespace: 'a', crossNamespace: true }))
    ).toBe('VALIDATION_ERROR');
  });
});

describe('AgentVault tools', () => {
  it('declare output schemas and open-world annotations', async () => {
    const server = new McpServer({ name: 'vault-only', version: '0.0.0' });
    registerVaultTools(
      server,
      AgentVaultConfigSchema.parse({ apiBaseUrl: 'https://av.example', apiToken: 'token' })
    );
    await connect(server);
    expect(tools.map(t => t.name).sort()).toEqual([
      'vault_get_secret',
      'vault_infer',
      'vault_memory_pull',
      'vault_memory_push',
      'vault_memory_repo_log',
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe('object');
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
    }
    expect(tools.find(t => t.name === 'vault_get_secret')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === 'vault_memory_pull')?.annotations?.destructiveHint).toBe(true);
  });
});
