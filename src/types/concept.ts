import { z } from 'zod';
import { ThoughtFormSchema, ThoughtFormInputSchema } from './thoughtform.js';

/**
 * Vector representation - fixed 768 dimensions (all-MiniLM-L6-v2)
 */
export const VECTOR_DIMENSION = 768;

export const VectorSchema = z.array(z.number()).length(VECTOR_DIMENSION);
export type Vector = z.infer<typeof VectorSchema>;

/**
 * Markdown representation
 */
export const MarkdownSchema = z.string().min(1);
export type Markdown = z.infer<typeof MarkdownSchema>;

/**
 * Representation types
 */
export type RepresentationType = 'vectors' | 'md' | 'thoughtForm';

/**
 * Full concept with all representations
 */
export const ConceptSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
  tags: z.array(z.string()).default([]),
  vectors: VectorSchema.nullable(),
  md: MarkdownSchema.nullable(),
  thoughtForm: ThoughtFormSchema.nullable(),
});

export type Concept = z.infer<typeof ConceptSchema>;

/**
 * Input schemas for save operations
 */
export const SaveVectorInputSchema = z.object({
  id: z.string().uuid(),
  vector: VectorSchema,
  tags: z.array(z.string()).optional(),
});

export const SaveMarkdownInputSchema = z.object({
  id: z.string().uuid(),
  md: MarkdownSchema,
  tags: z.array(z.string()).optional(),
});

export const SaveThoughtFormInputSchema = z.object({
  id: z.string().uuid(),
  thoughtForm: ThoughtFormInputSchema,
  tags: z.array(z.string()).optional(),
});

export type SaveVectorInput = z.infer<typeof SaveVectorInputSchema>;
export type SaveMarkdownInput = z.infer<typeof SaveMarkdownInputSchema>;
export type SaveThoughtFormInput = z.infer<typeof SaveThoughtFormInputSchema>;

/**
 * Read input schema
 */
export const ReadConceptInputSchema = z.object({
  id: z.string().uuid(),
});

export type ReadConceptInput = z.infer<typeof ReadConceptInputSchema>;

/**
 * Convert input schema
 */
export const ConvertConceptInputSchema = z.object({
  id: z.string().uuid(),
});

export type ConvertConceptInput = z.infer<typeof ConvertConceptInputSchema>;

/**
 * Response types
 */
export interface ConceptResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Neighbor result from FAISS search
 */
export interface NeighborResult {
  id: string;
  distance: number;
  md?: string;
  thoughtForm?: object;
}
