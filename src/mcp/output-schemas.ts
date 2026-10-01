import { z } from 'zod';
import {
  AssertionStatusSchema,
  ProvenanceMapSchema,
  RepresentationTypeSchema,
} from '../types/concept.js';

/**
 * Output schemas: the shape of every tool's `structuredContent` (the same
 * JSON is in `content[0].text`). The SDK validates each successful result
 * against its schema before sending it, and lists the schemas as JSON Schema
 * with `additionalProperties: false`, so every object here is strict: a field
 * the schema does not declare fails on the server, not in a client.
 */

const RepresentationsOut = z
  .object({ vector: z.boolean(), markdown: z.boolean(), thoughtform: z.boolean() })
  .strict();

/**
 * A concept. save_concept returns every field (null for an absent
 * representation); read_concept leaves out absent or unrequested ones.
 */
export const ConceptOut = z
  .object({
    id: z.string(),
    namespace: z.string(),
    version: z.number().int(),
    createdAt: z.number(),
    updatedAt: z.number(),
    tags: z.array(z.string()),
    markdown: z.string().nullable().optional(),
    // A ThoughtForm object; rows from 2.x may hold any JSON value.
    thoughtform: z.unknown().optional(),
    embedding: z.array(z.number()).nullable().optional(),
    provenance: ProvenanceMapSchema,
    assertionStatus: AssertionStatusSchema.nullable(),
    ledgerRef: z.string().nullable(),
  })
  .strict();

export const ListConceptsOut = z
  .object({
    concepts: z.array(
      z
        .object({
          id: z.string(),
          namespace: z.string(),
          version: z.number().int(),
          createdAt: z.number(),
          updatedAt: z.number(),
          tags: z.array(z.string()),
          representations: RepresentationsOut,
          assertionStatus: AssertionStatusSchema.nullable(),
        })
        .strict()
    ),
    total: z.number().int(),
  })
  .strict();

export const DeleteConceptOut = z.object({ deleted: z.string() }).strict();

export const BatchSaveOut = z
  .object({ count: z.number().int(), ids: z.array(z.string()) })
  .strict();

export const SearchConceptsOut = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string(),
          namespace: z.string(),
          score: z.number().min(0).max(1),
          tags: z.array(z.string()),
          representations: RepresentationsOut,
          assertionStatus: AssertionStatusSchema.nullable(),
        })
        .strict()
    ),
  })
  .strict();

export const ConvertConceptOut = z
  .object({
    converted: z.object({ from: RepresentationTypeSchema, to: RepresentationTypeSchema }).strict(),
    concept: ConceptOut,
  })
  .strict();

export const EmbedTextOut = z
  .object({ dimension: z.number().int(), embedding: z.array(z.number()) })
  .strict();

export const ReembedOut = z
  .object({
    model: z.string(),
    reembedded: z.array(z.string()),
    skipped: z.array(
      z.object({ id: z.string(), reason: z.enum(['authored', 'no-text', 'changed']) }).strict()
    ),
    remaining: z.number().int(),
  })
  .strict();

const StatsOut = z
  .object({
    conceptCount: z.number().int(),
    vectorCount: z.number().int(),
    representationCounts: z
      .object({
        markdown: z.number().int(),
        thoughtform: z.number().int(),
        vector: z.number().int(),
      })
      .strict(),
  })
  .strict();

export const GetStatsOut = StatsOut;

export const HealthCheckOut = z
  .object({
    server: z.literal('ok'),
    embedding: z
      .object({ loaded: z.boolean(), model: z.string(), dimension: z.number().int() })
      .strict(),
    llm: z.object({ provider: z.string() }).strict(),
    database: StatsOut,
  })
  .strict();

export const ExportBackupOut = z
  .object({
    file: z.string(),
    path: z.string(),
    backupId: z.string(),
    createdAt: z.string(),
    conceptCount: z.number().int(),
    namespaces: z.record(z.string(), z.number().int()),
    sizeBytes: z.number().int(),
    sha256: z.string(),
    encrypted: z.boolean(),
    keyId: z.string().nullable(),
  })
  .strict();

export const ImportBackupOut = z
  .object({
    file: z.string(),
    backupId: z.string(),
    createdAt: z.string(),
    encrypted: z.boolean(),
    conceptCount: z.number().int(),
    inserted: z.number().int(),
    updated: z.number().int(),
    skipped: z.array(
      z.object({ id: z.string(), namespace: z.string(), reason: z.string() }).strict()
    ),
    reembedded: z.number().int(),
    vectorsDropped: z.number().int(),
  })
  .strict();

export const ListBackupsOut = z
  .object({
    directory: z.string(),
    backups: z.array(
      z
        .object({
          file: z.string(),
          sizeBytes: z.number().int(),
          backupId: z.string(),
          createdAt: z.string(),
          encrypted: z.boolean(),
          keyId: z.string().nullable(),
          embeddingModel: z.string(),
        })
        .strict()
    ),
  })
  .strict();

// --- AgentVault tools: fields that come from AgentVault are typed loosely
// (any string), so an unexpected value from the remote is passed on rather
// than turned into an output validation failure. ---

export const VaultInferOut = z
  .object({
    text: z.string(),
    backend: z.string(),
    latencyMs: z.number(),
    savedConceptId: z.string().optional(),
  })
  .strict();

export const VaultMemoryPushOut = z.object({ pushed: z.literal(true), sha: z.string() }).strict();

export const VaultMemoryPullOut = z
  .object({
    pulled: z.literal(true),
    branch: z.string(),
    headSha: z.string(),
    imported: z.number().int(),
    skipped: z.array(z.object({ key: z.string(), reason: z.string() }).strict()).optional(),
  })
  .strict();

export const VaultArchiveOut = z
  .object({
    archived: z.literal(true),
    encrypted: z.literal(true),
    txId: z.string(),
    url: z.string(),
    size: z.number(),
  })
  .strict();

export const VaultGetSecretOut = z
  .object({
    name: z.string(),
    provider: z.string(),
    rotatedAt: z.number().nullable().optional(),
    valueLength: z.number().int(),
  })
  .strict();

export const VaultMemoryRepoLogOut = z
  .object({
    branch: z.string(),
    headSha: z.string(),
    entryCount: z.number().int(),
    conceptKeys: z.array(z.string()),
  })
  .strict();
