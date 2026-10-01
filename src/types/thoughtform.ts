import { z } from 'zod';
import { ThoughtFormV1Schema, type ThoughtFormV1 } from '../schemas/thoughtform.js';
import { LIMITS } from './limits.js';

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

// --- Stored thoughtforms ---
//
// A concept's thoughtform is either the native shape above (ISO timestamps,
// entities with `text`) or a PolyVault v1 ThoughtForm (epoch-ms timestamps,
// entities with `value`). Both are validated on write; free-form JSON is not
// accepted. Conversions read either shape through `viewThoughtForm`.

export const StoredThoughtFormSchema = z.union([ThoughtFormSchema, ThoughtFormV1Schema]);

export type StoredThoughtForm = ThoughtForm | ThoughtFormV1;

/** StoredThoughtFormSchema plus the serialized-size cap used at write boundaries. */
export const ThoughtFormInputUnionSchema = StoredThoughtFormSchema.refine(
  tf => JSON.stringify(tf).length <= LIMITS.thoughtformChars,
  { message: `thoughtform exceeds ${LIMITS.thoughtformChars} characters when serialized` }
);

export function isThoughtFormV1(tf: StoredThoughtForm): tf is ThoughtFormV1 {
  return 'schemaVersion' in tf;
}

/** Shape-independent view of a stored thoughtform, for conversions. */
export interface ThoughtFormView {
  rawText: string | null;
  entities: Array<{ id: string; text: string; type: string; confidence?: number }>;
  relationships: Array<{ subjectId: string; predicate: string; objectId: string }>;
}

export function viewThoughtForm(tf: StoredThoughtForm): ThoughtFormView {
  if (isThoughtFormV1(tf)) {
    return {
      rawText: tf.rawText ?? null,
      entities: tf.entities.map(e => ({
        id: e.id,
        text: e.value,
        type: e.type,
        confidence: e.confidence,
      })),
      relationships: tf.relationships.map(r => ({
        subjectId: r.from,
        predicate: r.type,
        objectId: r.to,
      })),
    };
  }
  return {
    rawText: tf.rawText,
    entities: tf.entities.map(e => ({
      id: e.id,
      text: e.text,
      type: e.type,
      confidence: e.confidence,
    })),
    relationships: tf.relationships.map(r => ({
      subjectId: r.subjectId,
      predicate: r.predicate,
      objectId: r.objectId,
    })),
  };
}

/** Text to embed for a thoughtform: its rawText, else its entity texts; null if there is none. */
export function thoughtFormText(tf: StoredThoughtForm): string | null {
  const view = viewThoughtForm(tf);
  if (view.rawText && view.rawText.trim().length > 0) return view.rawText;
  const entityText = view.entities
    .map(e => e.text)
    .filter(t => t.length > 0)
    .join(' ');
  return entityText.length > 0 ? entityText : null;
}
