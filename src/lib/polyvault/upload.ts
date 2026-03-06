import { idempotencyKey } from './idempotency.js';

/**
 * PolyVault chunk upload + commit finalization.
 *
 * This module provides a CanisterClient interface and an uploadBundle()
 * orchestrator that uploads chunks idempotently then finalizes the commit.
 * It is intentionally side-effect-free beyond calling the canister methods,
 * making it testable with an in-memory stub.
 */

// --- Canister client interface ---

export interface PutChunkRequest {
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

export interface FinalizeResult {
  accepted: boolean;
  duplicateOf: string | null;
}

export type CanisterResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CanisterClient {
  putChunk(req: PutChunkRequest): Promise<CanisterResult<void>>;
  finalizeCommit(
    commitId: string,
    parentCommitId: string | null,
    dedupeKey: string,
    manifestHash: string,
    expectedChunkCount: number
  ): Promise<CanisterResult<FinalizeResult>>;
  getLatestCommit(): Promise<{ commitId: string; createdAtMs: number } | null>;
}

// --- Upload types ---

export interface ChunkInput {
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  compressed: boolean;
  encrypted: boolean;
  payload: Uint8Array;
}

export interface UploadBundleRequest {
  bundleId: string;
  commitId: string;
  parentCommitId: string | null;
  dedupeKey: string;
  manifestHash: string;
  chunks: ChunkInput[];
}

export interface UploadResult {
  accepted: boolean;
  duplicateOf: string | null;
  chunksUploaded: number;
}

// --- Errors ---

export class ChunkUploadError extends Error {
  constructor(
    public readonly chunkIndex: number,
    public readonly reason: string
  ) {
    super(`Chunk ${chunkIndex} upload failed: ${reason}`);
    this.name = 'ChunkUploadError';
  }
}

export class FinalizeError extends Error {
  constructor(public readonly reason: string) {
    super(`Finalize commit failed: ${reason}`);
    this.name = 'FinalizeError';
  }
}

// --- Upload orchestrator ---

/**
 * Upload all chunks for a bundle and finalize the commit.
 *
 * Chunks are uploaded sequentially with idempotency keys per the PRD.
 * If the commit is a duplicate (same dedupeKey already finalized),
 * the result indicates `accepted: false` with the existing commitId.
 */
export async function uploadBundle(
  client: CanisterClient,
  req: UploadBundleRequest
): Promise<UploadResult> {
  let chunksUploaded = 0;

  for (const chunk of req.chunks) {
    const idemKey = idempotencyKey(req.commitId, chunk.chunkIndex, chunk.chunkHash);

    const result = await client.putChunk({
      idempotencyKey: idemKey,
      commitId: req.commitId,
      bundleId: req.bundleId,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      chunkHash: chunk.chunkHash,
      compressed: chunk.compressed,
      encrypted: chunk.encrypted,
      payload: chunk.payload,
    });

    if (result.ok === false) {
      throw new ChunkUploadError(chunk.chunkIndex, result.error);
    }
    chunksUploaded++;
  }

  const finalResult = await client.finalizeCommit(
    req.commitId,
    req.parentCommitId,
    req.dedupeKey,
    req.manifestHash,
    req.chunks.length
  );

  if (finalResult.ok === false) {
    throw new FinalizeError(finalResult.error);
  }

  return {
    accepted: finalResult.value.accepted,
    duplicateOf: finalResult.value.duplicateOf,
    chunksUploaded,
  };
}
