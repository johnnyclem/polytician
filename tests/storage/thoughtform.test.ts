import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { setupTestDb, teardownTestDb } from '../helpers/test-db.js';
import {
  deserializeAndUpsertBundle,
  ThoughtFormBundleSchema,
} from '../../src/storage/thoughtform.js';
import { getAdapter } from '../../src/db/client.js';
import type { ThoughtForm } from '../../src/types/thoughtform.js';

function makeThoughtForm(overrides: Partial<ThoughtForm> & { id: string }): ThoughtForm {
  return {
    rawText: 'Some thought',
    language: 'en',
    metadata: {
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-06-01T00:00:00Z',
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

describe('deserializeAndUpsertBundle', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should insert new ThoughtForms from a JSON string bundle', async () => {
    const tf = makeThoughtForm({ id: '11111111-1111-4111-a111-111111111111' });
    const bundle = JSON.stringify([tf]);

    await deserializeAndUpsertBundle(bundle);

    const adapter = getAdapter();
    const row = await adapter.findConcept(tf.id);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.thoughtform!)).toMatchObject({ id: tf.id, rawText: 'Some thought' });
  });

  it('should insert new ThoughtForms from a Buffer', async () => {
    const tf = makeThoughtForm({ id: '22222222-2222-4222-a222-222222222222' });
    const bundle = Buffer.from(JSON.stringify([tf]));

    await deserializeAndUpsertBundle(bundle);

    const adapter = getAdapter();
    const row = await adapter.findConcept(tf.id);
    expect(row).not.toBeNull();
  });

  it('should decompress gzip-compressed bundles', async () => {
    const tf = makeThoughtForm({ id: '33333333-3333-4333-a333-333333333333' });
    const compressed = gzipSync(JSON.stringify([tf]));

    await deserializeAndUpsertBundle(compressed);

    const adapter = getAdapter();
    const row = await adapter.findConcept(tf.id);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.thoughtform!).id).toBe(tf.id);
  });

  it('should overwrite existing concept when incoming updatedAt is newer', async () => {
    const id = '44444444-4444-4444-a444-444444444444';
    const oldTf = makeThoughtForm({
      id,
      rawText: 'old text',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-03-01T00:00:00Z',
        author: null,
        tags: [],
        source: 'user_input',
      },
    });
    const newTf = makeThoughtForm({
      id,
      rawText: 'new text',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-09-01T00:00:00Z',
        author: null,
        tags: ['updated'],
        source: 'user_input',
      },
    });

    // Insert old version first
    await deserializeAndUpsertBundle(JSON.stringify([oldTf]));

    // Upsert newer version
    await deserializeAndUpsertBundle(JSON.stringify([newTf]));

    const adapter = getAdapter();
    const row = await adapter.findConcept(id);
    expect(row).not.toBeNull();
    const stored = JSON.parse(row!.thoughtform!);
    expect(stored.rawText).toBe('new text');
    expect(row!.version).toBe(2);
  });

  it('should NOT overwrite existing concept when incoming updatedAt is older', async () => {
    const id = '55555555-5555-4555-a555-555555555555';
    const newerTf = makeThoughtForm({
      id,
      rawText: 'newer text',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-09-01T00:00:00Z',
        author: null,
        tags: [],
        source: 'user_input',
      },
    });
    const olderTf = makeThoughtForm({
      id,
      rawText: 'older text',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-03-01T00:00:00Z',
        author: null,
        tags: [],
        source: 'user_input',
      },
    });

    // Insert newer version first
    await deserializeAndUpsertBundle(JSON.stringify([newerTf]));

    // Attempt to upsert older version
    await deserializeAndUpsertBundle(JSON.stringify([olderTf]));

    const adapter = getAdapter();
    const row = await adapter.findConcept(id);
    expect(row).not.toBeNull();
    const stored = JSON.parse(row!.thoughtform!);
    expect(stored.rawText).toBe('newer text');
    expect(row!.version).toBe(1); // unchanged
  });

  it('should NOT overwrite when incoming updatedAt is equal', async () => {
    const id = '66666666-6666-4666-a666-666666666666';
    const tf = makeThoughtForm({
      id,
      rawText: 'original',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-06-01T00:00:00Z',
        author: null,
        tags: [],
        source: 'user_input',
      },
    });
    const sameTf = makeThoughtForm({
      id,
      rawText: 'duplicate attempt',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-06-01T00:00:00Z',
        author: null,
        tags: [],
        source: 'user_input',
      },
    });

    await deserializeAndUpsertBundle(JSON.stringify([tf]));
    await deserializeAndUpsertBundle(JSON.stringify([sameTf]));

    const adapter = getAdapter();
    const row = await adapter.findConcept(id);
    const stored = JSON.parse(row!.thoughtform!);
    expect(stored.rawText).toBe('original');
  });

  it('should handle multiple ThoughtForms in a single bundle', async () => {
    const tf1 = makeThoughtForm({ id: '77777777-7777-4777-a777-777777777771' });
    const tf2 = makeThoughtForm({ id: '77777777-7777-4777-a777-777777777772' });
    const tf3 = makeThoughtForm({ id: '77777777-7777-4777-a777-777777777773' });

    await deserializeAndUpsertBundle(JSON.stringify([tf1, tf2, tf3]));

    const adapter = getAdapter();
    expect(await adapter.findConcept(tf1.id)).not.toBeNull();
    expect(await adapter.findConcept(tf2.id)).not.toBeNull();
    expect(await adapter.findConcept(tf3.id)).not.toBeNull();
  });

  it('should prevent duplicates when bundle contains same id twice', async () => {
    const id = '88888888-8888-4888-a888-888888888888';
    const tf1 = makeThoughtForm({
      id,
      rawText: 'first',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-03-01T00:00:00Z',
        author: null,
        tags: [],
        source: 'user_input',
      },
    });
    const tf2 = makeThoughtForm({
      id,
      rawText: 'second (newer)',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-09-01T00:00:00Z',
        author: null,
        tags: [],
        source: 'user_input',
      },
    });

    await deserializeAndUpsertBundle(JSON.stringify([tf1, tf2]));

    const adapter = getAdapter();
    const row = await adapter.findConcept(id);
    const stored = JSON.parse(row!.thoughtform!);
    expect(stored.rawText).toBe('second (newer)');
  });

  it('should throw ValidationError for invalid JSON', async () => {
    await expect(deserializeAndUpsertBundle('not json {')).rejects.toThrow('not valid JSON');
  });

  it('should throw ValidationError for invalid bundle shape', async () => {
    await expect(deserializeAndUpsertBundle(JSON.stringify({ bad: true }))).rejects.toThrow(
      'Bundle validation failed',
    );
  });

  it('should throw ValidationError for empty array', async () => {
    await expect(deserializeAndUpsertBundle(JSON.stringify([]))).rejects.toThrow(
      'Bundle validation failed',
    );
  });

  it('should preserve metadata tags on insert', async () => {
    const tf = makeThoughtForm({
      id: '99999999-9999-4999-a999-999999999999',
      metadata: {
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-06-01T00:00:00Z',
        author: 'alice',
        tags: ['science', 'physics'],
        source: 'user_input',
      },
    });

    await deserializeAndUpsertBundle(JSON.stringify([tf]));

    const adapter = getAdapter();
    const row = await adapter.findConcept(tf.id);
    expect(JSON.parse(row!.tags)).toEqual(['science', 'physics']);
  });
});

describe('ThoughtFormBundleSchema', () => {
  it('should accept a valid array of ThoughtForms', () => {
    const tf = makeThoughtForm({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' });
    const result = ThoughtFormBundleSchema.safeParse([tf]);
    expect(result.success).toBe(true);
  });

  it('should reject an empty array', () => {
    const result = ThoughtFormBundleSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it('should reject non-array input', () => {
    const result = ThoughtFormBundleSchema.safeParse({ id: 'test' });
    expect(result.success).toBe(false);
  });
});
