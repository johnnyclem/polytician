import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const ROOT = join(import.meta.dirname, '..');
const CLI = 'npx tsx bin/agentvault-sync.ts';

let tempDir: string;

function run(args: string, env?: Record<string, string>): string {
  return execSync(`${CLI} ${args}`, {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, POLYTICIAN_DATA_DIR: tempDir, ...env },
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Run a command that should fail; returns its stderr. */
function runFailing(args: string, env?: Record<string, string>): string {
  try {
    run(args, env);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? '');
  }
  throw new Error(`expected "${args}" to fail`);
}

/** Seed concepts in three namespaces through the library, in a child process. */
function seed(): void {
  const src = join(ROOT, 'src');
  const script = join(tempDir, 'seed.mts');
  writeFileSync(
    script,
    `
    import { initializeDatabase, closeDatabase } from '${src}/db/client.js';
    import { conceptService } from '${src}/services/concept.service.js';
    initializeDatabase();
    await conceptService.save({ id: '11111111-1111-4111-a111-111111111111', namespace: 'default', markdown: '# Concept A', tags: ['tag1'] });
    await conceptService.save({ id: '22222222-2222-4222-a222-222222222222', namespace: 'work', markdown: '# Concept B', tags: ['tag2'] });
    await conceptService.save({ id: '33333333-3333-4333-a333-333333333333', namespace: 'personal', markdown: '# Concept C' });
    closeDatabase();
  `
  );
  execSync(`npx tsx ${script}`, {
    cwd: ROOT,
    env: { ...process.env, POLYTICIAN_DATA_DIR: tempDir },
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
    const backupPath = join(tempDir, 'nested', 'backup.jsonl');
    const output = run(`backup --out ${backupPath}`);
    expect(output).toContain('wrote 0 concepts');
    const lines = readFileSync(backupPath, 'utf-8').trimEnd().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ format: 'polytician-backup', formatVersion: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'footer', conceptCount: 0 });
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  });

  it('backs up every namespace when --namespace is omitted (POLY-04)', () => {
    seed();
    const backupPath = join(tempDir, 'all.jsonl');
    const output = run(`backup --out ${backupPath}`);
    expect(output).toContain('wrote 3 concepts (default=1, personal=1, work=1)');

    const footer = JSON.parse(readFileSync(backupPath, 'utf-8').trimEnd().split('\n').pop()!);
    expect(footer.namespaces).toEqual({ default: 1, work: 1, personal: 1 });

    const onlyWork = join(tempDir, 'work.jsonl');
    expect(run(`backup --namespace work --out ${onlyWork}`)).toContain('wrote 1 concepts (work=1)');
  });

  it('writes into <dataDir>/backups by default', () => {
    run('backup');
    const files = readdirSync(join(tempDir, 'backups'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^polytician-backup-.*\.jsonl$/);
  });

  it('restores a backup into an empty store', () => {
    seed();
    const backupPath = join(tempDir, 'b.jsonl');
    run(`backup --out ${backupPath}`);
    rmSync(join(tempDir, 'concepts.db'));

    const restoreOutput = run(`restore --file ${backupPath}`);
    expect(restoreOutput).toContain('imported 3 concepts (3 new, 0 replaced), skipped 0');

    const again = run(`restore --file ${backupPath}`);
    expect(again).toContain('imported 0 concepts');
    expect(again).toContain('skipped 3');
  });

  it('--encrypt fails without a key and encrypts with one', () => {
    seed();
    const backupPath = join(tempDir, 'enc.jsonl');
    expect(runFailing(`backup --encrypt --out ${backupPath}`)).toContain(
      'needs a backup encryption key'
    );
    expect(existsSync(backupPath)).toBe(false);

    const key = randomBytes(32).toString('base64');
    const output = run(`backup --encrypt --out ${backupPath}`, { POLYTICIAN_BACKUP_KEY: key });
    expect(output).toMatch(/encrypted with key [0-9a-f]{16}/);
    expect(readFileSync(backupPath, 'utf-8')).not.toContain('Concept A');

    rmSync(join(tempDir, 'concepts.db'));
    expect(runFailing(`restore --file ${backupPath}`)).toContain('no backup key is configured');
    expect(
      runFailing(`restore --file ${backupPath}`, {
        POLYTICIAN_BACKUP_KEY: randomBytes(32).toString('base64'),
      })
    ).toContain('Wrong backup key');
    expect(run(`restore --file ${backupPath}`, { POLYTICIAN_BACKUP_KEY: key })).toContain(
      'imported 3 concepts'
    );
    // Six CLI processes in a row: allow for a loaded machine.
  }, 30_000);

  it('should fail restore without --file flag', () => {
    expect(runFailing('restore')).toContain('--file <path> is required');
  });

  it('should fail restore with nonexistent file', () => {
    expect(() => run('restore --file /tmp/does-not-exist.jsonl')).toThrow();
  });
});

describe('agentvault-sync sync', () => {
  it('should fail when AgentVault is not configured', () => {
    expect(runFailing('sync')).toContain('AgentVault integration is not configured');
  });
});
