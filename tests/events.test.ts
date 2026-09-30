import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import { conceptEventBus } from '../src/events/concept-events.js';
import { getAdapter } from '../src/db/client.js';

let service: ConceptService;

describe('Concept event emission', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('emits concept.created when a new concept is saved', async () => {
    const received: unknown[] = [];
    const listener = (payload: unknown): void => { received.push(payload); };
    conceptEventBus.on('concept.created', listener as never);

    const concept = await service.save({ markdown: '# Distributed test' });

    conceptEventBus.off('concept.created', listener as never);
    expect(received).toHaveLength(1);
    expect((received[0] as { conceptId: string }).conceptId).toBe(concept.id);
  });

  it('emits concept.created with embedding when vector is provided', async () => {
    const embedding = Array.from({ length: 384 }, () => 0.1);
    let capturedPayload: { conceptId: string; embedding: number[] | null; timestamp: number } | null = null;

    const listener = (p: typeof capturedPayload): void => { capturedPayload = p; };
    conceptEventBus.on('concept.created', listener as never);

    const concept = await service.save({ embedding });

    conceptEventBus.off('concept.created', listener as never);
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.conceptId).toBe(concept.id);
    expect(capturedPayload!.embedding).toHaveLength(384);
    expect(capturedPayload!.timestamp).toBeGreaterThan(0);
  });

  it('emits concept.updated when an existing concept is re-saved', async () => {
    const id = '11111111-1111-4111-a111-111111111111';
    await service.save({ id, markdown: '# Original' });

    const received: unknown[] = [];
    const listener = (payload: unknown): void => { received.push(payload); };
    conceptEventBus.on('concept.updated', listener as never);

    await service.save({ id, markdown: '# Updated' });

    conceptEventBus.off('concept.updated', listener as never);
    expect(received).toHaveLength(1);
    expect((received[0] as { conceptId: string }).conceptId).toBe(id);
  });

  it('emits concept.deleted when a concept is removed', async () => {
    const concept = await service.save({ markdown: '# To delete' });

    let deletedId: string | null = null;
    const listener = (p: { conceptId: string }): void => { deletedId = p.conceptId; };
    conceptEventBus.on('concept.deleted', listener as never);

    await service.delete(concept.id);

    conceptEventBus.off('concept.deleted', listener as never);
    expect(deletedId).toBe(concept.id);
  });

  it('includes a timestamp in all emitted events', async () => {
    const before = Date.now();
    let ts = 0;

    const listener = (p: { timestamp: number }): void => { ts = p.timestamp; };
    conceptEventBus.on('concept.created', listener as never);

    await service.save({ markdown: '# Timestamp check' });

    conceptEventBus.off('concept.created', listener as never);
    const after = Date.now();

    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('Vector index consistency (replaces the 2.x async IndexSyncService)', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('indexes the vector in the same write as the row, with no async sync step', async () => {
    const embedding = Array.from({ length: 384 }, (_, i) => (i === 3 ? 1 : 0.01));
    const saved = await service.save({ embedding });

    const results = await getAdapter().vectorSearch(
      Buffer.from(new Float32Array(embedding).buffer),
      1,
      { namespaces: null }
    );
    expect(results.map(r => r.concept_id)).toEqual([saved.id]);
  });

  it('removes the vector together with the row on delete', async () => {
    const embedding = Array.from({ length: 384 }, (_, i) => (i === 4 ? 1 : 0.01));
    const saved = await service.save({ embedding });
    await service.delete(saved.id);

    const results = await getAdapter().vectorSearch(
      Buffer.from(new Float32Array(embedding).buffer),
      10,
      { namespaces: null }
    );
    expect(results).toEqual([]);
  });

  it('emits no events for a batch that was rolled back', async () => {
    const created = vi.fn();
    conceptEventBus.on('concept.created', created);
    try {
      await expect(
        service.saveBatch([{ markdown: '# ok' }, { markdown: '# bad', embedding: [1, 2, 3] }])
      ).rejects.toThrow();
    } finally {
      conceptEventBus.off('concept.created', created);
    }
    expect(created).not.toHaveBeenCalled();
  });
});

describe('Stateless scaling readiness', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('concept state is accessible to any service instance reading from the same store', async () => {
    // Simulate two service instances that share the same SQLite database
    // (stand-in for a shared external state backend in distributed mode).
    const writerService = new ConceptService();
    const readerService = new ConceptService();

    const concept = await writerService.save({ markdown: '# Shared state' });
    const read = await readerService.read(concept.id);

    expect(read.id).toBe(concept.id);
    expect(read.markdown).toBe('# Shared state');
  });

  it('multiple instances emitting events do not interfere with each other', async () => {
    const received: string[] = [];
    const listener = (p: { conceptId: string }): void => { received.push(p.conceptId); };
    conceptEventBus.on('concept.created', listener as never);

    const svc1 = new ConceptService();
    const svc2 = new ConceptService();

    const c1 = await svc1.save({ markdown: '# Node 1' });
    const c2 = await svc2.save({ markdown: '# Node 2' });

    conceptEventBus.off('concept.created', listener as never);

    expect(received).toContain(c1.id);
    expect(received).toContain(c2.id);
  });
});
