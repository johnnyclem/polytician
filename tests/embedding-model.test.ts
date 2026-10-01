import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// Deterministic stand-in for the embedding model: texts sharing words get similar vectors.
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
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { conceptService } from '../src/services/concept.service.js';
import { embeddingService } from '../src/services/embedding.service.js';
import { getConfig, resetConfig } from '../src/config.js';
import { closeDatabase, getAdapter, initializeDatabase, resetAdapter } from '../src/db/client.js';
import type { SqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createServer } from '../src/server.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

function storedModel(id: string): string | null {
  const row = (getAdapter() as SqliteAdapter)
    .getRawDb()
    .prepare('SELECT embedding_model FROM concepts WHERE id = ?')
    .get(id) as { embedding_model: string | null } | undefined;
  return row?.embedding_model ?? null;
}

describe('embedding model recorded per vector', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('records the model that produced each vector', async () => {
    const auto = await conceptService.save({ markdown: 'alpha beta', autoEmbed: true });
    const supplied = await conceptService.save({
      embedding: await embeddingService.embed('gamma'),
    });
    const textOnly = await conceptService.save({ markdown: 'no vector', autoEmbed: false });
    expect(storedModel(auto.id)).toBe(DEFAULT_MODEL);
    expect(storedModel(supplied.id)).toBe(DEFAULT_MODEL);
    expect(storedModel(textOnly.id)).toBeNull();
  });

  it('refuses to rank vectors from another model against the current one', async () => {
    await conceptService.save({ markdown: 'alpha beta', autoEmbed: true });
    // The operator switches POLYTICIAN_EMBEDDING_MODEL to a different 384-d model.
    getConfig().embeddingModel = 'Xenova/paraphrase-MiniLM-L3-v2';
    const query = await embeddingService.embed('alpha');
    await expect(conceptService.search(query, 5)).rejects.toMatchObject({
      code: 'EMBEDDING_MODEL_MISMATCH',
    });
    // Another namespace without stale vectors is unaffected.
    await expect(
      conceptService.search(query, 5, undefined, { namespace: 'other' })
    ).resolves.toEqual([]);
  });

  it('reembeds stale vectors from the concept text, after which search works again', async () => {
    const derived = await conceptService.save({ markdown: 'alpha beta', autoEmbed: true });
    const authored = await conceptService.save({
      markdown: 'gamma delta',
      embedding: await embeddingService.embed('gamma delta'),
    });
    const vectorOnly = await conceptService.save({
      embedding: await embeddingService.embed('epsilon'),
    });
    getConfig().embeddingModel = 'Xenova/paraphrase-MiniLM-L3-v2';

    const first = await conceptService.reembed({ namespace: 'default' });
    expect(first.reembedded).toEqual([derived.id]);
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        { id: authored.id, reason: 'authored' },
        { id: vectorOnly.id, reason: 'no-text' },
      ])
    );
    expect(first.remaining).toBe(2);
    expect(storedModel(derived.id)).toBe('Xenova/paraphrase-MiniLM-L3-v2');

    // Authored vectors are replaced only on request; vector-only concepts have nothing to embed.
    const second = await conceptService.reembed({ namespace: 'default', overwrite: true });
    expect(second.reembedded).toEqual([authored.id]);
    expect(second.remaining).toBe(1);
    await conceptService.delete(vectorOnly.id);

    const results = await conceptService.search(await embeddingService.embed('alpha'), 5);
    expect(results[0]!.id).toBe(derived.id);
  });

  it('exposes reembed_concepts as a tool and names it in the mismatch error', async () => {
    await conceptService.save({ markdown: 'alpha beta', autoEmbed: true });
    getConfig().embeddingModel = 'Xenova/paraphrase-MiniLM-L3-v2';

    const server = await createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'model-test', version: '1.0.0' });
    await client.connect(clientTransport);

    const refused = (await client.callTool({
      name: 'search_concepts',
      arguments: { query: 'alpha' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    const body = JSON.parse(refused.content[0]!.text) as { code: string; error: string };
    expect(body.code).toBe('EMBEDDING_MODEL_MISMATCH');
    expect(body.error).toMatch(/reembed_concepts/);

    const reembedded = (await client.callTool({
      name: 'reembed_concepts',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(reembedded.isError).toBeFalsy();
    expect(JSON.parse(reembedded.content[0]!.text)).toMatchObject({ remaining: 0 });

    const found = (await client.callTool({
      name: 'search_concepts',
      arguments: { query: 'alpha' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(found.isError).toBeFalsy();
    await client.close();
  });
});

describe('vectors written before 3.0', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'polytician-model-'));
  });

  afterEach(() => {
    closeDatabase();
    resetAdapter();
    rmSync(dir, { recursive: true, force: true });
  });

  it('are labelled with the configured model once, on the first 3.0 start', async () => {
    const dbPath = join(dir, 'concepts.db');
    const legacy = new Database(dbPath);
    sqliteVec.load(legacy);
    legacy.exec(`
      CREATE TABLE concepts (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default', version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tags TEXT DEFAULT '[]',
        markdown TEXT, thoughtform TEXT, embedding BLOB);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const id = '0e000000-0000-4000-a000-000000000001';
    const vector = await embeddingService.embed('legacy text');
    legacy
      .prepare(
        `INSERT INTO concepts (id, created_at, updated_at, markdown, embedding) VALUES (?, 1, 1, 'legacy text', ?)`
      )
      .run(id, Buffer.from(new Float32Array(vector).buffer));
    legacy.close();

    resetConfig();
    resetAdapter();
    initializeDatabase(dbPath);
    expect(storedModel(id)).toBe(DEFAULT_MODEL);
    const results = await conceptService.search(vector, 5);
    expect(results.map(r => r.id)).toEqual([id]);

    // A later start with another model does not relabel them.
    closeDatabase();
    resetConfig();
    resetAdapter();
    process.env['POLYTICIAN_EMBEDDING_MODEL'] = 'Xenova/paraphrase-MiniLM-L3-v2';
    try {
      initializeDatabase(dbPath);
      expect(storedModel(id)).toBe(DEFAULT_MODEL);
    } finally {
      delete process.env['POLYTICIAN_EMBEDDING_MODEL'];
    }
  });
});
