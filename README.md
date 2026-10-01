# Polytician

[![CI](https://github.com/johnnyclem/polytician/actions/workflows/ci.yml/badge.svg)](https://github.com/johnnyclem/polytician/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/polytician.svg)](https://www.npmjs.com/package/polytician)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](#requirements)

**Local-first semantic memory for AI agents.** Polytician is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Desktop (or any MCP client) a persistent, searchable memory: every concept can be stored — and freely converted between — a **384-dim vector**, human-readable **markdown**, and structured **ThoughtForm** JSON.

Everything runs on your machine. Embeddings are generated in-process; there's no external API call on the hot path unless you explicitly wire one in for LLM-assisted conversions.

---

## Why Polytician

- 🧠 **One concept, three shapes** — save once, read back as a vector, markdown, or structured JSON, and convert between them on demand via a single `convert_concept` tool
- 🔍 **Semantic search** — cosine similarity search over `sqlite-vec` (default) or Postgres/`pgvector`. Namespace and tag filters run inside the vector query, so a filtered top-k is the top-k of the matching concepts. Saved text is embedded automatically, so `save_concept` → `search_concepts` works without a manual conversion
- 🔒 **Local-first embeddings** — `@huggingface/transformers` runs `all-MiniLM-L6-v2` in-process (384 dimensions); after the one-time model download there is no network round-trip and no API key. Each vector records the model that made it, and search refuses to mix models
- 🗂️ **Namespaces + optimistic concurrency** — every tool call is scoped to a namespace, and an operator allowlist (`POLYTICIAN_NAMESPACES`) limits which ones a server serves (see [Namespaces](#namespaces) for exactly what that does and does not isolate). `expectedVersion` is checked in the same statement that writes, so of two concurrent writers holding the same version exactly one succeeds
- 🔌 **Optional LLM + NLP** — the conversions that generate content (`markdown→thoughtform`, `vector→markdown`, `vector→thoughtform`) use [AgentVault](#agentvault-integration) inference when you opt in with `POLYTICIAN_LLM_PROVIDER=agentvault`, or a rule-based NLP pipeline for `markdown→thoughtform`; nothing leaves the machine unless you configure it to
- 🧳 **Portable backups** — `export_backup` / `import_backup` write and restore every namespace (vectors, tags, thoughtforms and provenance included) as one versioned JSONL file, optionally AES-256-GCM encrypted, with a checksum that detects truncation and edits
- 🚀 **Local or shared** — one Node process per MCP client over stdio (SQLite by default), or one shared server over MCP Streamable HTTP (`--http`, bearer token) with Docker Compose and Kubernetes manifests for a Postgres-backed deployment

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│          MCP Server (TypeScript, @modelcontextprotocol/sdk)       │
│   stdio (default, one client per process)                         │
│   or Streamable HTTP with --http: POST /mcp (bearer token),       │
│   GET /health and /health/live on the same port (default 8788)    │
├───────────────────────────────────────────────────────────────────┤
│ Tools: save/read/delete/list/batch/search/convert/embed/reembed/  │
│        health_check/get_stats/export|import|list_backups          │
│        + vault_* (optional, AgentVault)                           │
├───────────────────────────────────────────────────────────────────┤
│ Embeddings: @huggingface/transformers (all-MiniLM-L6-v2, 384-dim, │
│             in-process; model downloaded once, then cached)       │
├───────────────────────────────────────────────────────────────────┤
│ Storage: better-sqlite3 + sqlite-vec (WAL mode, default)          │
│          — or Postgres + pgvector via POLYTICIAN_DB_BACKEND       │
└───────────────────────────────────────────────────────────────────┘
```

Everything runs in the one Node process: save, read, search, and the non-LLM conversions need nothing but `npm start`. There is no sidecar service (3.0 removed the optional Python sidecar, whose FAISS index nothing queried).

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
  - [HTTP transport](#http-transport)
  - [Docker](#docker)
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
| **Node.js** | >= 22 (CI runs 22 and 24) |
| **npm** | >= 10.0.0 |

`npm install` builds or downloads native modules (better-sqlite3, sharp, onnxruntime-node), so do not install with `--ignore-scripts`. On Linux x64, onnxruntime-node's install script also downloads its CUDA provider libraries; polytician runs on the CPU and does not use them, so `ONNXRUNTIME_NODE_INSTALL=skip npm install` saves that download.

---

## Quick Start

```bash
git clone https://github.com/johnnyclem/polytician.git
cd polytician
npm install
npm run build
npm start
```

The server speaks MCP over **stdio** and exits when its client closes stdin. It opens no network port unless you ask for one: `POLYTICIAN_HEALTH_PORT` adds a health endpoint, and `--http` serves MCP over HTTP instead (see [HTTP transport](#http-transport)). On first use it downloads the `all-MiniLM-L6-v2` embedding model (~25 MB, quantized) into `~/.polytician/models`; after that it runs offline.

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

Polytician is configured through environment variables and, optionally, a JSON config file: `~/.polytician/config.json`, or the file given with `--config <path>`. Env vars win over the file. The working directory is never read: MCP clients start servers with the opened project as their working directory, so a config file there is not trusted. A config file that exists but is not valid JSON, or an invalid `agentVault` block, stops the server with an error instead of being ignored. Everything has a sensible default; you don't need to set anything to get started.

In the config file, string values may reference environment variables as `${NAME}`, but only `POLYTICIAN_*` variables (for example `"apiToken": "${POLYTICIAN_AV_TOKEN}"`).

| Variable | Default | Description |
|----------|---------|--------------|
| `POLYTICIAN_DATA_DIR` | `~/.polytician` | Root directory for the SQLite DB and cached embedding model |
| `POLYTICIAN_HEALTH_PORT` | unset (off) | stdio mode only: serve `GET /health` and `/health/live` on this port. Off by default, so several stdio servers (one per MCP client) never compete for a port; a port that is taken is logged and the MCP server keeps running |
| `POLYTICIAN_HEALTH_HOST` | `127.0.0.1` | Interface the stdio-mode health endpoint binds |
| `POLYTICIAN_TRANSPORT` | `stdio` | `stdio` or `http`; `--http` is the same as `http`. See [HTTP transport](#http-transport) |
| `POLYTICIAN_HTTP_HOST` / `POLYTICIAN_HTTP_PORT` | `127.0.0.1` / `8788` | Where the HTTP transport listens. 8788 is the suite's polytician port (stenographer's REST daemon uses 8787) |
| `POLYTICIAN_HTTP_TOKEN` / `POLYTICIAN_HTTP_TOKEN_FILE` | — / `<dataDir>/http-token` | Bearer token HTTP clients must send (32+ characters), or the file holding it. Without either, a random token is written to the file (mode `600`) on first start |
| `POLYTICIAN_HTTP_ALLOWED_HOSTS` | loopback names | Host header names the HTTP transport accepts (DNS-rebinding protection). Required when `POLYTICIAN_HTTP_HOST` is not a loopback address |
| `POLYTICIAN_HTTP_ALLOWED_ORIGINS` | none | Browser origins allowed to call `/mcp`; a request carrying any other `Origin` is refused |
| `POLYTICIAN_DB_BACKEND` | `sqlite` | `sqlite` or `postgres` — see [Postgres backend](#postgres--pgvector-backend) |
| `POLYTICIAN_POSTGRES_URL` | — | Connection string, required when `POLYTICIAN_DB_BACKEND=postgres` |
| `POLYTICIAN_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | A `@huggingface/transformers` feature-extraction model with a quantized (`q8`) ONNX export that outputs **384**-dimensional vectors; any other size is an error. Changing it makes existing vectors stale until `reembed_concepts` re-derives them |
| `POLYTICIAN_LLM_PROVIDER` | `none` | `agentvault` or `none`. `agentvault` sends the text being converted, and its nearest neighbours' text, to AgentVault's inference chain; it is never enabled implicitly |
| `POLYTICIAN_NLP_PIPELINE` | `none` | `rule-based`, `llm`, or `none` — used by `markdown→thoughtform` |
| `POLYTICIAN_NAMESPACES` | unset | Namespaces tool calls may address: a comma-separated list, or `*` for any. Unset allows any namespace but refuses `crossNamespace` search. See [Namespaces](#namespaces) |
| `POLYTICIAN_ENCRYPT` | `false` | Require every backup file to be encrypted (AES-256-GCM); fails closed without a key. `--encrypt` does the same. See [Backup, Restore & Encryption](#backup-restore--encryption) |
| `POLYTICIAN_BACKUP_KEY` / `POLYTICIAN_BACKUP_KEY_FILE` | — / `<dataDir>/backup.key` | The 256-bit backup key (base64 or hex), or a file holding it (must be mode `600`) |
| `POLYTICIAN_BACKUP_THRESHOLD` | `0` (off) | Write an auto-backup after this many saves |
| `POLYTICIAN_BACKUP_RETAIN` | `10` | Auto-backups to keep; older ones are deleted |
| `POLYTICIAN_AV_API_URL` / `POLYTICIAN_AV_API_TOKEN` | — | Enable the [AgentVault integration](#agentvault-integration) and its `vault_*` tools. The URL must be `https` (plain `http` only for `localhost`) |

---

## Tools Reference

All tools return `{ "content": [{ "type": "text", "text": "<JSON>" }] }`; the examples below show the decoded JSON payload for brevity. Authoritative schemas live in `src/server.ts`.

Every tool's input schema is strict: an unknown argument is a validation error, not silently dropped. Every tool that takes a `namespace` defaults it to `"default"`. Errors from the service come back with `isError: true` and a JSON body `{ "error", "code" }`, where `code` is one of `NOT_FOUND`, `VALIDATION_ERROR`, `VERSION_CONFLICT` (plus `currentVersion`), `NAMESPACE_DENIED`, `OVERWRITE_REFUSED`, `CONVERSION_ERROR`, `EMBEDDING_MODEL_MISMATCH` (see `reembed_concepts`) or `CONFIG_ERROR` (the server is missing configuration the call needs, such as a backup key). Arguments that fail the input schema (an unknown key, a wrong type) come back as `isError: true` with a plain-text `Input validation error: ...` naming the offending keys.

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
- Every stored vector records the embedding model it belongs to (the configured `POLYTICIAN_EMBEDDING_MODEL` when it was written). If any vector in the searched namespaces was made by a different model, the search fails with `EMBEDDING_MODEL_MISMATCH` instead of ranking incomparable vectors; run `reembed_concepts`.

### `reembed_concepts`

`{ "namespace"?, "overwrite"?, "limit"? }` → `{ "model", "reembedded": [ids], "skipped": [{ id, reason }], "remaining" }`. Re-derives, from each concept's markdown (else its thoughtform text), the vectors in the namespace that another embedding model made, so the namespace can be searched again after `POLYTICIAN_EMBEDDING_MODEL` changes. Vectors a caller supplied are replaced only with `overwrite: true` (`reason: "authored"`); concepts with no text (`"no-text"`) are left for you to re-save or delete; a concept edited meanwhile is skipped (`"changed"`). At most `limit` (default 500) per call; `remaining` counts the stale vectors left. Vectors stored before 3.0 carry no model and are labelled once with the model configured on the first 3.0 start.

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
| `vault_memory_pull` | Pull `concepts/<uuid>/markdown` entries from a `memory_repo` branch into one namespace, last write wins: an entry replaces a local concept only if its `updatedAt` is newer, entries recorded for another namespace are skipped, and every skipped entry is reported with a reason |
| `vault_archive_concept` | Only when archival is enabled (see below). Archive a tagged concept to Arweave, encrypted, returning a transaction ID/URL |
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

### HTTP transport

`node dist/index.js --http` (or `POLYTICIAN_TRANSPORT=http`) serves MCP over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) instead of stdio, so several clients can share one server:

- `POST /mcp` — MCP JSON-RPC. The server is stateless (no `Mcp-Session-Id`; each request gets a fresh MCP server over the shared database), so replicas behind a load balancer need no session affinity. `GET` and `DELETE` on `/mcp` return `405`. Requests are capped at 16 MiB.
- `GET /health` — readiness: `200` when the database and the vector index answer, `503` otherwise. The body says only `ok`/`error` per check; details go to the server log.
- `GET /health/live` — liveness: `200` while the process answers.

Every `/mcp` request must carry `Authorization: Bearer <token>`, a `Host` header in `POLYTICIAN_HTTP_ALLOWED_HOSTS` (loopback names by default), and either no `Origin` or one listed in `POLYTICIAN_HTTP_ALLOWED_ORIGINS`; otherwise it gets `401` or `403`. The token is `POLYTICIAN_HTTP_TOKEN`, or the contents of `POLYTICIAN_HTTP_TOKEN_FILE` (default `<dataDir>/http-token`), which is generated with a random 256-bit token and mode `600` on first start; a token file that other users can read is refused. The health endpoints need no token.

The listener binds `127.0.0.1:8788` by default. Binding another interface (`POLYTICIAN_HTTP_HOST=0.0.0.0`) requires `POLYTICIAN_HTTP_ALLOWED_HOSTS`. The token authenticates the server's clients as a group: it does not tell clients apart, so the [namespace boundary](#namespaces) is the same as over stdio. There is no TLS; put the server behind a TLS-terminating proxy or keep it on a private network.

```bash
POLYTICIAN_HTTP_TOKEN=$(openssl rand -base64 32) node dist/index.js --http
POLYTICIAN_HTTP_TOKEN=... node scripts/smoke-http.mjs http://127.0.0.1:8788   # save + search over HTTP
```

### Docker

The image runs the HTTP transport on port 8788 with its data (SQLite database, model cache, generated token) in the `/data` volume:

```bash
docker build -t polytician:3.0.0 .
docker run -d -p 127.0.0.1:8788:8788 -v polytician-data:/data \
  -e POLYTICIAN_HTTP_TOKEN="$(openssl rand -base64 32)" polytician:3.0.0
```

Native modules are fetched or built during the image build (install scripts run), and the image's `HEALTHCHECK` uses `node`, not `curl`. The embedding model is downloaded from huggingface.co on the first embedding and cached in `/data/models`.

### Docker Compose

```bash
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
export POLYTICIAN_HTTP_TOKEN=$(openssl rand -base64 32)
docker compose up -d
```

`docker-compose.yml` runs one Polytician server (HTTP transport) on a `pgvector/pgvector` Postgres. Both secrets are required (there is no default password), Polytician is published on `127.0.0.1:8788` only, and Postgres is not published on the host at all. The Polytician container has a read-only root filesystem and no Linux capabilities.

### Kubernetes

Manifests live in [`k8s/`](k8s/). Create the two secrets first (the commands are in the comments of `k8s/postgres.yml` and `k8s/polytician.yml`; no credentials are committed), set the image you built, then:

```bash
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/postgres.yml
kubectl apply -f k8s/polytician.yml
kubectl apply -f k8s/networkpolicy.yml
```

`k8s/polytician.yml` runs 2+ replicas of the HTTP transport behind a `ClusterIP` service on port 8788, all sharing the Postgres store (each write updates the row and its vector in one transaction, so there is no index sync between replicas). Readiness probes `/health`, liveness `/health/live`, so a database outage takes pods out of the service without restarting them. Pods run as non-root with a read-only root filesystem, no capabilities and the `RuntimeDefault` seccomp profile. `k8s/networkpolicy.yml` admits only pods labelled `polytician-client: "true"` to Polytician and only Polytician to Postgres; Polytician's egress is limited to Postgres, DNS and HTTPS (for the model download).

### systemd / PM2

The build is a single `node dist/index.js` process (add `--http` for the network transport), so any standard Node process manager works — see `Dockerfile` for the runtime environment to mirror in a unit file or `ecosystem.config.js`.

---

## Postgres / pgvector Backend

Set `POLYTICIAN_DB_BACKEND=postgres` and `POLYTICIAN_POSTGRES_URL` to point at a Postgres instance with the `vector` extension available (the `pgvector/pgvector` Docker image is the easiest path). The adapter (`src/db/postgres-adapter.ts`) runs `CREATE EXTENSION IF NOT EXISTS vector`, creates its tables and applies its schema migrations on startup, under an advisory lock so several nodes can start at once. There is no separate migration step to run first. This backend is what lets several HTTP-transport replicas share one store, as in `docker-compose.yml` and `k8s/`.

Vectors are indexed with HNSW over cosine distance (`vector_cosine_ops`), which needs pgvector ≥ 0.5. Use pgvector ≥ 0.8 if you can: filtered searches (every search is filtered by namespace) then use HNSW iterative scans. On older pgvector they fall back to an exact scan, which returns correct results but costs a scan of the matching rows.

Run the adapter's tests against a disposable database with `POLYTICIAN_TEST_POSTGRES_URL=postgres://... npx vitest run tests/postgres-adapter.test.ts`. They are skipped when the variable is unset.

---

## Backup, Restore & Encryption

Backups are files in `<dataDir>/backups` (`~/.polytician/backups` by default; the directory is mode `700` and each file mode `600`). The `export_backup`, `import_backup` and `list_backups` tools, the auto-backup and the `agentvault-sync` CLI all read and write the same format:

- **Format:** JSONL, versioned (`"format": "polytician-backup", "formatVersion": 1`). Line 1 is a header (backup id, creation time, the embedding model id and dimension, and the encryption parameters), then one line per concept (id, namespace, version, timestamps, tags, markdown, thoughtform, embedding and provenance, all as JSON values), then a footer with per-namespace counts and a SHA-256 over the header and concept lines. The reference is [`src/backup/format.ts`](src/backup/format.ts).
- **Scope:** every namespace unless one is named (`export_backup` covers the namespaces the server serves under `POLYTICIAN_NAMESPACES`).
- **Restore:** `import_backup` verifies the file (checksum, counts, and the AES-GCM tag when encrypted) and validates every concept before writing anything, then writes all of them in one transaction with their original ids, namespaces, timestamps, tags, vectors and provenance. It never writes into a concept that lives in another namespace. If the backup's embedding model differs from the server's, it refuses unless `reembed: true`, which derives new vectors from each concept's text.
- **Encryption:** `export_backup { encrypt: true }`, `agentvault-sync backup --encrypt`, or `POLYTICIAN_ENCRYPT=true` (which makes every backup writer, including auto-backup, encrypt and refuse plaintext) encrypt the concept lines with AES-256-GCM. The random 96-bit nonce, the AAD (which binds the body to the header's backup id) and the key's fingerprint are stored in the header. The key is `POLYTICIAN_BACKUP_KEY` or the key file (`POLYTICIAN_BACKUP_KEY_FILE`, default `<dataDir>/backup.key`, mode `600`). Polytician never generates a key: if encryption is requested and no key is configured, the export fails instead of writing plaintext (and with `POLYTICIAN_ENCRYPT` the server does not start). Create one with `openssl rand -base64 32 > ~/.polytician/backup.key && chmod 600 ~/.polytician/backup.key`, and **keep a copy off the machine**, because an encrypted backup cannot be restored without it. Importing with the wrong key fails with an error naming both key fingerprints.
- **Integrity boundary:** the footer checksum detects truncation and accidental edits, and the GCM tag detects any change to an encrypted body. Neither is a signature: anyone who holds the file (and, for encrypted files, the key) can write a backup that verifies.
- **Auto-backup** is off by default. Set `POLYTICIAN_BACKUP_THRESHOLD=N` to write a full backup after every N saves (a burst of saves, such as a batch or an import, triggers one backup), keeping the newest `POLYTICIAN_BACKUP_RETAIN` (default 10).

The CLI runs the same export and import outside an MCP client. As an operator tool it accepts any `--out` / `--file` path:

```bash
npx tsx bin/agentvault-sync.ts backup  [--out backup.jsonl] [--namespace work] [--encrypt]
npx tsx bin/agentvault-sync.ts restore --file backup.jsonl [--on-conflict newer|overwrite|skip] [--reembed]
npx tsx bin/agentvault-sync.ts sync    --direction bidirectional
```

**PolyVault is experimental.** `src/polyvault/`, `src/lib/polyvault/` and `src/commands/polyvault/` implement a separate, chunked backup format for an Internet Computer canister (`src/agentvault_polyvault/`), but they are a library only: no shipped command, tool or startup path calls them, and their interfaces may change in a minor release. Use the backup files above for backups. See [`docs/polyvault/spec-v1.md`](docs/polyvault/spec-v1.md).

---

## AgentVault Integration

Polytician doubles as a semantic-memory source, on-chain backup target, and inference/secrets provider for [AgentVault](https://github.com/johnnyclem/agentvault)'s orchestrator, via the `vault_*` tools above.

Configuring AgentVault does not by itself send concept content anywhere. Each off-box path is a separate opt-in, and the server logs the endpoint and which paths are on at startup:

| Path | Opt-in | What leaves the machine |
|---|---|---|
| LLM conversions | `POLYTICIAN_LLM_PROVIDER=agentvault` | The text being converted and its nearest neighbours' text, to AgentVault inference |
| Memory sync | `agentVault.sync.enabled` | Markdown and thoughtform of every created or updated concept (push); pulls apply remote entries last-write-wins |
| Arweave archival | `agentVault.archival.enabled` with a non-empty `tagFilter` and a backup key | Concepts carrying every `tagFilter` tag, encrypted with the backup key. Only the concept id, version and key fingerprint are readable on-chain. Arweave is permanent and public, and each new version is a new paid upload |

Archival refuses to start without a `tagFilter` or without a backup key (see [Backup, Restore & Encryption](#backup-restore--encryption)); there is no plaintext archival. `openArchive()` in `src/integrations/agent-vault/connectors/archival.connector.ts` decrypts a downloaded archive with that key.

Requests that change state on AgentVault (memory commits, tombstones, archival uploads) are sent once and never retried, because a request that timed out may still have been applied: a retry could duplicate a commit or mint a second permanent upload (and resend the wallet). Reads and inference are retried on transient failures.

### Calling Polytician from AgentVault's orchestrator

AgentVault's `polytician-enricher` (`src/orchestration/polytician-enricher.ts` in AgentVault) is the one external caller of Polytician's MCP tools. As of AgentVault `12a025f` it sends arguments these tools do not accept, and 3.0 rejects them instead of silently dropping them (2.x saved an empty concept for every orchestration run and returned no id):

| AgentVault sends | Result in 3.0 | Correct call |
|---|---|---|
| `save_concept { name, content, representation, metadata }` | `isError: true`, `Input validation error: ... Unrecognized key(s) in object: 'name', 'content', 'representation', 'metadata'`; nothing is stored | `save_concept { markdown: content, tags: ["orchestration", "session:<id>"], namespace? }` (put the name in the markdown title; there is no free-form metadata field) |
| `search_concepts { query, limit, min_score }` | `isError: true`, `... Unrecognized key(s) in object: 'limit', 'min_score'` | `search_concepts { query, k: limit, namespace? }`, then drop results whose `score` is below `min_score` on the client |
| `read_concept { id }` | Works | Same; the text is the `markdown` field |

Results are JSON in `content[0].text` (parse it); there is no `content[0].data`. `save_concept` returns the concept, including its `id`; `search_concepts` returns an array of `{ id, namespace, score, tags, representations }` (no `name`). Contract tests that replay AgentVault's calls are in `tests/mcp-contract.test.ts`.

See also:

- [`AGENTVAULT_COMPATIBILITY_PRD.md`](AGENTVAULT_COMPATIBILITY_PRD.md) — the spec for AgentVault's side of this integration
- [`docs/polyvault/spec-v1.md`](docs/polyvault/spec-v1.md) — the encrypted backup/restore bridge to an IC canister (PolyVault, experimental, library only)
- [`docs/ecosystem/executive-summary.md`](docs/ecosystem/executive-summary.md) and [`docs/ecosystem/engineering-guide.md`](docs/ecosystem/engineering-guide.md) — cross-repo ecosystem evaluation, including what's actually shipped vs. still aspirational on AgentVault's side

---

## Health Checks & Troubleshooting

Health endpoints exist on the HTTP transport's port, or in stdio mode when `POLYTICIAN_HEALTH_PORT` is set (bound to `127.0.0.1`):

```bash
curl http://127.0.0.1:8788/health        # readiness: database + vector index
curl http://127.0.0.1:8788/health/live   # liveness: the process answers
```

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok" },
    "vector_index": { "status": "ok" }
  },
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

A failing check reports `"status": "error"` with HTTP `503`; the error itself is only logged.

**Common issues:**

| Symptom | Fix |
|---|---|
| Slow first request | The embedding model is downloading (~25 MB) into `POLYTICIAN_DATA_DIR/models`; subsequent runs load it from there. A failed download (offline, proxy) is retried on the next call |
| `... produces 768-dimensional vectors; polytician stores 384-dimensional vectors` | You've pointed `POLYTICIAN_EMBEDDING_MODEL` at a model that doesn't output 384-dim vectors |
| `EMBEDDING_MODEL_MISMATCH` on search | The namespace holds vectors made by a different embedding model than the configured one; run `reembed_concepts` (or switch the model back) |
| `401` / `403` from `/mcp` | Missing or wrong bearer token, a `Host` not in `POLYTICIAN_HTTP_ALLOWED_HOSTS`, or an `Origin` not in `POLYTICIAN_HTTP_ALLOWED_ORIGINS` |
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
│   ├── index.ts              # Entry point: stdio or --http transport
│   ├── transport/http.ts      # Streamable HTTP transport (auth, Host/Origin checks)
│   ├── health.ts              # /health and /health/live
│   ├── server.ts              # Tool registration
│   ├── config.ts              # Env vars + ~/.polytician/config.json (or --config)
│   ├── db/                    # SQLite + Postgres adapters
│   ├── services/               # concept, conversion, embedding, backup
│   ├── backup/                 # Backup file format (JSONL), key loading, backups directory
│   ├── mcp/tools/              # export_backup / import_backup / list_backups
│   ├── polyvault/ & lib/polyvault/  # PolyVault (experimental, library only)
│   └── integrations/agent-vault/    # AgentVault config, providers, vault_* tools
├── bin/agentvault-sync.ts      # Standalone backup/restore/sync CLI
├── scripts/smoke-http.mjs      # Save + search smoke test against a running HTTP server
├── tests/                      # vitest suite (~35 files: tools, storage, polyvault, concurrency)
├── Dockerfile, docker-compose.yml, k8s/  # HTTP transport + Postgres deployment
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
