import { VECTOR_DIMENSION } from '../types/concept.js';
import { getConfig } from '../config.js';

type FeatureExtractor = (
  text: string,
  options?: Record<string, unknown>
) => Promise<{ data: ArrayLike<number> }>;

let pipelineFn: FeatureExtractor | null = null;
let loading: Promise<FeatureExtractor> | null = null;

/**
 * Load the configured model once. Concurrent callers share one attempt; a
 * failed attempt (say, the first download while offline) is not cached, so
 * the next call tries again instead of failing until restart.
 */
async function loadModel(): Promise<FeatureExtractor> {
  if (pipelineFn) return pipelineFn;
  loading ??= (async (): Promise<FeatureExtractor> => {
    const { pipeline, env } = await import('@huggingface/transformers');
    const config = getConfig();
    env.cacheDir = config.modelsDir;
    // q8 is the quantized ONNX export (model_quantized.onnx), as 2.x loaded.
    const extractor = await pipeline('feature-extraction', config.embeddingModel, {
      dtype: 'q8',
    });
    return extractor as unknown as FeatureExtractor;
  })();
  try {
    pipelineFn = await loading;
    return pipelineFn;
  } finally {
    loading = null;
  }
}

export class EmbeddingService {
  /**
   * Mean-pooled, normalized embedding of `text`. The vector index stores
   * VECTOR_DIMENSION components, so a model with any other output size is an
   * error rather than a silently truncated vector.
   */
  async embed(text: string): Promise<number[]> {
    const extract = await loadModel();
    const output = await extract(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data);

    if (embedding.length !== VECTOR_DIMENSION) {
      throw new Error(
        `Embedding model ${getConfig().embeddingModel} produces ${embedding.length}-dimensional vectors; polytician stores ${VECTOR_DIMENSION}-dimensional vectors, so choose a ${VECTOR_DIMENSION}-dimensional model`
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

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(text => this.embed(text)));
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

  /** The model id recorded with every vector this service produces. */
  getModel(): string {
    return getConfig().embeddingModel;
  }
}

export const embeddingService = new EmbeddingService();
