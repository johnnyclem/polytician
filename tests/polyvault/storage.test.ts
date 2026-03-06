/**
 * PolyVault chunk/commit storage tests.
 *
 * These tests validate the storage contract specified in the Motoko canister
 * (types.mo, stable_store.mo, main.mo) by exercising equivalent logic in
 * TypeScript. The acceptance criteria from the PRD are:
 *   - Duplicate chunk put is idempotent.
 *   - Finalize rejects missing chunks.
 *   - Paginated listing with stable order.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sha256String } from '../../src/polyvault/hash.js';

// ---------- In-memory TypeScript mirror of Motoko StableStore ----------
// This mirrors the Motoko StableStore logic so we can validate the contract
// without requiring the dfx SDK / Motoko compiler.

interface ChunkRecord {
  version: string;
  bundleId: string;
  commitId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  compressed: boolean;
  encrypted: boolean;
  payload: Uint8Array;
  createdAtMs: number;
}

interface CommitRecord {
  commitId: string;
  parentCommitId: string | null;
  dedupeKey: string;
  authorPrincipal: string;
  createdAtMs: number;
  chunkCount: number;
  manifestHash: string;
}

interface PutChunkRequest {
  idempotencyKey: string;
  commitId: string;
  bundleId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  compressed: boolean;
  encrypted: boolean;
  payload: Uint8Array;
}

interface FinalizeCommitRequest {
  commitId: string;
  parentCommitId: string | null;
  dedupeKey: string;
  manifestHash: string;
  expectedChunkCount: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function chunkKey(bundleId: string, chunkIndex: number): string {
  return `${bundleId}:${chunkIndex}`;
}

class StableStore {
  private chunks = new Map<string, ChunkRecord>();
  private commits = new Map<string, CommitRecord>();
  private idempotencyKeys = new Set<string>();
  private dedupeIndex = new Map<string, string>();
  private commitChunkIndex = new Map<string, string[]>();

  putChunk(req: PutChunkRequest, now: number): Result<void> {
    if (this.idempotencyKeys.has(req.idempotencyKey)) {
      return { ok: true, value: undefined };
    }

    const key = chunkKey(req.bundleId, req.chunkIndex);
    const record: ChunkRecord = {
      version: '1.0',
      bundleId: req.bundleId,
      commitId: req.commitId,
      chunkIndex: req.chunkIndex,
      chunkCount: req.chunkCount,
      chunkHash: req.chunkHash,
      compressed: req.compressed,
      encrypted: req.encrypted,
      payload: req.payload,
      createdAtMs: now,
    };

    this.chunks.set(key, record);
    this.idempotencyKeys.add(req.idempotencyKey);

    const existing = this.commitChunkIndex.get(req.commitId) ?? [];
    existing.push(key);
    this.commitChunkIndex.set(req.commitId, existing);

    return { ok: true, value: undefined };
  }

  getChunk(bundleId: string, chunkIndex: number): ChunkRecord | null {
    return this.chunks.get(chunkKey(bundleId, chunkIndex)) ?? null;
  }

  finalizeCommit(
    req: FinalizeCommitRequest,
    caller: string,
    now: number
  ): Result<{ accepted: boolean; duplicateOf: string | null }> {
    // Dedupe check
    const existingCommitId = this.dedupeIndex.get(req.dedupeKey);
    if (existingCommitId !== undefined) {
      return { ok: true, value: { accepted: false, duplicateOf: existingCommitId } };
    }

    // Already-exists check
    if (this.commits.has(req.commitId)) {
      return { ok: false, error: `Commit already exists: ${req.commitId}` };
    }

    // Validate chunk count
    const chunkKeys = this.commitChunkIndex.get(req.commitId) ?? [];
    if (chunkKeys.length !== req.expectedChunkCount) {
      return {
        ok: false,
        error: `Expected ${req.expectedChunkCount} chunks, found ${chunkKeys.length}`,
      };
    }

    // Validate contiguous indices
    const found = new Array(req.expectedChunkCount).fill(false);
    for (const key of chunkKeys) {
      const chunk = this.chunks.get(key);
      if (!chunk) {
        return { ok: false, error: `Chunk key in index but not in store: ${key}` };
      }
      if (chunk.chunkIndex < req.expectedChunkCount) {
        found[chunk.chunkIndex] = true;
      }
    }
    for (let i = 0; i < req.expectedChunkCount; i++) {
      if (!found[i]) {
        return { ok: false, error: `Missing chunk at index ${i}` };
      }
    }

    const record: CommitRecord = {
      commitId: req.commitId,
      parentCommitId: req.parentCommitId,
      dedupeKey: req.dedupeKey,
      authorPrincipal: caller,
      createdAtMs: now,
      chunkCount: req.expectedChunkCount,
      manifestHash: req.manifestHash,
    };

    this.commits.set(req.commitId, record);
    this.dedupeIndex.set(req.dedupeKey, req.commitId);

    return { ok: true, value: { accepted: true, duplicateOf: null } };
  }

  listCommits(
    sinceUpdatedAtMs: number,
    limit: number,
    cursor: string | null
  ): { commits: CommitRecord[]; nextCursor: string | null } {
    const all = [...this.commits.values()]
      .filter((c) => c.createdAtMs > sinceUpdatedAtMs)
      .sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
        return a.commitId.localeCompare(b.commitId);
      });

    let startIdx = 0;
    if (cursor) {
      const idx = all.findIndex((c) => c.commitId === cursor);
      if (idx >= 0) startIdx = idx + 1;
    }

    const page = all.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + limit < all.length ? page[page.length - 1]!.commitId : null;

    return { commits: page, nextCursor };
  }

  getLatestCommit(): CommitRecord | null {
    let latest: CommitRecord | null = null;
    for (const record of this.commits.values()) {
      if (!latest || record.createdAtMs > latest.createdAtMs) {
        latest = record;
      } else if (
        record.createdAtMs === latest.createdAtMs &&
        record.commitId > latest.commitId
      ) {
        latest = record;
      }
    }
    return latest;
  }

  getChunksForCommit(
    commitId: string,
    offset: number,
    limit: number
  ): { chunks: ChunkRecord[]; nextOffset: number | null } {
    const chunkKeys = this.commitChunkIndex.get(commitId) ?? [];
    const records: ChunkRecord[] = [];
    for (const key of chunkKeys) {
      const r = this.chunks.get(key);
      if (r) records.push(r);
    }
    records.sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (offset >= records.length) {
      return { chunks: [], nextOffset: null };
    }

    const end = Math.min(offset + limit, records.length);
    const page = records.slice(offset, end);
    const nextOffset = end < records.length ? end : null;

    return { chunks: page, nextOffset };
  }
}

// ---------- Test helpers ----------

function makePutChunkReq(overrides: Partial<PutChunkRequest> = {}): PutChunkRequest {
  const bundleId = overrides.bundleId ?? 'bndl_test';
  const chunkIndex = overrides.chunkIndex ?? 0;
  const chunkHash = overrides.chunkHash ?? 'hash_0';
  const commitId = overrides.commitId ?? 'cmt_test';
  return {
    idempotencyKey:
      overrides.idempotencyKey ??
      sha256String(`${commitId}:${chunkIndex}:${chunkHash}`),
    commitId,
    bundleId,
    chunkIndex,
    chunkCount: overrides.chunkCount ?? 1,
    chunkHash,
    compressed: overrides.compressed ?? false,
    encrypted: overrides.encrypted ?? false,
    payload: overrides.payload ?? new Uint8Array([1, 2, 3]),
  };
}

function putAllChunks(
  store: StableStore,
  commitId: string,
  bundleId: string,
  count: number,
  now: number
): void {
  for (let i = 0; i < count; i++) {
    const req = makePutChunkReq({
      commitId,
      bundleId,
      chunkIndex: i,
      chunkCount: count,
      chunkHash: `hash_${i}`,
    });
    const result = store.putChunk(req, now);
    expect(result.ok).toBe(true);
  }
}

// ---------- Tests ----------

describe('PolyVault StableStore contract', () => {
  let store: StableStore;

  beforeEach(() => {
    store = new StableStore();
  });

  // --- put_chunk ---

  describe('put_chunk', () => {
    it('stores a chunk and retrieves it', () => {
      const req = makePutChunkReq();
      const result = store.putChunk(req, 1000);
      expect(result.ok).toBe(true);

      const chunk = store.getChunk('bndl_test', 0);
      expect(chunk).not.toBeNull();
      expect(chunk!.bundleId).toBe('bndl_test');
      expect(chunk!.chunkIndex).toBe(0);
      expect(chunk!.chunkHash).toBe('hash_0');
      expect(chunk!.createdAtMs).toBe(1000);
    });

    it('is idempotent for duplicate idempotencyKey', () => {
      const req = makePutChunkReq();
      const r1 = store.putChunk(req, 1000);
      const r2 = store.putChunk(req, 2000);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      // Original timestamp preserved (not overwritten)
      const chunk = store.getChunk('bndl_test', 0);
      expect(chunk!.createdAtMs).toBe(1000);
    });

    it('stores multiple chunks for the same commit', () => {
      putAllChunks(store, 'cmt_multi', 'bndl_multi', 3, 1000);

      expect(store.getChunk('bndl_multi', 0)).not.toBeNull();
      expect(store.getChunk('bndl_multi', 1)).not.toBeNull();
      expect(store.getChunk('bndl_multi', 2)).not.toBeNull();
      expect(store.getChunk('bndl_multi', 3)).toBeNull();
    });

    it('returns null for non-existent chunk', () => {
      expect(store.getChunk('nonexistent', 0)).toBeNull();
    });
  });

  // --- finalize_commit ---

  describe('finalize_commit', () => {
    it('accepts a commit when all chunks are present', () => {
      putAllChunks(store, 'cmt_ok', 'bndl_ok', 3, 1000);

      const result = store.finalizeCommit(
        {
          commitId: 'cmt_ok',
          parentCommitId: null,
          dedupeKey: 'dedupe_ok',
          manifestHash: 'mhash_ok',
          expectedChunkCount: 3,
        },
        'owner_principal',
        2000
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.accepted).toBe(true);
        expect(result.value.duplicateOf).toBeNull();
      }
    });

    it('rejects when chunks are missing', () => {
      // Only upload 2 of 3 expected chunks
      putAllChunks(store, 'cmt_partial', 'bndl_partial', 2, 1000);

      const result = store.finalizeCommit(
        {
          commitId: 'cmt_partial',
          parentCommitId: null,
          dedupeKey: 'dedupe_partial',
          manifestHash: 'mhash_partial',
          expectedChunkCount: 3,
        },
        'owner',
        2000
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Expected 3 chunks, found 2');
      }
    });

    it('rejects when no chunks uploaded at all', () => {
      const result = store.finalizeCommit(
        {
          commitId: 'cmt_empty',
          parentCommitId: null,
          dedupeKey: 'dedupe_empty',
          manifestHash: 'mhash_empty',
          expectedChunkCount: 2,
        },
        'owner',
        2000
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Expected 2 chunks, found 0');
      }
    });

    it('detects duplicate dedupeKey and returns existing commitId', () => {
      putAllChunks(store, 'cmt_dup1', 'bndl_dup1', 1, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_dup1',
          parentCommitId: null,
          dedupeKey: 'same_dedupe',
          manifestHash: 'mhash_1',
          expectedChunkCount: 1,
        },
        'owner',
        2000
      );

      // Second commit with same dedupeKey
      putAllChunks(store, 'cmt_dup2', 'bndl_dup2', 1, 3000);
      const result = store.finalizeCommit(
        {
          commitId: 'cmt_dup2',
          parentCommitId: 'cmt_dup1',
          dedupeKey: 'same_dedupe',
          manifestHash: 'mhash_2',
          expectedChunkCount: 1,
        },
        'owner',
        4000
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.accepted).toBe(false);
        expect(result.value.duplicateOf).toBe('cmt_dup1');
      }
    });

    it('rejects duplicate commitId', () => {
      putAllChunks(store, 'cmt_same', 'bndl_same', 1, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_same',
          parentCommitId: null,
          dedupeKey: 'dedupe_1',
          manifestHash: 'mhash',
          expectedChunkCount: 1,
        },
        'owner',
        2000
      );

      const result = store.finalizeCommit(
        {
          commitId: 'cmt_same',
          parentCommitId: null,
          dedupeKey: 'dedupe_2',
          manifestHash: 'mhash',
          expectedChunkCount: 1,
        },
        'owner',
        3000
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Commit already exists');
      }
    });

    it('supports single-chunk commit', () => {
      putAllChunks(store, 'cmt_single', 'bndl_single', 1, 1000);
      const result = store.finalizeCommit(
        {
          commitId: 'cmt_single',
          parentCommitId: null,
          dedupeKey: 'dedupe_single',
          manifestHash: 'mhash_single',
          expectedChunkCount: 1,
        },
        'owner',
        2000
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.accepted).toBe(true);
      }
    });

    it('records parentCommitId correctly', () => {
      putAllChunks(store, 'cmt_child', 'bndl_child', 1, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_child',
          parentCommitId: 'cmt_parent',
          dedupeKey: 'dedupe_child',
          manifestHash: 'mhash_child',
          expectedChunkCount: 1,
        },
        'owner',
        2000
      );

      const latest = store.getLatestCommit();
      expect(latest).not.toBeNull();
      expect(latest!.parentCommitId).toBe('cmt_parent');
    });
  });

  // --- list_commits ---

  describe('list_commits', () => {
    function setupCommits(store: StableStore): void {
      // Create 5 commits at different timestamps
      for (let i = 0; i < 5; i++) {
        const commitId = `cmt_${i}`;
        const bundleId = `bndl_${i}`;
        putAllChunks(store, commitId, bundleId, 1, 1000 + i * 1000);
        store.finalizeCommit(
          {
            commitId,
            parentCommitId: i > 0 ? `cmt_${i - 1}` : null,
            dedupeKey: `dedupe_${i}`,
            manifestHash: `mhash_${i}`,
            expectedChunkCount: 1,
          },
          'owner',
          1000 + i * 1000
        );
      }
    }

    it('returns commits in ascending createdAtMs order', () => {
      setupCommits(store);
      const result = store.listCommits(0, 10, null);

      expect(result.commits).toHaveLength(5);
      for (let i = 0; i < result.commits.length - 1; i++) {
        expect(result.commits[i]!.createdAtMs).toBeLessThanOrEqual(
          result.commits[i + 1]!.createdAtMs
        );
      }
    });

    it('filters by sinceUpdatedAtMs (exclusive lower bound)', () => {
      setupCommits(store);
      const result = store.listCommits(2000, 10, null);

      // Only commits with createdAtMs > 2000 (i.e., 3000, 4000, 5000)
      expect(result.commits).toHaveLength(3);
      expect(result.commits[0]!.commitId).toBe('cmt_2');
    });

    it('paginates with limit', () => {
      setupCommits(store);
      const page1 = store.listCommits(0, 2, null);

      expect(page1.commits).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.commits[0]!.commitId).toBe('cmt_0');
      expect(page1.commits[1]!.commitId).toBe('cmt_1');
    });

    it('paginates with cursor', () => {
      setupCommits(store);
      const page1 = store.listCommits(0, 2, null);
      const page2 = store.listCommits(0, 2, page1.nextCursor);

      expect(page2.commits).toHaveLength(2);
      expect(page2.commits[0]!.commitId).toBe('cmt_2');
      expect(page2.commits[1]!.commitId).toBe('cmt_3');
    });

    it('returns null nextCursor on last page', () => {
      setupCommits(store);
      const page1 = store.listCommits(0, 2, null);
      const page2 = store.listCommits(0, 2, page1.nextCursor);
      const page3 = store.listCommits(0, 2, page2.nextCursor);

      expect(page3.commits).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
    });

    it('returns empty list when no commits match', () => {
      setupCommits(store);
      const result = store.listCommits(999999, 10, null);
      expect(result.commits).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it('provides stable ordering for same-timestamp commits', () => {
      // Two commits with the same timestamp
      putAllChunks(store, 'cmt_b', 'bndl_b', 1, 5000);
      store.finalizeCommit(
        {
          commitId: 'cmt_b',
          parentCommitId: null,
          dedupeKey: 'dedupe_b',
          manifestHash: 'mhash_b',
          expectedChunkCount: 1,
        },
        'owner',
        5000
      );
      putAllChunks(store, 'cmt_a', 'bndl_a', 1, 5000);
      store.finalizeCommit(
        {
          commitId: 'cmt_a',
          parentCommitId: null,
          dedupeKey: 'dedupe_a',
          manifestHash: 'mhash_a',
          expectedChunkCount: 1,
        },
        'owner',
        5000
      );

      const result = store.listCommits(0, 10, null);
      expect(result.commits).toHaveLength(2);
      // Alphabetical tie-break: cmt_a < cmt_b
      expect(result.commits[0]!.commitId).toBe('cmt_a');
      expect(result.commits[1]!.commitId).toBe('cmt_b');
    });
  });

  // --- get_latest_commit ---

  describe('get_latest_commit', () => {
    it('returns null when no commits exist', () => {
      expect(store.getLatestCommit()).toBeNull();
    });

    it('returns the most recent commit', () => {
      putAllChunks(store, 'cmt_old', 'bndl_old', 1, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_old',
          parentCommitId: null,
          dedupeKey: 'dedupe_old',
          manifestHash: 'mhash_old',
          expectedChunkCount: 1,
        },
        'owner',
        1000
      );

      putAllChunks(store, 'cmt_new', 'bndl_new', 1, 5000);
      store.finalizeCommit(
        {
          commitId: 'cmt_new',
          parentCommitId: 'cmt_old',
          dedupeKey: 'dedupe_new',
          manifestHash: 'mhash_new',
          expectedChunkCount: 1,
        },
        'owner',
        5000
      );

      const latest = store.getLatestCommit();
      expect(latest).not.toBeNull();
      expect(latest!.commitId).toBe('cmt_new');
      expect(latest!.parentCommitId).toBe('cmt_old');
    });
  });

  // --- get_chunks_for_commit ---

  describe('get_chunks_for_commit', () => {
    it('returns all chunks for a commit sorted by index', () => {
      putAllChunks(store, 'cmt_fc', 'bndl_fc', 4, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_fc',
          parentCommitId: null,
          dedupeKey: 'dedupe_fc',
          manifestHash: 'mhash_fc',
          expectedChunkCount: 4,
        },
        'owner',
        2000
      );

      const result = store.getChunksForCommit('cmt_fc', 0, 10);
      expect(result.chunks).toHaveLength(4);
      for (let i = 0; i < result.chunks.length; i++) {
        expect(result.chunks[i]!.chunkIndex).toBe(i);
      }
      expect(result.nextOffset).toBeNull();
    });

    it('paginates with offset/limit', () => {
      putAllChunks(store, 'cmt_pg', 'bndl_pg', 5, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_pg',
          parentCommitId: null,
          dedupeKey: 'dedupe_pg',
          manifestHash: 'mhash_pg',
          expectedChunkCount: 5,
        },
        'owner',
        2000
      );

      const page1 = store.getChunksForCommit('cmt_pg', 0, 2);
      expect(page1.chunks).toHaveLength(2);
      expect(page1.chunks[0]!.chunkIndex).toBe(0);
      expect(page1.chunks[1]!.chunkIndex).toBe(1);
      expect(page1.nextOffset).toBe(2);

      const page2 = store.getChunksForCommit('cmt_pg', 2, 2);
      expect(page2.chunks).toHaveLength(2);
      expect(page2.chunks[0]!.chunkIndex).toBe(2);
      expect(page2.chunks[1]!.chunkIndex).toBe(3);
      expect(page2.nextOffset).toBe(4);

      const page3 = store.getChunksForCommit('cmt_pg', 4, 2);
      expect(page3.chunks).toHaveLength(1);
      expect(page3.chunks[0]!.chunkIndex).toBe(4);
      expect(page3.nextOffset).toBeNull();
    });

    it('returns empty for non-existent commit', () => {
      const result = store.getChunksForCommit('nonexistent', 0, 10);
      expect(result.chunks).toHaveLength(0);
      expect(result.nextOffset).toBeNull();
    });

    it('returns empty when offset exceeds chunk count', () => {
      putAllChunks(store, 'cmt_off', 'bndl_off', 2, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_off',
          parentCommitId: null,
          dedupeKey: 'dedupe_off',
          manifestHash: 'mhash_off',
          expectedChunkCount: 2,
        },
        'owner',
        2000
      );

      const result = store.getChunksForCommit('cmt_off', 10, 5);
      expect(result.chunks).toHaveLength(0);
      expect(result.nextOffset).toBeNull();
    });
  });

  // --- Type contract parity ---

  describe('type contract parity', () => {
    it('ChunkRecord has all fields specified in types.mo', () => {
      const req = makePutChunkReq({
        compressed: true,
        encrypted: true,
      });
      store.putChunk(req, 1234567890);
      const chunk = store.getChunk('bndl_test', 0)!;

      expect(chunk).toHaveProperty('version', '1.0');
      expect(chunk).toHaveProperty('bundleId');
      expect(chunk).toHaveProperty('commitId');
      expect(chunk).toHaveProperty('chunkIndex');
      expect(chunk).toHaveProperty('chunkCount');
      expect(chunk).toHaveProperty('chunkHash');
      expect(chunk).toHaveProperty('compressed', true);
      expect(chunk).toHaveProperty('encrypted', true);
      expect(chunk).toHaveProperty('payload');
      expect(chunk).toHaveProperty('createdAtMs', 1234567890);
    });

    it('CommitRecord has all fields specified in types.mo', () => {
      putAllChunks(store, 'cmt_fields', 'bndl_fields', 1, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_fields',
          parentCommitId: 'cmt_parent',
          dedupeKey: 'dedupe_fields',
          manifestHash: 'mhash_fields',
          expectedChunkCount: 1,
        },
        'owner_principal',
        2000
      );

      const commit = store.getLatestCommit()!;
      expect(commit).toHaveProperty('commitId', 'cmt_fields');
      expect(commit).toHaveProperty('parentCommitId', 'cmt_parent');
      expect(commit).toHaveProperty('dedupeKey', 'dedupe_fields');
      expect(commit).toHaveProperty('authorPrincipal', 'owner_principal');
      expect(commit).toHaveProperty('createdAtMs', 2000);
      expect(commit).toHaveProperty('chunkCount', 1);
      expect(commit).toHaveProperty('manifestHash', 'mhash_fields');
    });

    it('idempotencyKey is sha256(commitId:chunkIndex:chunkHash) per PRD', () => {
      const commitId = 'cmt_idem';
      const chunkIndex = 0;
      const chunkHash = 'hash_0';
      const expectedKey = sha256String(`${commitId}:${chunkIndex}:${chunkHash}`);

      const req = makePutChunkReq({
        commitId,
        chunkIndex,
        chunkHash,
        idempotencyKey: expectedKey,
      });

      // First put succeeds
      const r1 = store.putChunk(req, 1000);
      expect(r1.ok).toBe(true);

      // Duplicate put with same key is idempotent
      const r2 = store.putChunk(req, 2000);
      expect(r2.ok).toBe(true);

      // Chunk stored only once
      const chunk = store.getChunk(req.bundleId, req.chunkIndex)!;
      expect(chunk.createdAtMs).toBe(1000);
    });
  });

  // --- End-to-end flow ---

  describe('end-to-end backup flow', () => {
    it('simulates full backup: put chunks -> finalize -> list -> retrieve', () => {
      const commitId = 'cmt_e2e';
      const bundleId = 'bndl_e2e';
      const chunkCount = 3;

      // Step 1: Upload chunks
      putAllChunks(store, commitId, bundleId, chunkCount, 10000);

      // Step 2: Finalize commit
      const finalizeResult = store.finalizeCommit(
        {
          commitId,
          parentCommitId: null,
          dedupeKey: 'dedupe_e2e',
          manifestHash: 'mhash_e2e',
          expectedChunkCount: chunkCount,
        },
        'owner',
        10000
      );
      expect(finalizeResult.ok).toBe(true);
      if (finalizeResult.ok) {
        expect(finalizeResult.value.accepted).toBe(true);
      }

      // Step 3: List commits
      const listResult = store.listCommits(0, 10, null);
      expect(listResult.commits).toHaveLength(1);
      expect(listResult.commits[0]!.commitId).toBe(commitId);

      // Step 4: Retrieve chunks
      const chunksResult = store.getChunksForCommit(commitId, 0, 10);
      expect(chunksResult.chunks).toHaveLength(chunkCount);

      // Step 5: Verify latest commit
      const latest = store.getLatestCommit();
      expect(latest).not.toBeNull();
      expect(latest!.commitId).toBe(commitId);
    });

    it('simulates chain of commits with parent links', () => {
      // First commit
      putAllChunks(store, 'cmt_c1', 'bndl_c1', 1, 1000);
      store.finalizeCommit(
        {
          commitId: 'cmt_c1',
          parentCommitId: null,
          dedupeKey: 'dedupe_c1',
          manifestHash: 'mhash_c1',
          expectedChunkCount: 1,
        },
        'owner',
        1000
      );

      // Second commit
      putAllChunks(store, 'cmt_c2', 'bndl_c2', 2, 2000);
      store.finalizeCommit(
        {
          commitId: 'cmt_c2',
          parentCommitId: 'cmt_c1',
          dedupeKey: 'dedupe_c2',
          manifestHash: 'mhash_c2',
          expectedChunkCount: 2,
        },
        'owner',
        2000
      );

      // Third commit
      putAllChunks(store, 'cmt_c3', 'bndl_c3', 1, 3000);
      store.finalizeCommit(
        {
          commitId: 'cmt_c3',
          parentCommitId: 'cmt_c2',
          dedupeKey: 'dedupe_c3',
          manifestHash: 'mhash_c3',
          expectedChunkCount: 1,
        },
        'owner',
        3000
      );

      // Verify chain
      const all = store.listCommits(0, 10, null);
      expect(all.commits).toHaveLength(3);
      expect(all.commits[0]!.parentCommitId).toBeNull();
      expect(all.commits[1]!.parentCommitId).toBe('cmt_c1');
      expect(all.commits[2]!.parentCommitId).toBe('cmt_c2');

      // Latest is the last one
      const latest = store.getLatestCommit();
      expect(latest!.commitId).toBe('cmt_c3');
    });
  });
});
