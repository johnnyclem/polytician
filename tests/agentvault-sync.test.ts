import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const CLI = 'npx tsx bin/agentvault-sync.ts';

let tempDir: string;

function run(args: string, env?: Record<string, string>): string {
  return execSync(`${CLI} ${args}`, {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, POLYTICIAN_DATA_DIR: tempDir, ...env },
    timeout: 30_000,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'av-sync-test-'));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('agentvault-sync CLI', () => {
  it('should print usage when called with --help', () => {
    const output = run('--help');
    expect(output).toContain('Usage: agentvault-sync');
    expect(output).toContain('backup');
    expect(output).toContain('restore');
    expect(output).toContain('sync');
  });

  it('should print usage when called with no arguments', () => {
    const output = run('');
    expect(output).toContain('Usage: agentvault-sync');
  });

  it('should exit with error for unknown subcommand', () => {
    expect(() => run('foobar')).toThrow();
  });
});

describe('agentvault-sync backup & restore round-trip', () => {
  it('should backup an empty database', () => {
    const backupPath = join(tempDir, 'backup.json');
    const output = run(`backup --out ${backupPath}`);
    expect(output).toContain('wrote 0 concepts');
    expect(existsSync(backupPath)).toBe(true);

    const data = JSON.parse(readFileSync(backupPath, 'utf-8'));
    expect(data.version).toBe(1);
    expect(data.concepts).toEqual([]);
    expect(data.conceptCount).toBe(0);
  });

  it('should restore concepts from a backup file', () => {
    const backupPath = join(tempDir, 'backup.json');
    const backupData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      namespace: 'all',
      conceptCount: 2,
      concepts: [
        {
          id: '11111111-1111-4111-a111-111111111111',
          namespace: 'default',
          markdown: '# Concept A',
          tags: ['tag1'],
        },
        {
          id: '22222222-2222-4222-a222-222222222222',
          namespace: 'default',
          markdown: '# Concept B',
          tags: ['tag2'],
        },
      ],
    };
    writeFileSync(backupPath, JSON.stringify(backupData), 'utf-8');

    const restoreOutput = run(`restore --file ${backupPath}`);
    expect(restoreOutput).toContain('imported 2 concepts');
    expect(restoreOutput).toContain('skipped 0');
  });

  it('should fail restore without --file flag', () => {
    expect(() => run('restore')).toThrow();
  });

  it('should fail restore with nonexistent file', () => {
    expect(() => run('restore --file /tmp/does-not-exist.json')).toThrow();
  });
});

describe('agentvault-sync sync', () => {
  it('should fail when AgentVault is not configured', () => {
    expect(() => run('sync')).toThrow();
  });
});
