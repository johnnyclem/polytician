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
- 🔍 **Semantic search** — cosine similarity search over `sqlite-vec` (default) or Postgres/`pgvector`, scoped to a namespace by default with explicit opt-in for cross-namespace queries
- 🔒 **Local-first embeddings** — `@xenova/transformers` runs `all-MiniLM-L6-v2` in-process (384 dimensions); no network round-trip, no API key required
- 🗂️ **Namespaces + optimistic concurrency** — isolate concepts per agent/tenant and guard concurrent writes with an `expectedVersion` check
- 🔌 **Pluggable LLM + NLP** — bring your own provider (Anthropic, OpenAI, MCP sampling, or [AgentVault](#agentvault-integration)) for the conversions that need one (`markdown→thoughtform`, `vector→markdown`, `vector→thoughtform`)
- 🧳 **Portable backups** — snapshot and restore your entire memory as a single signed JSON bundle (optionally AES-256-GCM encrypted), with an optional Arweave archival path via AgentVault
- 🚀 **Deploys anywhere** — a single Node process (SQLite by default), with first-class Docker Compose and Kubernetes manifests for a distributed, Postgres-backed, multi-node setup

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                     MCP Server (TypeScript, stdio)                │
│                    @modelcontextprotocol/sdk                      │
├───────────────────────────────────────────────────────────────────┤
│ Tools: save/read/delete/list/batch/search/convert/embed/          │
│        health_check/get_stats/agentvault_backup + vault_* (opt.)  │
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
| `POLYTICIAN_NODE_ID` | random | Identifies this node in a distributed/multi-node deployment |
| `POLYTICIAN_ASYNC_INDEX_SYNC` | `false` | Enable background vector-index sync across nodes |
| `POLYTICIAN_ENCRYPT` | `false` | Encrypt PolyVault backup bundles (AES-256-GCM) — see [Backup, Restore & Encryption](#backup-restore--encryption) |
| `POLYTICIAN_BACKUP_THRESHOLD` | `50` | Auto-trigger a backup after this many saves (`0` disables) |
| `POLYTICIAN_AV_API_URL` / `POLYTICIAN_AV_API_TOKEN` | — | Enable the [AgentVault integration](#agentvault-integration) and its `vault_*` tools |

---

## Tools Reference

All tools return `{ "content": [{ "type": "text", "text": "<JSON>" }] }`; the examples below show the decoded JSON payload for brevity. Authoritative schemas live in `src/server.ts`.

### `save_concept`

Create or update a concept with one or more representations. Tags merge on update; namespace defaults to `"default"`.

```json
// Request
{
  "markdown": "Albert Einstein developed the theory of relativity.",
  "tags": ["physics", "history"]
}
// Response
{ "id": "...", "namespace": "default", "version": 1, "tags": ["physics", "history"], ... }
```

Pass `expectedVersion` to guard against concurrent writes — a mismatch throws `VERSION_CONFLICT` with the current version attached.

### `read_concept`

`{ "id": "...", "representations"?: ["vector"|"markdown"|"thoughtform"] }` → the concept, optionally filtered to the requested representations.

### `delete_concept`

`{ "id": "..." }` → `{ "deleted": "..." }`

### `list_concepts`

`{ "namespace"?, "limit"? (≤100, default 50), "offset"?, "tags"? }` → paginated concepts scoped to the namespace.

### `batch_save_concepts`

`{ "concepts": [{ "id"?, "markdown"?, "thoughtform"?, "embedding"?, "tags"? }, ...], "autoEmbed"?, "batchSize"? }` → `{ "count", "ids": [...] }`. When `autoEmbed` is true, any entry with markdown but no embedding is embedded in batches of `batchSize` (default 50).

### `search_concepts`

Semantic similarity search — provide `query` (auto-embedded) or a raw `vector`.

```json
{ "query": "famous physicists", "k": 5, "namespace": "default" }
```

Results are namespace-scoped by default; pass `crossNamespace: true` to search globally.

### `convert_concept`

`{ "id": "...", "from": "vector"|"markdown"|"thoughtform", "to": "vector"|"markdown"|"thoughtform" }` → `{ "converted": { "from", "to" }, "concept": {...} }`

| Conversion | Requires an LLM? |
|---|---|
| `thoughtform → vector`, `thoughtform → markdown`, `markdown → vector` | No — deterministic |
| `markdown → thoughtform`, `vector → markdown`, `vector → thoughtform` | Yes — set `POLYTICIAN_LLM_PROVIDER` (or `POLYTICIAN_NLP_PIPELINE=rule-based` for `markdown → thoughtform`) |

### `embed_text`

`{ "text": "..." }` → `{ "dimension": 384, "embedding": [...] }`. Embeds arbitrary text without persisting a concept.

### `health_check` / `get_stats`

`{ "namespace"? }` → server + embedding model + LLM provider status, and concept/representation counts for that namespace.

### `agentvault_backup`

`{ "namespace"? }` → serializes every concept in the namespace into a signed JSON bundle: `{ "success", "conceptCount", "sizeBytes", "sha256", "namespace", "lastSynced", "createdAt" }`. See [Backup, Restore & Encryption](#backup-restore--encryption).

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
| `vault_restore` | Restore concepts and rebuild the FAISS index from an inline bundle or file path |

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

`convert_concept` moves between these on demand — deterministically for the vector/markdown/thoughtform-derived paths, and via your configured LLM or NLP pipeline for the paths that need to *generate* rather than *derive* content.

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

`k8s/polytician.yml` deploys 3 replicas behind a `ClusterIP` service on port 8787 — pair with `POLYTICIAN_DB_BACKEND=postgres` and `POLYTICIAN_ASYNC_INDEX_SYNC=true` for a real multi-replica deployment.

### systemd / PM2

The build is a single `node dist/index.js` process reading stdio, so any standard Node process manager works — see `Dockerfile` for the exact runtime invocation to mirror in a unit file or `ecosystem.config.js`.

---

## Postgres / pgvector Backend

Set `POLYTICIAN_DB_BACKEND=postgres` and `POLYTICIAN_POSTGRES_URL` to point at a Postgres instance with the `vector` extension available (the `pgvector/pgvector` Docker image is the easiest path). The adapter (`src/db/postgres-adapter.ts`) runs `CREATE EXTENSION IF NOT EXISTS vector` and creates its tables on startup — there's no separate migration step to run first. This backend is what backs the multi-node / distributed deployments in `docker-compose.yml` and `k8s/`.

---

## Backup, Restore & Encryption

`agentvault_backup` (and the `agentvault-sync` CLI, see below) serialize a namespace's concepts into a single JSON bundle with a `sha256` integrity hash. Set `POLYTICIAN_ENCRYPT=true` (or pass `--encrypt`) to encrypt the bundle with AES-256-GCM behind a VetKeys-shaped crypto interface (`src/polyvault/crypto.ts`) — today that's a local AES-GCM adapter, laid out so a future IC/VetKeys threshold-key backend can drop in without changing the bundle format.

A standalone CLI is also available for scripted backup/restore/sync outside of an MCP client:

```bash
npx tsx bin/agentvault-sync.ts backup  --out backup.json --namespace default
npx tsx bin/agentvault-sync.ts restore --file backup.json
npx tsx bin/agentvault-sync.ts sync    --direction bidirectional --namespace default
```

See [`docs/polyvault/spec-v1.md`](docs/polyvault/spec-v1.md) for the bundle format and [`docs/polyvault/runbook.md`](docs/polyvault/runbook.md) for operational guidance.

---

## AgentVault Integration

Polytician doubles as a semantic-memory source, on-chain backup target, and inference/secrets provider for [AgentVault](https://github.com/johnnyclem/agentvault)'s orchestrator, via the `vault_*` tools and `agentvault_backup` above. See:

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
│   ├── polyvault/ & lib/polyvault/  # Encrypted backup bundle format + FAISS client
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
