import type { ThoughtFormV1 } from '../schemas/thoughtform.js';

// --- PolyVault conflict resolution engine ---
// Deterministic merge/rebase conflict resolution for ThoughtForm sync.
// See PRD §3.5 for the full policy specification.

export type ConflictPolicy = 'updatedAt' | 'preferLocal' | 'preferRemote';

export type PreferOrigin = 'onchain' | 'local';

export interface ConflictResolutionOptions {
  policy: ConflictPolicy;
  prefer?: PreferOrigin;
  skewWindowMs?: number; // default 300_000 (5 minutes)
}

export type ConflictOutcome = 'local' | 'remote' | 'no-conflict';

export interface ConflictRecord {
  id: string;
  outcome: ConflictOutcome;
  winner: ThoughtFormV1;
  loser?: ThoughtFormV1;
  reason: string;
}

export interface MergeResult {
  merged: ThoughtFormV1[];
  conflicts: ConflictRecord[];
}

const DEFAULT_SKEW_WINDOW_MS = 300_000; // 5 minutes

/**
 * Compare two ThoughtForms that share the same `id` and determine which wins.
 *
 * Resolution order (§3.5):
 *  1. Higher `metadata.updatedAtMs` wins.
 *  2. Tie → lexical compare `metadata.contentHash` (higher hex wins).
 *  3. Tie → lexical compare `metadata.source` then `id` for total ordering.
 *
 * When `prefer` is set and the updatedAt delta is within the skew window,
 * the preferred origin overrides step 1.
 */
export function resolveConflict(
  local: ThoughtFormV1,
  remote: ThoughtFormV1,
  options: ConflictResolutionOptions,
): ConflictRecord {
  const { policy, prefer, skewWindowMs = DEFAULT_SKEW_WINDOW_MS } = options;

  // Fast path: identical content → no real conflict
  if (local.metadata.contentHash === remote.metadata.contentHash) {
    // Pick the one with higher updatedAtMs for consistency
    const winner =
      local.metadata.updatedAtMs >= remote.metadata.updatedAtMs ? local : remote;
    return {
      id: local.id,
      outcome: 'no-conflict',
      winner,
      reason: 'identical-content-hash',
    };
  }

  // preferLocal / preferRemote policies short-circuit
  if (policy === 'preferLocal') {
    return {
      id: local.id,
      outcome: 'local',
      winner: local,
      loser: remote,
      reason: 'policy-preferLocal',
    };
  }
  if (policy === 'preferRemote') {
    return {
      id: local.id,
      outcome: 'remote',
      winner: remote,
      loser: local,
      reason: 'policy-preferRemote',
    };
  }

  // policy === 'updatedAt'
  const localTs = local.metadata.updatedAtMs;
  const remoteTs = remote.metadata.updatedAtMs;
  const delta = Math.abs(localTs - remoteTs);

  // If within skew window and prefer is set, preferred origin wins
  if (prefer && delta <= skewWindowMs) {
    if (prefer === 'local') {
      return {
        id: local.id,
        outcome: 'local',
        winner: local,
        loser: remote,
        reason: `prefer-local-within-skew (delta=${delta}ms)`,
      };
    }
    // prefer === 'onchain' (remote is on-chain)
    return {
      id: local.id,
      outcome: 'remote',
      winner: remote,
      loser: local,
      reason: `prefer-onchain-within-skew (delta=${delta}ms)`,
    };
  }

  // Step 1: higher updatedAtMs wins
  if (localTs !== remoteTs) {
    const localWins = localTs > remoteTs;
    return {
      id: local.id,
      outcome: localWins ? 'local' : 'remote',
      winner: localWins ? local : remote,
      loser: localWins ? remote : local,
      reason: `updatedAt (local=${localTs}, remote=${remoteTs})`,
    };
  }

  // Step 2: tie → lexical compare contentHash (higher hex wins)
  const hashCmp = local.metadata.contentHash.localeCompare(
    remote.metadata.contentHash,
  );
  if (hashCmp !== 0) {
    const localWins = hashCmp > 0;
    return {
      id: local.id,
      outcome: localWins ? 'local' : 'remote',
      winner: localWins ? local : remote,
      loser: localWins ? remote : local,
      reason: `contentHash-tiebreak`,
    };
  }

  // Step 3: tie → lexical compare source, then id
  const sourceCmp = (local.metadata.source ?? '').localeCompare(
    remote.metadata.source ?? '',
  );
  if (sourceCmp !== 0) {
    const localWins = sourceCmp > 0;
    return {
      id: local.id,
      outcome: localWins ? 'local' : 'remote',
      winner: localWins ? local : remote,
      loser: localWins ? remote : local,
      reason: `source-tiebreak`,
    };
  }

  // Final: compare id (should be identical since we matched on id, but for completeness)
  const idCmp = local.id.localeCompare(remote.id);
  const localWins = idCmp >= 0;
  return {
    id: local.id,
    outcome: localWins ? 'local' : 'remote',
    winner: localWins ? local : remote,
    loser: localWins ? remote : local,
    reason: `id-tiebreak`,
  };
}

/**
 * Merge two sets of ThoughtForms by id, applying the conflict resolution policy.
 *
 * - ThoughtForms only in local → kept as-is.
 * - ThoughtForms only in remote → added.
 * - ThoughtForms in both → resolved via `resolveConflict`.
 */
export function mergeThoughtformSets(
  localForms: ThoughtFormV1[],
  remoteForms: ThoughtFormV1[],
  options: ConflictResolutionOptions,
): MergeResult {
  const localMap = new Map<string, ThoughtFormV1>();
  for (const tf of localForms) {
    localMap.set(tf.id, tf);
  }

  const remoteMap = new Map<string, ThoughtFormV1>();
  for (const tf of remoteForms) {
    remoteMap.set(tf.id, tf);
  }

  const merged: ThoughtFormV1[] = [];
  const conflicts: ConflictRecord[] = [];

  // Process all local forms
  for (const [id, localTf] of Array.from(localMap.entries())) {
    const remoteTf = remoteMap.get(id);
    if (!remoteTf) {
      merged.push(localTf);
      continue;
    }
    const record = resolveConflict(localTf, remoteTf, options);
    merged.push(record.winner);
    conflicts.push(record);
  }

  // Add remote-only forms
  for (const [id, remoteTf] of Array.from(remoteMap.entries())) {
    if (!localMap.has(id)) {
      merged.push(remoteTf);
    }
  }

  // Deterministic output order: updatedAtMs asc, id asc, contentHash asc
  merged.sort((a, b) => {
    const tsCmp = a.metadata.updatedAtMs - b.metadata.updatedAtMs;
    if (tsCmp !== 0) return tsCmp;
    const idCmp = a.id.localeCompare(b.id);
    if (idCmp !== 0) return idCmp;
    return a.metadata.contentHash.localeCompare(b.metadata.contentHash);
  });

  return { merged, conflicts };
}

/**
 * Compute the effective delta lower bound accounting for clock skew.
 *
 * Uses: min(lastSyncedAtMs, observedRemoteMaxUpdatedAtMs) - skewWindowMs
 * to ensure no updates are missed due to clock drift.
 */
export function computeSkewSafeLowerBound(
  lastSyncedAtMs: number,
  observedRemoteMaxUpdatedAtMs: number,
  skewWindowMs: number = DEFAULT_SKEW_WINDOW_MS,
): number {
  const effectiveBase = Math.min(lastSyncedAtMs, observedRemoteMaxUpdatedAtMs);
  return Math.max(0, effectiveBase - skewWindowMs);
}
