import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getAdapter } from '../db/client.js';
import type { ConceptRow } from '../db/adapter.js';
import { deserializeEmbedding } from '../db/embedding-codec.js';
import { getConfig } from '../config.js';
import { conceptEventBus } from '../events/concept-events.js';
import { logger } from '../logger.js';
import { ConfigurationError, ValidationError } from '../errors/index.js';
import { VECTOR_DIMENSION, type DerivedMap } from '../types/concept.js';
import { thoughtFormText, type StoredThoughtForm } from '../types/thoughtform.js';
import { decodeBackup, encodeBackup, type BackupRecord } from '../backup/format.js';
import { loadBackupKey, requireBackupKey, type BackupKey } from '../backup/key.js';
import {
  backupsDir,
  ensurePrivateDir,
  newBackupFileName,
  pruneBackups,
  resolveBackupFile,
  writePrivateFile,
} from '../backup/files.js';
import {
  conceptService,
  type RestoreConflictPolicy,
  type RestoreOutcome,
  type RestoreRecord,
} from './concept.service.js';
import { embeddingService } from './embedding.service.js';

const SAVE_COUNTER_KEY = 'backup_save_counter';

/** Rows fetched per listConcepts call; one call returns every id in scope. */
const LIST_ALL = 2_147_483_647;

// --- Export ---

export interface ExportOptions {
  /** Namespaces to include, or '*' for every namespace (the default). */
  namespaces?: readonly string[] | '*';
  /**
   * Encrypt with the configured backup key. Defaults to POLYTICIAN_ENCRYPT;
   * when that is set, a plaintext export is refused.
   */
  encrypt?: boolean;
}

export interface ExportResult {
  file: string;
  path: string;
  backupId: string;
  createdAt: string;
  conceptCount: number;
  namespaces: Record<string, number>;
  sizeBytes: number;
  /** SHA-256 of the file as written. */
  sha256: string;
  encrypted: boolean;
  keyId: string | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: ConceptRow): BackupRecord {
  return {
    type: 'concept',
    id: row.id,
    namespace: row.namespace,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: parseJson<string[]>(row.tags, []),
    markdown: row.markdown,
    thoughtform: row.thoughtform ? (JSON.parse(row.thoughtform) as StoredThoughtForm) : null,
    embedding: deserializeEmbedding(row.embedding),
    derived: parseJson<DerivedMap>(row.derived, {}),
  };
}

/**
 * Every concept in scope, read row by row after listing all ids in one query.
 * Concepts deleted meanwhile are left out; concepts updated meanwhile are
 * exported in their newer state.
 */
async function collectRecords(namespaces: readonly string[] | '*'): Promise<BackupRecord[]> {
  const adapter = getAdapter();
  const scopes = namespaces === '*' ? [undefined] : [...new Set(namespaces)];
  const ids: string[] = [];
  for (const namespace of scopes) {
    const { rows } = await adapter.listConcepts({ limit: LIST_ALL, offset: 0, namespace });
    ids.push(...rows.map(r => r.id));
  }
  const records: BackupRecord[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const row = await adapter.findConcept(id);
    if (row) records.push(rowToRecord(row));
  }
  return records;
}

/** Encryption key for a new backup, or null for plaintext; fails closed. */
function keyForExport(encrypt: boolean | undefined): BackupKey | null {
  const required = getConfig().encrypt;
  if (required && encrypt === false) {
    throw new ConfigurationError(
      'This server requires encrypted backups (POLYTICIAN_ENCRYPT); a plaintext export is refused'
    );
  }
  return (encrypt ?? required) ? requireBackupKey('An encrypted backup') : null;
}

/** Serialize the concepts in scope into backup-file bytes. */
export async function buildBackup(
  options: ExportOptions = {}
): Promise<{ bytes: Buffer; result: Omit<ExportResult, 'file' | 'path'> }> {
  const key = keyForExport(options.encrypt);
  const records = await collectRecords(options.namespaces ?? '*');
  const { bytes, header, footer } = encodeBackup({
    records,
    embeddingModel: getConfig().embeddingModel,
    embeddingDimension: VECTOR_DIMENSION,
    key,
  });
  return {
    bytes,
    result: {
      backupId: header.backupId,
      createdAt: header.createdAt,
      conceptCount: footer.conceptCount,
      namespaces: footer.namespaces,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      encrypted: key !== null,
      keyId: key?.keyId ?? null,
    },
  };
}

/** Write a backup to `path` (mode 0600). For operator tools such as the CLI. */
export async function exportBackupTo(
  path: string,
  options: ExportOptions = {}
): Promise<ExportResult> {
  const { bytes, result } = await buildBackup(options);
  writePrivateFile(path, bytes);
  return { ...result, file: basename(path), path };
}

/** Write a backup into {dataDir}/backups and return where it went. */
export async function exportBackup(
  options: ExportOptions = {},
  prefix: 'backup' | 'auto' = 'backup'
): Promise<ExportResult> {
  const { bytes, result } = await buildBackup(options);
  const dir = backupsDir();
  ensurePrivateDir(dir);
  const file = newBackupFileName(prefix, result.createdAt, result.backupId);
  const path = join(dir, file);
  writePrivateFile(path, bytes);
  logger.info('backup written', {
    file,
    conceptCount: result.conceptCount,
    sizeBytes: result.sizeBytes,
    encrypted: result.encrypted,
  });
  return { ...result, file, path };
}

// --- Import ---

export interface ImportOptions {
  /** Only restore concepts from this namespace. */
  namespace?: string;
  /** What to do with concepts that already exist (default 'newer'). */
  onConflict?: RestoreConflictPolicy;
  /**
   * Drop the backup's vectors and derive new ones from each concept's text.
   * Required when the backup was embedded with a different model.
   */
  reembed?: boolean;
  /** Tool callers pass the namespace allowlist; records outside it are skipped. */
  allowNamespace?: (namespace: string) => boolean;
}

export interface ImportResult {
  backupId: string;
  createdAt: string;
  encrypted: boolean;
  conceptCount: number;
  inserted: number;
  updated: number;
  skipped: Array<{ id: string; namespace: string; reason: string }>;
  /** Vectors re-derived from text (reembed). */
  reembedded: number;
  /** Vectors dropped by reembed because their concept has no text to derive a new one from. */
  vectorsDropped: number;
}

/**
 * Replace the records' vectors with ones derived from their text (markdown,
 * else thoughtform text). Returns how many were derived, and how many
 * vectors were dropped because their concept has no text to derive from.
 */
async function reembedRecords(
  records: RestoreRecord[]
): Promise<{ reembedded: number; vectorsDropped: number }> {
  const pending: Array<{ record: RestoreRecord; text: string; from: 'markdown' | 'thoughtform' }> =
    [];
  let vectorsDropped = 0;
  for (const record of records) {
    const hadVector = record.embedding !== null;
    record.embedding = null;
    delete record.derived.vector;
    const tfText = record.thoughtform ? thoughtFormText(record.thoughtform) : null;
    if (record.markdown?.trim()) pending.push({ record, text: record.markdown, from: 'markdown' });
    else if (tfText) pending.push({ record, text: tfText, from: 'thoughtform' });
    else if (hadVector) vectorsDropped++;
  }
  const vectors = pending.length ? await embeddingService.embedBatch(pending.map(p => p.text)) : [];
  pending.forEach((p, i) => {
    const vector = vectors[i];
    if (!vector) return;
    p.record.embedding = vector;
    p.record.derived.vector = { from: p.from };
  });
  return { reembedded: pending.length, vectorsDropped };
}

/** Restore concepts from backup-file bytes. */
export async function importBackupBytes(
  bytes: Buffer,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const { header, records } = decodeBackup(bytes, loadBackupKey);

  const modelMatches =
    header.embeddingModel === getConfig().embeddingModel &&
    header.embeddingDimension === VECTOR_DIMENSION;
  if (!modelMatches && !options.reembed && records.some(r => r.embedding !== null)) {
    throw new ValidationError(
      `This backup's vectors were made with a different embedding model than this server's (${getConfig().embeddingModel}, ${VECTOR_DIMENSION} dimensions). Import with reembed: true to drop them and derive new vectors from each concept's text.`
    );
  }

  const skipped: ImportResult['skipped'] = [];
  const inScope: RestoreRecord[] = [];
  for (const record of records) {
    if (options.namespace !== undefined && record.namespace !== options.namespace) continue;
    if (options.allowNamespace && !options.allowNamespace(record.namespace)) {
      skipped.push({ id: record.id, namespace: record.namespace, reason: 'namespace-not-allowed' });
      continue;
    }
    inScope.push(record);
  }

  let reembedded = 0;
  let vectorsDropped = 0;
  let toRestore = inScope;
  if (options.reembed) {
    ({ reembedded, vectorsDropped } = await reembedRecords(inScope));
    // A concept that only had a vector has nothing left to restore.
    toRestore = inScope.filter(r => {
      const keep = r.markdown !== null || r.thoughtform !== null || r.embedding !== null;
      if (!keep) skipped.push({ id: r.id, namespace: r.namespace, reason: 'vector-only' });
      return keep;
    });
  }

  const outcome: RestoreOutcome = await conceptService.restore(toRestore, {
    onConflict: options.onConflict,
  });
  return {
    backupId: header.backupId,
    createdAt: header.createdAt,
    encrypted: header.encryption !== null,
    conceptCount: records.length,
    inserted: outcome.inserted.length,
    updated: outcome.updated.length,
    skipped: [...skipped, ...outcome.skipped],
    reembedded,
    vectorsDropped,
  };
}

/** Restore concepts from a backup in {dataDir}/backups, named by its file name. */
export async function importBackup(
  file: string,
  options: ImportOptions = {}
): Promise<ImportResult & { file: string }> {
  const path = resolveBackupFile(file);
  const result = await importBackupBytes(readFileSync(path), options);
  logger.info('backup imported', {
    file,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped.length,
  });
  return { ...result, file };
}

// --- Auto-backup ---

/**
 * Writes a full backup (all namespaces, vectors included, encrypted when
 * POLYTICIAN_ENCRYPT is set) into {dataDir}/backups after every
 * POLYTICIAN_BACKUP_THRESHOLD saves, keeping the newest
 * POLYTICIAN_BACKUP_RETAIN auto-backups. Off unless the threshold is set.
 *
 * The save counter is persisted in the database metadata table so it
 * survives restarts.
 */
export class BackupService {
  private listening = false;
  /** Saves seen since the last flush into the persisted counter. */
  private pending = 0;
  /**
   * Serializes counter updates: getCounter/setMetadata is a read-modify-write,
   * so concurrent flushes must be chained or increments (and threshold
   * triggers) can be lost.
   */
  private queue: Promise<void> = Promise.resolve();
  private readonly onSaved = (): void => {
    this.pending++;
    this.queue = this.queue
      .then(() => this.flush())
      .catch((err: unknown) => {
        logger.error('backup-service increment failed', err);
      });
  };

  start(): void {
    if (this.listening) return;
    this.listening = true;
    conceptEventBus.on('concept.created', this.onSaved);
    conceptEventBus.on('concept.updated', this.onSaved);
    logger.debug('backup-service started');
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    conceptEventBus.off('concept.created', this.onSaved);
    conceptEventBus.off('concept.updated', this.onSaved);
    logger.debug('backup-service stopped');
  }

  /** Read the current save counter from the database. */
  async getCounter(): Promise<number> {
    const raw = await getAdapter().getMetadata(SAVE_COUNTER_KEY);
    return raw !== null ? parseInt(raw, 10) || 0 : 0;
  }

  /** Reset the save counter to zero. */
  async resetCounter(): Promise<void> {
    await getAdapter().setMetadata(SAVE_COUNTER_KEY, '0');
  }

  /**
   * Add the saves seen since the last flush to the counter, and back up once
   * it reaches the threshold. A burst of saves (a batch, an import) that
   * crosses the threshold produces one backup, not one per threshold multiple.
   */
  private async flush(): Promise<void> {
    const seen = this.pending;
    this.pending = 0;
    const { threshold } = getConfig().backup;
    if (seen === 0 || threshold <= 0) return;

    const adapter = getAdapter();
    const next = (await this.getCounter()) + seen;
    if (next >= threshold) {
      await adapter.setMetadata(SAVE_COUNTER_KEY, '0');
      await this.runBackup();
    } else {
      await adapter.setMetadata(SAVE_COUNTER_KEY, String(next));
    }
  }

  /** Write an auto-backup and prune old ones; returns the new file's path. */
  async runBackup(): Promise<string> {
    const result = await exportBackup({ namespaces: '*' }, 'auto');
    const removed = pruneBackups('auto', getConfig().backup.retain);
    if (removed.length > 0) logger.info('backup-service pruned', { removed: removed.length });
    return result.path;
  }
}

export const backupService = new BackupService();
