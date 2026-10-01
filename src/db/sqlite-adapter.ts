import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  DatabaseAdapter,
  ConceptRow,
  ConceptUpdateFields,
  ConceptWrite,
  WriteOutcome,
  ListRow,
  VectorFilter,
  VectorResult,
  ConceptMetaRow,
  StatsResult,
} from './adapter.js';
import { VECTOR_DIMENSION, embeddingProblem } from '../types/concept.js';
import { deserializeEmbedding } from './embedding-codec.js';

/** vec0 rejects larger k values. */
const MAX_KNN_K = 4096;

/** Columns ConceptUpdateFields may set; guards the dynamic SET clause. */
const UPDATABLE_COLUMNS = new Set([
  'version',
  'updated_at',
  'tags',
  'markdown',
  'thoughtform',
  'embedding',
  'embedding_model',
  'derived',
]);

/** metadata key recording that pre-3.0 vectors were labelled with a model. */
const LEGACY_VECTORS_LABELLED = 'legacy_vectors_labelled';

/** Rows whose vector is not recorded as made by the bound model. */
const FOREIGN_VECTOR = '(embedding_model IS NULL OR embedding_model <> ?)';

/** Thrown inside a transaction to roll it back when a write's precondition fails. */
class PreconditionFailed extends Error {
  constructor(readonly index: number) {
    super(`write ${index} precondition failed`);
  }
}

/** `EXISTS` clause matching one exact tag in a JSON-array `tags` column. */
function tagClause(column: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ?)`;
}

export class SqliteAdapter implements DatabaseAdapter {
  private db: DatabaseType;

  /** Expose the underlying better-sqlite3 instance for Drizzle query builder usage. */
  getRawDb(): DatabaseType {
    return this.db;
  }

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath);
    // Memories are private: owner-only, before the WAL and SHM files (which
    // SQLite creates with the database file's mode) exist.
    if (dbPath !== ':memory:' && process.platform !== 'win32') chmodSync(dbPath, 0o600);
  }

  initialize(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    sqliteVec.load(this.db);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        tags TEXT DEFAULT '[]',
        markdown TEXT,
        thoughtform TEXT,
        embedding BLOB,
        embedding_model TEXT,
        derived TEXT NOT NULL DEFAULT '{}'
      )
    `);

    // Add columns introduced after the first release (migration for existing DBs)
    for (const column of [
      `namespace TEXT NOT NULL DEFAULT 'default'`,
      `version INTEGER NOT NULL DEFAULT 1`,
      `derived TEXT NOT NULL DEFAULT '{}'`,
      `embedding_model TEXT`,
    ]) {
      try {
        this.db.exec(`ALTER TABLE concepts ADD COLUMN ${column}`);
      } catch {
        // Column already exists
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_concepts_updated ON concepts(updated_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_concepts_namespace ON concepts(namespace, updated_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_concepts_vector_model
        ON concepts(namespace, embedding_model) WHERE embedding IS NOT NULL
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.migrateVectorIndex();
  }

  /**
   * The vector index partitions by namespace (so namespace filters run inside
   * the KNN query) and uses cosine distance. Databases from 2.x have an
   * unpartitioned L2 index; it is rebuilt from `concepts.embedding`, the
   * source of truth. Embeddings that could never be searched (wrong length
   * from a failed, non-atomic 2.x save, non-finite or zero) are cleared.
   */
  private migrateVectorIndex(): void {
    const existing = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'concept_vectors'")
      .get() as { sql: string } | undefined;
    const current =
      existing !== undefined &&
      /partition key/i.test(existing.sql) &&
      /distance_metric=cosine/i.test(existing.sql);
    if (current) return;

    this.db.transaction(() => {
      if (existing) this.db.exec('DROP TABLE concept_vectors');
      // Each partition (namespace) allocates whole chunks; 128 rows per chunk
      // keeps a small namespace at ~200 KB instead of vec0's default ~1.5 MB.
      this.db.exec(`
        CREATE VIRTUAL TABLE concept_vectors USING vec0(
          concept_id TEXT PRIMARY KEY,
          namespace TEXT partition key,
          embedding float[${VECTOR_DIMENSION}] distance_metric=cosine,
          chunk_size=128
        )
      `);
      const rows = this.db
        .prepare('SELECT id, namespace, embedding FROM concepts WHERE embedding IS NOT NULL')
        .all() as Array<{ id: string; namespace: string; embedding: Buffer }>;
      const clear = this.db.prepare(
        'UPDATE concepts SET embedding = NULL, embedding_model = NULL WHERE id = ?'
      );
      for (const row of rows) {
        const usable =
          row.embedding.byteLength === VECTOR_DIMENSION * 4 &&
          embeddingProblem(deserializeEmbedding(row.embedding)) === null;
        if (usable) this.upsertVector(row.id, row.namespace, row.embedding);
        else clear.run(row.id);
      }
    })();
  }

  close(): void {
    this.db.close();
  }

  findConcept(id: string): ConceptRow | null {
    return (
      (this.db
        .prepare(
          'SELECT id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding, embedding_model, derived FROM concepts WHERE id = ?'
        )
        .get(id) as ConceptRow | undefined) ?? null
    );
  }

  applyWrites(writes: ConceptWrite[]): WriteOutcome {
    const apply = this.db.transaction((batch: ConceptWrite[]) => {
      batch.forEach((write, index) => {
        if (!this.applyWrite(write)) throw new PreconditionFailed(index);
      });
    });
    try {
      apply(writes);
      return { ok: true };
    } catch (err) {
      if (err instanceof PreconditionFailed) return { ok: false, index: err.index };
      throw err;
    }
  }

  /** Runs inside applyWrites' transaction; false means the precondition failed. */
  private applyWrite(write: ConceptWrite): boolean {
    switch (write.kind) {
      case 'insert': {
        const { row } = write;
        const inserted = this.db
          .prepare(
            `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding, embedding_model, derived)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
          )
          .run(
            row.id,
            row.namespace,
            row.version,
            row.created_at,
            row.updated_at,
            row.tags,
            row.markdown,
            row.thoughtform,
            row.embedding,
            row.embedding ? (row.embedding_model ?? null) : null,
            row.derived ?? '{}'
          );
        if (inserted.changes === 0) return false;
        if (row.embedding) this.upsertVector(row.id, row.namespace, row.embedding);
        return true;
      }
      case 'update': {
        const entries = this.updateEntries(write.fields);
        const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
        const updated = this.db
          .prepare(`UPDATE concepts SET ${setClause} WHERE id = ? AND version = ?`)
          .run(...entries.map(([, v]) => v), write.id, write.expectedVersion);
        if (updated.changes === 0) return false;
        if (write.fields.embedding === null) this.deleteVector(write.id);
        else if (write.fields.embedding) {
          this.upsertVector(write.id, write.namespace, write.fields.embedding);
        }
        return true;
      }
      case 'delete': {
        const deleted =
          write.namespace === undefined
            ? this.db.prepare('DELETE FROM concepts WHERE id = ?').run(write.id)
            : this.db
                .prepare('DELETE FROM concepts WHERE id = ? AND namespace = ?')
                .run(write.id, write.namespace);
        if (deleted.changes === 0) return false;
        this.deleteVector(write.id);
        return true;
      }
    }
  }

  private updateEntries(fields: ConceptUpdateFields): Array<[string, unknown]> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    for (const [key] of entries) {
      if (!UPDATABLE_COLUMNS.has(key)) throw new Error(`Cannot update column '${key}'`);
    }
    if (entries.length === 0) throw new Error('Update has no fields');
    return entries;
  }

  insertConcept(row: ConceptRow): void {
    this.db
      .prepare(
        `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding, embedding_model, derived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.namespace,
        row.version,
        row.created_at,
        row.updated_at,
        row.tags,
        row.markdown,
        row.thoughtform,
        row.embedding,
        row.embedding ? (row.embedding_model ?? null) : null,
        row.derived ?? '{}'
      );
  }

  updateConcept(id: string, fields: ConceptUpdateFields): void {
    if (Object.values(fields).every(v => v === undefined)) return;
    const entries = this.updateEntries(fields);
    const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE concepts SET ${setClause} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id);
  }

  deleteConcept(id: string): void {
    this.db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
  }

  listConcepts(params: { limit: number; offset: number; tags?: string[]; namespace?: string }): {
    rows: ListRow[];
    total: number;
  } {
    const conditions: string[] = [];
    const queryParams: unknown[] = [];

    if (params.namespace) {
      conditions.push('namespace = ?');
      queryParams.push(params.namespace);
    }

    for (const tag of params.tags ?? []) {
      conditions.push(tagClause('concepts.tags'));
      queryParams.push(tag);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM concepts ${where}`)
      .get(...queryParams) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT id, namespace, version, created_at, updated_at, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec FROM concepts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(...queryParams, params.limit, params.offset) as ListRow[];

    return { rows, total: countResult.count };
  }

  upsertVector(id: string, namespace: string, embedding: Buffer): void {
    // vec0 cannot UPDATE a partition key, so replace the row.
    this.db.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
    this.db
      .prepare('INSERT INTO concept_vectors (concept_id, namespace, embedding) VALUES (?, ?, ?)')
      .run(id, namespace, embedding);
  }

  deleteVector(id: string): void {
    this.db.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
  }

  vectorSearch(queryEmbedding: Buffer, k: number, filter: VectorFilter): VectorResult[] {
    const conditions = ['embedding MATCH ?', 'k = ?'];
    const params: unknown[] = [queryEmbedding, Math.min(k, MAX_KNN_K)];

    // Both filters are constraints on the vec0 scan itself: `namespace` is the
    // partition key and `concept_id IN (...)` restricts candidate rows, so the
    // KNN ranks only matching rows.
    if (filter.namespaces !== null) {
      if (filter.namespaces.length === 0) return [];
      conditions.push(`namespace IN (${filter.namespaces.map(() => '?').join(', ')})`);
      params.push(...filter.namespaces);
    }
    if (filter.tags && filter.tags.length > 0) {
      const tagConditions = filter.tags.map(() => tagClause('c.tags')).join(' AND ');
      conditions.push(`concept_id IN (SELECT c.id FROM concepts c WHERE ${tagConditions})`);
      params.push(...filter.tags);
    }

    return this.db
      .prepare(
        `SELECT concept_id, distance FROM concept_vectors WHERE ${conditions.join(' AND ')} ORDER BY distance`
      )
      .all(...params) as VectorResult[];
  }

  countForeignVectors(model: string, namespaces: readonly string[] | null): number {
    if (namespaces !== null && namespaces.length === 0) return 0;
    const nsClause =
      namespaces === null ? '' : ` AND namespace IN (${namespaces.map(() => '?').join(', ')})`;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM concepts WHERE embedding IS NOT NULL AND ${FOREIGN_VECTOR}${nsClause}`
      )
      .get(model, ...(namespaces ?? [])) as { count: number };
    return row.count;
  }

  findForeignVectors(
    model: string,
    namespace: string,
    afterId: string | null,
    limit: number
  ): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM concepts WHERE embedding IS NOT NULL AND namespace = ? AND ${FOREIGN_VECTOR}
         AND id > ? ORDER BY id LIMIT ?`
      )
      .all(namespace, model, afterId ?? '', limit) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  labelLegacyVectors(model: string): number {
    return this.db.transaction((): number => {
      if (this.getMetadata(LEGACY_VECTORS_LABELLED) !== null) return 0;
      const labelled = this.db
        .prepare(
          'UPDATE concepts SET embedding_model = ? WHERE embedding IS NOT NULL AND embedding_model IS NULL'
        )
        .run(model).changes;
      this.setMetadata(LEGACY_VECTORS_LABELLED, model);
      return labelled;
    })();
  }

  findConceptMeta(ids: string[]): ConceptMetaRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT id, namespace, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec
         FROM concepts WHERE id IN (${placeholders})`
      )
      .all(...ids) as ConceptMetaRow[];
  }

  getStats(namespace?: string): StatsResult {
    const nsFilter = namespace ? ' WHERE namespace = ?' : '';
    const nsParam = namespace ? [namespace] : [];

    const conceptCount = (
      this.db.prepare(`SELECT COUNT(*) as count FROM concepts${nsFilter}`).get(...nsParam) as {
        count: number;
      }
    ).count;

    const vectorSubquery = namespace
      ? 'SELECT COUNT(*) as count FROM concept_vectors WHERE namespace = ?'
      : 'SELECT COUNT(*) as count FROM concept_vectors';
    const vectorCount = (this.db.prepare(vectorSubquery).get(...nsParam) as { count: number })
      .count;

    const mdCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM concepts WHERE markdown IS NOT NULL${namespace ? ' AND namespace = ?' : ''}`
        )
        .get(...nsParam) as { count: number }
    ).count;
    const tfCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM concepts WHERE thoughtform IS NOT NULL${namespace ? ' AND namespace = ?' : ''}`
        )
        .get(...nsParam) as { count: number }
    ).count;
    const vecCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM concepts WHERE embedding IS NOT NULL${namespace ? ' AND namespace = ?' : ''}`
        )
        .get(...nsParam) as { count: number }
    ).count;

    return { conceptCount, vectorCount, mdCount, tfCount, vecCount };
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }
}
