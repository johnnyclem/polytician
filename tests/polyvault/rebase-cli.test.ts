import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { runRebase, type RebaseOptions, type RebaseState } from '../../src/commands/polyvault/rebase.js';
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

const testDir = join(tmpdir(), `polyvault-rebase-test-${Date.now()}`);
const localPath = join(testDir, 'local.json');
const remotePath = join(testDir, 'remote.json');
const outPath = join(testDir, 'rebased.json');
const stateFilePath = join(testDir, '.polyvault', 'rebase-state.json');

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function defaultOpts(overrides: Partial<RebaseOptions> = {}): RebaseOptions {
  return {
    local: localPath,
    remote: remotePath,
    policy: 'updatedAt',
    out: outPath,
    nonInteractive: true,
    stateFile: stateFilePath,
    localBaseUpdatedAtMs: 0,
    observedRemoteMaxUpdatedAtMs: 0,
    ...overrides,
  };
}

// --- Tests ---

describe('runRebase CLI', () => {
  it('rebases remote delta into local set', async () => {
    const local = [makeTf({ id: 'tf_local', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } })];
    const remote = [makeTf({ id: 'tf_remote', metadata: { updatedAtMs: 8000, contentHash: 'b'.repeat(64) } })];
    writeFileSync(localPath, JSON.stringify(local));
    writeFileSync(remotePath, JSON.stringify(remote));

    const { result, exitCode } = await runRebase(defaultOpts({
      localBaseUpdatedAtMs: 1000,
      observedRemoteMaxUpdatedAtMs: 8000,
      skewWindowMs: 500,
    }));

    expect(exitCode).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.mergedCount).toBe(2);
    expect(result.remoteDeltaCount).toBe(1);
    expect(result.newBaseUpdatedAtMs).toBe(8000);
  });

  it('persists rebase state to file', async () => {
    const local = [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000 } })];
    const remote = [makeTf({ id: 'tf_2', metadata: { updatedAtMs: 8000 } })];
    writeFileSync(localPath, JSON.stringify(local));
    writeFileSync(remotePath, JSON.stringify(remote));

    await runRebase(defaultOpts({
      localBaseUpdatedAtMs: 0,
      observedRemoteMaxUpdatedAtMs: 0,
    }));

    expect(existsSync(stateFilePath)).toBe(true);
    const state = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as RebaseState;
    expect(state.localBaseUpdatedAtMs).toBeGreaterThan(0);
    expect(state.observedRemoteMaxUpdatedAtMs).toBeGreaterThanOrEqual(8000);
    expect(state.lastRebasedAtMs).toBeGreaterThan(0);
  });

  it('loads rebase state from file for subsequent runs', async () => {
    // First run
    const local1 = [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000 } })];
    const remote1 = [makeTf({ id: 'tf_2', metadata: { updatedAtMs: 8000 } })];
    writeFileSync(localPath, JSON.stringify(local1));
    writeFileSync(remotePath, JSON.stringify(remote1));

    await runRebase(defaultOpts({
      localBaseUpdatedAtMs: 0,
      observedRemoteMaxUpdatedAtMs: 0,
    }));

    // Second run without explicit timestamps — should read from state file
    const local2 = [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000 } })];
    const remote2 = [
      makeTf({ id: 'tf_2', metadata: { updatedAtMs: 8000 } }),
      makeTf({ id: 'tf_3', metadata: { updatedAtMs: 12000 } }),
    ];
    writeFileSync(localPath, JSON.stringify(local2));
    writeFileSync(remotePath, JSON.stringify(remote2));

    const { result } = await runRebase({
      local: localPath,
      remote: remotePath,
      policy: 'updatedAt',
      out: outPath,
      nonInteractive: true,
      stateFile: stateFilePath,
      // No explicit timestamps — should load from state
    });

    expect(result.status).toBe('ok');
  });

  it('handles conflicting IDs during rebase', async () => {
    const local = [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } })];
    const remote = [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 7000, contentHash: 'b'.repeat(64) } })];
    writeFileSync(localPath, JSON.stringify(local));
    writeFileSync(remotePath, JSON.stringify(remote));

    const conflictPath = join(testDir, 'conflicts.json');
    const { result } = await runRebase(defaultOpts({
      localBaseUpdatedAtMs: 1000,
      observedRemoteMaxUpdatedAtMs: 7000,
      conflictReport: conflictPath,
    }));

    expect(result.mergedCount).toBe(1);
    expect(result.conflictCount).toBe(1);
    expect(existsSync(conflictPath)).toBe(true);
  });

  it('returns validation error for invalid input', async () => {
    writeFileSync(localPath, 'not json');
    writeFileSync(remotePath, JSON.stringify([]));

    const { result, exitCode } = await runRebase(defaultOpts());
    expect(exitCode).toBe(2);
    expect(result.status).toBe('error');
  });
});
