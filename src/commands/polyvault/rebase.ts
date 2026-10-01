import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { parseThoughtForm } from '../../lib/polyvault/validate.js';
import {
  rebase,
  type CommitCursor,
  type RebaseInput,
  type RebaseResult,
  type RemoteCommit,
} from '../../polyvault/rebase.js';
import type { ConflictPolicy, PreferOrigin } from '../../polyvault/conflict.js';
import { computeContentHash } from '../../polyvault/hash.js';
import { vaultLogger, classifyFailure } from '../../polyvault/logger.js';
import type { ThoughtFormV1 } from '../../schemas/thoughtform.js';

// --- Exit codes per PRD ---

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 2;

// --- Rebase state file ---

const DEFAULT_REBASE_STATE_FILE = '.polyvault/rebase-state.json';

export interface RebaseState {
  /** Last remote commit applied (canister commit order); null before the first rebase. */
  lastApplied: CommitCursor | null;
  lastRebasedAtMs: number;
}

// --- Rebase options ---

export interface RebaseOptions {
  /** Path to local ThoughtForms JSON file (an array of ThoughtForms). */
  local: string;
  /**
   * Path to the remote commits JSON file: an array of
   * `{ commitId, createdAtMs, thoughtforms: ThoughtForm[] }`, where
   * createdAtMs is the canister's commit time.
   */
  remote: string;
  /** Conflict resolution policy. */
  policy: ConflictPolicy;
  /** Preferred origin when timestamps are within skew window. */
  prefer?: PreferOrigin;
  /** Skew window in ms (default 300_000 = 5 min), used by `prefer`. */
  skewWindowMs?: number;
  /** Output path for rebased ThoughtForms JSON. */
  out?: string;
  /** Output path for conflict report JSON. */
  conflictReport?: string;
  /** Non-interactive mode. */
  nonInteractive: boolean;
  /** Path to rebase state file for persistence. */
  stateFile?: string;
  /** Explicit last applied commit (overrides state file); null applies every commit. */
  lastApplied?: CommitCursor | null;
}

// --- Rebase command result ---

export interface RebaseCommandResult {
  status: 'ok' | 'error';
  mergedCount: number;
  conflictCount: number;
  remoteDeltaCount: number;
  appliedCommitCount: number;
  lastApplied: CommitCursor | null;
}

// --- Core rebase pipeline ---

/**
 * Run the PolyVault rebase pipeline (non-interactive).
 *
 * Steps per PRD 3.3:
 * 1. Load rebase state (from file or explicit options).
 * 2. Read and validate the local ThoughtForms and the remote commits.
 * 3. Take every ThoughtForm from remote commits after the last applied one
 *    (commit order, not content timestamps).
 * 4. Merge them into the local working set.
 * 5. Write rebased output, conflict report, and updated state.
 */
export async function runRebase(
  options: RebaseOptions
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

  // Step 2: Read and validate inputs
  const localForms = readLocalForms(options.local);
  if (!localForms.ok) {
    return failRebase(localForms.error, EXIT_VALIDATION, startMs);
  }

  const remoteCommits = readRemoteCommits(options.remote);
  if (!remoteCommits.ok) {
    return failRebase(remoteCommits.error, EXIT_VALIDATION, startMs);
  }

  // Step 3-4: Run rebase
  const rebaseInput: RebaseInput = {
    localForms: localForms.data,
    remoteCommits: remoteCommits.data,
    lastApplied: state.lastApplied,
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
  saveRebaseState(stateFile, {
    lastApplied: rebaseResult.lastApplied,
    lastRebasedAtMs: Date.now(),
  });

  const commandResult: RebaseCommandResult = {
    status: 'ok',
    mergedCount: rebaseResult.merged.length,
    conflictCount: rebaseResult.conflicts.filter(c => c.outcome !== 'no-conflict').length,
    remoteDeltaCount: rebaseResult.remoteDeltaCount,
    appliedCommitCount: rebaseResult.appliedCommitCount,
    lastApplied: rebaseResult.lastApplied,
  };

  vaultLogger.info('rebase.complete', {
    mergedCount: commandResult.mergedCount,
    conflictCount: commandResult.conflictCount,
    remoteDeltaCount: commandResult.remoteDeltaCount,
    appliedCommitCount: commandResult.appliedCommitCount,
    lastCommitId: commandResult.lastApplied?.commitId ?? null,
    duration_ms: Date.now() - startMs,
  });

  return { result: commandResult, exitCode: EXIT_SUCCESS };
}

// --- State persistence ---

const CursorSchema = z.object({
  commitId: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
});

function loadRebaseState(options: RebaseOptions): RebaseState {
  // Explicit overrides take priority
  if (options.lastApplied !== undefined) {
    return { lastApplied: options.lastApplied, lastRebasedAtMs: 0 };
  }

  // Try to load from state file. A state file written before 3.0 (with
  // timestamp markers instead of a commit cursor) reads as "nothing applied
  // yet": every commit is merged again, which the conflict policy makes safe.
  const stateFile = options.stateFile ?? DEFAULT_REBASE_STATE_FILE;
  if (existsSync(stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
      const cursor = CursorSchema.safeParse(raw['lastApplied']);
      return {
        lastApplied: cursor.success ? cursor.data : null,
        lastRebasedAtMs: typeof raw['lastRebasedAtMs'] === 'number' ? raw['lastRebasedAtMs'] : 0,
      };
    } catch {
      // Fall through to defaults
    }
  }

  // Defaults: treat as first rebase
  return { lastApplied: null, lastRebasedAtMs: 0 };
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

function readJson(
  path: string,
  label: string
): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, 'utf-8')) as unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read ${label} file: ${message}` };
  }
}

/** Validate ThoughtForms, including that each contentHash matches its content. */
function validateForms(
  raw: unknown[],
  label: string
): { ok: true; data: ThoughtFormV1[] } | { ok: false; error: string } {
  const forms: ThoughtFormV1[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseThoughtForm(raw[i]);
    if (!parsed.ok) {
      const paths = parsed.errors.map(e => `${e.path}: ${e.message}`).join('; ');
      return { ok: false, error: `${label} ThoughtForm[${i}] validation failed: ${paths}` };
    }
    if (parsed.data.metadata.contentHash !== computeContentHash(parsed.data)) {
      return {
        ok: false,
        error: `${label} ThoughtForm[${i}] metadata.contentHash does not match its content`,
      };
    }
    forms.push(parsed.data);
  }
  return { ok: true, data: forms };
}

function readLocalForms(
  path: string
): { ok: true; data: ThoughtFormV1[] } | { ok: false; error: string } {
  const json = readJson(path, 'local');
  if (!json.ok) return json;
  if (!Array.isArray(json.data)) {
    return { ok: false, error: 'local input must be a JSON array of ThoughtForms' };
  }
  return validateForms(json.data, 'local');
}

const RemoteCommitSchema = z
  .object({
    commitId: z.string().min(1),
    createdAtMs: z.number().int().nonnegative(),
    thoughtforms: z.array(z.unknown()),
  })
  .passthrough();

function readRemoteCommits(
  path: string
): { ok: true; data: RemoteCommit[] } | { ok: false; error: string } {
  const json = readJson(path, 'remote');
  if (!json.ok) return json;
  if (!Array.isArray(json.data)) {
    return {
      ok: false,
      error:
        'remote input must be a JSON array of commits ({ commitId, createdAtMs, thoughtforms })',
    };
  }
  const commits: RemoteCommit[] = [];
  for (let i = 0; i < json.data.length; i++) {
    const commit = RemoteCommitSchema.safeParse(json.data[i]);
    if (!commit.success) {
      const paths = commit.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      return { ok: false, error: `remote commit[${i}] validation failed: ${paths}` };
    }
    const forms = validateForms(commit.data.thoughtforms, `remote commit[${i}]`);
    if (!forms.ok) return forms;
    commits.push({
      commitId: commit.data.commitId,
      createdAtMs: commit.data.createdAtMs,
      thoughtforms: forms.data,
    });
  }
  return { ok: true, data: commits };
}

function failRebase(
  message: string,
  exitCode: number,
  startMs: number
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
      appliedCommitCount: 0,
      lastApplied: null,
    },
    exitCode,
  };
}
