# Polytician

[![CI](https://github.com/johnnyclem/polytician/actions/workflows/ci.yml/badge.svg)](https://github.com/johnnyclem/polytician/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/polytician.svg)](https://www.npmjs.com/package/polytician)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#requirements)

**Local-first semantic memory for AI agents.** Polytician is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Desktop (or any MCP client) a persistent, searchable memory: every concept can be stored — and freely converted between — a **384-dim vector**, human-readable **markdown**, and structured **ThoughtForm** JSON.

Everything runs on your machine. Embeddings are generated in-process; there's no external API call on the hot path unless you explicitly wire one in for LLM-assisted conversions.

---

## Why Polytician

- 🧠 **One concept, three shapes** — save once, read back as a vector, markdown, or structured JSON, and convert between them on demand via a single `convert_concept` tool
- 🔍 **Semantic search** — cosine similarity search over `sqlite-vec` (default) or Postgres/`pgvector`. Namespace and tag filters run inside the vector query, so a filtered top-k is the top-k of the matching concepts. Saved text is embedded automatically, so `save_concept` → `search_concepts` works without a manual conversion
- 🔒 **Local-first embeddings** — `@xenova/transformers` runs `all-MiniLM-L6-v2` in-process (384 dimensions); no network round-trip, no API key required
- 🗂️ **Namespaces + optimistic concurrency** — every tool call is scoped to a namespace, and an operator allowlist (`POLYTICIAN_NAMESPACES`) limits which ones a server serves (see [Namespaces](#namespaces) for exactly what that does and does not isolate). `expectedVersion` is checked in the same statement that writes, so of two concurrent writers holding the same version exactly one succeeds
- 🔌 **Pluggable LLM + NLP** — bring your own provider (Anthropic, OpenAI, MCP sampling, or [AgentVault](#agentvault-integration)) for the conversions that need one (`markdown→thoughtform`, `vector→markdown`, `vector→thoughtform`)
- 🧳 **Portable backups** — `export_backup` / `import_backup` write and restore every namespace (vectors, tags, thoughtforms and provenance included) as one versioned JSONL file, optionally AES-256-GCM encrypted, with a checksum that detects truncation and edits
- 🚀 **Deploys anywhere** — a single Node process (SQLite by default), with first-class Docker Compose and Kubernetes manifests for a distributed, Postgres-backed, multi-node setup

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                     MCP Server (TypeScript, stdio)                │
│                    @modelcontextprotocol/sdk                      │
├───────────────────────────────────────────────────────────────────┤
│ Tools: save/read/delete/list/batch/search/convert/embed/          │
│        health_check/get_stats/export|import|list_backups          │
│        + vault_* (optional, AgentVault)                           │
├───────────────────────────────────────────────────────────────────┤
│ Embeddings: @xenova/transformers (all-MiniLM-L6-v2, 384-dim,      │
│             in-process — no external call)                        │
├───────────────────────────────────────────────────────────────────┤
│ Storage: better-sqlite3 + sqlite-vec (WAL mode, default)          │
│          — or Postgres + pgvector via POLYTICIAN_DB_BACKEND       │
├───────────────────────────────────────────────────────────────────┤
│ HTTP: GET /health on POLYTICIAN_HEALTH_PORT (default 8787)        │
└──────────────────────────────┬────────────────────────────────────┘
                                │ HTTP (optional, best-effort)
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│              Python Sidecar (Flask, optional helper)               │
├───────────────────────────────────────────────────────────────────┤
│ • FAISS index rebuild after a PolyVault bundle restore             │
│ • PolyVault bundle serialize/deserialize endpoints                 │
└───────────────────────────────────────────────────────────────────┘
```

The Node server is fully self-contained for everyday use — save, read, search, and non-LLM conversions all work with nothing but `npm start`. The Python sidecar is an optional helper for FAISS index rebuilds and PolyVault bundle operations; it is **not** required and is never auto-spawned by the server. If `POLYTICIAN_SIDECAR_URL` is unset, those code paths simply skip and log rather than fail.

---

## Table of Contents

- [Why Polytician](#why-polytician)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Claude Desktop Integration](#claude-desktop-integration)
- [Configuration](#configuration)
- [Tools Reference](#tools-reference)
- [Concepts](#concepts)
- [Deployment](#deployment)
  - [Docker Compose](#docker-compose)
  - [Kubernetes](#kubernetes)
  - [systemd / PM2](#systemd--pm2)
- [Postgres / pgvector Backend](#postgres--pgvector-backend)
- [Backup, Restore & Encryption](#backup-restore--encryption)
- [AgentVault Integration](#agentvault-integration)
- [Health Checks & Troubleshooting](#health-checks--troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Requirements

| Software | Version |
|----------|---------|
| **Node.js** | >= 20.0.0 |
| **npm** | >= 10.0.0 |

Python 3.10+ is only needed if you run the optional [Python sidecar](#docker-compose) (FAISS rebuild / PolyVault bundle ops). It is not required for normal operation.

---

## Quick Start

```bash
git clone https://github.com/johnnyclem/polytician.git
cd polytician
npm install
npm run build
npm start
```

The server speaks MCP over **stdio** and starts an HTTP health endpoint on `:8787`. On first use it downloads the `all-MiniLM-L6-v2` embedding model (~30 MB) into `~/.polytician/models`; after that it runs fully offline.

For local development with hot-reload:

```bash
npm run dev   # runs src/index.ts directly via tsx, restarts on change
```

---

## Claude Desktop Integration

Add to your Claude Desktop config:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "polytician": {
      "command": "node",
      "args": ["/absolute/path/to/polytician/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop and look for "polytician" in the MCP servers list.

---

## Configuration

Polytician is configured entirely through environment variables (or a `.polytician.json` file in the project root or home directory — env vars win). Everything has a sensible default; you don't need to set anything to get started.

| Variable | Default | Description |
|----------|---------|--------------|
| `POLYTICIAN_DATA_DIR` | `~/.polytician` | Root directory for the SQLite DB and cached embedding model |
| `POLYTICIAN_HEALTH_PORT` | `8787` | Port for the `GET /health` HTTP endpoint |
| `POLYTICIAN_DB_BACKEND` | `sqlite` | `sqlite` or `postgres` — see [Postgres backend](#postgres--pgvector-backend) |
| `POLYTICIAN_POSTGRES_URL` | — | Connection string, required when `POLYTICIAN_DB_BACKEND=postgres` |
| `POLYTICIAN_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Any `@xenova/transformers`-compatible feature-extraction model |
| `POLYTICIAN_SIDECAR_URL` | — | Base URL of the [Python sidecar](#docker-compose), if running one |
| `POLYTICIAN_LLM_PROVIDER` | `none` | `anthropic`, `openai`, `sampling`, `agentvault`, or `none` — required for LLM-assisted conversions |
| `POLYTICIAN_LLM_MODEL` / `POLYTICIAN_LLM_API_KEY` | — | Provider-specific model name / key |
| `POLYTICIAN_NLP_PIPELINE` | `none` | `rule-based`, `llm`, or `none` — used by `markdown→thoughtform` |
| `POLYTICIAN_NAMESPACES` | unset | Namespaces tool calls may address: a comma-separated list, or `*` for any. Unset allows any namespace but refuses `crossNamespace` search. See [Namespaces](#namespaces) |
| `POLYTICIAN_NODE_ID` | random | Identifies this node in a distributed/multi-node deployment |
| `POLYTICIAN_ENCRYPT` | `false` | Require every backup file to be encrypted (AES-256-GCM); fails closed without a key. `--encrypt` does the same. See [Backup, Restore & Encryption](#backup-restore--encryption) |
| `POLYTICIAN_BACKUP_KEY` / `POLYTICIAN_BACKUP_KEY_FILE` | — / `<dataDir>/backup.key` | The 256-bit backup key (base64 or hex), or a file holding it (must be mode `600`) |
| `POLYTICIAN_BACKUP_THRESHOLD` | `0` (off) | Write an auto-backup after this many saves |
| `POLYTICIAN_BACKUP_RETAIN` | `10` | Auto-backups to keep; older ones are deleted |
| `POLYTICIAN_AV_API_URL` / `POLYTICIAN_AV_API_TOKEN` | — | Enable the [AgentVault integration](#agentvault-integration) and its `vault_*` tools |

---

## Tools Reference

All tools return `{ "content": [{ "type": "text", "text": "<JSON>" }] }`; the examples below show the decoded JSON payload for brevity. Authoritative schemas live in `src/server.ts`.

Every tool's input schema is strict: an unknown argument is a validation error, not silently dropped. Every tool that takes a `namespace` defaults it to `"default"`. Errors from the service come back with `isError: true` and a JSON body `{ "error", "code" }`, where `code` is one of `NOT_FOUND`, `VALIDATION_ERROR`, `VERSION_CONFLICT` (plus `currentVersion`), `NAMESPACE_DENIED`, `OVERWRITE_REFUSED`, `CONVERSION_ERROR` or `CONFIG_ERROR` (the server is missing configuration the call needs, such as a backup key).

Input caps: markdown ≤ 1,000,000 characters, thoughtform ≤ 2,000,000 characters of JSON, ≤ 64 tags of ≤ 128 characters, ≤ 500 concepts per batch, query/`embed_text` text ≤ 100,000 characters. Namespaces match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. Embeddings must have exactly 384 finite components and must not be all zero.

### `save_concept`

Create or update a concept. A new concept needs at least one representation (`markdown`, `thoughtform` or `embedding`). Tags merge on update.

```json
// Request
{
  "markdown": "Albert Einstein developed the theory of relativity.",
  "tags": ["physics", "history"]
}
// Response
{ "id": "...", "namespace": "default", "version": 1, "tags": ["physics", "history"], "derived": { "vector": { "from": "markdown" } }, ... }
```

- **Auto-embedding** (`autoEmbed`, default `true`): when no `embedding` is passed, the vector is computed from the markdown written (or, for a thoughtform-only concept, its `rawText`), so the concept is immediately searchable. It never replaces a vector you supplied yourself; pass `autoEmbed: false` to skip it.
- **Concurrency**: pass `expectedVersion` and the write applies only if the stored version still matches, checked in the same `UPDATE` that writes. Otherwise it fails with `VERSION_CONFLICT` and `currentVersion`. Writes without `expectedVersion` never lose a concurrent writer's changes either: the tag merge is re-applied on top of the newer version.
- **Namespaces**: an update must name the namespace the concept lives in (`NAMESPACE_DENIED` otherwise). Concepts cannot move between namespaces.
- **Atomicity**: the concept row and its vector are written in one transaction.
- **`thoughtform`** must be either the native shape (`rawText`, ISO-timestamp `metadata`, `entities` with `text`/`type`/`confidence`/`offset`) or a PolyVault v1 ThoughtForm (`schemaVersion`, epoch-ms `metadata`, `entities` with `value`). Free-form JSON is rejected.

### `read_concept`

`{ "id": "...", "namespace"?, "representations"?: ["vector"|"markdown"|"thoughtform"] }` → the concept, optionally filtered to the requested representations. `derived` lists the representations that were derived rather than written by a caller, with their provenance (`from`, and `provider`/`sources` for LLM conversions). A concept in another namespace is `NOT_FOUND`.

### `delete_concept`

`{ "id": "...", "namespace"? }` → `{ "deleted": "..." }`. Deletes the row and its vector together; a concept in another namespace is `NOT_FOUND`.

### `list_concepts`

`{ "namespace"?, "limit"? (≤100, default 50), "offset"?, "tags"? }` → paginated concepts in the namespace carrying every listed tag (exact match), with a `representations` flag per concept (`vector: false` means it is not searchable).

### `batch_save_concepts`

`{ "concepts": [{ "id"?, "expectedVersion"?, "markdown"?, "thoughtform"?, "embedding"?, "tags"? }, ...], "namespace"?, "autoEmbed"?, "batchSize"? }` → `{ "count", "ids": [...] }`. The batch is atomic: every entry is validated (and embedded, once, in batches of `batchSize`, default 50) before anything is written, and then all entries are written in one transaction or none are. `autoEmbed` defaults to `true`, as in `save_concept`.

### `search_concepts`

Semantic similarity search. Provide exactly one of `query` (auto-embedded) or a raw `vector`.

```json
// Request
{ "query": "famous physicists", "k": 5, "namespace": "default", "tags"?: ["history"] }
// Response
[{ "id": "...", "namespace": "default", "score": 0.83, "tags": ["physics", "history"], "representations": { ... } }]
```

- `score` is `(1 + cosine similarity) / 2`, in `[0, 1]` (1 = same direction as the query, 0.5 = orthogonal). Results are ordered by score, and equal scores by id.
- The namespace and `tags` (every tag, exact match) filters run inside the vector query. With sqlite-vec the namespace is the vec0 partition key and tags restrict the candidate ids. With pgvector they are SQL `WHERE` clauses on an HNSW iterative scan (pgvector ≥ 0.8) or an exact scan (older pgvector). So the top-k is the top-k of the matching concepts, not a filtered global top-k.
- On sqlite-vec the search is exact (brute-force KNN). On pgvector it is an HNSW approximate search, so recall is high but not guaranteed.
- `crossNamespace: true` searches every namespace in `POLYTICIAN_NAMESPACES` (all of them if it is `*`). It fails with `NAMESPACE_DENIED` when the operator has not set `POLYTICIAN_NAMESPACES`.

### `convert_concept`

`{ "id": "...", "namespace"?, "from": "vector"|"markdown"|"thoughtform", "to": "vector"|"markdown"|"thoughtform", "overwrite"? }` → `{ "converted": { "from", "to" }, "concept": {...} }`

The result is stored as a **derived** representation (see `derived` in `read_concept`). A conversion never replaces an **authored** representation (one a caller wrote) unless `overwrite: true`; otherwise it fails with `OVERWRITE_REFUSED`. Replacing an earlier derived one is allowed. The write is conditional on the version the source was read at, so a concurrent edit of the source surfaces as `VERSION_CONFLICT`.

| Conversion | Requires an LLM? |
|---|---|
| `thoughtform → vector`, `thoughtform → markdown`, `markdown → vector` | No. `markdown → vector` and `thoughtform → vector` depend on the embedding model; `thoughtform → markdown` is a fixed template |
| `markdown → thoughtform` | Yes: set `POLYTICIAN_LLM_PROVIDER`, or `POLYTICIAN_NLP_PIPELINE=rule-based` |
| `vector → markdown`, `vector → thoughtform` | Yes: set `POLYTICIAN_LLM_PROVIDER`. The LLM is given the concept's nearest neighbours **from its own namespace**, and their ids are recorded in `derived.<rep>.sources`. There is no non-LLM path, because a vector cannot be decoded back into text |

### `embed_text`

`{ "text": "..." }` → `{ "dimension": 384, "embedding": [...] }`. Embeds arbitrary text without persisting a concept.

### `health_check` / `get_stats`

`{ "namespace"? }` → server + embedding model + LLM provider status, and concept/representation counts for that namespace (default `"default"`).

### `export_backup` / `import_backup` / `list_backups`

- `export_backup { namespace?, encrypt? }` writes a backup file into `<dataDir>/backups` (mode `600`) covering every namespace the server serves, or just `namespace`, and returns `{ file, path, backupId, createdAt, conceptCount, namespaces: { <ns>: <count> }, sizeBytes, sha256, encrypted, keyId }`.
- `import_backup { file, namespace?, onConflict?, reembed? }` restores a backup named by its file name in that directory (paths are refused). It returns `{ inserted, updated, skipped: [{ id, namespace, reason }], reembedded, vectorsDropped, ... }`. `onConflict` is `"newer"` (default: an existing concept is replaced only if the backup copy was updated later), `"overwrite"` or `"skip"`.
- `list_backups {}` lists the backups in that directory, newest first, from their headers.

See [Backup, Restore & Encryption](#backup-restore--encryption).

### AgentVault-only tools (`vault_*`)

Registered only when `POLYTICIAN_AV_API_URL` / `POLYTICIAN_AV_API_TOKEN` are set:

| Tool | Purpose |
|---|---|
| `vault_infer` | Run a prompt through AgentVault's inference fallback chain (Bittensor → Venice → local), optionally saving the result as a concept |
| `vault_memory_push` | Push a concept's markdown/thoughtform to AgentVault's `memory_repo` canister |
| `vault_memory_pull` | Pull `concepts/*/markdown` entries from a `memory_repo` branch into local concepts |
| `vault_archive_concept` | Permanently archive a concept to Arweave, returning a transaction ID/URL |
| `vault_get_secret` | Fetch secret **metadata** (name, provider, rotation date, length) — never the raw value |
| `vault_memory_repo_log` | Inspect the `memory_repo` branch head and entry state |

---

## Concepts

A **concept** is the unit of memory. Any subset of its three representations can exist at once:

| Representation | Type | Best for |
|---|---|---|
| **Vector** | `float[384]` | Semantic search, similarity matching |
| **Markdown** | `string` | Human-readable display |
| **ThoughtForm** | JSON object | Structured entities, relationships, a context graph |

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "namespace": "default",
  "version": 3,
  "tags": ["physics", "history"],
  "markdown": "Albert Einstein developed the theory of relativity...",
  "thoughtform": {
    "rawText": "Albert Einstein developed the theory of relativity...",
    "entities": [{ "id": "ent_0", "text": "Albert Einstein", "type": "PERSON" }],
    "relationships": [],
    "contextGraph": {}
  },
  "embedding": [0.0234, -0.0891, "...384 floats total"]
}
```

`convert_concept` moves between these on demand: without an LLM for the vector/markdown/thoughtform-derived paths, and via your configured LLM or NLP pipeline for the paths that need to *generate* rather than *derive* content.

### Namespaces

A namespace scopes every tool call. `save_concept`, `read_concept`, `delete_concept`, `convert_concept`, `list_concepts`, `search_concepts`, `get_stats` and the `vault_*` tools all take `namespace` (default `"default"`). A concept is only visible through its own namespace: reading, deleting or converting it through another namespace is `NOT_FOUND`, and writing to it is `NAMESPACE_DENIED`.

`POLYTICIAN_NAMESPACES` is the operator's allowlist. When it is set to a list, calls naming any other namespace (including the implicit `"default"`) are `NAMESPACE_DENIED`, and `crossNamespace` search spans exactly the list. `*` allows every namespace and lets `crossNamespace` span them all. Unset allows every namespace and refuses `crossNamespace`.

**Boundary:** the namespace is chosen by the caller. Polytician does not authenticate callers, so the allowlist bounds which namespaces a server exposes, but it does not stop one client of that server from naming another client's namespace. To isolate agents from each other, give each one its own server process with its own `POLYTICIAN_NAMESPACES`, or put a policy layer in front of the tools (for example an OpenAPPA battery keyed on the `namespace` argument).

---

## Deployment

### Docker Compose

```bash
docker-compose up -d
```

`docker-compose.yml` provisions a full distributed reference setup: a `pgvector/pgvector` Postgres instance, two Polytician nodes (`polytician-1` / `polytician-2`, each with a distinct `POLYTICIAN_NODE_ID`) sharing that database, and a `sidecar` service built from `python-sidecar/` for FAISS rebuilds. For a single-node SQLite setup, run just the `polytician-1` service with `POLYTICIAN_DB_BACKEND=sqlite`.

### Kubernetes

Manifests live in [`k8s/`](k8s/):

```bash
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/postgres.yml
kubectl apply -f k8s/polytician.yml
kubectl apply -f k8s/sidecar.yml
```

`k8s/polytician.yml` deploys 3 replicas behind a `ClusterIP` service on port 8787 — pair with `POLYTICIAN_DB_BACKEND=postgres` so the replicas share one store (each write updates the row and its vector in one transaction, so there is no separate index sync to run).

### systemd / PM2

The build is a single `node dist/index.js` process reading stdio, so any standard Node process manager works — see `Dockerfile` for the exact runtime invocation to mirror in a unit file or `ecosystem.config.js`.

---

## Postgres / pgvector Backend

Set `POLYTICIAN_DB_BACKEND=postgres` and `POLYTICIAN_POSTGRES_URL` to point at a Postgres instance with the `vector` extension available (the `pgvector/pgvector` Docker image is the easiest path). The adapter (`src/db/postgres-adapter.ts`) runs `CREATE EXTENSION IF NOT EXISTS vector`, creates its tables and applies its schema migrations on startup, under an advisory lock so several nodes can start at once. There is no separate migration step to run first. This backend is what backs the multi-node / distributed deployments in `docker-compose.yml` and `k8s/`.

Vectors are indexed with HNSW over cosine distance (`vector_cosine_ops`), which needs pgvector ≥ 0.5. Use pgvector ≥ 0.8 if you can: filtered searches (every search is filtered by namespace) then use HNSW iterative scans. On older pgvector they fall back to an exact scan, which returns correct results but costs a scan of the matching rows.

Run the adapter's tests against a disposable database with `POLYTICIAN_TEST_POSTGRES_URL=postgres://... npx vitest run tests/postgres-adapter.test.ts`. They are skipped when the variable is unset.

---

## Backup, Restore & Encryption

Backups are files in `<dataDir>/backups` (`~/.polytician/backups` by default; the directory is mode `700` and each file mode `600`). The `export_backup`, `import_backup` and `list_backups` tools, the auto-backup and the `agentvault-sync` CLI all read and write the same format:

- **Format:** JSONL, versioned (`"format": "polytician-backup", "formatVersion": 1`). Line 1 is a header (backup id, creation time, the embedding model id and dimension, and the encryption parameters), then one line per concept (id, namespace, version, timestamps, tags, markdown, thoughtform, embedding and provenance, all as JSON values), then a footer with per-namespace counts and a SHA-256 over the header and concept lines. The reference is [`src/backup/format.ts`](src/backup/format.ts).
- **Scope:** every namespace unless one is named (`export_backup` covers the namespaces the server serves under `POLYTICIAN_NAMESPACES`).
- **Restore:** `import_backup` verifies the file (checksum, counts, and the AES-GCM tag when encrypted) and validates every concept before writing anything, then writes all of them in one transaction with their original ids, namespaces, timestamps, tags, vectors and provenance. It never writes into a concept that lives in another namespace. If the backup's embedding model differs from the server's, it refuses unless `reembed: true`, which derives new vectors from each concept's text.
- **Encryption:** `export_backup { encrypt: true }`, `agentvault-sync backup --encrypt`, or `POLYTICIAN_ENCRYPT=true` (which makes every backup writer, including auto-backup, encrypt and refuse plaintext) encrypt the concept lines with AES-256-GCM. The random 96-bit nonce, the AAD (which binds the body to the header's backup id) and the key's fingerprint are stored in the header. The key is `POLYTICIAN_BACKUP_KEY` or the key file (`POLYTICIAN_BACKUP_KEY_FILE`, default `<dataDir>/backup.key`, mode `600`). Polytician never generates a key: if encryption is requested and no key is configured, the export fails instead of writing plaintext. Create one with `openssl rand -base64 32 > ~/.polytician/backup.key && chmod 600 ~/.polytician/backup.key`, and **keep a copy off the machine**, because an encrypted backup cannot be restored without it. Importing with the wrong key fails with an error naming both key fingerprints.
- **Integrity boundary:** the footer checksum detects truncation and accidental edits, and the GCM tag detects any change to an encrypted body. Neither is a signature: anyone who holds the file (and, for encrypted files, the key) can write a backup that verifies.
- **Auto-backup** is off by default. Set `POLYTICIAN_BACKUP_THRESHOLD=N` to write a full backup after every N saves (a burst of saves, such as a batch or an import, triggers one backup), keeping the newest `POLYTICIAN_BACKUP_RETAIN` (default 10).

The CLI runs the same export and import outside an MCP client. As an operator tool it accepts any `--out` / `--file` path:

```bash
npx tsx bin/agentvault-sync.ts backup  [--out backup.jsonl] [--namespace work] [--encrypt]
npx tsx bin/agentvault-sync.ts restore --file backup.jsonl [--on-conflict newer|overwrite|skip] [--reembed]
npx tsx bin/agentvault-sync.ts sync    --direction bidirectional
```

PolyVault (`src/polyvault/`, `src/commands/polyvault/`) is a separate, chunked backup format for an Internet Computer canister; see [`docs/polyvault/spec-v1.md`](docs/polyvault/spec-v1.md).

---

## AgentVault Integration

Polytician doubles as a semantic-memory source, on-chain backup target, and inference/secrets provider for [AgentVault](https://github.com/johnnyclem/agentvault)'s orchestrator, via the `vault_*` tools above. See:

- [`AGENTVAULT_COMPATIBILITY_PRD.md`](AGENTVAULT_COMPATIBILITY_PRD.md) — the spec for AgentVault's side of this integration
- [`docs/polyvault/spec-v1.md`](docs/polyvault/spec-v1.md) — the encrypted backup/restore bridge (PolyVault)
- [`docs/ecosystem/executive-summary.md`](docs/ecosystem/executive-summary.md) and [`docs/ecosystem/engineering-guide.md`](docs/ecosystem/engineering-guide.md) — cross-repo ecosystem evaluation, including what's actually shipped vs. still aspirational on AgentVault's side

---

## Health Checks & Troubleshooting

```bash
curl http://localhost:8787/health
```

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok" },
    "vector_index": { "status": "ok" },
    "sidecar": { "status": "not_configured" }
  },
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

`sidecar: "not_configured"` is expected and harmless if you haven't set `POLYTICIAN_SIDECAR_URL` — it only affects FAISS rebuilds and PolyVault restore.

**Common issues:**

| Symptom | Fix |
|---|---|
| Slow first request | The embedding model is downloading (~30 MB) into `POLYTICIAN_DATA_DIR/models`; subsequent runs are instant |
| `Embedding dimension mismatch` | You've pointed `POLYTICIAN_EMBEDDING_MODEL` at a model that doesn't output 384-dim vectors |
| `markdown → thoughtform` / `vector → *` conversions fail | Set `POLYTICIAN_LLM_PROVIDER` (or `POLYTICIAN_NLP_PIPELINE=rule-based`) |
| `OVERWRITE_REFUSED` on convert | The target representation was written by a caller; pass `overwrite: true` to replace it |
| `NAMESPACE_DENIED` | The namespace is not in `POLYTICIAN_NAMESPACES`, `crossNamespace` was used without it, or the concept lives in another namespace |
| Postgres backend won't start | Confirm `POLYTICIAN_POSTGRES_URL` is reachable and the role can `CREATE EXTENSION vector` |
| `VERSION_CONFLICT` on save | Another writer updated the concept first — re-read it and retry with the new version |

Set `LOG_LEVEL=debug` for verbose logging.

---

## Development

```
polytician/
├── src/
│   ├── index.ts              # Entry point (stdio MCP server + HTTP health server)
│   ├── server.ts              # Tool registration
│   ├── config.ts              # Env-var / .polytician.json configuration
│   ├── db/                    # SQLite + Postgres adapters
│   ├── services/               # concept, conversion, embedding, backup, index-sync
│   ├── backup/                 # Backup file format (JSONL), key loading, backups directory
│   ├── mcp/tools/              # export_backup / import_backup / list_backups
│   ├── polyvault/ & lib/polyvault/  # PolyVault chunked canister format + FAISS client
│   ├── integrations/agent-vault/    # AgentVault config, providers, vault_* tools
│   └── sidecar/                # HTTP client for the optional Python sidecar
├── python-sidecar/             # Optional Flask helper: FAISS rebuild, PolyVault bundles
├── bin/agentvault-sync.ts      # Standalone backup/restore/sync CLI
├── tests/                      # vitest suite (~35 files: tools, storage, polyvault, concurrency)
├── docker-compose.yml, k8s/    # Distributed, Postgres-backed reference deployment
└── docs/                       # PolyVault spec/runbook, ecosystem evaluation
```

```bash
npm run dev          # hot-reload dev server (tsx)
npm run build        # compile to dist/
npm run typecheck    # tsc --noEmit
npm test             # vitest run — tools, storage, concurrency, PolyVault, encryption
npm run test:watch
npm run quality      # lint + typecheck + format:check
npm run quality:fix  # lint:fix + format
```

### Adding a New Tool

Register it in `src/server.ts` with `server.tool(name, description, zodInputShape, handler)` — see any existing tool for the pattern of validating input, calling into a service in `src/services/`, and returning `jsonResult(...)` / `errorResult(...)`.

---

## Contributing

1. Fork the repository and create a feature branch
2. Make your changes, adding or updating tests in `tests/`
3. Run `npm run quality && npm test` before pushing
4. Open a pull request describing the change and its motivation

Please include Node.js version, OS, and reproduction steps when reporting issues.

---

## License

MIT — see [LICENSE](LICENSE).
