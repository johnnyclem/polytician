import { z } from 'zod';
import type { AgentVaultConfig } from '../config.js';
import type { AVMemoryEntry } from '../types.js';
import { MemoryRepoClient } from '../client/memory-repo-client.js';
import { conceptService } from '../../../services/concept.service.js';
import { isNamespaceAllowed } from '../../../services/namespace-policy.js';
import { NAMESPACE_PATTERN } from '../../../types/limits.js';
import { PolyticianError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';

const ConceptIdSchema = z.string().uuid();
const PREFIX = 'concepts/';
const SUFFIX = '/markdown';

export interface PullReport {
  imported: string[];
  skipped: Array<{ key: string; reason: string }>;
}

export interface PullTarget {
  /**
   * Pull into this namespace only: entries recorded for another namespace
   * are skipped. Without it, each entry goes to the namespace recorded in its
   * metadata ('default' if none).
   */
  namespace?: string;
  /** Namespaces the caller may write (default: the POLYTICIAN_NAMESPACES allowlist); others are skipped. */
  allowNamespace?: (namespace: string) => boolean;
}

/**
 * Apply memory_repo `concepts/<id>/markdown` entries to local concepts,
 * last write wins: an entry replaces a local concept only if its
 * metadata.updatedAt is newer than the local updatedAt, and never across
 * namespaces. Ids must be UUIDs. The vector is re-derived from the pulled
 * markdown so pulled concepts are searchable. Shared by the event bridge's
 * pull and the vault_memory_pull tool.
 */
export async function applyPulledEntries(
  entries: AVMemoryEntry[],
  target: PullTarget = {}
): Promise<PullReport> {
  const report: PullReport = { imported: [], skipped: [] };
  const allow = target.allowNamespace ?? isNamespaceAllowed;
  for (const entry of entries) {
    if (!entry.key.startsWith(PREFIX) || !entry.key.endsWith(SUFFIX)) continue;
    const skip = (reason: string): void => {
      report.skipped.push({ key: entry.key, reason });
    };
    const id = entry.key.slice(PREFIX.length, -SUFFIX.length);
    if (!ConceptIdSchema.safeParse(id).success) {
      skip('invalid-id');
      continue;
    }

    const recorded = entry.metadata['namespace'];
    const remoteNamespace = typeof recorded === 'string' ? recorded : undefined;
    if (target.namespace !== undefined && remoteNamespace !== undefined) {
      if (remoteNamespace !== target.namespace) {
        skip('other-namespace');
        continue;
      }
    }
    const namespace = target.namespace ?? remoteNamespace ?? 'default';
    if (!NAMESPACE_PATTERN.test(namespace)) {
      skip('invalid-namespace');
      continue;
    }
    if (!allow(namespace)) {
      skip('namespace-not-allowed');
      continue;
    }

    const rawUpdatedAt = entry.metadata['updatedAt'];
    const remoteUpdatedAt =
      typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : undefined;

    try {
      const existing = await conceptService.read(id).catch(() => null);
      if (existing) {
        if (existing.namespace !== namespace) {
          skip('other-namespace');
          continue;
        }
        // Without a remote timestamp the entry cannot be ordered against the
        // local copy, so it never replaces one.
        if (remoteUpdatedAt === undefined) {
          skip('no-updatedAt');
          continue;
        }
        if ((existing.updatedAt ?? 0) >= remoteUpdatedAt) {
          skip('local-newer');
          continue;
        }
      }
      await conceptService.save({
        id,
        namespace,
        markdown: entry.data,
        tags: entry.tags,
        // Guards against a local write between our read and this save.
        expectedVersion: existing?.version,
        autoEmbed: true,
      });
      report.imported.push(id);
    } catch (err) {
      skip(err instanceof PolyticianError ? err.code : 'error');
    }
  }
  return report;
}

/**
 * Bidirectional sync between Polytician concepts and AgentVault memory_repo.
 *
 * Push: Polytician -> memory_repo (on concept events)
 * Pull: memory_repo -> Polytician (on startup and optional timer)
 * Conflict: last-write-wins by updatedAt timestamp (see applyPulledEntries)
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
        await this.client.commit(`polytician: upsert concept ${conceptId}`, entries);
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

  async pullAll(): Promise<PullReport | null> {
    if (this.direction === 'push') return null;
    try {
      const branchState = await this.client.getBranchState();
      const report = await applyPulledEntries(branchState.entries);
      logger.info('av-sync pulled', {
        imported: report.imported.length,
        skipped: report.skipped.length,
      });
      return report;
    } catch (err) {
      logger.error('av-sync pull all failed', err);
      return null;
    }
  }
}
