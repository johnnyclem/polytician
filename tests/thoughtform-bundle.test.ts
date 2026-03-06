import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import {
  serializeThoughtFormsBundle,
  type ThoughtFormBundle,
} from '../src/storage/thoughtform.js';
import type { ThoughtForm } from '../src/types/thoughtform.js';

function makeTf(index: number, overrides?: Partial<ThoughtForm>): ThoughtForm {
  const id = `${index}0000000-0000-4000-a000-000000000000`;
  const now = new Date().toISOString();
  return {
    id,
    rawText: `Sample thought ${index}`,
    language: 'en',
    metadata: {
      createdAt: now,
      updatedAt: now,
      author: null,
      tags: [`tag-${index}`],
      source: 'user_input',
    },
    entities: [
      {
        id: `ent_${index}`,
        text: `Entity${index}`,
        type: 'CONCEPT',
        confidence: 0.9,
        offset: { start: 0, end: 7 },
      },
    ],
    relationships:
      index > 1
        ? [
            {
              subjectId: `ent_${index}`,
              predicate: 'related_to',
              objectId: `ent_${index - 1}`,
              confidence: 0.8,
            },
          ]
        : [],
    contextGraph: {},
    ...overrides,
  };
}

let service: ConceptService;

describe('serializeThoughtFormsBundle', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should round-trip 5 sample ThoughtForm records', async () => {
    // --- Insert 5 concepts with ThoughtForm data ---
    const originals: ThoughtForm[] = [];
    for (let i = 1; i <= 5; i++) {
      const tf = makeTf(i);
      originals.push(tf);
      await service.save({ id: tf.id, thoughtform: tf });
    }

    // --- Serialize ---
    const json = await serializeThoughtFormsBundle();
    const bundle: ThoughtFormBundle = JSON.parse(json);

    // --- Verify bundle envelope ---
    expect(bundle.version).toBe('1.0');
    expect(bundle.metadata.count).toBe(5);
    expect(bundle.metadata.lastSynced).toBeGreaterThan(0);
    expect(bundle.thoughtforms).toHaveLength(5);

    // --- Verify round-trip fidelity for each record ---
    for (const original of originals) {
      const found = bundle.thoughtforms.find((tf) => tf.id === original.id);
      expect(found).toBeDefined();
      expect(found!.rawText).toBe(original.rawText);
      expect(found!.language).toBe(original.language);
      expect(found!.entities).toEqual(original.entities);
      expect(found!.relationships).toEqual(original.relationships);
      expect(found!.metadata.tags).toEqual(original.metadata.tags);
      expect(found!.metadata.source).toBe(original.metadata.source);
    }
  });

  it('should filter by lastSynced timestamp', async () => {
    // Insert 5 records
    for (let i = 1; i <= 5; i++) {
      const tf = makeTf(i);
      await service.save({ id: tf.id, thoughtform: tf });
    }

    // Use a cutoff timestamp far in the future — nothing should pass
    const futureCutoff = Date.now() + 100_000;
    const emptyJson = await serializeThoughtFormsBundle(futureCutoff);
    const emptyBundle: ThoughtFormBundle = JSON.parse(emptyJson);
    expect(emptyBundle.metadata.count).toBe(0);

    // Use a cutoff timestamp in the past — all should pass
    const pastCutoff = 0;
    const fullJson = await serializeThoughtFormsBundle(pastCutoff);
    const fullBundle: ThoughtFormBundle = JSON.parse(fullJson);
    expect(fullBundle.metadata.count).toBe(5);

    // Now update one record to give it a fresh updated_at, then use the
    // original updated_at as cutoff so only the refreshed one appears.
    const beforeUpdate = Date.now() - 1;
    // Re-save record 3 with updated text to bump its updated_at
    const tf3 = makeTf(3, { rawText: 'Updated thought 3' });
    await service.save({ id: tf3.id, thoughtform: tf3 });

    const json = await serializeThoughtFormsBundle(beforeUpdate);
    const bundle: ThoughtFormBundle = JSON.parse(json);

    expect(bundle.metadata.count).toBeGreaterThanOrEqual(1);
    const ids = bundle.thoughtforms.map((tf) => tf.id);
    expect(ids).toContain(tf3.id);
  });

  it('should return empty bundle when no ThoughtForms exist', async () => {
    // Insert a concept without thoughtform
    await service.save({ markdown: '# No ThoughtForm here' });

    const json = await serializeThoughtFormsBundle();
    const bundle: ThoughtFormBundle = JSON.parse(json);

    expect(bundle.version).toBe('1.0');
    expect(bundle.metadata.count).toBe(0);
    expect(bundle.thoughtforms).toEqual([]);
  });

  it('should produce valid JSON that can be deserialized back to the same bundle', async () => {
    for (let i = 1; i <= 5; i++) {
      const tf = makeTf(i);
      await service.save({ id: tf.id, thoughtform: tf });
    }

    const json = await serializeThoughtFormsBundle();

    // Verify it's valid JSON
    expect(() => JSON.parse(json)).not.toThrow();

    // Re-serialize and compare (excluding lastSynced which is timestamp-dependent)
    const bundle1: ThoughtFormBundle = JSON.parse(json);
    const reSerialized = JSON.stringify(bundle1);
    const bundle2: ThoughtFormBundle = JSON.parse(reSerialized);

    expect(bundle2.version).toBe(bundle1.version);
    expect(bundle2.metadata.count).toBe(bundle1.metadata.count);
    expect(bundle2.thoughtforms).toEqual(bundle1.thoughtforms);
  });
});
