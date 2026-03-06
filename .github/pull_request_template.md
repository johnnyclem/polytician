## What Changed

-

## Why

-

## Validation

- [ ] Tests added/updated where needed
- [ ] Local checks run (describe below)

```
# Example:
# npm test
# npm run lint
```

## Risks / Rollback

- Risk level: low / medium / high
- Rollback plan:

---

## PolyVault Guardrails Checklist

If this PR touches PolyVault backup/restore/sync, complete this checklist.

Reference: `docs/polyvault-guardrails.md`

### Correctness and Data Integrity

- [ ] ThoughtForm field semantics are preserved end-to-end (`entities`, `relationships`, `contextGraph`, `rawText`, `metadata`)
- [ ] Malformed ThoughtForms are explicitly rejected (no silent repair/invention)
- [ ] Unknown/forward-compatible fields are preserved
- [ ] Conflict resolution cannot overwrite newer data with older data by default
- [ ] Relationship/context graph merge logic avoids duplicate/contradictory corruption
- [ ] Bundle metadata is cross-checked with configured principal/canister/network

### Security and Privacy

- [ ] Encryption-required mode fails closed (no plaintext upload fallback)
- [ ] No plaintext ThoughtForms, `rawText`, keys, IVs, or decrypted payloads are logged
- [ ] Nonce/IV reuse is prevented
- [ ] No insecure/downgraded bundle version accepted without explicit policy
- [ ] Identity/provenance checks are enforced for write vs restore actors

### Sync, Conflict, and Atomicity

- [ ] Command mode is explicit (`backup|restore|merge|rebase`), not ambiguous `sync`
- [ ] Repeated sync/backup is idempotent (no duplication/bundle explosion)
- [ ] Restore cannot leave SQLite/FAISS permanently inconsistent
- [ ] Destructive operations require explicit opt-in (`--force`) and/or confirmation
- [ ] Partial outcomes are reported with counts (fetched/inserted/updated/skipped/conflicted/failed)

### Performance and Limits

- [ ] Payloads are chunked before ingress/stable-memory limits are exceeded
- [ ] Compression is threshold-based (not indiscriminate)
- [ ] No full-table memory load when streaming/chunking is feasible
- [ ] Long operations provide progress + timeout/cancellation behavior

### Testing and Compatibility

- [ ] Round-trip tests cover serialize -> store -> fetch -> deserialize fidelity
- [ ] Failure-path tests cover interruption/chunk loss/corruption/schema mismatch/sidecar unavailable
- [ ] Integration tests use local replica (not mainnet)
- [ ] Existing CLI/MCP interfaces remain backward-compatible
- [ ] No hard-coded canister IDs, network targets, or developer-specific paths

## Notes for Reviewers

- If PolyVault is out of scope for this PR, reviewers may ignore the PolyVault section.
