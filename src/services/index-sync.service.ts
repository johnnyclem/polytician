import { rebuildFaissIndex } from '../sidecar/faiss.js';
import { logger } from '../logger.js';

/**
 * IndexSyncService keeps the optional Python sidecar's FAISS index in step
 * after a bulk restore.
 *
 * The local vector index (sqlite-vec / pgvector) needs no syncing: since 3.0,
 * ConceptService writes each concept row and its vector in one transaction.
 * The event-driven re-sync that 2.x ran here (POLYTICIAN_ASYNC_INDEX_SYNC)
 * was removed because it re-wrote vectors outside that transaction and could
 * resurrect the vector of a concept deleted in the meantime.
 */
export class IndexSyncService {
  /**
   * Trigger a FAISS index rebuild on the Python sidecar after deserialization.
   *
   * Call this after batch-upserting restored ThoughtForms so the sidecar's
   * in-memory FAISS index contains the new vectors.  The method is async and
   * can be awaited to confirm the rebuild completed, but errors are logged
   * rather than propagated so deserialization is not blocked by sidecar
   * availability.
   */
  async rebuildAfterDeserialize(entries: Array<{ id: string; text: string }>): Promise<void> {
    if (entries.length === 0) return;

    const ids = entries.map(e => e.id);
    const texts = entries.map(e => e.text);

    try {
      await rebuildFaissIndex({ ids, texts });
    } catch (err) {
      logger.error('faiss rebuild after deserialize failed', err, {
        idCount: ids.length,
      });
    }
  }
}

export const indexSyncService = new IndexSyncService();
