# Ecosystem Engineering Guide: Polytician's Vantage Point

## Sourcing note

Same scope as the executive summary: this session had full source access to
`johnnyclem/polytician` only. Every claim about AgentVault below is tagged **[AV-verified]**
(fetched the exact file from `raw.githubusercontent.com/johnnyclem/AgentVault/main/...` and
read its content) or **[AV-README]** (from AgentVault's own docs, not source). No access to
SmallChat, Stenographer, or Short-Hand was attempted or is claimed. See
[`executive-summary.md`](./executive-summary.md) for the narrative version of these
findings, and AgentVault's
[`engineering-guide.md`](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md)
for the other side of this integration.

## Component reference: Polytician's AgentVault integration surface

All paths below are relative to this repo (`johnnyclem/polytician`) and were read directly.

| File | Lines | Role |
|---|---|---|
| `src/integrations/agent-vault/config.ts` | ~50 | Zod schema (`AgentVaultConfigSchema`) for `apiBaseUrl`, `apiToken`, `agentPrincipal`, `memoryRepoBranch`, and `inference`/`secrets`/`sync`/`archival` sub-configs |
| `src/integrations/agent-vault/client/http-client.ts` | 136 | `AVHttpClient` — the transport layer. Enforces a **path allowlist** (6 regexes matching exactly the 6 REST routes below), a 2048-char URL cap, a 10MB body cap, bearer-token auth, and unwraps AgentVault's `{success, data}` envelope |
| `src/integrations/agent-vault/client/inference-client.ts` | 15 | Thin wrapper: `POST /api/inference` |
| `src/integrations/agent-vault/client/memory-repo-client.ts` | 34 | Wraps `GET /api/memory-repo/branches/:branch`, `POST /api/memory-repo/commits`, `POST /api/memory-repo/tombstone` |
| `src/integrations/agent-vault/client/secret-client.ts` | 15 | Thin wrapper: `GET /api/secrets/:name` |
| `src/integrations/agent-vault/client/arweave-client.ts` | 46 | `POST /api/archival/upload`, plus a `withJwk()` method for wallet configuration |
| `src/integrations/agent-vault/connectors/memory-sync.connector.ts` | 137 | `MemorySyncConnector` — bidirectional concept sync (push/pull/bidirectional), last-write-wins by `updatedAt`, optional polling timer |
| `src/integrations/agent-vault/connectors/archival.connector.ts` | 127 | Debounced Arweave archival, JWK loading from file path / inline JSON / env var |
| `src/integrations/agent-vault/connectors/event-bridge.ts` | 66 | `AgentVaultEventBridge` — wires concept CRUD events to sync/archival connectors |
| `src/integrations/agent-vault/providers/agentvault-llm.provider.ts` | 87 | Adapts AgentVault's inference chain as an LLM provider for Polytician itself |
| `src/integrations/agent-vault/providers/agentvault-secret.provider.ts` | 37 | Adapts AgentVault's secret store as a secret provider for Polytician itself |
| `src/integrations/agent-vault/tools/vault-tools.ts` | 422 | Registers 7 MCP tools: `vault_infer`, `vault_memory_push`, `vault_memory_pull`, `vault_archive_concept`, `vault_get_secret`, `vault_memory_repo_log`, `vault_restore` |
| `src/mcp/tools/agentvault.ts` | — | Backup-bundle serialization (`serializeBackupBundle`) used by the vault tools |
| `docs/polyvault/spec-v1.md` | — | Full spec for **PolyVault**: encrypted (AES-256-GCM), gzip-compressed, chunked (≤1MB), deterministically-conflict-resolved backup/restore of ThoughtForms to an IC canister |
| `docs/polyvault/runbook.md` | — | Operator runbook: exit codes, failure matrix, restore drill procedure |
| `docs/polyvault-guardrails.md` | — | Non-negotiable implementation policy (fail-closed security, no plaintext-on-chain, idempotency requirements) |
| `AGENTVAULT_COMPATIBILITY_PRD.md` | 646 | The spec (written from this repo) of what AgentVault needs to build to support Polytician — see status table below |
| `tests/agentvault-integration.test.ts` | 156 | 12 tests: response unwrapping, path-allowlist security, auth |
| `tests/agentvault-sync.test.ts` | 105 | Sync connector tests |
| `bin/agentvault-sync.ts` | — | `npm run agentvault-sync` CLI entry point |

## Data flow

```
┌─────────────────────────┐         MCP (stdio)         ┌──────────────────────────┐
│   AgentVault             │◄────────────────────────────│  Polytician MCP server    │
│   orchestrator            │  search_concepts,           │  (this repo)              │
│                            │  read_concept                │                          │
│  polytician-enricher.ts   │─────────────────────────────►│  17 save/read/convert      │
│  [AV-verified: exists,    │  (enriches prompts with      │  tools + FAISS search      │
│   truncates at N chars]   │   Polytician's semantic       │                          │
└──────────┬────────────────┘   search results)            └──────────┬───────────────┘
           │                                                            │
           │ REST, 6 routes, bearer auth                                │ AVHttpClient
           │ (inference / memory-repo / archival / secrets)             │ (path allowlist,
           ▼                                                            ▼  body-size caps)
┌─────────────────────────┐                                ┌──────────────────────────┐
│ AgentVault webapp API    │◄───────────────────────────────│ vault-tools.ts (7 MCP     │
│ routes [AV-verified:      │  HTTP                          │ tools) + MemorySync /     │
│ inference, commits,      │                                 │ Archival connectors        │
│ archival, secrets exist] │                                 │                          │
└──────────┬────────────────┘                                └──────────────────────────┘
           │
           ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│ memory_repo canister     │         │ Arweave (permanent        │
│ (ICP)                    │         │ archival)                  │
└─────────────────────────┘         └──────────────────────────┘
```

Two independent bridges exist, both real:
1. **MCP enrichment** (AgentVault → Polytician, read-only, per-prompt): AgentVault's
   orchestrator spawns/queries Polytician over MCP to pull relevant concepts into a prompt.
   AgentVault's own docs **[AV-README]** already flag this as truncation-limited and slated
   for replacement by Short-Hand's `CompactionEngine`.
2. **REST sync/archival/inference** (Polytician → AgentVault, read/write, event- or
   command-driven): Polytician's connectors push/pull concepts to `memory_repo`, archive to
   Arweave, and can route its own LLM calls and secret lookups through AgentVault.

These are not redundant — (1) is AgentVault consuming Polytician's search; (2) is Polytician
using AgentVault as a durable backing store and inference/secrets provider. A change to one
does not require a change to the other.

## PRD-vs-reality status table (the README-vs-reality check for this evaluation)

`AGENTVAULT_COMPATIBILITY_PRD.md`'s 7 tasks, checked against AgentVault `main` by fetching
the exact files it names:

| # | Task | File(s) checked | Result |
|---|---|---|---|
| 1 | REST bridge: `/api/inference` | `webapp/src/app/api/inference/route.ts` | **Exists** [AV-verified] — auth check, `prompt` validation, fallback-chain routing, matches PRD shape |
| 1 | REST bridge: `/api/memory-repo/commits` | `webapp/src/app/api/memory-repo/commits/route.ts` | **Exists** [AV-verified] — full content read; note the response's `author` field is derived from `latestCommit?.branch` (likely a copy-paste placeholder, not `'polytician-connector'` as the PRD specifies) and `timestamp` is an ISO string, not the epoch-ms integer the PRD's example shows — a minor contract drift worth flagging to whoever owns that route |
| 1 | REST bridge: `/api/archival/upload` | `webapp/src/app/api/archival/upload/route.ts` | **Exists** [AV-verified] — validates `data`+`jwk`, tags with content-type/app-id, returns txId/url/timestamp/tags/size |
| 1 | REST bridge: `/api/secrets/:name` | `webapp/src/app/api/secrets/[name]/route.ts` | **Exists** [AV-verified] — auth-gated, supports HashiCorp Vault or env-var fallback |
| 1 | REST bridge: `/api/memory-repo/branches/:branch`, `/api/memory-repo/tombstone` | Not fetched individually | **Not verified either way** — given 4/6 sibling routes exist with matching patterns, likely also implemented, but this was not confirmed by reading the file |
| 2 | `src/packaging/parsers/polytician.ts` | same path | **Exists** [AV-verified] — `parsePolyticianConfig`, `findPolyticianConfigs`, `validatePolyticianConfig`, matches PRD's field list |
| 3 | Canister MCP registration (`agent.did`: `MCPServerRegistration`, `registerMCPServer`, `listMCPServers`) | `canister/agent.did` | **Not implemented** [AV-verified] — none of the three symbols appear in the Candid interface |
| 4 | `src/orchestration/polytician-enricher.ts` | same path | **Exists** [AV-verified] — `enrichWithPolyticianContext`, `EnrichmentConfig` match the PRD exactly; this is the same file AgentVault's engineering guide criticizes for character-count truncation |
| 5 | `webapp/src/components/ConceptList.tsx` (dashboard) | same path | **Not implemented** [AV-verified] — 404 |
| 6 | `cli/commands/polytician.ts` | same path | **Exists** [AV-verified] — all 6 subcommands present (`status`, `search`, `push-all`, `pull`, `archive`, `register`) |
| 7 | Testing | AgentVault's test suite | **Not checked** — this session has no way to browse AgentVault's `tests/` directory without API/shell access to that repo |

**Net read**: 4 of 7 tasks are substantially shipped, 2 are confirmed not started
(canister registry, dashboard UI), 1 is unverifiable from this side. Whoever maintains
`AGENTVAULT_COMPATIBILITY_PRD.md` should update it to reflect this rather than leave it
reading as a from-scratch spec — a new contributor picking up "Task 1" today would be
redoing work that already exists.

## Confirming/refuting AgentVault's engineering guide's claims about Polytician

AgentVault's engineering guide **[AV-README]** makes exactly one substantive factual claim
about Polytician: that `polytician-enricher.ts` does prompt enrichment via
`search_concepts`/`read_concept` MCP calls with a hard character-count truncation. This is
**confirmed** — the file exists at that path with that exact interface **[AV-verified]**, and
Polytician's own MCP tool surface (17 tools per its README, including implicit
`search_concepts`/`read_concept`-shaped read/convert commands) is consistent with what that
enrichment code would need to call. No refutation to report here; this is one place the
AgentVault-side docs got it right without over-claiming.

## Roadmap from Polytician's side

If someone wanted to close the remaining gaps found above, in priority order:

1. **Update `AGENTVAULT_COMPATIBILITY_PRD.md`'s status** (this repo, cheap, unblocks nothing
   technical but stops future contributors from duplicating shipped work).
2. **Canister MCP registry (PRD Task 3)** — this is the actual blocker to AgentVault's
   orchestrator auto-discovering a running Polytician instance; today, wiring
   `polytician-enricher.ts` into a given agent's orchestration presumably requires manual
   configuration rather than a `listMCPServers()` lookup. This is AgentVault-side work; from
   Polytician's side, no changes are needed since it takes commands over stdio regardless of
   how AgentVault discovers it.
3. **Webapp dashboard (PRD Task 5)** — lowest priority; the CLI subcommands (Task 6, shipped)
   already cover status/search/push/pull/archive from the terminal.
4. **When/if AgentVault migrates `polytician-enricher.ts` to Short-Hand's `CompactionEngine`**
   (a recommendation from AgentVault's own docs, not from this evaluation), Polytician's MCP
   contract (`search_concepts` → `read_concept`) does not need to change. That migration is
   entirely a consumer-side (AgentVault orchestrator) concern.
5. **Document the integration in this repo's README** — currently a purely cosmetic gap (see
   executive summary), but worth doing before anyone relies on the README as the entry point
   to understanding this repo's scope.
