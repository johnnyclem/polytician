/**
 * PolyVault end-to-end backup/restore orchestration.
 *
 * Wires the CLI backup/restore commands with:
 * - SQLite upsert (restore: write ThoughtForms to local concepts table)
 * - FAISS rebuild (restore: trigger sidecar to rebuild vector index)
 * - SQLite read (backup: read ThoughtForms from local concepts table)
 *
 * This module is the "PR11" integration layer that turns the individual
 * pipeline stages into a complete, idempotent backup/restore cycle.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { runBackup, type BackupOptions, type BackupResult } from './backup.js';
import { runRestore, type RestoreOptions, type RestoreResult } from './restore.js';
import { upsertThoughtforms, type UpsertResult } from '../../storage/sqlite-upsert.js';
import type { FaissRebuildClient, FaissRebuildMode, FaissRebuildResult } from '../../lib/polyvault/faiss-client.js';
import type { DatabaseAdapter } from '../../db/adapter.js';
import type { CanisterClient } from '../../lib/polyvault/upload.js';
import type { RestoreClient } from '../../lib/polyvault/download.js';
import type { ThoughtFormV1 } from '../../schemas/thoughtform.js';

// --- E2E Restore ---

export interface RestoreE2EOptions extends RestoreOptions {
  /** FAISS rebuild mode: 'replace' for full, 'upsert' for incremental. */
  faissMode: FaissRebuildMode;
}

export interface RestoreE2EResult {
  restore: RestoreResult;
  upsert: UpsertResult | null;
  faiss: FaissRebuildResult | null;
}

/**
 * End-to-end restore: fetch from canister → write JSON → upsert SQLite → rebuild FAISS.
 *
 * Steps:
 * 1. Run the restore pipeline (fetch commits/chunks, reassemble, decrypt, decompress).
 * 2. Read the restored ThoughtForms from the output file.
 * 3. Upsert into the local SQLite concepts table (idempotent, local-first).
 * 4. Trigger FAISS index rebuild via the Python sidecar.
 */
export async function runRestoreE2E(
  client: RestoreClient,
  db: DatabaseAdapter,
  faissClient: FaissRebuildClient | null,
  options: RestoreE2EOptions,
): Promise<{ result: RestoreE2EResult; exitCode: number }> {
  // Step 1: Run restore pipeline
  const { result: restoreResult, exitCode } = await runRestore(client, options);

  if (exitCode !== 0 || restoreResult.status === 'error') {
    return {
      result: { restore: restoreResult, upsert: null, faiss: null },
      exitCode,
    };
  }

  // Empty restore — no work to do
  if (restoreResult.status === 'empty' || restoreResult.thoughtformCount === 0) {
    return {
      result: { restore: restoreResult, upsert: null, faiss: null },
      exitCode: 0,
    };
  }

  // Step 2: Read restored ThoughtForms from output file
  let thoughtforms: ThoughtFormV1[];
  try {
    const text = readFileSync(options.to, 'utf-8');
    thoughtforms = JSON.parse(text) as ThoughtFormV1[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        restore: restoreResult,
        upsert: null,
        faiss: null,
        ...({ error: `Failed to read restored file: ${message}` } as Record<string, unknown>),
      } as RestoreE2EResult,
      exitCode: 2,
    };
  }

  // Step 3: Upsert into SQLite
  let upsertResult: UpsertResult;
  try {
    upsertResult = await upsertThoughtforms(db, thoughtforms);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        restore: restoreResult,
        upsert: null,
        faiss: null,
        ...({ error: `SQLite upsert failed: ${message}` } as Record<string, unknown>),
      } as RestoreE2EResult,
      exitCode: 2,
    };
  }

  // Step 4: Rebuild FAISS index (optional — skip if no sidecar)
  let faissResult: FaissRebuildResult | null = null;
  if (faissClient) {
    try {
      faissResult = await faissClient.rebuildIndex(thoughtforms, options.faissMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        result: {
          restore: restoreResult,
          upsert: upsertResult,
          faiss: null,
          ...({ error: `FAISS rebuild failed: ${message}` } as Record<string, unknown>),
        } as RestoreE2EResult,
        exitCode: 4,
      };
    }
  }

  return {
    result: { restore: restoreResult, upsert: upsertResult, faiss: faissResult },
    exitCode: 0,
  };
}

// --- E2E Backup ---

export interface BackupE2EOptions extends BackupOptions {
  /** Namespace filter for reading concepts from SQLite. */
  namespace?: string;
  /** Tags filter for reading concepts from SQLite. */
  tags?: string[];
}

export interface BackupE2EResult {
  backup: BackupResult;
  conceptsRead: number;
}

/**
 * End-to-end backup: read from SQLite → run backup pipeline → upload to canister.
 *
 * Steps:
 * 1. Query ThoughtForms from the local SQLite concepts table.
 * 2. Write them to a temporary input file (or use provided `from` path).
 * 3. Run the backup pipeline (validate, serialize, compress, encrypt, chunk, upload).
 *
 * If `options.from` is set to '__sqlite__', reads from the database instead of a file.
 */
export async function runBackupE2E(
  client: CanisterClient,
  db: DatabaseAdapter,
  options: BackupE2EOptions,
): Promise<{ result: BackupE2EResult; exitCode: number }> {
  let conceptsRead = 0;

  // Read ThoughtForms from SQLite if requested
  if (options.from === '__sqlite__') {
    const thoughtforms = await readThoughtformsFromDb(db, {
      namespace: options.namespace,
      tags: options.tags,
      sinceUpdatedAt: options.sinceUpdatedAt,
    });

    conceptsRead = thoughtforms.length;

    if (thoughtforms.length === 0) {
      const emptyResult: BackupResult = {
        status: 'ok',
        bundleId: '',
        commitId: '',
        parentCommitId: null,
        thoughtformCount: 0,
        chunkCount: 0,
        chunksUploaded: 0,
        payloadHash: '',
        compression: options.compress,
        encryption: options.encrypt,
        duplicateOf: null,
      };
      return {
        result: { backup: emptyResult, conceptsRead: 0 },
        exitCode: 0,
      };
    }

    // Write to the from path so the backup pipeline can read it
    const tempPath = options.from.replace('__sqlite__', '') || `${options.out ?? '/tmp/polyvault-backup'}-input.json`;
    writeFileSync(tempPath, JSON.stringify(thoughtforms, null, 2));
    options = { ...options, from: tempPath };
  }

  // Run backup pipeline
  const { result: backupResult, exitCode } = await runBackup(client, options);

  return {
    result: { backup: backupResult, conceptsRead },
    exitCode,
  };
}

/**
 * Read ThoughtFormV1 records from the local concepts table.
 */
async function readThoughtformsFromDb(
  db: DatabaseAdapter,
  filters: {
    namespace?: string;
    tags?: string[];
    sinceUpdatedAt: number;
  },
): Promise<ThoughtFormV1[]> {
  const thoughtforms: ThoughtFormV1[] = [];
  const pageSize = 100;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { rows, total } = await db.listConcepts({
      limit: pageSize,
      offset,
      namespace: filters.namespace,
      tags: filters.tags,
    });

    for (const row of rows) {
      // Only include rows that have a ThoughtForm stored
      if (!row.has_tf) continue;

      // Fetch the full concept to get the thoughtform JSON
      const concept = await db.findConcept(row.id);
      if (!concept?.thoughtform) continue;

      try {
        const tf = JSON.parse(concept.thoughtform) as ThoughtFormV1;

        // Apply sinceUpdatedAt filter
        if (tf.metadata.updatedAtMs > filters.sinceUpdatedAt) {
          thoughtforms.push(tf);
        }
      } catch {
        // Skip rows with unparseable ThoughtForm JSON
      }
    }

    offset += pageSize;
    hasMore = offset < total;
  }

  return thoughtforms;
}
