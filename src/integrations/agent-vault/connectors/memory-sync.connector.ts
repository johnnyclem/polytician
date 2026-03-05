import type { AgentVaultConfig } from '../config.js';
import type { AVMemoryEntry } from '../types.js';
import { MemoryRepoClient } from '../client/memory-repo-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { logger } from '../../../logger.js';

/**
 * Bidirectional sync between Polytician concepts and AgentVault memory_repo.
 *
 * Push: Polytician -> memory_repo (on concept events)
 * Pull: memory_repo -> Polytician (on startup and optional timer)
 * Conflict: last-write-wins by updatedAt timestamp
 */
export class MemorySyncConnector {
  private readonly client: MemoryRepoClient;
  private readonly direction: 'push' | 'pull' | 'bidirectional';
  private pullTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentVaultConfig) {
    this.client = new MemoryRepoClient(config);
    this.direction = config.sync.direction;
    const pullIntervalMs = config.sync.pullIntervalMs;

    if (pullIntervalMs > 0 && this.direction !== 'push') {
      this.pullTimer = setInterval(() => {
        this.pullAll().catch((err: unknown) => {
          logger.error('av-sync periodic pull failed', err);
        });
      }, pullIntervalMs);
    }
  }

  stop(): void {
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
  }

  async pushConcept(conceptId: string): Promise<void> {
    if (this.direction === 'pull') return;
    try {
      const concept = await conceptService.read(conceptId);
      const entries: AVMemoryEntry[] = [];

      if (concept.markdown) {
        entries.push({
          key: `concepts/${conceptId}/markdown`,
          contentType: 'markdown',
          data: concept.markdown,
          tags: concept.tags ?? [],
          metadata: {
            conceptId,
            namespace: concept.namespace ?? 'default',
            version: concept.version,
            updatedAt: concept.updatedAt,
          },
        });
      }

      if (concept.thoughtform) {
        entries.push({
          key: `concepts/${conceptId}/thoughtform`,
          contentType: 'json',
          data: JSON.stringify(concept.thoughtform),
          tags: concept.tags ?? [],
          metadata: {
            conceptId,
            namespace: concept.namespace ?? 'default',
            version: concept.version,
            updatedAt: concept.updatedAt,
          },
        });
      }

      if (entries.length > 0) {
        await this.client.commit(
          `polytician: upsert concept ${conceptId}`,
          entries
        );
        logger.debug('av-sync pushed concept', { conceptId, entryCount: entries.length });
      }
    } catch (err) {
      logger.error('av-sync push failed', err, { conceptId });
    }
  }

  async deleteConcept(conceptId: string): Promise<void> {
    if (this.direction === 'pull') return;
    try {
      await this.client.tombstone(`concepts/${conceptId}/markdown`);
      await this.client.tombstone(`concepts/${conceptId}/thoughtform`);
      logger.debug('av-sync tombstoned concept', { conceptId });
    } catch (err) {
      logger.error('av-sync tombstone failed', err, { conceptId });
    }
  }

  async pullAll(): Promise<void> {
    if (this.direction === 'push') return;
    try {
      const branchState = await this.client.getBranchState();
      const markdownEntries = branchState.entries.filter(
        e => e.key.startsWith('concepts/') && e.key.endsWith('/markdown')
      );

      for (const entry of markdownEntries) {
        const conceptId = entry.key.split('/')[1];
        if (!conceptId) continue;
        const remoteUpdatedAt = entry.metadata['updatedAt'] as number | undefined;

        try {
          const existing = await conceptService.read(conceptId).catch(() => null);
          if (
            existing &&
            remoteUpdatedAt !== undefined &&
            existing.updatedAt >= remoteUpdatedAt
          ) {
            continue;
          }

          await conceptService.save({
            id: conceptId,
            markdown: entry.data,
            tags: entry.tags,
          });
          logger.debug('av-sync pulled concept', { conceptId });
        } catch (err) {
          logger.error('av-sync pull item failed', err, { conceptId });
        }
      }
    } catch (err) {
      logger.error('av-sync pull all failed', err);
    }
  }
}
