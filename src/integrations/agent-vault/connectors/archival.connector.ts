import type { AgentVaultConfig } from '../config.js';
import { ArweaveUploadClient } from '../client/arweave-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { logger } from '../../../logger.js';

/**
 * Archives Polytician concepts to Arweave via AgentVault.
 * Debounced per-concept to prevent rapid-fire saves from triggering
 * individual Arweave transactions.
 */
export class ArchivalConnector {
  private readonly client: ArweaveUploadClient;
  private readonly tagFilter: string[];
  private readonly debounceMs: number;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: AgentVaultConfig) {
    this.client = new ArweaveUploadClient(config);
    this.tagFilter = config.archival.tagFilter;
    this.debounceMs = config.archival.debounceMs;
  }

  scheduleArchive(conceptId: string): void {
    const existing = this.pending.get(conceptId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(conceptId);
      this.archiveConcept(conceptId).catch((err: unknown) => {
        logger.error('av-archive async failed', err, { conceptId });
      });
    }, this.debounceMs);

    this.pending.set(conceptId, timer);
  }

  cancelPending(conceptId: string): void {
    const timer = this.pending.get(conceptId);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(conceptId);
    }
  }

  private async archiveConcept(conceptId: string): Promise<void> {
    try {
      const concept = await conceptService.read(conceptId);

      if (this.tagFilter.length > 0) {
        const conceptTags = concept.tags ?? [];
        const passes = this.tagFilter.every(t => conceptTags.includes(t));
        if (!passes) return;
      }

      const content = concept.markdown ?? JSON.stringify(concept.thoughtform);
      if (!content) return;

      const receipt = await this.client.upload({
        content,
        contentType: concept.markdown ? 'markdown' : 'json',
        tags: concept.tags ?? [],
        metadata: {
          conceptId,
          namespace: concept.namespace ?? 'default',
          version: concept.version,
          archivedAt: Date.now(),
        },
      });

      logger.info('av-archive concept archived', {
        conceptId,
        txId: receipt.txId,
        url: receipt.url,
        sizeBytes: receipt.size,
      });
    } catch (err) {
      logger.error('av-archive failed', err, { conceptId });
    }
  }
}
