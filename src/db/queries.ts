import { drizzle } from 'drizzle-orm/better-sqlite3';
import { gt, isNotNull, desc } from 'drizzle-orm';
import { concepts } from './schema.js';
import { getAdapter } from './client.js';
import { SqliteAdapter } from './sqlite-adapter.js';
import type { ThoughtForm } from '../types/thoughtform.js';

export interface ThoughtFormDelta {
  id: string;
  namespace: string;
  version: number;
  updatedAt: number;
  tags: string[];
  thoughtform: ThoughtForm;
}

/**
 * Returns concepts with a ThoughtForm representation that have been updated
 * after the given timestamp. Uses Drizzle query builder for type-safe queries.
 *
 * @param timestamp - Unix epoch milliseconds; only records with updated_at > timestamp are returned
 * @returns Array of ThoughtFormDelta records ordered by updated_at descending
 */
export function getUpdatedThoughtFormsSince(timestamp: number): ThoughtFormDelta[] {
  const adapter = getAdapter();

  if (!(adapter instanceof SqliteAdapter)) {
    throw new Error('getUpdatedThoughtFormsSince currently supports SQLite only');
  }

  const db = drizzle(adapter.getRawDb());

  const rows = db
    .select({
      id: concepts.id,
      namespace: concepts.namespace,
      version: concepts.version,
      updatedAt: concepts.updatedAt,
      tags: concepts.tags,
      thoughtform: concepts.thoughtform,
    })
    .from(concepts)
    .where(
      gt(concepts.updatedAt, timestamp),
    )
    .orderBy(desc(concepts.updatedAt))
    .all()
    .filter((row) => row.thoughtform !== null);

  return rows.map((row) => ({
    id: row.id,
    namespace: row.namespace ?? 'default',
    version: row.version ?? 1,
    updatedAt: row.updatedAt ?? 0,
    tags: (row.tags as string[] | null) ?? [],
    thoughtform: JSON.parse(row.thoughtform as string) as ThoughtForm,
  }));
}
