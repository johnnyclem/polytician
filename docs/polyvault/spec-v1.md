# PolyVault v1.0 Specification

> **Status: experimental, library only.** The modules described here are not wired to any shipped command, MCP tool or startup path, and their interfaces may change in a minor release. Polytician's supported backups are the JSONL files written by `export_backup` (see the README).

## Overview

PolyVault is the backup/restore bridge between local Polytician ThoughtForms and on-chain AgentVault storage on the Internet Computer. Its properties, each with its boundary:

- **Deterministic serialization:** the same bundle value always serializes to the same bytes (keys sorted recursively).
- **Idempotent backup:** re-running a backup whose ThoughtForms have the same ids, `updatedAtMs` and content returns `duplicateOf` instead of a new commit. Any edit, rename or touch produces a new commit.
- **Encryption:** AES-256-GCM with a fresh random nonce per commit, stored in front of the ciphertext; restore needs only the key.

## Architecture

```
Local SQLite   -->  Backup Pipeline  -->  IC Canister
(ThoughtForms)     (serialize/compress/    (chunked storage)
                    encrypt/chunk/upload)

IC Canister    -->  Restore Pipeline -->  Local SQLite
(chunked storage)  (fetch/reassemble/     (concepts table + vector index)
                    decrypt/decompress)
```

### Three-Layer Design

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Core | `src/polyvault/` | Pure functions: serialization, chunking, crypto, conflict resolution |
| Lib | `src/lib/polyvault/` | Integration: upload, download, validation |
| Commands | `src/commands/polyvault/` | CLI orchestration: backup, restore, end-to-end pipelines |

## Data Schemas

### ThoughtForm v1.0

The canonical unit of semantic memory. Validated by Zod with `.passthrough()` for forward compatibility.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `"1.0"` | yes | Schema version literal |
| `id` | `string` | yes | Unique identifier |
| `rawText` | `string` | no | Original text (omittable when redacted) |
| `entities` | `EntityV1[]` | yes | Extracted entities |
| `relationships` | `RelationshipV1[]` | yes | Entity relationships |
| `contextGraph` | `object` | yes | Graph context |
| `metadata` | `ThoughtMetadataV1` | yes | Timestamps, source, hash, redaction |

### Bundle v1.0

Transport envelope for backup/restore. Contains a commit record, manifest, delta window, and ThoughtForm array.

| Field | Type | Description |
|-------|------|-------------|
| `version` | `"1.0"` | Bundle schema version |
| `bundleId` | `string` | Deterministic ID from content hash |
| `commit` | `Commit` | Commit metadata (ID, parent, dedupeKey) |
| `manifest` | `Manifest` | Payload stats (count, hash, compression, encryption) |
| `delta` | `Delta` | Time window of included ThoughtForms |
| `thoughtforms` | `ThoughtFormV1[]` | The data payload |

## Sync Semantics

### Backup (local to on-chain)

1. Read and validate ThoughtForms. Each `metadata.contentHash` must equal the content hash computed from the ThoughtForm (see below); a mismatch is a validation error (exit 2)
2. Filter by `sinceUpdatedAt` (exclusive lower bound)
3. Canonical sort: `updatedAtMs asc, id asc, contentHash asc`
4. Build bundle with deterministic `dedupeKey`
5. Serialize (deterministic JSON) -> compress (gzip) -> encrypt (AES-256-GCM) -> chunk (max 1MB)
6. Upload chunks with idempotency keys
7. Finalize commit on canister

**Content hash:** `contentHash = sha256hex(canonicalJson({ rawText (null if omitted), entities, relationships, contextGraph }))`, where canonical JSON sorts object keys recursively. Metadata is not part of it. `computeContentHash()` / `withContentHash()` in `src/polyvault/hash.ts` compute it for producers.

**Idempotency:** `dedupeKey = sha256(contentFingerprint + ':' + compress + ':' + encrypt)`, where `contentFingerprint` joins `id@updatedAtMs#contentHash` for every ThoughtForm in canonical order. Re-running an unchanged backup returns `duplicateOf` with no new storage.

**Encrypted payload:** `nonce (12 bytes) || AES-256-GCM ciphertext || tag (16 bytes)`, with AAD `polyvault/1:<bundleId>:<commitId>`, so a payload cannot be replayed under another commit.

### Restore (on-chain to local)

1. List commits (paginated) since checkpoint
2. Fetch chunks per commit (paginated)
3. Reassemble and validate hashes
4. Decrypt (if encrypted; the nonce is read from the payload) and decompress
5. Deserialize and schema validate
6. Deduplicate by ID (last-writer-wins by `updatedAtMs`)
7. Upsert into SQLite (local-first: newer local data preserved). Upserted concepts carry no vector until one is derived for them (3.0 removed the FAISS rebuild step, whose index nothing queried)

### Rebase (remote commits onto the local set)

Which remote changes are new is decided by **commit order**: each commit's `createdAtMs` is assigned by the canister when the commit is finalized, and the rebase state stores the last commit applied (`{ commitId, createdAtMs }`). A rebase takes every ThoughtForm from the commits after that cursor, ordered by `(createdAtMs, commitId)`, regardless of the ThoughtForms' own `updatedAtMs`: a device that was offline commits day-old edits, and those must still be applied. `updatedAtMs` is used only to resolve conflicts (below). Remote input is an array of `{ commitId, createdAtMs, thoughtforms }`.

### Conflict Resolution

Deterministic policy (no interactive prompts):

0. Equal `contentHash` **and** equal content (recomputed) → no conflict
1. Higher `updatedAtMs` wins
2. Tie: higher `contentHash` (lexical hex) wins
3. Tie: compare `source`, then `id`
4. `prefer` flag overrides within skew window (default 5 min)

## Security Model

### Encryption

- Default: AES-256-GCM per bundle chunk (`vetkeys-aes-gcm-v1`)
- Fail-closed: `encryptionRequired=true` prevents plaintext upload
- Per-commit random nonce (never derived or reused), stored in front of the ciphertext
- Key material never logged, stored in files, or passed via CLI args

### Access Control

- Owner principal set at canister initialization
- Optional allowlist for delegated agents
- Write methods enforce `isWriter(msg.caller)`
- Read policy: owner-only by default

### Redaction Logging

All PolyVault logs are routed through `src/polyvault/logger.ts` which ensures:

- `rawText`, key material, payloads, and ThoughtForm content are always `[REDACTED]`
- Only safe telemetry fields appear: counts, IDs, hashes, sizes, timestamps, flags
- Error logs include actionable remediation guidance

## Exit Codes

| Code | Category | Description |
|------|----------|-------------|
| 0 | Success | Operation completed |
| 2 | Validation | Schema mismatch, malformed input |
| 3 | Auth | Principal not authorized |
| 4 | Network | Canister unreachable |
| 5 | Integrity | Hash mismatch, corruption |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `POLYVAULT_CHUNK_SIZE` | `1000000` | Max chunk size in bytes (capped at 1MB) |
| `POLYVAULT_SKEW_WINDOW_MS` | `300000` | Clock-skew tolerance for conflict resolution |

## Performance Characteristics

- Chunking: payloads split at configurable boundary (max 1MB per canister ingress limit)
- Compression: gzip reduces typical ThoughtForm bundles by 60-80%
- Pagination: commits and chunks fetched in pages of 50
- Deterministic hashing: SHA-256 for content addressing and deduplication
