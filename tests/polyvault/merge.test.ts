import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { runMerge, type MergeOptions } from '../../src/commands/polyvault/merge.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';
import type { ThoughtFormV1 } from '../../src/schemas/thoughtform.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Fixtures ---

function makeTf(overrides: Partial<ThoughtFormV1> & { id: string }): ThoughtFormV1 {
  const defaults = {
    createdAtMs: 1730000000000,
    updatedAtMs: 1730000000000,
    source: 'local' as const,
    contentHash: 'a'.repeat(64),
    redaction: { rawTextOmitted: false },
  };
  const { metadata: metaOverrides, ...rest } = overrides;
  return {
    schemaVersion: SCHEMA_VERSION_V1,
    id: overrides.id,
    entities: [],
    relationships: [],
    contextGraph: {},
    metadata: { ...defaults, ...metaOverrides },
    ...rest,
  };
}

const testDir = join(tmpdir(), `polyvault-merge-test-${Date.now()}`);
const localPath = join(testDir, 'local.json');
const remotePath = join(testDir, 'remote.json');
const outPath = join(testDir, 'merged.json');
const conflictPath = join(testDir, 'conflicts.json');

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  for (const f of [localPath, remotePath, outPath, conflictPath]) {
    if (existsSync(f)) unlinkSync(f);
  }
});

function defaultOpts(overrides: Partial<MergeOptions> = {}): MergeOptions {
  return {
    local: localPath,
    remote: remotePath,
    policy: 'updatedAt',
    out: outPath,
    nonInteractive: true,
    ...overrides,
  };
}

// --- Tests ---

describe('runMerge', () => {
  it('merges disjoint sets with no conflicts', async () => {
    const local = [makeTf({ id: 'tf_local_1' })];
    const remote = [makeTf({ id: 'tf_remote_1' })];
    writeFileSync(localPath, JSON.stringify(local));
    writeFileSync(remotePath, JSON.stringify(remote));

    const { result, exitCode } = await runMerge(defaultOpts());
    expect(exitCode).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.mergedCount).toBe(2);
    expect(result.conflictCount).toBe(0);
    expect(result.localOnlyCount).toBe(1);
    expect(result.remoteOnlyCount).toBe(1);
  });

  it('resolves conflicts with updatedAt policy', async () => {
    const local = [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 2000, contentHash: 'a'.repeat(64) } })];
    const remote = [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 1000, contentHash: 'b'.repeat(64) } })];
    writeFileSync(localPath, JSON.stringify(local));
    writeFileSync(remotePath, JSON.stringify(remote));

    const { result, exitCode } = await runMerge(defaultOpts({ conflictReport: conflictPath }));
    expect(exitCode).toBe(0);
    expect(result.mergedCount).toBe(1);
    expect(result.conflictCount).toBe(1);

    // Conflict report written
    expect(existsSync(conflictPath)).toBe(true);
  });

  it('applies preferLocal policy', async () => {
    const local = [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } })];
    const remote = [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 9000, contentHash: 'z'.repeat(64) } })];
    writeFileSync(localPath, JSON.stringify(local));
    writeFileSync(remotePath, JSON.stringify(remote));

    const { result, exitCode } = await runMerge(defaultOpts({ policy: 'preferLocal' }));
    expect(exitCode).toBe(0);
    expect(result.mergedCount).toBe(1);

    // Read output and verify local won
    const merged = JSON.parse(require('fs').readFileSync(outPath, 'utf-8')) as ThoughtFormV1[];
    expect(merged[0]!.metadata.contentHash).toBe('a'.repeat(64));
  });

  it('handles empty inputs', async () => {
    writeFileSync(localPath, JSON.stringify([]));
    writeFileSync(remotePath, JSON.stringify([]));

    const { result, exitCode } = await runMerge(defaultOpts());
    expect(exitCode).toBe(0);
    expect(result.mergedCount).toBe(0);
    expect(result.conflictCount).toBe(0);
  });

  it('returns validation error for missing file', async () => {
    writeFileSync(remotePath, JSON.stringify([]));
    const { result, exitCode } = await runMerge(defaultOpts({ local: '/nonexistent/file.json' }));
    expect(exitCode).toBe(2);
    expect(result.status).toBe('error');
  });

  it('returns validation error for invalid ThoughtForm', async () => {
    writeFileSync(localPath, JSON.stringify([{ bad: 'data' }]));
    writeFileSync(remotePath, JSON.stringify([]));
    const { result, exitCode } = await runMerge(defaultOpts());
    expect(exitCode).toBe(2);
    expect(result.status).toBe('error');
  });
});
