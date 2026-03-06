import type { CanisterResult } from './upload.js';

/**
 * PolyVault commit/chunk download + reassembly orchestration.
 *
 * Provides a RestoreClient interface and a downloadCommit() function
 * that fetches all chunks for a commit, paginated, and returns them
 * ready for reassembly.
 */

// --- Types matching Motoko canister responses ---

export interface CommitRecord {
  commitId: string;
  parentCommitId: string | null;
  dedupeKey: string;
  manifestHash: string;
  chunkCount: number;
  createdAtMs: number;
}

export interface ChunkRecord {
  bundleId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  compressed: boolean;
  encrypted: boolean;
  payload: Uint8Array;
}

export interface CommitListResult {
  commits: CommitRecord[];
  nextCursor: string | null;
}

export interface ChunkListResult {
  chunks: ChunkRecord[];
  nextOffset: number | null;
}

// --- Restore client interface ---

export interface RestoreClient {
  listCommits(
    sinceCreatedAtMs: number,
    limit: number,
    cursor: string | null
  ): Promise<CanisterResult<CommitListResult>>;
  getChunksForCommit(
    commitId: string,
    offset: number,
    limit: number
  ): Promise<CanisterResult<ChunkListResult>>;
}

// --- Errors ---

export class CommitFetchError extends Error {
  constructor(public readonly reason: string) {
    super(`Failed to fetch commits: ${reason}`);
    this.name = 'CommitFetchError';
  }
}

export class ChunkFetchError extends Error {
  constructor(
    public readonly commitId: string,
    public readonly reason: string
  ) {
    super(`Failed to fetch chunks for commit ${commitId}: ${reason}`);
    this.name = 'ChunkFetchError';
  }
}

// --- Download orchestrator ---

const DEFAULT_CHUNK_PAGE_SIZE = 50;

/**
 * Fetch all commits since a given timestamp, handling pagination.
 */
export async function fetchCommits(
  client: RestoreClient,
  sinceCreatedAtMs: number,
  pageSize: number = 50
): Promise<CommitRecord[]> {
  const allCommits: CommitRecord[] = [];
  let cursor: string | null = null;

  do {
    const result = await client.listCommits(sinceCreatedAtMs, pageSize, cursor);
    if (!result.ok) {
      throw new CommitFetchError(result.error);
    }
    allCommits.push(...result.value.commits);
    cursor = result.value.nextCursor;
  } while (cursor !== null);

  return allCommits;
}

/**
 * Fetch all chunks for a single commit, handling pagination.
 */
export async function fetchChunksForCommit(
  client: RestoreClient,
  commitId: string,
  pageSize: number = DEFAULT_CHUNK_PAGE_SIZE
): Promise<ChunkRecord[]> {
  const allChunks: ChunkRecord[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await client.getChunksForCommit(commitId, offset, pageSize);
    if (!result.ok) {
      throw new ChunkFetchError(commitId, result.error);
    }
    allChunks.push(...result.value.chunks);
    if (result.value.nextOffset !== null) {
      offset = result.value.nextOffset;
    } else {
      hasMore = false;
    }
  }

  return allChunks;
}
