import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// Mock @xenova/transformers to avoid downloading a model in tests
vi.mock('@xenova/transformers', () => {
  const mockPipeline = async (text: string, _options?: Record<string, unknown>) => {
    // Generate a deterministic pseudo-embedding from the text
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
      data[i] = Math.sin(hash + i) * 0.5;
    }
    // Normalize
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

// Must import after mock setup
const { EmbeddingService } = await import('../src/services/embedding.service.js');

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    service = new EmbeddingService();
  });

  it('should return an embedding with the correct dimension', async () => {
    const embedding = await service.embed('hello world');
    expect(embedding).toHaveLength(VECTOR_DIMENSION);
  });

  it('should return an array of numbers', async () => {
    const embedding = await service.embed('test text');
    expect(embedding.every(v => typeof v === 'number')).toBe(true);
  });

  it('should return normalized vectors (unit length)', async () => {
    const embedding = await service.embed('some text to embed');
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 3);
  });

  it('should produce different embeddings for different texts', async () => {
    const emb1 = await service.embed('quantum physics');
    const emb2 = await service.embed('renaissance painting');
    // At least some values should differ
    const allSame = emb1.every((v, i) => Math.abs(v - emb2[i]!) < 0.0001);
    expect(allSame).toBe(false);
  });

  it('should produce identical embeddings for identical texts', async () => {
    const emb1 = await service.embed('deterministic test');
    const emb2 = await service.embed('deterministic test');
    expect(emb1).toEqual(emb2);
  });

  it('should report dimension correctly', () => {
    const service = new EmbeddingService();
    expect(service.getDimension()).toBe(VECTOR_DIMENSION);
  });
});
