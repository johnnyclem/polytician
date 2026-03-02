import { sqliteTable, text, blob, integer } from 'drizzle-orm/sqlite-core';

export const concepts = sqliteTable('concepts', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  markdown: text('markdown'),
  thoughtform: text('thoughtform'),
  embedding: blob('embedding', { mode: 'buffer' }),
});

export type ConceptRow = typeof concepts.$inferSelect;
export type ConceptInsert = typeof concepts.$inferInsert;
