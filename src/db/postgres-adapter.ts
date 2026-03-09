import pg from 'pg';
import type {
  DatabaseAdapter,
  ConceptRow,
  ListRow,
  VectorResult,
  ConceptMetaRow,
  StatsResult,
} from './adapter.js';

const { Pool } = pg;

/**
 * PostgreSQL adapter using pgvector for vector similarity search.
 *
 * Requires:
 *  - PostgreSQL 15+ with pgvector extension installed
 *  - A connection string via config (e.g. POLYTICIAN_POSTGRES_URL)
 */
export class PostgresAdapter implements DatabaseAdapter {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        tags TEXT DEFAULT '[]',
        markdown TEXT,
        thoughtform TEXT,
        embedding BYTEA
      )
    `);

    // Add namespace and version columns if missing (migration for existing DBs)
    await this.pool.query(`
      DO $$ BEGIN
        ALTER TABLE concepts ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE concepts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      END $$;
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_concepts_updated ON concepts(updated_at)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS concept_vectors (
        concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
        embedding vector(384) NOT NULL
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_concept_vectors_embedding
      ON concept_vectors USING ivfflat (embedding vector_l2_ops)
      WITH (lists = 100)
    `).catch(async () => {
      // IVFFlat index requires rows to exist; fall back to no index initially.
      // For small datasets this is fine — the index can be created later.
      // Try HNSW instead which doesn't have the minimum rows requirement.
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_concept_vectors_embedding
        ON concept_vectors USING hnsw (embedding vector_l2_ops)
      `).catch(() => {
        // If HNSW also fails (older pgvector), queries still work via sequential scan.
      });
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async findConcept(id: string): Promise<ConceptRow | null> {
    const result = await this.pool.query(
      'SELECT id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding FROM concepts WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return null;
    return this.toConceptRow(result.rows[0]);
  }

  async insertConcept(row: ConceptRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
      ],
    );
  }

  async updateConcept(id: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = Object.values(fields);
    await this.pool.query(
      `UPDATE concepts SET ${setClauses} WHERE id = $${keys.length + 1}`,
      [...values, id],
    );
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
      for (const tag of params.tags) {
        conditions.push(`tags LIKE $${paramIdx++}`);
        queryParams.push(`%"${tag}"%`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM concepts ${where}`,
      queryParams,
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
      listParams,
    );

    return {
      rows: rows.rows.map((r) => ({
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

  async upsertVector(id: string, embedding: Buffer): Promise<void> {
    const floats = new Float32Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength / 4,
    );
    const pgVector = `[${Array.from(floats).join(',')}]`;

    await this.pool.query(
      `INSERT INTO concept_vectors (concept_id, embedding) VALUES ($1, $2)
       ON CONFLICT (concept_id) DO UPDATE SET embedding = $2`,
      [id, pgVector],
    );
  }

  async deleteVector(id: string): Promise<void> {
    await this.pool.query('DELETE FROM concept_vectors WHERE concept_id = $1', [id]);
  }

  async vectorSearch(queryEmbedding: Buffer, k: number): Promise<VectorResult[]> {
    const floats = new Float32Array(
      queryEmbedding.buffer,
      queryEmbedding.byteOffset,
      queryEmbedding.byteLength / 4,
    );
    const pgVector = `[${Array.from(floats).join(',')}]`;

    const result = await this.pool.query(
      `SELECT concept_id, embedding <-> $1::vector as distance
       FROM concept_vectors
       ORDER BY embedding <-> $1::vector
       LIMIT $2`,
      [pgVector, k],
    );

    return result.rows.map((r) => ({
      concept_id: r.concept_id as string,
      distance: Number(r.distance),
    }));
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
      ids,
    );

    return result.rows.map((r) => ({
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
            nsParam,
          )
        : this.pool.query('SELECT COUNT(*) as count FROM concept_vectors'),
      this.pool.query(
        `SELECT COUNT(*) as count FROM concepts WHERE markdown IS NOT NULL${namespace ? ' AND namespace = $1' : ''}`,
        nsParam,
      ),
      this.pool.query(
        `SELECT COUNT(*) as count FROM concepts WHERE thoughtform IS NOT NULL${namespace ? ' AND namespace = $1' : ''}`,
        nsParam,
      ),
      this.pool.query(
        `SELECT COUNT(*) as count FROM concepts WHERE embedding IS NOT NULL${namespace ? ' AND namespace = $1' : ''}`,
        nsParam,
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
    const result = await this.pool.query(
      'SELECT value FROM metadata WHERE key = $1',
      [key],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].value as string;
  }

  async setMetadata(key: string, value: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO metadata (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value],
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
    };
  }
}
