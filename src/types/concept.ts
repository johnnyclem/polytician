import { z } from 'zod';
import { StoredThoughtFormSchema, ThoughtFormInputUnionSchema } from './thoughtform.js';
import { FLOAT32_MAX, LIMITS, NAMESPACE_PATTERN } from './limits.js';

export const VECTOR_DIMENSION = 384;

export type RepresentationType = 'vector' | 'markdown' | 'thoughtform';

export const RepresentationTypeSchema = z.enum(['vector', 'markdown', 'thoughtform']);

/**
 * Why an embedding is unusable, or null if it is a valid VECTOR_DIMENSION-d,
 * finite, float32-representable, non-zero vector (cosine needs a direction).
 */
export function embeddingProblem(embedding: unknown): string | null {
  if (!Array.isArray(embedding)) return 'embedding must be an array of numbers';
  if (embedding.length !== VECTOR_DIMENSION) {
    return `embedding must have ${VECTOR_DIMENSION} dimensions, got ${embedding.length}`;
  }
  let normSq = 0;
  for (let i = 0; i < embedding.length; i++) {
    const x: unknown = embedding[i];
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > FLOAT32_MAX) {
      return `embedding[${i}] must be a finite float32 value`;
    }
    normSq += x * x;
  }
  if (!(normSq > 0)) return 'embedding must not be the zero vector';
  return null;
}

// --- Input schemas shared by the MCP tools and the service layer ---

export const NamespaceSchema = z
  .string()
  .regex(NAMESPACE_PATTERN, 'namespace must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$');

export const TagSchema = z.string().min(1).max(LIMITS.tagChars);

export const TagsSchema = z.array(TagSchema).max(LIMITS.tags);

export const MarkdownSchema = z.string().max(LIMITS.markdownChars);

export const EmbeddingSchema = z
  .array(z.number())
  .length(VECTOR_DIMENSION)
  .superRefine((embedding, ctx) => {
    const problem = embeddingProblem(embedding);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

export const ThoughtFormInputSchema = ThoughtFormInputUnionSchema;

// --- Provenance of derived representations ---

export const ProvenanceSchema = z.object({
  /** Representation the content was derived from. */
  from: RepresentationTypeSchema,
  /** LLM provider or NLP pipeline that produced it, when one was involved. */
  provider: z.string().optional(),
  /** Other concepts whose content was used (e.g. nearest neighbours). */
  sources: z.array(z.string()).optional(),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Representations that were derived from another representation rather than
 * authored by a caller. A representation absent from this map is authored.
 */
export type DerivedMap = Partial<Record<RepresentationType, Provenance>>;

export const ConceptSchema = z.object({
  id: z.string().uuid(),
  namespace: z.string().default('default'),
  version: z.number().int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
  tags: z.array(z.string()).default([]),
  markdown: z.string().nullable(),
  thoughtform: StoredThoughtFormSchema.nullable(),
  embedding: z.array(z.number()).length(VECTOR_DIMENSION).nullable(),
  derived: z.record(RepresentationTypeSchema, ProvenanceSchema).default({}),
});

export type Concept = z.infer<typeof ConceptSchema>;

export interface ConceptRepresentations {
  vector: boolean;
  markdown: boolean;
  thoughtform: boolean;
}

export interface SearchResult {
  id: string;
  namespace: string;
  /** (1 + cosine similarity) / 2, in [0, 1]; 1 is the same direction as the query. */
  score: number;
  tags: string[];
  representations: ConceptRepresentations;
}
