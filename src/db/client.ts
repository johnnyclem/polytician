import type { DatabaseAdapter } from './adapter.js';
import { SqliteAdapter } from './sqlite-adapter.js';
import { getConfig } from '../config.js';

let adapter: DatabaseAdapter | null = null;

/**
 * Initialize the database using the configured backend (sqlite or postgres).
 *
 * For SQLite (default): provide an optional dbPath override.
 * For PostgreSQL: configure via POLYTICIAN_DB_BACKEND=postgres and POLYTICIAN_POSTGRES_URL.
 */
export function initializeDatabase(overrideDbPath?: string): DatabaseAdapter {
  if (adapter) return adapter;

  const config = getConfig();

  if (config.dbBackend === 'postgres') {
    throw new Error(
      'PostgreSQL backend requires async initialization. Use initializeDatabaseAsync() instead.',
    );
  }

  const dbPath = overrideDbPath ?? config.dbPath;
  const sqliteAdapter = new SqliteAdapter(dbPath);
  sqliteAdapter.initialize();
  adapter = sqliteAdapter;
  return adapter;
}

/**
 * Async initialization — required for PostgreSQL, also works for SQLite.
 */
export async function initializeDatabaseAsync(
  overrideDbPath?: string,
): Promise<DatabaseAdapter> {
  if (adapter) return adapter;
  // Create concepts table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'default',
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tags TEXT DEFAULT '[]',
      markdown TEXT,
      thoughtform TEXT,
      embedding BLOB
    )
  `);

  const config = getConfig();

  if (config.dbBackend === 'postgres') {
    const { PostgresAdapter } = await import('./postgres-adapter.js');
    const pgAdapter = new PostgresAdapter(config.postgresUrl);
    await pgAdapter.initialize();
    adapter = pgAdapter;
    return adapter;
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_concepts_namespace ON concepts(namespace)
  `);

  // Create sqlite-vec virtual table for vector search
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS concept_vectors USING vec0(
      concept_id TEXT PRIMARY KEY,
      embedding float[384]
    )
  `);

  // SQLite path (synchronous internally)
  return initializeDatabase(overrideDbPath);
}

export function getAdapter(): DatabaseAdapter {
  if (!adapter) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return adapter;
}

export function closeDatabase(): void | Promise<void> {
  if (adapter) {
    const result = adapter.close();
    adapter = null;
    return result;
  }
}

/** Reset the singleton — used by tests. */
export function resetAdapter(): void {
  adapter = null;
}
