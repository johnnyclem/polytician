import { describe, it, expect } from 'vitest';
import {
  resolveConflict,
  mergeThoughtformSets,
  computeSkewSafeLowerBound,
  type ConflictResolutionOptions,
} from '../../src/polyvault/conflict.js';
import {
  computeRemoteDelta,
  rebase,
  type RebaseInput,
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

// ==================== computeSkewSafeLowerBound ====================

describe('computeSkewSafeLowerBound', () => {
  it('uses min of lastSyncedAt and observedRemoteMax minus skew window', () => {
    const bound = computeSkewSafeLowerBound(10_000, 8_000, 5_000);
    // min(10000, 8000) = 8000, minus 5000 = 3000
    expect(bound).toBe(3_000);
  });

  it('never goes below zero', () => {
    const bound = computeSkewSafeLowerBound(1000, 2000, 5000);
    expect(bound).toBe(0);
  });

  it('defaults skew window to 300_000ms (5 min)', () => {
    const bound = computeSkewSafeLowerBound(1_000_000, 1_000_000);
    expect(bound).toBe(700_000);
  });

  it('clock-skew window prevents missed updates in simulated skew (AC)', () => {
    // Simulate: local thinks sync was at t=10000, remote clock is 2min ahead
    // Remote actually updated record at t=9500 (which is "before" local sync cursor)
    const lastSyncedAtMs = 10_000;
    const observedRemoteMax = 12_000; // remote clock ahead
    const skewWindowMs = 5_000;
    const bound = computeSkewSafeLowerBound(lastSyncedAtMs, observedRemoteMax, skewWindowMs);
    // min(10000, 12000) = 10000, minus 5000 = 5000
    // Record at t=9500 > bound(5000), so it IS captured
    expect(bound).toBe(5_000);
    expect(9500 > bound).toBe(true); // record not missed
  });

  it('without skew window, update IS missed', () => {
    // Same scenario but no skew window
    const bound = computeSkewSafeLowerBound(10_000, 12_000, 0);
    expect(bound).toBe(10_000);
    // Record at t=9500 < bound(10000), so it IS missed without the skew window
    expect(9500 > bound).toBe(false);
  });
});

// ==================== computeRemoteDelta ====================

describe('computeRemoteDelta', () => {
  it('filters remote forms to those updated after skew-safe lower bound', () => {
    const remoteForms = [
      makeTf({ id: 'tf_old', metadata: { updatedAtMs: 1000 } }),
      makeTf({ id: 'tf_new', metadata: { updatedAtMs: 9000 } }),
      makeTf({ id: 'tf_newer', metadata: { updatedAtMs: 15000 } }),
    ];
    const { delta, lowerBound } = computeRemoteDelta(remoteForms, 10_000, 10_000, 5_000);
    expect(lowerBound).toBe(5_000);
    expect(delta).toHaveLength(2);
    expect(delta.map((tf) => tf.id)).toEqual(['tf_new', 'tf_newer']);
  });

  it('returns empty delta when no remote forms are newer', () => {
    const remoteForms = [
      makeTf({ id: 'tf_old', metadata: { updatedAtMs: 1000 } }),
    ];
    const { delta } = computeRemoteDelta(remoteForms, 10_000, 10_000, 5_000);
    expect(delta).toHaveLength(0);
  });

  it('returns all remote forms when lower bound is 0', () => {
    const remoteForms = [
      makeTf({ id: 'tf_1', metadata: { updatedAtMs: 1 } }),
      makeTf({ id: 'tf_2', metadata: { updatedAtMs: 2 } }),
    ];
    const { delta } = computeRemoteDelta(remoteForms, 100, 100, 200);
    // lower bound = max(0, min(100,100) - 200) = 0
    expect(delta).toHaveLength(2);
  });
});

// ==================== rebase ====================

describe('rebase', () => {
  it('merges remote delta into local set', () => {
    const input: RebaseInput = {
      localForms: [makeTf({ id: 'tf_local', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } })],
      remoteForms: [
        makeTf({ id: 'tf_remote', metadata: { updatedAtMs: 8000, contentHash: 'b'.repeat(64) } }),
        makeTf({ id: 'tf_old_remote', metadata: { updatedAtMs: 100, contentHash: 'c'.repeat(64) } }),
      ],
      localBaseUpdatedAtMs: 1000,
      observedRemoteMaxUpdatedAtMs: 8000,
      options: { policy: 'updatedAt', skewWindowMs: 500 },
    };
    const result = rebase(input);
    // lower bound = min(1000, 8000) - 500 = 500
    // tf_remote (8000 > 500) → included in delta
    // tf_old_remote (100 < 500) → excluded from delta
    expect(result.remoteDeltaCount).toBe(1);
    expect(result.merged).toHaveLength(2); // tf_local + tf_remote
    expect(result.newBaseUpdatedAtMs).toBe(8000);
    expect(result.skewSafeLowerBound).toBe(500);
  });

  it('handles conflicting IDs during rebase', () => {
    const input: RebaseInput = {
      localForms: [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } })],
      remoteForms: [makeTf({ id: 'tf_shared', metadata: { updatedAtMs: 7000, contentHash: 'b'.repeat(64) } })],
      localBaseUpdatedAtMs: 1000,
      observedRemoteMaxUpdatedAtMs: 7000,
      options: { policy: 'updatedAt', skewWindowMs: 500 },
    };
    const result = rebase(input);
    expect(result.merged).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.outcome).toBe('remote'); // 7000 > 5000
    expect(result.merged[0]!.metadata.updatedAtMs).toBe(7000);
  });

  it('preserves local forms not in remote delta', () => {
    const input: RebaseInput = {
      localForms: [
        makeTf({ id: 'tf_untouched', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } }),
        makeTf({ id: 'tf_conflicting', metadata: { updatedAtMs: 3000, contentHash: 'c'.repeat(64) } }),
      ],
      remoteForms: [
        makeTf({ id: 'tf_conflicting', metadata: { updatedAtMs: 6000, contentHash: 'd'.repeat(64) } }),
      ],
      localBaseUpdatedAtMs: 1000,
      observedRemoteMaxUpdatedAtMs: 6000,
      options: { policy: 'updatedAt', skewWindowMs: 500 },
    };
    const result = rebase(input);
    expect(result.merged).toHaveLength(2);
    const ids = result.merged.map((tf) => tf.id);
    expect(ids).toContain('tf_untouched');
    expect(ids).toContain('tf_conflicting');
    // tf_conflicting resolved as remote winner (6000 > 3000)
    const conflicting = result.merged.find((tf) => tf.id === 'tf_conflicting')!;
    expect(conflicting.metadata.updatedAtMs).toBe(6000);
  });

  it('empty remote delta produces unchanged local set', () => {
    const input: RebaseInput = {
      localForms: [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000 } })],
      remoteForms: [],
      localBaseUpdatedAtMs: 10_000,
      observedRemoteMaxUpdatedAtMs: 10_000,
      options: { policy: 'updatedAt' },
    };
    const result = rebase(input);
    expect(result.merged).toHaveLength(1);
    expect(result.remoteDeltaCount).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('rebase with preferLocal preserves local on conflict within skew', () => {
    const input: RebaseInput = {
      localForms: [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5000, contentHash: 'a'.repeat(64) } })],
      remoteForms: [makeTf({ id: 'tf_1', metadata: { updatedAtMs: 5100, contentHash: 'b'.repeat(64) } })],
      localBaseUpdatedAtMs: 1000,
      observedRemoteMaxUpdatedAtMs: 5100,
      options: { policy: 'updatedAt', prefer: 'local', skewWindowMs: 300_000 },
    };
    const result = rebase(input);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.outcome).toBe('local');
    expect(result.merged[0]!.metadata.contentHash).toBe('a'.repeat(64));
  });
});
