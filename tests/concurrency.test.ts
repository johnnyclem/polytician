import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import { VersionConflictError } from '../src/errors/index.js';

let service: ConceptService;

describe('Optimistic concurrency control', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should initialize new concepts at version 1', async () => {
    const result = await service.save({ markdown: '# Version test' });
    expect(result.version).toBe(1);
  });

  it('should increment version on each update', async () => {
    const id = '11111111-1111-4111-a111-111111111111';
    const v1 = await service.save({ id, markdown: '# V1' });
    expect(v1.version).toBe(1);

    const v2 = await service.save({ id, markdown: '# V2' });
    expect(v2.version).toBe(2);

    const v3 = await service.save({ id, tags: ['new-tag'] });
    expect(v3.version).toBe(3);
  });

  it('should accept update when expectedVersion matches current version', async () => {
    const id = '22222222-2222-4222-a222-222222222222';
    await service.save({ id, markdown: '# V1' });

    const updated = await service.save({ id, expectedVersion: 1, markdown: '# V2' });
    expect(updated.version).toBe(2);
    expect(updated.markdown).toBe('# V2');
  });

  it('should reject update when expectedVersion does not match current version', async () => {
    const id = '33333333-3333-4333-a333-333333333333';
    await service.save({ id, markdown: '# V1' });
    await service.save({ id, markdown: '# V2' }); // Now at version 2

    await expect(
      service.save({ id, expectedVersion: 1, markdown: '# Stale write' })
    ).rejects.toThrow(VersionConflictError);
  });

  it('should include current version in the conflict error', async () => {
    const id = '44444444-4444-4444-a444-444444444444';
    await service.save({ id, markdown: '# V1' });
    await service.save({ id, markdown: '# V2' });
    await service.save({ id, markdown: '# V3' }); // Now at version 3

    try {
      await service.save({ id, expectedVersion: 1, markdown: '# Stale' });
      expect.fail('Should have thrown VersionConflictError');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError);
      expect((error as VersionConflictError).currentVersion).toBe(3);
      expect((error as VersionConflictError).message).toContain('expected version 1');
      expect((error as VersionConflictError).message).toContain('current version is 3');
    }
  });

  it('should allow update without expectedVersion (no concurrency check)', async () => {
    const id = '55555555-5555-4555-a555-555555555555';
    await service.save({ id, markdown: '# V1' });

    // Update without expectedVersion should always succeed
    const updated = await service.save({ id, markdown: '# V2' });
    expect(updated.version).toBe(2);
  });

  it('should return version in read response', async () => {
    const id = '66666666-6666-4666-a666-666666666666';
    await service.save({ id, markdown: '# V1' });
    await service.save({ id, markdown: '# V2' });

    const result = await service.read(id);
    expect(result.version).toBe(2);
  });

  it('should return version in list response', async () => {
    const id = '77777777-7777-4777-a777-777777777777';
    await service.save({ id, markdown: '# V1' });
    await service.save({ id, markdown: '# V2' });
    await service.save({ id, markdown: '# V3' });

    const list = await service.list();
    const found = list.concepts.find(c => c.id === id);
    expect(found).toBeDefined();
    expect(found!.version).toBe(3);
  });

  it('should simulate concurrent update conflict', async () => {
    const id = '88888888-8888-4888-a888-888888888888';

    // Agent A reads concept at version 1
    const created = await service.save({ id, markdown: '# Original' });
    const agentAVersion = created.version;

    // Agent B also reads concept at version 1, then updates
    await service.save({ id, expectedVersion: 1, markdown: '# Agent B update' });

    // Agent A tries to update using stale version — should be rejected
    await expect(
      service.save({ id, expectedVersion: agentAVersion, markdown: '# Agent A stale update' })
    ).rejects.toThrow(VersionConflictError);

    // Verify Agent B's update is preserved
    const final = await service.read(id);
    expect(final.markdown).toBe('# Agent B update');
    expect(final.version).toBe(2);
  });

  it('should allow Agent A to retry with correct version after conflict', async () => {
    const id = '99999999-9999-4999-a999-999999999999';
    await service.save({ id, markdown: '# Original' });

    // Agent B updates first
    await service.save({ id, expectedVersion: 1, markdown: '# Agent B' });

    // Agent A gets conflict
    try {
      await service.save({ id, expectedVersion: 1, markdown: '# Agent A attempt 1' });
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError);
      const conflict = error as VersionConflictError;

      // Agent A retries with correct version
      const retried = await service.save({
        id,
        expectedVersion: conflict.currentVersion,
        markdown: '# Agent A attempt 2',
      });
      expect(retried.version).toBe(3);
      expect(retried.markdown).toBe('# Agent A attempt 2');
    }
  });
});
