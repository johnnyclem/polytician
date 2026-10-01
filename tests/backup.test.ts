import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { VECTOR_DIMENSION } from '../src/types/concept.js';

vi.mock('@huggingface/transformers', () => {
  const mockPipeline = async (text: string) => {
    const hash = Array.from(text).reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const data = new Float32Array(VECTOR_DIMENSION);
    for (let i = 0; i < VECTOR_DIMENSION; i++) data[i] = Math.sin(hash + i) * 0.5 + 0.01;
    return { data };
  };
  return { pipeline: vi.fn().mockResolvedValue(mockPipeline), env: { cacheDir: '' } };
});

import { setupTestDb, teardownTestDb } from './helpers/test-db.js';
import { ConceptService } from '../src/services/concept.service.js';
import {
  BackupService,
  exportBackup,
  importBackup,
  importBackupBytes,
} from '../src/services/backup.service.js';
import { getAdapter } from '../src/db/client.js';
import { getConfig, resetConfig } from '../src/config.js';

let service: ConceptService;
let backupSvc: BackupService;
let dataDir: string;

const ID_A = '11111111-1111-4111-a111-111111111111';
const ID_B = '22222222-2222-4222-a222-222222222222';

function vector(seed: number): number[] {
  return Array.from({ length: VECTOR_DIMENSION }, (_, i) => Math.fround(Math.cos(seed + i)));
}

function thoughtform(id: string) {
  return {
    id,
    rawText: 'Grace Hopper built the first compiler.',
    language: 'en',
    metadata: {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      author: null,
      tags: ['history'],
      source: 'user_input' as const,
    },
    entities: [],
    relationships: [],
    contextGraph: {},
  };
}

/** Delete every concept, as after data loss. */
async function wipe(): Promise<void> {
  const adapter = getAdapter();
  const { rows } = await adapter.listConcepts({ limit: 1000, offset: 0 });
  for (const row of rows) await service.delete(row.id);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'polytician-backup-'));
  process.env['POLYTICIAN_DATA_DIR'] = dataDir;
  setupTestDb();
  service = new ConceptService();
  backupSvc = new BackupService();
});

afterEach(() => {
  backupSvc.stop();
  teardownTestDb();
  delete process.env['POLYTICIAN_DATA_DIR'];
  delete process.env['POLYTICIAN_BACKUP_THRESHOLD'];
  delete process.env['POLYTICIAN_BACKUP_RETAIN'];
  delete process.env['POLYTICIAN_BACKUP_KEY'];
  delete process.env['POLYTICIAN_ENCRYPT'];
  resetConfig();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('auto-backup configuration (POLY-23)', () => {
  it('is off by default', () => {
    expect(getConfig().backup.threshold).toBe(0);
    expect(getConfig().backup.retain).toBe(10);
  });

  it('POLYTICIAN_BACKUP_THRESHOLD=0 disables it instead of meaning 50', () => {
    process.env['POLYTICIAN_BACKUP_THRESHOLD'] = '0';
    resetConfig();
    expect(getConfig().backup.threshold).toBe(0);
  });

  it('rejects a non-numeric threshold instead of guessing', () => {
    process.env['POLYTICIAN_BACKUP_THRESHOLD'] = 'lots';
    resetConfig();
    expect(() => getConfig()).toThrow(/POLYTICIAN_BACKUP_THRESHOLD must be a non-negative integer/);
  });
});

describe('BackupService – auto-backup trigger with threshold', () => {
  it('counter increments on each save when service is started', async () => {
    getConfig().backup.threshold = 100;
    backupSvc.start();
    await service.save({ markdown: '# One' });
    await tick();
    expect(await backupSvc.getCounter()).toBe(1);
    await service.save({ markdown: '# Two' });
    await tick();
    expect(await backupSvc.getCounter()).toBe(2);
  });

  it('does not count or back up while disabled', async () => {
    const runBackupSpy = vi.spyOn(backupSvc, 'runBackup');
    backupSvc.start();
    await service.save({ markdown: '# Disabled' });
    await tick();
    expect(runBackupSpy).not.toHaveBeenCalled();
    expect(await backupSvc.getCounter()).toBe(0);
  });

  it('does not increment when service is stopped', async () => {
    getConfig().backup.threshold = 100;
    backupSvc.start();
    backupSvc.stop();
    await service.save({ markdown: '# Ignored' });
    await tick();
    expect(await backupSvc.getCounter()).toBe(0);
  });

  it('triggers backup and resets counter when threshold is reached', async () => {
    getConfig().backup.threshold = 3;
    const runBackupSpy = vi.spyOn(backupSvc, 'runBackup');
    backupSvc.start();

    await service.save({ markdown: '# A' });
    await service.save({ markdown: '# B' });
    await tick();
    expect(runBackupSpy).not.toHaveBeenCalled();
    expect(await backupSvc.getCounter()).toBe(2);

    await service.save({ markdown: '# C' });
    await tick();
    expect(runBackupSpy).toHaveBeenCalledTimes(1);
    expect(await backupSvc.getCounter()).toBe(0);
  });

  it('writes one backup for a burst of saves, not one per threshold multiple', async () => {
    getConfig().backup.threshold = 2;
    const runBackupSpy = vi.spyOn(backupSvc, 'runBackup');
    backupSvc.start();
    await service.saveBatch(
      Array.from({ length: 10 }, (_, i) => ({ markdown: `# burst ${i}` }))
    );
    await tick();
    expect(runBackupSpy).toHaveBeenCalledTimes(1);
  });

  it('counter persists across service instances', async () => {
    getConfig().backup.threshold = 100;
    backupSvc.start();
    await service.save({ markdown: '# Persist' });
    await tick();
    backupSvc.stop();
    expect(await new BackupService().getCounter()).toBe(1);
  });

  it('keeps only the newest POLYTICIAN_BACKUP_RETAIN auto-backups', async () => {
    getConfig().backup.retain = 2;
    await service.save({ markdown: '# kept' });
    const paths: string[] = [];
    for (let i = 0; i < 4; i++) {
      paths.push(await backupSvc.runBackup());
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const files = readdirSync(join(dataDir, 'backups')).sort();
    expect(files).toHaveLength(2);
    expect(files).toEqual(paths.slice(2).map(p => p.split('/').pop()).sort());
  });

  it('writes owner-only files in an owner-only directory', async () => {
    await service.save({ markdown: '# private' });
    const path = await backupSvc.runBackup();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'backups')).mode & 0o777).toBe(0o700);
  });
});

describe('auto-backup restores faithfully (POLY-22)', () => {
  it('keeps tags as arrays, thoughtforms as objects and embeddings with their model id', async () => {
    await service.save({
      id: ID_A,
      namespace: 'default',
      markdown: '# Alpha',
      embedding: vector(1),
      tags: ['b', 'c'],
    });
    await service.save({ id: ID_B, namespace: 'work', thoughtform: thoughtform(ID_B), tags: ['x'] });

    const path = await backupSvc.runBackup();
    const lines = readFileSync(path, 'utf-8').trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as { embeddingModel: string };
    expect(header.embeddingModel).toBe(getConfig().embeddingModel);
    const alpha = lines.map(l => JSON.parse(l) as Record<string, unknown>).find(l => l['id'] === ID_A)!;
    expect(alpha['tags']).toEqual(['b', 'c']);
    expect(alpha['embedding']).toEqual(vector(1));

    const before = [await service.read(ID_A), await service.read(ID_B)];
    await wipe();
    const result = await importBackupBytes(readFileSync(path));
    expect(result.inserted).toBe(2);

    const after = [await service.read(ID_A), await service.read(ID_B)];
    expect(after).toEqual(before);

    // Tags stay an array: a later tag merge adds one tag.
    const merged = await service.save({ id: ID_A, tags: ['new'] });
    expect(merged.tags).toEqual(['b', 'c', 'new']);
    // Restored vectors are searchable.
    const hits = await service.search(vector(1), 1, undefined, { namespace: 'default' });
    expect(hits[0]?.id).toBe(ID_A);
  });
});

describe('exportBackup / importBackup', () => {
  it('backs up every namespace by default (POLY-04)', async () => {
    await service.save({ namespace: 'default', markdown: 'a' });
    await service.save({ namespace: 'work', markdown: 'b' });
    await service.save({ namespace: 'personal', markdown: 'c' });

    const all = await exportBackup();
    expect(all.conceptCount).toBe(3);
    expect(all.namespaces).toEqual({ default: 1, work: 1, personal: 1 });

    const one = await exportBackup({ namespaces: ['work'] });
    expect(one.namespaces).toEqual({ work: 1 });
  });

  it('restores into an empty store and reports what it did', async () => {
    await service.save({ id: ID_A, namespace: 'work', markdown: '# kept', tags: ['t'] });
    const { file } = await exportBackup();
    await wipe();

    const result = await importBackup(file);
    expect(result).toMatchObject({ inserted: 1, updated: 0, skipped: [], conceptCount: 1 });
    const restored = await service.read(ID_A, undefined, { namespace: 'work' });
    expect(restored.markdown).toBe('# kept');
    expect(restored.tags).toEqual(['t']);
  });

  it('keeps newer local edits by default and replaces them with overwrite', async () => {
    await service.save({ id: ID_A, markdown: 'backed up' });
    const { file } = await exportBackup();
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.save({ id: ID_A, markdown: 'edited after the backup' });

    const kept = await importBackup(file);
    expect(kept.skipped).toEqual([{ id: ID_A, namespace: 'default', reason: 'not-newer' }]);
    expect((await service.read(ID_A)).markdown).toBe('edited after the backup');

    const replaced = await importBackup(file, { onConflict: 'overwrite' });
    expect(replaced.updated).toBe(1);
    const after = await service.read(ID_A);
    expect(after.markdown).toBe('backed up');
    expect(after.version).toBe(3);
  });

  it('never writes a concept whose id lives in another namespace', async () => {
    await service.save({ id: ID_A, namespace: 'work', markdown: 'work copy' });
    const { file } = await exportBackup();
    await wipe();
    await service.save({ id: ID_A, namespace: 'personal', markdown: 'personal copy' });

    const result = await importBackup(file, { onConflict: 'overwrite' });
    expect(result.skipped).toEqual([{ id: ID_A, namespace: 'work', reason: 'other-namespace' }]);
    expect((await service.read(ID_A)).markdown).toBe('personal copy');
  });

  it('is all-or-nothing when a record is invalid', async () => {
    await service.save({ id: ID_A, markdown: 'fine' });
    await service.save({ id: ID_B, markdown: 'zeroed below', embedding: vector(4) });
    const { path } = await exportBackup();
    await wipe();
    const text = readFileSync(path, 'utf-8');
    // A structurally valid record whose vector is the zero vector.
    const bad = text.replace(/"embedding":\[[^\]]*\]/, `"embedding":[${new Array(VECTOR_DIMENSION).fill(0).join(',')}]`);
    const lines = bad.trimEnd().split('\n');
    const { createHash } = await import('node:crypto');
    const footer = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    footer['sha256'] = createHash('sha256')
      .update(lines.slice(0, -1).map(l => l + '\n').join(''))
      .digest('hex');
    lines[lines.length - 1] = JSON.stringify(footer);
    await expect(importBackupBytes(Buffer.from(lines.join('\n') + '\n'))).rejects.toThrow(
      /zero vector/
    );
    expect((await getAdapter().listConcepts({ limit: 10, offset: 0 })).total).toBe(0);
  });

  it('refuses vectors from another embedding model unless reembed is set', async () => {
    await service.save({ id: ID_A, markdown: 'text to re-embed', embedding: vector(2) });
    await service.save({ id: ID_B, embedding: vector(3) });
    const { path } = await exportBackup();
    await wipe();

    getConfig().embeddingModel = 'Xenova/some-other-model';
    await expect(importBackupBytes(readFileSync(path))).rejects.toThrow(/reembed: true/);

    const result = await importBackupBytes(readFileSync(path), { reembed: true });
    expect(result.reembedded).toBe(1);
    expect(result.vectorsDropped).toBe(1);
    expect(result.skipped).toEqual([{ id: ID_B, namespace: 'default', reason: 'vector-only' }]);
    const restored = await service.read(ID_A);
    expect(restored.embedding).not.toEqual(vector(2));
    expect(restored.derived?.vector).toEqual({ from: 'markdown' });
  });
});

describe('encrypted backups (POLY-03)', () => {
  const key = randomBytes(32).toString('base64');

  it('POLYTICIAN_ENCRYPT without a key fails closed', async () => {
    process.env['POLYTICIAN_ENCRYPT'] = 'true';
    resetConfig();
    await service.save({ markdown: 'secret memory' });
    await expect(exportBackup()).rejects.toThrow(/needs a backup encryption key/);
    expect(existsSync(join(dataDir, 'backups'))).toBe(false);
  });

  it('POLYTICIAN_ENCRYPT refuses a plaintext export', async () => {
    process.env['POLYTICIAN_ENCRYPT'] = 'true';
    process.env['POLYTICIAN_BACKUP_KEY'] = key;
    resetConfig();
    await expect(exportBackup({ encrypt: false })).rejects.toThrow(/plaintext export is refused/);
  });

  it('auto-backups are encrypted when POLYTICIAN_ENCRYPT is set, and restore with the key', async () => {
    process.env['POLYTICIAN_ENCRYPT'] = 'true';
    process.env['POLYTICIAN_BACKUP_KEY'] = key;
    resetConfig();
    await service.save({ id: ID_A, markdown: 'secret memory sk-live-123', tags: ['private'] });
    const path = await backupSvc.runBackup();
    const text = readFileSync(path, 'utf-8');
    expect(text).not.toContain('secret memory');
    expect(text).not.toContain('private');

    await wipe();
    const result = await importBackupBytes(readFileSync(path));
    expect(result).toMatchObject({ encrypted: true, inserted: 1 });
    expect((await service.read(ID_A)).markdown).toBe('secret memory sk-live-123');

    process.env['POLYTICIAN_BACKUP_KEY'] = randomBytes(32).toString('hex');
    await expect(importBackupBytes(readFileSync(path))).rejects.toThrow(/Wrong backup key/);
  });

  it('reads the key from an owner-only key file', async () => {
    const { writeFileSync, chmodSync } = await import('node:fs');
    const keyFile = join(dataDir, 'backup.key');
    writeFileSync(keyFile, key + '\n', { mode: 0o644 });
    chmodSync(keyFile, 0o644);
    await service.save({ markdown: 'x' });
    await expect(exportBackup({ encrypt: true })).rejects.toThrow(/chmod 600/);
    chmodSync(keyFile, 0o600);
    const result = await exportBackup({ encrypt: true });
    expect(result.encrypted).toBe(true);
    expect(result.keyId).toMatch(/^[0-9a-f]{16}$/);
  });
});

/** Allow async event handlers to process. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 30));
}
