import { sqliteTable, text, blob, integer } from 'drizzle-orm/sqlite-core';

/**
 * Main concepts table storing all three representations
 * - vector_blob: Binary blob of Float32Array (768 dimensions * 4 bytes = 3072 bytes)
 * - md_blob: Raw markdown string
 * - thoughtform_blob: JSON-encoded ThoughtForm (UTF-8)
 */
export const concepts = sqliteTable('concepts', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  vectorBlob: blob('vector_blob', { mode: 'buffer' }),
  mdBlob: text('md_blob'),
  thoughtformBlob: text('thoughtform_blob'),
});

export type ConceptRow = typeof concepts.$inferSelect;
export type ConceptInsert = typeof concepts.$inferInsert;
