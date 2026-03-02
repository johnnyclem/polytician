import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';

let service: ConceptService;

function makeEmbedding(dominantIndex: number): number[] {
  const vec = Array.from({ length: 384 }, () => 0.01);
  vec[dominantIndex] = 1.0;
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / magnitude);
}

describe('Namespace isolation', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should save a concept with a namespace', async () => {
    const result = await service.save({ namespace: 'agent-a', markdown: '# Agent A concept' });
    expect(result.namespace).toBe('agent-a');
  });

  it('should default namespace to "default"', async () => {
    const result = await service.save({ markdown: '# Default namespace' });
    expect(result.namespace).toBe('default');
  });

  it('should allow same-id concepts only once (ID is global)', async () => {
    const id = '11111111-1111-4111-a111-111111111111';
    await service.save({ id, namespace: 'agent-a', markdown: '# Agent A' });
    // Saving with same ID but different namespace updates the existing row
    const updated = await service.save({ id, markdown: '# Updated by agent-b' });
    expect(updated.namespace).toBe('agent-a'); // namespace is set at creation
  });

  it('should scope list results to a namespace', async () => {
    await service.save({ namespace: 'agent-a', markdown: '# A1', tags: ['test'] });
    await service.save({ namespace: 'agent-a', markdown: '# A2', tags: ['test'] });
    await service.save({ namespace: 'agent-b', markdown: '# B1', tags: ['test'] });

    const agentAList = await service.list({ namespace: 'agent-a' });
    expect(agentAList.total).toBe(2);
    expect(agentAList.concepts.every(c => c.namespace === 'agent-a')).toBe(true);

    const agentBList = await service.list({ namespace: 'agent-b' });
    expect(agentBList.total).toBe(1);
    expect(agentBList.concepts[0]!.namespace).toBe('agent-b');
  });

  it('should scope list to "default" namespace by default', async () => {
    await service.save({ markdown: '# Default' });
    await service.save({ namespace: 'agent-a', markdown: '# Agent A' });

    const defaultList = await service.list();
    expect(defaultList.total).toBe(1);
  });

  it('should scope search results to a namespace by default', async () => {
    const embedding = makeEmbedding(10);
    await service.save({ namespace: 'agent-a', embedding, tags: ['a'] });
    await service.save({ namespace: 'agent-b', embedding: makeEmbedding(11), tags: ['b'] });

    const results = await service.search(makeEmbedding(10), 10, undefined, { namespace: 'agent-a' });
    expect(results.length).toBe(1);
    expect(results[0]!.namespace).toBe('agent-a');
    expect(results[0]!.tags).toContain('a');
  });

  it('should allow cross-namespace search with explicit opt-in', async () => {
    await service.save({ namespace: 'agent-a', embedding: makeEmbedding(10), tags: ['a'] });
    await service.save({ namespace: 'agent-b', embedding: makeEmbedding(11), tags: ['b'] });

    const results = await service.search(makeEmbedding(10), 10, undefined, { crossNamespace: true });
    expect(results.length).toBe(2);
    const namespaces = results.map(r => r.namespace).sort();
    expect(namespaces).toEqual(['agent-a', 'agent-b']);
  });

  it('should scope stats to a namespace', async () => {
    const embedding = makeEmbedding(0);
    await service.save({ namespace: 'agent-a', markdown: '# A1', embedding });
    await service.save({ namespace: 'agent-a', markdown: '# A2' });
    await service.save({ namespace: 'agent-b', markdown: '# B1' });

    const statsA = await service.getStats('agent-a');
    expect(statsA.conceptCount).toBe(2);
    expect(statsA.representationCounts.markdown).toBe(2);
    expect(statsA.vectorCount).toBe(1);

    const statsB = await service.getStats('agent-b');
    expect(statsB.conceptCount).toBe(1);
    expect(statsB.representationCounts.markdown).toBe(1);
    expect(statsB.vectorCount).toBe(0);
  });

  it('should combine namespace and tag filtering in list', async () => {
    await service.save({ namespace: 'agent-a', markdown: '# A-physics', tags: ['physics'] });
    await service.save({ namespace: 'agent-a', markdown: '# A-art', tags: ['art'] });
    await service.save({ namespace: 'agent-b', markdown: '# B-physics', tags: ['physics'] });

    const result = await service.list({ namespace: 'agent-a', tags: ['physics'] });
    expect(result.total).toBe(1);
    expect(result.concepts[0]!.tags).toContain('physics');
  });

  it('should combine namespace and tag filtering in search', async () => {
    await service.save({ namespace: 'agent-a', embedding: makeEmbedding(10), tags: ['physics'] });
    await service.save({ namespace: 'agent-a', embedding: makeEmbedding(11), tags: ['art'] });
    await service.save({ namespace: 'agent-b', embedding: makeEmbedding(12), tags: ['physics'] });

    const results = await service.search(makeEmbedding(10), 10, ['physics'], { namespace: 'agent-a' });
    expect(results.length).toBe(1);
    expect(results[0]!.tags).toContain('physics');
    expect(results[0]!.namespace).toBe('agent-a');
  });
});
