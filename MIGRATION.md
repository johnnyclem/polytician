# Migrating to Polytician 3.0

This guide covers every breaking change in 3.0 and what to do about it. The full list of changes is in [CHANGELOG.md](CHANGELOG.md).

## Before you upgrade

- **Back up the database** (`~/.polytician/concepts.db`, or a `pg_dump` of the Postgres database). The first 3.0 start migrates the schema in place, and 2.x cannot read the migrated vector index. Copy the file (or dump the database): 3.0 cannot import 2.x backup files (see "Backups" below), so a 2.x backup is only restorable with 2.x.
- **Postgres:** make sure pgvector is at least 0.5 (HNSW); 0.8 or newer is recommended. Check with `SELECT extversion FROM pg_extension WHERE extname = 'vector';`.

## What the first start does

| Backend | Migration |
|---|---|
| SQLite | Rebuilds `concept_vectors` from `concepts.embedding` with a `namespace` partition key and `distance_metric=cosine`, and adds the `concepts.derived` column. |
| Postgres | Under an advisory lock: adds `concepts.derived`, drops `idx_concept_vectors_embedding` (IVFFlat, L2) and creates `idx_concept_vectors_embedding_cosine` (HNSW, `vector_cosine_ops`). Re-indexes rows whose vector was missing and records `schema_version = 3` in `metadata`. |

On both backends, stored embeddings that could never be searched are set to `NULL`: wrong byte length (left by a failed, non-atomic 2.x save), non-finite, or all zero. The concept keeps its markdown and thoughtform. Re-embed it with `convert_concept { from: "markdown", to: "vector" }`, or re-save it.

## Tool callers (MCP clients, agents, AgentVault)

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
- Sizes are capped (see the README's Tools Reference). Namespaces must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. Rename any namespace containing spaces, commas or other characters before upgrading.

### Namespaces

- Pass `namespace` to `read_concept`, `delete_concept`, `convert_concept`, `vault_memory_push` and `vault_archive_concept` when the concept is not in `"default"`. Otherwise the call returns `NOT_FOUND`.
- Pass the concept's `namespace` when updating it with `save_concept`. An update through a different namespace (including an omitted one, which means `"default"`) returns `NAMESPACE_DENIED`. Concepts cannot move between namespaces; to move one, create it in the new namespace and delete the old one.
- `crossNamespace: true` now requires the operator to set `POLYTICIAN_NAMESPACES` (a comma-separated list, or `*` for all namespaces), and it searches only those namespaces.
- `get_stats` and `health_check` without `namespace` report `"default"` only, as their descriptions always said; call them per namespace for other counts.

### Concurrency

`expectedVersion` now really rejects stale writes. Expect `VERSION_CONFLICT` (with `currentVersion`) where 2.x silently let the last writer win, and handle it by re-reading and retrying.

### Auto-embedding

`save_concept` and `batch_save_concepts` now compute the vector from the text when you do not pass `embedding`. That makes `save → search` work without a separate `convert_concept markdown → vector`, which you can drop. If you manage vectors yourself and do not want them computed, pass `autoEmbed: false`. A vector you supply yourself is never replaced by auto-embedding.

### Conversions

- `convert_concept` refuses (`OVERWRITE_REFUSED`) to replace a representation that a caller wrote. Pass `overwrite: true` to replace it. Representations produced by an earlier conversion or by auto-embedding can be re-derived without it. `read_concept` shows which representations are derived in `derived`.
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

### Error bodies

Service errors are returned as `{ "error": "...", "code": "..." }` (with `isError: true`). Branch on `code` (`NOT_FOUND`, `VALIDATION_ERROR`, `VERSION_CONFLICT`, `NAMESPACE_DENIED`, `OVERWRITE_REFUSED`, `CONVERSION_ERROR`), not on message text.

## Operators

- Remove `POLYTICIAN_ASYNC_INDEX_SYNC` / `distributed.asyncIndexSync`; it no longer exists. Writes update the row and its vector in one transaction, so nothing needs syncing.
- **Move your config file.** `.polytician.json` in the working directory and `~/.polytician.json` are no longer read. Move the file to `~/.polytician/config.json`, or start the server with `--config /path/to/file.json`. Check it is valid JSON: an unparseable file now stops the server.
- **`${VAR}` in config values** may only name `POLYTICIAN_*` variables. Rename, for example `"apiToken": "${AV_TOKEN}"` → `"${POLYTICIAN_AV_TOKEN}"` and export that variable. Do not put `${...}` in `POLYTICIAN_AV_API_TOKEN`; it is used literally.
- **AgentVault over `https`.** Change an `http://` `apiBaseUrl` / `POLYTICIAN_AV_API_URL` to `https://` (plain `http` works only for localhost).
- **LLM provider.** Remove `POLYTICIAN_LLM_MODEL`, `POLYTICIAN_LLM_API_KEY`, `llm.model`, `llm.apiKey` and `agentVault.secrets` (none of them did anything). If you set `POLYTICIAN_LLM_PROVIDER` to `anthropic`, `openai` or `sampling`, the server now refuses to start: those providers never existed, so remove the setting (or set `agentvault`). **If you relied on AgentVault inference running without `POLYTICIAN_LLM_PROVIDER`,** set `POLYTICIAN_LLM_PROVIDER=agentvault`; without it, `vector → *` and `markdown → thoughtform` (without the rule-based pipeline) fail with `CONVERSION_ERROR`.
- **Arweave archival.** If `agentVault.archival.enabled` is true, add a non-empty `archival.tagFilter` (only concepts carrying every listed tag are archived) and a backup key (see "Backups and encryption"); without both the server refuses to start. Archives are now encrypted: keep the backup key, since `openArchive()` needs it to read them. Tags and namespace are no longer uploaded as public Arweave tags.
- **AgentVault retries.** Commits, tombstones and uploads are no longer retried. If a sync push fails transiently, it is logged and the next update of that concept pushes it again; run `agentvault-sync sync --direction push` to push everything.
- Decide on `POLYTICIAN_NAMESPACES`. Leave it unset for a single-user server, set it to the list of namespaces a server should expose, or set `*` to allow every namespace and enable `crossNamespace` search. The allowlist does not authenticate callers; see "Namespaces" in the README.

### Backups and encryption

- **Make a fresh backup after upgrading.** The 3.0 format (JSONL, `formatVersion: 1`) is different from every 2.x backup file, and 3.0 does not read 2.x files. Your data itself is migrated in place, so the simplest path is: copy the 2.x database, upgrade, start once, then `export_backup` (or `agentvault-sync backup`).
- **Auto-backup is now off.** If you relied on the 2.x default (every 50 saves), set `POLYTICIAN_BACKUP_THRESHOLD=50`, and `POLYTICIAN_BACKUP_RETAIN` if you want to keep more than 10. The old `backup-*.json` files in `<dataDir>/backups` are not touched or pruned; delete them when you no longer need them (they are plaintext and were created world-readable).
- **If you set `POLYTICIAN_ENCRYPT` or `--encrypt`,** your 2.x backups were not encrypted. Create a key before upgrading, or every backup will fail with `CONFIG_ERROR`:

  ```bash
  openssl rand -base64 32 > ~/.polytician/backup.key && chmod 600 ~/.polytician/backup.key
  ```

  (or set `POLYTICIAN_BACKUP_KEY`). Store a copy of the key somewhere other than this machine. An encrypted backup cannot be restored without it.
- **`agentvault-sync backup`** now writes every namespace by default (pass `--namespace` for one) in JSONL, to `<dataDir>/backups` unless you pass `--out`. Scripts that parsed the 2.x JSON output need updating. `restore` keeps newer local copies unless `--on-conflict overwrite`.
- The SQLite database file is set to mode `600` on start. If another local user or group needs to read it, grant that explicitly.

## Library users (`ConceptService`, `DatabaseAdapter`)

- `ConceptService.search()` returns `{ id, namespace, score, tags, representations }`. The option `{ crossNamespace: true }` is now `{ namespaces: '*' }`; `{ namespaces: ['a', 'b'] }` searches several namespaces.
- `read(id, reps, { namespace })` and `delete(id, { namespace })` check the namespace when given. Omitting it keeps the unchecked, trusted behaviour for in-process callers.
- `save()` accepts `autoEmbed` (default `false` at the service level), `derived` and `overwrite`, and throws `ValidationError`, `NamespaceDeniedError` and `OverwriteRefusedError` in addition to `VersionConflictError`. `saveBatch(entries, { autoEmbed, batchSize })` is atomic.
- Custom `DatabaseAdapter` implementations must add `applyWrites(writes)`, which applies inserts, conditional updates (`WHERE version = expectedVersion`) and deletes atomically, keeping the vector index in step. They must also accept `vectorSearch(query, k, { namespaces, tags })` with the filters applied inside the KNN query and `distance` as cosine distance, and `upsertVector(id, namespace, embedding)`.
- `IndexSyncService` only keeps `rebuildAfterDeserialize()`; `start()`, `stop()`, `waitForPending()` and `pendingCount` were removed.
- `SummarizeOptions.neighborDistances` is now `neighborScores`, with the same `[0, 1]` scores as search.
- `encryptBundle` and `decryptBundle` (`src/storage/thoughtform.ts`) were removed; they returned their input unchanged. Backup encryption lives in `src/backup/format.ts`.
- `BackupService.runBackup()` writes the JSONL format and returns the file path; `exportBackup`, `importBackup` and `importBackupBytes` in `src/services/backup.service.ts` are the export/import entry points.
- **PolyVault (experimental, library only).** Producers must set `metadata.contentHash` to `computeContentHash(tf)` (or pass ThoughtForms through `withContentHash()`) before `runBackup`; other hashes are rejected. Drop `decryptionNonce` from `runRestore` options. Encrypted commits written by 2.x cannot be restored by any version (their nonce was never stored). Call `rebase()` / `runRebase()` with remote commits and a `lastApplied` cursor; a 2.x rebase state file is read as "nothing applied yet", so the first 3.0 rebase merges every remote commit again, which the conflict policy makes safe.
