import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  DatabaseAdapter,
  ConceptRow,
  ListRow,
  VectorResult,
  ConceptMetaRow,
  StatsResult,
} from './adapter.js';

export class SqliteAdapter implements DatabaseAdapter {
  private db: DatabaseType;

  /** Expose the underlying better-sqlite3 instance for Drizzle query builder usage. */
  getRawDb(): DatabaseType {
    return this.db;
  }

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
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
        embedding BLOB
      )
    `);

    // Add namespace and version columns if missing (migration for existing DBs)
    try {
      this.db.exec(`ALTER TABLE concepts ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE concepts ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_concepts_updated ON concepts(updated_at)
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS concept_vectors USING vec0(
        concept_id TEXT PRIMARY KEY,
        embedding float[384]
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  findConcept(id: string): ConceptRow | null {
    return (
      (this.db
        .prepare(
          'SELECT id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding FROM concepts WHERE id = ?',
        )
        .get(id) as ConceptRow | undefined) ?? null
    );
  }

  insertConcept(row: ConceptRow): void {
    this.db
      .prepare(
        `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  updateConcept(id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const setClauses = keys.map((k) => `${k} = ?`).join(', ');
    const values = Object.values(fields);
    this.db.prepare(`UPDATE concepts SET ${setClauses} WHERE id = ?`).run(...values, id);
  }

  deleteConcept(id: string): void {
    this.db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
  }

  listConcepts(params: {
    limit: number;
    offset: number;
    tags?: string[];
    namespace?: string;
  }): { rows: ListRow[]; total: number } {
    const conditions: string[] = [];
    const queryParams: unknown[] = [];

    if (params.namespace) {
      conditions.push('namespace = ?');
      queryParams.push(params.namespace);
    }

    if (params.tags && params.tags.length > 0) {
      for (const tag of params.tags) {
        conditions.push('tags LIKE ?');
        queryParams.push(`%"${tag}"%`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = this.db
      .prepare(`SELECT COUNT(*) as count FROM concepts ${where}`)
      .get(...queryParams) as { count: number };

    const rows = this.db
      .prepare(
        `SELECT id, namespace, version, created_at, updated_at, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec FROM concepts ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...queryParams, params.limit, params.offset) as ListRow[];

    return { rows, total: countResult.count };
  }

  upsertVector(id: string, embedding: Buffer): void {
    this.db.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
    this.db
      .prepare('INSERT INTO concept_vectors (concept_id, embedding) VALUES (?, ?)')
      .run(id, embedding);
  }

  deleteVector(id: string): void {
    this.db.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
  }

  vectorSearch(queryEmbedding: Buffer, k: number): VectorResult[] {
    return this.db
      .prepare(
        'SELECT concept_id, distance FROM concept_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance',
      )
      .all(queryEmbedding, k) as VectorResult[];
  }

  findConceptMeta(ids: string[]): ConceptMetaRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT id, namespace, tags, markdown IS NOT NULL as has_md, thoughtform IS NOT NULL as has_tf, embedding IS NOT NULL as has_vec
         FROM concepts WHERE id IN (${placeholders})`,
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
      ? 'SELECT COUNT(*) as count FROM concept_vectors WHERE concept_id IN (SELECT id FROM concepts WHERE namespace = ?)'
      : 'SELECT COUNT(*) as count FROM concept_vectors';
    const vectorCount = (
      this.db.prepare(vectorSubquery).get(...nsParam) as { count: number }
    ).count;

    const mdCount = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM concepts WHERE markdown IS NOT NULL${namespace ? ' AND namespace = ?' : ''}`)
        .get(...nsParam) as { count: number }
    ).count;
    const tfCount = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM concepts WHERE thoughtform IS NOT NULL${namespace ? ' AND namespace = ?' : ''}`)
        .get(...nsParam) as { count: number }
    ).count;
    const vecCount = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM concepts WHERE embedding IS NOT NULL${namespace ? ' AND namespace = ?' : ''}`)
        .get(...nsParam) as { count: number }
    ).count;

    return { conceptCount, vectorCount, mdCount, tfCount, vecCount };
  }
}
