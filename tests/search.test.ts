import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';

let service: ConceptService;

// Helper: create a simple normalized embedding vector with a dominant dimension
function makeEmbedding(dominantIndex: number): number[] {
  const vec = Array.from({ length: 384 }, () => 0.01);
  vec[dominantIndex] = 1.0;
  // Normalize
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / magnitude);
}

describe('ConceptService search', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should return empty array on empty index', async () => {
    const query = makeEmbedding(0);
    const results = await service.search(query, 5);
    expect(results).toEqual([]);
  });

  it('should find a concept by vector similarity', async () => {
    const embedding = makeEmbedding(10);
    await service.save({ markdown: '# Found', embedding, tags: ['test'] });

    const query = makeEmbedding(10);
    const results = await service.search(query, 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.distance).toBeCloseTo(0, 1);
    expect(results[0]!.tags).toContain('test');
    expect(results[0]!.representations.markdown).toBe(true);
    expect(results[0]!.representations.vector).toBe(true);
  });

  it('should rank closer vectors higher', async () => {
    const similar = makeEmbedding(10);
    const different = makeEmbedding(200);

    const savedSimilar = await service.save({ markdown: '# Similar', embedding: similar });
    const savedDifferent = await service.save({ markdown: '# Different', embedding: different });

    const query = makeEmbedding(10);
    const results = await service.search(query, 10);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe(savedSimilar.id);
    expect(results[1]!.id).toBe(savedDifferent.id);
    expect(results[0]!.distance).toBeLessThan(results[1]!.distance);
  });

  it('should respect k limit', async () => {
    for (let i = 0; i < 10; i++) {
      await service.save({ embedding: makeEmbedding(i), tags: [`idx-${i}`] });
    }

    const query = makeEmbedding(0);
    const results = await service.search(query, 3);
    expect(results).toHaveLength(3);
  });

  it('should filter results by tags', async () => {
    await service.save({ embedding: makeEmbedding(10), tags: ['physics'] });
    await service.save({ embedding: makeEmbedding(11), tags: ['art'] });

    const query = makeEmbedding(10);
    const results = await service.search(query, 10, ['physics']);
    expect(results).toHaveLength(1);
    expect(results[0]!.tags).toContain('physics');
  });

  it('should include representation availability in results', async () => {
    const embedding = makeEmbedding(0);
    await service.save({ embedding, markdown: '# Has markdown' });
    await service.save({ embedding: makeEmbedding(1) });

    const results = await service.search(makeEmbedding(0), 10);
    const withMd = results.find(r => r.representations.markdown);
    const withoutMd = results.find(r => !r.representations.markdown);
    expect(withMd).toBeDefined();
    expect(withoutMd).toBeDefined();
  });

  it('should work with updated embeddings', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    await service.save({ id, embedding: makeEmbedding(0) });
    // Update the embedding to a different region
    await service.save({ id, embedding: makeEmbedding(300) });

    // Should find it near 300, not near 0
    const resultsNear300 = await service.search(makeEmbedding(300), 5);
    const resultsNear0 = await service.search(makeEmbedding(0), 5);
    expect(resultsNear300[0]!.distance).toBeLessThan(resultsNear0[0]!.distance);
  });

  it('should remove vector from index on concept delete', async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
    await service.save({ id, embedding: makeEmbedding(50) });
    await service.delete(id);

    const results = await service.search(makeEmbedding(50), 5);
    expect(results).toHaveLength(0);
  });
});
