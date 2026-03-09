import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseThoughtForm } from '../../lib/polyvault/validate.js';
import {
  rebase,
  type RebaseInput,
  type RebaseResult,
} from '../../polyvault/rebase.js';
import type {
  ConflictPolicy,
  PreferOrigin,
} from '../../polyvault/conflict.js';
import { vaultLogger, classifyFailure } from '../../polyvault/logger.js';
import type { ThoughtFormV1 } from '../../schemas/thoughtform.js';

// --- Exit codes per PRD ---

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 2;

// --- Rebase state file ---

const DEFAULT_REBASE_STATE_FILE = '.polyvault/rebase-state.json';

export interface RebaseState {
  localBaseUpdatedAtMs: number;
  observedRemoteMaxUpdatedAtMs: number;
  lastRebasedAtMs: number;
}

// --- Rebase options ---

export interface RebaseOptions {
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
  /** Output path for rebased ThoughtForms JSON. */
  out?: string;
  /** Output path for conflict report JSON. */
  conflictReport?: string;
  /** Non-interactive mode. */
  nonInteractive: boolean;
  /** Path to rebase state file for persistence. */
  stateFile?: string;
  /** Explicit localBaseUpdatedAtMs (overrides state file). */
  localBaseUpdatedAtMs?: number;
  /** Explicit observedRemoteMaxUpdatedAtMs (overrides state file). */
  observedRemoteMaxUpdatedAtMs?: number;
}

// --- Rebase command result ---

export interface RebaseCommandResult {
  status: 'ok' | 'error';
  mergedCount: number;
  conflictCount: number;
  remoteDeltaCount: number;
  newBaseUpdatedAtMs: number;
  skewSafeLowerBound: number;
}

// --- Core rebase pipeline ---

/**
 * Run the PolyVault rebase pipeline (non-interactive).
 *
 * Steps per PRD 3.3:
 * 1. Load rebase state (from file or explicit options).
 * 2. Read and validate local and remote ThoughtForm sets.
 * 3. Compute remote delta since local base (with skew safety).
 * 4. Merge remote delta into local working set.
 * 5. Write rebased output, conflict report, and updated state.
 */
export async function runRebase(
  options: RebaseOptions,
): Promise<{ result: RebaseCommandResult; exitCode: number }> {
  const startMs = Date.now();
  vaultLogger.info('rebase.start', {
    policy: options.policy,
    prefer: options.prefer,
    skewWindowMs: options.skewWindowMs,
    nonInteractive: options.nonInteractive,
  });

  // Step 1: Load rebase state
  const state = loadRebaseState(options);

  // Step 2: Read and validate forms
  const localForms = readAndValidate(options.local, 'local');
  if (!localForms.ok) {
    return failRebase(localForms.error, EXIT_VALIDATION, startMs);
  }

  const remoteForms = readAndValidate(options.remote, 'remote');
  if (!remoteForms.ok) {
    return failRebase(remoteForms.error, EXIT_VALIDATION, startMs);
  }

  // Step 3-4: Run rebase
  const rebaseInput: RebaseInput = {
    localForms: localForms.data,
    remoteForms: remoteForms.data,
    localBaseUpdatedAtMs: state.localBaseUpdatedAtMs,
    observedRemoteMaxUpdatedAtMs: state.observedRemoteMaxUpdatedAtMs,
    options: {
      policy: options.policy,
      prefer: options.prefer,
      skewWindowMs: options.skewWindowMs,
    },
  };

  const rebaseResult: RebaseResult = rebase(rebaseInput);

  // Step 5: Write output
  if (options.out) {
    writeFileSync(options.out, JSON.stringify(rebaseResult.merged, null, 2));
  }

  if (options.conflictReport && rebaseResult.conflicts.length > 0) {
    writeFileSync(options.conflictReport, JSON.stringify(rebaseResult.conflicts, null, 2));
  }

  // Persist updated rebase state
  const stateFile = options.stateFile ?? DEFAULT_REBASE_STATE_FILE;
  const updatedState: RebaseState = {
    localBaseUpdatedAtMs: rebaseResult.newBaseUpdatedAtMs,
    observedRemoteMaxUpdatedAtMs: Math.max(
      state.observedRemoteMaxUpdatedAtMs,
      ...remoteForms.data.map((tf) => tf.metadata.updatedAtMs),
    ),
    lastRebasedAtMs: Date.now(),
  };
  saveRebaseState(stateFile, updatedState);

  const commandResult: RebaseCommandResult = {
    status: 'ok',
    mergedCount: rebaseResult.merged.length,
    conflictCount: rebaseResult.conflicts.filter((c) => c.outcome !== 'no-conflict').length,
    remoteDeltaCount: rebaseResult.remoteDeltaCount,
    newBaseUpdatedAtMs: rebaseResult.newBaseUpdatedAtMs,
    skewSafeLowerBound: rebaseResult.skewSafeLowerBound,
  };

  vaultLogger.info('rebase.complete', {
    mergedCount: commandResult.mergedCount,
    conflictCount: commandResult.conflictCount,
    remoteDeltaCount: commandResult.remoteDeltaCount,
    newBaseUpdatedAtMs: commandResult.newBaseUpdatedAtMs,
    duration_ms: Date.now() - startMs,
  });

  return { result: commandResult, exitCode: EXIT_SUCCESS };
}

// --- State persistence ---

function loadRebaseState(options: RebaseOptions): RebaseState {
  // Explicit overrides take priority
  if (options.localBaseUpdatedAtMs !== undefined && options.observedRemoteMaxUpdatedAtMs !== undefined) {
    return {
      localBaseUpdatedAtMs: options.localBaseUpdatedAtMs,
      observedRemoteMaxUpdatedAtMs: options.observedRemoteMaxUpdatedAtMs,
      lastRebasedAtMs: 0,
    };
  }

  // Try to load from state file
  const stateFile = options.stateFile ?? DEFAULT_REBASE_STATE_FILE;
  if (existsSync(stateFile)) {
    try {
      const text = readFileSync(stateFile, 'utf-8');
      return JSON.parse(text) as RebaseState;
    } catch {
      // Fall through to defaults
    }
  }

  // Defaults: treat as first rebase
  return {
    localBaseUpdatedAtMs: options.localBaseUpdatedAtMs ?? 0,
    observedRemoteMaxUpdatedAtMs: options.observedRemoteMaxUpdatedAtMs ?? 0,
    lastRebasedAtMs: 0,
  };
}

function saveRebaseState(stateFile: string, state: RebaseState): void {
  try {
    // Ensure parent directory exists
    const dir = stateFile.substring(0, stateFile.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal: state file is advisory
    vaultLogger.warn('rebase.state.save-failed', { stateFile });
  }
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

function failRebase(
  message: string,
  exitCode: number,
  startMs: number,
): { result: RebaseCommandResult; exitCode: number } {
  const failure = classifyFailure(exitCode, message);
  vaultLogger.error('rebase.failed', {
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
      remoteDeltaCount: 0,
      newBaseUpdatedAtMs: 0,
      skewSafeLowerBound: 0,
    },
    exitCode,
  };
}
