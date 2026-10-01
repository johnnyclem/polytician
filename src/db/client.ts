import type { DatabaseAdapter } from './adapter.js';
import { SqliteAdapter } from './sqlite-adapter.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

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
      'PostgreSQL backend requires async initialization. Use initializeDatabaseAsync() instead.'
    );
  }

  const dbPath = overrideDbPath ?? config.dbPath;
  const sqliteAdapter = new SqliteAdapter(dbPath);
  sqliteAdapter.initialize();
  logLegacyLabels(sqliteAdapter.labelLegacyVectors(config.embeddingModel), config.embeddingModel);
  adapter = sqliteAdapter;
  return adapter;
}

/**
 * 2.x recorded no embedding model; its vectors are labelled with the model
 * configured on the first 3.0 start (2.x's default unless the operator
 * changed it), after which a model change is detected per vector.
 */
function logLegacyLabels(count: number, model: string): void {
  if (count > 0) logger.info('labelled vectors stored before 3.0', { count, model });
}

/**
 * Async initialization — required for PostgreSQL, also works for SQLite.
 */
export async function initializeDatabaseAsync(overrideDbPath?: string): Promise<DatabaseAdapter> {
  if (adapter) return adapter;

  const config = getConfig();

  if (config.dbBackend === 'postgres') {
    const { PostgresAdapter } = await import('./postgres-adapter.js');
    const pgAdapter = new PostgresAdapter(config.postgresUrl);
    await pgAdapter.initialize();
    logLegacyLabels(
      await pgAdapter.labelLegacyVectors(config.embeddingModel),
      config.embeddingModel
    );
    adapter = pgAdapter;
    return adapter;
  }

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
