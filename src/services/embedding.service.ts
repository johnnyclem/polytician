import { VECTOR_DIMENSION } from '../types/concept.js';
import { getConfig } from '../config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineFn: ((text: string, options?: Record<string, unknown>) => Promise<any>) | null = null;
let loading: Promise<void> | null = null;

async function loadModel(): Promise<void> {
  if (pipelineFn) return;
  if (loading) {
    await loading;
    return;
  }

  loading = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    const config = getConfig();
    env.cacheDir = config.modelsDir;

    pipelineFn = (await pipeline('feature-extraction', config.embeddingModel, {
      quantized: true,
    })) as unknown as (
      text: string,
      options?: Record<string, unknown>
    ) => Promise<{ data: Float32Array }>;
  })();

  await loading;
}

export class EmbeddingService {
  async embed(text: string): Promise<number[]> {
    await loadModel();
    if (!pipelineFn) throw new Error('Embedding model failed to load');

    const output = await pipelineFn(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data as Float32Array).slice(0, VECTOR_DIMENSION);

    if (embedding.length !== VECTOR_DIMENSION) {
      throw new Error(
        `Embedding dimension mismatch: expected ${VECTOR_DIMENSION}, got ${embedding.length}`
      );
    }

    return embedding;
  }

  /**
   * Generate embeddings for multiple texts in batches.
   * Processes texts concurrently within each batch to maximize throughput
   * while controlling memory usage.
   */
  async embedBatch(texts: string[], batchSize: number = 50): Promise<number[][]> {
    await loadModel();
    if (!pipelineFn) throw new Error('Embedding model failed to load');

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(text => this.embed(text))
      );
      results.push(...batchResults);
    }

    return results;
  }

  async isLoaded(): Promise<boolean> {
    return pipelineFn !== null;
  }

  getDimension(): number {
    return VECTOR_DIMENSION;
  }
}

export const embeddingService = new EmbeddingService();
