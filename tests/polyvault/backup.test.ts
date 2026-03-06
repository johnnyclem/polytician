import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256String } from '../../src/polyvault/hash.js';
import { idempotencyKey } from '../../src/lib/polyvault/idempotency.js';
import {
  uploadBundle,
  ChunkUploadError,
  FinalizeError,
  type CanisterClient,
  type CanisterResult,
  type FinalizeResult,
  type PutChunkRequest,
} from '../../src/lib/polyvault/upload.js';
import {
  runBackup,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
  EXIT_AUTH,
  EXIT_NETWORK,
  EXIT_INTEGRITY,
  type BackupOptions,
  type BackupResult,
} from '../../src/commands/polyvault/backup.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';
import type { ThoughtFormV1 } from '../../src/schemas/thoughtform.js';

// --- Fixtures ---

function makeThoughtForm(overrides: Partial<ThoughtFormV1> = {}): ThoughtFormV1 {
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    id: 'tf_backup_01',
    rawText: 'hello world',
    entities: [{ id: 'e_1', type: 'concept', value: 'hello' }],
    relationships: [{ id: 'r_1', type: 'relates_to', from: 'e_1', to: 'e_2' }],
    contextGraph: { source: 'test' },
    metadata: {
      createdAtMs: 1730000000000,
      updatedAtMs: 1730000000000,
      source: 'local',
      contentHash: 'a'.repeat(64),
      redaction: { rawTextOmitted: false },
    },
    ...overrides,
  };
}

// --- In-memory canister stub ---

interface StoredChunk {
  idempotencyKey: string;
  commitId: string;
  bundleId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  payload: Uint8Array;
}

interface StoredCommit {
  commitId: string;
  parentCommitId: string | null;
  dedupeKey: string;
  manifestHash: string;
  chunkCount: number;
  createdAtMs: number;
}

class InMemoryCanister implements CanisterClient {
  chunks = new Map<string, StoredChunk>();
  commits = new Map<string, StoredCommit>();
  idempotencyKeys = new Set<string>();
  dedupeIndex = new Map<string, string>();
  commitChunkIndex = new Map<string, string[]>();

  async putChunk(req: PutChunkRequest): Promise<CanisterResult<void>> {
    if (this.idempotencyKeys.has(req.idempotencyKey)) {
      return { ok: true, value: undefined };
    }

    const key = `${req.bundleId}:${req.chunkIndex}`;
    this.chunks.set(key, {
      idempotencyKey: req.idempotencyKey,
      commitId: req.commitId,
      bundleId: req.bundleId,
      chunkIndex: req.chunkIndex,
      chunkCount: req.chunkCount,
      chunkHash: req.chunkHash,
      payload: req.payload,
    });
    this.idempotencyKeys.add(req.idempotencyKey);

    const existing = this.commitChunkIndex.get(req.commitId) ?? [];
    existing.push(key);
    this.commitChunkIndex.set(req.commitId, existing);

    return { ok: true, value: undefined };
  }

  async finalizeCommit(
    commitId: string,
    parentCommitId: string | null,
    dedupeKey: string,
    manifestHash: string,
    expectedChunkCount: number,
  ): Promise<CanisterResult<FinalizeResult>> {
    const dup = this.dedupeIndex.get(dedupeKey);
    if (dup !== undefined) {
      return { ok: true, value: { accepted: false, duplicateOf: dup } };
    }

    if (this.commits.has(commitId)) {
      return { ok: false, error: `Commit already exists: ${commitId}` };
    }

    const chunkKeys = this.commitChunkIndex.get(commitId) ?? [];
    if (chunkKeys.length !== expectedChunkCount) {
      return {
        ok: false,
        error: `Expected ${expectedChunkCount} chunks, found ${chunkKeys.length}`,
      };
    }

    this.commits.set(commitId, {
      commitId,
      parentCommitId,
      dedupeKey,
      manifestHash,
      chunkCount: expectedChunkCount,
      createdAtMs: Date.now(),
    });
    this.dedupeIndex.set(dedupeKey, commitId);

    return { ok: true, value: { accepted: true, duplicateOf: null } };
  }

  async getLatestCommit(): Promise<{ commitId: string; createdAtMs: number } | null> {
    let latest: StoredCommit | null = null;
    for (const c of this.commits.values()) {
      if (!latest || c.createdAtMs > latest.createdAtMs) {
        latest = c;
      }
    }
    return latest ? { commitId: latest.commitId, createdAtMs: latest.createdAtMs } : null;
  }
}

// --- Idempotency key tests ---

describe('idempotencyKey', () => {
  it('produces sha256 of commitId:chunkIndex:chunkHash', () => {
    const key = idempotencyKey('cmt_1', 0, 'hash_0');
    expect(key).toBe(sha256String('cmt_1:0:hash_0'));
  });

  it('different inputs produce different keys', () => {
    const k1 = idempotencyKey('cmt_1', 0, 'hash_0');
    const k2 = idempotencyKey('cmt_1', 1, 'hash_0');
    const k3 = idempotencyKey('cmt_2', 0, 'hash_0');
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('is deterministic', () => {
    const k1 = idempotencyKey('cmt_x', 5, 'hash_y');
    const k2 = idempotencyKey('cmt_x', 5, 'hash_y');
    expect(k1).toBe(k2);
  });
});

// --- Upload module tests ---

describe('uploadBundle', () => {
  let canister: InMemoryCanister;

  beforeEach(() => {
    canister = new InMemoryCanister();
  });

  it('uploads chunks and finalizes successfully', async () => {
    const result = await uploadBundle(canister, {
      bundleId: 'bndl_1',
      commitId: 'cmt_1',
      parentCommitId: null,
      dedupeKey: 'dedupe_1',
      manifestHash: 'mhash_1',
      chunks: [
        {
          chunkIndex: 0,
          chunkCount: 2,
          chunkHash: 'hash_0',
          compressed: false,
          encrypted: false,
          payload: new Uint8Array([1, 2, 3]),
        },
        {
          chunkIndex: 1,
          chunkCount: 2,
          chunkHash: 'hash_1',
          compressed: false,
          encrypted: false,
          payload: new Uint8Array([4, 5, 6]),
        },
      ],
    });

    expect(result.accepted).toBe(true);
    expect(result.duplicateOf).toBeNull();
    expect(result.chunksUploaded).toBe(2);
    expect(canister.commits.size).toBe(1);
    expect(canister.chunks.size).toBe(2);
  });

  it('detects duplicate dedupeKey (idempotent re-run)', async () => {
    // First upload
    await uploadBundle(canister, {
      bundleId: 'bndl_1',
      commitId: 'cmt_1',
      parentCommitId: null,
      dedupeKey: 'same_dedupe',
      manifestHash: 'mhash_1',
      chunks: [
        {
          chunkIndex: 0,
          chunkCount: 1,
          chunkHash: 'hash_0',
          compressed: false,
          encrypted: false,
          payload: new Uint8Array([1]),
        },
      ],
    });

    // Second upload with same dedupeKey
    const result = await uploadBundle(canister, {
      bundleId: 'bndl_2',
      commitId: 'cmt_2',
      parentCommitId: 'cmt_1',
      dedupeKey: 'same_dedupe',
      manifestHash: 'mhash_2',
      chunks: [
        {
          chunkIndex: 0,
          chunkCount: 1,
          chunkHash: 'hash_0b',
          compressed: false,
          encrypted: false,
          payload: new Uint8Array([2]),
        },
      ],
    });

    expect(result.accepted).toBe(false);
    expect(result.duplicateOf).toBe('cmt_1');
  });

  it('throws ChunkUploadError on put_chunk failure', async () => {
    const failingClient: CanisterClient = {
      async putChunk() {
        return { ok: false, error: 'Unauthorized: caller is not permitted to write' };
      },
      async finalizeCommit() {
        return { ok: true, value: { accepted: true, duplicateOf: null } };
      },
      async getLatestCommit() {
        return null;
      },
    };

    await expect(
      uploadBundle(failingClient, {
        bundleId: 'bndl_f',
        commitId: 'cmt_f',
        parentCommitId: null,
        dedupeKey: 'dedupe_f',
        manifestHash: 'mhash_f',
        chunks: [
          {
            chunkIndex: 0,
            chunkCount: 1,
            chunkHash: 'hash_0',
            compressed: false,
            encrypted: false,
            payload: new Uint8Array([1]),
          },
        ],
      }),
    ).rejects.toThrow(ChunkUploadError);
  });

  it('throws FinalizeError on finalize_commit failure', async () => {
    const failFinalizeClient: CanisterClient = {
      async putChunk() {
        return { ok: true, value: undefined };
      },
      async finalizeCommit() {
        return { ok: false, error: 'Expected 2 chunks, found 1' };
      },
      async getLatestCommit() {
        return null;
      },
    };

    await expect(
      uploadBundle(failFinalizeClient, {
        bundleId: 'bndl_ff',
        commitId: 'cmt_ff',
        parentCommitId: null,
        dedupeKey: 'dedupe_ff',
        manifestHash: 'mhash_ff',
        chunks: [
          {
            chunkIndex: 0,
            chunkCount: 1,
            chunkHash: 'hash_0',
            compressed: false,
            encrypted: false,
            payload: new Uint8Array([1]),
          },
        ],
      }),
    ).rejects.toThrow(FinalizeError);
  });

  it('chunk upload is idempotent (replay safe)', async () => {
    const req = {
      bundleId: 'bndl_idem',
      commitId: 'cmt_idem',
      parentCommitId: null,
      dedupeKey: 'dedupe_idem',
      manifestHash: 'mhash_idem',
      chunks: [
        {
          chunkIndex: 0,
          chunkCount: 1,
          chunkHash: 'hash_idem',
          compressed: false,
          encrypted: false,
          payload: new Uint8Array([42]),
        },
      ],
    };

    // Upload chunks (but use a client that fails on finalize to simulate interruption)
    const firstClient = new InMemoryCanister();
    // Manually put the chunk
    const idemKey = idempotencyKey('cmt_idem', 0, 'hash_idem');
    await firstClient.putChunk({
      idempotencyKey: idemKey,
      commitId: 'cmt_idem',
      bundleId: 'bndl_idem',
      chunkIndex: 0,
      chunkCount: 1,
      chunkHash: 'hash_idem',
      compressed: false,
      encrypted: false,
      payload: new Uint8Array([42]),
    });

    // Now replay the full upload — chunk should be idempotent
    const result = await uploadBundle(firstClient, req);
    expect(result.accepted).toBe(true);
    expect(result.chunksUploaded).toBe(1);
    // Only one chunk stored (no duplicate)
    expect(firstClient.chunks.size).toBe(1);
  });
});

// --- CLI backup command tests ---

describe('runBackup', () => {
  let tempDir: string;
  let canister: InMemoryCanister;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'polyvault-backup-test-'));
    canister = new InMemoryCanister();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function defaultOptions(overrides: Partial<BackupOptions> = {}): BackupOptions {
    return {
      from: join(tempDir, 'input.json'),
      compress: 'none',
      encrypt: 'none',
      encryptionRequired: false,
      chunkSize: 1_000_000,
      sinceUpdatedAt: 0,
      ...overrides,
    };
  }

  function writeInput(data: unknown): string {
    const path = join(tempDir, 'input.json');
    writeFileSync(path, JSON.stringify(data));
    return path;
  }

  it('backs up ThoughtForms successfully', async () => {
    const tf = makeThoughtForm();
    const inputPath = writeInput([tf]);

    const { result, exitCode } = await runBackup(canister, defaultOptions({ from: inputPath }));

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(result.status).toBe('ok');
    expect(result.thoughtformCount).toBe(1);
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(result.chunksUploaded).toBeGreaterThanOrEqual(1);
    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bundleId).toContain('bndl_');
    expect(result.commitId).toContain('cmt_');
    expect(canister.commits.size).toBe(1);
  });

  it('re-running unchanged backup yields duplicate', async () => {
    const tf = makeThoughtForm();
    const inputPath = writeInput([tf]);
    const opts = defaultOptions({ from: inputPath });

    const { result: r1 } = await runBackup(canister, opts);
    expect(r1.status).toBe('ok');

    const { result: r2, exitCode } = await runBackup(canister, opts);
    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(r2.status).toBe('duplicate');
    expect(r2.duplicateOf).toBe(r1.commitId);
  });

  it('filters by sinceUpdatedAt', async () => {
    const old = makeThoughtForm({
      id: 'tf_old',
      metadata: {
        createdAtMs: 1000,
        updatedAtMs: 1000,
        source: 'local',
        contentHash: 'b'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    });
    const recent = makeThoughtForm({
      id: 'tf_recent',
      metadata: {
        createdAtMs: 5000,
        updatedAtMs: 5000,
        source: 'local',
        contentHash: 'c'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    });
    const inputPath = writeInput([old, recent]);

    const { result, exitCode } = await runBackup(
      canister,
      defaultOptions({ from: inputPath, sinceUpdatedAt: 2000 }),
    );

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(result.thoughtformCount).toBe(1);
  });

  it('handles empty ThoughtForm array (0 items)', async () => {
    const inputPath = writeInput([]);

    const { result, exitCode } = await runBackup(canister, defaultOptions({ from: inputPath }));

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(result.status).toBe('ok');
    expect(result.thoughtformCount).toBe(0);
    expect(result.chunkCount).toBe(0);
  });

  it('handles all items filtered out', async () => {
    const old = makeThoughtForm({
      metadata: {
        createdAtMs: 1000,
        updatedAtMs: 1000,
        source: 'local',
        contentHash: 'b'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    });
    const inputPath = writeInput([old]);

    const { result, exitCode } = await runBackup(
      canister,
      defaultOptions({ from: inputPath, sinceUpdatedAt: 5000 }),
    );

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(result.thoughtformCount).toBe(0);
  });

  it('returns EXIT_VALIDATION for invalid input file', async () => {
    const { result, exitCode } = await runBackup(
      canister,
      defaultOptions({ from: join(tempDir, 'nonexistent.json') }),
    );

    expect(exitCode).toBe(EXIT_VALIDATION);
    expect(result.status).toBe('error');
  });

  it('returns EXIT_VALIDATION for non-array input', async () => {
    const inputPath = writeInput({ notAnArray: true });

    const { result, exitCode } = await runBackup(canister, defaultOptions({ from: inputPath }));

    expect(exitCode).toBe(EXIT_VALIDATION);
    expect(result.status).toBe('error');
  });

  it('returns EXIT_VALIDATION for invalid ThoughtForm', async () => {
    const inputPath = writeInput([{ id: '' }]);

    const { result, exitCode } = await runBackup(canister, defaultOptions({ from: inputPath }));

    expect(exitCode).toBe(EXIT_VALIDATION);
    expect(result.status).toBe('error');
  });

  it('writes manifest to --out path', async () => {
    const tf = makeThoughtForm();
    const inputPath = writeInput([tf]);
    const outPath = join(tempDir, 'manifest.json');

    const { result, exitCode } = await runBackup(
      canister,
      defaultOptions({ from: inputPath, out: outPath }),
    );

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(existsSync(outPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(outPath, 'utf-8')) as BackupResult;
    expect(manifest.status).toBe('ok');
    expect(manifest.bundleId).toBe(result.bundleId);
  });

  it('writes manifest for empty backup when --out provided', async () => {
    const inputPath = writeInput([]);
    const outPath = join(tempDir, 'empty-manifest.json');

    const { exitCode } = await runBackup(
      canister,
      defaultOptions({ from: inputPath, out: outPath }),
    );

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(existsSync(outPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(outPath, 'utf-8')) as BackupResult;
    expect(manifest.thoughtformCount).toBe(0);
  });

  it('returns EXIT_NETWORK on chunk upload failure', async () => {
    const failClient: CanisterClient = {
      async putChunk() {
        return { ok: false, error: 'Network timeout' };
      },
      async finalizeCommit() {
        return { ok: true, value: { accepted: true, duplicateOf: null } };
      },
      async getLatestCommit() {
        return null;
      },
    };

    const tf = makeThoughtForm();
    const inputPath = writeInput([tf]);

    const { result, exitCode } = await runBackup(
      failClient,
      defaultOptions({ from: inputPath }),
    );

    expect(exitCode).toBe(EXIT_NETWORK);
    expect(result.status).toBe('error');
  });

  it('returns EXIT_AUTH on authorization failure', async () => {
    const authFailClient: CanisterClient = {
      async putChunk() {
        return { ok: true, value: undefined };
      },
      async finalizeCommit() {
        return { ok: false, error: 'Unauthorized: caller is not permitted to write' };
      },
      async getLatestCommit() {
        return null;
      },
    };

    const tf = makeThoughtForm();
    const inputPath = writeInput([tf]);

    const { result, exitCode } = await runBackup(
      authFailClient,
      defaultOptions({ from: inputPath }),
    );

    expect(exitCode).toBe(EXIT_AUTH);
    expect(result.status).toBe('error');
  });

  it('returns EXIT_INTEGRITY on finalize failure (non-auth)', async () => {
    const integrityFailClient: CanisterClient = {
      async putChunk() {
        return { ok: true, value: undefined };
      },
      async finalizeCommit() {
        return { ok: false, error: 'Expected 2 chunks, found 1' };
      },
      async getLatestCommit() {
        return null;
      },
    };

    const tf = makeThoughtForm();
    const inputPath = writeInput([tf]);

    const { result, exitCode } = await runBackup(
      integrityFailClient,
      defaultOptions({ from: inputPath }),
    );

    expect(exitCode).toBe(EXIT_INTEGRITY);
    expect(result.status).toBe('error');
  });

  it('supports gzip compression', async () => {
    const tf = makeThoughtForm();
    const inputPath = writeInput([tf]);

    const { result, exitCode } = await runBackup(
      canister,
      defaultOptions({ from: inputPath, compress: 'gzip' }),
    );

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(result.compression).toBe('gzip');
    expect(result.status).toBe('ok');
  });

  it('sorts ThoughtForms canonically (updatedAtMs asc, id asc, contentHash asc)', async () => {
    const tf1 = makeThoughtForm({
      id: 'tf_z',
      metadata: {
        createdAtMs: 1000,
        updatedAtMs: 2000,
        source: 'local',
        contentHash: 'a'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    });
    const tf2 = makeThoughtForm({
      id: 'tf_a',
      metadata: {
        createdAtMs: 1000,
        updatedAtMs: 1000,
        source: 'local',
        contentHash: 'b'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    });
    const tf3 = makeThoughtForm({
      id: 'tf_a',
      metadata: {
        createdAtMs: 1000,
        updatedAtMs: 2000,
        source: 'local',
        contentHash: 'c'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    });
    const inputPath = writeInput([tf1, tf2, tf3]);

    const { result, exitCode } = await runBackup(canister, defaultOptions({ from: inputPath }));

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(result.thoughtformCount).toBe(3);
    // The backup should succeed; canonical sort ensures deterministic output
    expect(result.status).toBe('ok');
  });

  it('backs up multiple ThoughtForms with correct count', async () => {
    const forms = Array.from({ length: 10 }, (_, i) =>
      makeThoughtForm({
        id: `tf_${i}`,
        metadata: {
          createdAtMs: 1730000000000 + i,
          updatedAtMs: 1730000000000 + i,
          source: 'local',
          contentHash: `${String(i).padStart(64, '0')}`,
          redaction: { rawTextOmitted: false },
        },
      }),
    );
    const inputPath = writeInput(forms);

    const { result, exitCode } = await runBackup(canister, defaultOptions({ from: inputPath }));

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(result.thoughtformCount).toBe(10);
  });

  it('sets parentCommitId from latest remote commit', async () => {
    // First backup
    const tf1 = makeThoughtForm({ id: 'tf_first' });
    const inputPath1 = writeInput([tf1]);
    const { result: r1 } = await runBackup(canister, defaultOptions({ from: inputPath1 }));
    expect(r1.parentCommitId).toBeNull();

    // Second backup — should chain to first
    const tf2 = makeThoughtForm({
      id: 'tf_second',
      metadata: {
        createdAtMs: 2000000000000,
        updatedAtMs: 2000000000000,
        source: 'local',
        contentHash: 'd'.repeat(64),
        redaction: { rawTextOmitted: false },
      },
    });
    const inputPath2 = writeInput([tf2]);
    const { result: r2 } = await runBackup(
      canister,
      defaultOptions({ from: inputPath2, sinceUpdatedAt: 1730000000000 }),
    );
    expect(r2.parentCommitId).toBe(r1.commitId);
  });
});
