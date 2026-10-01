import pg from 'pg';
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

const { Pool } = pg;

/** Bumped when initialize() gains a migration step. */
const SCHEMA_VERSION = 3;

/** Advisory lock key serializing migrations across nodes sharing one database. */
const MIGRATION_LOCK_KEY = 0x706f6c79; // 'poly'

/** pgvector's upper bound for hnsw.ef_search. */
const MAX_EF_SEARCH = 1000;

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

/** pgvector text literal for a Float32 embedding buffer. */
function toPgVector(embedding: Buffer): string {
  const floats = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
  return `[${Array.from(floats).join(',')}]`;
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [maj = 0, min = 0] = version.split('.').map(n => parseInt(n, 10));
  return maj > major || (maj === major && min >= minor);
}

/**
 * PostgreSQL adapter using pgvector for vector similarity search.
 *
 * Requires:
 *  - PostgreSQL 15+ with pgvector >= 0.5 (HNSW); >= 0.8 recommended so
 *    filtered searches use HNSW iterative scans instead of an exact scan
 *  - A connection string via config (e.g. POLYTICIAN_POSTGRES_URL)
 */
export class PostgresAdapter implements DatabaseAdapter {
  private pool: pg.Pool;
  /** pgvector >= 0.8: filtered HNSW scans keep going until LIMIT rows match. */
  private iterativeScan = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      await client.query(`
        CREATE TABLE IF NOT EXISTS concepts (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL DEFAULT 'default',
          version INTEGER NOT NULL DEFAULT 1,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          tags TEXT DEFAULT '[]',
          markdown TEXT,
          thoughtform TEXT,
          embedding BYTEA,
          embedding_model TEXT,
          derived TEXT NOT NULL DEFAULT '{}'
        )
      `);

      // Add columns introduced after the first release (migration for existing DBs)
      await client.query(`
        ALTER TABLE concepts ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE concepts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE concepts ADD COLUMN IF NOT EXISTS derived TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE concepts ADD COLUMN IF NOT EXISTS embedding_model TEXT;
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_concepts_updated ON concepts(updated_at)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_concepts_namespace ON concepts(namespace, updated_at)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_concepts_vector_model
           ON concepts(namespace, embedding_model) WHERE embedding IS NOT NULL`
      );

      await client.query(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS concept_vectors (
          concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
          embedding vector(${VECTOR_DIMENSION}) NOT NULL
        )
      `);

      const current = await client.query<{ value: string }>(
        `SELECT value FROM metadata WHERE key = 'schema_version'`
      );
      const from = current.rows[0] ? parseInt(current.rows[0].value, 10) : 0;
      if (from < SCHEMA_VERSION) {
        await this.migrateToV3(client);
        await client.query(
          `INSERT INTO metadata (key, value) VALUES ('schema_version', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1`,
          [String(SCHEMA_VERSION)]
        );
      }
    });

    const ext = await this.pool.query<{ extversion: string }>(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
    );
    this.iterativeScan = versionAtLeast(ext.rows[0]?.extversion ?? '0', 0, 8);
  }

  /**
   * 3.0: search ranks by cosine distance through an HNSW index. 2.x created
   * an IVFFlat (L2, lists=100) index at startup on an empty table, which
   * pgvector accepts but which gives very low recall. Also clears embeddings
   * that can never be searched and re-indexes rows whose vector write was
   * lost by the non-atomic 2.x save.
   */
  private async migrateToV3(client: pg.PoolClient): Promise<void> {
    await client.query('DROP INDEX IF EXISTS idx_concept_vectors_embedding');
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_concept_vectors_embedding_cosine
        ON concept_vectors USING hnsw (embedding vector_cosine_ops)
      `);
    } catch (err) {
      throw new Error(
        `pgvector >= 0.5.0 is required for the HNSW index: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const stored = await client.query<{ id: string; embedding: Buffer; indexed: boolean }>(
      `SELECT c.id, c.embedding, v.concept_id IS NOT NULL AS indexed FROM concepts c
       LEFT JOIN concept_vectors v ON v.concept_id = c.id
       WHERE c.embedding IS NOT NULL`
    );
    for (const row of stored.rows) {
      const embedding = Buffer.from(row.embedding);
      const usable =
        embedding.byteLength === VECTOR_DIMENSION * 4 &&
        embeddingProblem(deserializeEmbedding(embedding)) === null;
      if (!usable) {
        // Never searchable (wrong length, non-finite or zero): drop it.
        await client.query(
          'UPDATE concepts SET embedding = NULL, embedding_model = NULL WHERE id = $1',
          [row.id]
        );
        await client.query('DELETE FROM concept_vectors WHERE concept_id = $1', [row.id]);
      } else if (!row.indexed) {
        await this.upsertVectorWith(client, row.id, embedding);
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Run fn in a transaction on a dedicated client; rolls back and rethrows on error. */
  private async withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findConcept(id: string): Promise<ConceptRow | null> {
    const result = await this.pool.query(
      'SELECT id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding, embedding_model, derived FROM concepts WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.toConceptRow(result.rows[0]);
  }

  async applyWrites(writes: ConceptWrite[]): Promise<WriteOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [index, write] of writes.entries()) {
        if (!(await this.applyWrite(client, write))) {
          await client.query('ROLLBACK');
          return { ok: false, index };
        }
      }
      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Runs inside applyWrites' transaction; false means the precondition failed. */
  private async applyWrite(client: pg.PoolClient, write: ConceptWrite): Promise<boolean> {
    switch (write.kind) {
      case 'insert': {
        const { row } = write;
        const inserted = await client.query(
          `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding, embedding_model, derived)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
          [
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
            row.derived ?? '{}',
          ]
        );
        if (inserted.rowCount === 0) return false;
        if (row.embedding) await this.upsertVectorWith(client, row.id, row.embedding);
        return true;
      }
      case 'update': {
        const entries = this.updateEntries(write.fields);
        const setClause = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
        // Under READ COMMITTED a concurrent writer's UPDATE blocks on the row
        // lock, then re-checks `version` against the committed row, so only
        // one writer holding a given expectedVersion can match.
        const updated = await client.query(
          `UPDATE concepts SET ${setClause} WHERE id = $${entries.length + 1} AND version = $${entries.length + 2}`,
          [...entries.map(([, v]) => v), write.id, write.expectedVersion]
        );
        if (updated.rowCount === 0) return false;
        if (write.fields.embedding === null) {
          await client.query('DELETE FROM concept_vectors WHERE concept_id = $1', [write.id]);
        } else if (write.fields.embedding) {
          await this.upsertVectorWith(client, write.id, write.fields.embedding);
        }
        return true;
      }
      case 'delete': {
        // concept_vectors has ON DELETE CASCADE.
        const deleted =
          write.namespace === undefined
            ? await client.query('DELETE FROM concepts WHERE id = $1', [write.id])
            : await client.query('DELETE FROM concepts WHERE id = $1 AND namespace = $2', [
                write.id,
                write.namespace,
              ]);
        return (deleted.rowCount ?? 0) > 0;
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

  async insertConcept(row: ConceptRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding, embedding_model, derived)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
        row.derived ?? '{}',
      ]
    );
  }

  async updateConcept(id: string, fields: ConceptUpdateFields): Promise<void> {
    if (Object.values(fields).every(v => v === undefined)) return;
    const entries = this.updateEntries(fields);
    const setClause = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
    await this.pool.query(`UPDATE concepts SET ${setClause} WHERE id = $${entries.length + 1}`, [
      ...entries.map(([, v]) => v),
      id,
    ]);
  }

  async deleteConcept(id: string): Promise<void> {
    // concept_vectors has ON DELETE CASCADE, so only need to delete from concepts
    await this.pool.query('DELETE FROM concepts WHERE id = $1', [id]);
  }

  async listConcepts(params: {
    limit: number;
    offset: number;
    tags?: string[];
    namespace?: string;
  }): Promise<{ rows: ListRow[]; total: number }> {
    const conditions: string[] = [];
    const queryParams: unknown[] = [];
    let paramIdx = 1;

    if (params.namespace) {
      conditions.push(`namespace = $${paramIdx++}`);
      queryParams.push(params.namespace);
    }

    if (params.tags && params.tags.length > 0) {
      // jsonb containment: every tag must be an element of the array (exact match).
      conditions.push(`tags::jsonb @> $${paramIdx++}::jsonb`);
      queryParams.push(JSON.stringify(params.tags));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM concepts ${where}`,
      queryParams
    );

    const listParams = [...queryParams, params.limit, params.offset];
    const rows = await this.pool.query(
      `SELECT id, namespace, version, created_at, updated_at, tags,
              CASE WHEN markdown IS NOT NULL THEN 1 ELSE 0 END as has_md,
              CASE WHEN thoughtform IS NOT NULL THEN 1 ELSE 0 END as has_tf,
              CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END as has_vec
       FROM concepts ${where}
       ORDER BY updated_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      listParams
    );

    return {
      rows: rows.rows.map(r => ({
        id: r.id as string,
        namespace: (r.namespace as string) ?? 'default',
        version: Number(r.version ?? 1),
        created_at: Number(r.created_at),
        updated_at: Number(r.updated_at),
        tags: r.tags as string,
        has_md: Number(r.has_md),
        has_tf: Number(r.has_tf),
        has_vec: Number(r.has_vec),
      })),
      total: Number(countResult.rows[0].count),
    };
  }

  async upsertVector(id: string, _namespace: string, embedding: Buffer): Promise<void> {
    await this.upsertVectorWith(this.pool, id, embedding);
  }

  private async upsertVectorWith(
    db: pg.Pool | pg.PoolClient,
    id: string,
    embedding: Buffer
  ): Promise<void> {
    await db.query(
      `INSERT INTO concept_vectors (concept_id, embedding) VALUES ($1, $2)
       ON CONFLICT (concept_id) DO UPDATE SET embedding = $2`,
      [id, toPgVector(embedding)]
    );
  }

  async deleteVector(id: string): Promise<void> {
    await this.pool.query('DELETE FROM concept_vectors WHERE concept_id = $1', [id]);
  }

  async vectorSearch(
    queryEmbedding: Buffer,
    k: number,
    filter: VectorFilter
  ): Promise<VectorResult[]> {
    const params: unknown[] = [toPgVector(queryEmbedding)];
    const conditions: string[] = [];

    if (filter.namespaces !== null) {
      if (filter.namespaces.length === 0) return [];
      params.push([...filter.namespaces]);
      conditions.push(`c.namespace = ANY($${params.length}::text[])`);
    }
    if (filter.tags && filter.tags.length > 0) {
      params.push(JSON.stringify(filter.tags));
      conditions.push(`c.tags::jsonb @> $${params.length}::jsonb`);
    }
    params.push(k);

    const filtered = conditions.length > 0;
    const sql = `SELECT v.concept_id, v.embedding <=> $1::vector AS distance
       FROM concept_vectors v ${filtered ? 'JOIN concepts c ON c.id = v.concept_id' : ''}
       ${filtered ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY v.embedding <=> $1::vector
       LIMIT $${params.length}`;

    // An HNSW scan yields at most ef_search candidates, and WHERE is applied
    // to those candidates. So: raise ef_search to k; for filtered queries use
    // an iterative scan (pgvector >= 0.8) or, on older pgvector, an exact
    // scan. Without this, filters silently drop matches (fewer than k rows).
    const efSearch = Math.max(40, Math.min(MAX_EF_SEARCH, Math.ceil(k)));
    const exact = k > MAX_EF_SEARCH || (filtered && !this.iterativeScan);

    const rows = await this.withTransaction(async client => {
      await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
      if (exact) await client.query('SET LOCAL enable_indexscan = off');
      else if (filtered) await client.query('SET LOCAL hnsw.iterative_scan = strict_order');
      return (await client.query(sql, params)).rows;
    });

    return rows.map(r => ({
      concept_id: r.concept_id as string,
      distance: Number(r.distance),
    }));
  }

  async countForeignVectors(model: string, namespaces: readonly string[] | null): Promise<number> {
    if (namespaces !== null && namespaces.length === 0) return 0;
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM concepts
       WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $1
       ${namespaces === null ? '' : 'AND namespace = ANY($2::text[])'}`,
      namespaces === null ? [model] : [model, [...namespaces]]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async findForeignVectors(
    model: string,
    namespace: string,
    afterId: string | null,
    limit: number
  ): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM concepts
       WHERE embedding IS NOT NULL AND namespace = $1 AND embedding_model IS DISTINCT FROM $2
         AND id > $3
       ORDER BY id LIMIT $4`,
      [namespace, model, afterId ?? '', limit]
    );
    return result.rows.map(r => r.id);
  }

  async labelLegacyVectors(model: string): Promise<number> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const done = await client.query('SELECT 1 FROM metadata WHERE key = $1', [
        LEGACY_VECTORS_LABELLED,
      ]);
      if ((done.rowCount ?? 0) > 0) return 0;
      const labelled = await client.query(
        'UPDATE concepts SET embedding_model = $1 WHERE embedding IS NOT NULL AND embedding_model IS NULL',
        [model]
      );
      await client.query('INSERT INTO metadata (key, value) VALUES ($1, $2)', [
        LEGACY_VECTORS_LABELLED,
        model,
      ]);
      return labelled.rowCount ?? 0;
    });
  }

  async findConceptMeta(ids: string[]): Promise<ConceptMetaRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const result = await this.pool.query(
      `SELECT id, namespace, tags,
              CASE WHEN markdown IS NOT NULL THEN 1 ELSE 0 END as has_md,
              CASE WHEN thoughtform IS NOT NULL THEN 1 ELSE 0 END as has_tf,
              CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END as has_vec
       FROM concepts WHERE id IN (${placeholders})`,
      ids
    );

    return result.rows.map(r => ({
      id: r.id as string,
      namespace: (r.namespace as string) ?? 'default',
      tags: r.tags as string,
      has_md: Number(r.has_md),
      has_tf: Number(r.has_tf),
      has_vec: Number(r.has_vec),
    }));
  }

  async getStats(namespace?: string): Promise<StatsResult> {
    const nsFilter = namespace ? ' WHERE namespace = $1' : '';
    const nsParam = namespace ? [namespace] : [];

    const [concepts, vectors, md, tf, vec] = await Promise.all([
      this.pool.query(`SELECT COUNT(*) as count FROM concepts${nsFilter}`, nsParam),
      namespace
        ? this.pool.query(
            'SELECT COUNT(*) as count FROM concept_vectors WHERE concept_id IN (SELECT id FROM concepts WHERE namespace = $1)',
            nsParam
          )
        : this.pool.query('SELECT COUNT(*) as count FROM concept_vectors'),
      this.pool.query(
        `SELECT COUNT(*) as count FROM concepts WHERE markdown IS NOT NULL${namespace ? ' AND namespace = $1' : ''}`,
        nsParam
      ),
      this.pool.query(
        `SELECT COUNT(*) as count FROM concepts WHERE thoughtform IS NOT NULL${namespace ? ' AND namespace = $1' : ''}`,
        nsParam
      ),
      this.pool.query(
        `SELECT COUNT(*) as count FROM concepts WHERE embedding IS NOT NULL${namespace ? ' AND namespace = $1' : ''}`,
        nsParam
      ),
    ]);

    return {
      conceptCount: Number(concepts.rows[0].count),
      vectorCount: Number(vectors.rows[0].count),
      mdCount: Number(md.rows[0].count),
      tfCount: Number(tf.rows[0].count),
      vecCount: Number(vec.rows[0].count),
    };
  }

  async getMetadata(key: string): Promise<string | null> {
    const result = await this.pool.query('SELECT value FROM metadata WHERE key = $1', [key]);
    if (result.rows.length === 0) return null;
    return result.rows[0].value as string;
  }

  async setMetadata(key: string, value: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO metadata (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    );
  }

  /** Normalize PostgreSQL row types to match the ConceptRow interface. */
  private toConceptRow(row: Record<string, unknown>): ConceptRow {
    return {
      id: row.id as string,
      namespace: (row.namespace as string) ?? 'default',
      version: Number(row.version ?? 1),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      tags: row.tags as string,
      markdown: (row.markdown as string) ?? null,
      thoughtform: (row.thoughtform as string) ?? null,
      embedding: row.embedding ? Buffer.from(row.embedding as Buffer) : null,
      embedding_model: (row.embedding_model as string | null) ?? null,
      derived: (row.derived as string) ?? '{}',
    };
  }
}
