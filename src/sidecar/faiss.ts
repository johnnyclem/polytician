import { getConfig } from '../config.js';
import { logger } from '../logger.js';

export interface RebuildIndexRequest {
  ids: string[];
  texts: string[];
}

export interface RebuildIndexResponse {
  status: string;
  indexed_ids: string[];
  total_vectors: number;
  dimension: number;
}

const REBUILD_TIMEOUT_MS = 30_000;

/**
 * Trigger a FAISS index rebuild on the Python sidecar for the given
 * ThoughtForm IDs and their associated texts.
 *
 * The sidecar generates embeddings for each text and upserts the resulting
 * vectors into its in-memory FAISS index so they become searchable
 * immediately after deserialization.
 *
 * Returns null when the sidecar is not configured, allowing callers to
 * treat it as a best-effort operation.
 */
export async function rebuildFaissIndex(
  req: RebuildIndexRequest,
): Promise<RebuildIndexResponse | null> {
  const { sidecarUrl } = getConfig();

  if (!sidecarUrl) {
    logger.debug('faiss rebuild skipped: sidecar not configured');
    return null;
  }

  if (req.ids.length === 0) {
    logger.debug('faiss rebuild skipped: empty id list');
    return null;
  }

  if (req.ids.length !== req.texts.length) {
    throw new Error('ids and texts must have the same length');
  }

  const url = `${sidecarUrl}/rebuild-index`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REBUILD_TIMEOUT_MS);

  try {
    logger.info('faiss rebuild requested', {
      idCount: req.ids.length,
      url,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: req.ids, texts: req.texts }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sidecar rebuild-index returned HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as RebuildIndexResponse;

    logger.info('faiss rebuild complete', {
      indexedCount: data.indexed_ids.length,
      totalVectors: data.total_vectors,
    });

    return data;
  } catch (err) {
    logger.error('faiss rebuild failed', err);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
