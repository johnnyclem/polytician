/**
 * PostgreSQL + pgvector adapter tests.
 *
 * Skipped unless POLYTICIAN_TEST_POSTGRES_URL points at a disposable database
 * with the pgvector extension available, e.g.
 *   POLYTICIAN_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/polytest npx vitest run tests/postgres-adapter.test.ts
 * The tests drop and recreate Polytician's tables in that database.
 */
import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  initializeDatabaseAsync,
  closeDatabase,
  getAdapter,
  resetAdapter,
} from '../src/db/client.js';
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
    // Tags as a 2.x `agentvault-sync restore` stored them (POLY-R2), and NULL.
    const stringTags = '0d000000-0000-4000-a000-000000000011';
    const nullTags = '0d000000-0000-4000-a000-000000000012';
    await admin.query(
      `INSERT INTO concepts (id, created_at, updated_at, tags, markdown) VALUES ($1, 1, 1, $2, 's'), ($3, 1, 1, NULL, 'n')`,
      [stringTags, JSON.stringify('["b","c"]'), nullTags]
    );

    await open();
    expect((await service.read(stringTags)).tags).toEqual(['b', 'c']);
    expect((await service.read(nullTags)).tags).toEqual([]);
    expect((await service.list({ tags: ['b'] })).concepts.map(c => c.id)).toEqual([stringTags]);
    const stored = await admin.query<{ tags: string }>(
      'SELECT tags FROM concepts WHERE id = ANY($1) ORDER BY id',
      [[stringTags, nullTags]]
    );
    expect(stored.rows.map(r => r.tags)).toEqual(['["b","c"]', '[]']);

    const { rows } = await admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'concept_vectors'"
    );
    expect(rows.some(r => r.indexdef.toLowerCase().includes('ivfflat'))).toBe(false);
    const results = await service.search(vec(4), 5);
    expect(results.map(r => r.id)).toEqual([id]);
    expect(results[0]!.score).toBeCloseTo(1, 5);
    const read = await service.read(id);
    expect(read.provenance).toEqual({});
    expect(read).toMatchObject({ assertionStatus: null, ledgerRef: null });
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

  it('stores provenance and assertion status, and filters search and list by status', async () => {
    await open();
    for (let i = 0; i < 60; i++) {
      await service.save({ embedding: vec(0, i / 1000), assertionStatus: i % 2 ? 'contested' : null });
    }
    const verified = await service.save({
      markdown: 'verified fact',
      embedding: vec(0, 0.9),
      source: { origin: 'import', createdBy: 'stenographer' },
      assertionStatus: 'verified',
      ledgerRef: 'stenographer:wiki#tb-1',
    });
    expect(await service.read(verified.id)).toMatchObject({
      assertionStatus: 'verified',
      ledgerRef: 'stenographer:wiki#tb-1',
      provenance: {
        markdown: { origin: 'import', createdBy: 'stenographer' },
        vector: { origin: 'import', createdBy: 'stenographer' },
      },
    });
    const hits = await service.search(vec(0), 1, undefined, { assertionStatus: ['verified'] });
    expect(hits.map(h => [h.id, h.assertionStatus])).toEqual([[verified.id, 'verified']]);
    expect((await service.list({ assertionStatus: ['contested'] })).total).toBe(30);

    await service.save({ id: verified.id, namespace: 'default', assertionStatus: null });
    expect((await service.read(verified.id)).assertionStatus).toBeNull();
  });

  it('finds a small filtered namespace behind a crowd when the iterative scan gives up (POLY3-R05)', async () => {
    // pgvector ends an iterative HNSW scan after hnsw.max_scan_tuples
    // (20,000 by default); a low limit and no explicit sorts reproduce, on a
    // small table, a large table whose crowd of near vectors hides the matches.
    const { rows: db } = await admin.query<{ db: string }>('SELECT current_database() AS db');
    const database = `"${db[0]!.db}"`;
    await admin.query(`ALTER DATABASE ${database} SET hnsw.max_scan_tuples = 100`);
    await admin.query(`ALTER DATABASE ${database} SET enable_sort = off`);
    try {
      await searchBehindCrowd();
    } finally {
      await admin.query(`ALTER DATABASE ${database} RESET hnsw.max_scan_tuples`);
      await admin.query(`ALTER DATABASE ${database} RESET enable_sort`);
    }
  });

  async function searchBehindCrowd(): Promise<void> {
    await open();
    const model = getConfig().embeddingModel;
    await admin.query(
      `INSERT INTO concepts (id, namespace, created_at, updated_at, tags, markdown, embedding, embedding_model)
       SELECT 'big-' || i, 'big', 1, 1, '[]', 'near', '\\x00'::bytea, $1 FROM generate_series(1, 2000) i`,
      [model]
    );
    await admin.query(
      `INSERT INTO concept_vectors (concept_id, embedding)
       SELECT 'big-' || i, ('[1,' || (i / 100000.0)::text || repeat(',0', ${VECTOR_DIMENSION - 2}) || ']')::vector
       FROM generate_series(1, 2000) i`
    );
    await admin.query('ANALYZE concepts');
    await admin.query('ANALYZE concept_vectors');
    const far = [];
    for (let i = 0; i < 3; i++) far.push((await service.save({ namespace: 'small', embedding: vec(10 + i) })).id);

    const hits = await service.search(vec(0), 3, undefined, { namespace: 'small' });
    expect(hits.map(h => h.id).sort()).toEqual([...far].sort());
  }

  it('refuses a stale update once its id was re-created in another namespace (POLY3-R03)', async () => {
    await open();
    const id = '0d000000-0000-4000-a000-000000000005';
    await service.save({ id, namespace: 'a', markdown: 'from a', embedding: vec(1) });
    const stale = {
      kind: 'update' as const,
      id,
      namespace: 'a',
      expectedVersion: 1,
      fields: {
        version: 2,
        updated_at: Date.now(),
        markdown: 'written from a',
        embedding: Buffer.from(new Float32Array(vec(2)).buffer),
      },
    };
    await service.delete(id, { namespace: 'a' });
    await service.save({ id, namespace: 'b', markdown: 'from b', embedding: vec(3) });

    expect(await getAdapter().applyWrites([stale])).toEqual({ ok: false, index: 0 });
    expect(await service.read(id)).toMatchObject({ namespace: 'b', markdown: 'from b' });
    expect(await service.search(vec(2), 5, undefined, { namespace: 'a' })).toEqual([]);
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

  // --- The agentvault-sync CLI on Postgres (the Compose / Kubernetes backend) ---

  it('backs up and restores a Postgres store with the agentvault-sync CLI', async () => {
    await open();
    const a = await service.save({ embedding: vec(7), markdown: 'a', namespace: 'default' });
    const b = await service.save({ markdown: 'b', tags: ['t'], namespace: 'work' });
    await closeDatabase();
    resetAdapter();

    const dataDir = mkdtempSync(join(tmpdir(), 'pg-cli-'));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const file = join(dataDir, 'drill.jsonl');
    const cli = (args: string): string =>
      execSync(`npx tsx bin/agentvault-sync.ts ${args}`, {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf-8',
        env: {
          ...process.env,
          POLYTICIAN_DATA_DIR: dataDir,
          POLYTICIAN_DB_BACKEND: 'postgres',
          POLYTICIAN_POSTGRES_URL: PG_URL!,
        },
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    expect(cli(`backup --out ${file}`)).toContain('wrote 2 concepts (default=1, work=1)');
    await dropAll();
    expect(cli(`restore --file ${file}`)).toContain('imported 2 concepts (2 new, 0 replaced)');

    await open();
    expect(await service.read(b.id, undefined, { namespace: 'work' })).toMatchObject({
      markdown: 'b',
      tags: ['t'],
    });
    expect((await service.search(vec(7), 5)).map(r => r.id)).toEqual([a.id]);
  }, 60_000);
});
