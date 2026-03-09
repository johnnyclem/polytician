/**
 * PolyVault access control / allowlist tests.
 *
 * These tests validate the auth contract specified in auth.mo + main.mo
 * by exercising equivalent logic in TypeScript. Acceptance criteria:
 *   - Unauthorized principal gets explicit auth error.
 *   - Owner is always permitted.
 *   - Allowlist empty means owner-only baseline.
 *   - Write allowlist grants write access to listed principals.
 *   - Read allowlist grants read access to listed principals.
 *   - Only the owner can modify allowlists.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ---------- TypeScript mirror of Motoko Auth.AccessControl ----------

class AccessControl {
  private owner: string;
  private writeAllowlist: string[] = [];
  private readAllowlist: string[] = [];

  constructor(owner: string) {
    this.owner = owner;
  }

  isOwner(caller: string): boolean {
    return caller === this.owner;
  }

  isWriter(caller: string): boolean {
    if (caller === this.owner) return true;
    return this.writeAllowlist.includes(caller);
  }

  isReader(caller: string): boolean {
    if (caller === this.owner) return true;
    return this.readAllowlist.includes(caller);
  }

  setWriteAllowlist(caller: string, principals: string[]): boolean {
    if (caller !== this.owner) return false;
    this.writeAllowlist = [...principals];
    return true;
  }

  setReadAllowlist(caller: string, principals: string[]): boolean {
    if (caller !== this.owner) return false;
    this.readAllowlist = [...principals];
    return true;
  }

  getWriteAllowlist(): string[] {
    return this.writeAllowlist;
  }

  getReadAllowlist(): string[] {
    return this.readAllowlist;
  }

  getOwner(): string {
    return this.owner;
  }
}

// ---------- Minimal StableStore for auth integration tests ----------

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

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

interface CommitRecord {
  commitId: string;
  parentCommitId: string | null;
  dedupeKey: string;
  authorPrincipal: string;
  createdAtMs: number;
  chunkCount: number;
  manifestHash: string;
}

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

/**
 * Simulates the PolyVault canister with auth-gated methods.
 */
class PolyVaultCanister {
  private access: AccessControl;
  private chunks = new Map<string, ChunkRecord>();
  private commits = new Map<string, CommitRecord>();
  private idempotencyKeys = new Set<string>();
  private commitChunkIndex = new Map<string, string[]>();
  private dedupeIndex = new Map<string, string>();

  constructor(owner: string) {
    this.access = new AccessControl(owner);
  }

  put_chunk(caller: string, req: PutChunkRequest): Result<void> {
    if (!this.access.isWriter(caller)) {
      return { ok: false, error: 'Unauthorized: caller is not permitted to write' };
    }
    if (this.idempotencyKeys.has(req.idempotencyKey)) {
      return { ok: true, value: undefined };
    }
    const key = `${req.bundleId}:${req.chunkIndex}`;
    this.chunks.set(key, {
      version: '1.0',
      ...req,
      createdAtMs: Date.now(),
    });
    this.idempotencyKeys.add(req.idempotencyKey);
    const existing = this.commitChunkIndex.get(req.commitId) ?? [];
    existing.push(key);
    this.commitChunkIndex.set(req.commitId, existing);
    return { ok: true, value: undefined };
  }

  get_chunk(caller: string, bundleId: string, chunkIndex: number): ChunkRecord | null {
    if (!this.access.isReader(caller)) return null;
    return this.chunks.get(`${bundleId}:${chunkIndex}`) ?? null;
  }

  finalize_commit(
    caller: string,
    commitId: string,
    parentCommitId: string | null,
    dedupeKey: string,
    manifestHash: string,
    expectedChunkCount: number,
  ): Result<{ accepted: boolean; duplicateOf: string | null }> {
    if (!this.access.isWriter(caller)) {
      return { ok: false, error: 'Unauthorized: caller is not permitted to write' };
    }
    const dup = this.dedupeIndex.get(dedupeKey);
    if (dup !== undefined) {
      return { ok: true, value: { accepted: false, duplicateOf: dup } };
    }
    const chunkKeys = this.commitChunkIndex.get(commitId) ?? [];
    if (chunkKeys.length !== expectedChunkCount) {
      return {
        ok: false,
        error: `Expected ${expectedChunkCount} chunks, found ${chunkKeys.length}`,
      };
    }
    const record: CommitRecord = {
      commitId,
      parentCommitId,
      dedupeKey,
      authorPrincipal: caller,
      createdAtMs: Date.now(),
      chunkCount: expectedChunkCount,
      manifestHash,
    };
    this.commits.set(commitId, record);
    this.dedupeIndex.set(dedupeKey, commitId);
    return { ok: true, value: { accepted: true, duplicateOf: null } };
  }

  list_commits(
    caller: string,
    sinceUpdatedAtMs: number,
    limit: number,
  ): { commits: CommitRecord[]; nextCursor: string | null } {
    if (!this.access.isReader(caller)) {
      return { commits: [], nextCursor: null };
    }
    const all = [...this.commits.values()].filter(
      (c) => c.createdAtMs > sinceUpdatedAtMs,
    );
    return { commits: all.slice(0, limit), nextCursor: null };
  }

  get_latest_commit(caller: string): CommitRecord | null {
    if (!this.access.isReader(caller)) return null;
    let latest: CommitRecord | null = null;
    for (const r of this.commits.values()) {
      if (!latest || r.createdAtMs > latest.createdAtMs) latest = r;
    }
    return latest;
  }

  get_chunks_for_commit(
    caller: string,
    commitId: string,
    offset: number,
    limit: number,
  ): { chunks: ChunkRecord[]; nextOffset: number | null } {
    if (!this.access.isReader(caller)) {
      return { chunks: [], nextOffset: null };
    }
    const keys = this.commitChunkIndex.get(commitId) ?? [];
    const records: ChunkRecord[] = [];
    for (const k of keys) {
      const r = this.chunks.get(k);
      if (r) records.push(r);
    }
    records.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const page = records.slice(offset, offset + limit);
    return {
      chunks: page,
      nextOffset: offset + limit < records.length ? offset + limit : null,
    };
  }

  set_allowlist(caller: string, principals: string[]): Result<void> {
    if (!this.access.setWriteAllowlist(caller, principals)) {
      return { ok: false, error: 'Unauthorized: only the owner can set the allowlist' };
    }
    return { ok: true, value: undefined };
  }

  get_allowlist(caller: string): string[] {
    if (!this.access.isOwner(caller)) return [];
    return this.access.getWriteAllowlist();
  }

  set_read_allowlist(caller: string, principals: string[]): Result<void> {
    if (!this.access.setReadAllowlist(caller, principals)) {
      return {
        ok: false,
        error: 'Unauthorized: only the owner can set the read allowlist',
      };
    }
    return { ok: true, value: undefined };
  }

  get_read_allowlist(caller: string): string[] {
    if (!this.access.isOwner(caller)) return [];
    return this.access.getReadAllowlist();
  }
}

// ---------- Test helpers ----------

const OWNER = 'owner-principal-abc';
const AGENT_A = 'agent-a-principal';
const AGENT_B = 'agent-b-principal';
const STRANGER = 'stranger-principal';

function makeChunkReq(overrides: Partial<PutChunkRequest> = {}): PutChunkRequest {
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'idem_1',
    commitId: overrides.commitId ?? 'cmt_1',
    bundleId: overrides.bundleId ?? 'bndl_1',
    chunkIndex: overrides.chunkIndex ?? 0,
    chunkCount: overrides.chunkCount ?? 1,
    chunkHash: overrides.chunkHash ?? 'hash_0',
    compressed: false,
    encrypted: false,
    payload: new Uint8Array([1, 2, 3]),
  };
}

// ---------- Tests ----------

describe('PolyVault AccessControl', () => {
  let ac: AccessControl;

  beforeEach(() => {
    ac = new AccessControl(OWNER);
  });

  describe('owner checks', () => {
    it('owner is recognized', () => {
      expect(ac.isOwner(OWNER)).toBe(true);
    });

    it('non-owner is not recognized', () => {
      expect(ac.isOwner(STRANGER)).toBe(false);
    });
  });

  describe('writer checks', () => {
    it('owner is always a writer', () => {
      expect(ac.isWriter(OWNER)).toBe(true);
    });

    it('non-owner is not a writer when allowlist is empty', () => {
      expect(ac.isWriter(AGENT_A)).toBe(false);
    });

    it('allowlisted principal is a writer', () => {
      ac.setWriteAllowlist(OWNER, [AGENT_A]);
      expect(ac.isWriter(AGENT_A)).toBe(true);
    });

    it('non-allowlisted principal is not a writer', () => {
      ac.setWriteAllowlist(OWNER, [AGENT_A]);
      expect(ac.isWriter(AGENT_B)).toBe(false);
    });

    it('multiple principals on allowlist', () => {
      ac.setWriteAllowlist(OWNER, [AGENT_A, AGENT_B]);
      expect(ac.isWriter(AGENT_A)).toBe(true);
      expect(ac.isWriter(AGENT_B)).toBe(true);
      expect(ac.isWriter(STRANGER)).toBe(false);
    });
  });

  describe('reader checks', () => {
    it('owner is always a reader', () => {
      expect(ac.isReader(OWNER)).toBe(true);
    });

    it('non-owner is not a reader when allowlist is empty', () => {
      expect(ac.isReader(AGENT_A)).toBe(false);
    });

    it('allowlisted principal is a reader', () => {
      ac.setReadAllowlist(OWNER, [AGENT_A]);
      expect(ac.isReader(AGENT_A)).toBe(true);
    });
  });

  describe('allowlist management', () => {
    it('only owner can set write allowlist', () => {
      expect(ac.setWriteAllowlist(STRANGER, [AGENT_A])).toBe(false);
      expect(ac.getWriteAllowlist()).toEqual([]);
    });

    it('only owner can set read allowlist', () => {
      expect(ac.setReadAllowlist(STRANGER, [AGENT_A])).toBe(false);
      expect(ac.getReadAllowlist()).toEqual([]);
    });

    it('owner can set write allowlist', () => {
      expect(ac.setWriteAllowlist(OWNER, [AGENT_A, AGENT_B])).toBe(true);
      expect(ac.getWriteAllowlist()).toEqual([AGENT_A, AGENT_B]);
    });

    it('owner can set read allowlist', () => {
      expect(ac.setReadAllowlist(OWNER, [AGENT_A])).toBe(true);
      expect(ac.getReadAllowlist()).toEqual([AGENT_A]);
    });

    it('setting allowlist replaces previous list', () => {
      ac.setWriteAllowlist(OWNER, [AGENT_A]);
      ac.setWriteAllowlist(OWNER, [AGENT_B]);
      expect(ac.getWriteAllowlist()).toEqual([AGENT_B]);
      expect(ac.isWriter(AGENT_A)).toBe(false);
      expect(ac.isWriter(AGENT_B)).toBe(true);
    });

    it('setting allowlist to empty reverts to owner-only', () => {
      ac.setWriteAllowlist(OWNER, [AGENT_A]);
      ac.setWriteAllowlist(OWNER, []);
      expect(ac.isWriter(AGENT_A)).toBe(false);
      expect(ac.isWriter(OWNER)).toBe(true);
    });

    it('write and read allowlists are independent', () => {
      ac.setWriteAllowlist(OWNER, [AGENT_A]);
      ac.setReadAllowlist(OWNER, [AGENT_B]);
      expect(ac.isWriter(AGENT_A)).toBe(true);
      expect(ac.isReader(AGENT_A)).toBe(false);
      expect(ac.isWriter(AGENT_B)).toBe(false);
      expect(ac.isReader(AGENT_B)).toBe(true);
    });
  });
});

describe('PolyVault canister auth integration', () => {
  let canister: PolyVaultCanister;

  beforeEach(() => {
    canister = new PolyVaultCanister(OWNER);
  });

  describe('write methods — owner-only baseline', () => {
    it('owner can put_chunk', () => {
      const result = canister.put_chunk(OWNER, makeChunkReq());
      expect(result.ok).toBe(true);
    });

    it('stranger cannot put_chunk', () => {
      const result = canister.put_chunk(STRANGER, makeChunkReq());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Unauthorized');
      }
    });

    it('owner can finalize_commit', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      const result = canister.finalize_commit(
        OWNER,
        'cmt_1',
        null,
        'dedupe_1',
        'mhash',
        1,
      );
      expect(result.ok).toBe(true);
    });

    it('stranger cannot finalize_commit', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      const result = canister.finalize_commit(
        STRANGER,
        'cmt_1',
        null,
        'dedupe_1',
        'mhash',
        1,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Unauthorized');
      }
    });
  });

  describe('read methods — owner-only baseline', () => {
    it('owner can get_chunk', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      const chunk = canister.get_chunk(OWNER, 'bndl_1', 0);
      expect(chunk).not.toBeNull();
    });

    it('stranger gets null for get_chunk', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      const chunk = canister.get_chunk(STRANGER, 'bndl_1', 0);
      expect(chunk).toBeNull();
    });

    it('stranger gets empty list_commits', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      canister.finalize_commit(OWNER, 'cmt_1', null, 'ded', 'mh', 1);
      const result = canister.list_commits(STRANGER, 0, 10);
      expect(result.commits).toHaveLength(0);
    });

    it('stranger gets null for get_latest_commit', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      canister.finalize_commit(OWNER, 'cmt_1', null, 'ded', 'mh', 1);
      expect(canister.get_latest_commit(STRANGER)).toBeNull();
    });

    it('stranger gets empty get_chunks_for_commit', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      canister.finalize_commit(OWNER, 'cmt_1', null, 'ded', 'mh', 1);
      const result = canister.get_chunks_for_commit(STRANGER, 'cmt_1', 0, 10);
      expect(result.chunks).toHaveLength(0);
    });
  });

  describe('write allowlist grants write access', () => {
    it('allowlisted agent can put_chunk and finalize', () => {
      canister.set_allowlist(OWNER, [AGENT_A]);

      const putResult = canister.put_chunk(
        AGENT_A,
        makeChunkReq({ idempotencyKey: 'idem_a', commitId: 'cmt_a', bundleId: 'bndl_a' }),
      );
      expect(putResult.ok).toBe(true);

      const finalResult = canister.finalize_commit(
        AGENT_A,
        'cmt_a',
        null,
        'dedupe_a',
        'mhash_a',
        1,
      );
      expect(finalResult.ok).toBe(true);
    });

    it('write-allowlisted agent cannot read without read allowlist', () => {
      canister.set_allowlist(OWNER, [AGENT_A]);
      canister.put_chunk(OWNER, makeChunkReq());
      expect(canister.get_chunk(AGENT_A, 'bndl_1', 0)).toBeNull();
    });

    it('removing agent from write allowlist revokes write access', () => {
      canister.set_allowlist(OWNER, [AGENT_A]);
      canister.set_allowlist(OWNER, []);
      const result = canister.put_chunk(AGENT_A, makeChunkReq());
      expect(result.ok).toBe(false);
    });
  });

  describe('read allowlist grants read access', () => {
    it('allowlisted agent can read chunks', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      canister.set_read_allowlist(OWNER, [AGENT_A]);
      const chunk = canister.get_chunk(AGENT_A, 'bndl_1', 0);
      expect(chunk).not.toBeNull();
    });

    it('read-allowlisted agent cannot write', () => {
      canister.set_read_allowlist(OWNER, [AGENT_A]);
      const result = canister.put_chunk(AGENT_A, makeChunkReq());
      expect(result.ok).toBe(false);
    });

    it('allowlisted agent can list commits', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      canister.finalize_commit(OWNER, 'cmt_1', null, 'ded', 'mh', 1);
      canister.set_read_allowlist(OWNER, [AGENT_A]);
      const result = canister.list_commits(AGENT_A, 0, 10);
      expect(result.commits).toHaveLength(1);
    });

    it('allowlisted agent can get latest commit', () => {
      canister.put_chunk(OWNER, makeChunkReq());
      canister.finalize_commit(OWNER, 'cmt_1', null, 'ded', 'mh', 1);
      canister.set_read_allowlist(OWNER, [AGENT_A]);
      expect(canister.get_latest_commit(AGENT_A)).not.toBeNull();
    });
  });

  describe('set_allowlist / set_read_allowlist authorization', () => {
    it('stranger cannot set write allowlist', () => {
      const result = canister.set_allowlist(STRANGER, [AGENT_A]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Unauthorized');
      }
    });

    it('stranger cannot set read allowlist', () => {
      const result = canister.set_read_allowlist(STRANGER, [AGENT_A]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Unauthorized');
      }
    });

    it('write-allowlisted agent cannot set allowlist', () => {
      canister.set_allowlist(OWNER, [AGENT_A]);
      const result = canister.set_allowlist(AGENT_A, [AGENT_B]);
      expect(result.ok).toBe(false);
    });
  });

  describe('get_allowlist / get_read_allowlist authorization', () => {
    it('owner can see write allowlist', () => {
      canister.set_allowlist(OWNER, [AGENT_A, AGENT_B]);
      expect(canister.get_allowlist(OWNER)).toEqual([AGENT_A, AGENT_B]);
    });

    it('stranger gets empty array for get_allowlist', () => {
      canister.set_allowlist(OWNER, [AGENT_A]);
      expect(canister.get_allowlist(STRANGER)).toEqual([]);
    });

    it('owner can see read allowlist', () => {
      canister.set_read_allowlist(OWNER, [AGENT_A]);
      expect(canister.get_read_allowlist(OWNER)).toEqual([AGENT_A]);
    });

    it('stranger gets empty array for get_read_allowlist', () => {
      canister.set_read_allowlist(OWNER, [AGENT_A]);
      expect(canister.get_read_allowlist(STRANGER)).toEqual([]);
    });
  });

  describe('dual allowlist (read + write for same agent)', () => {
    it('agent on both lists can read and write', () => {
      canister.set_allowlist(OWNER, [AGENT_A]);
      canister.set_read_allowlist(OWNER, [AGENT_A]);

      const putResult = canister.put_chunk(
        AGENT_A,
        makeChunkReq({ idempotencyKey: 'idem_dual', commitId: 'cmt_d', bundleId: 'bndl_d' }),
      );
      expect(putResult.ok).toBe(true);

      const chunk = canister.get_chunk(AGENT_A, 'bndl_d', 0);
      expect(chunk).not.toBeNull();
    });
  });
});
