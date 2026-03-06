import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRestoreE2E, runBackupE2E, type RestoreE2EOptions, type BackupE2EOptions } from '../src/commands/polyvault/e2e.js';
import type { RestoreClient, CommitRecord, ChunkRecord } from '../src/lib/polyvault/download.js';
import type { CanisterResult, CanisterClient, FinalizeResult, PutChunkRequest } from '../src/lib/polyvault/upload.js';
import type { FaissRebuildClient, FaissRebuildResult, FaissRebuildMode } from '../src/lib/polyvault/faiss-client.js';
import type { DatabaseAdapter, ConceptRow, ListRow, VectorResult, ConceptMetaRow, StatsResult } from '../src/db/adapter.js';
import type { ThoughtFormV1 } from '../src/schemas/thoughtform.js';
import { serializeBundle } from '../src/polyvault/serializer.js';
import { chunkPayload } from '../src/polyvault/chunker.js';
import { sha256String } from '../src/polyvault/hash.js';

// --- Fixtures ---

const CONTENT_HASH = 'a'.repeat(64);

function makeThoughtForm(id: string, updatedAt = 1730000000000, rawText = 'hello'): ThoughtFormV1 {
  return {
    schemaVersion: '1.0',
    id,
    entities: [{ id: 'e1', type: 'concept', value: rawText }],
    relationships: [],
    contextGraph: {},
    metadata: {
      createdAtMs: 1730000000000,
      updatedAtMs: updatedAt,
      source: 'test',
      contentHash: sha256String(`${id}:${rawText}`),
      redaction: { rawTextOmitted: false },
    },
    rawText,
  } as ThoughtFormV1;
}

// --- In-memory DB adapter stub ---

class InMemoryDbAdapter implements DatabaseAdapter {
  private concepts = new Map<string, ConceptRow>();

  initialize(): void { /* no-op */ }
  close(): void { /* no-op */ }

  findConcept(id: string): ConceptRow | null {
    return this.concepts.get(id) ?? null;
  }

  insertConcept(row: ConceptRow): void {
    this.concepts.set(row.id, row);
  }

  updateConcept(id: string, fields: Record<string, unknown>): void {
    const existing = this.concepts.get(id);
    if (!existing) return;
    this.concepts.set(id, { ...existing, ...fields } as ConceptRow);
  }

  deleteConcept(id: string): void {
    this.concepts.delete(id);
  }

  listConcepts(params: { limit: number; offset: number; tags?: string[]; namespace?: string }): { rows: ListRow[]; total: number } {
    const allRows = Array.from(this.concepts.values());
    const filtered = allRows.filter(r => {
      if (params.namespace && r.namespace !== params.namespace) return false;
      return true;
    });
    const total = filtered.length;
    const page = filtered.slice(params.offset, params.offset + params.limit);
    return {
      rows: page.map(c => ({
        id: c.id,
        namespace: c.namespace,
        version: c.version,
        created_at: c.created_at,
        updated_at: c.updated_at,
        tags: c.tags,
        has_md: c.markdown ? 1 : 0,
        has_tf: c.thoughtform ? 1 : 0,
        has_vec: c.embedding ? 1 : 0,
      })),
      total,
    };
  }

  upsertVector(_id: string, _embedding: Buffer): void { /* no-op */ }
  deleteVector(_id: string): void { /* no-op */ }
  vectorSearch(_queryEmbedding: Buffer, _k: number): VectorResult[] { return []; }
  findConceptMeta(ids: string[]): ConceptMetaRow[] {
    return ids.map(id => {
      const c = this.concepts.get(id);
      return c ? { id: c.id, namespace: c.namespace, tags: c.tags, has_md: c.markdown ? 1 : 0, has_tf: c.thoughtform ? 1 : 0, has_vec: c.embedding ? 1 : 0 } : null;
    }).filter(Boolean) as ConceptMetaRow[];
  }
  getStats(_namespace?: string): StatsResult {
    return { conceptCount: this.concepts.size, vectorCount: 0, mdCount: 0, tfCount: 0, vecCount: 0 };
  }

  // Test helpers
  getAll(): ConceptRow[] { return Array.from(this.concepts.values()); }
  count(): number { return this.concepts.size; }
}

// --- Mock FAISS client ---

function createMockFaissClient(): FaissRebuildClient & { calls: Array<{ thoughtforms: ThoughtFormV1[]; mode: FaissRebuildMode }> } {
  const calls: Array<{ thoughtforms: ThoughtFormV1[]; mode: FaissRebuildMode }> = [];
  return {
    calls,
    async rebuildIndex(thoughtforms: ThoughtFormV1[], mode: FaissRebuildMode): Promise<FaissRebuildResult> {
      calls.push({ thoughtforms, mode });
      return { rebuilt: true, vectorCount: thoughtforms.length };
    },
  };
}

// --- Mock restore client that serves pre-built bundles ---

function buildBundleChunks(thoughtforms: ThoughtFormV1[]): { commit: CommitRecord; chunks: ChunkRecord[] } {
  const sorted = [...thoughtforms].sort((a, b) => a.metadata.updatedAtMs - b.metadata.updatedAtMs);

  const contentFingerprint = sorted.map(tf => tf.metadata.contentHash).join(':');
  const dedupeKey = sha256String(contentFingerprint + ':none:none');
  const bundleId = `bndl_${dedupeKey.slice(0, 32)}`;
  const commitId = `cmt_${dedupeKey.slice(0, 64)}`;

  const bundle = {
    version: '1.0',
    bundleId,
    commit: {
      commitId,
      parentCommitId: null,
      createdAtMs: Date.now(),
      syncMode: 'backup',
      dedupeKey,
    },
    manifest: {
      thoughtformCount: sorted.length,
      payloadHash: '',
      compression: 'none',
      encryption: 'none',
      chunkCount: 1,
      chunkSizeMaxBytes: 1_000_000,
    },
    delta: {
      sinceUpdatedAtMsExclusive: 0,
      untilUpdatedAtMsInclusive: Math.max(...sorted.map(tf => tf.metadata.updatedAtMs)),
    },
    thoughtforms: sorted,
  };

  const { bytes, payloadHash } = serializeBundle(bundle as any);
  const rawChunks = chunkPayload(bytes, { maxChunkSize: 1_000_000 });

  const commit: CommitRecord = {
    commitId,
    parentCommitId: null,
    dedupeKey,
    manifestHash: payloadHash,
    chunkCount: rawChunks.length,
    createdAtMs: Date.now(),
  };

  const chunkRecords: ChunkRecord[] = rawChunks.map(c => ({
    bundleId,
    chunkIndex: c.chunkIndex,
    chunkCount: c.chunkCount,
    chunkHash: c.chunkHash,
    compressed: false,
    encrypted: false,
    payload: c.payload,
  }));

  return { commit, chunks: chunkRecords };
}

function createMockRestoreClient(bundles: Array<{ commit: CommitRecord; chunks: ChunkRecord[] }>): RestoreClient {
  return {
    async listCommits(sinceCreatedAtMs: number, limit: number, cursor: string | null): Promise<CanisterResult<{ commits: CommitRecord[]; nextCursor: string | null }>> {
      const filtered = bundles
        .map(b => b.commit)
        .filter(c => c.createdAtMs > sinceCreatedAtMs);
      return { ok: true, value: { commits: filtered, nextCursor: null } };
    },
    async getChunksForCommit(commitId: string, offset: number, limit: number): Promise<CanisterResult<{ chunks: ChunkRecord[]; nextOffset: number | null }>> {
      const bundle = bundles.find(b => b.commit.commitId === commitId);
      if (!bundle) return { ok: true, value: { chunks: [], nextOffset: null } };
      return { ok: true, value: { chunks: bundle.chunks, nextOffset: null } };
    },
  };
}

// --- Mock canister client for backup ---

function createMockCanisterClient(): CanisterClient & { uploadedChunks: PutChunkRequest[]; finalized: boolean } {
  const uploadedChunks: PutChunkRequest[] = [];
  let finalized = false;
  return {
    uploadedChunks,
    get finalized() { return finalized; },
    async putChunk(req: PutChunkRequest): Promise<CanisterResult<void>> {
      uploadedChunks.push(req);
      return { ok: true, value: undefined };
    },
    async finalizeCommit(): Promise<CanisterResult<FinalizeResult>> {
      finalized = true;
      return { ok: true, value: { accepted: true, duplicateOf: null } };
    },
    async getLatestCommit(): Promise<{ commitId: string; createdAtMs: number } | null> {
      return null;
    },
  };
}

// --- Test suite ---

describe('PolyVault E2E Restore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'polyvault-e2e-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores ThoughtForms into SQLite and triggers FAISS rebuild', async () => {
    const tf1 = makeThoughtForm('tf_1', 1730000000001, 'first concept');
    const tf2 = makeThoughtForm('tf_2', 1730000000002, 'second concept');

    const bundle = buildBundleChunks([tf1, tf2]);
    const client = createMockRestoreClient([bundle]);
    const db = new InMemoryDbAdapter();
    const faiss = createMockFaissClient();

    const outPath = join(tmpDir, 'restored.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    const { result, exitCode } = await runRestoreE2E(client, db, faiss, options);

    expect(exitCode).toBe(0);
    expect(result.restore.status).toBe('ok');
    expect(result.restore.thoughtformCount).toBe(2);

    // SQLite upsert worked
    expect(result.upsert).not.toBeNull();
    expect(result.upsert!.totalProcessed).toBe(2);
    expect(result.upsert!.inserted).toBe(2);
    expect(db.count()).toBe(2);

    // FAISS rebuild was called
    expect(result.faiss).not.toBeNull();
    expect(result.faiss!.rebuilt).toBe(true);
    expect(result.faiss!.vectorCount).toBe(2);
    expect(faiss.calls).toHaveLength(1);
    expect(faiss.calls[0]!.mode).toBe('replace');
  });

  it('handles empty restore (no commits)', async () => {
    const client = createMockRestoreClient([]);
    const db = new InMemoryDbAdapter();
    const faiss = createMockFaissClient();

    const outPath = join(tmpDir, 'empty.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    const { result, exitCode } = await runRestoreE2E(client, db, faiss, options);

    expect(exitCode).toBe(0);
    expect(result.restore.status).toBe('empty');
    expect(result.upsert).toBeNull();
    expect(result.faiss).toBeNull();
    expect(db.count()).toBe(0);
    expect(faiss.calls).toHaveLength(0);
  });

  it('skips FAISS rebuild when no faiss client provided', async () => {
    const tf = makeThoughtForm('tf_solo', 1730000000001, 'solo');
    const bundle = buildBundleChunks([tf]);
    const client = createMockRestoreClient([bundle]);
    const db = new InMemoryDbAdapter();

    const outPath = join(tmpDir, 'no-faiss.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    const { result, exitCode } = await runRestoreE2E(client, db, null, options);

    expect(exitCode).toBe(0);
    expect(result.upsert!.inserted).toBe(1);
    expect(result.faiss).toBeNull();
  });

  it('idempotent restore does not duplicate rows', async () => {
    const tf = makeThoughtForm('tf_idem', 1730000000001, 'idempotent');
    const bundle = buildBundleChunks([tf]);
    const client = createMockRestoreClient([bundle]);
    const db = new InMemoryDbAdapter();

    const outPath = join(tmpDir, 'idem.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    // First restore
    await runRestoreE2E(client, db, null, options);
    expect(db.count()).toBe(1);

    // Second restore — same data, idempotent (equal timestamps → update, not skip)
    const { result } = await runRestoreE2E(client, db, null, options);
    expect(db.count()).toBe(1);
    expect(result.upsert!.updated).toBe(1);
    expect(result.upsert!.inserted).toBe(0);
  });

  it('upserts newer ThoughtForms over older ones', async () => {
    const db = new InMemoryDbAdapter();

    // Seed with older version
    const oldTf = makeThoughtForm('tf_update', 1730000000001, 'old text');
    const oldBundle = buildBundleChunks([oldTf]);
    const oldClient = createMockRestoreClient([oldBundle]);

    const outPath = join(tmpDir, 'update.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    await runRestoreE2E(oldClient, db, null, options);
    expect(db.count()).toBe(1);
    const v1 = db.findConcept('tf_update');
    expect(v1?.markdown).toBe('old text');

    // Restore newer version
    const newTf = makeThoughtForm('tf_update', 1730000000999, 'new text');
    const newBundle = buildBundleChunks([newTf]);
    const newClient = createMockRestoreClient([newBundle]);

    const { result } = await runRestoreE2E(newClient, db, null, options);
    expect(result.upsert!.updated).toBe(1);
    const v2 = db.findConcept('tf_update');
    expect(v2?.markdown).toBe('new text');
  });

  it('does not overwrite newer local data (local-first policy)', async () => {
    const db = new InMemoryDbAdapter();

    // Seed with newer local version
    const localTf = makeThoughtForm('tf_local', 1730000099999, 'local latest');
    const localBundle = buildBundleChunks([localTf]);
    const localClient = createMockRestoreClient([localBundle]);

    const outPath = join(tmpDir, 'local-first.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    await runRestoreE2E(localClient, db, null, options);

    // Try to restore older remote version
    const remoteTf = makeThoughtForm('tf_local', 1730000000001, 'remote older');
    const remoteBundle = buildBundleChunks([remoteTf]);
    const remoteClient = createMockRestoreClient([remoteBundle]);

    const { result } = await runRestoreE2E(remoteClient, db, null, options);
    expect(result.upsert!.skipped).toBe(1);
    const concept = db.findConcept('tf_local');
    expect(concept?.markdown).toBe('local latest');
  });

  it('uses incremental mode with sinceCommitCreatedAtMs filter', async () => {
    const tf = makeThoughtForm('tf_inc', 1730000000001);
    const bundle = buildBundleChunks([tf]);
    // Set commit timestamp in the past
    bundle.commit.createdAtMs = 1000;
    const client = createMockRestoreClient([bundle]);
    const db = new InMemoryDbAdapter();

    const outPath = join(tmpDir, 'incremental.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'incremental',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 2000, // After the commit timestamp
      faissMode: 'upsert',
    };

    const { result, exitCode } = await runRestoreE2E(client, db, null, options);
    expect(exitCode).toBe(0);
    expect(result.restore.status).toBe('empty');
    expect(db.count()).toBe(0);
  });

  it('handles FAISS rebuild failure gracefully', async () => {
    const tf = makeThoughtForm('tf_faiss_fail', 1730000000001);
    const bundle = buildBundleChunks([tf]);
    const client = createMockRestoreClient([bundle]);
    const db = new InMemoryDbAdapter();

    const failingFaiss: FaissRebuildClient = {
      async rebuildIndex(): Promise<FaissRebuildResult> {
        throw new Error('Sidecar unreachable');
      },
    };

    const outPath = join(tmpDir, 'faiss-fail.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    const { result, exitCode } = await runRestoreE2E(client, db, failingFaiss, options);

    // SQLite upsert succeeded, but FAISS failed
    expect(exitCode).toBe(4);
    expect(result.upsert).not.toBeNull();
    expect(result.upsert!.inserted).toBe(1);
    expect(result.faiss).toBeNull();
    expect(db.count()).toBe(1);
  });
});

describe('PolyVault E2E Backup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'polyvault-e2e-backup-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backs up ThoughtForms from a JSON file', async () => {
    const tf1 = makeThoughtForm('tf_b1', 1730000000001, 'backup me');
    const tf2 = makeThoughtForm('tf_b2', 1730000000002, 'backup me too');
    const inputPath = join(tmpDir, 'input.json');
    writeFileSync(inputPath, JSON.stringify([tf1, tf2]));

    const client = createMockCanisterClient();
    const db = new InMemoryDbAdapter();

    const options: BackupE2EOptions = {
      from: inputPath,
      compress: 'none',
      encrypt: 'none',
      encryptionRequired: false,
      chunkSize: 1_000_000,
      sinceUpdatedAt: 0,
      out: join(tmpDir, 'manifest.json'),
    };

    const { result, exitCode } = await runBackupE2E(client, db, options);

    expect(exitCode).toBe(0);
    expect(result.backup.status).toBe('ok');
    expect(result.backup.thoughtformCount).toBe(2);
    expect(result.backup.chunksUploaded).toBeGreaterThan(0);
    expect(client.finalized).toBe(true);
  });

  it('reads ThoughtForms from SQLite when from=__sqlite__', async () => {
    // Seed DB with ThoughtForms
    const db = new InMemoryDbAdapter();
    const tf1 = makeThoughtForm('tf_db1', 1730000000001, 'from db one');
    const tf2 = makeThoughtForm('tf_db2', 1730000000002, 'from db two');

    db.insertConcept({
      id: 'tf_db1',
      namespace: 'default',
      version: 1,
      created_at: 1730000000000,
      updated_at: 1730000000001,
      tags: '["concept"]',
      markdown: 'from db one',
      thoughtform: JSON.stringify(tf1),
      embedding: null,
    });
    db.insertConcept({
      id: 'tf_db2',
      namespace: 'default',
      version: 1,
      created_at: 1730000000000,
      updated_at: 1730000000002,
      tags: '["concept"]',
      markdown: 'from db two',
      thoughtform: JSON.stringify(tf2),
      embedding: null,
    });

    const client = createMockCanisterClient();
    const outPath = join(tmpDir, 'manifest.json');

    const options: BackupE2EOptions = {
      from: '__sqlite__',
      compress: 'none',
      encrypt: 'none',
      encryptionRequired: false,
      chunkSize: 1_000_000,
      sinceUpdatedAt: 0,
      out: outPath,
    };

    const { result, exitCode } = await runBackupE2E(client, db, options);

    expect(exitCode).toBe(0);
    expect(result.backup.status).toBe('ok');
    expect(result.conceptsRead).toBe(2);
    expect(result.backup.thoughtformCount).toBe(2);
    expect(client.finalized).toBe(true);
  });

  it('returns empty result when SQLite has no ThoughtForms', async () => {
    const db = new InMemoryDbAdapter();
    const client = createMockCanisterClient();

    const options: BackupE2EOptions = {
      from: '__sqlite__',
      compress: 'none',
      encrypt: 'none',
      encryptionRequired: false,
      chunkSize: 1_000_000,
      sinceUpdatedAt: 0,
    };

    const { result, exitCode } = await runBackupE2E(client, db, options);

    expect(exitCode).toBe(0);
    expect(result.backup.status).toBe('ok');
    expect(result.conceptsRead).toBe(0);
    expect(result.backup.thoughtformCount).toBe(0);
    expect(client.finalized).toBe(false);
  });

  it('filters by sinceUpdatedAt when reading from SQLite', async () => {
    const db = new InMemoryDbAdapter();
    const tfOld = makeThoughtForm('tf_old', 1000, 'old');
    const tfNew = makeThoughtForm('tf_new', 9999, 'new');

    db.insertConcept({
      id: 'tf_old', namespace: 'default', version: 1,
      created_at: 1000, updated_at: 1000, tags: '[]',
      markdown: 'old', thoughtform: JSON.stringify(tfOld), embedding: null,
    });
    db.insertConcept({
      id: 'tf_new', namespace: 'default', version: 1,
      created_at: 1000, updated_at: 9999, tags: '[]',
      markdown: 'new', thoughtform: JSON.stringify(tfNew), embedding: null,
    });

    const client = createMockCanisterClient();

    const options: BackupE2EOptions = {
      from: '__sqlite__',
      compress: 'none',
      encrypt: 'none',
      encryptionRequired: false,
      chunkSize: 1_000_000,
      sinceUpdatedAt: 5000,
    };

    const { result, exitCode } = await runBackupE2E(client, db, options);

    expect(exitCode).toBe(0);
    expect(result.conceptsRead).toBe(1);
    expect(result.backup.thoughtformCount).toBe(1);
  });
});

describe('PolyVault E2E roundtrip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'polyvault-roundtrip-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backup -> restore roundtrip preserves ThoughtForm data', async () => {
    const tf1 = makeThoughtForm('tf_rt1', 1730000000001, 'roundtrip one');
    const tf2 = makeThoughtForm('tf_rt2', 1730000000002, 'roundtrip two');

    // Step 1: Build chunks like backup would produce, then serve via restore client
    const bundle = buildBundleChunks([tf1, tf2]);
    const restoreClient = createMockRestoreClient([bundle]);
    const db = new InMemoryDbAdapter();
    const faiss = createMockFaissClient();

    const outPath = join(tmpDir, 'roundtrip.json');
    const options: RestoreE2EOptions = {
      to: outPath,
      mode: 'full',
      compression: 'none',
      encryption: 'none',
      sinceCommitCreatedAtMs: 0,
      faissMode: 'replace',
    };

    const { result, exitCode } = await runRestoreE2E(restoreClient, db, faiss, options);

    expect(exitCode).toBe(0);
    expect(db.count()).toBe(2);

    // Verify restored data matches original
    const c1 = db.findConcept('tf_rt1');
    expect(c1).not.toBeNull();
    const parsed1 = JSON.parse(c1!.thoughtform!) as ThoughtFormV1;
    expect(parsed1.rawText).toBe('roundtrip one');

    const c2 = db.findConcept('tf_rt2');
    expect(c2).not.toBeNull();
    const parsed2 = JSON.parse(c2!.thoughtform!) as ThoughtFormV1;
    expect(parsed2.rawText).toBe('roundtrip two');

    // FAISS was rebuilt with both ThoughtForms
    expect(faiss.calls).toHaveLength(1);
    expect(faiss.calls[0]!.thoughtforms).toHaveLength(2);
  });

  it('incremental upsert FAISS mode works on second restore', async () => {
    const db = new InMemoryDbAdapter();
    const faiss = createMockFaissClient();

    // First restore
    const tf1 = makeThoughtForm('tf_inc1', 1730000000001, 'first batch');
    const bundle1 = buildBundleChunks([tf1]);
    const client1 = createMockRestoreClient([bundle1]);

    const outPath = join(tmpDir, 'incremental.json');
    const fullOpts: RestoreE2EOptions = {
      to: outPath, mode: 'full', compression: 'none', encryption: 'none',
      sinceCommitCreatedAtMs: 0, faissMode: 'replace',
    };

    await runRestoreE2E(client1, db, faiss, fullOpts);
    expect(faiss.calls).toHaveLength(1);
    expect(faiss.calls[0]!.mode).toBe('replace');

    // Second restore with upsert mode
    const tf2 = makeThoughtForm('tf_inc2', 1730000000002, 'second batch');
    const bundle2 = buildBundleChunks([tf2]);
    const client2 = createMockRestoreClient([bundle2]);

    const upsertOpts: RestoreE2EOptions = {
      to: outPath, mode: 'full', compression: 'none', encryption: 'none',
      sinceCommitCreatedAtMs: 0, faissMode: 'upsert',
    };

    await runRestoreE2E(client2, db, faiss, upsertOpts);
    expect(faiss.calls).toHaveLength(2);
    expect(faiss.calls[1]!.mode).toBe('upsert');
    expect(db.count()).toBe(2);
  });
});
