# Repository Evaluation — July 2026

A full-codebase evaluation of Polytician, covering the TypeScript MCP server,
the PolyVault subsystem, the AgentVault integration, the Python sidecar, and
the Motoko canister sources. Each finding is marked **Fixed** (addressed in
the accompanying refactor) or **Deferred** (documented here for follow-up).

## 1. Baseline breakage (Fixed)

- **`src/storage/thoughtform.ts` and `tests/thoughtform-bundle.test.ts` were
  merge-corrupted.** Four feature branches each created these files
  independently (`24cb329`, `ba7c8f7`, `7ccc4a3`, `3f01671`) and successive
  merges concatenated the versions, dropping closing braces and leaving import
  statements mid-file. The repository did not compile (`tsc` failed with
  TS1005). Both files were reconstructed from the original commits.
- **ESLint crashed on every run.** The blanket `"ajv": ">=8.18.0"` override in
  `package.json` force-upgraded `@eslint/eslintrc`'s ajv 6 dependency to ajv 8,
  which it cannot load. The MCP SDK already requires ajv ^8 natively, so the
  override was removed. The ESLint config also hand-listed a small set of Node
  globals and flagged the rest (`setImmediate`, `AbortController`,
  `TextEncoder`, …) as `no-undef`; the rule is now disabled for TS sources per
  standard typescript-eslint practice — the compiler owns that check.

## 2. Correctness bugs

### Fixed

- **PostgreSQL backend was unreachable.** `src/index.ts` called the
  synchronous `initializeDatabase()`, which throws for
  `POLYTICIAN_DB_BACKEND=postgres`; `initializeDatabaseAsync()` existed but was
  never called. Startup now uses the async initializer.
- **Health checks silently passed under Postgres.** `src/health.ts` invoked
  `adapter.getStats()` / `adapter.vectorSearch()` without awaiting, so async
  adapter failures never reached the `try/catch` and leaked as unhandled
  rejections. All three checks are now awaited via `Promise.all`.
- **Sidecar health check probed the wrong URL.** `checkSidecar` fetched the
  sidecar base URL, which serves no route (Flask only exposes `/health`), so a
  healthy sidecar always reported `error`. It now probes `/health` with
  trailing-slash normalization; `src/sidecar/faiss.ts` gets the same
  normalization.
- **`IndexSyncService` leaked unhandled rejections.** Queued vector updates
  called `adapter.upsertVector`/`deleteVector` without awaiting; the flush
  loop's `try/catch` could not observe async failures. The flush path is now
  fully async and awaits each update.
- **Graceful shutdown abandoned in-flight work.** `shutdown()` called the
  possibly-async `closeDatabase()` and immediately `process.exit(0)`. It now
  drains pending index updates and awaits DB close, with a re-entrancy guard.
- **Backup save-counter race.** `BackupService.incrementAndCheckAsync()` is a
  read-modify-write on the metadata table; concurrent `concept.created` /
  `concept.updated` events could lose increments or threshold triggers.
  Increments are now serialized through a promise queue.
- **`expectedVersion` was ignored for missing concepts.**
  `ConceptService.save()` only enforced optimistic concurrency when the row
  existed; a save with `expectedVersion` for a concurrently-deleted id silently
  created a new v1 concept. It now throws `VersionConflictError`.
- **Bundle serialize → deserialize did not round-trip.**
  `serializeThoughtFormsBundle` emits a versioned envelope
  (`{version, thoughtforms, metadata}`) while `deserializeAndUpsertBundle`
  validated a bare ThoughtForm array, so one's output failed the other's
  validation. The deserializer now accepts both shapes.
- **`inference.maxRetries` was advertised but never implemented.** The
  AgentVault config schema documents `maxRetries` (default 2) yet
  `AVHttpClient` performed exactly one attempt. The client now retries network
  errors/timeouts and gateway 5xx (502/503/504) with exponential backoff, and
  tolerates empty response bodies (204 / bodyless 200) on void-style endpoints
  instead of crashing in `res.json()`.
- **Config was parsed but never applied (NLP).** `nlp.pipeline: 'rule-based'`
  (and `entityTypes` / `minConfidence`) had zero runtime effect;
  `markdownToThoughtform` always fell through to the LLM provider, which is
  `NullProvider` (throws) unless AgentVault is configured. The pipeline is now
  wired at startup and the options are threaded into extraction.
- **Misleading tool contract.** `batch_save_concepts` claimed to defer vector
  index updates until batch completion; it saves sequentially. The description
  now matches the implementation (batching applies to `autoEmbed` embedding
  generation only).
- **Magic number 384.** `src/health.ts` hardcoded the vector dimension instead
  of using `VECTOR_DIMENSION`; `health_check` also hardcoded the embedding
  model name instead of reading config. Both fixed.

### Deferred

- **`namespace` is silently ignored on update.** `ConceptService.save()` never
  applies `params.namespace` to an existing concept. Changing this affects
  isolation semantics and existing callers; it should either error or move the
  concept, decided deliberately.
- **`vectorCount` vs `vecCount` dual sources of truth.** `getStats` reports
  both rows-in-`concept_vectors` and `embedding IS NOT NULL`; the two can
  drift. Consolidating requires a data-model decision.
- **Drizzle schema drift.** `src/db/schema.ts` models only `concepts`; the
  `metadata` and vector tables exist solely in adapter DDL, so drizzle-kit
  migrations cannot manage them, and `getUpdatedThoughtFormsSince` is
  SQLite-only.
- **Python sidecar `/polyvault/faiss/rebuild` is non-functional.** It ignores
  `mode`, builds a local FAISS index, and discards it; unlike `/rebuild-index`
  it never updates searchable state. Its only TS caller
  (`src/lib/polyvault/faiss-client.ts`) is itself unreachable at runtime.
  `python-sidecar/faiss_rebuild.py` is entirely dead.
- **Sidecar bundle round-trip integrity.** `polyvault_service.py` serializes
  the payload while `manifest.payloadHash` / `commitId` / `dedupeKey` are still
  empty placeholders (the hash cannot include itself); deserialized bundles
  therefore carry empty identity fields. The contract should define these
  fields as external to the payload.
- **Multi-worker FAISS state.** `app.py` keeps the FAISS index in module
  globals while the Dockerfile runs `gunicorn --workers 2`; a rebuild in one
  worker is invisible to the other.
- **Silent error-swallowing in vault sync.** `MemorySyncConnector.pushConcept`
  and the event-bridge handlers log-and-drop failures — no dead-letter or
  retry, so a concept can silently never reach the vault.

## 3. Duplication

### Fixed

- `serializeEmbedding` / `deserializeEmbedding` were duplicated across
  `concept.service.ts`, `index-sync.service.ts`, and inline in `health.ts`;
  consolidated into `src/db/embedding-codec.ts`.
- `src/server.ts` hand-rolled the MCP text-content envelope in every tool and
  applied request logging to only 4 of 10 tools; all tools now share
  `jsonResult` / `errorResult` helpers and `withRequestLogging`, and
  `search_concepts` validation failures are now flagged `isError` like every
  other tool error.

### Deferred

- **Two ThoughtForm schemas.** `src/types/thoughtform.ts` (live app: ISO
  timestamps, `subjectId/predicate/objectId` relationships) vs
  `src/schemas/thoughtform.ts` (PolyVault v1: epoch-ms, `from/to/type`).
  Both write the same `concepts.thoughtform` column via different paths
  (`ConceptService` vs `sqlite-upsert.ts`), so the column can hold either
  shape. Needs either a unification or an explicit translation layer.
- **Three "backup" implementations** (`backup.service.ts` JSON snapshots,
  `commands/polyvault/backup.ts` chunked/encrypted canister pipeline,
  `bin/agentvault-sync.ts` full-DB export) and **triplicated restore logic**
  (bin script, `vault-tools.ts`, `commands/polyvault/restore.ts`), all
  paginating `list` + N+1 `read`.
- **Four HTTP call sites** with divergent timeout/normalization behavior
  (`AVHttpClient`, `sidecar/faiss.ts`, `lib/polyvault/faiss-client.ts` — which
  has no timeout at all — and `health.ts`).
- Postgres adapter repeats row-mapping/`CASE WHEN` blocks across three
  methods; `${ENV_VAR}` substitution is implemented twice (`config.ts`,
  `archival.connector.ts`).

## 4. Dead code

### Fixed

- Unused imports removed: `restore.ts` (5 symbols), `queries.ts`
  (`isNotNull`), `polyvault/logger.ts` (`LogLevel`), `types/concept.ts`
  (`ThoughtFormInputSchema`).

### Deferred (flagged, deliberately not deleted)

- **The PolyVault command layer has no entrypoint.** `src/commands/polyvault/*`
  (backup/restore/merge/rebase/e2e) and, transitively,
  `src/lib/polyvault/*`, most of `src/polyvault/*`, `src/schemas/bundle.ts`,
  and `src/storage/sqlite-upsert.ts` are reachable only from the test suite —
  there is no CLI wiring. The code is well-tested and matches
  `docs/polyvault/spec-v1.md`, so it looks like an unfinished feature rather
  than cruft; it needs a `bin` entry (e.g. `polytician polyvault backup …`)
  or an explicit decision to remove it.
- `src/polyvault/timestamp.ts` is tests-only; `ThoughtFormInputSchema` /
  `ThoughtFormInput` and `SearchResult` (types) have no consumers;
  `ConceptSchema` is never used as a runtime validator.
- Python: `faiss_rebuild.py` and all response models in
  `polyvault_models.py` are unreferenced.
- **Motoko canister (`src/agentvault_polyvault/*.mo`) is not buildable.**
  There is no `dfx.json`, no candid files, and no CI step referencing it.
  `main.mo` uses `__installing_principal` (not a valid Motoko identifier) and
  keeps all state in non-stable bindings despite the "stable_store" naming, so
  data would be lost on upgrade. `stable_store.mo` has `Nat` underflow traps on
  empty collections (`size() - 1`). This needs a dedicated effort (or removal)
  and cannot be verified in this environment.

## 5. Documentation drift (partially fixed)

The README predates the current architecture and still described a
768-dimension embedding pipeline, a mandatory spaCy/sentence-transformers
sidecar, and a 17-tool API (`save_concept_as_thoughtForm`, `generate_id`, …)
that does not exist. The actual server registers 10 core tools plus
`agentvault_backup` and 7 optional `vault_*` tools, embeds in-process via
`@xenova/transformers` (384 dimensions), and treats the Python sidecar as an
optional FAISS-rebuild helper. The most misleading sections (architecture
diagram, key features, test instructions) were corrected; a full README
rewrite (tutorials and API reference still describe the old tool names) is
deferred.
