import { z } from "zod";

/**
 * Entity extracted from text via NER
 */
export const EntitySchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.string(), // e.g., PERSON, ORG, DATE, GPE, etc.
  confidence: z.number().min(0).max(1),
  offset: z.object({
    start: z.number(),
    end: z.number(),
  }),
});

export type Entity = z.infer<typeof EntitySchema>;

/**
 * Relationship between two entities
 */
export const RelationshipSchema = z.object({
  subjectId: z.string(),
  predicate: z.string(), // e.g., "is_about", "located_in", "works_for"
  objectId: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

/**
 * Metadata for the ThoughtForm
 */
export const MetadataSchema = z.object({
  timestamp: z.string().datetime(),
  author: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  source: z.string().optional(), // e.g., "user_input", "imported", "converted"
});

export type Metadata = z.infer<typeof MetadataSchema>;

/**
 * ThoughtForm - Universal representation of a concept
 * Acts as the canonical intermediate format for conversions
 */
export const ThoughtFormSchema = z.object({
  id: z.string().uuid(),
  rawText: z.string(),
  language: z.string().default("en"), // ISO-639-1
  metadata: MetadataSchema,
  entities: z.array(EntitySchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  contextGraph: z.record(z.string(), z.array(z.string())).default({}), // adjacency list
  embeddings: z.array(z.number()).optional(), // optional cached vector
});

export type ThoughtForm = z.infer<typeof ThoughtFormSchema>;

/**
 * Input schema for creating a new ThoughtForm (minimal required fields)
 */
export const ThoughtFormInputSchema = z.object({
  id: z.string().uuid().optional(),
  rawText: z.string().min(1),
  language: z.string().default("en"),
  metadata: MetadataSchema.partial().optional(),
  entities: z.array(EntitySchema).optional(),
  relationships: z.array(RelationshipSchema).optional(),
  contextGraph: z.record(z.string(), z.array(z.string())).optional(),
  embeddings: z.array(z.number()).optional(),
});

export type ThoughtFormInput = z.infer<typeof ThoughtFormInputSchema>;
