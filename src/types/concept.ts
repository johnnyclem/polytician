import { z } from 'zod';
import { ThoughtFormSchema, ThoughtFormInputSchema } from './thoughtform.js';

export const VECTOR_DIMENSION = 384;

export type RepresentationType = 'vector' | 'markdown' | 'thoughtform';

export const ConceptSchema = z.object({
  id: z.string().uuid(),
  namespace: z.string().default('default'),
  version: z.number().int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
  tags: z.array(z.string()).default([]),
  markdown: z.string().nullable(),
  thoughtform: ThoughtFormSchema.nullable(),
  embedding: z.array(z.number()).length(VECTOR_DIMENSION).nullable(),
});

export type Concept = z.infer<typeof ConceptSchema>;

export interface ConceptRepresentations {
  vector: boolean;
  markdown: boolean;
  thoughtform: boolean;
}

export interface SearchResult {
  id: string;
  distance: number;
  tags: string[];
  representations: ConceptRepresentations;
}
