import { z } from 'zod';

export const EntitySchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.string(),
  confidence: z.number().min(0).max(1),
  offset: z.object({
    start: z.number(),
    end: z.number(),
  }),
});

export type Entity = z.infer<typeof EntitySchema>;

export const RelationshipSchema = z.object({
  subjectId: z.string(),
  predicate: z.string(),
  objectId: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

export const MetadataSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  author: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  source: z.enum(['user_input', 'converted', 'extracted']).default('user_input'),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const ThoughtFormSchema = z.object({
  id: z.string().uuid(),
  rawText: z.string(),
  language: z.string().default('en'),
  metadata: MetadataSchema,
  entities: z.array(EntitySchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  contextGraph: z.record(z.string(), z.array(z.string())).default({}),
});

export type ThoughtForm = z.infer<typeof ThoughtFormSchema>;

export const ThoughtFormInputSchema = z.object({
  id: z.string().uuid().optional(),
  rawText: z.string().min(1),
  language: z.string().default('en'),
  metadata: MetadataSchema.partial().optional(),
  entities: z.array(EntitySchema).optional(),
  relationships: z.array(RelationshipSchema).optional(),
  contextGraph: z.record(z.string(), z.array(z.string())).optional(),
});

export type ThoughtFormInput = z.infer<typeof ThoughtFormInputSchema>;
