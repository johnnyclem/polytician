import { sqliteTable, text, blob, integer } from 'drizzle-orm/sqlite-core';

export const concepts = sqliteTable('concepts', {
  id: text('id').primaryKey(),
  namespace: text('namespace').notNull().default('default'),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  markdown: text('markdown'),
  thoughtform: text('thoughtform'),
  embedding: blob('embedding', { mode: 'buffer' }),
  provenance: text('provenance', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  assertionStatus: text('assertion_status'),
  ledgerRef: text('ledger_ref'),
});

export type ConceptRow = typeof concepts.$inferSelect;
export type ConceptInsert = typeof concepts.$inferInsert;
