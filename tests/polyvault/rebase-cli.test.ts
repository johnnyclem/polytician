import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { runRebase, type RebaseOptions, type RebaseState } from '../../src/commands/polyvault/rebase.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';
import type { ThoughtFormV1 } from '../../src/schemas/thoughtform.js';
import { withContentHash } from '../../src/polyvault/hash.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Fixtures ---

function makeTf(
  overrides: Partial<Omit<ThoughtFormV1, 'metadata'>> & {
    id: string;
    metadata?: Partial<ThoughtFormV1['metadata']>;
  }
): ThoughtFormV1 {
  const { metadata: metaOverrides, ...rest } = overrides;
  return withContentHash({
    schemaVersion: SCHEMA_VERSION_V1,
    entities: [],
    relationships: [],
    contextGraph: {},
    rawText: `text of ${overrides.id}`,
    ...rest,
    metadata: {
      createdAtMs: 1730000000000,
      updatedAtMs: 1730000000000,
      source: 'local',
      contentHash: '',
      redaction: { rawTextOmitted: false },
      ...metaOverrides,
    },
  } as ThoughtFormV1);
}

function commit(commitId: string, createdAtMs: number, thoughtforms: ThoughtFormV1[]) {
  return { commitId, createdAtMs, thoughtforms };
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
    ...overrides,
  };
}

function write(local: unknown, remote: unknown): void {
  writeFileSync(localPath, JSON.stringify(local));
  writeFileSync(remotePath, JSON.stringify(remote));
}

// --- Tests ---

describe('runRebase CLI', () => {
  it('rebases the new commits into the local set', async () => {
    write(
      [makeTf({ id: 'tf_local', metadata: { updatedAtMs: 5000 } })],
      [commit('cmt_1', 100, [makeTf({ id: 'tf_remote', metadata: { updatedAtMs: 8000 } })])]
    );

    const { result, exitCode } = await runRebase(defaultOpts({ lastApplied: null }));

    expect(exitCode).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.mergedCount).toBe(2);
    expect(result.remoteDeltaCount).toBe(1);
    expect(result.lastApplied).toEqual({ commitId: 'cmt_1', createdAtMs: 100 });
  });

  it('persists the last applied commit and resumes after it', async () => {
    write(
      [makeTf({ id: 'tf_1' })],
      [commit('cmt_1', 100, [makeTf({ id: 'tf_2', metadata: { updatedAtMs: 8000 } })])]
    );
    await runRebase(defaultOpts());

    const state = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as RebaseState;
    expect(state.lastApplied).toEqual({ commitId: 'cmt_1', createdAtMs: 100 });
    expect(state.lastRebasedAtMs).toBeGreaterThan(0);

    // A later commit holds an edit made long before the previous rebase
    // (an offline device): it is still applied, because it is a new commit.
    write(JSON.parse(readFileSync(outPath, 'utf-8')), [
      commit('cmt_1', 100, [makeTf({ id: 'tf_2', metadata: { updatedAtMs: 8000 } })]),
      commit('cmt_2', 200, [makeTf({ id: 'tf_3', metadata: { updatedAtMs: 1 } })]),
    ]);
    const { result } = await runRebase(defaultOpts());
    expect(result.appliedCommitCount).toBe(1);
    expect(result.remoteDeltaCount).toBe(1);
    expect(result.mergedCount).toBe(3);
    expect(result.lastApplied).toEqual({ commitId: 'cmt_2', createdAtMs: 200 });
  });

  it('treats a 2.x timestamp state file as a first rebase', async () => {
    mkdirSync(join(testDir, '.polyvault'), { recursive: true });
    writeFileSync(
      stateFilePath,
      JSON.stringify({ localBaseUpdatedAtMs: 9e12, observedRemoteMaxUpdatedAtMs: 9e12, lastRebasedAtMs: 1 })
    );
    write([], [commit('cmt_1', 100, [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5 } })])]);
    const { result } = await runRebase(defaultOpts());
    expect(result.remoteDeltaCount).toBe(1);
  });

  it('handles conflicting IDs during rebase', async () => {
    write(
      [makeTf({ id: 'tf_shared', rawText: 'mine', metadata: { updatedAtMs: 5000 } })],
      [commit('cmt_1', 100, [makeTf({ id: 'tf_shared', rawText: 'theirs', metadata: { updatedAtMs: 7000 } })])]
    );

    const conflictPath = join(testDir, 'conflicts.json');
    const { result } = await runRebase(defaultOpts({ conflictReport: conflictPath }));

    expect(result.mergedCount).toBe(1);
    expect(result.conflictCount).toBe(1);
    expect(existsSync(conflictPath)).toBe(true);
  });

  it('rejects a ThoughtForm whose contentHash does not match its content', async () => {
    const stale = { ...makeTf({ id: 'tf_1' }), rawText: 'edited without rehashing' };
    write([], [commit('cmt_1', 100, [stale])]);
    const { result, exitCode } = await runRebase(defaultOpts());
    expect(exitCode).toBe(2);
    expect(result.status).toBe('error');
  });

  it('returns validation error for invalid input', async () => {
    writeFileSync(localPath, 'not json');
    writeFileSync(remotePath, JSON.stringify([]));

    const { result, exitCode } = await runRebase(defaultOpts());
    expect(exitCode).toBe(2);
    expect(result.status).toBe('error');
  });

  it('requires remote commits, not a bare ThoughtForm array', async () => {
    write([], [makeTf({ id: 'tf_1' })]);
    const { exitCode } = await runRebase(defaultOpts());
    expect(exitCode).toBe(2);
  });
});
