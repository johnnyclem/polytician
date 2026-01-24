/**
 * Database Client
 *
 * Initializes SQLite database with Drizzle ORM.
 * Handles connection, migrations, and provides query interface.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database path
const DATA_DIR = join(__dirname, "../../data");
const DB_PATH = join(DATA_DIR, "concepts.db");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Create SQLite connection with WAL mode for better concurrency
const sqlite: DatabaseType = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Create Drizzle instance
export const db = drizzle(sqlite, { schema });

// Initialize schema (create tables if not exist)
export function initializeDatabase(): void {
  console.log("Initializing database...");

  // Create concepts table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tags TEXT DEFAULT '[]',
      vector_blob BLOB,
      md_blob TEXT,
      thoughtform_blob TEXT
    )
  `);

  // Create indexes
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_concepts_created_at ON concepts(created_at);
    CREATE INDEX IF NOT EXISTS idx_concepts_updated_at ON concepts(updated_at);
  `);

  console.log("Database initialized successfully");
}

// Close database connection
export function closeDatabase(): void {
  sqlite.close();
  console.log("Database connection closed");
}

// Export raw sqlite for advanced operations
export { sqlite };
