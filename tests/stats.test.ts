import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';

let service: ConceptService;

describe('ConceptService stats', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should return zeros on empty database', async () => {
    const stats = await service.getStats();
    expect(stats.conceptCount).toBe(0);
    expect(stats.vectorCount).toBe(0);
    expect(stats.representationCounts.markdown).toBe(0);
    expect(stats.representationCounts.thoughtform).toBe(0);
    expect(stats.representationCounts.vector).toBe(0);
  });

  it('should count concepts and representations correctly', async () => {
    const embedding = Array.from({ length: 384 }, () => 0.1);

    // Concept 1: markdown only
    await service.save({ markdown: '# One' });
    // Concept 2: markdown + vector
    await service.save({ markdown: '# Two', embedding });
    // Concept 3: vector only
    await service.save({ embedding: Array.from({ length: 384 }, () => 0.2) });

    const stats = await service.getStats();
    expect(stats.conceptCount).toBe(3);
    expect(stats.vectorCount).toBe(2);
    expect(stats.representationCounts.markdown).toBe(2);
    expect(stats.representationCounts.vector).toBe(2);
    expect(stats.representationCounts.thoughtform).toBe(0);
  });

  it('should update counts after delete', async () => {
    const id = 'cccccccc-cccc-4ccc-accc-cccccccccccc';
    const embedding = Array.from({ length: 384 }, () => 0.1);
    await service.save({ id, markdown: '# Delete me', embedding });
    await service.save({ markdown: '# Keep me' });

    await service.delete(id);

    const stats = await service.getStats();
    expect(stats.conceptCount).toBe(1);
    expect(stats.vectorCount).toBe(0);
    expect(stats.representationCounts.markdown).toBe(1);
  });
});
