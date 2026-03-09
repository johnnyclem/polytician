import { readFileSync, writeFileSync } from 'node:fs';
import { parseThoughtForm } from '../../lib/polyvault/validate.js';
import {
  mergeThoughtformSets,
  type ConflictPolicy,
  type PreferOrigin,
  type ConflictResolutionOptions,
  type MergeResult,
} from '../../polyvault/conflict.js';
import { vaultLogger, classifyFailure } from '../../polyvault/logger.js';
import type { ThoughtFormV1 } from '../../schemas/thoughtform.js';

// --- Exit codes per PRD ---

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 2;
export const EXIT_CONFLICTS_UNRESOLVED = 2;

// --- Merge options ---

export interface MergeOptions {
  /** Path to local ThoughtForms JSON file. */
  local: string;
  /** Path to remote/on-chain ThoughtForms JSON file. */
  remote: string;
  /** Conflict resolution policy. */
  policy: ConflictPolicy;
  /** Preferred origin when timestamps are within skew window. */
  prefer?: PreferOrigin;
  /** Skew window in ms (default 300_000 = 5 min). */
  skewWindowMs?: number;
  /** Output path for merged ThoughtForms JSON. */
  out?: string;
  /** Output path for conflict report JSON. */
  conflictReport?: string;
  /** Non-interactive mode (always apply policy, never prompt). */
  nonInteractive: boolean;
}

// --- Merge result ---

export interface MergeCommandResult {
  status: 'ok' | 'error';
  mergedCount: number;
  conflictCount: number;
  localOnlyCount: number;
  remoteOnlyCount: number;
}

// --- Core merge pipeline ---

/**
 * Run the PolyVault merge pipeline (non-interactive).
 *
 * Steps per PRD 3.4:
 * 1. Read and validate local and remote ThoughtForm sets.
 * 2. Merge using deterministic conflict resolution policy.
 * 3. Write merged output and optional conflict report.
 */
export async function runMerge(
  options: MergeOptions,
): Promise<{ result: MergeCommandResult; exitCode: number }> {
  const startMs = Date.now();
  vaultLogger.info('merge.start', {
    policy: options.policy,
    prefer: options.prefer,
    skewWindowMs: options.skewWindowMs,
    nonInteractive: options.nonInteractive,
  });

  // Step 1: Read and validate local forms
  const localForms = readAndValidate(options.local, 'local');
  if (!localForms.ok) {
    return failMerge(localForms.error, EXIT_VALIDATION, startMs);
  }

  // Step 1b: Read and validate remote forms
  const remoteForms = readAndValidate(options.remote, 'remote');
  if (!remoteForms.ok) {
    return failMerge(remoteForms.error, EXIT_VALIDATION, startMs);
  }

  // Step 2: Merge with conflict resolution
  const conflictOptions: ConflictResolutionOptions = {
    policy: options.policy,
    prefer: options.prefer,
    skewWindowMs: options.skewWindowMs,
  };

  const mergeResult: MergeResult = mergeThoughtformSets(
    localForms.data,
    remoteForms.data,
    conflictOptions,
  );

  // Count local-only and remote-only
  const localIds = new Set(localForms.data.map((tf) => tf.id));
  const remoteIds = new Set(remoteForms.data.map((tf) => tf.id));
  const localOnlyCount = localForms.data.filter((tf) => !remoteIds.has(tf.id)).length;
  const remoteOnlyCount = remoteForms.data.filter((tf) => !localIds.has(tf.id)).length;

  // Step 3: Write output
  if (options.out) {
    writeFileSync(options.out, JSON.stringify(mergeResult.merged, null, 2));
  }

  if (options.conflictReport && mergeResult.conflicts.length > 0) {
    writeFileSync(options.conflictReport, JSON.stringify(mergeResult.conflicts, null, 2));
  }

  const commandResult: MergeCommandResult = {
    status: 'ok',
    mergedCount: mergeResult.merged.length,
    conflictCount: mergeResult.conflicts.filter((c) => c.outcome !== 'no-conflict').length,
    localOnlyCount,
    remoteOnlyCount,
  };

  vaultLogger.info('merge.complete', {
    mergedCount: commandResult.mergedCount,
    conflictCount: commandResult.conflictCount,
    localOnlyCount: commandResult.localOnlyCount,
    remoteOnlyCount: commandResult.remoteOnlyCount,
    duration_ms: Date.now() - startMs,
  });

  return { result: commandResult, exitCode: EXIT_SUCCESS };
}

// --- Helpers ---

function readAndValidate(
  path: string,
  label: string,
): { ok: true; data: ThoughtFormV1[] } | { ok: false; error: string } {
  let rawInput: unknown;
  try {
    const text = readFileSync(path, 'utf-8');
    rawInput = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read ${label} file: ${message}` };
  }

  if (!Array.isArray(rawInput)) {
    return { ok: false, error: `${label} input must be a JSON array of ThoughtForms` };
  }

  const forms: ThoughtFormV1[] = [];
  for (let i = 0; i < rawInput.length; i++) {
    const parsed = parseThoughtForm(rawInput[i]);
    if (!parsed.ok) {
      const paths = parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return { ok: false, error: `${label} ThoughtForm[${i}] validation failed: ${paths}` };
    }
    forms.push(parsed.data);
  }

  return { ok: true, data: forms };
}

function failMerge(
  message: string,
  exitCode: number,
  startMs: number,
): { result: MergeCommandResult; exitCode: number } {
  const failure = classifyFailure(exitCode, message);
  vaultLogger.error('merge.failed', {
    exitCode,
    errorCode: failure.code,
    errorMessage: failure.message,
    remediation: failure.remediation,
    duration_ms: Date.now() - startMs,
  });
  return {
    result: {
      status: 'error',
      mergedCount: 0,
      conflictCount: 0,
      localOnlyCount: 0,
      remoteOnlyCount: 0,
    },
    exitCode,
  };
}
