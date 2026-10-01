import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

vi.mock('@xenova/transformers', () => {
  const mockPipeline = async (text: string) => {
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) data[i] = Math.sin(hash + i) * 0.5 + 0.01;
    return { data };
  };
  return { pipeline: vi.fn().mockResolvedValue(mockPipeline), env: { cacheDir: '' } };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AVHttpClient } from '../src/integrations/agent-vault/client/http-client.js';
import { ArweaveUploadClient } from '../src/integrations/agent-vault/client/arweave-client.js';
import {
  ArchivalConnector,
  openArchive,
  resetSharedArchivalConnector,
  type ArchiveEnvelope,
} from '../src/integrations/agent-vault/connectors/archival.connector.js';
import {
  AgentVaultConfigSchema,
  type AgentVaultConfig,
} from '../src/integrations/agent-vault/config.js';
import { backupKeyId } from '../src/backup/key.js';
import { configureProviders } from '../src/providers/configure.js';
import { conversionService } from '../src/services/conversion.service.js';
import { conceptService } from '../src/services/concept.service.js';
import { NullProvider } from '../src/providers/null.provider.js';
import { createServer } from '../src/server.js';
import { getConfig, resetConfig } from '../src/config.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';

function avConfig(overrides: Record<string, unknown> = {}): AgentVaultConfig {
  return AgentVaultConfigSchema.parse({
    apiBaseUrl: 'https://av.test',
    apiToken: 'tok',
    inference: { timeoutMs: 50, maxRetries: 2 },
    ...overrides,
  });
}

/** fetch that never answers until its request is aborted. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      })
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentVault HTTP retries (POLY-18)', () => {
  it('does not retry a POST that timed out, so the wallet is sent once', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const client = new ArweaveUploadClient(
      avConfig({ archival: { timeoutMs: 50 } })
    ).withJwk({ kty: 'RSA', d: 'private-part' });

    await expect(
      client.upload({ content: 'x', contentType: 'json', tags: [], metadata: {} })
    ).rejects.toThrow(/timed out after 50ms; it may still have been applied/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a memory_repo commit after a 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'busy', code: 'X' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new AVHttpClient(avConfig()).post('/api/memory-repo/commits', {})).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries GETs and inference', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const client = new AVHttpClient(avConfig());
    await expect(client.get('/api/memory-repo/branches/main')).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockClear();
    await expect(
      client.post('/api/inference', { prompt: 'p' }, { retry: true })
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('LLM provider wiring (POLY-24)', () => {
  afterEach(() => {
    conversionService.setLLMProvider(new NullProvider());
  });

  it('does not route conversions to AgentVault when llm.provider is none', async () => {
    const config = { ...getConfig(), llm: { provider: 'none' as const }, agentVault: avConfig() };
    await configureProviders(config);
    expect(conversionService.getLLMProviderName()).toBe('none');
  });

  it('uses AgentVault only when chosen explicitly', async () => {
    const config = {
      ...getConfig(),
      llm: { provider: 'agentvault' as const },
      agentVault: avConfig(),
    };
    await configureProviders(config);
    expect(conversionService.getLLMProviderName()).toBe('agentvault');
  });

  it('refuses agentvault without the AgentVault integration', async () => {
    const config = { ...getConfig(), llm: { provider: 'agentvault' as const }, agentVault: undefined };
    await expect(configureProviders(config)).rejects.toThrow(/needs the AgentVault integration/);
  });
});

describe('Arweave archival (POLY-19)', () => {
  let dataDir: string;
  const keyBytes = randomBytes(32);
  const key = { key: keyBytes, keyId: backupKeyId(keyBytes) };
  const SECRET = 'my password is hunter2';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'polytician-archive-'));
    process.env['POLYTICIAN_DATA_DIR'] = dataDir;
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    delete process.env['POLYTICIAN_DATA_DIR'];
    delete process.env['POLYTICIAN_BACKUP_KEY'];
    resetConfig();
    resetSharedArchivalConnector();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function archivalConfig(): AgentVaultConfig {
    const jwk = join(dataDir, 'wallet.json');
    writeFileSync(jwk, JSON.stringify({ kty: 'RSA' }));
    return avConfig({
      archival: { enabled: true, tagFilter: ['publish'], debounceMs: 0, arweaveJwk: jwk },
    });
  }

  it('cannot be enabled without a tag filter', () => {
    expect(() =>
      AgentVaultConfigSchema.parse({ apiBaseUrl: 'https://av.test', archival: { enabled: true } })
    ).toThrow(/tagFilter/);
  });

  it('cannot run without a backup key, so nothing is uploaded in plaintext', () => {
    expect(() => new ArchivalConnector(archivalConfig())).toThrow(/needs a backup encryption key/);
  });

  it('uploads only tagged concepts, encrypted, once per version', async () => {
    process.env['POLYTICIAN_BACKUP_KEY'] = keyBytes.toString('base64');
    const fetchMock = vi.fn().mockImplementation(async () =>
      json({ txId: 'tx1', url: 'https://arweave.net/tx1', timestamp: 1, tags: [], size: 10 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ArchivalConnector(archivalConfig());

    const untagged = await conceptService.save({ markdown: SECRET, tags: ['private'] });
    expect(await connector.archive(untagged.id)).toEqual({ archived: false, reason: 'not-tagged' });
    expect(fetchMock).not.toHaveBeenCalled();

    const tagged = await conceptService.save({ markdown: SECRET, tags: ['publish', 'private'] });
    const outcome = await connector.archive(tagged.id);
    expect(outcome.archived).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      data: string;
      tags: Record<string, string>;
      metadata: Record<string, unknown>;
    };
    expect(body.data).not.toContain('hunter2');
    expect(JSON.stringify(body.tags)).not.toContain('private');
    expect(body.metadata).not.toHaveProperty('namespace');
    const envelope = JSON.parse(body.data) as ArchiveEnvelope;
    expect(envelope).toMatchObject({ format: 'polytician-archive', alg: 'AES-256-GCM' });
    expect(openArchive(envelope, key)).toMatchObject({ id: tagged.id, markdown: SECRET });

    expect(await connector.archive(tagged.id)).toEqual({
      archived: false,
      reason: 'already-archived',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('vault_memory_pull (POLY-21)', () => {
  let client: Client;
  let dataDir: string;
  const ID_LOCAL = '11111111-1111-4111-a111-111111111111';
  const ID_NEW = '22222222-2222-4222-a222-222222222222';
  const ID_WORK = '33333333-3333-4333-a333-333333333333';

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'polytician-pull-'));
    process.env['POLYTICIAN_DATA_DIR'] = dataDir;
    process.env['POLYTICIAN_AV_API_URL'] = 'https://av.test';
    setupTestDb();
    const server = await createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(() => {
    teardownTestDb();
    delete process.env['POLYTICIAN_DATA_DIR'];
    delete process.env['POLYTICIAN_AV_API_URL'];
    resetConfig();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function branch(entries: Array<{ id: string; data: string; metadata: Record<string, unknown> }>) {
    return json({
      branch: 'polytician-main',
      headSha: 'abc',
      entries: entries.map(e => ({
        key: `concepts/${e.id}/markdown`,
        contentType: 'markdown',
        data: e.data,
        tags: ['remote'],
        metadata: e.metadata,
      })),
    });
  }

  async function pull(namespace?: string): Promise<Record<string, unknown>> {
    const result = (await client.callTool({
      name: 'vault_memory_pull',
      arguments: namespace ? { namespace } : {},
    })) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }

  it('keeps newer local edits and honours namespaces and ids', async () => {
    await conceptService.save({ id: ID_LOCAL, markdown: 'LOCAL newest edit' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        branch([
          { id: ID_LOCAL, data: 'REMOTE stale v0', metadata: { updatedAt: 1, namespace: 'default' } },
          { id: ID_NEW, data: 'remote new note', metadata: { updatedAt: Date.now() } },
          { id: ID_WORK, data: 'work note', metadata: { updatedAt: Date.now(), namespace: 'work' } },
          { id: '../../etc', data: 'bad id', metadata: { updatedAt: Date.now() } },
        ])
      )
    );

    const report = await pull();
    expect(report['imported']).toBe(1);
    expect(report['skipped']).toEqual([
      { key: `concepts/${ID_LOCAL}/markdown`, reason: 'local-newer' },
      { key: `concepts/${ID_WORK}/markdown`, reason: 'other-namespace' },
      { key: 'concepts/../../etc/markdown', reason: 'invalid-id' },
    ]);
    expect((await conceptService.read(ID_LOCAL)).markdown).toBe('LOCAL newest edit');
    const pulled = await conceptService.read(ID_NEW, undefined, { namespace: 'default' });
    expect(pulled.markdown).toBe('remote new note');
    expect(pulled.embedding).toBeDefined();
  });

  it('applies a remote edit that is newer than the local copy', async () => {
    const local = await conceptService.save({ id: ID_LOCAL, markdown: 'old local' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        branch([{ id: ID_LOCAL, data: 'newer remote', metadata: { updatedAt: local.updatedAt + 1000 } }])
      )
    );
    const report = await pull();
    expect(report['imported']).toBe(1);
    expect((await conceptService.read(ID_LOCAL)).markdown).toBe('newer remote');
  });

  it('pulls a namespace-tagged entry into that namespace only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        branch([{ id: ID_WORK, data: 'work note', metadata: { updatedAt: 5, namespace: 'work' } }])
      )
    );
    expect((await pull('work'))['imported']).toBe(1);
    const read = await conceptService.read(ID_WORK);
    expect(read.namespace).toBe('work');
  });
});
