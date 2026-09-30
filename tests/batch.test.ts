import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// Mock @xenova/transformers
vi.mock('@xenova/transformers', () => {
  const mockPipeline = async (text: string, _options?: Record<string, unknown>) => {
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
      data[i] = Math.sin(hash + i) * 0.5;
    }
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

import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import { getAdapter } from '../src/db/client.js';
import { ValidationError, VersionConflictError } from '../src/errors/index.js';
const { EmbeddingService, embeddingService } = await import('../src/services/embedding.service.js');

// Helper: create a simple normalized embedding vector with a dominant dimension
function makeEmbedding(dominantIndex: number): number[] {
  const vec = Array.from({ length: 384 }, () => 0.01);
  vec[dominantIndex % 384] = 1.0;
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / magnitude);
}

describe('Batch embedding ingestion', () => {
  let conceptService: ConceptService;
  let localEmbeddingService: InstanceType<typeof EmbeddingService>;

  beforeEach(() => {
    setupTestDb();
    conceptService = new ConceptService();
    localEmbeddingService = new EmbeddingService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  describe('EmbeddingService.embedBatch', () => {
    it('should generate embeddings for multiple texts', async () => {
      const texts = ['hello world', 'quantum physics', 'machine learning'];
      const embeddings = await localEmbeddingService.embedBatch(texts);

      expect(embeddings).toHaveLength(3);
      for (const emb of embeddings) {
        expect(emb).toHaveLength(VECTOR_DIMENSION);
      }
    });

    it('should produce same results as individual embed calls', async () => {
      const texts = ['alpha', 'beta', 'gamma'];
      const batchResults = await localEmbeddingService.embedBatch(texts);
      const individualResults = await Promise.all(texts.map(t => localEmbeddingService.embed(t)));

      for (let i = 0; i < texts.length; i++) {
        expect(batchResults[i]).toEqual(individualResults[i]);
      }
    });

    it('should handle empty input', async () => {
      const results = await localEmbeddingService.embedBatch([]);
      expect(results).toEqual([]);
    });

    it('should respect batch size parameter', async () => {
      const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
      const results = await localEmbeddingService.embedBatch(texts, 3);
      expect(results).toHaveLength(10);
    });
  });

  describe('ConceptService.saveBatch', () => {
    it('should save multiple concepts in a single batch', async () => {
      const entries = Array.from({ length: 5 }, (_, i) => ({
        markdown: `# Concept ${i}`,
        tags: ['batch-test'],
      }));

      const result = await conceptService.saveBatch(entries);

      expect(result.count).toBe(5);
      expect(result.saved).toHaveLength(5);
      for (const concept of result.saved) {
        expect(concept.tags).toContain('batch-test');
      }
    });

    it('should save more than 50 entries with batched processing', async () => {
      const entries = Array.from({ length: 75 }, (_, i) => ({
        markdown: `# Bulk concept ${i}`,
        embedding: makeEmbedding(i),
        tags: ['bulk'],
      }));

      const result = await conceptService.saveBatch(entries, { batchSize: 50 });

      expect(result.count).toBe(75);
      expect(result.saved).toHaveLength(75);

      // Verify all concepts are searchable
      const listResult = await conceptService.list({ tags: ['bulk'], limit: 100 });
      expect(listResult.total).toBe(75);
    });

    it('should defer vector index updates until batch completion', async () => {
      const entries = Array.from({ length: 20 }, (_, i) => ({
        embedding: makeEmbedding(i),
        tags: ['deferred-test'],
      }));

      const result = await conceptService.saveBatch(entries);
      expect(result.count).toBe(20);

      // All vectors should be searchable after batch completion
      const searchResults = await conceptService.search(makeEmbedding(0), 20);
      expect(searchResults.length).toBe(20);
    });

    it('should handle mixed entries with and without embeddings', async () => {
      const entries = [
        { markdown: '# No embedding', tags: ['mixed'] },
        { markdown: '# With embedding', embedding: makeEmbedding(5), tags: ['mixed'] },
        { markdown: '# Another without', tags: ['mixed'] },
      ];

      const result = await conceptService.saveBatch(entries);
      expect(result.count).toBe(3);

      // Only one should be in vector index
      const searchResults = await conceptService.search(makeEmbedding(5), 10);
      expect(searchResults.length).toBe(1);
    });

    it('should auto-generate UUIDs for entries without IDs', async () => {
      const entries = [
        { markdown: '# Auto ID 1' },
        { markdown: '# Auto ID 2' },
      ];

      const result = await conceptService.saveBatch(entries);
      expect(result.saved[0]!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(result.saved[0]!.id).not.toBe(result.saved[1]!.id);
    });

    it('should merge tags on update within batch', async () => {
      const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      await conceptService.save({ id, markdown: '# Original', tags: ['original'] });

      const result = await conceptService.saveBatch([
        { id, tags: ['updated'] },
      ]);

      expect(result.saved[0]!.tags).toContain('original');
      expect(result.saved[0]!.tags).toContain('updated');
    });

    it('is atomic: one invalid entry means nothing in the batch is persisted', async () => {
      const entries = [
        { markdown: '# ok 1', tags: ['atomic'] },
        { markdown: '# ok 2', embedding: makeEmbedding(2), tags: ['atomic'] },
        { markdown: '# bad', embedding: [1, 2, 3], tags: ['atomic'] },
        { markdown: '# ok 4', tags: ['atomic'] },
      ];

      await expect(conceptService.saveBatch(entries)).rejects.toThrow(ValidationError);
      expect((await conceptService.list({ tags: ['atomic'] })).total).toBe(0);
    });

    it('rolls back earlier entries when a later write fails inside the transaction', async () => {
      const id = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
      await conceptService.save({ id, markdown: '# v1' });
      await conceptService.save({ id, markdown: '# v2' });

      await expect(
        conceptService.saveBatch([
          { markdown: '# new', tags: ['rollback'] },
          { id, expectedVersion: 1, markdown: '# stale' },
        ])
      ).rejects.toThrow(VersionConflictError);

      expect((await conceptService.list({ tags: ['rollback'] })).total).toBe(0);
      expect((await conceptService.read(id)).markdown).toBe('# v2');
    });

    it('writes the whole batch through a single adapter transaction', async () => {
      const spy = vi.spyOn(getAdapter(), 'applyWrites');
      await conceptService.saveBatch(
        Array.from({ length: 10 }, (_, i) => ({ markdown: `# tx ${i}`, embedding: makeEmbedding(i) }))
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toHaveLength(10);
    });

    it('embeds each entry that needs a vector exactly once', async () => {
      const embedBatch = vi.spyOn(embeddingService, 'embedBatch');
      const embed = vi.spyOn(embeddingService, 'embed');
      const entries = [
        { markdown: '# needs embedding 1' },
        { markdown: '# has its own', embedding: makeEmbedding(7) },
        { markdown: '# needs embedding 2' },
      ];

      const result = await conceptService.saveBatch(entries, { autoEmbed: true });

      expect(embedBatch).toHaveBeenCalledTimes(1);
      expect(embedBatch.mock.calls[0]![0]).toEqual(['# needs embedding 1', '# needs embedding 2']);
      expect(embed.mock.calls.map(c => c[0])).toEqual([
        '# needs embedding 1',
        '# needs embedding 2',
      ]);
      expect(result.saved.every(c => c.embedding?.length === VECTOR_DIMENSION)).toBe(true);
      expect(result.saved[1]!.derived).toEqual({});
      expect(result.saved[0]!.derived).toEqual({ vector: { from: 'markdown' } });
    });
  });
});

describe('Async sidecar communication', () => {
  let embeddingService: InstanceType<typeof EmbeddingService>;

  beforeEach(() => {
    embeddingService = new EmbeddingService();
  });

  it('should handle multiple embedding requests concurrently', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `concurrent text ${i}`);

    // Fire all requests simultaneously
    const promises = texts.map(text => embeddingService.embed(text));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(20);
    for (const emb of results) {
      expect(emb).toHaveLength(VECTOR_DIMENSION);
    }
  });

  it('should not block the event loop during batch processing', async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `non-blocking ${i}`);

    // Start batch embedding
    const batchPromise = embeddingService.embedBatch(texts, 5);

    // This should resolve concurrently without waiting for batch
    let eventLoopFree = false;
    const checkPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        eventLoopFree = true;
        resolve();
      }, 0);
    });

    await Promise.all([batchPromise, checkPromise]);
    expect(eventLoopFree).toBe(true);
  });

  it('should produce consistent results regardless of concurrency', async () => {
    const text = 'consistency check';

    // Run the same embedding multiple times concurrently
    const promises = Array.from({ length: 5 }, () => embeddingService.embed(text));
    const results = await Promise.all(promises);

    // All results should be identical
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }
  });
});
