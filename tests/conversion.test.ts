import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// Mock @xenova/transformers for embedding calls during conversion
vi.mock('@xenova/transformers', () => {
  const mockPipeline = async (text: string, _options?: Record<string, unknown>) => {
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
      data[i] = Math.sin(hash + i) * 0.5;
    }
    let magnitude = 0;
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
      magnitude += data[i]! * data[i]!;
    }
    magnitude = Math.sqrt(magnitude);
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
      data[i] = data[i]! / magnitude;
    }
    return { data };
  };

  return {
    pipeline: vi.fn().mockResolvedValue(mockPipeline),
    env: { cacheDir: '' },
  };
});

import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import { ConversionService } from '../src/services/conversion.service.js';
import type { ThoughtForm } from '../src/types/thoughtform.js';

let concepts: ConceptService;
let conversions: ConversionService;

function makeThoughtForm(id: string): ThoughtForm {
  return {
    id,
    rawText: 'Albert Einstein was a theoretical physicist who developed the theory of relativity.',
    language: 'en',
    metadata: {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      author: null,
      tags: ['physics'],
      source: 'user_input',
    },
    entities: [
      { id: 'ent_0', text: 'Albert Einstein', type: 'PERSON', confidence: 0.98, offset: { start: 0, end: 15 } },
      { id: 'ent_1', text: 'theory of relativity', type: 'CONCEPT', confidence: 0.95, offset: { start: 60, end: 80 } },
    ],
    relationships: [
      { subjectId: 'ent_0', predicate: 'developed', objectId: 'ent_1', confidence: 0.92 },
    ],
    contextGraph: {
      ent_0: ['ent_1'],
    },
  };
}

describe('ConversionService — Non-LLM paths', () => {
  beforeEach(() => {
    setupTestDb();
    concepts = new ConceptService();
    conversions = new ConversionService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  // --- markdown → vector ---

  describe('markdown → vector', () => {
    it('should embed markdown text and persist the vector', async () => {
      const id = '11111111-1111-4111-a111-111111111111';
      await concepts.save({ id, markdown: '# Einstein was a physicist' });

      await conversions.convert(id, 'markdown', 'vector');

      const result = await concepts.read(id);
      expect(result.embedding).toBeDefined();
      expect(result.embedding).toHaveLength(VECTOR_DIMENSION);
      // Markdown should still be present
      expect(result.markdown).toBe('# Einstein was a physicist');
    });

    it('should make the concept searchable after conversion', async () => {
      const id = '22222222-2222-4222-a222-222222222222';
      await concepts.save({ id, markdown: '# Quantum mechanics' });

      await conversions.convert(id, 'markdown', 'vector');

      // Search with the same text should find it
      const { embed } = await import('../src/services/embedding.service.js');
      const emb = await (await import('../src/services/embedding.service.js')).embeddingService.embed('# Quantum mechanics');
      const results = await concepts.search(emb, 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe(id);
    });

    it('should throw when concept has no markdown', async () => {
      const id = '33333333-3333-4333-a333-333333333333';
      const embedding = Array.from({ length: 384 }, () => 0.1);
      await concepts.save({ id, embedding });

      await expect(conversions.convert(id, 'markdown', 'vector')).rejects.toThrow('no markdown');
    });
  });

  // --- thoughtform → vector ---

  describe('thoughtform → vector', () => {
    it('should embed rawText and persist the vector', async () => {
      const id = '44444444-4444-4444-a444-444444444444';
      const tf = makeThoughtForm(id);
      await concepts.save({ id, thoughtform: tf });

      await conversions.convert(id, 'thoughtform', 'vector');

      const result = await concepts.read(id);
      expect(result.embedding).toBeDefined();
      expect(result.embedding).toHaveLength(VECTOR_DIMENSION);
      // ThoughtForm should still be present
      expect(result.thoughtform).toBeDefined();
    });

    it('should throw when concept has no thoughtform', async () => {
      const id = '55555555-5555-4555-a555-555555555555';
      await concepts.save({ id, markdown: '# Just markdown' });

      await expect(conversions.convert(id, 'thoughtform', 'vector')).rejects.toThrow('no thoughtform');
    });
  });

  // --- thoughtform → markdown ---

  describe('thoughtform → markdown', () => {
    it('should format entities and relationships as markdown', async () => {
      const id = '66666666-6666-4666-a666-666666666666';
      const tf = makeThoughtForm(id);
      await concepts.save({ id, thoughtform: tf });

      await conversions.convert(id, 'thoughtform', 'markdown');

      const result = await concepts.read(id);
      expect(result.markdown).toBeDefined();
      const md = result.markdown!;
      // Should contain the raw text
      expect(md).toContain('Albert Einstein was a theoretical physicist');
      // Should contain entities section
      expect(md).toContain('## Entities');
      expect(md).toContain('**Albert Einstein**');
      expect(md).toContain('PERSON');
      expect(md).toContain('**theory of relativity**');
      // Should contain relationships section
      expect(md).toContain('## Relationships');
      expect(md).toContain('**developed**');
    });

    it('should handle thoughtform with no entities gracefully', async () => {
      const id = '77777777-7777-4777-a777-777777777777';
      const tf: ThoughtForm = {
        id,
        rawText: 'A simple note with no entities.',
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
      };
      await concepts.save({ id, thoughtform: tf });

      await conversions.convert(id, 'thoughtform', 'markdown');

      const result = await concepts.read(id);
      expect(result.markdown).toBeDefined();
      expect(result.markdown).toContain('A simple note with no entities.');
      // Should NOT contain entity/relationship sections
      expect(result.markdown).not.toContain('## Entities');
      expect(result.markdown).not.toContain('## Relationships');
    });

    it('should overwrite existing markdown', async () => {
      const id = '88888888-8888-4888-a888-888888888888';
      const tf = makeThoughtForm(id);
      await concepts.save({ id, markdown: '# Old markdown', thoughtform: tf });

      await conversions.convert(id, 'thoughtform', 'markdown');

      const result = await concepts.read(id);
      expect(result.markdown).not.toBe('# Old markdown');
      expect(result.markdown).toContain('Albert Einstein');
    });

    it('should throw when concept has no thoughtform', async () => {
      const id = '99999999-9999-4999-a999-999999999999';
      await concepts.save({ id, markdown: '# Just markdown' });

      await expect(conversions.convert(id, 'thoughtform', 'markdown')).rejects.toThrow('no thoughtform');
    });
  });

  // --- Error cases ---

  describe('error handling', () => {
    it('should throw when converting from same to same', async () => {
      await expect(conversions.convert('any-id', 'markdown', 'markdown'))
        .rejects.toThrow("Cannot convert from 'markdown' to itself");
    });

    it('should throw when concept does not exist', async () => {
      await expect(conversions.convert('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'markdown', 'vector'))
        .rejects.toThrow('not found');
    });
  });
});

describe('ConversionService — LLM paths graceful degradation', () => {
  beforeEach(() => {
    setupTestDb();
    concepts = new ConceptService();
    conversions = new ConversionService();
    // Default NullProvider — no LLM configured
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('markdown → thoughtform should throw with clear LLM error', async () => {
    const id = 'dddddddd-dddd-4ddd-addd-dddddddddddd';
    await concepts.save({ id, markdown: '# Need LLM for this' });

    await expect(conversions.convert(id, 'markdown', 'thoughtform'))
      .rejects.toThrow(/LLM provider|requires.*provider/i);
  });

  it('vector → markdown should throw with clear LLM error', async () => {
    const id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee';
    const embedding = Array.from({ length: 384 }, () => 0.1);
    await concepts.save({ id, embedding });

    await expect(conversions.convert(id, 'vector', 'markdown'))
      .rejects.toThrow(/LLM provider|requires.*provider/i);
  });

  it('vector → thoughtform should throw with clear LLM error', async () => {
    const id = 'ffffffff-ffff-4fff-afff-ffffffffffff';
    const embedding = Array.from({ length: 384 }, () => 0.1);
    await concepts.save({ id, embedding });

    await expect(conversions.convert(id, 'vector', 'thoughtform'))
      .rejects.toThrow(/LLM provider|requires.*provider/i);
  });

  it('should report LLM provider as "none"', () => {
    expect(conversions.getLLMProviderName()).toBe('none');
  });
});

describe('ConversionService — Round-trip', () => {
  beforeEach(() => {
    setupTestDb();
    concepts = new ConceptService();
    conversions = new ConversionService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should round-trip: save ThoughtForm → convert to markdown → convert to vector → search', async () => {
    const id = 'abababab-abab-4bab-abab-abababababab';
    const tf = makeThoughtForm(id);

    // Step 1: Save ThoughtForm
    await concepts.save({ id, thoughtform: tf, tags: ['physics'] });

    // Step 2: Convert to markdown
    await conversions.convert(id, 'thoughtform', 'markdown');
    const afterMd = await concepts.read(id);
    expect(afterMd.markdown).toContain('Albert Einstein');
    expect(afterMd.thoughtform).toBeDefined(); // still preserved

    // Step 3: Convert to vector (from markdown)
    await conversions.convert(id, 'markdown', 'vector');
    const afterVec = await concepts.read(id);
    expect(afterVec.embedding).toHaveLength(VECTOR_DIMENSION);
    expect(afterVec.markdown).toBeDefined(); // still preserved
    expect(afterVec.thoughtform).toBeDefined(); // still preserved

    // Step 4: Search should find it
    const { embeddingService } = await import('../src/services/embedding.service.js');
    const queryEmb = await embeddingService.embed('Einstein physicist relativity');
    const results = await concepts.search(queryEmb, 5);
    expect(results.length).toBeGreaterThan(0);

    // Verify representations
    const found = results.find(r => r.id === id);
    expect(found).toBeDefined();
    expect(found!.representations.vector).toBe(true);
    expect(found!.representations.markdown).toBe(true);
    expect(found!.representations.thoughtform).toBe(true);
    expect(found!.tags).toContain('physics');
  });
});
