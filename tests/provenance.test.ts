import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// Deterministic stand-in for the MiniLM pipeline: texts sharing words get similar vectors.
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
import { createServer } from '../src/server.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { getAdapter } from '../src/db/client.js';
import { resetConfig } from '../src/config.js';
import { conceptService } from '../src/services/concept.service.js';
import { ConversionService } from '../src/services/conversion.service.js';
import { exportBackup, importBackup } from '../src/services/backup.service.js';
import { OverwriteRefusedError } from '../src/errors/index.js';
import type { LLMProvider } from '../src/providers/llm.interface.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const LEDGER_REF = 'stenographer:wiki/truth.jsonl#tb-0042';

const THOUGHTFORM = {
  id: '3f1c7e0a-5b6d-4c2e-9a8b-7d6e5f4a3b2c',
  rawText: 'Something else entirely.',
  language: 'en',
  metadata: {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    author: null,
    tags: [],
    source: 'user_input' as const,
  },
  entities: [],
  relationships: [],
  contextGraph: {},
};

function vec(dominant: number): number[] {
  const v = new Array<number>(VECTOR_DIMENSION).fill(0);
  v[dominant] = 1;
  return v;
}

const mockLLM: LLMProvider = {
  name: 'mock-llm',
  async complete() {
    return '';
  },
  async extractEntities() {
    return { entities: [], relationships: [], contextGraph: {} };
  },
  async summarize() {
    return '# Summary written by the mock LLM';
  },
};

describe('provenance per representation', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('records caller-written content as user and the auto-embedded vector as derived, with its model', async () => {
    const saved = await conceptService.save({ markdown: 'alpha beta gamma', autoEmbed: true });
    expect(saved.provenance).toEqual({
      markdown: { origin: 'user' },
      vector: { origin: 'derived', derivedFrom: 'markdown', model: MODEL },
    });
    expect((await conceptService.read(saved.id)).provenance).toEqual(saved.provenance);
  });

  it("records the caller's declared origin and createdBy on what it supplies and on what is derived from it", async () => {
    const saved = await conceptService.save({
      markdown: 'The parser owns tokenization.',
      source: { origin: 'import', createdBy: 'stenographer' },
      autoEmbed: true,
    });
    expect(saved.provenance).toEqual({
      markdown: { origin: 'import', createdBy: 'stenographer' },
      vector: { origin: 'derived', derivedFrom: 'markdown', model: MODEL, createdBy: 'stenographer' },
    });
  });

  it('keeps provenance of representations a write does not touch', async () => {
    const saved = await conceptService.save({ markdown: 'one two', autoEmbed: true });
    const tagged = await conceptService.save({
      id: saved.id,
      namespace: 'default',
      tags: ['x'],
      source: { createdBy: 'someone-else' },
    });
    expect(tagged.provenance).toEqual(saved.provenance);
  });

  it('records derived and LLM conversions with what they came from and which model made them', async () => {
    const conversions = new ConversionService();
    conversions.setLLMProvider(mockLLM);
    const neighbor = await conceptService.save({ markdown: 'neighbour text', embedding: vec(1) });
    const target = await conceptService.save({ embedding: vec(1) });

    await conversions.convert(target.id, 'vector', 'markdown');
    const converted = await conceptService.read(target.id);
    expect(converted.provenance).toEqual({
      vector: { origin: 'user' },
      markdown: { origin: 'llm', derivedFrom: 'vector', model: 'mock-llm', sources: [neighbor.id] },
    });
  });

  it('treats imported content as authored: a conversion does not replace it without overwrite', async () => {
    const conversions = new ConversionService();
    const saved = await conceptService.save({
      markdown: 'From the ledger.',
      thoughtform: THOUGHTFORM,
      source: { origin: 'import' },
    });
    await expect(conversions.convert(saved.id, 'thoughtform', 'markdown')).rejects.toThrow(
      OverwriteRefusedError
    );
  });

  it('treats a representation with no recorded provenance (written before 3.0) as authored', async () => {
    const conversions = new ConversionService();
    const saved = await conceptService.save({
      markdown: 'legacy text',
      thoughtform: THOUGHTFORM,
      autoEmbed: true,
    });
    await getAdapter().updateConcept(saved.id, { provenance: '{}' });
    expect((await conceptService.read(saved.id)).provenance).toEqual({});

    await expect(conversions.convert(saved.id, 'thoughtform', 'markdown')).rejects.toThrow(
      OverwriteRefusedError
    );
    await expect(conversions.convert(saved.id, 'markdown', 'vector')).rejects.toThrow(
      OverwriteRefusedError
    );
  });
});

describe('assertion status and ledger reference', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('stores, updates and clears the status and the ledger reference', async () => {
    const saved = await conceptService.save({
      markdown: 'The service listens on 8787.',
      assertionStatus: 'asserted',
      ledgerRef: LEDGER_REF,
    });
    expect(saved).toMatchObject({ assertionStatus: 'asserted', ledgerRef: LEDGER_REF });

    const verified = await conceptService.save({
      id: saved.id,
      namespace: 'default',
      assertionStatus: 'verified',
    });
    expect(verified).toMatchObject({ version: 2, assertionStatus: 'verified', ledgerRef: LEDGER_REF });
    expect(verified.provenance).toEqual(saved.provenance);

    const cleared = await conceptService.save({
      id: saved.id,
      namespace: 'default',
      assertionStatus: null,
      ledgerRef: null,
    });
    expect(cleared).toMatchObject({ assertionStatus: null, ledgerRef: null });
  });

  it('defaults to no status for ordinary memories', async () => {
    const saved = await conceptService.save({ markdown: 'plain note' });
    expect(saved).toMatchObject({ assertionStatus: null, ledgerRef: null });
  });

  it('filters search by status inside the vector query and reports each result status', async () => {
    // Many unverified concepts are closer to the query than the one verified concept.
    for (let i = 0; i < 20; i++) {
      await conceptService.save({ embedding: vec(0), assertionStatus: i % 2 ? 'contested' : null });
    }
    const verified = await conceptService.save({ embedding: vec(2), assertionStatus: 'verified' });

    const hits = await conceptService.search(vec(0), 1, undefined, {
      assertionStatus: ['verified'],
    });
    expect(hits.map(h => h.id)).toEqual([verified.id]);
    expect(hits[0]!.assertionStatus).toBe('verified');

    const unfiltered = await conceptService.search(vec(0), 3);
    expect(unfiltered).toHaveLength(3);
    expect(unfiltered.every(h => h.assertionStatus !== 'verified')).toBe(true);
  });

  it('filters list_concepts by status', async () => {
    await conceptService.save({ markdown: 'a', assertionStatus: 'retracted' });
    const keep = await conceptService.save({ markdown: 'b', assertionStatus: 'verified' });
    await conceptService.save({ markdown: 'c' });
    const listed = await conceptService.list({ assertionStatus: ['verified', 'asserted'] });
    expect(listed.total).toBe(1);
    expect(listed.concepts.map(c => [c.id, c.assertionStatus])).toEqual([[keep.id, 'verified']]);
  });
});

describe('backups carry provenance and assertion status', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'polytician-provenance-'));
    process.env['POLYTICIAN_DATA_DIR'] = dataDir;
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    delete process.env['POLYTICIAN_DATA_DIR'];
    resetConfig();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('restores them as they were saved', async () => {
    const saved = await conceptService.save({
      markdown: 'Port 8787 belongs to stenographer.',
      source: { origin: 'import', createdBy: 'stenographer' },
      assertionStatus: 'verified',
      ledgerRef: LEDGER_REF,
      autoEmbed: true,
    });
    const backup = await exportBackup();
    await conceptService.delete(saved.id);

    await importBackup(backup.file);
    const restored = await conceptService.read(saved.id);
    expect(restored).toMatchObject({
      assertionStatus: 'verified',
      ledgerRef: LEDGER_REF,
      provenance: saved.provenance,
    });
  });
});

describe('MCP: provenance and assertion status', () => {
  let client: Client;

  beforeEach(async () => {
    setupTestDb();
    const server = await createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'provenance-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(teardownTestDb);

  it('stores a stenographer truth entry with its status, and search can keep to verified ones', async () => {
    const saved = (await client.callTool({
      name: 'save_concept',
      arguments: {
        markdown: 'Polytician serves HTTP on 8788.',
        source: { origin: 'import', createdBy: 'stenographer' },
        assertionStatus: 'verified',
        ledgerRef: LEDGER_REF,
      },
    })) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent).toMatchObject({
      assertionStatus: 'verified',
      ledgerRef: LEDGER_REF,
      provenance: { markdown: { origin: 'import', createdBy: 'stenographer' } },
    });

    await client.callTool({
      name: 'save_concept',
      arguments: { markdown: 'Polytician serves HTTP on 8787.', assertionStatus: 'contested' },
    });

    const found = (await client.callTool({
      name: 'search_concepts',
      arguments: { query: 'Polytician HTTP port', assertionStatus: ['verified'] },
    })) as { structuredContent?: { results: Array<{ id: string; assertionStatus: string }> } };
    expect(found.structuredContent?.results.map(r => [r.id, r.assertionStatus])).toEqual([
      [saved.structuredContent?.['id'], 'verified'],
    ]);
  });

  it('refuses an unknown status or a derived origin from a caller with VALIDATION_ERROR', async () => {
    for (const args of [
      { markdown: 'x', assertionStatus: 'true' },
      { markdown: 'x', source: { origin: 'derived' } },
      { markdown: 'x', source: { origin: 'llm' } },
    ]) {
      const result = (await client.callTool({ name: 'save_concept', arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });
});
