# PolyVault Operator Runbook

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
4. Run with `LOG_LEVEL=debug` for per-record validation details.

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

Use this procedure to verify your backup/restore pipeline works end-to-end.

### Prerequisites
- Local dfx replica running (`dfx start --background`)
- PolyVault canister deployed
- At least one backup completed

### Steps

1. **Verify existing state**
   ```bash
   # Count current concepts in SQLite
   sqlite3 data/polytician.db "SELECT COUNT(*) FROM concepts"
   ```

2. **Create a fresh backup**
   ```bash
   npx tsx src/index.ts polyvault backup \
     --from data/thoughtforms.json \
     --compress gzip \
     --out /tmp/backup-manifest.json
   ```
   Verify: exit code 0, manifest shows `thoughtformCount > 0`.

3. **Drop local state** (destructive -- confirm before running)
   ```bash
   # Back up current DB first
   cp data/polytician.db data/polytician.db.bak
   sqlite3 data/polytician.db "DELETE FROM concepts"
   ```

4. **Run full restore**
   ```bash
   npx tsx src/index.ts polyvault restore \
     --to /tmp/restored.json \
     --mode full \
     --compression gzip \
     --out /tmp/restore-manifest.json
   ```
   Verify: exit code 0, manifest `thoughtformCount` matches backup.

5. **Verify data integrity**
   ```bash
   # Compare restored count to backup count
   cat /tmp/restore-manifest.json | jq '.thoughtformCount'
   cat /tmp/backup-manifest.json | jq '.thoughtformCount'
   ```

6. **Verify no sensitive data in logs**
   ```bash
   # Check that no rawText appeared in stderr output
   LOG_LEVEL=debug npx tsx src/index.ts polyvault restore \
     --to /tmp/restored.json --mode full --compression gzip 2>/tmp/restore.log
   grep -c "rawText" /tmp/restore.log  # Should be 0 or only show [REDACTED]
   ```

7. **Restore from backup** (if drill failed)
   ```bash
   cp data/polytician.db.bak data/polytician.db
   ```

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
