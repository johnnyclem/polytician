# Ecosystem Evaluation: Polytician's Vantage Point

## Sourcing note

This evaluation was produced from a Claude Code session whose GitHub access is scoped to
**`johnnyclem/polytician` only**. Everything said about Polytician's own code is
source-verified (read directly from this checkout). Everything said about **AgentVault**
comes from unauthenticated `raw.githubusercontent.com` fetches of specific files on
AgentVault's `main` branch — no shell/API access, no ability to browse the whole tree, and
no ability to check commit history or CI status. Findings about AgentVault are flagged
**[AV-verified]** (a specific file was fetched and read) or **[AV-README]** (inferred from a
doc file, not source) throughout. **SmallChat**, **Stenographer**, and **Short-Hand** were
not investigated at all — nothing in Polytician's source, docs, or dependency graph
references them (see the "not part of this repo's story" note below), and the four-layer
ecosystem model in AgentVault's own docs doesn't include Polytician either. This document
does not attempt to extend that four-layer model; it reports on a separate, fifth
integration that AgentVault's engineering guide already acknowledges but doesn't fully
describe.

Read AgentVault's own version of this evaluation first if you can reach it:
- [`docs/ecosystem/executive-summary.md`](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/executive-summary.md)
- [`docs/ecosystem/engineering-guide.md`](https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md)

## What Polytician is, in one sentence

A local-first MCP server (TypeScript + a Python FastAPI sidecar) that stores "concepts" in
three interchangeable representations — 768-dim vectors, markdown, and structured
**ThoughtForm** JSON (entities/relationships/context graph) — and converts between them on
demand, primarily for use as Claude Desktop's or another MCP client's semantic-memory tool.

## Where Polytician sits relative to AgentVault's ecosystem

AgentVault's four-layer thesis (body / reflexes / memory / working-memory, covering
AgentVault, SmallChat, Stenographer, Short-Hand) does not mention Polytician. But
AgentVault's engineering guide **[AV-verified]** already references Polytician directly, as
an existing, wired-up context source:

> "Polytician enrichment (`src/orchestration/polytician-enricher.ts`) — pulls 'concepts'
> from an external MCP server and stuffs them into the prompt with a hard
> character-count truncation" — and identifies this as "the weakest link in AgentVault's
> orchestration pipeline for any long-running session," recommending Short-Hand's
> `CompactionEngine` as a replacement for the truncation logic.

So from Polytician's vantage, the honest framing is: **Polytician is not one of the four
named layers — it's a semantic-memory MCP tool that AgentVault's orchestrator already calls
out to for prompt enrichment, with a known, acknowledged weakness (character-count
truncation) that AgentVault's own docs already flag as the reason to eventually route
through Short-Hand's compaction layer instead.** This repo doesn't need to invent that
recommendation — AgentVault's docs already made it, from the other side, correctly.

## Key finding: the compatibility PRD is largely already shipped, not aspirational

This repo contains [`AGENTVAULT_COMPATIBILITY_PRD.md`](../../AGENTVAULT_COMPATIBILITY_PRD.md),
a 7-task spec written from Polytician's side describing what AgentVault would need to build
to support Polytician: a 6-route REST bridge, an agent-type parser, canister-level MCP
registration, orchestrator enrichment, a webapp dashboard, and CLI subcommands.

Fetching the exact files the PRD names from AgentVault's `main` branch shows **most of this
is already built**, not a future task list:

| PRD task | Status against AgentVault `main` | Evidence |
|---|---|---|
| Task 1: REST bridge (`/api/inference`, `/api/memory-repo/commits`, `/api/archival/upload`, `/api/secrets/:name`) | **Shipped** [AV-verified] | All four fetched routes exist with matching shapes (auth check, validation, the documented error codes) |
| Task 2: Polytician agent-type parser | **Shipped** [AV-verified] | `src/packaging/parsers/polytician.ts` exists, matches the PRD's function names (`parsePolyticianConfig`, `findPolyticianConfigs`) |
| Task 3: Canister-level MCP server registration (`registerMCPServer`/`listMCPServers` in `agent.did`) | **Not shipped** [AV-verified] | Fetched `canister/agent.did` — no `MCPServerRegistration`, `registerMCPServer`, or `listMCPServers` present |
| Task 4: Orchestrator context enrichment (`polytician-enricher.ts`) | **Shipped** [AV-verified] | File exists, matches PRD's `EnrichmentConfig`/`enrichWithPolyticianContext` interface exactly — this is the same integration AgentVault's engineering guide criticizes for hard truncation |
| Task 5: Webapp dashboard (`ConceptList.tsx`, `SemanticSearchBar.tsx`, etc.) | **Not shipped** [AV-verified] | Fetched `webapp/src/components/ConceptList.tsx` → 404 |
| Task 6: CLI subcommands (`agentvault polytician ...`) | **Shipped** [AV-verified] | `cli/commands/polytician.ts` exists with all six documented subcommands (status/search/push-all/pull/archive/register) |
| Task 7: Testing | Not checked from this side — would need AgentVault's test suite, which this session can't browse | — |

**This matters for anyone reading the PRD file at face value**: treat it as a partially
stale historical spec, not a live backlog. The REST bridge, parser, enrichment hook, and CLI
are real and callable today; only the on-chain MCP-server registry and the webapp dashboard
UI remain undone.

## Polytician's own side: what's real vs. what's a stub

Verified directly from source in this repo:

- `src/integrations/agent-vault/` (1,122 lines across 8 files) implements the client side of
  every one of the 6 REST routes above, plus a `vault-tools.ts` module registering 7 MCP
  tools (`vault_infer`, `vault_memory_push`, `vault_memory_pull`, `vault_archive_concept`,
  `vault_get_secret`, `vault_memory_repo_log`, `vault_restore`) — all real, non-stub
  implementations with a path allowlist, body-size limits, and bearer-token auth
  (`http-client.ts`), covered by 12 integration tests
  (`tests/agentvault-integration.test.ts`).
- A separate, larger subsystem — **PolyVault** (`docs/polyvault/spec-v1.md`,
  `docs/polyvault-guardrails.md`) — implements encrypted backup/restore of ThoughtForms to
  an IC canister (AES-256-GCM, gzip, chunking, deterministic conflict resolution). This is
  a real, spec'd, guardrail-documented subsystem, not a placeholder.
- **Gap the README doesn't disclose**: `README.md` — Polytician's only user-facing
  documentation — makes **zero mention** of AgentVault, PolyVault, or any on-chain
  integration. Someone reading only the README would have no idea roughly a third of this
  repo's `src/` and `docs/` content is AgentVault-integration code. This is the inverse of
  the usual "README oversells" gap: here the README undersells, and the PRD (which nobody
  would find without already knowing the integration exists) is the only place the story is
  told.

## Recommendations

1. **Fix the PRD's status, not just its content.** Add a status column or a top banner to
   `AGENTVAULT_COMPATIBILITY_PRD.md` marking Tasks 1/2/4/6 as shipped and 3/5 as outstanding,
   so it stops reading as a from-scratch backlog.
2. **Document the AgentVault/PolyVault integration in the README**, even briefly — a
   "Integrations" section linking to `AGENTVAULT_COMPATIBILITY_PRD.md` and
   `docs/polyvault/spec-v1.md` would close the disclosure gap above.
3. **Prioritize Task 5 (dashboard) low, Task 3 (canister MCP registry) higher** — the CLI
   subcommands (Task 6, shipped) already give operators everything the dashboard would add
   read-only value on top of; the canister registry is what lets AgentVault's orchestrator
   *discover* a running Polytician instance instead of requiring it to be wired in by hand,
   which is the actual blocker to Task 4's enrichment hook being used automatically per-agent.
4. **When AgentVault swaps `polytician-enricher.ts`'s truncation for Short-Hand's
   `CompactionEngine`** (per AgentVault's own engineering guide), Polytician's
   `search_concepts`/`read_concept` MCP contract doesn't need to change — the fix is entirely
   on AgentVault's consuming side. Nothing in this repo blocks that migration.
