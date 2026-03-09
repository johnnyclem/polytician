import { z } from 'zod';
import { ThoughtFormV1Schema } from './thoughtform.js';

// --- PolyVault Bundle v1 schema ---
// Transport/commit envelope for ThoughtForm backup/restore/sync.
// Unknown fields preserved via .passthrough() for forward compatibility.

const epochMs = z.number().int().nonnegative();

export const CommitSchema = z
  .object({
    commitId: z.string().min(1),
    parentCommitId: z.string().nullable(),
    authorPrincipal: z.string().optional(),
    createdAtMs: epochMs,
    syncMode: z.enum(['backup', 'merge', 'rebase']),
    dedupeKey: z.string().min(1),
  })
  .passthrough();

export type Commit = z.infer<typeof CommitSchema>;

export const ManifestSchema = z
  .object({
    thoughtformCount: z.number().int().nonnegative(),
    payloadHash: z.string().min(1),
    compression: z.enum(['none', 'gzip']),
    encryption: z.enum(['none', 'vetkeys-aes-gcm-v1']),
    chunkCount: z.number().int().positive(),
    chunkSizeMaxBytes: z.number().int().positive().max(1_000_000),
  })
  .passthrough();

export type Manifest = z.infer<typeof ManifestSchema>;

export const DeltaSchema = z
  .object({
    sinceUpdatedAtMsExclusive: epochMs,
    untilUpdatedAtMsInclusive: epochMs,
  })
  .passthrough();

export type Delta = z.infer<typeof DeltaSchema>;

export const BundleV1Schema = z
  .object({
    version: z.string(),
    bundleId: z.string().min(1),
    commit: CommitSchema,
    manifest: ManifestSchema,
    delta: DeltaSchema,
    thoughtforms: z.array(ThoughtFormV1Schema),
    extensions: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type BundleV1 = z.infer<typeof BundleV1Schema>;

export const ChunkSchema = z
  .object({
    version: z.string(),
    bundleId: z.string().min(1),
    commitId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    chunkHash: z.string().min(1),
    payloadEncoding: z.enum(['base64', 'raw']),
    payload: z.string(),
    compressed: z.boolean(),
    encrypted: z.boolean(),
  })
  .passthrough();

export type Chunk = z.infer<typeof ChunkSchema>;
