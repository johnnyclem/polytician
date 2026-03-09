import { describe, it, expect } from 'vitest';
import {
  uploadBundle,
  type CanisterClient,
  type CanisterResult,
  type PutChunkRequest,
  type FinalizeResult,
  ChunkUploadError,
} from '../../src/lib/polyvault/upload.js';
import type { NetworkConfig } from '../../src/polyvault/types.js';
import { getNetworkConfig } from '../../src/polyvault/types.js';

// --- Mock canister client ---

function makeChunk(index: number, count: number = 1) {
  return {
    chunkIndex: index,
    chunkCount: count,
    chunkHash: `hash_${index}`,
    compressed: false,
    encrypted: false,
    payload: new Uint8Array([index]),
  };
}

describe('uploadBundle with retry', () => {
  it('succeeds on first attempt with no retries needed', async () => {
    let calls = 0;
    const client: CanisterClient = {
      async putChunk(): Promise<CanisterResult<void>> {
        calls++;
        return { ok: true, value: undefined };
      },
      async finalizeCommit(): Promise<CanisterResult<FinalizeResult>> {
        return { ok: true, value: { accepted: true, duplicateOf: null } };
      },
      async getLatestCommit() {
        return null;
      },
    };

    const result = await uploadBundle(client, {
      bundleId: 'bndl_1',
      commitId: 'cmt_1',
      parentCommitId: null,
      dedupeKey: 'key_1',
      manifestHash: 'hash_1',
      chunks: [makeChunk(0), makeChunk(1, 2)],
    });

    expect(result.accepted).toBe(true);
    expect(result.chunksUploaded).toBe(2);
    expect(calls).toBe(2);
  });

  it('retries failed chunk uploads and succeeds', async () => {
    let attempts = 0;
    const client: CanisterClient = {
      async putChunk(): Promise<CanisterResult<void>> {
        attempts++;
        if (attempts <= 2) {
          throw new Error('network timeout');
        }
        return { ok: true, value: undefined };
      },
      async finalizeCommit(): Promise<CanisterResult<FinalizeResult>> {
        return { ok: true, value: { accepted: true, duplicateOf: null } };
      },
      async getLatestCommit() {
        return null;
      },
    };

    const result = await uploadBundle(client, {
      bundleId: 'bndl_1',
      commitId: 'cmt_1',
      parentCommitId: null,
      dedupeKey: 'key_1',
      manifestHash: 'hash_1',
      chunks: [makeChunk(0)],
      networkConfig: { connectTimeoutMs: 5000, requestTimeoutMs: 20000, maxConcurrentChunkFetches: 3, retryAttempts: 5 },
    });

    expect(result.accepted).toBe(true);
    expect(attempts).toBe(3); // 2 failures + 1 success
  });

  it('throws after exhausting all retries', async () => {
    const client: CanisterClient = {
      async putChunk(): Promise<CanisterResult<void>> {
        throw new Error('persistent failure');
      },
      async finalizeCommit(): Promise<CanisterResult<FinalizeResult>> {
        return { ok: true, value: { accepted: true, duplicateOf: null } };
      },
      async getLatestCommit() {
        return null;
      },
    };

    await expect(
      uploadBundle(client, {
        bundleId: 'bndl_1',
        commitId: 'cmt_1',
        parentCommitId: null,
        dedupeKey: 'key_1',
        manifestHash: 'hash_1',
        chunks: [makeChunk(0)],
        networkConfig: { connectTimeoutMs: 5000, requestTimeoutMs: 20000, maxConcurrentChunkFetches: 3, retryAttempts: 2 },
      }),
    ).rejects.toThrow('persistent failure');
  });

  it('propagates ChunkUploadError from canister result', async () => {
    let attempts = 0;
    const client: CanisterClient = {
      async putChunk(): Promise<CanisterResult<void>> {
        attempts++;
        return { ok: false, error: 'Unauthorized' };
      },
      async finalizeCommit(): Promise<CanisterResult<FinalizeResult>> {
        return { ok: true, value: { accepted: true, duplicateOf: null } };
      },
      async getLatestCommit() {
        return null;
      },
    };

    await expect(
      uploadBundle(client, {
        bundleId: 'bndl_1',
        commitId: 'cmt_1',
        parentCommitId: null,
        dedupeKey: 'key_1',
        manifestHash: 'hash_1',
        chunks: [makeChunk(0)],
        networkConfig: { connectTimeoutMs: 5000, requestTimeoutMs: 20000, maxConcurrentChunkFetches: 3, retryAttempts: 3 },
      }),
    ).rejects.toThrow(ChunkUploadError);

    // All retry attempts were made
    expect(attempts).toBe(3);
  });
});

describe('getNetworkConfig', () => {
  it('returns local profile with lower timeouts', () => {
    const config = getNetworkConfig('local');
    expect(config.connectTimeoutMs).toBe(5_000);
    expect(config.requestTimeoutMs).toBe(20_000);
    expect(config.maxConcurrentChunkFetches).toBe(3);
    expect(config.retryAttempts).toBe(5);
  });

  it('returns ic profile with higher timeouts', () => {
    const config = getNetworkConfig('ic');
    expect(config.connectTimeoutMs).toBe(15_000);
    expect(config.requestTimeoutMs).toBe(60_000);
    expect(config.maxConcurrentChunkFetches).toBe(3);
    expect(config.retryAttempts).toBe(3);
  });
});
