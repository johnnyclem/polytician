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
- **Library API (`ConceptService`, `DatabaseAdapter`)**: `search()` results carry `score`. `search()` options take `namespaces: string[] | '*'` instead of `crossNamespace`. `read()`/`delete()` take `{ namespace }`. `save()` takes `autoEmbed`/`derived`/`overwrite`. Adapters implement `applyWrites()`, and `vectorSearch(query, k, filter)`/`upsertVector(id, namespace, embedding)` changed signature. `SummarizeOptions.neighborDistances` became `neighborScores`.

### Added

- `POLYTICIAN_NAMESPACES` (or `namespaces` in the config file): the operator allowlist of namespaces a server serves.
- `derived` on every concept: which representations were derived rather than authored, with provenance (`from`, and for LLM conversions `provider` and neighbour `sources`).
- `convert_concept` `overwrite` argument, and `autoEmbed` on `save_concept`.
- Stable error codes on tool errors: `NOT_FOUND`, `VALIDATION_ERROR`, `VERSION_CONFLICT` (with `currentVersion`), `NAMESPACE_DENIED`, `OVERWRITE_REFUSED`, `CONVERSION_ERROR`.
- Postgres adapter test suite (`tests/postgres-adapter.test.ts`, run with `POLYTICIAN_TEST_POSTGRES_URL`) and a CI job against `pgvector/pgvector:pg16`.

### Fixed

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
