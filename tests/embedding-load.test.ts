import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

// The model loader is driven per test: `loadModel` decides what pipeline() does.
const state = vi.hoisted(() => ({
  loadModel: async (): Promise<unknown> => {
    throw new Error('not set');
  },
  loads: 0,
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => {
    state.loads++;
    return state.loadModel();
  }),
  env: { cacheDir: '' },
}));

function unitVector(dimension: number): Float32Array {
  const data = new Float32Array(dimension);
  data[0] = 1;
  return data;
}

async function freshService(): Promise<
  InstanceType<typeof import('../src/services/embedding.service.js').EmbeddingService>
> {
  vi.resetModules();
  const { EmbeddingService } = await import('../src/services/embedding.service.js');
  return new EmbeddingService();
}

describe('EmbeddingService model loading', () => {
  beforeEach(() => {
    state.loads = 0;
  });

  it('retries the model load after a failed first load instead of caching the failure', async () => {
    // First start offline: the download fails. The network then comes back.
    let online = false;
    state.loadModel = async () => {
      if (!online) throw new Error('fetch failed: ENOTFOUND huggingface.co');
      return async () => ({ data: unitVector(VECTOR_DIMENSION) });
    };
    const service = await freshService();

    await expect(service.embed('first')).rejects.toThrow(/ENOTFOUND/);
    online = true;
    await expect(service.embed('second')).resolves.toHaveLength(VECTOR_DIMENSION);
    expect(state.loads).toBe(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    state.loadModel = async () => async () => ({ data: unitVector(VECTOR_DIMENSION) });
    const service = await freshService();
    await Promise.all([service.embed('a'), service.embed('b'), service.embed('c')]);
    expect(state.loads).toBe(1);
  });

  it('rejects a model whose vectors are not 384-dimensional instead of truncating them', async () => {
    // e.g. POLYTICIAN_EMBEDDING_MODEL pointed at a 768-d model
    state.loadModel = async () => async () => ({ data: unitVector(768) });
    const service = await freshService();
    await expect(service.embed('text')).rejects.toThrow(/768.*384|384.*768/);
  });
});
