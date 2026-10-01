# Migrating to Polytician 3.0

This guide covers every breaking change in 3.0 and what to do about it. The full list of changes, with the audit finding (`POLY-NN`) behind each, is in [CHANGELOG.md](CHANGELOG.md).

## Upgrade checklist

1. **Runtime:** Node.js 22 or newer; reinstall dependencies with install scripts enabled (see "Before you upgrade").
2. **Back up the 2.x store** (copy `concepts.db` or `pg_dump`); on Postgres, check pgvector ≥ 0.5.
3. **Configuration:** move a `.polytician.json` / `~/.polytician.json` to `~/.polytician/config.json` (or pass `--config`), and remove the settings 3.0 dropped (`POLYTICIAN_SIDECAR_URL`, `POLYTICIAN_ASYNC_INDEX_SYNC`, `POLYTICIAN_NODE_ID`, `POLYTICIAN_EXTERNAL_STATE_URL`, `POLYTICIAN_VECTOR_INDEX_URL`, `POLYTICIAN_LLM_MODEL`, `POLYTICIAN_LLM_API_KEY`, `agentVault.secrets`). See "Operators".
4. **Keys and opt-ins:** with `POLYTICIAN_ENCRYPT` or archival enabled, create a backup key first, or the server will not start. Set `POLYTICIAN_LLM_PROVIDER=agentvault` if you relied on implicit AgentVault inference.
5. **Ports:** nothing listens on 8787 any more; point health probes and deployments at 8788 (see "Ports").
6. **Start 3.0 once.** It migrates the schema in place (see "What the first start does"); 2.x cannot open the database afterwards.
7. **Make old concepts searchable** and take a fresh 3.0 backup (see "Embeddings and re-indexing" and "Backups and encryption").
8. **Update clients** for the tool contract changes: `{ results }` and `score` from `search_concepts`, strict arguments, namespaces, `VERSION_CONFLICT` and error codes (see "Tool callers").

## Before you upgrade

- **Node.js 22 or newer** is required (`engines.node: ">=22"`). Install with scripts enabled (no `--ignore-scripts`): better-sqlite3, sharp and onnxruntime-node fetch or build native binaries at install time. `ONNXRUNTIME_NODE_INSTALL=skip` skips onnxruntime-node's CUDA download on Linux x64, which polytician does not use.
- **Back up the database** (`~/.polytician/concepts.db`, or a `pg_dump` of the Postgres database). The first 3.0 start migrates the schema in place, and 2.x cannot read the migrated vector index. Copy the file (or dump the database): 3.0 cannot import 2.x backup files (see "Backups" below), so a 2.x backup is only restorable with 2.x.
- **Postgres:** make sure pgvector is at least 0.5 (HNSW); 0.8 or newer is recommended. Check with `SELECT extversion FROM pg_extension WHERE extname = 'vector';`.

## What the first start does

| Backend | Migration |
|---|---|
| SQLite | Rebuilds `concept_vectors` from `concepts.embedding` with a `namespace` partition key and `distance_metric=cosine`, and adds the `concepts.provenance`, `assertion_status` and `ledger_ref` columns. |
| Postgres | Under an advisory lock: adds `concepts.provenance`, `assertion_status` and `ledger_ref`, drops `idx_concept_vectors_embedding` (IVFFlat, L2) and creates `idx_concept_vectors_embedding_cosine` (HNSW, `vector_cosine_ops`). Re-indexes rows whose vector was missing and records `schema_version = 3` in `metadata`. |

Both backends also add `concepts.embedding_model` (with a partial index on `(namespace, embedding_model)`) and label every existing vector, once, with the configured `POLYTICIAN_EMBEDDING_MODEL` (2.x recorded no model; `legacy_vectors_labelled` in `metadata` records that this ran). See "Embeddings and re-indexing" if you changed the model in 2.x.

They also rewrite, once, every `tags` value that is not a JSON array of strings as the array it means (`legacy_tags_normalized` in `metadata`): a 2.x `agentvault-sync restore` of a 2.x auto-backup stored the array JSON-encoded a second time, which 3.0's tag filters could not match. NULL becomes `[]`.

On both backends, stored embeddings that could never be searched are set to `NULL`: wrong byte length (left by a failed, non-atomic 2.x save), non-finite, or all zero. The concept keeps its markdown and thoughtform. Re-embed it with `convert_concept { from: "markdown", to: "vector" }`, or re-save it.

On Postgres the HNSW index is built during this migration, inside the transaction that holds the migration's advisory lock. On a large table the build takes a while (raise `maintenance_work_mem` to speed it up), and other replicas starting meanwhile wait for it.

## Embeddings and re-indexing

- **Library.** 3.0 embeds with `@huggingface/transformers` 4.x instead of `@xenova/transformers` 2.x. The default model is the same (`Xenova/all-MiniLM-L6-v2`, quantized `q8`), cached in `<dataDir>/models`, so vectors made by 2.x stay comparable with new ones and need no re-embedding. A custom `POLYTICIAN_EMBEDDING_MODEL` must be one `@huggingface/transformers` can load (with a `q8` ONNX export) and must output 384-dimensional vectors; 2.x truncated larger outputs, 3.0 refuses them. If the first start cannot download the model (offline, proxy), the next embedding retries the download instead of failing until restart.
- **The vector index is rebuilt for you** by the first start (cosine distance, namespace partitioning); nothing needs to be re-embedded for that.
- **Concepts saved by 2.x without a vector are still not searchable.** 2.x did not embed saved markdown (3.0 does), so a 2.x concept stays out of search results until it gets a vector. `list_concepts` shows them with `representations.vector: false`; give each one a vector with `convert_concept { id, namespace, from: "markdown", to: "vector" }` (or `from: "thoughtform"` for a thoughtform-only concept). `reembed_concepts` does not cover them: it only replaces vectors made by another model.
- **Vectors stored by 2.x count as authored.** 2.x recorded no provenance, so 3.0 cannot tell a vector your client supplied from one 2.x derived from the markdown, and treats every pre-3.0 vector as authored (`provenance` has no `vector` entry). Auto-embedding never replaces an authored vector: after you edit a 2.x concept's markdown with `save_concept`, its vector still matches the old text, and `convert_concept { id, namespace, from: "markdown", to: "vector" }` fails with `OVERWRITE_REFUSED`. Re-derive it once with `convert_concept { id, namespace, from: "markdown", to: "vector", overwrite: true }` (`save_concept` has no `overwrite`); the vector is then recorded as derived, and later markdown edits re-derive it automatically. If you know every 2.x vector in a namespace came from its concept's text, run that conversion over the namespace's concepts after upgrading.
- **If you changed `POLYTICIAN_EMBEDDING_MODEL` in 2.x,** start 3.0 the first time with the model your vectors were made with (the start labels every existing vector with the configured model), then switch to the model you want and run `reembed_concepts { namespace }` per namespace, repeating while `remaining` > 0. Until then, searches over those namespaces fail with `EMBEDDING_MODEL_MISMATCH` rather than ranking incomparable vectors.

## Tool callers (MCP clients, agents, AgentVault)

### Results are typed objects: `search_concepts` returns `{ results }`

Every tool now declares an `outputSchema` and returns `structuredContent`; `content[0].text` holds the same JSON. Read `structuredContent` if your client supports it. The one shape change is `search_concepts`, which returns `{ "results": [...] }` instead of a bare array:

```diff
- const hits = JSON.parse(result.content[0].text);
+ const { results: hits } = JSON.parse(result.content[0].text); // or result.structuredContent
```

### `search_concepts`: `distance` → `score`

Results carry `score` in `[0, 1]` (higher is better) instead of L2 `distance` (lower is better).

```diff
- results.filter(r => r.distance < 0.8)
+ results.filter(r => r.score > 0.84)
```

`score = (1 + cosine similarity) / 2`. For unit vectors (MiniLM embeddings are normalized), L2 distance `d` and score are related by `score = 1 - d² / 4`, so an old threshold `d < t` becomes `score > 1 - t² / 4`.

Pass exactly one of `query` or `vector`; passing both is now a `VALIDATION_ERROR`.

### Unknown arguments are errors

Remove any argument a tool does not declare (`listTools` shows each schema, with `additionalProperties: false`). In 2.x unknown arguments were silently dropped. For example, a `save_concept { content, metadata }` call stored an empty concept.

### A new concept needs a representation

A `save_concept` create must include at least one of `markdown`, `thoughtform` or `embedding`. Tag-only saves still work on an existing concept.

### Thoughtforms and embeddings are validated

- `thoughtform` must be the native shape (`id` UUID, `rawText`, `metadata.createdAt`/`updatedAt` ISO strings, `entities[]` with `id`/`text`/`type`/`confidence`/`offset`) or a PolyVault v1 ThoughtForm (`schemaVersion`, epoch-ms `metadata`, `entities[]` with `value`). Free-form objects are rejected.
- `embedding` must have exactly 384 finite components and must not be all zero.
- Sizes are capped (see the README's Tools Reference). Namespaces must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. Rename any namespace containing spaces, commas or other characters before upgrading: 3.0 tools cannot name it (backups still carry and restore its concepts).

### Namespaces

- Pass `namespace` to `read_concept`, `delete_concept`, `convert_concept`, `vault_memory_push` and `vault_archive_concept` when the concept is not in `"default"`. Otherwise the call returns `NOT_FOUND`.
- Pass the concept's `namespace` when updating it with `save_concept`. An update through a different namespace (including an omitted one, which means `"default"`) returns `NAMESPACE_DENIED`. Concepts cannot move between namespaces; to move one, create it in the new namespace and delete the old one.
- `crossNamespace: true` now requires the operator to set `POLYTICIAN_NAMESPACES` (a comma-separated list, or `*` for all namespaces), and it searches only those namespaces. Drop `namespace` from a `crossNamespace` search: passing both is a `VALIDATION_ERROR`.
- `get_stats` and `health_check` without `namespace` report `"default"` only, as their descriptions always said; call them per namespace for other counts.

### Concurrency

`expectedVersion` now really rejects stale writes. Expect `VERSION_CONFLICT` (with `currentVersion`) where 2.x silently let the last writer win, and handle it by re-reading and retrying.

### Auto-embedding

`save_concept` and `batch_save_concepts` now compute the vector from the text when you do not pass `embedding`. That makes `save → search` work without a separate `convert_concept markdown → vector`, which you can drop. If you manage vectors yourself and do not want them computed, pass `autoEmbed: false`. A vector you supply yourself is never replaced by auto-embedding, and neither is a vector stored by 2.x (see "Vectors stored by 2.x count as authored" under "Embeddings and re-indexing").

### Conversions

- `convert_concept` refuses (`OVERWRITE_REFUSED`) to replace a representation that a caller wrote or imported. Pass `overwrite: true` to replace it. Representations that 3.0 produced (by a conversion, auto-embedding or `reembed_concepts`, recorded with origin `derived` or `llm`) can be re-derived without it; representations stored by 2.x, including vectors 2.x's `convert_concept` made, have no recorded provenance and need `overwrite: true` once. `read_concept` shows where each representation came from in `provenance` (`origin`: `user`, `derived`, `llm` or `import`).
- `vector → markdown` without `POLYTICIAN_LLM_PROVIDER` now fails with `CONVERSION_ERROR` instead of writing neighbouring concepts' text as the concept's markdown. Configure an LLM provider if you use this conversion.

### Batches

`batch_save_concepts` is all-or-nothing: one invalid entry fails the whole call and nothing is written. Validate or split input if you relied on partial success. The batch-wide `namespace` argument applies to all entries.

### AgentVault tools

- `vault_memory_pull` no longer overwrites a local concept with an older or undated remote entry, and skips entries recorded for another namespace or with non-UUID ids; read `skipped` in the result. It now also embeds pulled concepts.
- `vault_archive_concept` exists only when the operator enabled archival, and it refuses concepts that do not carry every `archival.tagFilter` tag (`VALIDATION_ERROR`, "Not archived: ..."), and a version that was already archived.

### Backups

- `agentvault_backup` is gone (it never persisted anything). Call `export_backup` (optionally `{ namespace }` or `{ encrypt: true }`); it returns the `file` name to pass to `import_backup { file }`. `list_backups` lists them.
- `vault_restore` is gone. Put the backup file in `<dataDir>/backups` and call `import_backup { file: "<name>" }`. Inline bundles and arbitrary paths are no longer accepted.
- `import_backup` keeps a local concept that is as new as or newer than the backup copy (`onConflict: "newer"`), where `vault_restore` overwrote it. Pass `onConflict: "overwrite"` to restore over newer local edits.

### AgentVault's `polytician-enricher`

Its calls never matched these tools: in 2.x they stored empty concepts and found nothing; in 3.0 they fail with `VALIDATION_ERROR` (`Input validation error: ... Unrecognized key(s)`). Change `save_concept { name, content, representation, metadata }` to `save_concept { markdown: content, tags: [...] }`, `search_concepts { query, limit, min_score }` to `search_concepts { query, k: limit }` and filter `results` on `score` client-side, and read results from `structuredContent` or `content[0].text` (there is no `content[0].data`). The README section "Calling Polytician from AgentVault's orchestrator" has the full contract.

### Embedding model changes

A search over a namespace holding vectors made by another embedding model fails with `EMBEDDING_MODEL_MISMATCH`. Run `reembed_concepts { namespace }` (repeat while `remaining` > 0; add `overwrite: true` to also replace vectors your client supplied, and re-save or delete concepts reported as `no-text`).

### Error bodies

Every tool error is returned as `{ "error": "...", "code": "..." }` in `content[0].text` (with `isError: true` and no `structuredContent`), including arguments that fail the input schema, which 2.x answered in plain text. Branch on `code` (`NOT_FOUND`, `VALIDATION_ERROR`, `VERSION_CONFLICT`, `NAMESPACE_DENIED`, `OVERWRITE_REFUSED`, `CONVERSION_ERROR`, `EMBEDDING_MODEL_MISMATCH`, `CONFIG_ERROR`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`), not on message text.

## Operators

### Ports

| | 2.x | 3.0 |
|---|---|---|
| stdio server | `/health` always on `0.0.0.0:8787` | No port unless `POLYTICIAN_HEALTH_PORT` is set; then `/health` and `/health/live` on `127.0.0.1` (`POLYTICIAN_HEALTH_HOST`) |
| HTTP transport (`--http`, Docker, Compose, Kubernetes) | none (only `/health` on 8787) | MCP on `POST /mcp` plus `/health` and `/health/live`, on `127.0.0.1:8788` (`POLYTICIAN_HTTP_HOST` / `POLYTICIAN_HTTP_PORT`; the image binds `0.0.0.0:8788` inside the container) |
| Python sidecar | `0.0.0.0:5001` | removed |

8787 belongs to stenographer's REST daemon in the suite; 8788 is Polytician's. Update monitors, firewall rules, Service and probe ports, and `-p` mappings accordingly.

- **Health endpoint.** A stdio server no longer opens a port. If a monitor or AgentVault's packaging probes `http://localhost:8787/health`, set `POLYTICIAN_HEALTH_PORT` (8788 is the suite default; 8787 is stenographer's) and point the probe at it; it binds `127.0.0.1` unless `POLYTICIAN_HEALTH_HOST` says otherwise. Use `/health/live` for liveness and `/health` for readiness. Parse `checks.database` / `checks.vector_index`; `checks.sidecar` and error messages are gone.
- **Python sidecar.** Delete the sidecar service, `POLYTICIAN_SIDECAR_URL`, and any `python-sidecar` image or `k8s/sidecar.yml` deployment. Nothing replaces it: search never used its FAISS index.
- **Remove `POLYTICIAN_NODE_ID`, `POLYTICIAN_EXTERNAL_STATE_URL` and `POLYTICIAN_VECTOR_INDEX_URL`** (`distributed.*`). They were never read.
- **Docker / compose / Kubernetes.** Rebuild the image: it now serves MCP over HTTP on port 8788 with data in `/data`. Clients need `Authorization: Bearer <POLYTICIAN_HTTP_TOKEN>`. For compose, export `POSTGRES_PASSWORD` and `POLYTICIAN_HTTP_TOKEN` (there is no default password; an existing `pgdata` volume keeps the password it was created with, so reuse `changeme` for it or change the role's password first), and use the single `polytician` service. Postgres is no longer published on the host. For Kubernetes, create `postgres-secret` and `polytician-http` (commands in the manifests), set the image, change Service/probe ports from 8787 to 8788, apply `k8s/networkpolicy.yml`, and label client pods `polytician-client: "true"`.
- Remove `POLYTICIAN_ASYNC_INDEX_SYNC` / `distributed.asyncIndexSync`; it no longer exists. Writes update the row and its vector in one transaction, so nothing needs syncing.
- **Move your config file.** `.polytician.json` in the working directory and `~/.polytician.json` are no longer read. Move the file to `~/.polytician/config.json`, or start the server with `--config /path/to/file.json`. Check it is valid JSON: an unparseable file now stops the server.
- **`${VAR}` in config values** may only name `POLYTICIAN_*` variables. Rename, for example `"apiToken": "${AV_TOKEN}"` → `"${POLYTICIAN_AV_TOKEN}"` and export that variable. Do not put `${...}` in `POLYTICIAN_AV_API_TOKEN`; it is used literally.
- **AgentVault over `https`.** Change an `http://` `apiBaseUrl` / `POLYTICIAN_AV_API_URL` to `https://` (plain `http` works only for localhost).
- **LLM provider.** Remove `POLYTICIAN_LLM_MODEL`, `POLYTICIAN_LLM_API_KEY`, `llm.model`, `llm.apiKey` and `agentVault.secrets` (none of them did anything). If you set `POLYTICIAN_LLM_PROVIDER` to `anthropic`, `openai` or `sampling`, the server now refuses to start: those providers never existed, so remove the setting (or set `agentvault`). **If you relied on AgentVault inference running without `POLYTICIAN_LLM_PROVIDER`,** set `POLYTICIAN_LLM_PROVIDER=agentvault`; without it, `vector → *` and `markdown → thoughtform` (without the rule-based pipeline) fail with `CONVERSION_ERROR`.
- **Arweave archival.** If `agentVault.archival.enabled` is true, add a non-empty `archival.tagFilter` (only concepts carrying every listed tag are archived) and a backup key (see "Backups and encryption"); without both the server refuses to start. Archives are now encrypted: keep the backup key, since `openArchive()` needs it to read them. Tags and namespace are no longer uploaded as public Arweave tags.
- **AgentVault retries.** Commits, tombstones and uploads are no longer retried. If a sync push fails transiently, it is logged and the next update of that concept pushes it again; run `agentvault-sync sync --direction push` to push everything. It now counts only the pushes that succeeded and exits non-zero if any failed (or, for `--direction pull`, if the pull failed), so a script can rely on its exit status.
- Decide on `POLYTICIAN_NAMESPACES`. Leave it unset for a single-user server, set it to the list of namespaces a server should expose, or set `*` to allow every namespace and enable `crossNamespace` search. The allowlist does not authenticate callers; see "Namespaces" in the README. A value that is set but empty (for example `POLYTICIAN_NAMESPACES=` in a deployment template), names an invalid namespace, or is not a string or array in the config file stops the server with `CONFIG_ERROR`; remove the setting to mean "no allowlist".

### Backups and encryption

- **Make a fresh backup after upgrading.** The 3.0 format (JSONL, `formatVersion: 1`) is different from every 2.x backup file, and 3.0 does not read 2.x files. Your data itself is migrated in place, so the simplest path is: copy the 2.x database, upgrade, start once, then `export_backup` (or `agentvault-sync backup`). That backup restores every concept as the store holds it, including content 2.x accepted and 3.0 refuses on a new write (a free-form thoughtform, more than 64 or longer tags, markdown over 1,000,000 characters, a non-UUID id, a namespace with spaces).
- **Auto-backup is now off.** If you relied on the 2.x default (every 50 saves), set `POLYTICIAN_BACKUP_THRESHOLD=50`, and `POLYTICIAN_BACKUP_RETAIN` if you want to keep more than 10 (it must be at least 1). The old `backup-*.json` files in `<dataDir>/backups` are not touched or pruned; delete them when you no longer need them (they are plaintext and were created world-readable).
- **If you set `POLYTICIAN_ENCRYPT` or `--encrypt`,** your 2.x backups were not encrypted. Create a key before upgrading, or the server will refuse to start (and the CLI's `--encrypt` backups fail with `CONFIG_ERROR`):

  ```bash
  openssl rand -base64 32 > ~/.polytician/backup.key && chmod 600 ~/.polytician/backup.key
  ```

  (or set `POLYTICIAN_BACKUP_KEY`). Store a copy of the key somewhere other than this machine. An encrypted backup cannot be restored without it.
- **`agentvault-sync backup`** now writes every namespace by default (pass `--namespace` for one) in JSONL, to `<dataDir>/backups` unless you pass `--out`. Scripts that parsed the 2.x JSON output need updating. `restore` keeps newer local copies unless `--on-conflict overwrite`.
- **Kubernetes:** each pod's `/data` is an `emptyDir`, so a file `export_backup` or auto-backup writes there is lost with the pod. Back up with `agentvault-sync backup` run from a checkout with `POLYTICIAN_DB_BACKEND=postgres` and `POLYTICIAN_POSTGRES_URL` (in 2.x the CLI could not open a Postgres store at all), or with `pg_dump`.
- Rehearse a restore with the drill in [`docs/polyvault/runbook.md`](docs/polyvault/runbook.md#restore-drill-procedure); it restores into a scratch store and never touches the live one.
- The SQLite database file is set to mode `600` on start. If another local user or group needs to read it, grant that explicitly.

## Library users (`ConceptService`, `DatabaseAdapter`)

- `ConceptService.search()` returns `{ id, namespace, score, tags, representations }`. The option `{ crossNamespace: true }` is now `{ namespaces: '*' }`; `{ namespaces: ['a', 'b'] }` searches several namespaces.
- `read(id, reps, { namespace })` and `delete(id, { namespace })` check the namespace when given. Omitting it keeps the unchecked, trusted behaviour for in-process callers.
- `save()` accepts `autoEmbed` (default `false` at the service level), `source` (what the caller declares about the content it writes), `provenance` (exact provenance, for content your code derived), `overwrite`, `assertionStatus` and `ledgerRef`, and throws `ValidationError`, `NamespaceDeniedError` and `OverwriteRefusedError` in addition to `VersionConflictError`. `saveBatch(entries, { autoEmbed, batchSize })` is atomic. Concepts carry `provenance`, `assertionStatus` and `ledgerRef`; search and list results carry `assertionStatus`.
- Custom `DatabaseAdapter` implementations must store `provenance` (JSON text, default `'{}'`), `assertion_status` and `ledger_ref`, return `assertion_status` in `ListRow` and `ConceptMetaRow`, and apply `assertionStatus` filters in `listConcepts()` and inside the KNN query of `vectorSearch()`.
- Custom `DatabaseAdapter` implementations must add `applyWrites(writes)`, which applies inserts, conditional updates (`WHERE version = expectedVersion`) and deletes atomically, keeping the vector index in step. They must also accept `vectorSearch(query, k, { namespaces, tags })` with the filters applied inside the KNN query and `distance` as cosine distance, and `upsertVector(id, namespace, embedding)`.
- `IndexSyncService` (`src/services/index-sync.service.ts`), `rebuildFaissIndex` (`src/sidecar/faiss.ts`) and the PolyVault FAISS client (`src/lib/polyvault/faiss-client.ts`) are removed. Call `runRestoreE2E(client, db, options)` without the FAISS client, and drop `faissMode` and `result.faiss`.
- Custom `DatabaseAdapter` implementations must also store `embedding_model` with each vector and implement `countForeignVectors(model, namespaces)`, `findForeignVectors(model, namespace, afterId, limit)`, `labelLegacyVectors(model)` and `normalizeLegacyTags()`. The conditional update in `applyWrites()` must match `namespace` as well as `id` and `version` (`WHERE id = ? AND version = ? AND namespace = ?`). Read `tags` with `parseTags()` (`src/db/tags.ts`), which decodes the shapes 2.x left.
- `ConceptService.restore()` checks records against `StoredConceptSchema` (types, and vectors against the embedding rules) instead of the input caps and thoughtform schemas, so it restores content kept from 2.x; `RestoreRecord.thoughtform` and `BackupRecord.thoughtform` are `unknown`. `MemorySyncConnector.pushConcept()` returns `'pushed' | 'skipped' | 'failed'` instead of `void` (it still never throws).
- `PolyticianConfig` lost `sidecarUrl` and `distributed`; `healthPort` is `number | null`, and `healthHost` and `http` were added.
- `SummarizeOptions.neighborDistances` is now `neighborScores`, with the same `[0, 1]` scores as search.
- `src/storage/thoughtform.ts` was removed: `encryptBundle` and `decryptBundle` returned their input unchanged, and `serializeThoughtFormsBundle` / `deserializeAndUpsertBundle` were called by nothing and wrote around the transactional write path. Backup encryption lives in `src/backup/format.ts`; use `exportBackup` / `importBackupBytes` (or `ConceptService.restore`) to move concepts in and out.
- `BackupService.runBackup()` writes the JSONL format and returns the file path; `exportBackup`, `importBackup` and `importBackupBytes` in `src/services/backup.service.ts` are the export/import entry points.
- **PolyVault (experimental, library only).** Producers must set `metadata.contentHash` to `computeContentHash(tf)` (or pass ThoughtForms through `withContentHash()`) before `runBackup`; other hashes are rejected. Drop `decryptionNonce` from `runRestore` options. Encrypted commits written by 2.x cannot be restored by any version (their nonce was never stored). A `runRestore` with `encryption` other than `none` now fails with exit 5 on a commit stored as plaintext, or whose chunks disagree on their `encrypted`/`compressed` flags, and one with `encryption: 'none'` fails with exit 2 on an encrypted commit; restore plaintext and encrypted commits in separate runs with the matching option. Call `rebase()` / `runRebase()` with remote commits and a `lastApplied` cursor; a 2.x rebase state file is read as "nothing applied yet", so the first 3.0 rebase merges every remote commit again, which the conflict policy makes safe.
