import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// Deterministic stand-in for the MiniLM pipeline: texts sharing words get similar vectors.
vi.mock('@huggingface/transformers', () => {
  const mockPipeline = async (text: string, _options?: Record<string, unknown>) => {
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
  return {
    pipeline: vi.fn().mockResolvedValue(mockPipeline),
    env: { cacheDir: '' },
  };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { conceptService } from '../src/services/concept.service.js';

let client: Client;

interface RawResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown>): Promise<RawResult> {
  return (await client.callTool({ name, arguments: args })) as RawResult;
}

async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]!.text}`);
  return JSON.parse(result.content[0]!.text) as T;
}

/** Tool error body; SDK-level input validation errors are plain text, so fall back to it. */
function errorBody(result: RawResult): { code?: string; error?: string; text: string } {
  expect(result.isError).toBe(true);
  const text = result.content[0]!.text;
  try {
    return { ...(JSON.parse(text) as { code?: string; error?: string }), text };
  } catch {
    return { text };
  }
}

async function connect(): Promise<void> {
  setupTestDb();
  const server = await createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'contract-test', version: '1.0.0' });
  await client.connect(clientTransport);
}

const V1_THOUGHTFORM = {
  schemaVersion: '1.0',
  id: 'tf-v1-1',
  rawText: 'Ada Lovelace wrote the first program.',
  entities: [{ id: 'e1', type: 'PERSON', value: 'Ada Lovelace' }],
  relationships: [{ id: 'r1', type: 'wrote', from: 'e1', to: 'e2' }],
  contextGraph: {},
  metadata: {
    createdAtMs: 1700000000000,
    updatedAtMs: 1700000000000,
    source: 'test',
    contentHash: 'abcdef0123456789abcdef',
    redaction: { rawTextOmitted: false },
  },
};

describe('MCP tool contract', () => {
  afterEach(() => {
    delete process.env['POLYTICIAN_NAMESPACES'];
    teardownTestDb();
  });

  // --- POLY-10: the only external consumer, AgentVault's polytician-enricher ---

  describe('AgentVault polytician-enricher calls (AgentVault src/orchestration/polytician-enricher.ts)', () => {
    beforeEach(connect);

    it('gets a validation error naming its unknown arguments when it saves, and nothing is stored', async () => {
      // saveConceptFromOrchestration(): the arguments it sends, verbatim.
      const result = await call('save_concept', {
        name: 'orchestration-session-1',
        content: '# Orchestration Result: session-1\n\n## Task\nrefactor',
        representation: 'orchestration_result',
        metadata: { sessionId: 'session-1', timestamp: '2026-10-01T00:00:00.000Z', filesChangedCount: 2 },
      });
      const body = errorBody(result);
      for (const key of ['name', 'content', 'representation', 'metadata']) {
        expect(body.text).toContain(`'${key}'`);
      }
      expect((await conceptService.getStats()).conceptCount).toBe(0);
    });

    it('gets a validation error for limit/min_score instead of silently searching with defaults', async () => {
      // enrichWithPolyticianContext(): { query, limit: topK, min_score: minRelevanceScore }.
      const body = errorBody(
        await call('search_concepts', { query: 'refactor the parser', limit: 5, min_score: 0.3 })
      );
      expect(body.text).toContain(`'limit'`);
      expect(body.text).toContain(`'min_score'`);
    });

    it('succeeds with the documented contract: markdown + tags to save, k to search, JSON in content[0].text', async () => {
      const saved = await ok<{ id: string }>('save_concept', {
        markdown: '# Orchestration Result: session-1\n\n## Task\nrefactor the parser',
        tags: ['orchestration', 'session:session-1'],
      });
      const hits = await ok<Array<{ id: string; score: number }>>('search_concepts', {
        query: 'refactor the parser',
        k: 5,
      });
      expect(hits[0]!.id).toBe(saved.id);
      expect(hits[0]!.score).toBeGreaterThan(0.3);
      // read_concept { id } is already valid; the concept text is `markdown`.
      const read = await ok<{ id: string; markdown: string }>('read_concept', { id: saved.id });
      expect(read.markdown).toContain('refactor the parser');
    });
  });

  describe('strict input schemas', () => {
    beforeEach(connect);

    it('rejects unknown arguments instead of silently dropping them', async () => {
      // The AgentVault enricher sends { content, metadata }; 2.x stripped both and saved an empty concept.
      const result = await call('save_concept', { content: 'hello', metadata: { a: 1 } });
      expect(errorBody(result).text).toMatch(/unrecognized key|content/i);
      expect((await conceptService.getStats()).conceptCount).toBe(0);
    });

    it('rejects unknown arguments on every tool', async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
      }
      const result = await call('search_concepts', { query: 'x', namespcae: 'typo' });
      expect(result.isError).toBe(true);
    });

    it('requires at least one representation when creating a concept', async () => {
      const body = errorBody(await call('save_concept', { tags: ['only-tags'] }));
      expect(body.code).toBe('VALIDATION_ERROR');
      expect((await conceptService.getStats()).conceptCount).toBe(0);
    });

    it('rejects embeddings of the wrong dimension or with non-numeric components', async () => {
      expect((await call('save_concept', { embedding: [1, 2, 3] })).isError).toBe(true);
      const withNull = new Array<unknown>(VECTOR_DIMENSION).fill(0.1);
      withNull[3] = null;
      expect((await call('save_concept', { embedding: withNull })).isError).toBe(true);
      expect((await conceptService.getStats()).conceptCount).toBe(0);
    });

    it('caps tag counts and lengths', async () => {
      const tooMany = Array.from({ length: 65 }, (_, i) => `t${i}`);
      expect((await call('save_concept', { markdown: 'x', tags: tooMany })).isError).toBe(true);
      expect((await call('save_concept', { markdown: 'x', tags: ['x'.repeat(129)] })).isError).toBe(
        true
      );
    });

    it('rejects malformed namespaces', async () => {
      expect((await call('save_concept', { markdown: 'x', namespace: 'a,b' })).isError).toBe(true);
      expect((await call('save_concept', { markdown: 'x', namespace: '' })).isError).toBe(true);
    });
  });

  // --- POLY-29: thoughtform is validated, not z.any ---

  describe('thoughtform validation', () => {
    beforeEach(connect);

    it('rejects free-form JSON as a thoughtform', async () => {
      const result = await call('save_concept', { thoughtform: { note: 'free form' } });
      expect(result.isError).toBe(true);
      expect((await conceptService.getStats()).conceptCount).toBe(0);
    });

    it('accepts a PolyVault v1 thoughtform and converts it to markdown without crashing', async () => {
      const saved = await ok<{ id: string }>('save_concept', { thoughtform: V1_THOUGHTFORM });
      const converted = await ok<{ concept: { markdown: string } }>('convert_concept', {
        id: saved.id,
        from: 'thoughtform',
        to: 'markdown',
      });
      expect(converted.concept.markdown).toContain('Ada Lovelace wrote the first program.');
      expect(converted.concept.markdown).toContain('**Ada Lovelace** (PERSON)');
    });
  });

  // --- POLY-33: save → search works without a manual convert ---

  describe('auto-embedding on save', () => {
    beforeEach(connect);

    it('makes a markdown-only concept searchable immediately', async () => {
      const saved = await ok<{ id: string; derived: Record<string, unknown> }>('save_concept', {
        markdown: 'Marie Curie studied radioactivity',
      });
      expect(saved.derived).toEqual({ vector: { from: 'markdown' } });

      const results = await ok<Array<{ id: string; score: number }>>('search_concepts', {
        query: 'radioactivity Curie',
      });
      expect(results[0]?.id).toBe(saved.id);
      expect(results[0]!.score).toBeGreaterThan(0.5);
      expect(results[0]!.score).toBeLessThanOrEqual(1);
    });

    it('embeds a thoughtform-only concept from its rawText', async () => {
      const saved = await ok<{ id: string }>('save_concept', { thoughtform: V1_THOUGHTFORM });
      const results = await ok<Array<{ id: string }>>('search_concepts', { query: 'Lovelace program' });
      expect(results.map(r => r.id)).toContain(saved.id);
    });

    it('can be switched off with autoEmbed:false', async () => {
      await ok('save_concept', { markdown: 'Marie Curie studied radioactivity', autoEmbed: false });
      expect(await ok('search_concepts', { query: 'radioactivity' })).toEqual([]);
    });

    it('re-embeds when authored markdown changes, but never replaces an authored vector', async () => {
      const saved = await ok<{ id: string }>('save_concept', { markdown: 'alpha beta' });
      await ok('save_concept', { id: saved.id, markdown: 'gamma delta' });
      const hits = await ok<Array<{ id: string }>>('search_concepts', { query: 'gamma delta', k: 1 });
      expect(hits[0]?.id).toBe(saved.id);

      const authored = new Array<number>(VECTOR_DIMENSION).fill(0);
      authored[0] = 1;
      const withVector = await ok<{ id: string }>('save_concept', {
        markdown: 'epsilon',
        embedding: authored,
      });
      const updated = await ok<{ embedding: number[]; derived: Record<string, unknown> }>(
        'save_concept',
        { id: withVector.id, markdown: 'zeta' }
      );
      expect(updated.embedding[0]).toBeCloseTo(1, 6);
      expect(updated.derived).toEqual({});
    });

    it('auto-embeds batch saves by default', async () => {
      const result = await ok<{ ids: string[] }>('batch_save_concepts', {
        concepts: [{ markdown: 'one fish' }, { markdown: 'two fish' }],
      });
      const stats = await ok<{ vectorCount: number }>('get_stats', {});
      expect(stats.vectorCount).toBe(result.ids.length);
    });
  });

  // --- POLY-16: derived content never replaces authored content; conversions stay in-namespace ---

  describe('conversions', () => {
    beforeEach(connect);

    it('refuses to overwrite authored markdown unless overwrite:true', async () => {
      const saved = await ok<{ id: string }>('save_concept', {
        markdown: 'my own words',
        thoughtform: V1_THOUGHTFORM,
      });
      const body = errorBody(
        await call('convert_concept', { id: saved.id, from: 'thoughtform', to: 'markdown' })
      );
      expect(body.code).toBe('OVERWRITE_REFUSED');
      expect((await conceptService.read(saved.id)).markdown).toBe('my own words');

      const forced = await ok<{ concept: { markdown: string; derived: Record<string, unknown> } }>(
        'convert_concept',
        { id: saved.id, from: 'thoughtform', to: 'markdown', overwrite: true }
      );
      expect(forced.concept.markdown).toContain('Ada Lovelace');
      expect(forced.concept.derived).toMatchObject({ markdown: { from: 'thoughtform' } });
    });

    it('refuses vector → markdown without an LLM instead of splicing in neighbours', async () => {
      await ok('save_concept', { markdown: 'DEFAULT-NS SECRET: payroll numbers' });
      const target = await ok<{ id: string }>('save_concept', {
        namespace: 'agent-b',
        markdown: 'agentB original note',
      });
      const body = errorBody(
        await call('convert_concept', {
          id: target.id,
          namespace: 'agent-b',
          from: 'vector',
          to: 'markdown',
          overwrite: true,
        })
      );
      expect(body.code).toBe('CONVERSION_ERROR');
      expect((await conceptService.read(target.id)).markdown).toBe('agentB original note');
    });
  });

  // --- POLY-17: namespace enforcement ---

  describe('namespace enforcement', () => {
    beforeEach(connect);

    it('treats a concept in another namespace as not found for read, delete and convert', async () => {
      const b = await ok<{ id: string }>('save_concept', { namespace: 'agent-b', markdown: 'b secret' });

      for (const [tool, args] of [
        ['read_concept', { id: b.id }],
        ['read_concept', { id: b.id, namespace: 'agent-a' }],
        ['delete_concept', { id: b.id, namespace: 'agent-a' }],
        ['convert_concept', { id: b.id, namespace: 'agent-a', from: 'markdown', to: 'vector' }],
      ] as const) {
        const body = errorBody(await call(tool, args));
        expect(body.code).toBe('NOT_FOUND');
        expect(body.text).not.toContain('b secret');
      }

      const own = await ok<{ markdown: string }>('read_concept', { id: b.id, namespace: 'agent-b' });
      expect(own.markdown).toBe('b secret');
    });

    it('refuses to update a concept through a different namespace', async () => {
      const b = await ok<{ id: string }>('save_concept', { namespace: 'agent-b', markdown: 'b' });
      const body = errorBody(await call('save_concept', { id: b.id, markdown: 'hijack' }));
      expect(body.code).toBe('NAMESPACE_DENIED');
      expect((await conceptService.read(b.id)).markdown).toBe('b');
    });

    it('denies crossNamespace search unless the operator configured namespaces', async () => {
      await ok('save_concept', { namespace: 'agent-b', markdown: 'b data' });
      const body = errorBody(await call('search_concepts', { query: 'data', crossNamespace: true }));
      expect(body.code).toBe('NAMESPACE_DENIED');
    });
  });

  describe('namespace allowlist (POLYTICIAN_NAMESPACES)', () => {
    beforeEach(async () => {
      process.env['POLYTICIAN_NAMESPACES'] = 'agent-a,agent-b';
      await connect();
    });

    it('denies namespaces outside the allowlist, including the implicit default', async () => {
      expect(
        errorBody(await call('save_concept', { namespace: 'agent-c', markdown: 'x' })).code
      ).toBe('NAMESPACE_DENIED');
      expect(errorBody(await call('save_concept', { markdown: 'x' })).code).toBe('NAMESPACE_DENIED');
      expect(errorBody(await call('list_concepts', { namespace: 'agent-c' })).code).toBe(
        'NAMESPACE_DENIED'
      );
      expect(
        errorBody(await call('search_concepts', { query: 'x', namespace: 'agent-c' })).code
      ).toBe('NAMESPACE_DENIED');
    });

    it('limits crossNamespace search to the allowlisted namespaces', async () => {
      const a = await ok<{ id: string }>('save_concept', { namespace: 'agent-a', markdown: 'shared words' });
      const b = await ok<{ id: string }>('save_concept', { namespace: 'agent-b', markdown: 'shared words' });
      // Written behind the server's back, e.g. by an older deployment.
      const c = await conceptService.save({
        namespace: 'agent-c',
        markdown: 'shared words',
        autoEmbed: true,
      });

      const results = await ok<Array<{ id: string; namespace: string }>>('search_concepts', {
        query: 'shared words',
        crossNamespace: true,
      });
      const ids = results.map(r => r.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(ids).not.toContain(c.id);
    });
  });
});
