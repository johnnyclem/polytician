/**
 * PostgreSQL + pgvector adapter tests.
 *
 * Skipped unless POLYTICIAN_TEST_POSTGRES_URL points at a disposable database
 * with the pgvector extension available, e.g.
 *   POLYTICIAN_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/polytest npx vitest run tests/postgres-adapter.test.ts
 * The tests drop and recreate Polytician's tables in that database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { initializeDatabaseAsync, closeDatabase, resetAdapter } from '../src/db/client.js';
import { getConfig, resetConfig } from '../src/config.js';
import { ConceptService } from '../src/services/concept.service.js';
import { VersionConflictError } from '../src/errors/index.js';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

const PG_URL = process.env['POLYTICIAN_TEST_POSTGRES_URL'];

function vec(dominant: number, tilt = 0, towards = (dominant + 1) % VECTOR_DIMENSION): number[] {
  const v = new Array<number>(VECTOR_DIMENSION).fill(0);
  v[dominant] = 1;
  v[towards] = (v[towards] ?? 0) + tilt;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

describe.skipIf(!PG_URL)('PostgresAdapter (pgvector)', () => {
  let admin: pg.Pool;
  let service: ConceptService;
  const savedEnv = { ...process.env };

  async function dropAll(): Promise<void> {
    await admin.query('DROP TABLE IF EXISTS concept_vectors, concepts, metadata CASCADE');
  }

  async function open(): Promise<void> {
    process.env['POLYTICIAN_DB_BACKEND'] = 'postgres';
    process.env['POLYTICIAN_POSTGRES_URL'] = PG_URL!;
    resetConfig();
    resetAdapter();
    await initializeDatabaseAsync();
    service = new ConceptService();
  }

  beforeEach(async () => {
    admin = new pg.Pool({ connectionString: PG_URL });
    await dropAll();
  });

  afterEach(async () => {
    await closeDatabase();
    resetAdapter();
    process.env = { ...savedEnv };
    resetConfig();
    await dropAll();
    await admin.end();
  });

  // --- POLY-14 ---

  it('indexes vectors with HNSW (cosine), not IVFFlat on an empty table', async () => {
    await open();
    const { rows } = await admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'concept_vectors'"
    );
    const defs = rows.map(r => r.indexdef.toLowerCase());
    expect(defs.some(d => d.includes('using hnsw') && d.includes('vector_cosine_ops'))).toBe(true);
    expect(defs.some(d => d.includes('ivfflat'))).toBe(false);
  });

  it('migrates a 2.x database: drops the IVFFlat index and keeps existing vectors searchable', async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`
      CREATE TABLE concepts (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default', version INTEGER NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, tags TEXT DEFAULT '[]',
        markdown TEXT, thoughtform TEXT, embedding BYTEA)`);
    await admin.query('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await admin.query(`
      CREATE TABLE concept_vectors (
        concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
        embedding vector(384) NOT NULL)`);
    await admin.query(
      `CREATE INDEX idx_concept_vectors_embedding ON concept_vectors USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)`
    );
    const e = vec(4);
    const id = '0d000000-0000-4000-a000-000000000001';
    await admin.query(
      `INSERT INTO concepts (id, created_at, updated_at, tags, markdown, embedding) VALUES ($1, 1, 1, '[]', 'old', $2)`,
      [id, Buffer.from(new Float32Array(e).buffer)]
    );
    await admin.query(`INSERT INTO concept_vectors (concept_id, embedding) VALUES ($1, $2)`, [
      id,
      `[${e.join(',')}]`,
    ]);

    await open();

    const { rows } = await admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'concept_vectors'"
    );
    expect(rows.some(r => r.indexdef.toLowerCase().includes('ivfflat'))).toBe(false);
    const results = await service.search(vec(4), 5);
    expect(results.map(r => r.id)).toEqual([id]);
    expect(results[0]!.score).toBeCloseTo(1, 5);
    const read = await service.read(id);
    expect(read.derived).toEqual({});
    // 2.x recorded no model; its vectors are labelled with the configured one.
    const labelled = await admin.query<{ embedding_model: string }>(
      'SELECT embedding_model FROM concepts WHERE id = $1',
      [id]
    );
    expect(labelled.rows[0]!.embedding_model).toBe(getConfig().embeddingModel);
  });

  // --- POLY-27 ---

  it('refuses to rank vectors from another embedding model', async () => {
    await open();
    await service.save({ embedding: vec(6), namespace: 'default' });
    getConfig().embeddingModel = 'Xenova/paraphrase-MiniLM-L3-v2';
    await expect(service.search(vec(6), 5)).rejects.toMatchObject({
      code: 'EMBEDDING_MODEL_MISMATCH',
    });
    await expect(service.search(vec(6), 5, undefined, { namespace: 'other' })).resolves.toEqual(
      []
    );
  });

  // --- POLY-02 on a real multi-connection backend ---

  it('lets exactly one of several concurrent expectedVersion writers win', async () => {
    await open();
    const id = '0d000000-0000-4000-a000-000000000002';
    await service.save({ id, markdown: 'v1' });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        service.save({ id, expectedVersion: 1, markdown: `writer ${i}` })
      )
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(r => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);
    }
    expect((await service.read(id)).version).toBe(2);
  });

  it('does not lose concurrent tag merges', async () => {
    await open();
    const id = '0d000000-0000-4000-a000-000000000003';
    await service.save({ id, markdown: 'base' });
    await Promise.all(['a', 'b', 'c', 'd'].map(t => service.save({ id, tags: [t] })));
    const final = await service.read(id);
    expect([...(final.tags ?? [])].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(final.version).toBe(5);
  });

  it('rejects a bad embedding without persisting the concept row', async () => {
    await open();
    const id = '0d000000-0000-4000-a000-000000000004';
    await expect(service.save({ id, markdown: 'x', embedding: [1, 2, 3] })).rejects.toThrow();
    const { rowCount } = await admin.query('SELECT 1 FROM concepts WHERE id = $1', [id]);
    expect(rowCount).toBe(0);
  });

  // --- POLY-05 on pgvector ---

  it('applies namespace and tag filters inside the vector query', async () => {
    await open();
    for (let i = 0; i < 60; i++) {
      await service.save({ namespace: 'noisy', embedding: vec(0, i / 1000), tags: ['common'] });
    }
    const target = await service.save({ namespace: 'quiet', embedding: vec(0, 0.9) });
    const rare = await service.save({ namespace: 'noisy', embedding: vec(0, 0.8), tags: ['rare'] });

    expect(
      (await service.search(vec(0), 10, undefined, { namespace: 'quiet' })).map(r => r.id)
    ).toEqual([target.id]);
    expect((await service.search(vec(0), 5, ['rare'], { namespaces: '*' })).map(r => r.id)).toEqual(
      [rare.id]
    );
  });

  it('returns up to k results beyond the default ef_search', async () => {
    await open();
    for (let i = 0; i < 70; i++) {
      await service.save({ embedding: vec(i % VECTOR_DIMENSION, 0.5, 0) });
    }
    expect(await service.search(vec(0), 60)).toHaveLength(60);
  });

  // --- POLY-34 on Postgres ---

  it('matches list tags exactly', async () => {
    await open();
    await service.save({ markdown: 'p', tags: ['physics'] });
    await service.save({ markdown: 'q', tags: ['50%_"off"'] });
    expect((await service.list({ tags: ['phys_cs'] })).total).toBe(0);
    expect((await service.list({ tags: ['%'] })).total).toBe(0);
    expect((await service.list({ tags: ['physics'] })).total).toBe(1);
    expect((await service.list({ tags: ['50%_"off"'] })).total).toBe(1);
  });
});
