import { describe, it, expect } from 'vitest';
import {
  resolveConflict,
  mergeThoughtformSets,
  type ConflictResolutionOptions,
} from '../../src/polyvault/conflict.js';
import {
  computeRemoteDelta,
  rebase,
  type RebaseInput,
  type RemoteCommit,
} from '../../src/polyvault/rebase.js';
import type { ThoughtFormV1 } from '../../src/schemas/thoughtform.js';
import { SCHEMA_VERSION_V1 } from '../../src/schemas/thoughtform.js';

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

const defaultOptions: ConflictResolutionOptions = {
  policy: 'updatedAt',
};

// ==================== resolveConflict ====================

describe('resolveConflict', () => {
  it('equal contentHash over different content is a real conflict (stale producer hash)', () => {
    const local = makeTf({ id: 'tf_1', rawText: 'mine', metadata: { updatedAtMs: 2000 } });
    const remote = makeTf({ id: 'tf_1', rawText: 'theirs', metadata: { updatedAtMs: 1000 } });
    const result = resolveConflict(local, remote, defaultOptions);
    expect(result.outcome).toBe('local');
    expect(result.loser).toBe(remote);
  });

  it('identical contentHash → no-conflict outcome', () => {
    const local = makeTf({ id: 'tf_1', metadata: { contentHash: 'abc'.padEnd(64, '0') } });
    const remote = makeTf({ id: 'tf_1', metadata: { contentHash: 'abc'.padEnd(64, '0') } });
    const result = resolveConflict(local, remote, defaultOptions);
    expect(result.outcome).toBe('no-conflict');
    expect(result.reason).toBe('identical-content-hash');
    expect(result.loser).toBeUndefined();
  });

  // --- updatedAt policy ---

  it('higher updatedAtMs wins (AC: deterministic updatedAt)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 2000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'b'.repeat(64) } });
    const result = resolveConflict(local, remote, defaultOptions);
    expect(result.outcome).toBe('local');
    expect(result.winner).toBe(local);
    expect(result.loser).toBe(remote);
    expect(result.reason).toContain('updatedAt');
  });

  it('remote wins when it has higher updatedAtMs', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 2000, contentHash: 'b'.repeat(64) } });
    const result = resolveConflict(local, remote, defaultOptions);
    expect(result.outcome).toBe('remote');
    expect(result.winner).toBe(remote);
  });

  it('tie-break: higher contentHash hex wins (AC: deterministic tie-break)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'f'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const result = resolveConflict(local, remote, defaultOptions);
    expect(result.outcome).toBe('local');
    expect(result.reason).toBe('contentHash-tiebreak');
  });

  it('tie-break: remote contentHash wins when higher', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'f'.repeat(64) } });
    const result = resolveConflict(local, remote, defaultOptions);
    expect(result.outcome).toBe('remote');
    expect(result.reason).toBe('contentHash-tiebreak');
  });

  it('identical contentHash with different sources is no-conflict (same content)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64), source: 'zlocal' } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64), source: 'aremote' } });
    const result = resolveConflict(local, remote, defaultOptions);
    expect(result.outcome).toBe('no-conflict');
    expect(result.reason).toBe('identical-content-hash');
  });

  it('deterministic: same inputs always produce same outcome across runs (AC)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000, contentHash: 'c'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 3000, contentHash: 'd'.repeat(64) } });
    const results = Array.from({ length: 100 }, () =>
      resolveConflict(local, remote, defaultOptions),
    );
    const first = results[0]!;
    for (const r of results) {
      expect(r.outcome).toBe(first.outcome);
      expect(r.winner).toBe(first.winner);
      expect(r.reason).toBe(first.reason);
    }
  });

  // --- preferLocal / preferRemote policies ---

  it('preferLocal policy always picks local (AC: prefer flags alter documented branches)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 9999, contentHash: 'z'.repeat(64) } });
    const result = resolveConflict(local, remote, { policy: 'preferLocal' });
    expect(result.outcome).toBe('local');
    expect(result.reason).toBe('policy-preferLocal');
  });

  it('preferRemote policy always picks remote (AC: prefer flags alter documented branches)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 9999, contentHash: 'z'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const result = resolveConflict(local, remote, { policy: 'preferRemote' });
    expect(result.outcome).toBe('remote');
    expect(result.reason).toBe('policy-preferRemote');
  });

  // --- prefer origin with skew window ---

  it('prefer onchain within skew window overrides updatedAt (AC: prefer onchain)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1100, contentHash: 'b'.repeat(64) } });
    const result = resolveConflict(local, remote, {
      policy: 'updatedAt',
      prefer: 'onchain',
      skewWindowMs: 300_000,
    });
    expect(result.outcome).toBe('remote');
    expect(result.reason).toContain('prefer-onchain-within-skew');
  });

  it('prefer local within skew window overrides updatedAt (AC: prefer local)', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1100, contentHash: 'b'.repeat(64) } });
    const result = resolveConflict(local, remote, {
      policy: 'updatedAt',
      prefer: 'local',
      skewWindowMs: 300_000,
    });
    expect(result.outcome).toBe('local');
    expect(result.reason).toContain('prefer-local-within-skew');
  });

  it('prefer does NOT apply when delta exceeds skew window', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1_000_000, contentHash: 'b'.repeat(64) } });
    const result = resolveConflict(local, remote, {
      policy: 'updatedAt',
      prefer: 'local',
      skewWindowMs: 300_000,
    });
    // remote has higher ts and delta > skew window, so updatedAt rule applies
    expect(result.outcome).toBe('remote');
    expect(result.reason).toContain('updatedAt');
  });

  it('prefer with zero skew window only applies on exact timestamp match', () => {
    const local = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } });
    const remote = makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'b'.repeat(64) } });
    const result = resolveConflict(local, remote, {
      policy: 'updatedAt',
      prefer: 'onchain',
      skewWindowMs: 0,
    });
    expect(result.outcome).toBe('remote');
    expect(result.reason).toContain('prefer-onchain-within-skew');
  });
});

// ==================== mergeThoughtformSets ====================

describe('mergeThoughtformSets', () => {
  it('local-only forms are kept', () => {
    const local = [makeTf({ id: 'tf_1' }), makeTf({ id: 'tf_2' })];
    const remote: ThoughtFormV1[] = [];
    const result = mergeThoughtformSets(local, remote, defaultOptions);
    expect(result.merged).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
  });

  it('remote-only forms are added', () => {
    const local: ThoughtFormV1[] = [];
    const remote = [makeTf({ id: 'tf_r1' })];
    const result = mergeThoughtformSets(local, remote, defaultOptions);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]!.id).toBe('tf_r1');
    expect(result.conflicts).toHaveLength(0);
  });

  it('conflicting ids are resolved and reported', () => {
    const local = [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 2000, contentHash: 'a'.repeat(64) } })];
    const remote = [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1000, contentHash: 'b'.repeat(64) } })];
    const result = mergeThoughtformSets(local, remote, defaultOptions);
    expect(result.merged).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.outcome).toBe('local');
  });

  it('output is sorted deterministically: updatedAtMs asc, id asc, contentHash asc', () => {
    const local = [
      makeTf({ id: 'tf_b', metadata: { updatedAtMs: 3000, contentHash: 'a'.repeat(64) } }),
      makeTf({ id: 'tf_a', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } }),
    ];
    const remote = [
      makeTf({ id: 'tf_c', metadata: { updatedAtMs: 2000, contentHash: 'b'.repeat(64) } }),
    ];
    const result = mergeThoughtformSets(local, remote, defaultOptions);
    const ids = result.merged.map((tf) => tf.id);
    expect(ids).toEqual(['tf_a', 'tf_c', 'tf_b']);
  });

  it('mixed scenario: local-only, remote-only, and conflicting', () => {
    const local = [
      makeTf({ id: 'tf_local_only' }),
      makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } }),
    ];
    const remote = [
      makeTf({ id: 'tf_remote_only' }),
      makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 3000, contentHash: 'b'.repeat(64) } }),
    ];
    const result = mergeThoughtformSets(local, remote, defaultOptions);
    expect(result.merged).toHaveLength(3);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.id).toBe('tf_shared');
    expect(result.conflicts[0]!.outcome).toBe('local');
    const mergedIds = result.merged.map((tf) => tf.id);
    expect(mergedIds).toContain('tf_local_only');
    expect(mergedIds).toContain('tf_remote_only');
    expect(mergedIds).toContain('tf_shared');
  });

  it('empty sets produce empty result', () => {
    const result = mergeThoughtformSets([], [], defaultOptions);
    expect(result.merged).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('duplicate IDs in same set: last one wins (map behavior)', () => {
    const local = [
      makeTf({ id: 'tf_dup', metadata: { updatedAtMs: 1000, contentHash: 'a'.repeat(64) } }),
      makeTf({ id: 'tf_dup', metadata: { updatedAtMs: 2000, contentHash: 'b'.repeat(64) } }),
    ];
    const remote: ThoughtFormV1[] = [];
    const result = mergeThoughtformSets(local, remote, defaultOptions);
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]!.metadata.updatedAtMs).toBe(2000);
  });
});

// ==================== computeRemoteDelta ====================

const DAY = 86_400_000;
const T0 = 1_730_000_000_000;

function commit(commitId: string, createdAtMs: number, thoughtforms: ThoughtFormV1[]): RemoteCommit {
  return { commitId, createdAtMs, thoughtforms };
}

describe('computeRemoteDelta', () => {
  it('takes every form from commits after the cursor, whatever their updatedAtMs', () => {
    const commits = [
      commit('cmt_2', T0 + 2, [makeTf({ id: 'tf_old_edit', metadata: { updatedAtMs: 1 } })]),
      commit('cmt_1', T0 + 1, [makeTf({ id: 'tf_seen', metadata: { updatedAtMs: T0 } })]),
    ];
    const { delta, applied } = computeRemoteDelta(commits, { commitId: 'cmt_1', createdAtMs: T0 + 1 });
    expect(applied.map(c => c.commitId)).toEqual(['cmt_2']);
    expect(delta.map(tf => tf.id)).toEqual(['tf_old_edit']);
  });

  it('applies every commit on the first rebase', () => {
    const commits = [
      commit('cmt_1', T0 + 1, [makeTf({ id: 'tf_1' })]),
      commit('cmt_2', T0 + 2, [makeTf({ id: 'tf_2' })]),
    ];
    expect(computeRemoteDelta(commits, null).delta).toHaveLength(2);
  });

  it('orders commits with the same createdAtMs by commitId', () => {
    const commits = [
      commit('cmt_b', T0, [makeTf({ id: 'tf_b' })]),
      commit('cmt_a', T0, [makeTf({ id: 'tf_a' })]),
    ];
    const { applied } = computeRemoteDelta(commits, { commitId: 'cmt_a', createdAtMs: T0 });
    expect(applied.map(c => c.commitId)).toEqual(['cmt_b']);
  });

  it('resolves an id carried by several new commits with the updatedAt rules', () => {
    const commits = [
      commit('cmt_1', T0 + 1, [makeTf({ id: 'tf_x', metadata: { updatedAtMs: 5000, contentHash: 'b'.repeat(64) } })]),
      commit('cmt_2', T0 + 2, [makeTf({ id: 'tf_x', metadata: { updatedAtMs: 3000, contentHash: 'c'.repeat(64) } })]),
    ];
    const { delta } = computeRemoteDelta(commits, null);
    expect(delta).toHaveLength(1);
    expect(delta[0]!.metadata.updatedAtMs).toBe(5000);
  });
});

// ==================== rebase ====================

describe('rebase', () => {
  it('applies offline edits that reach the canister late (POLY-12)', () => {
    // Device A rebased after commit cmt_1 (a note edited a day after T0).
    // Device B was offline: it edited `shared` and wrote `b_note` around T0,
    // and its commit reached the canister only afterwards.
    const shared = makeTf({ id: 'shared', rawText: 'v1', metadata: { updatedAtMs: T0, contentHash: 'a'.repeat(64) } });
    const recent = makeTf({ id: 'recent', metadata: { updatedAtMs: T0 + DAY, contentHash: 'c'.repeat(64) } });
    const commits = [
      commit('cmt_1', T0 + DAY, [recent]),
      commit('cmt_2', T0 + DAY + 60_000, [
        makeTf({ id: 'shared', rawText: 'B edit', metadata: { updatedAtMs: T0 + 1000, contentHash: 'b'.repeat(64) } }),
        makeTf({ id: 'b_note', metadata: { updatedAtMs: T0 + 2000, contentHash: 'd'.repeat(64) } }),
      ]),
    ];
    const result = rebase({
      localForms: [shared, recent],
      remoteCommits: commits,
      lastApplied: { commitId: 'cmt_1', createdAtMs: T0 + DAY },
      options: { policy: 'updatedAt' },
    });
    expect(result.remoteDeltaCount).toBe(2);
    expect(result.merged.map(tf => tf.id).sort()).toEqual(['b_note', 'recent', 'shared']);
    expect(result.merged.find(tf => tf.id === 'shared')!.rawText).toBe('B edit');
    expect(result.lastApplied).toEqual({ commitId: 'cmt_2', createdAtMs: T0 + DAY + 60_000 });
  });

  it('handles conflicting IDs during rebase', () => {
    const input: RebaseInput = {
      localForms: [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } })],
      remoteCommits: [
        commit('cmt_1', T0, [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 7000, contentHash: 'b'.repeat(64) } })]),
      ],
      lastApplied: null,
      options: { policy: 'updatedAt' },
    };
    const result = rebase(input);
    expect(result.merged).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.outcome).toBe('remote'); // 7000 > 5000
    expect(result.merged[0]!.metadata.updatedAtMs).toBe(7000);
  });

  it('preserves local forms not in the new commits', () => {
    const input: RebaseInput = {
      localForms: [
        makeTf({ id: 'tf_untouched', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } }),
        makeTf({ id: 'tf_conflicting', metadata: { updatedAtMs: 3000, contentHash: 'c'.repeat(64) } }),
      ],
      remoteCommits: [
        commit('cmt_1', T0, [makeTf({ id: 'tf_conflicting', metadata: { updatedAtMs: 6000, contentHash: 'd'.repeat(64) } })]),
      ],
      lastApplied: null,
      options: { policy: 'updatedAt' },
    };
    const result = rebase(input);
    expect(result.merged.map(tf => tf.id).sort()).toEqual(['tf_conflicting', 'tf_untouched']);
    expect(result.merged.find(tf => tf.id === 'tf_conflicting')!.metadata.updatedAtMs).toBe(6000);
  });

  it('with no new commits, leaves the local set and the cursor unchanged', () => {
    const cursor = { commitId: 'cmt_1', createdAtMs: T0 };
    const result = rebase({
      localForms: [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000 } })],
      remoteCommits: [commit('cmt_1', T0, [makeTf({ id: 'tf_remote' })])],
      lastApplied: cursor,
      options: { policy: 'updatedAt' },
    });
    expect(result.merged).toHaveLength(1);
    expect(result.remoteDeltaCount).toBe(0);
    expect(result.appliedCommitCount).toBe(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.lastApplied).toEqual(cursor);
  });

  it('rebase with prefer local preserves local on conflict within skew', () => {
    const input: RebaseInput = {
      localForms: [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } })],
      remoteCommits: [
        commit('cmt_1', T0, [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5100, contentHash: 'b'.repeat(64) } })]),
      ],
      lastApplied: null,
      options: { policy: 'updatedAt', prefer: 'local', skewWindowMs: 300_000 },
    };
    const result = rebase(input);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.outcome).toBe('local');
    expect(result.merged[0]!.metadata.contentHash).toBe('a'.repeat(64));
  });
});
