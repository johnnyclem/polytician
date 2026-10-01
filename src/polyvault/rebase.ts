import type { ThoughtFormV1 } from '../schemas/thoughtform.js';
import {
  mergeThoughtformSets,
  resolveConflict,
  type ConflictResolutionOptions,
  type MergeResult,
} from './conflict.js';

// --- PolyVault rebase engine ---
// Applies remote changes onto local working set while preserving local-first semantics.
// See PRD §3.3 for the full rebase specification.
//
// Which remote changes are new is decided by commit order: the canister
// assigns each commit its createdAtMs when it is finalized, and the rebase
// state remembers the last commit applied. A producer's updatedAtMs says
// when content was edited, not when it reached the canister (an offline
// device commits day-old edits), so it is used only to resolve conflicts.

/** A commit as listed by the canister, with the ThoughtForms of its bundle. */
export interface RemoteCommit {
  commitId: string;
  /** Server-assigned finalize time (canister clock). */
  createdAtMs: number;
  thoughtforms: ThoughtFormV1[];
}

/** Position in the remote commit sequence: the last commit already applied. */
export interface CommitCursor {
  commitId: string;
  createdAtMs: number;
}

export interface RebaseInput {
  localForms: ThoughtFormV1[];
  /** Remote commits; any order, already-applied ones may be included. */
  remoteCommits: RemoteCommit[];
  /** Last remote commit applied by the previous rebase; null for the first one. */
  lastApplied: CommitCursor | null;
  options: ConflictResolutionOptions;
}

export interface RebaseResult extends MergeResult {
  /** ThoughtForms taken from the new commits (after collapsing repeated ids). */
  remoteDeltaCount: number;
  appliedCommitCount: number;
  /** Cursor to store for the next rebase (unchanged when there was nothing new). */
  lastApplied: CommitCursor | null;
}

/** Total order of commits: createdAtMs, then commitId. */
function compareCommits(a: CommitCursor, b: CommitCursor): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.commitId < b.commitId ? -1 : a.commitId > b.commitId ? 1 : 0;
}

/** Commits strictly after `cursor` in commit order, oldest first. */
export function commitsAfter(commits: RemoteCommit[], cursor: CommitCursor | null): RemoteCommit[] {
  return [...commits]
    .sort(compareCommits)
    .filter(c => cursor === null || compareCommits(c, cursor) > 0);
}

/**
 * The remote delta: every ThoughtForm in the commits after `cursor`,
 * whatever its updatedAtMs. When several new commits carry the same id, the
 * conflict policy's updatedAt rules pick one.
 */
export function computeRemoteDelta(
  commits: RemoteCommit[],
  cursor: CommitCursor | null,
  options: ConflictResolutionOptions = { policy: 'updatedAt' }
): { delta: ThoughtFormV1[]; applied: RemoteCommit[] } {
  const applied = commitsAfter(commits, cursor);
  const byId = new Map<string, ThoughtFormV1>();
  for (const commit of applied) {
    for (const tf of commit.thoughtforms) {
      const seen = byId.get(tf.id);
      byId.set(
        tf.id,
        seen
          ? resolveConflict(seen, tf, { ...options, policy: 'updatedAt', prefer: undefined }).winner
          : tf
      );
    }
  }
  return { delta: [...byId.values()], applied };
}

/**
 * Perform a rebase operation:
 *  1. Take the ThoughtForms of every remote commit after the last applied one.
 *  2. Merge them into the local working set with the conflict policy.
 *  3. Return the merged set and the new cursor.
 */
export function rebase(input: RebaseInput): RebaseResult {
  const { localForms, remoteCommits, lastApplied, options } = input;
  const { delta, applied } = computeRemoteDelta(remoteCommits, lastApplied, options);
  const mergeResult = mergeThoughtformSets(localForms, delta, options);
  const newest = applied[applied.length - 1];

  return {
    ...mergeResult,
    remoteDeltaCount: delta.length,
    appliedCommitCount: applied.length,
    lastApplied: newest
      ? { commitId: newest.commitId, createdAtMs: newest.createdAtMs }
      : lastApplied,
  };
}
