import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import { BackupService } from '../src/services/backup.service.js';
import { getConfig } from '../src/config.js';

let service: ConceptService;
let backupSvc: BackupService;

describe('BackupService – auto-backup trigger with threshold', () => {
  beforeEach(() => {
    setupTestDb();
    service = new ConceptService();
    backupSvc = new BackupService();
  });

  afterEach(() => {
    backupSvc.stop();
    teardownTestDb();
  });

  it('counter starts at zero', async () => {
    expect(await backupSvc.getCounter()).toBe(0);
  });

  it('counter increments on each save when service is started', async () => {
    backupSvc.start();

    await service.save({ markdown: '# One' });
    // Allow async increment to complete
    await tick();
    expect(await backupSvc.getCounter()).toBe(1);

    await service.save({ markdown: '# Two' });
    await tick();
    expect(await backupSvc.getCounter()).toBe(2);
  });

  it('does not increment when service is stopped', async () => {
    backupSvc.start();
    backupSvc.stop();

    await service.save({ markdown: '# Ignored' });
    await tick();
    expect(await backupSvc.getCounter()).toBe(0);
  });

  it('triggers backup and resets counter when threshold is reached', async () => {
    // Set a low threshold for testing
    const config = getConfig();
    const originalThreshold = config.backup.threshold;
    config.backup.threshold = 3;

    const runBackupSpy = vi.spyOn(backupSvc, 'runBackup');
    backupSvc.start();

    // Save concepts up to the threshold
    await service.save({ markdown: '# A' });
    await tick();
    await service.save({ markdown: '# B' });
    await tick();

    expect(runBackupSpy).not.toHaveBeenCalled();
    expect(await backupSvc.getCounter()).toBe(2);

    // This save should trigger the backup (counter reaches 3)
    await service.save({ markdown: '# C' });
    await tick();

    expect(runBackupSpy).toHaveBeenCalledTimes(1);
    expect(await backupSvc.getCounter()).toBe(0);

    // Restore
    config.backup.threshold = originalThreshold;
  });

  it('does not trigger backup when threshold is 0 (disabled)', async () => {
    const config = getConfig();
    const originalThreshold = config.backup.threshold;
    config.backup.threshold = 0;

    const runBackupSpy = vi.spyOn(backupSvc, 'runBackup');
    backupSvc.start();

    await service.save({ markdown: '# Disabled' });
    await tick();

    expect(runBackupSpy).not.toHaveBeenCalled();
    expect(await backupSvc.getCounter()).toBe(0);

    config.backup.threshold = originalThreshold;
  });

  it('runBackup creates a valid JSON backup file', async () => {
    // Save some concepts first
    await service.save({ markdown: '# Concept 1', tags: ['test'] });
    await service.save({ markdown: '# Concept 2', tags: ['test'] });

    const filepath = await backupSvc.runBackup();

    expect(existsSync(filepath)).toBe(true);

    const contents = JSON.parse(readFileSync(filepath, 'utf-8'));
    expect(contents.version).toBe('1.0');
    expect(contents.conceptCount).toBe(2);
    expect(contents.concepts).toHaveLength(2);
    expect(contents.concepts[0].markdown).toBeDefined();
  });

  it('backup file is placed in the backups subdirectory', async () => {
    const config = getConfig();
    const backupDir = join(config.dataDir, 'backups');

    await service.save({ markdown: '# For backup' });
    await backupSvc.runBackup();

    expect(existsSync(backupDir)).toBe(true);
    const files = readdirSync(backupDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toMatch(/^backup-.*\.json$/);
  });

  it('counter resets after backup and resumes counting', async () => {
    const config = getConfig();
    const originalThreshold = config.backup.threshold;
    config.backup.threshold = 2;

    backupSvc.start();

    // First cycle
    await service.save({ markdown: '# Round 1a' });
    await tick();
    await service.save({ markdown: '# Round 1b' });
    await tick();
    expect(await backupSvc.getCounter()).toBe(0); // reset after backup

    // Second cycle starts fresh
    await service.save({ markdown: '# Round 2a' });
    await tick();
    expect(await backupSvc.getCounter()).toBe(1);

    config.backup.threshold = originalThreshold;
  });

  it('counter persists across service instances', async () => {
    backupSvc.start();
    await service.save({ markdown: '# Persist' });
    await tick();
    backupSvc.stop();

    // Create a new service instance — counter should still be 1
    const backupSvc2 = new BackupService();
    expect(await backupSvc2.getCounter()).toBe(1);
  });
});

/** Allow async event handlers to process. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
