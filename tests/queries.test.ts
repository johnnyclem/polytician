import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import { getUpdatedThoughtFormsSince } from '../src/db/queries.js';
import type { ThoughtForm } from '../src/types/thoughtform.js';

function makeTf(overrides: Partial<ThoughtForm> = {}): ThoughtForm {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    rawText: 'Test thought',
    language: 'en',
    metadata: {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      author: null,
      tags: [],
      source: 'user_input',
    },
    entities: [],
    relationships: [],
    contextGraph: {},
    ...overrides,
  };
}

let service: ConceptService;

describe('getUpdatedThoughtFormsSince', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should return empty array when no concepts exist', () => {
    const results = getUpdatedThoughtFormsSince(0);
    expect(results).toEqual([]);
  });

  it('should return only concepts with a thoughtform', async () => {
    const before = Date.now() - 1;
    await service.save({ markdown: '# No TF' });
    await service.save({
      id: '22222222-2222-4222-a222-222222222222',
      thoughtform: makeTf({ id: '22222222-2222-4222-a222-222222222222' }),
    });

    const results = getUpdatedThoughtFormsSince(before);
    expect(results).toHaveLength(1);
    expect(results[0]!.thoughtform.rawText).toBe('Test thought');
  });

  it('should return only records updated after the given timestamp', async () => {
    await service.save({
      id: '33333333-3333-4333-a333-333333333333',
      thoughtform: makeTf({ id: '33333333-3333-4333-a333-333333333333' }),
    });

    // Use a future timestamp to guarantee the first record is excluded
    const midpoint = Date.now() + 1000;

    // Manually set a concept's updated_at to be after midpoint
    const { getAdapter } = await import('../src/db/client.js');
    const adapter = getAdapter();
    const tfData = makeTf({ id: '44444444-4444-4444-a444-444444444444', rawText: 'Newer thought' });
    await adapter.insertConcept({
      id: '44444444-4444-4444-a444-444444444444',
      namespace: 'default',
      version: 1,
      created_at: midpoint + 1,
      updated_at: midpoint + 1,
      tags: '[]',
      markdown: null,
      thoughtform: JSON.stringify(tfData),
      embedding: null,
    });

    const results = getUpdatedThoughtFormsSince(midpoint);
    expect(results).toHaveLength(1);
    expect(results[0]!.thoughtform.rawText).toBe('Newer thought');
  });

  it('should include entities and relationships from thoughtform', async () => {
    const tf = makeTf({
      id: '55555555-5555-4555-a555-555555555555',
      rawText: 'Einstein was a physicist',
      entities: [
        { id: 'ent_0', text: 'Einstein', type: 'PERSON', confidence: 0.95, offset: { start: 0, end: 8 } },
      ],
      relationships: [
        { subjectId: 'ent_0', predicate: 'occupation', objectId: 'physicist' },
      ],
    });

    const before = Date.now() - 1;
    await service.save({ id: tf.id, thoughtform: tf });

    const results = getUpdatedThoughtFormsSince(before);
    expect(results).toHaveLength(1);
    expect(results[0]!.thoughtform.entities).toHaveLength(1);
    expect(results[0]!.thoughtform.entities[0]!.text).toBe('Einstein');
    expect(results[0]!.thoughtform.relationships).toHaveLength(1);
    expect(results[0]!.thoughtform.relationships[0]!.predicate).toBe('occupation');
  });

  it('should order results by updated_at descending', async () => {
    const before = Date.now() - 1;

    await service.save({
      id: '66666666-6666-4666-a666-666666666666',
      thoughtform: makeTf({ id: '66666666-6666-4666-a666-666666666666', rawText: 'First' }),
    });

    await service.save({
      id: '77777777-7777-4777-a777-777777777777',
      thoughtform: makeTf({ id: '77777777-7777-4777-a777-777777777777', rawText: 'Second' }),
    });

    const results = getUpdatedThoughtFormsSince(before);
    expect(results).toHaveLength(2);
    expect(results[0]!.thoughtform.rawText).toBe('Second');
    expect(results[1]!.thoughtform.rawText).toBe('First');
  });

  it('should include updated records after modification', async () => {
    const id = '88888888-8888-4888-a888-888888888888';
    const { getAdapter } = await import('../src/db/client.js');
    const adapter = getAdapter();

    // Insert with a known timestamp
    const t1 = 1000000;
    await adapter.insertConcept({
      id,
      namespace: 'default',
      version: 1,
      created_at: t1,
      updated_at: t1,
      tags: '[]',
      markdown: null,
      thoughtform: JSON.stringify(makeTf({ id, rawText: 'Original' })),
      embedding: null,
    });

    const afterCreate = t1 + 1;

    // Update with a later timestamp
    const t2 = t1 + 100;
    await adapter.updateConcept(id, {
      version: 2,
      updated_at: t2,
      thoughtform: JSON.stringify(makeTf({ id, rawText: 'Updated' })),
    });

    const results = getUpdatedThoughtFormsSince(afterCreate);
    expect(results).toHaveLength(1);
    expect(results[0]!.thoughtform.rawText).toBe('Updated');
  });
});
