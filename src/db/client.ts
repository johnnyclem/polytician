import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { getConfig } from '../config.js';

let sqlite: DatabaseType | null = null;
let drizzleDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function initializeDatabase(overrideDbPath?: string): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: DatabaseType } {
  if (sqlite && drizzleDb) {
    return { db: drizzleDb, sqlite };
  }

  const config = getConfig();
  const dbPath = overrideDbPath ?? config.dbPath;

  // Ensure parent directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Create SQLite connection
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  sqliteVec.load(sqlite);

  // Create concepts table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tags TEXT DEFAULT '[]',
      markdown TEXT,
      thoughtform TEXT,
      embedding BLOB
    )
  `);

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_concepts_updated ON concepts(updated_at)
  `);

  // Create sqlite-vec virtual table for vector search
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS concept_vectors USING vec0(
      concept_id TEXT PRIMARY KEY,
      embedding float[384]
    )
  `);

  drizzleDb = drizzle(sqlite, { schema });
  return { db: drizzleDb, sqlite };
}

export function getDatabase(): ReturnType<typeof drizzle<typeof schema>> {
  if (!drizzleDb) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return drizzleDb;
}

export function getSqlite(): DatabaseType {
  if (!sqlite) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return sqlite;
}

export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    drizzleDb = null;
  }
}
