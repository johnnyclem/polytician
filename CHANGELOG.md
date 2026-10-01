# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [3.0.0] - Unreleased

Upgrade notes for every breaking change are in [MIGRATION.md](MIGRATION.md).

### Breaking

- **`search_concepts` returns `score`, not `distance`.** `score = (1 + cosine similarity) / 2`, in `[0, 1]`, higher is better. Results are ordered by score, and ties by id. The L2 `distance` field is gone. Both backends now rank by cosine distance: sqlite-vec with `distance_metric=cosine`, pgvector with `<=>`.
- **Strict tool input schemas.** Every tool rejects unknown arguments with a validation error instead of silently dropping them. In 2.x an AgentVault enricher call such as `{ content, metadata }` was stored as an empty concept.
- **A new concept needs at least one representation.** `save_concept` (and the service) reject a create without `markdown`, `thoughtform` or `embedding` with `VALIDATION_ERROR`.
- **`thoughtform` is validated.** It must be the native ThoughtForm shape or a PolyVault v1 ThoughtForm; free-form JSON is rejected. It was `z.any()`, and conversions then crashed with `TypeError`.
- **Embeddings are validated.** Exactly 384 components, all finite and float32-representable, and not all zero. Wrong-dimension vectors used to leave a persisted concept with a corrupt embedding.
- **Input size caps** on every tool: markdown ≤ 1,000,000 characters, thoughtform ≤ 2,000,000 characters of JSON, ≤ 64 tags of ≤ 128 characters, ≤ 500 concepts per batch, query/`embed_text` text ≤ 100,000 characters. Namespaces must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`.
- **`expectedVersion` is enforced atomically.** It is checked in the same `UPDATE ... WHERE version = ?` that writes, so of two concurrent writers holding the same version exactly one succeeds and the other gets `VERSION_CONFLICT`. In 2.x both were told they won and one edit was lost. Two concurrent creates of one id now become a create plus an update instead of a raw `UNIQUE` error.
- **Namespaces are enforced on id-based tools.** `read_concept`, `delete_concept`, `convert_concept`, `vault_memory_push` and `vault_archive_concept` take `namespace` (default `"default"`), and a concept in another namespace is `NOT_FOUND`. `save_concept` and `vault_restore` refuse to update a concept that lives in another namespace (`NAMESPACE_DENIED`). `vault_memory_pull` writes into one namespace and reports entries it had to skip.
- **`crossNamespace` search requires operator opt-in.** It is refused (`NAMESPACE_DENIED`) unless `POLYTICIAN_NAMESPACES` is set, and then spans exactly the allowlisted namespaces (all of them for `*`).
- **Conversions never overwrite authored content without `overwrite: true`.** `convert_concept` fails with `OVERWRITE_REFUSED` if the target representation was written by a caller. Replacing a previously derived representation is still allowed.
- **`vector → markdown` requires an LLM provider.** The non-LLM fallback, which pasted neighbouring concepts' text (from the `default` namespace, whatever the concept's own namespace was) into the concept's markdown, was removed. With an LLM, both `vector → *` conversions now use neighbours from the concept's own namespace only.
- **`save_concept` and `batch_save_concepts` auto-embed by default.** When no `embedding` is passed, the vector is derived from the markdown (else the thoughtform text), so saved concepts are searchable. Opt out with `autoEmbed: false`. `batch_save_concepts` previously defaulted to `false`.
- **`batch_save_concepts` is atomic.** All entries are saved, or none are. It takes `namespace` for the whole batch, and entries accept `expectedVersion`.
- **`get_stats` / `health_check` count one namespace** (default `"default"`), as documented, instead of all namespaces when `namespace` was omitted.
- **`search_concepts` requires exactly one of `query` or `vector`.**
- **Removed `POLYTICIAN_ASYNC_INDEX_SYNC`** (`distributed.asyncIndexSync`) and the event-driven vector re-sync in `IndexSyncService`. The vector is now written in the same transaction as its row. The re-sync ran outside that transaction and could re-insert the vector of a concept deleted in the meantime.
- **Postgres: HNSW cosine index.** A schema migration drops 2.x's IVFFlat (`vector_l2_ops`, `lists = 100`) index, which was built on an empty table and gave very low recall, and creates `hnsw (embedding vector_cosine_ops)`. Requires pgvector ≥ 0.5.
- **`agentvault_backup` is replaced by `export_backup`, `import_backup` and `list_backups`.** `agentvault_backup` reported success and a SHA-256 but wrote nothing anywhere, ignored `POLYTICIAN_ENCRYPT`, and covered only one namespace. `export_backup` writes a file into `<dataDir>/backups` covering every namespace the server serves, `import_backup` restores one, and `list_backups` lists them.
- **One backup format: versioned JSONL** (`polytician-backup`, format version 1), written and read by `export_backup`/`import_backup`, the auto-backup and `agentvault-sync backup`/`restore`. It carries vectors with the embedding model id, and tags, thoughtforms and provenance as JSON values, plus a footer checksum. The three 2.x formats (the `agentvault_backup` bundle, the auto-backup's `backup-*.json` with tags and thoughtforms as JSON strings and no vectors, and the CLI's JSON) are no longer read or written.
- **`vault_restore` is removed.** Its `path` argument read any file on disk and echoed the first bytes of non-JSON files in its error. Use `import_backup`, which only reads files inside `<dataDir>/backups` by name and never quotes file content in errors.
- **Encryption is real and fails closed.** `POLYTICIAN_ENCRYPT` / `--encrypt` used to be a silent no-op (every backup was plaintext). Backups are now encrypted with AES-256-GCM under a key from `POLYTICIAN_BACKUP_KEY` or an owner-only key file (`POLYTICIAN_BACKUP_KEY_FILE`, default `<dataDir>/backup.key`). With `POLYTICIAN_ENCRYPT` set, every backup writer encrypts, a plaintext export is refused, and a missing key is an error (`CONFIG_ERROR`) rather than a plaintext file; the server refuses to start without a key. The `encryptBundle`/`decryptBundle` stubs in `src/storage/thoughtform.ts` are removed.
- **Auto-backup is off by default** and keeps the newest `POLYTICIAN_BACKUP_RETAIN` (default 10) files. In 2.x it ran every 50 saves with no rotation. `POLYTICIAN_BACKUP_THRESHOLD=0` now disables it (2.x read `0` as 50), and a non-numeric value is a startup error. A burst of saves that crosses the threshold writes one backup.
- **Files are owner-only.** Backup files are mode `600` in a `700` directory, and the SQLite database file is set to mode `600` on start (a new data directory is created `700`).
- **`agentvault-sync backup`** without `--namespace` exports every namespace (2.x exported only `default` and labelled the file `all`), writes JSONL to `<dataDir>/backups` unless `--out` is given, and honours `--encrypt`. `restore` reads the new format, keeps newer local copies unless `--on-conflict overwrite`, and exits non-zero on errors. `sync` pushes every namespace when `--namespace` is omitted.
- **Config is read only from trusted places.** Environment variables, `~/.polytician/config.json`, or `--config <path>`. `.polytician.json` in the working directory (which MCP clients set to the opened project) and `~/.polytician.json` are no longer read: a cloned repository could redirect AgentVault traffic and sync memories to an attacker. A config file that exists but is invalid, and an invalid `agentVault` block, are now startup errors instead of being ignored.
- **`${VAR}` expansion is limited to `POLYTICIAN_*` variables** in config-file values (`agentVault.apiToken`, `archival.arweaveJwk`); a reference to any other variable is an error. `POLYTICIAN_AV_API_TOKEN` is used literally. In 2.x `"apiToken": "${AWS_SECRET_ACCESS_KEY}"` sent that secret as the bearer token.
- **AgentVault `apiBaseUrl` must be `https`** (plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`).
- **LLM providers `anthropic`, `openai` and `sampling` are removed** (they were never implemented), as are `POLYTICIAN_LLM_MODEL`, `POLYTICIAN_LLM_API_KEY` (`llm.model`, `llm.apiKey`) and `agentVault.secrets.llmApiKey`, whose only effect was to fill that unread key. `POLYTICIAN_LLM_PROVIDER` accepts `none` or `agentvault`; anything else is a startup error.
- **No implicit AgentVault inference.** With AgentVault configured and `llm.provider` `none`, 2.x routed every LLM conversion (with neighbouring concepts' text) to AgentVault's inference chain. It now happens only with `POLYTICIAN_LLM_PROVIDER=agentvault`.
- **Arweave archival is opt-in, filtered and encrypted.** `archival.enabled` requires a non-empty `archival.tagFilter` (an empty filter used to archive every concept) and a backup key; concepts are encrypted with that key before upload, and their tags and namespace are no longer published. `vault_archive_concept` is registered only when archival is enabled, applies the same tag filter and encryption, archives each version once, and carries `openWorldHint` annotations. In 2.x it always failed because it never loaded the wallet.
- **AgentVault requests that change state are not retried.** Memory commits, tombstones and archival uploads are sent once (a timed-out POST may still have been applied, so a retry could duplicate a permanent upload and resend the wallet). GETs and inference are still retried. Archival uploads use `archival.timeoutMs` (default 120 s) instead of the inference timeout.
- **`vault_memory_pull` is last-write-wins.** An entry replaces a local concept only when its `updatedAt` is newer, entries without `updatedAt` never replace one, entries recorded for another namespace are skipped, and ids must be UUIDs. Skipped entries are reported (`local-newer`, `other-namespace`, `invalid-id`, ...). Pulled concepts are embedded. The startup/periodic pull shares this code and writes each entry into the namespace recorded with it. `vault_memory_push` records the namespace and version with each entry.
- **PolyVault is documented as experimental and library-only** (no shipped command or tool calls it). Its library API changed:
  - Encrypted payloads are stored as `nonce || ciphertext || tag` with AAD `polyvault/1:<bundleId>:<commitId>`. `RestoreOptions.decryptionNonce` is removed; restore reads each commit's nonce from its payload. In 2.x the nonce was discarded, so no encrypted backup could ever be restored.
  - `runBackup` rejects a ThoughtForm whose `metadata.contentHash` does not equal `computeContentHash()` of its content (exit 2), and the dedupe key covers each ThoughtForm's id, `updatedAtMs` and content hash. In 2.x an edit with a stale producer hash was reported as a `duplicate` and never backed up.
  - Rebase is driven by commit order: `rebase()` takes `remoteCommits` (`{ commitId, createdAtMs, thoughtforms }`) and `lastApplied` (a commit cursor) instead of `remoteForms`, `localBaseUpdatedAtMs` and `observedRemoteMaxUpdatedAtMs`, and `runRebase` reads remote commits and stores `lastApplied` in its state file. `computeSkewSafeLowerBound` is removed. In 2.x the delta was filtered by producer timestamps, so edits from a device that synced late were silently dropped.
  - `resolveConflict` treats two ThoughtForms as identical only if their content is equal, not just their `contentHash`.
- **Node.js 22 or newer.** `engines.node` is `>=22` (Node 20 reached end of life in April 2026); CI runs Node 22 and 24, and the Docker image uses `node:22-bookworm-slim`.
- **`@xenova/transformers` is replaced by `@huggingface/transformers` 4.x.** 2.x pulled in a critical protobufjs advisory (via onnxruntime-web) and vulnerable sharp/libvips builds; `npm audit --omit=dev --audit-level=high` is now clean. The default model (`Xenova/all-MiniLM-L6-v2`, quantized `q8`) is unchanged. `POLYTICIAN_EMBEDDING_MODEL` must name a model `@huggingface/transformers` can load.
- **An embedding model must produce 384-dimensional vectors.** 2.x silently truncated a larger model's output to 384 components; 3.0 fails the embedding with an error naming both sizes.
- **Each vector records its embedding model, and search refuses to mix models.** `concepts.embedding_model` holds the configured model when the vector was written. A search over namespaces holding vectors from another model fails with `EMBEDDING_MODEL_MISMATCH` (in 2.x, changing `POLYTICIAN_EMBEDDING_MODEL` silently produced meaningless rankings); the new `reembed_concepts` tool re-derives them. Vectors from 2.x are labelled with the model configured on the first 3.0 start.
- **Library API (`ConceptService`, `DatabaseAdapter`)**: `search()` results carry `score`. `search()` options take `namespaces: string[] | '*'` instead of `crossNamespace`. `read()`/`delete()` take `{ namespace }`. `save()` takes `autoEmbed`/`derived`/`overwrite`. Adapters implement `applyWrites()`, `countForeignVectors()`, `findForeignVectors()` and `labelLegacyVectors()`, rows carry `embedding_model`, and `vectorSearch(query, k, filter)`/`upsertVector(id, namespace, embedding)` changed signature. `SummarizeOptions.neighborDistances` became `neighborScores`.

### Added

- `reembed_concepts { namespace?, overwrite?, limit? }` and `ConceptService.reembed()`: re-derive the vectors another embedding model made.
- `EMBEDDING_MODEL_MISMATCH` error code.
- `ConceptService.restore(records, { onConflict })`: writes backup records with their ids, namespaces, timestamps, vectors and provenance in one transaction.
- `CONFIG_ERROR` error code for calls that need configuration the server lacks (such as a backup key).
- `--config <path>` command-line option.
- A startup log line naming the AgentVault endpoint and which off-box paths (LLM, sync, archival) are enabled.
- `POLYTICIAN_NAMESPACES` (or `namespaces` in the config file): the operator allowlist of namespaces a server serves.
- `derived` on every concept: which representations were derived rather than authored, with provenance (`from`, and for LLM conversions `provider` and neighbour `sources`).
- `convert_concept` `overwrite` argument, and `autoEmbed` on `save_concept`.
- Stable error codes on tool errors: `NOT_FOUND`, `VALIDATION_ERROR`, `VERSION_CONFLICT` (with `currentVersion`), `NAMESPACE_DENIED`, `OVERWRITE_REFUSED`, `CONVERSION_ERROR`.
- Postgres adapter test suite (`tests/postgres-adapter.test.ts`, run with `POLYTICIAN_TEST_POSTGRES_URL`) and a CI job against `pgvector/pgvector:pg16`.

### Fixed

- A failed embedding-model load (for example the first download while offline) is retried on the next call instead of failing every embedding until restart.
- A backup can be restored: in 2.x the only persisted backups (auto-backups) stored tags and thoughtforms as JSON strings and no vectors, so a restore corrupted tags (a later tag merge produced `["[", "\"", ...]`), double-encoded thoughtforms and left nothing searchable.
- Namespace- and tag-filtered search no longer post-filters a global top-k. The filters run inside the KNN query: the vec0 namespace partition key and a candidate-id constraint on sqlite-vec, SQL `WHERE` with HNSW iterative scan (or exact scan on pgvector < 0.8) on Postgres. A crowded namespace can no longer hide another namespace's matches.
- Saving is atomic: the concept row and its vector are written in one transaction on both backends. A failed vector write no longer leaves a concept that reports a vector but is never found.
- Concurrent tag merges without `expectedVersion` no longer lose tags.
- `list_concepts` tag filtering matches tags exactly. `_` and `%` were `LIKE` wildcards, and tags containing `"` never matched.
- `convert_concept` of a PolyVault v1 thoughtform no longer crashes (`TypeError` on `toFixed`/`slice`).
- Postgres searches return up to `k` results beyond the default `hnsw.ef_search` of 40.
- Replaced the wall-clock throughput assertion in `tests/batch.test.ts`, which failed at random under load, with behavioural tests: atomicity, one transaction, one embedding per entry.

### Migration on startup

- SQLite: the `concept_vectors` vec0 table is rebuilt from `concepts.embedding` with a `namespace` partition key and cosine distance. A `derived` column is added. Stored embeddings that could never be searched (wrong length, non-finite or all zero, e.g. left behind by a failed 2.x save) are cleared.
- Postgres: the same repair, plus the IVFFlat → HNSW index change, recorded as `schema_version = 3` in `metadata`.
- Both: a `concepts.embedding_model` column (with a partial index on `(namespace, embedding_model)`) is added, and existing vectors are labelled once with the configured embedding model (recorded as `legacy_vectors_labelled` in `metadata`).
