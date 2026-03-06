import type { ThoughtFormV1 } from '../schemas/thoughtform.js';
import {
  mergeThoughtformSets,
  computeSkewSafeLowerBound,
  type ConflictResolutionOptions,
  type MergeResult,
} from './conflict.js';

// --- PolyVault rebase engine ---
// Applies remote changes onto local working set while preserving local-first semantics.
// See PRD §3.3 for the full rebase specification.

export interface RebaseInput {
  localForms: ThoughtFormV1[];
  remoteForms: ThoughtFormV1[];
  localBaseUpdatedAtMs: number;
  observedRemoteMaxUpdatedAtMs: number;
  options: ConflictResolutionOptions;
}

export interface RebaseResult extends MergeResult {
  newBaseUpdatedAtMs: number;
  remoteDeltaCount: number;
  skewSafeLowerBound: number;
}

/**
 * Compute the remote delta: ThoughtForms from remote that were updated
 * after the skew-safe lower bound derived from the local base.
 */
export function computeRemoteDelta(
  remoteForms: ThoughtFormV1[],
  localBaseUpdatedAtMs: number,
  observedRemoteMaxUpdatedAtMs: number,
  skewWindowMs?: number,
): { delta: ThoughtFormV1[]; lowerBound: number } {
  const lowerBound = computeSkewSafeLowerBound(
    localBaseUpdatedAtMs,
    observedRemoteMaxUpdatedAtMs,
    skewWindowMs,
  );
  const delta = remoteForms.filter(
    (tf) => tf.metadata.updatedAtMs > lowerBound,
  );
  return { delta, lowerBound };
}

/**
 * Perform a rebase operation:
 *  1. Compute remote delta since local base (with skew safety).
 *  2. Merge remote delta into local working set.
 *  3. Return merged result with updated base marker.
 */
export function rebase(input: RebaseInput): RebaseResult {
  const {
    localForms,
    remoteForms,
    localBaseUpdatedAtMs,
    observedRemoteMaxUpdatedAtMs,
    options,
  } = input;

  const { delta: remoteDelta, lowerBound } = computeRemoteDelta(
    remoteForms,
    localBaseUpdatedAtMs,
    observedRemoteMaxUpdatedAtMs,
    options.skewWindowMs,
  );

  const mergeResult = mergeThoughtformSets(localForms, remoteDelta, options);

  // New base is the max updatedAtMs across all merged forms
  const newBaseUpdatedAtMs = mergeResult.merged.reduce(
    (max, tf) => Math.max(max, tf.metadata.updatedAtMs),
    0,
  );

  return {
    ...mergeResult,
    newBaseUpdatedAtMs,
    remoteDeltaCount: remoteDelta.length,
    skewSafeLowerBound: lowerBound,
  };
}
