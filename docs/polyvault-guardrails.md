# PolyVault Guardrails: Implementation Policy and Definition of Done

## Purpose

This policy defines non-negotiable guardrails for implementing PolyVault as a bridge between local Polytitian ThoughtForms and AgentVault on-chain backup/sync. It is designed to prevent privacy leaks, data loss, semantic drift, and non-upstreamable architecture decisions.

All PolyVault work must satisfy this policy before merge.

## Core Principles

1. **Preserve meaning**: ThoughtForm semantics and field intent must remain unchanged end-to-end.
2. **Fail closed**: Security-sensitive operations must abort when prerequisites are unmet.
3. **No silent loss**: Conflicts, partial restores, and invalid data must be explicit.
4. **Deterministic by design**: Any hash/commit-related payload must serialize canonically.
5. **Additive compatibility**: New interfaces must be backward-compatible and upstream-friendly.

## Required Runtime Invariants

These invariants must hold in all environments unless a command explicitly documents otherwise.

- `backup` is idempotent: repeated runs with unchanged source state do not duplicate records or bloat bundles.
- `restore` is system-consistent: SQLite and FAISS end in a matched state, or rollback/recovery is applied.
- Sensitive mode never persists plaintext `rawText` on-chain by default.
- Encryption-required mode never uploads plaintext if encryption is unavailable.
- Bundle metadata is advisory until validated against configured principal/canister/network.
- Payload transfer respects configured ingress/message limits via chunking before failure.
- All partial outcomes are surfaced with counts: fetched, inserted, updated, skipped, conflicted, failed.

## Guardrails by Area

### 1) Content Correctness and Semantics

Must:

- Preserve exact meaning of `entities`, `relationships`, `contextGraph`, `rawText`, `metadata` during serialization/deserialization.
- Reject malformed ThoughtForms with explicit typed errors.
- Preserve unknown/forward-compatible fields unless explicitly deprecated in a versioned schema migration.
- Validate timestamps and sanity-check future values before trust.
- Apply conflict rules that prevent older data from overwriting newer data.
- Define and enforce ID collision strategy across devices/principals (for example, namespaced IDs).
- Validate bundle metadata against runtime configuration.

Must not:

- Invent missing fields or silently "repair" malformed records.
- Perform naive graph merges that concatenate contradictory or duplicate edges.
- Claim on-chain semantic/vector query support unless it exists.

### 2) Security and Privacy

Must:

- Encrypt at rest/in transit according to mode and policy, with fail-closed behavior.
- Use nonce/IV generation that guarantees uniqueness per encryption operation.
- Keep keys and secret material out of logs, files, process arguments, and shell history.
- Enforce principal-based access controls and provenance checks for identity-sensitive operations.
- Refuse insecure version downgrades by default.

Must not:

- Ship encryption stubs or placeholders that imply protection.
- Log plaintext ThoughtForms, `rawText`, decrypted payloads, VetKeys material, derived keys, or IVs.
- Mix write/restore identities without explicit confirmation and provenance validation.
- Write decrypted bundles to disk unless explicitly requested.

### 3) Sync, Merge, and Conflict Behavior

Must:

- Define source-of-truth and per-field conflict rules for each mode (`backup`, `restore`, `merge`, `rebase`).
- Guarantee idempotency for repeated sync runs.
- Require explicit destructive flags for force overwrite operations.
- Handle network failures with resumable checkpoints or rollback strategy.
- Keep restore operations transactional enough to avoid permanent partial state.

Must not:

- Use timestamp-only conflict resolution in distributed clock-drift scenarios.
- Discard whole ThoughtForms when only subset fields conflict.
- Treat on-chain history as mutable unless canister explicitly supports and documents it.

### 4) Performance and Resource Use

Must:

- Chunk large uploads before ingress/stable-memory limits are exceeded.
- Use streaming/chunking for serialization where feasible instead of full-table memory loads.
- Gate compression behind size thresholds.
- Batch FAISS rebuild work to avoid rebuild-per-delta loops.
- Provide progress, timeout, and cancellation for long interactive operations.

Must not:

- Assume fixed safe limits (for example, hard-coding 1 MB universally).
- Create recursive background sync triggers that can thrash.

### 5) Reliability, Atomicity, and Recovery

Must:

- Verify integrity with hashes before/after writes.
- Validate schema and detect corruption before restore.
- Require verified snapshot + explicit confirmation before destructive local reset/truncate actions.
- Securely clean up temporary sensitive artifacts.
- Emit explicit per-run result accounting and failure reasons.
- Fail gracefully when sidecars/services are unavailable.

Must not:

- Report success without remote acknowledgments and local consistency checks.
- Allow silent partial restore completion.

### 6) Interop and Compatibility

Must:

- Keep CLI/MCP additions backward-compatible and additive.
- Communicate cross-repo via stable boundaries (JSON/CLI/HTTP), not internal imports.
- Keep environment/network/canister config externalized with sensible defaults.
- Justify and validate dependency changes against Node/Python toolchain compatibility.

Must not:

- Perform invasive architectural rewrites that block upstream contribution.
- Assume specific OS schedulers as requirements.

### 7) Logging, Observability, and UX

Must:

- Log minimal safe telemetry: counts, non-sensitive IDs, hashes, payload sizes, timestamps.
- Return actionable remediation guidance with each failure class: retry, re-auth, reconfigure, inspect.
- Use explicit command modes (`backup|restore|merge|rebase`) instead of ambiguous `sync` defaults.
- Require dry-run or confirmation for destructive operations in CLI/MCP tools.

Must not:

- Dump full ThoughtForms into logs.
- Use ambiguous flags or vague success messages.

### 8) Scope Boundaries

Out of scope for initial integration unless separately approved:

- On-chain vector indexing/semantic search (FAISS remains local).
- Claims of immutable snapshots unless canister guarantees immutability.
- Multi-agent orchestration beyond defined roadmap.
- Generalized VCS beyond MemoryRepo needs.
- Wallet/payment/cycles automation.

## Definition of Done (Release Gates)

A PolyVault change is done only when all gates below pass.

### A. Test Gates

- Round-trip fidelity tests pass: serialize -> store -> fetch -> deserialize yields semantically identical ThoughtForms, including unknown fields.
- Encryption-at-rest tests pass when encryption mode is enabled (no plaintext acceptance).
- Failure-path tests pass:
  - interrupted upload and missing chunk,
  - corrupted bundle payload,
  - schema/version mismatch,
  - identity mismatch,
  - sidecar unreachable.
- Idempotency tests pass for repeated backup/sync runs.
- Restore consistency tests prove no permanent SQLite/FAISS mismatch after failure.
- Integration tests run against local replica, not mainnet.

### B. Security Gates

- No secret/plaintext leakage in logs during normal and error paths.
- No insecure version downgrade acceptance without explicit policy exception.
- No key material persisted in repo, env files, CLI args, or process-visible command lines.

### C. Operational Gates

- Chunking/compression thresholds are configurable and exercised.
- Long operations provide progress and bounded timeout/cancellation behavior.
- Errors include concrete next actions and do not end in silent partial state.

### D. Compatibility Gates

- Existing CLI/MCP commands remain backward-compatible.
- No hard-coded developer paths, canister IDs, or fixed network targets.
- Cross-repo integration uses stable interface boundaries.

## Suggested Command Semantics

Command behavior should be explicit and safe by default.

- `polyvault backup`: local -> on-chain, non-destructive, idempotent.
- `polyvault restore`: on-chain -> local with conflict reporting and consistency guarantees.
- `polyvault merge`: explicit, field-level conflict policy required.
- `polyvault rebase`: explicit source-of-truth and replay semantics required.
- `--dry-run`: required for preview in destructive-capable commands.
- `--force`: opt-in for destructive overwrite operations only.

## Documentation Requirements

All user-facing docs for PolyVault must include:

- Size/ingress limits and chunking behavior.
- Encryption expectations and sensitive-mode behavior.
- Identity/principal mismatch risks.
- Clock-drift and conflict-resolution caveats.
- Explicit warnings for any command targeting mainnet (`--network=ic`).
- Performance claims with qualifiers (dataset size, hardware, rebuild strategy).

## Non-Compliant Outcomes (Release Blockers)

Do not release if any condition below is true:

- ThoughtForms can be silently lost or overwritten during merge/restore.
- Sensitive plaintext can be stored on-chain when encryption is expected.
- Repeated syncs duplicate concepts or grow bundles unexpectedly.
- SQLite/FAISS consistency can be left mismatched without recovery.
- Upload path can exceed canister constraints without preemptive chunking.
- Implementation depends on hard-coded environment values or local developer paths.
- Changes cannot be reasonably upstreamed due to invasive design.
- Product claims exceed delivered capability (for example, on-chain semantic query, immutable snapshots).
