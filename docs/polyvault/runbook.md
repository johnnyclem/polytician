# PolyVault Operator Runbook

PolyVault is experimental and library-only: no shipped command, tool or startup path calls it. The exit codes and log lines below are what `runBackup`, `runRestore`, `runRebase` and `runMerge` in `src/commands/polyvault/` return and log when your own code calls them. Backups of a running Polytician are the JSONL backup files (`export_backup`, `agentvault-sync backup`); the [restore drill](#restore-drill-procedure) below exercises those.

## Quick Reference

| Exit Code | Category | Meaning |
|-----------|----------|---------|
| 0 | Success | Operation completed normally |
| 2 | Validation | Malformed input, schema mismatch, or missing required parameter |
| 3 | Auth | Principal not authorized, allowlist rejection |
| 4 | Network | Canister unreachable, timeout, connection refused |
| 5 | Integrity | Hash mismatch, chunk corruption, decryption failure |

## Failure Matrix

### ERR_VALIDATION (exit 2)

**Symptoms:** ThoughtForm schema mismatch, missing required fields, invalid timestamp.

**Log pattern:**
```json
{"message":"polyvault.backup.failed","errorCode":"ERR_VALIDATION","remediation":"Check input file format..."}
```

**Actions:**
1. Validate your input JSON against the ThoughtForm v1.0 schema.
2. Check that all timestamps are positive integers (epoch ms).
3. Ensure `schemaVersion` is `"1.0"`.
4. Ensure each `metadata.contentHash` equals `computeContentHash()` of its content (`withContentHash()` fills it in); a stale producer hash is rejected.
5. Run with `LOG_LEVEL=debug` for per-record validation details.

### ERR_AUTH (exit 3)

**Symptoms:** `Unauthorized: caller is not permitted` in error output.

**Log pattern:**
```json
{"message":"polyvault.restore.failed","errorCode":"ERR_AUTH","remediation":"Verify principal identity..."}
```

**Actions:**
1. Verify your dfx identity: `dfx identity whoami`
2. Check the canister allowlist includes your principal.
3. If using delegated agents, confirm the delegation is current.
4. Confirm you are targeting the correct canister ID and network.

### ERR_NETWORK (exit 4)

**Symptoms:** Connection refused, timeout, DNS resolution failure.

**Log pattern:**
```json
{"message":"polyvault.backup.failed","errorCode":"ERR_NETWORK","remediation":"Check network connectivity..."}
```

**Actions:**
1. Verify network connectivity: `ping <canister-host>`
2. Check that the IC replica or local dfx is running.
3. Retry the operation (backup/restore are idempotent).
4. If using local replica: `dfx start --background`
5. Check for firewall or proxy interference.

### ERR_INTEGRITY (exit 5)

**Symptoms:** Hash mismatch, chunk corruption, decryption failure.

**Log pattern:**
```json
{"message":"polyvault.restore.failed","errorCode":"ERR_INTEGRITY","remediation":"Data integrity check failed..."}
```

**Actions:**
1. If chunk hash mismatch: data was corrupted in transit. Retry the restore.
2. If payload hash mismatch: the on-chain data may be corrupted. Verify the commit record.
3. If decryption failed: verify the correct encryption key is being used.
4. Consider running a full restore (`mode: 'full'`) to rebuild from genesis.

## Restore Drill Procedure

There is no PolyVault command to drill: PolyVault is a library, and `src/index.ts` ignores its arguments and starts the MCP server. (The 2.x version of this drill ran `npx tsx src/index.ts polyvault backup|restore`, which only started a server, after deleting every row of a database path the server does not use.) This drill exercises the backups Polytician actually ships, the JSONL backup files written by `export_backup` and `agentvault-sync`, and restores into a scratch store, so it never modifies your live data.

To drill PolyVault itself, call `runBackupE2E` / `runRestoreE2E` (`src/commands/polyvault/e2e.ts`) from your own code against a local replica; `tests/polyvault-e2e.test.ts` shows the calls.

### Prerequisites

- A checkout of the polytician repository with `npm install` done (the CLI runs through `tsx`), and `jq`.
- The environment the server runs with (`POLYTICIAN_DATA_DIR`, `POLYTICIAN_DB_BACKEND`, `POLYTICIAN_POSTGRES_URL`, and for encrypted backups `POLYTICIAN_BACKUP_KEY` or the key file), so the backup reads the live store.

### Steps

1. **Back up the live store**
   ```bash
   DRILL=$(mktemp -d)
   npx tsx bin/agentvault-sync.ts backup --out "$DRILL/backup.jsonl" | tee "$DRILL/backup.log"
   # add --encrypt (or keep POLYTICIAN_ENCRYPT=true) to drill an encrypted backup
   ```
   Verify: it prints `wrote N concepts (<namespace>=<count>, ...)` covering every namespace you expect (an error is printed instead on failure; `tee` hides the exit code).

2. **Restore into a scratch store** (SQLite in the drill directory; the format does not depend on the backend, so this works for a Postgres store too)
   ```bash
   LIVE_DIR="${POLYTICIAN_DATA_DIR:-$HOME/.polytician}"
   scratch() {
     POLYTICIAN_DATA_DIR="$DRILL/data" POLYTICIAN_DB_BACKEND=sqlite \
     POLYTICIAN_BACKUP_KEY_FILE="${POLYTICIAN_BACKUP_KEY_FILE:-$LIVE_DIR/backup.key}" \
       npx tsx bin/agentvault-sync.ts "$@"
   }
   scratch restore --file "$DRILL/backup.jsonl" | tee "$DRILL/restore.log"
   ```
   `POLYTICIAN_BACKUP_KEY_FILE` keeps pointing at the live key file, whose default location moves with `POLYTICIAN_DATA_DIR`. Verify: it prints `imported N concepts (N new, 0 replaced), skipped 0`.

3. **Compare a fresh export of the scratch store with the backup**
   ```bash
   scratch backup --out "$DRILL/roundtrip.jsonl" | tee "$DRILL/roundtrip.log"
   diff <(grep -o 'wrote [0-9]* concepts[^/]*' "$DRILL/backup.log") \
        <(grep -o 'wrote [0-9]* concepts[^/]*' "$DRILL/roundtrip.log") && echo "counts match"
   # Plaintext backups only: every concept line round-trips unchanged.
   diff <(sed '1d;$d' "$DRILL/backup.jsonl" | jq -Sc . | sort) \
        <(sed '1d;$d' "$DRILL/roundtrip.jsonl" | jq -Sc . | sort) && echo "concepts match"
   ```

4. **Check that corruption is detected**
   ```bash
   sed '2s/./X/' "$DRILL/backup.jsonl" > "$DRILL/tampered.jsonl"
   scratch restore --file "$DRILL/tampered.jsonl"; echo "exit=$?"
   ```
   Verify: exit 1, with `Backup line 2 is not valid JSON` or `Backup checksum mismatch` (plaintext) or `authentication tag mismatch` (encrypted), and nothing restored.

5. **Clean up.** A plaintext backup holds your memory in clear text.
   ```bash
   rm -rf "$DRILL"
   ```

To restore for real, run `npx tsx bin/agentvault-sync.ts restore --file <backup>` against the live store (it keeps a local concept that is as new as or newer than the backup copy unless `--on-conflict overwrite`), or put the file in `<dataDir>/backups` and call the `import_backup` tool.

## Observability

### Log Levels

Set via `LOG_LEVEL` environment variable:

| Level | Output |
|-------|--------|
| `debug` | Per-record validation, chunk processing, commit details |
| `info` | Pipeline start/complete, result summaries (default) |
| `warn` | Non-fatal issues: empty backups, skipped commits |
| `error` | Pipeline failures with exit code and remediation |

### Safe Log Fields

These fields appear in structured JSON logs and are safe for monitoring/alerting:

- `commitId`, `bundleId` -- commit/bundle identifiers
- `thoughtformCount`, `chunkCount`, `chunksUploaded` -- operation counts
- `payloadHash`, `manifestHash`, `chunkHash` -- integrity hashes
- `payloadSizeBytes` -- payload size
- `compressed`, `encrypted` -- boolean flags
- `duration_ms` -- operation timing
- `exitCode`, `errorCode`, `remediation` -- failure classification

### Redacted Fields

These fields are always replaced with `[REDACTED]` in logs:

- `rawText` -- user content
- `encryptionKey`, `decryptionKey` -- key material
- `nonce`, `decryptionNonce` -- initialization vectors
- `payload`, `plaintext`, `ciphertext` -- binary data
- `thoughtforms`, `entities`, `relationships`, `contextGraph` -- ThoughtForm content

### Monitoring Alerts

Suggested alert thresholds:

| Metric | Warning | Critical |
|--------|---------|----------|
| `backup.failed` count | > 2 in 1h | > 5 in 1h |
| `restore.failed` count | > 1 in 1h | > 3 in 1h |
| `backup.complete` duration_ms | > 30000 | > 120000 |
| `restore.complete` duration_ms | > 60000 | > 300000 |

### Log Search Examples

```bash
# Find all backup failures
grep 'polyvault.backup.failed' /var/log/polytician.log | jq .

# Find slow restores
grep 'polyvault.restore.complete' /var/log/polytician.log | jq 'select(.duration_ms > 30000)'

# Count operations by status
grep 'polyvault.backup.complete' /var/log/polytician.log | jq -r .status | sort | uniq -c
```
