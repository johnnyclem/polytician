import {
  conceptEventBus,
  type ConceptCreatedPayload,
  type ConceptUpdatedPayload,
  type ConceptDeletedPayload,
} from '../events/concept-events.js';
import { getAdapter } from '../db/client.js';
import { rebuildFaissIndex } from '../sidecar/faiss.js';
import { logger } from '../logger.js';
import { serializeEmbedding } from '../db/embedding-codec.js';

type PendingUpdate = () => void | Promise<void>;

/**
 * IndexSyncService processes vector index updates asynchronously via the
 * concept event bus.
 *
 * In a single-node deployment the local sqlite-vec table is updated by
 * ConceptService already; IndexSyncService serves as an additional
 * asynchronous reconciliation layer.
 *
 * In a distributed deployment each node runs its own IndexSyncService and
 * subscribes to events forwarded from the shared message broker.  Nodes
 * that do not own the primary write path still receive events and keep their
 * local (or shared) vector index consistent.
 *
 * Behaviour:
 * - Updates are batched with setImmediate so that a burst of concept writes
 *   does not block the event loop.
 * - Call `waitForPending()` in tests or health checks to confirm all queued
 *   updates have been flushed.
 */
export class IndexSyncService {
  private pendingUpdates: PendingUpdate[] = [];
  private processing = false;
  private started = false;

  private readonly onCreated = (payload: ConceptCreatedPayload): void => {
    this.enqueue(() => this.syncVector(payload.conceptId, payload.embedding));
  };

  private readonly onUpdated = (payload: ConceptUpdatedPayload): void => {
    this.enqueue(() => this.syncVector(payload.conceptId, payload.embedding));
  };

  private readonly onDeleted = (payload: ConceptDeletedPayload): void => {
    this.enqueue(() => this.removeVector(payload.conceptId));
  };

  /** Attach listeners to the event bus. Idempotent – safe to call multiple times. */
  start(): void {
    if (this.started) return;
    this.started = true;
    conceptEventBus.on('concept.created', this.onCreated);
    conceptEventBus.on('concept.updated', this.onUpdated);
    conceptEventBus.on('concept.deleted', this.onDeleted);
  }

  /** Detach listeners. Call during graceful shutdown. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    conceptEventBus.off('concept.created', this.onCreated);
    conceptEventBus.off('concept.updated', this.onUpdated);
    conceptEventBus.off('concept.deleted', this.onDeleted);
  }

  /**
   * Returns a Promise that resolves once all currently pending index updates
   * have been processed.  Useful in tests and health-check endpoints to
   * confirm the vector index is up to date.
   */
  waitForPending(): Promise<void> {
    if (this.pendingUpdates.length === 0 && !this.processing) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      setImmediate(() => {
        this.waitForPending().then(resolve).catch(resolve);
      });
    });
  }

  /** Number of updates waiting to be applied. */
  get pendingCount(): number {
    return this.pendingUpdates.length;
  }

  private enqueue(update: PendingUpdate): void {
    this.pendingUpdates.push(update);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.processing) return;
    this.processing = true;
    setImmediate(() => {
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    const batch = this.pendingUpdates.splice(0);

    for (const update of batch) {
      try {
        // Await so async adapters (Postgres) cannot leak unhandled rejections.
        await update();
      } catch {
        // Errors are swallowed at this layer; in production, emit a dead-letter
        // event or forward to an observability sink.
      }
    }

    this.processing = false;

    // If more items were enqueued while flushing, schedule another pass.
    if (this.pendingUpdates.length > 0) {
      this.scheduleFlush();
    }
  }

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

  private async syncVector(conceptId: string, embedding: number[] | null): Promise<void> {
    if (!embedding) return;
    const adapter = getAdapter();
    const buf = serializeEmbedding(embedding);
    await adapter.upsertVector(conceptId, buf);
  }

  private async removeVector(conceptId: string): Promise<void> {
    const adapter = getAdapter();
    await adapter.deleteVector(conceptId);
  }
}

export const indexSyncService = new IndexSyncService();
