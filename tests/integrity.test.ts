import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import { closeDatabase, getAdapter, initializeDatabase, resetAdapter } from '../src/db/client.js';
import { resetConfig } from '../src/config.js';
import type { SqliteAdapter } from '../src/db/sqlite-adapter.js';
import { ValidationError, VersionConflictError } from '../src/errors/index.js';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

let service: ConceptService;

/** Unit vector pointing mostly along `dominant`, with a small `tilt` towards `towards`. */
function vec(dominant: number, tilt = 0, towards = (dominant + 1) % VECTOR_DIMENSION): number[] {
  const v = new Array<number>(VECTOR_DIMENSION).fill(0);
  v[dominant] = 1;
  v[towards] = (v[towards] ?? 0) + tilt;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function rawDb(): ReturnType<SqliteAdapter['getRawDb']> {
  return (getAdapter() as SqliteAdapter).getRawDb();
}

describe('Data integrity (SQLite)', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
  });

  afterEach(() => {
    teardownTestDb();
  });

  // --- POLY-02: expectedVersion must be enforced atomically ---

  describe('optimistic concurrency under concurrent writers', () => {
    it('lets exactly one of two concurrent expectedVersion=1 writers win', async () => {
      const id = '0a000000-0000-4000-a000-000000000001';
      await service.save({ id, markdown: 'v1' });

      const results = await Promise.allSettled([
        service.save({ id, expectedVersion: 1, markdown: 'writer A' }),
        service.save({ id, expectedVersion: 1, markdown: 'writer B' }),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);

      const winner = (fulfilled[0] as PromiseFulfilledResult<{ markdown: string | null }>).value;
      const final = await service.read(id);
      expect(final.version).toBe(2);
      expect(final.markdown).toBe(winner.markdown);
    });

    it('does not lose concurrent tag merges from writers without expectedVersion', async () => {
      const id = '0a000000-0000-4000-a000-000000000002';
      await service.save({ id, markdown: 'base', tags: ['base'] });

      await Promise.all([
        service.save({ id, tags: ['from-a'] }),
        service.save({ id, tags: ['from-b'] }),
      ]);

      const final = await service.read(id);
      expect(final.tags).toEqual(expect.arrayContaining(['base', 'from-a', 'from-b']));
      expect(final.version).toBe(3);
    });

    it('turns two concurrent creates of the same id into create + update', async () => {
      const id = '0a000000-0000-4000-a000-000000000003';
      const results = await Promise.allSettled([
        service.save({ id, markdown: 'first' }),
        service.save({ id, markdown: 'second' }),
      ]);
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      const final = await service.read(id);
      expect(final.version).toBe(2);
    });
  });

  // --- POLY-15: embedding validation and atomic save ---

  describe('embedding validation and atomic save', () => {
    it('rejects a wrong-dimension embedding and persists nothing', async () => {
      const id = '0b000000-0000-4000-a000-000000000001';
      await expect(service.save({ id, markdown: 'x', embedding: [1, 2, 3] })).rejects.toThrow(
        ValidationError
      );
      expect(await getAdapter().findConcept(id)).toBeNull();
    });

    it('rejects non-finite and float32-overflowing components', async () => {
      const nan = vec(0);
      nan[5] = Number.NaN;
      const inf = vec(0);
      inf[5] = Number.POSITIVE_INFINITY;
      const huge = vec(0);
      huge[5] = 1e39;
      for (const embedding of [nan, inf, huge]) {
        await expect(service.save({ embedding })).rejects.toThrow(ValidationError);
      }
      expect((await service.getStats()).conceptCount).toBe(0);
    });

    it('rejects a zero vector, which has no cosine direction', async () => {
      await expect(
        service.save({ embedding: new Array<number>(VECTOR_DIMENSION).fill(0) })
      ).rejects.toThrow(ValidationError);
    });

    it('leaves the stored concept untouched when an update carries a bad embedding', async () => {
      const id = '0b000000-0000-4000-a000-000000000002';
      await service.save({ id, markdown: 'keep me', embedding: vec(1) });
      await expect(service.save({ id, markdown: 'clobber', embedding: [1, 2, 3] })).rejects.toThrow(
        ValidationError
      );
      const after = await service.read(id);
      expect(after.version).toBe(1);
      expect(after.markdown).toBe('keep me');
    });

    it('rolls back the concept row when the vector write fails', async () => {
      const id = '0b000000-0000-4000-a000-000000000003';
      rawDb().exec('DROP TABLE concept_vectors');
      await expect(service.save({ id, markdown: 'x', embedding: vec(2) })).rejects.toThrow();
      expect(await getAdapter().findConcept(id)).toBeNull();
    });

    it('rejects creating a concept with no representation', async () => {
      await expect(service.save({ tags: ['empty'] })).rejects.toThrow(ValidationError);
      expect((await service.getStats()).conceptCount).toBe(0);
    });
  });

  // --- POLY-05: filters apply inside the KNN query, not after a global top-k ---

  describe('filtered KNN', () => {
    it('finds a namespace-scoped match even when another namespace crowds the query', async () => {
      for (let i = 0; i < 40; i++) {
        await service.save({ namespace: 'noisy', embedding: vec(0, i / 1000) });
      }
      const target = await service.save({ namespace: 'default', embedding: vec(0, 0.9) });

      const results = await service.search(vec(0), 10, undefined, { namespace: 'default' });
      expect(results.map(r => r.id)).toEqual([target.id]);
    });

    it('finds a tag-scoped match across namespaces even when untagged vectors crowd the query', async () => {
      for (let i = 0; i < 40; i++) {
        await service.save({ namespace: `ns-${i % 4}`, embedding: vec(0, i / 1000), tags: ['common'] });
      }
      const rare = await service.save({ namespace: 'ns-9', embedding: vec(0, 0.9), tags: ['rare'] });

      const results = await service.search(vec(0), 5, ['rare'], { namespaces: '*' });
      expect(results.map(r => r.id)).toEqual([rare.id]);
    });

    it('restricts a multi-namespace search to the listed namespaces', async () => {
      const a = await service.save({ namespace: 'a', embedding: vec(0, 0.1) });
      const b = await service.save({ namespace: 'b', embedding: vec(0, 0.2) });
      await service.save({ namespace: 'c', embedding: vec(0) });

      const results = await service.search(vec(0), 10, undefined, { namespaces: ['a', 'b'] });
      expect(results.map(r => r.id)).toEqual([a.id, b.id]);
    });

    it('matches tags exactly (no partial or wildcard matches)', async () => {
      await service.save({ embedding: vec(3), tags: ['physics'] });
      expect(await service.search(vec(3), 10, ['phys'])).toEqual([]);
      expect(await service.search(vec(3), 10, ['%'])).toEqual([]);
    });
  });

  // --- Score semantics (replaces L2 distance) ---

  describe('search scores', () => {
    it('returns cosine scores in [0, 1], best first', async () => {
      const same = await service.save({ embedding: vec(7) });
      const orthogonal = await service.save({ embedding: vec(8) });
      const opposite = await service.save({ embedding: vec(7).map(x => -x) });

      const results = await service.search(vec(7), 10);
      expect(results.map(r => r.id)).toEqual([same.id, orthogonal.id, opposite.id]);
      expect(results[0]!.score).toBeCloseTo(1, 5);
      expect(results[1]!.score).toBeCloseTo(0.5, 5);
      expect(results[2]!.score).toBeCloseTo(0, 5);
      for (const r of results) {
        expect(r).not.toHaveProperty('distance');
      }
    });

    it('breaks score ties by id, including at the k boundary', async () => {
      const ids = [
        '0c000000-0000-4000-a000-000000000005',
        '0c000000-0000-4000-a000-000000000003',
        '0c000000-0000-4000-a000-000000000001',
        '0c000000-0000-4000-a000-000000000004',
        '0c000000-0000-4000-a000-000000000002',
      ];
      for (const id of ids) {
        await service.save({ id, embedding: vec(9) });
      }
      const top3 = await service.search(vec(9), 3);
      expect(top3.map(r => r.id)).toEqual([...ids].sort().slice(0, 3));
    });
  });

  // --- POLY-34: list tag filter matches tags exactly ---

  describe('list tag filter', () => {
    it('does not treat LIKE metacharacters in tags as wildcards', async () => {
      await service.save({ markdown: 'p', tags: ['physics'] });
      expect((await service.list({ tags: ['phys_cs'] })).total).toBe(0);
      expect((await service.list({ tags: ['%'] })).total).toBe(0);
      expect((await service.list({ tags: ['phys'] })).total).toBe(0);
      expect((await service.list({ tags: ['physics'] })).total).toBe(1);
    });

    it('matches tags containing quotes and LIKE metacharacters literally', async () => {
      await service.save({ markdown: 'q', tags: ['50%_"off"'] });
      await service.save({ markdown: 'r', tags: ['50x_off'] });
      const result = await service.list({ tags: ['50%_"off"'] });
      expect(result.total).toBe(1);
      expect(result.concepts[0]!.tags).toEqual(['50%_"off"']);
    });
  });
});

describe('Migration from a 2.x SQLite database', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'polytician-migrate-'));
  });

  afterEach(() => {
    closeDatabase();
    resetAdapter();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds the vector index partitioned by namespace with cosine distance', async () => {
    const dbPath = join(dir, 'concepts.db');
    const legacy = new Database(dbPath);
    sqliteVec.load(legacy);
    legacy.exec(`
      CREATE TABLE concepts (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default', version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tags TEXT DEFAULT '[]',
        markdown TEXT, thoughtform TEXT, embedding BLOB);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE concept_vectors USING vec0(concept_id TEXT PRIMARY KEY, embedding float[384]);
    `);
    const insert = legacy.prepare(
      `INSERT INTO concepts (id, namespace, created_at, updated_at, markdown, embedding) VALUES (?, ?, 1, 1, ?, ?)`
    );
    const buf = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);
    const good = '0f000000-0000-4000-a000-000000000001';
    const corrupt = '0f000000-0000-4000-a000-000000000002';
    const other = '0f000000-0000-4000-a000-000000000003';
    insert.run(good, 'default', 'good', buf(vec(5)));
    insert.run(corrupt, 'default', 'corrupt', buf([1, 2, 3])); // left by a failed 2.x save
    insert.run(other, 'agent-b', 'other', buf(vec(5)));
    legacy
      .prepare('INSERT INTO concept_vectors (concept_id, embedding) VALUES (?, ?)')
      .run(good, buf(vec(5)));
    legacy.close();

    resetConfig();
    resetAdapter();
    initializeDatabase(dbPath);
    const migrated = new ConceptService();

    const schema = (
      rawDb()
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'concept_vectors'")
        .get() as { sql: string }
    ).sql;
    expect(schema).toMatch(/partition key/);
    expect(schema).toMatch(/distance_metric=cosine/);

    const results = await migrated.search(vec(5), 10);
    expect(results.map(r => r.id)).toEqual([good]);
    expect(results[0]!.score).toBeCloseTo(1, 5);
    expect((await migrated.search(vec(5), 10, undefined, { namespace: 'agent-b' })).map(r => r.id)).toEqual([other]);

    const repaired = await migrated.read(corrupt);
    expect(repaired.embedding).toBeUndefined();
    expect(repaired.markdown).toBe('corrupt');
    expect(repaired.derived).toEqual({});
  });
});
