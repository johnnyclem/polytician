import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';

let service: ConceptService;

describe('ConceptService', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('save', () => {
    it('should create a concept with only markdown', async () => {
      const result = await service.save({ markdown: '# Hello World' });
      expect(result.id).toBeDefined();
      expect(result.markdown).toBe('# Hello World');
      expect(result.thoughtform).toBeNull();
      expect(result.embedding).toBeNull();
    });

    it('should auto-generate a UUID if none provided', async () => {
      const result = await service.save({ markdown: 'test' });
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should use provided UUID', async () => {
      const id = '11111111-1111-4111-a111-111111111111';
      const result = await service.save({ id, markdown: 'test' });
      expect(result.id).toBe(id);
    });

    it('should save a concept with embedding', async () => {
      const embedding = Array.from({ length: 384 }, (_, i) => i / 384);
      const result = await service.save({ embedding });
      expect(result.embedding).toHaveLength(384);
      // Float32 precision: values may differ slightly
      expect(result.embedding![0]).toBeCloseTo(0, 5);
    });

    it('should save a concept with thoughtform', async () => {
      const tf = {
        id: '22222222-2222-4222-a222-222222222222',
        rawText: 'Einstein was a physicist',
        language: 'en',
        metadata: {
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
          author: null,
          tags: [],
          source: 'user_input' as const,
        },
        entities: [
          { id: 'ent_0', text: 'Einstein', type: 'PERSON', confidence: 0.95, offset: { start: 0, end: 8 } },
        ],
        relationships: [],
        contextGraph: {},
      };
      const result = await service.save({ id: tf.id, thoughtform: tf });
      expect(result.thoughtform).toBeDefined();
      expect(result.thoughtform!.rawText).toBe('Einstein was a physicist');
      expect(result.thoughtform!.entities).toHaveLength(1);
    });

    it('should merge tags on update (union, not replace)', async () => {
      const id = '33333333-3333-4333-a333-333333333333';
      await service.save({ id, tags: ['physics', 'science'] });
      const updated = await service.save({ id, tags: ['science', 'biography'] });
      expect(updated.tags).toEqual(expect.arrayContaining(['physics', 'science', 'biography']));
      expect(updated.tags).toHaveLength(3);
    });

    it('should merge representations without overwriting existing ones', async () => {
      const id = '44444444-4444-4444-a444-444444444444';
      await service.save({ id, markdown: '# Original' });
      const embedding = Array.from({ length: 384 }, () => 0.5);
      const updated = await service.save({ id, embedding });
      expect(updated.markdown).toBe('# Original');
      expect(updated.embedding).toHaveLength(384);
    });

    it('should overwrite a representation when explicitly provided', async () => {
      const id = '55555555-5555-4555-a555-555555555555';
      await service.save({ id, markdown: '# Original' });
      const updated = await service.save({ id, markdown: '# Updated' });
      expect(updated.markdown).toBe('# Updated');
    });
  });

  describe('read', () => {
    it('should return concept with only non-null representations', async () => {
      const id = '66666666-6666-4666-a666-666666666666';
      await service.save({ id, markdown: '# Test' });
      const result = await service.read(id);
      expect(result.markdown).toBe('# Test');
      expect(result).not.toHaveProperty('thoughtform');
      expect(result).not.toHaveProperty('embedding');
    });

    it('should filter to requested representations', async () => {
      const id = '77777777-7777-4777-a777-777777777777';
      const embedding = Array.from({ length: 384 }, () => 0.1);
      await service.save({ id, markdown: '# Test', embedding });
      const result = await service.read(id, ['markdown']);
      expect(result.markdown).toBe('# Test');
      expect(result).not.toHaveProperty('embedding');
    });

    it('should throw for non-existent concept', async () => {
      await expect(service.read('99999999-9999-4999-a999-999999999999')).rejects.toThrow('not found');
    });
  });

  describe('delete', () => {
    it('should delete concept and all representations', async () => {
      const id = '88888888-8888-4888-a888-888888888888';
      const embedding = Array.from({ length: 384 }, () => 0.1);
      await service.save({ id, markdown: '# Delete me', embedding });
      await service.delete(id);
      await expect(service.read(id)).rejects.toThrow('not found');
    });

    it('should throw for non-existent concept', async () => {
      await expect(service.delete('99999999-9999-4999-a999-999999999999')).rejects.toThrow('not found');
    });
  });

  describe('list', () => {
    it('should return empty list on empty database', async () => {
      const result = await service.list();
      expect(result.concepts).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should list concepts with representation availability', async () => {
      const embedding = Array.from({ length: 384 }, () => 0.1);
      await service.save({ markdown: '# One' });
      await service.save({ embedding });
      const result = await service.list();
      expect(result.total).toBe(2);
      const mdConcept = result.concepts.find(c => c.representations.markdown);
      expect(mdConcept).toBeDefined();
      expect(mdConcept!.representations.vector).toBe(false);
    });

    it('should filter by tags', async () => {
      await service.save({ markdown: '# Physics', tags: ['physics'] });
      await service.save({ markdown: '# Art', tags: ['art'] });
      const result = await service.list({ tags: ['physics'] });
      expect(result.total).toBe(1);
      expect(result.concepts[0]!.tags).toContain('physics');
    });

    it('should paginate with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await service.save({ markdown: `# Concept ${i}` });
      }
      const page1 = await service.list({ limit: 2, offset: 0 });
      const page2 = await service.list({ limit: 2, offset: 2 });
      expect(page1.concepts).toHaveLength(2);
      expect(page2.concepts).toHaveLength(2);
      expect(page1.total).toBe(5);
      // Different concepts on each page
      expect(page1.concepts[0]!.id).not.toBe(page2.concepts[0]!.id);
    });
  });
});
