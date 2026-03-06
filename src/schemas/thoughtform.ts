import { z } from 'zod';

// --- PolyVault canonical ThoughtForm v1 schema ---
// Forward-compatibility: unknown fields preserved via .passthrough()
// Timestamps: epoch milliseconds UTC, validated as non-negative integers

export const SCHEMA_VERSION_V1 = '1.0';

const epochMs = z.number().int().nonnegative();

export const RedactionSchema = z
  .object({
    rawTextOmitted: z.boolean(),
  })
  .passthrough();

export type Redaction = z.infer<typeof RedactionSchema>;

export const ThoughtMetadataV1Schema = z
  .object({
    createdAtMs: epochMs,
    updatedAtMs: epochMs,
    source: z.string().min(1),
    sourceDeviceId: z.string().optional(),
    authorPrincipal: z.string().optional(),
    contentHash: z.string().min(16),
    redaction: RedactionSchema,
    tombstone: z.boolean().optional(),
  })
  .passthrough();

export type ThoughtMetadataV1 = z.infer<typeof ThoughtMetadataV1Schema>;

export const EntityV1Schema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    value: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();

export type EntityV1 = z.infer<typeof EntityV1Schema>;

export const RelationshipV1Schema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    weight: z.number().optional(),
  })
  .passthrough();

export type RelationshipV1 = z.infer<typeof RelationshipV1Schema>;

export const ThoughtFormV1Schema = z
  .object({
    schemaVersion: z.string(),
    id: z.string().min(1),
    rawText: z.string().optional(),
    entities: z.array(EntityV1Schema),
    relationships: z.array(RelationshipV1Schema),
    contextGraph: z.record(z.unknown()),
    metadata: ThoughtMetadataV1Schema,
    extensions: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type ThoughtFormV1 = z.infer<typeof ThoughtFormV1Schema>;
