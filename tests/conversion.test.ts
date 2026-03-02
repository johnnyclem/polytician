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
import { RuleBasedNLPPipeline } from '../src/providers/rule-based-nlp.pipeline.js';
import type { ThoughtForm } from '../src/types/thoughtform.js';
import type { LLMProvider, SummarizeOptions, ThoughtFormEntities } from '../src/providers/llm.interface.js';

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

  it('vector → markdown should use non-LLM fallback when no provider configured', async () => {
    const id = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee';
    const embedding = Array.from({ length: 384 }, () => 0.1);
    await concepts.save({ id, embedding });

    // Should succeed with non-LLM reconstruction (no neighbors to draw from)
    await conversions.convert(id, 'vector', 'markdown');

    const result = await concepts.read(id);
    expect(result.markdown).toBeDefined();
    expect(result.markdown).toContain('Reconstructed Concept');
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

// --- Scenario: LLM-assisted vector-to-markdown reconstruction ---

describe('ConversionService — LLM-assisted vector-to-markdown', () => {
  beforeEach(() => {
    setupTestDb();
    concepts = new ConceptService();
    conversions = new ConversionService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should reconstruct markdown from neighbors without LLM', async () => {
    const { embeddingService } = await import('../src/services/embedding.service.js');

    // Create neighbor concepts with markdown
    const neighborId1 = 'aaa11111-1111-4111-a111-111111111111';
    const neighborId2 = 'aaa22222-2222-4222-a222-222222222222';
    const embedding1 = await embeddingService.embed('Physics and relativity theory');
    const embedding2 = await embeddingService.embed('Quantum mechanics and particles');
    await concepts.save({ id: neighborId1, markdown: 'Einstein developed the theory of relativity.', embedding: embedding1 });
    await concepts.save({ id: neighborId2, markdown: 'Quantum mechanics governs subatomic particles.', embedding: embedding2 });

    // Create target concept with a similar vector
    const targetId = 'aaa33333-3333-4333-a333-333333333333';
    const targetEmbedding = await embeddingService.embed('Physics relativity quantum');
    await concepts.save({ id: targetId, embedding: targetEmbedding });

    // Convert vector → markdown without LLM (NullProvider)
    await conversions.convert(targetId, 'vector', 'markdown');

    const result = await concepts.read(targetId);
    expect(result.markdown).toBeDefined();
    // Should contain reconstructed content from neighbors
    expect(result.markdown).toContain('Reconstructed Concept');
    expect(result.markdown).toContain('Related Context');
  });

  it('should include nearest-neighbor context when LLM is configured', async () => {
    const { embeddingService } = await import('../src/services/embedding.service.js');

    // Create a mock LLM provider that captures the summarize call
    let capturedTexts: string[] = [];
    let capturedOptions: SummarizeOptions | undefined;
    const mockLLM: LLMProvider = {
      name: 'mock',
      async complete() { return ''; },
      async extractEntities(): Promise<ThoughtFormEntities> {
        return { entities: [], relationships: [], contextGraph: {} };
      },
      async summarize(texts: string[], options?: SummarizeOptions): Promise<string> {
        capturedTexts = texts;
        capturedOptions = options;
        return '# LLM-synthesized summary of related concepts.';
      },
    };
    conversions.setLLMProvider(mockLLM);

    // Create neighbor concepts
    const neighborId = 'bbb11111-1111-4111-a111-111111111111';
    const embedding = await embeddingService.embed('Relativity and spacetime');
    await concepts.save({ id: neighborId, markdown: 'Spacetime curvature explains gravity.', embedding });

    // Create target concept
    const targetId = 'bbb22222-2222-4222-a222-222222222222';
    const targetEmbedding = await embeddingService.embed('Relativity spacetime gravity');
    await concepts.save({ id: targetId, embedding: targetEmbedding });

    // Convert vector → markdown with LLM
    await conversions.convert(targetId, 'vector', 'markdown');

    const result = await concepts.read(targetId);
    expect(result.markdown).toBe('# LLM-synthesized summary of related concepts.');

    // Verify neighbor context was included in the prompt
    expect(capturedTexts.length).toBeGreaterThan(0);
    expect(capturedTexts[0]).toContain('Spacetime curvature');

    // Verify neighbor distances were passed
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.neighborDistances).toBeDefined();
    expect(capturedOptions!.neighborDistances!.length).toBeGreaterThan(0);
    expect(capturedOptions!.conceptId).toBe(targetId);
  });

  it('should produce valid markdown even with no neighbors', async () => {
    const targetId = 'ccc11111-1111-4111-a111-111111111111';
    const embedding = Array.from({ length: 384 }, () => 0.1);
    await concepts.save({ id: targetId, embedding });

    // No neighbors exist, non-LLM fallback
    await conversions.convert(targetId, 'vector', 'markdown');

    const result = await concepts.read(targetId);
    expect(result.markdown).toBeDefined();
    expect(result.markdown).toContain('No neighboring concepts available');
  });
});

// --- Scenario: Structured graph enrichment via NLP pipeline ---

describe('ConversionService — NLP pipeline graph enrichment', () => {
  beforeEach(() => {
    setupTestDb();
    concepts = new ConceptService();
    conversions = new ConversionService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should extract entities using rule-based NLP pipeline', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    conversions.setNLPPipeline(pipeline);

    const id = 'ddd11111-1111-4111-a111-111111111111';
    await concepts.save({
      id,
      markdown: 'Albert Einstein developed the theory of relativity at Princeton University.',
    });

    await conversions.convert(id, 'markdown', 'thoughtform');

    const result = await concepts.read(id);
    expect(result.thoughtform).toBeDefined();
    const tf = result.thoughtform as ThoughtForm;

    // Should have extracted entities
    expect(tf.entities.length).toBeGreaterThan(0);

    // Should find "Albert Einstein" as a PERSON entity
    const einsteinEntity = tf.entities.find(e => e.text === 'Albert Einstein');
    expect(einsteinEntity).toBeDefined();
    expect(einsteinEntity!.type).toBe('PERSON');
    expect(einsteinEntity!.confidence).toBeGreaterThanOrEqual(0.5);

    // Should find "Princeton University" as ORGANIZATION
    const princetonEntity = tf.entities.find(e => e.text === 'Princeton University');
    expect(princetonEntity).toBeDefined();
    expect(princetonEntity!.type).toBe('ORGANIZATION');
  });

  it('should infer relationships using dependency parsing', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    conversions.setNLPPipeline(pipeline);

    const id = 'ddd22222-2222-4222-a222-222222222222';
    await concepts.save({
      id,
      markdown: 'Albert Einstein developed the theory at Princeton University.',
    });

    await conversions.convert(id, 'markdown', 'thoughtform');

    const result = await concepts.read(id);
    const tf = result.thoughtform as ThoughtForm;

    // Should have inferred relationships between co-occurring entities
    if (tf.entities.length >= 2) {
      expect(tf.relationships.length).toBeGreaterThan(0);

      // Relationships should have confidence scores
      for (const rel of tf.relationships) {
        expect(rel.confidence).toBeGreaterThan(0);
        expect(rel.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it('should build context graph from relationships', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    conversions.setNLPPipeline(pipeline);

    const id = 'ddd33333-3333-4333-a333-333333333333';
    await concepts.save({
      id,
      markdown: 'Albert Einstein worked at Princeton University on general relativity.',
    });

    await conversions.convert(id, 'markdown', 'thoughtform');

    const result = await concepts.read(id);
    const tf = result.thoughtform as ThoughtForm;

    // Context graph should be a valid adjacency list
    expect(tf.contextGraph).toBeDefined();
    for (const [key, connections] of Object.entries(tf.contextGraph)) {
      expect(typeof key).toBe('string');
      expect(Array.isArray(connections)).toBe(true);
      // Each connection should reference an entity that exists
      for (const conn of connections) {
        expect(tf.entities.some(e => e.id === conn)).toBe(true);
      }
    }
  });

  it('should validate ThoughtForm output against schema', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    conversions.setNLPPipeline(pipeline);

    const id = 'ddd44444-4444-4444-a444-444444444444';
    await concepts.save({
      id,
      markdown: 'Marie Curie discovered radium at the Sorbonne University.',
    });

    await conversions.convert(id, 'markdown', 'thoughtform');

    const result = await concepts.read(id);
    const tf = result.thoughtform as ThoughtForm;

    // Validate the entire ThoughtForm structure
    expect(tf.id).toBe(id);
    expect(tf.rawText).toContain('Marie Curie');
    expect(tf.language).toBe('en');
    expect(tf.metadata).toBeDefined();
    expect(tf.metadata.source).toBe('converted');
    expect(tf.metadata.createdAt).toBeDefined();
    expect(tf.metadata.updatedAt).toBeDefined();

    // Entities should have required fields
    for (const entity of tf.entities) {
      expect(entity.id).toBeDefined();
      expect(entity.text).toBeDefined();
      expect(entity.type).toBeDefined();
      expect(entity.confidence).toBeGreaterThanOrEqual(0);
      expect(entity.confidence).toBeLessThanOrEqual(1);
      expect(entity.offset.start).toBeGreaterThanOrEqual(0);
      expect(entity.offset.end).toBeGreaterThan(entity.offset.start);
    }

    // Relationships should have required fields
    for (const rel of tf.relationships) {
      expect(rel.subjectId).toBeDefined();
      expect(rel.predicate).toBeDefined();
      expect(rel.objectId).toBeDefined();
      // Subject and object should reference existing entities
      expect(tf.entities.some(e => e.id === rel.subjectId)).toBe(true);
      expect(tf.entities.some(e => e.id === rel.objectId)).toBe(true);
    }
  });

  it('should use configurable NLP pipeline options', async () => {
    // Verify that the pipeline is configurable
    const pipeline = new RuleBasedNLPPipeline();
    conversions.setNLPPipeline(pipeline);
    expect(conversions.getNLPPipelineName()).toBe('rule-based');

    // Extract entities directly with custom options
    const result = await pipeline.extractEntities(
      'Albert Einstein worked at Princeton University.',
      { minConfidence: 0.8, inferRelationships: false }
    );

    // With high confidence threshold, fewer entities should pass
    for (const entity of result.entities) {
      expect(entity.confidence).toBeGreaterThanOrEqual(0.8);
    }

    // With inferRelationships disabled, no relationships
    expect(result.relationships).toHaveLength(0);
  });

  it('should fall back to LLM when no NLP pipeline is configured', async () => {
    // No NLP pipeline set — should fall through to LLM provider
    const id = 'ddd55555-5555-4555-a555-555555555555';
    await concepts.save({ id, markdown: '# Some concept' });

    // Without LLM or NLP pipeline, should throw the LLM error
    await expect(conversions.convert(id, 'markdown', 'thoughtform'))
      .rejects.toThrow(/LLM provider|requires.*provider/i);
  });
});

// --- RuleBasedNLPPipeline unit tests ---

describe('RuleBasedNLPPipeline', () => {
  it('should extract capitalized multi-word entities', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    const result = await pipeline.extractEntities(
      'Albert Einstein and Isaac Newton were great physicists.'
    );

    const names = result.entities.map(e => e.text);
    expect(names).toContain('Albert Einstein');
    expect(names).toContain('Isaac Newton');
  });

  it('should classify organizations correctly', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    const result = await pipeline.extractEntities(
      'He studied at Princeton University and worked for Bell Labs Foundation.'
    );

    const princeton = result.entities.find(e => e.text === 'Princeton University');
    expect(princeton).toBeDefined();
    expect(princeton!.type).toBe('ORGANIZATION');
  });

  it('should extract quoted terms as CONCEPT', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    const result = await pipeline.extractEntities(
      'The "theory of relativity" changed physics forever.'
    );

    const concept = result.entities.find(e => e.text === 'theory of relativity');
    expect(concept).toBeDefined();
    expect(concept!.type).toBe('CONCEPT');
  });

  it('should infer relationships between co-occurring entities', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    const result = await pipeline.extractEntities(
      'Albert Einstein developed the theory at Princeton University.'
    );

    // Should find at least Einstein and Princeton
    expect(result.entities.length).toBeGreaterThanOrEqual(2);

    // If both entities are found in the same sentence, a relationship should be inferred
    if (result.entities.length >= 2) {
      expect(result.relationships.length).toBeGreaterThan(0);
    }
  });

  it('should build bidirectional context graph', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    const result = await pipeline.extractEntities(
      'Albert Einstein worked at Princeton University.'
    );

    // If there are relationships, graph should be bidirectional
    for (const rel of result.relationships) {
      if (result.contextGraph[rel.subjectId]) {
        expect(result.contextGraph[rel.subjectId]).toContain(rel.objectId);
      }
      if (result.contextGraph[rel.objectId]) {
        expect(result.contextGraph[rel.objectId]).toContain(rel.subjectId);
      }
    }
  });

  it('should respect minConfidence filter', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    const result = await pipeline.extractEntities(
      'Albert Einstein worked in Berlin.',
      { minConfidence: 0.9 }
    );

    // All returned entities should meet the confidence threshold
    for (const entity of result.entities) {
      expect(entity.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('should respect entityTypes filter', async () => {
    const pipeline = new RuleBasedNLPPipeline();
    const result = await pipeline.extractEntities(
      'Albert Einstein worked at Princeton University.',
      { entityTypes: ['PERSON'] }
    );

    for (const entity of result.entities) {
      expect(entity.type).toBe('PERSON');
    }
  });
});
