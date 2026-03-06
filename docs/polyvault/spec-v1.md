# PolyVault v1.0 Specification

## Overview

PolyVault is the backup/restore bridge between local Polytician ThoughtForms and on-chain AgentVault storage on the Internet Computer. It provides deterministic, idempotent, and encrypted sync of semantic memory records.

## Architecture

```
Local SQLite   -->  Backup Pipeline  -->  IC Canister
(ThoughtForms)     (serialize/compress/    (chunked storage)
                    encrypt/chunk/upload)

IC Canister    -->  Restore Pipeline -->  Local SQLite + FAISS
(chunked storage)  (fetch/reassemble/     (concepts table + vector index)
                    decrypt/decompress)
```

### Three-Layer Design

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Core | `src/polyvault/` | Pure functions: serialization, chunking, crypto, conflict resolution |
| Lib | `src/lib/polyvault/` | Integration: upload, download, validation, FAISS client |
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

1. Read and validate ThoughtForms
2. Filter by `sinceUpdatedAt` (exclusive lower bound)
3. Canonical sort: `updatedAtMs asc, id asc, contentHash asc`
4. Build bundle with deterministic `dedupeKey`
5. Serialize (deterministic JSON) -> compress (gzip) -> encrypt (AES-256-GCM) -> chunk (max 1MB)
6. Upload chunks with idempotency keys
7. Finalize commit on canister

**Idempotency:** `dedupeKey = sha256(contentFingerprint + ':' + compress + ':' + encrypt)`. Re-running unchanged backup returns `duplicateOf` with no new storage.

### Restore (on-chain to local)

1. List commits (paginated) since checkpoint
2. Fetch chunks per commit (paginated)
3. Reassemble and validate hashes
4. Decrypt (if encrypted) and decompress
5. Deserialize and schema validate
6. Deduplicate by ID (last-writer-wins by `updatedAtMs`)
7. Upsert into SQLite (local-first: newer local data preserved)
8. Trigger FAISS index rebuild

### Conflict Resolution

Deterministic policy (no interactive prompts):

1. Higher `updatedAtMs` wins
2. Tie: higher `contentHash` (lexical hex) wins
3. Tie: compare `source`, then `id`
4. `prefer` flag overrides within skew window (default 5 min)

## Security Model

### Encryption

- Default: AES-256-GCM per bundle chunk (`vetkeys-aes-gcm-v1`)
- Fail-closed: `encryptionRequired=true` prevents plaintext upload
- Per-operation random nonce (never derived or reused)
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
