import { readFileSync, writeFileSync } from 'node:fs';
import { parseThoughtForm } from '../../lib/polyvault/validate.js';
import { serializeBundle } from '../../polyvault/serializer.js';
import { chunkPayload, MAX_CHUNK_SIZE } from '../../polyvault/chunker.js';
import { compress, type CompressionMode } from '../../polyvault/compress.js';
import { requireEncryptionAdapter, type EncryptionMode } from '../../polyvault/crypto.js';
import { sha256String } from '../../polyvault/hash.js';
import {
  uploadBundle,
  ChunkUploadError,
  FinalizeError,
  type CanisterClient,
  type ChunkInput,
} from '../../lib/polyvault/upload.js';
import type { ThoughtFormV1 } from '../../schemas/thoughtform.js';
import type { BundleV1 } from '../../schemas/bundle.js';

// --- Exit codes per PRD ---

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 2;
export const EXIT_AUTH = 3;
export const EXIT_NETWORK = 4;
export const EXIT_INTEGRITY = 5;

// --- Backup options ---

export interface BackupOptions {
  /** Path to input JSON file containing ThoughtForm array. */
  from: string;
  /** Compression mode: 'none' | 'gzip'. */
  compress: CompressionMode;
  /** Encryption mode: 'none' | 'vetkeys-aes-gcm-v1'. */
  encrypt: EncryptionMode;
  /** Whether encryption is required (fail-closed if unavailable). */
  encryptionRequired: boolean;
  /** Max chunk size in bytes (<=1MB). */
  chunkSize: number;
  /** Only include ThoughtForms with updatedAtMs > this value. */
  sinceUpdatedAt: number;
  /** Output path for backup manifest JSON (optional). */
  out?: string;
  /** Encryption key (required if encrypt != 'none'). */
  encryptionKey?: Uint8Array;
}

// --- Backup result (JSON output) ---

export interface BackupResult {
  status: 'ok' | 'duplicate' | 'error';
  bundleId: string;
  commitId: string;
  parentCommitId: string | null;
  thoughtformCount: number;
  chunkCount: number;
  chunksUploaded: number;
  payloadHash: string;
  compression: CompressionMode;
  encryption: EncryptionMode;
  duplicateOf: string | null;
}

// --- Core backup pipeline ---

/**
 * Run the PolyVault backup pipeline (non-interactive).
 *
 * Steps per PRD 3.1:
 * 1. Read and validate ThoughtForms from input file.
 * 2. Filter by sinceUpdatedAt (exclusive lower bound).
 * 3. Canonical sort: updatedAtMs asc, id asc, contentHash asc.
 * 4. Build bundle + compute commitId/dedupeKey.
 * 5. Serialize -> compress -> encrypt -> chunk.
 * 6. Upload chunks with idempotency keys.
 * 7. Finalize commit.
 * 8. Write manifest if --out provided.
 */
export async function runBackup(
  client: CanisterClient,
  options: BackupOptions
): Promise<{ result: BackupResult; exitCode: number }> {
  // Step 1: Read input
  let rawInput: unknown;
  try {
    const text = readFileSync(options.from, 'utf-8');
    rawInput = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: errorResult(`Failed to read input file: ${message}`),
      exitCode: EXIT_VALIDATION,
    };
  }

  if (!Array.isArray(rawInput)) {
    return {
      result: errorResult('Input must be a JSON array of ThoughtForms'),
      exitCode: EXIT_VALIDATION,
    };
  }

  // Validate each ThoughtForm
  const thoughtforms: ThoughtFormV1[] = [];
  for (let i = 0; i < rawInput.length; i++) {
    const parsed = parseThoughtForm(rawInput[i]);
    if (parsed.ok === false) {
      const paths = parsed.errors.map(e => `${e.path}: ${e.message}`).join('; ');
      return {
        result: errorResult(`ThoughtForm[${i}] validation failed: ${paths}`),
        exitCode: EXIT_VALIDATION,
      };
    }
    thoughtforms.push(parsed.data);
  }

  // Step 2: Filter by sinceUpdatedAt
  const filtered = thoughtforms.filter(tf => tf.metadata.updatedAtMs > options.sinceUpdatedAt);

  // Step 3: Canonical sort
  filtered.sort((a, b) => {
    if (a.metadata.updatedAtMs !== b.metadata.updatedAtMs) {
      return a.metadata.updatedAtMs - b.metadata.updatedAtMs;
    }
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return a.metadata.contentHash < b.metadata.contentHash
      ? -1
      : a.metadata.contentHash > b.metadata.contentHash
        ? 1
        : 0;
  });

  // Empty backup: still valid, no-op
  if (filtered.length === 0) {
    const emptyResult: BackupResult = {
      status: 'ok',
      bundleId: '',
      commitId: '',
      parentCommitId: null,
      thoughtformCount: 0,
      chunkCount: 0,
      chunksUploaded: 0,
      payloadHash: '',
      compression: options.compress,
      encryption: options.encrypt,
      duplicateOf: null,
    };
    if (options.out) {
      writeFileSync(options.out, JSON.stringify(emptyResult, null, 2));
    }
    return { result: emptyResult, exitCode: EXIT_SUCCESS };
  }

  // Get latest commit for parent chain
  let parentCommitId: string | null = null;
  try {
    const latest = await client.getLatestCommit();
    if (latest) {
      parentCommitId = latest.commitId;
    }
  } catch {
    // Non-fatal: first backup has no parent
  }

  // Step 4: Build bundle
  const updatedAtValues = filtered.map(tf => tf.metadata.updatedAtMs);
  const sinceExclusive = options.sinceUpdatedAt;
  const untilInclusive = Math.max(...updatedAtValues);

  // Compute content-based dedupeKey from sorted ThoughtForm content hashes.
  // This ensures identical data produces the same dedupeKey regardless of
  // when the backup runs (PRD: "Re-running backup with unchanged data
  // returns duplicateOf and no new storage growth").
  const contentFingerprint = filtered.map(tf => tf.metadata.contentHash).join(':');
  const dedupeKey = sha256String(
    contentFingerprint + ':' + options.compress + ':' + options.encrypt
  );

  // bundleId is deterministic from dedupeKey to support idempotent reruns
  const bundleId = `bndl_${dedupeKey.slice(0, 32)}`;
  const commitId = `cmt_${dedupeKey.slice(0, 64)}`;

  const bundle: BundleV1 = {
    version: '1.0',
    bundleId,
    commit: {
      commitId,
      parentCommitId,
      createdAtMs: Date.now(),
      syncMode: 'backup',
      dedupeKey,
    },
    manifest: {
      thoughtformCount: filtered.length,
      payloadHash: '', // placeholder, filled after serialization
      compression: options.compress,
      encryption: options.encrypt,
      chunkCount: 1, // placeholder
      chunkSizeMaxBytes: Math.min(options.chunkSize, MAX_CHUNK_SIZE),
    },
    delta: {
      sinceUpdatedAtMsExclusive: sinceExclusive,
      untilUpdatedAtMsInclusive: untilInclusive,
    },
    thoughtforms: filtered,
  };

  // Step 5: Serialize
  const { bytes: serializedBytes, payloadHash } = serializeBundle(bundle);

  // Compress
  const compressedBytes = await compress(serializedBytes, options.compress);

  // Encrypt
  const cryptoAdapter = requireEncryptionAdapter(options.encrypt, options.encryptionRequired);
  let finalBytes: Uint8Array;
  if (options.encrypt !== 'none') {
    if (!options.encryptionKey) {
      return {
        result: errorResult('Encryption key required but not provided'),
        exitCode: EXIT_VALIDATION,
      };
    }
    const { ciphertext } = await cryptoAdapter.encrypt(compressedBytes, options.encryptionKey);
    finalBytes = ciphertext;
  } else {
    finalBytes = compressedBytes;
  }

  // Chunk
  const chunkSize = Math.min(options.chunkSize, MAX_CHUNK_SIZE);
  const rawChunks = chunkPayload(finalBytes, { maxChunkSize: chunkSize });

  // Build chunk inputs
  const chunkInputs: ChunkInput[] = rawChunks.map(c => ({
    chunkIndex: c.chunkIndex,
    chunkCount: c.chunkCount,
    chunkHash: c.chunkHash,
    compressed: options.compress !== 'none',
    encrypted: options.encrypt !== 'none',
    payload: c.payload,
  }));

  // Step 6 & 7: Upload and finalize
  try {
    const uploadResult = await uploadBundle(client, {
      bundleId,
      commitId,
      parentCommitId,
      dedupeKey,
      manifestHash: payloadHash,
      chunks: chunkInputs,
    });

    const backupResult: BackupResult = {
      status: uploadResult.accepted ? 'ok' : 'duplicate',
      bundleId,
      commitId,
      parentCommitId,
      thoughtformCount: filtered.length,
      chunkCount: rawChunks.length,
      chunksUploaded: uploadResult.chunksUploaded,
      payloadHash,
      compression: options.compress,
      encryption: options.encrypt,
      duplicateOf: uploadResult.duplicateOf,
    };

    // Step 8: Write manifest
    if (options.out) {
      writeFileSync(options.out, JSON.stringify(backupResult, null, 2));
    }

    return { result: backupResult, exitCode: EXIT_SUCCESS };
  } catch (err) {
    if (err instanceof ChunkUploadError) {
      return {
        result: errorResult(`Chunk upload failed: ${err.message}`),
        exitCode: EXIT_NETWORK,
      };
    }
    if (err instanceof FinalizeError) {
      if (err.reason.includes('Unauthorized')) {
        return {
          result: errorResult(`Authorization failed: ${err.reason}`),
          exitCode: EXIT_AUTH,
        };
      }
      return {
        result: errorResult(`Finalize failed: ${err.reason}`),
        exitCode: EXIT_INTEGRITY,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: errorResult(`Unexpected error: ${message}`),
      exitCode: EXIT_NETWORK,
    };
  }
}

function errorResult(message: string): BackupResult {
  return {
    status: 'error',
    bundleId: '',
    commitId: '',
    parentCommitId: null,
    thoughtformCount: 0,
    chunkCount: 0,
    chunksUploaded: 0,
    payloadHash: '',
    compression: 'none',
    encryption: 'none',
    duplicateOf: null,
    ...({ error: message } as Record<string, unknown>),
  } as BackupResult;
}
