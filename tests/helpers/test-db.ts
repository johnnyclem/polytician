import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase, closeDatabase, resetAdapter } from '../../src/db/client.js';
import { resetConfig } from '../../src/config.js';

let tempDir: string | null = null;

export function setupTestDb(): void {
  tempDir = mkdtempSync(join(tmpdir(), 'polytician-test-'));
  const dbPath = join(tempDir, 'test.db');
  resetConfig();
  resetAdapter();
  initializeDatabase(dbPath);
}

export function teardownTestDb(): void {
  closeDatabase();
  resetAdapter();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}
