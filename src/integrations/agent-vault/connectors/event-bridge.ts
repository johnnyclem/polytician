import {
  conceptEventBus,
  type ConceptCreatedPayload,
  type ConceptUpdatedPayload,
  type ConceptDeletedPayload,
} from '../../../events/concept-events.js';
import type { AgentVaultConfig } from '../config.js';
import { MemorySyncConnector } from './memory-sync.connector.js';
import { ArchivalConnector } from './archival.connector.js';
import { logger } from '../../../logger.js';

/**
 * Wires conceptEventBus to AgentVault sync and archival connectors.
 * Follows IndexSyncService's start/stop lifecycle pattern.
 */
export class AgentVaultEventBridge {
  private readonly syncConnector: MemorySyncConnector | null;
  private readonly archivalConnector: ArchivalConnector | null;
  private started = false;

  constructor(config: AgentVaultConfig) {
    this.syncConnector = config.sync.enabled ? new MemorySyncConnector(config) : null;
    this.archivalConnector = config.archival.enabled ? new ArchivalConnector(config) : null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    conceptEventBus.on('concept.created', this.onCreated);
    conceptEventBus.on('concept.updated', this.onUpdated);
    conceptEventBus.on('concept.deleted', this.onDeleted);
    logger.info('av-event-bridge started', {
      sync: this.syncConnector !== null,
      archival: this.archivalConnector !== null,
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    conceptEventBus.off('concept.created', this.onCreated);
    conceptEventBus.off('concept.updated', this.onUpdated);
    conceptEventBus.off('concept.deleted', this.onDeleted);
    this.syncConnector?.stop();
    logger.info('av-event-bridge stopped');
  }

  async initialPull(): Promise<void> {
    await this.syncConnector?.pullAll();
  }

  private readonly onCreated = (payload: ConceptCreatedPayload): void => {
    this.syncConnector?.pushConcept(payload.conceptId).catch(() => {});
    this.archivalConnector?.scheduleArchive(payload.conceptId);
  };

  private readonly onUpdated = (payload: ConceptUpdatedPayload): void => {
    this.syncConnector?.pushConcept(payload.conceptId).catch(() => {});
    this.archivalConnector?.scheduleArchive(payload.conceptId);
  };

  private readonly onDeleted = (payload: ConceptDeletedPayload): void => {
    this.syncConnector?.deleteConcept(payload.conceptId).catch(() => {});
    this.archivalConnector?.cancelPending(payload.conceptId);
  };
}
