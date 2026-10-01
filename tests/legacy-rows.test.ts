/**
 * Rows written by 2.x under its looser rules (POLY3-R01, POLY-R1, POLY-R2):
 * after the first 3.0 start they must stay readable through every tool, and
 * a 3.0 backup of them must restore. 2.x accepted any JSON as a thoughtform,
 * any number and length of tags, any namespace string, any id, markdown of
 * any size and concepts with no representation; a 2.x CLI restore stored
 * tags as a JSON-encoded string.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

vi.mock('@huggingface/transformers', () => {
  const mockPipeline = async (text: string) => {
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) data[i] = Math.sin(hash + i) * 0.5 + 0.01;
    return { data };
  };
  return { pipeline: vi.fn().mockResolvedValue(mockPipeline), env: { cacheDir: '' } };
});

import { closeDatabase, getAdapter, initializeDatabase, resetAdapter } from '../src/db/client.js';
import { resetConfig } from '../src/config.js';
import type { SqliteAdapter } from '../src/db/sqlite-adapter.js';
import { ConceptService } from '../src/services/concept.service.js';
import { exportBackup, importBackup } from '../src/services/backup.service.js';
import { conversionService } from '../src/services/conversion.service.js';
import { OverwriteRefusedError } from '../src/errors/index.js';

function vec(dominant: number): number[] {
  const v = new Array<number>(VECTOR_DIMENSION).fill(0);
  v[dominant] = 1;
  return v;
}

const buf = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);

const FREE_FORM = '0e000000-0000-4000-a000-000000000001';
const MANY_TAGS = '0e000000-0000-4000-a000-000000000002';
const LONG_TAG = '0e000000-0000-4000-a000-000000000003';
const STRING_TAGS = '0e000000-0000-4000-a000-000000000004';
const NULL_TAGS = '0e000000-0000-4000-a000-000000000005';
const BIG_MARKDOWN = '0e000000-0000-4000-a000-000000000006';
const SPACED_NS = '0e000000-0000-4000-a000-000000000007';
const NO_REPRESENTATION = '0e000000-0000-4000-a000-000000000008';
const NOT_A_UUID = 'notes/2024-q3';
const PLAIN = '0e000000-0000-4000-a000-000000000009';

const SEVENTY_TAGS = Array.from({ length: 70 }, (_, i) => `t${i}`);
const TAG_200 = 'x'.repeat(200);

let dir: string;
let service: ConceptService;

/** A 2.x database holding one row of each shape 2.x accepted and 3.0's write rules refuse. */
function seedLegacyDatabase(dbPath: string): void {
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
    `INSERT INTO concepts (id, namespace, version, created_at, updated_at, tags, markdown, thoughtform, embedding)
     VALUES (?, ?, 2, 1000, 2000, ?, ?, ?, ?)`
  );
  const tf = JSON.stringify({ summary: 'any JSON', entities: ['x'] });
  insert.run(FREE_FORM, 'default', '["a"]', 'free-form thoughtform', tf, buf(vec(1)));
  insert.run(MANY_TAGS, 'default', JSON.stringify(SEVENTY_TAGS), 'seventy tags', null, null);
  insert.run(LONG_TAG, 'default', JSON.stringify([TAG_200, '']), 'long and empty tag', null, null);
  // What a 2.x `agentvault-sync restore` of a 2.x auto-backup stored.
  insert.run(STRING_TAGS, 'default', JSON.stringify('["b","c"]'), 'string tags', null, buf(vec(2)));
  insert.run(NULL_TAGS, 'default', null, 'null tags', null, null);
  insert.run(BIG_MARKDOWN, 'default', '[]', 'm'.repeat(1_000_001), null, null);
  insert.run(SPACED_NS, 'my notes', '[]', 'spaced namespace', null, buf(vec(3)));
  insert.run(NO_REPRESENTATION, 'default', '["only-tags"]', null, null, null);
  insert.run(NOT_A_UUID, 'default', '[]', 'pulled by 2.x vault_memory_pull', null, null);
  insert.run(PLAIN, 'default', '["ok"]', 'plain', null, null);
  legacy.close();
}

const ALL_IDS = [
  FREE_FORM,
  MANY_TAGS,
  LONG_TAG,
  STRING_TAGS,
  NULL_TAGS,
  BIG_MARKDOWN,
  SPACED_NS,
  NO_REPRESENTATION,
  NOT_A_UUID,
  PLAIN,
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polytician-legacy-'));
  process.env['POLYTICIAN_DATA_DIR'] = dir;
  resetConfig();
  resetAdapter();
  const dbPath = join(dir, 'concepts.db');
  seedLegacyDatabase(dbPath);
  initializeDatabase(dbPath);
  service = new ConceptService();
});

afterEach(() => {
  closeDatabase();
  resetAdapter();
  delete process.env['POLYTICIAN_DATA_DIR'];
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('2.x tags stored as a JSON string (POLY-R2)', () => {
  it('are rewritten as an array by the first start', () => {
    const db = (getAdapter() as SqliteAdapter).getRawDb();
    const rows = db
      .prepare('SELECT id, tags FROM concepts WHERE id IN (?, ?)')
      .all(STRING_TAGS, NULL_TAGS) as Array<{ id: string; tags: string }>;
    expect(Object.fromEntries(rows.map(r => [r.id, r.tags]))).toEqual({
      [STRING_TAGS]: '["b","c"]',
      [NULL_TAGS]: '[]',
    });
  });

  it('read, list, search and tag merges see an array', async () => {
    expect((await service.read(STRING_TAGS)).tags).toEqual(['b', 'c']);
    expect((await service.read(NULL_TAGS)).tags).toEqual([]);
    const listed = await service.list({ limit: 100 });
    for (const c of listed.concepts) expect(Array.isArray(c.tags)).toBe(true);
    expect((await service.list({ tags: ['b'] })).concepts.map(c => c.id)).toEqual([STRING_TAGS]);
    const hits = await service.search(vec(2), 1);
    expect(hits[0]).toMatchObject({ id: STRING_TAGS, tags: ['b', 'c'] });
    const merged = await service.save({ id: STRING_TAGS, tags: ['d'] });
    expect(merged.tags).toEqual(['b', 'c', 'd']);
  });

  it('a row written with string tags after the first start still reads as an array', async () => {
    await getAdapter().updateConcept(PLAIN, { tags: JSON.stringify('["late"]') });
    expect((await service.read(PLAIN)).tags).toEqual(['late']);
    expect((await service.list({ limit: 100 })).concepts.find(c => c.id === PLAIN)?.tags).toEqual([
      'late',
    ]);
    expect((await service.save({ id: PLAIN, tags: ['more'] })).tags).toEqual(['late', 'more']);
  });
});

describe('a 3.0 backup of a migrated 2.x store (POLY3-R01, POLY-R1)', () => {
  it('restores every row exactly as it was stored', async () => {
    const before = await Promise.all(ALL_IDS.map(id => service.read(id)));
    const exported = await exportBackup();
    expect(exported.conceptCount).toBe(ALL_IDS.length);

    for (const id of ALL_IDS) await service.delete(id);
    expect((await getAdapter().listConcepts({ limit: 100, offset: 0 })).total).toBe(0);

    const result = await importBackup(exported.file);
    expect(result).toMatchObject({ inserted: ALL_IDS.length, updated: 0, skipped: [] });
    const after = await Promise.all(ALL_IDS.map(id => service.read(id)));
    expect(after).toEqual(before);

    // Restored vectors are searchable in their own namespace partition.
    expect((await service.search(vec(3), 1, undefined, { namespace: 'my notes' }))[0]?.id).toBe(
      SPACED_NS
    );
    expect((await service.search(vec(1), 1))[0]?.id).toBe(FREE_FORM);
  });

  it('restores a legacy row over a newer-dated copy only by the usual conflict rules', async () => {
    const { file } = await exportBackup();
    await service.save({ id: FREE_FORM, markdown: 'edited in 3.0' });
    const kept = await importBackup(file);
    expect(kept.skipped).toContainEqual({ id: FREE_FORM, namespace: 'default', reason: 'not-newer' });
    const replaced = await importBackup(file, { onConflict: 'overwrite' });
    expect(replaced.updated).toBe(ALL_IDS.length);
    expect((await service.read(FREE_FORM)).thoughtform).toEqual({
      summary: 'any JSON',
      entities: ['x'],
    });
  });
});

describe('a vector stored by 2.x (POLY-R3, as MIGRATION.md documents it)', () => {
  it('counts as authored until it is re-derived once with overwrite', async () => {
    const original = (await service.read(FREE_FORM)).embedding;
    expect((await service.read(FREE_FORM)).provenance).toEqual({});

    // Auto-embedding never replaces an authored vector, so the edit keeps it.
    await service.save({ id: FREE_FORM, markdown: 'edited after the upgrade', autoEmbed: true });
    expect((await service.read(FREE_FORM)).embedding).toEqual(original);
    await expect(conversionService.convert(FREE_FORM, 'markdown', 'vector')).rejects.toBeInstanceOf(
      OverwriteRefusedError
    );

    await conversionService.convert(FREE_FORM, 'markdown', 'vector', { overwrite: true });
    const rederived = await service.read(FREE_FORM);
    expect(rederived.embedding).not.toEqual(original);
    expect(rederived.provenance?.vector).toMatchObject({ origin: 'derived', derivedFrom: 'markdown' });

    // From then on, editing the markdown re-derives the vector.
    await service.save({ id: FREE_FORM, markdown: 'edited again', autoEmbed: true });
    expect((await service.read(FREE_FORM)).embedding).not.toEqual(rederived.embedding);
  });
});
