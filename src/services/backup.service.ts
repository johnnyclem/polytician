import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAdapter } from '../db/client.js';
import { getConfig } from '../config.js';
import { conceptEventBus } from '../events/concept-events.js';
import { logger } from '../logger.js';

const SAVE_COUNTER_KEY = 'backup_save_counter';

/**
 * Auto-backup service that serializes the concept store to a JSON file
 * after a configurable number of saves (default: 50).
 *
 * The save counter is persisted in the database metadata table so it
 * survives restarts. When the threshold is reached the counter resets
 * and a timestamped backup file is written to `{dataDir}/backups/`.
 */
export class BackupService {
  private listening = false;
  private readonly onCreated = (): void => { this.incrementAndCheck(); };
  private readonly onUpdated = (): void => { this.incrementAndCheck(); };

  start(): void {
    if (this.listening) return;
    this.listening = true;
    conceptEventBus.on('concept.created', this.onCreated);
    conceptEventBus.on('concept.updated', this.onUpdated);
    logger.debug('backup-service started');
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    conceptEventBus.off('concept.created', this.onCreated);
    conceptEventBus.off('concept.updated', this.onUpdated);
    logger.debug('backup-service stopped');
  }

  /** Read the current save counter from the database. */
  async getCounter(): Promise<number> {
    const adapter = getAdapter();
    const raw = await adapter.getMetadata(SAVE_COUNTER_KEY);
    return raw !== null ? parseInt(raw, 10) || 0 : 0;
  }

  /** Reset the save counter to zero. */
  async resetCounter(): Promise<void> {
    const adapter = getAdapter();
    await adapter.setMetadata(SAVE_COUNTER_KEY, '0');
  }

  /** Increment the counter and trigger backup if threshold is reached. */
  private incrementAndCheck(): void {
    this.incrementAndCheckAsync().catch((err: unknown) => {
      logger.error('backup-service increment failed', err);
    });
  }

  private async incrementAndCheckAsync(): Promise<void> {
    const config = getConfig();
    const threshold = config.backup.threshold;

    // Threshold of 0 disables auto-backup
    if (threshold <= 0) return;

    const adapter = getAdapter();
    const current = await this.getCounter();
    const next = current + 1;

    if (next >= threshold) {
      await adapter.setMetadata(SAVE_COUNTER_KEY, '0');
      await this.runBackup();
    } else {
      await adapter.setMetadata(SAVE_COUNTER_KEY, String(next));
    }
  }

  /** Serialize all concepts to a timestamped JSON backup file. */
  async runBackup(): Promise<string> {
    const config = getConfig();
    const adapter = getAdapter();

    const backupDir = join(config.dataDir, 'backups');
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }

    // Fetch all concepts (paginated)
    const allConcepts: Record<string, unknown>[] = [];
    let offset = 0;
    const pageSize = 200;
    let hasMore = true;

    while (hasMore) {
      const page = await adapter.listConcepts({
        limit: pageSize,
        offset,
      });
      for (const row of page.rows) {
        const full = await adapter.findConcept(row.id);
        if (full) {
          allConcepts.push({
            id: full.id,
            namespace: full.namespace,
            version: full.version,
            created_at: full.created_at,
            updated_at: full.updated_at,
            tags: full.tags,
            markdown: full.markdown,
            thoughtform: full.thoughtform,
          });
        }
      }
      offset += pageSize;
      hasMore = page.rows.length === pageSize;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.json`;
    const filepath = join(backupDir, filename);

    const payload = {
      version: '1.0',
      createdAt: new Date().toISOString(),
      conceptCount: allConcepts.length,
      concepts: allConcepts,
    };

    writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8');

    logger.info('backup-service backup created', {
      filepath,
      conceptCount: allConcepts.length,
    });

    return filepath;
  }
}

export const backupService = new BackupService();
