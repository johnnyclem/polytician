import { writeFileSync } from 'node:fs';
import { parseBundle } from '../../lib/polyvault/validate.js';
import { deserializeBundle } from '../../polyvault/serializer.js';
import { reassembleChunks, ChunkIntegrityError, ChunkReassemblyError } from '../../polyvault/chunker.js';
import { decompress, type CompressionMode } from '../../polyvault/compress.js';
import { createCryptoAdapter, type EncryptionMode } from '../../polyvault/crypto.js';
import { sha256 } from '../../polyvault/hash.js';
import {
  fetchCommits,
  fetchChunksForCommit,
  CommitFetchError,
  ChunkFetchError,
  type RestoreClient,
  type CommitRecord,
} from '../../lib/polyvault/download.js';
import { vaultLogger, classifyFailure } from '../../polyvault/logger.js';
import { upsertThoughtforms, extractEmbeddingText, type UpsertResult } from '../../storage/sqlite-upsert.js';
import type { DatabaseAdapter } from '../../db/adapter.js';
import type { ThoughtFormV1 } from '../../schemas/thoughtform.js';
import type { BundleV1 } from '../../schemas/bundle.js';
import type { NetworkProfile } from '../../polyvault/types.js';
import { getNetworkConfig } from '../../polyvault/types.js';

// --- Exit codes per PRD ---

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 2;
export const EXIT_AUTH = 3;
export const EXIT_NETWORK = 4;
export const EXIT_INTEGRITY = 5;

// --- Restore options ---

export interface RestoreOptions {
  /** Output path for restored ThoughtForms JSON. */
  to: string;
  /** Restore mode: 'full' replays from genesis, 'incremental' from sinceCommitCreatedAtMs. */
  mode: 'full' | 'incremental';
  /** Compression mode expected on the stored data. */
  compression: CompressionMode;
  /** Encryption mode expected on the stored data. */
  encryption: EncryptionMode;
  /** Timestamp for incremental restore (fetch commits created after this). 0 for full. */
  sinceCommitCreatedAtMs: number;
  /** Decryption key (required if encryption != 'none'). */
  decryptionKey?: Uint8Array;
  /** Nonce for decryption (required if encryption != 'none'). */
  decryptionNonce?: Uint8Array;
  /** Output path for restore manifest JSON (optional). */
  out?: string;
  /** Network profile: 'local' (lower timeouts) or 'ic' (higher timeouts). */
  network?: NetworkProfile;
  /** Filter: only restore ThoughtForms with updatedAtMs > this value. No-op stub — reserved for future use. */
  filterUpdatedSince?: number;
  /** Filter: only restore ThoughtForms whose id starts with this prefix. No-op stub — reserved for future use. */
  filterIdPrefix?: string;
}

// --- Restore result ---

export interface RestoreResult {
  status: 'ok' | 'empty' | 'error';
  commitCount: number;
  thoughtformCount: number;
  chunksReassembled: number;
  lastCommitId: string | null;
  lastCommitCreatedAtMs: number | null;
}

// --- Core restore pipeline ---

/**
 * Run the PolyVault restore pipeline (non-interactive).
 *
 * Steps per PRD 3.2:
 * 1. List commits (paginated) since sinceCommitCreatedAtMs.
 * 2. For each commit, fetch all chunks (paginated).
 * 3. Reassemble chunks (validate hashes, ordering).
 * 4. Decrypt if encrypted.
 * 5. Decompress if compressed.
 * 6. Deserialize bundle and validate schema.
 * 7. Extract ThoughtForms.
 * 8. Write output file.
 */
export async function runRestore(
  client: RestoreClient,
  options: RestoreOptions
): Promise<{ result: RestoreResult; exitCode: number }> {
  const startMs = Date.now();
  vaultLogger.info('restore.start', {
    mode: options.mode,
    compression: options.compression,
    encryption: options.encryption,
    sinceCommitCreatedAtMs: options.sinceCommitCreatedAtMs,
  });

  // Step 1: Fetch commits
  const sinceMs = options.mode === 'full' ? 0 : options.sinceCommitCreatedAtMs;

  let commits: CommitRecord[];
  try {
    commits = await fetchCommits(client, sinceMs);
  } catch (err) {
    if (err instanceof CommitFetchError) {
      if (err.reason.includes('Unauthorized')) {
        return failRestore(`Authorization failed: ${err.reason}`, EXIT_AUTH, startMs);
      }
      return failRestore(`Failed to list commits: ${err.reason}`, EXIT_NETWORK, startMs);
    }
    const message = err instanceof Error ? err.message : String(err);
    return failRestore(`Unexpected error listing commits: ${message}`, EXIT_NETWORK, startMs);
  }

  vaultLogger.debug('restore.commits.fetched', { commitCount: commits.length });

  // No commits found
  if (commits.length === 0) {
    vaultLogger.info('restore.empty', { duration_ms: Date.now() - startMs });
    const emptyResult: RestoreResult = {
      status: 'empty',
      commitCount: 0,
      thoughtformCount: 0,
      chunksReassembled: 0,
      lastCommitId: null,
      lastCommitCreatedAtMs: null,
    };
    writeFileSync(options.to, JSON.stringify([], null, 2));
    if (options.out) {
      writeFileSync(options.out, JSON.stringify(emptyResult, null, 2));
    }
    return { result: emptyResult, exitCode: EXIT_SUCCESS };
  }

  // Sort commits by createdAtMs asc, commitId asc for deterministic replay
  commits.sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    return a.commitId < b.commitId ? -1 : a.commitId > b.commitId ? 1 : 0;
  });

  // Process each commit: fetch chunks -> reassemble -> decrypt -> decompress -> parse
  const allThoughtForms: ThoughtFormV1[] = [];
  let totalChunks = 0;

  for (const commit of commits) {
    vaultLogger.debug('restore.commit.process', {
      commitId: commit.commitId,
      chunkCount: commit.chunkCount,
      manifestHash: commit.manifestHash,
    });

    // Step 2: Fetch chunks for this commit
    let chunkRecords;
    try {
      chunkRecords = await fetchChunksForCommit(client, commit.commitId);
    } catch (err) {
      if (err instanceof ChunkFetchError) {
        if (err.reason.includes('Unauthorized')) {
          return failRestore(`Authorization failed: ${err.reason}`, EXIT_AUTH, startMs);
        }
        return failRestore(
          `Failed to fetch chunks for commit ${commit.commitId}: ${err.reason}`,
          EXIT_NETWORK,
          startMs
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return failRestore(`Unexpected error fetching chunks: ${message}`, EXIT_NETWORK, startMs);
    }

    if (chunkRecords.length === 0) {
      continue;
    }

    // Step 3: Reassemble chunks
    let reassembled: Uint8Array;
    try {
      reassembled = reassembleChunks(
        chunkRecords.map((c) => ({
          chunkIndex: c.chunkIndex,
          chunkCount: c.chunkCount,
          chunkHash: c.chunkHash,
          payload: c.payload,
        }))
      );
    } catch (err) {
      if (err instanceof ChunkIntegrityError || err instanceof ChunkReassemblyError) {
        return failRestore(
          `Integrity error for commit ${commit.commitId}: ${err.message}`,
          EXIT_INTEGRITY,
          startMs
        );
      }
      throw err;
    }
    totalChunks += chunkRecords.length;

    // Step 4: Decrypt if needed
    let decrypted: Uint8Array;
    const encrypted = chunkRecords[0]!.encrypted;
    if (encrypted && options.encryption !== 'none') {
      if (!options.decryptionKey || !options.decryptionNonce) {
        return failRestore(
          'Decryption key and nonce required for encrypted data',
          EXIT_VALIDATION,
          startMs
        );
      }
      const adapter = createCryptoAdapter(options.encryption);
      try {
        decrypted = await adapter.decrypt(reassembled, options.decryptionKey, options.decryptionNonce);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failRestore(
          `Decryption failed for commit ${commit.commitId}: ${message}`,
          EXIT_INTEGRITY,
          startMs
        );
      }
    } else {
      decrypted = reassembled;
    }

    // Step 5: Decompress if needed
    const compressed = chunkRecords[0]!.compressed;
    const compressionMode: CompressionMode = compressed ? options.compression : 'none';
    let decompressed: Uint8Array;
    try {
      decompressed = await decompress(decrypted, compressionMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failRestore(
        `Decompression failed for commit ${commit.commitId}: ${message}`,
        EXIT_INTEGRITY,
        startMs
      );
    }

    // Step 6: Deserialize and validate
    let rawBundle: unknown;
    try {
      rawBundle = deserializeBundle(decompressed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failRestore(
        `Deserialization failed for commit ${commit.commitId}: ${message}`,
        EXIT_INTEGRITY,
        startMs
      );
    }

    // Verify payload hash against commit record's manifestHash
    const actualHash = sha256(decompressed);
    if (actualHash !== commit.manifestHash) {
      return failRestore(
        `Payload hash mismatch for commit ${commit.commitId}: ` +
          `expected ${commit.manifestHash}, got ${actualHash}`,
        EXIT_INTEGRITY,
        startMs
      );
    }

    // Patch placeholder fields in the serialized bundle before Zod validation.
    // The backup pipeline serializes the bundle with payloadHash='' and
    // chunkCount=1 as placeholders (the real values live in the commit record).
    if (typeof rawBundle === 'object' && rawBundle !== null && 'manifest' in rawBundle) {
      const manifest = (rawBundle as Record<string, unknown>).manifest;
      if (typeof manifest === 'object' && manifest !== null) {
        (manifest as Record<string, unknown>).payloadHash = actualHash;
        (manifest as Record<string, unknown>).chunkCount = commit.chunkCount;
      }
    }

    const parsed = parseBundle(rawBundle);
    if (!parsed.ok) {
      const paths = parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return failRestore(
        `Bundle validation failed for commit ${commit.commitId}: ${paths}`,
        EXIT_VALIDATION,
        startMs
      );
    }

    const bundle: BundleV1 = parsed.data;

    // Step 7: Extract ThoughtForms
    allThoughtForms.push(...bundle.thoughtforms);
  }

  // Deduplicate by ID: later commits win (last-writer-wins by replay order)
  const thoughtformMap = new Map<string, ThoughtFormV1>();
  for (const tf of allThoughtForms) {
    const existing = thoughtformMap.get(tf.id);
    if (!existing || tf.metadata.updatedAtMs > existing.metadata.updatedAtMs) {
      thoughtformMap.set(tf.id, tf);
    } else if (
      tf.metadata.updatedAtMs === existing.metadata.updatedAtMs &&
      tf.metadata.contentHash > existing.metadata.contentHash
    ) {
      thoughtformMap.set(tf.id, tf);
    }
  }

  const deduped = Array.from(thoughtformMap.values());

  // Step 8: Write output
  writeFileSync(options.to, JSON.stringify(deduped, null, 2));

  const lastCommit = commits[commits.length - 1]!;
  const restoreResult: RestoreResult = {
    status: 'ok',
    commitCount: commits.length,
    thoughtformCount: deduped.length,
    chunksReassembled: totalChunks,
    lastCommitId: lastCommit.commitId,
    lastCommitCreatedAtMs: lastCommit.createdAtMs,
  };

  if (options.out) {
    writeFileSync(options.out, JSON.stringify(restoreResult, null, 2));
  }

  vaultLogger.info('restore.complete', {
    commitCount: commits.length,
    thoughtformCount: deduped.length,
    chunksReassembled: totalChunks,
    dedupedFrom: allThoughtForms.length,
    lastCommitId: lastCommit.commitId,
    duration_ms: Date.now() - startMs,
  });

  return { result: restoreResult, exitCode: EXIT_SUCCESS };
}

function failRestore(
  message: string,
  exitCode: number,
  startMs: number
): { result: RestoreResult; exitCode: number } {
  const failure = classifyFailure(exitCode, message);
  vaultLogger.error('restore.failed', {
    exitCode,
    errorCode: failure.code,
    errorMessage: failure.message,
    remediation: failure.remediation,
    duration_ms: Date.now() - startMs,
  });
  return {
    result: {
      status: 'error',
      commitCount: 0,
      thoughtformCount: 0,
      chunksReassembled: 0,
      lastCommitId: null,
      lastCommitCreatedAtMs: null,
      ...({ error: message } as Record<string, unknown>),
    } as RestoreResult,
    exitCode,
  };
}
