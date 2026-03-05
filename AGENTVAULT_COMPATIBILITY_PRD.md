# AgentVault ↔ Polytician Compatibility PRD

## Overview

This document specifies the changes required in [AgentVault](https://github.com/johnnyclem/agentvault) to achieve full bidirectional compatibility with [Polytician](https://github.com/johnnyclem/polytician), a local-first MCP semantic memory server. Polytician's side of the integration has already been implemented (see `src/integrations/agent-vault/`).

**Prerequisite:** Polytician v2.0.0 with the AgentVault integration module.

---

## Task 1: REST Bridge API Routes

**Priority:** P0 (blocker — Polytician's HTTP clients call these endpoints)
**Effort:** Medium
**Files:** `webapp/src/app/api/`

Polytician's `AVHttpClient` communicates with AgentVault via 6 REST endpoints. These must be implemented as Next.js API routes that translate HTTP calls to ICP canister operations via `@dfinity/agent`.

### 1.1 Inference Endpoint

**Route:** `POST /api/inference`

**Request body:**
```json
{
  "prompt": "string",
  "preferredBackend": "bittensor" | "venice" | "local",  // optional
  "maxTokens": 4096,        // optional
  "temperature": 0.7,       // optional
  "systemPrompt": "string"  // optional
}
```

**Response body:**
```json
{
  "text": "string",
  "backend": "bittensor" | "venice" | "local",
  "latencyMs": 1234
}
```

**Implementation:**
- File: `webapp/src/app/api/inference/route.ts`
- Import `InferenceFallbackChain` from `src/inference/fallback-chain.ts`
- Construct `FallbackInferenceRequest` from the request body
- If `preferredBackend` is set, disable all other providers via `disableProviders`
- Map `FallbackResult.text` to `text`, `FallbackResult.provider` to `backend`, `FallbackResult.responseTime` to `latencyMs`
- Return 502 if `!result.success`

### 1.2 Memory Repo — Get Branch State

**Route:** `GET /api/memory-repo/branches/:branch`

**Response body:**
```json
{
  "branch": "polytician-main",
  "headSha": "commit_000042",
  "entries": [
    {
      "key": "concepts/uuid/markdown",
      "contentType": "markdown",
      "data": "# Title\n...",
      "tags": ["tag1"],
      "metadata": { "conceptId": "uuid", "updatedAt": 1709555555000 }
    }
  ]
}
```

**Implementation:**
- File: `webapp/src/app/api/memory-repo/branches/[branch]/route.ts`
- Use `ICPClient.callAgentMethod()` to call `memory_repo` canister methods:
  - `switchBranch(branch)` then `getCurrentState()` for the diff
  - `log(branch)` for the commit list
- Reconstruct entries from the latest commit diffs on the branch
- Parse commit diffs to extract `key`, `contentType`, `data`, `tags`, `metadata` fields
- `headSha` = the ID of the most recent commit on the branch

### 1.3 Memory Repo — Commit

**Route:** `POST /api/memory-repo/commits`

**Request body:**
```json
{
  "branch": "polytician-main",
  "message": "polytician: upsert concept <uuid>",
  "entries": [
    {
      "key": "concepts/uuid/markdown",
      "contentType": "markdown",
      "data": "# Concept content",
      "tags": ["tag1"],
      "metadata": { "conceptId": "uuid", "updatedAt": 1709555555000 }
    }
  ]
}
```

**Response body:**
```json
{
  "sha": "commit_000043",
  "branch": "polytician-main",
  "author": "polytician-connector",
  "timestamp": 1709555556000,
  "message": "polytician: upsert concept <uuid>",
  "entries": [...]
}
```

**Implementation:**
- File: `webapp/src/app/api/memory-repo/commits/route.ts`
- Ensure the target branch exists (call `createBranch()` if needed, catch "already exists")
- Switch to the branch
- Serialize entries as a JSON diff string
- Call `commit(message, diff, tags)` on the `memory_repo` canister
- Return the commit result with `sha` = commit ID

### 1.4 Memory Repo — Tombstone

**Route:** `POST /api/memory-repo/tombstone`

**Request body:**
```json
{
  "branch": "polytician-main",
  "key": "concepts/uuid/markdown"
}
```

**Implementation:**
- File: `webapp/src/app/api/memory-repo/tombstone/route.ts`
- Switch to the branch
- Call `commit("tombstone: <key>", JSON.stringify({ deleted: key }), ["tombstone"])`
- Return 204 on success

### 1.5 Archival Upload

**Route:** `POST /api/archival/upload`

**Request body:**
```json
{
  "content": "# Concept content...",
  "contentType": "markdown" | "json",
  "tags": ["tag1"],
  "metadata": {
    "conceptId": "uuid",
    "namespace": "default",
    "version": 3,
    "archivedAt": 1709555556000
  }
}
```

**Response body:**
```json
{
  "txId": "arweave-tx-id",
  "url": "https://arweave.net/arweave-tx-id",
  "timestamp": 1709555557000,
  "tags": ["tag1"],
  "size": 1234
}
```

**Implementation:**
- File: `webapp/src/app/api/archival/upload/route.ts`
- Import `ArweaveClient` from `src/archival/arweave-client.ts`
- Load the Arweave JWK from config or environment
- Convert `tags` and `metadata` to Arweave transaction tags (key-value pairs)
- Call `arweaveClient.uploadData(content, jwk, { tags: arweaveTags })`
- Map `UploadResult` to the response shape

### 1.6 Secret Retrieval

**Route:** `GET /api/secrets/:name`

**Response body:**
```json
{
  "name": "polytician/llm-api-key",
  "value": "sk-...",
  "provider": "hashicorp" | "bitwarden" | "icp-vetkd",
  "rotatedAt": 1709555556000
}
```

**Implementation:**
- File: `webapp/src/app/api/secrets/[name]/route.ts`
- Import the configured `SecretProvider` (HashiCorp or Bitwarden)
- Call `provider.getSecret(name)`
- Return the value with provider metadata
- **Security:** This endpoint MUST require authentication (Bearer token validation against a configured secret or ICP principal check). Never expose secrets without auth.

### Authentication for All Routes

All 6 routes must validate the `Authorization: Bearer <token>` header:
- Compare against `AGENTVAULT_POLYTICIAN_API_TOKEN` env var
- Or validate as an ICP principal with canister access rights
- Return 401 if missing, 403 if invalid

---

## Task 2: Polytician Agent Type Parser

**Priority:** P1
**Effort:** Small
**Files:** `src/packaging/parsers/polytician.ts`, `src/packaging/parsers/index.ts`, `src/packaging/detector.ts`

### 2.1 Parser

Create `src/packaging/parsers/polytician.ts`:

```typescript
export interface PolyticianAgentConfig {
  type: 'polytician';
  name: string;
  version: string;
  mcpTransport: 'stdio';
  entryPoint: string;
  dataDir: string;
  dbBackend: 'sqlite' | 'postgres';
  healthPort: number;
  namespaces: string[];
  llmProvider: string;
  agentVaultIntegration: boolean;
}

export function parsePolyticianConfig(sourcePath: string, verbose?: boolean): PolyticianAgentConfig
export function findPolyticianConfigs(sourcePath: string): string[]
```

**Detection heuristic:**
1. `.polytician.json` exists in directory
2. `package.json` has `polytician` in dependencies
3. `dist/index.js` exists with MCP server pattern

**Parsing:**
1. Read `.polytician.json` for `dataDir`, `dbBackend`, `healthPort`, `llm.provider`
2. Read `package.json` for version
3. Check for `agentVault` block presence → set `agentVaultIntegration`
4. Default `entryPoint` = `dist/index.js`

### 2.2 Detector Update

In `src/packaging/detector.ts`:

- Add `'polytician'` to the `AgentType` union
- Add detection pattern:
  - Config files: `['.polytician.json', 'polytician.config.json']`
  - Config dirs: `['.polytician/']`
- Update `detectAgentType()` to check for Polytician before `generic` fallback
- Update `detectAgent()` to call `parsePolyticianConfig()`

### 2.3 Parser Index

In `src/packaging/parsers/index.ts`:
```typescript
export { parsePolyticianConfig, findPolyticianConfigs } from './polytician.js';
```

---

## Task 3: MCP Server Registration

**Priority:** P1
**Effort:** Medium
**Files:** `cli/commands/mcp.ts`, `src/canister/actor.idl.ts`, `canister/agent.did`

### 3.1 Canister State Extension

Add to `agent.did` and `actor.idl.ts`:

```candid
type MCPServerRegistration = record {
  id: text;
  name: text;
  transport: text;
  command: text;
  args: vec text;
  env: vec record { text; text };
  tools: vec text;
  namespace: text;
};

registerMCPServer : (MCPServerRegistration) -> (variant { ok: text; err: text });
listMCPServers : () -> (vec MCPServerRegistration) query;
removeMCPServer : (text) -> (variant { ok; err: text });
```

### 3.2 Motoko Implementation

Add to `canister/agent.mo`:

- Stable variable: `mcpServers : HashMap<Text, MCPServerRegistration>`
- `registerMCPServer()`: owner-only, validates fields, stores registration
- `listMCPServers()`: query, returns all registrations
- `removeMCPServer(id)`: owner-only, removes by ID

### 3.3 CLI Command

Create `cli/commands/mcp.ts`:

```
agentvault mcp register-polytician \
  --entry /path/to/polytician/dist/index.js \
  --namespace my-agent \
  --health-port 8787
```

Steps:
1. Probe `http://localhost:{healthPort}/health` to verify Polytician is running
2. Call `health_check` MCP tool via stdio to discover available tools
3. Build `MCPServerRegistration` record
4. Call `registerMCPServer()` on the canister
5. Print registration ID

---

## Task 4: Orchestrator Context Enrichment

**Priority:** P1
**Effort:** Medium
**Files:** `src/orchestration/polytician-enricher.ts`, `src/orchestration/claude.ts`

### 4.1 Context Enricher Module

Create `src/orchestration/polytician-enricher.ts`:

```typescript
export interface EnrichmentConfig {
  polyticianEntry: string;     // path to dist/index.js
  namespace: string;
  k: number;                   // top-K search results (default: 5)
  maxContextLength: number;    // max chars to inject (default: 8000)
}

export async function enrichWithPolyticianContext(
  prompt: string,
  config: EnrichmentConfig
): Promise<{ enrichedPrompt: string; conceptsUsed: string[] }>
```

**Implementation:**
1. Spawn Polytician as a child process via stdio (`node <entry>`)
2. Connect as an MCP client using `@modelcontextprotocol/sdk/client`
3. Call `search_concepts` with `query: prompt, k: config.k, namespace: config.namespace`
4. For each hit, call `read_concept` with `representations: ['markdown']`
5. Build context block: `[Concept: <id> (distance: X.XXX)]\n<markdown>`
6. Prepend to prompt: `"Relevant context from memory:\n\n<contexts>\n\n---\n\nUser prompt:\n\n<original prompt>"`
7. Truncate to `maxContextLength` if needed
8. Return enriched prompt + list of concept IDs used

### 4.2 Orchestrator Integration

In `src/orchestration/claude.ts`, modify `orchestrate()`:

After step 2 (load conventions) and before step 4 (API call):

```typescript
// Check if a Polytician MCP server is registered
const mcpServers = await icpClient.callAgentMethod(canisterId, 'listMCPServers', []);
const polyticianServer = mcpServers.find(s => s.name === 'polytician');

if (polyticianServer) {
  const { enrichWithPolyticianContext } = await import('./polytician-enricher.js');
  const { enrichedPrompt, conceptsUsed } = await enrichWithPolyticianContext(
    options.task,
    {
      polyticianEntry: polyticianServer.command + ' ' + polyticianServer.args.join(' '),
      namespace: polyticianServer.namespace,
      k: 5,
      maxContextLength: 8000,
    }
  );
  options.task = enrichedPrompt;
  // Log concept IDs used for audit trail
  auditLog.contextEnrichment = { conceptsUsed, provider: 'polytician' };
}
```

### 4.3 Post-Orchestration Concept Save

After step 6 (re-snapshot), save the orchestration result back to Polytician:

```typescript
if (polyticianServer && result.filesChanged.length > 0) {
  // Save orchestration summary as a new concept
  await mcpClient.callTool('save_concept', {
    namespace: polyticianServer.namespace,
    markdown: `# Orchestration: ${options.task.slice(0, 100)}\n\n${result.summary}`,
    tags: ['orchestration', 'auto-generated', result.sessionId],
  });
}
```

---

## Task 5: Webapp Dashboard Integration

**Priority:** P2
**Effort:** Large
**Files:** `webapp/src/app/`, `webapp/src/components/`, `webapp/src/hooks/`, `webapp/src/lib/types.ts`

### 5.1 Type Definitions

Add to `webapp/src/lib/types.ts`:

```typescript
export interface PolyticianConcept {
  id: string;
  namespace: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  hasMarkdown: boolean;
  hasThoughtform: boolean;
  hasVector: boolean;
  markdown?: string;
  thoughtform?: ThoughtFormSummary;
}

export interface ThoughtFormSummary {
  entityCount: number;
  relationshipCount: number;
  language: string;
}

export interface PolyticianStats {
  conceptCount: number;
  vectorCount: number;
  mdCount: number;
  tfCount: number;
  vecCount: number;
}

export interface PolyticianSearchResult {
  id: string;
  distance: number;
  tags: string[];
  representations: { vector: boolean; markdown: boolean; thoughtform: boolean };
}
```

### 5.2 API Proxy Routes

These routes proxy to Polytician via its registered MCP server:

| Route | Method | Proxies To |
|-------|--------|-----------|
| `/api/polytician/[agentId]/stats` | GET | `get_stats` MCP tool |
| `/api/polytician/[agentId]/concepts` | GET | `list_concepts` MCP tool |
| `/api/polytician/[agentId]/concepts/[id]` | GET | `read_concept` MCP tool |
| `/api/polytician/[agentId]/search` | GET | `search_concepts` MCP tool (query param: `q`) |
| `/api/polytician/[agentId]/archive` | POST | `vault_archive_concept` MCP tool |

Each route:
1. Look up the agent's registered Polytician MCP server
2. Spawn/connect to Polytician via stdio
3. Call the appropriate MCP tool
4. Transform and return the result

### 5.3 React Components

**`ConceptList.tsx`** — Paginated table
- Columns: ID (truncated), Tags (badges), Representations (V/M/TF icons), Updated At
- Click row to expand and show markdown preview
- Pagination controls at bottom
- Tag filter input at top

**`SemanticSearchBar.tsx`** — Search input
- Debounced text input (300ms)
- Calls `/api/polytician/[agentId]/search?q=<query>`
- Shows results as cards with distance score bar (0.0 = exact match, 2.0 = distant)
- Click result to navigate to concept detail

**`ConceptGraph.tsx`** — Force-directed relationship graph
- Nodes = entities from ThoughtForm
- Edges = relationships from ThoughtForm
- Color-coded by entity type (PERSON=blue, ORG=green, LOC=red, CONCEPT=purple)
- Uses a lightweight SVG renderer (no heavy D3 dependency)
- Zoom and pan controls

**`ArchivePanel.tsx`** — Arweave receipts
- Lists recent archival receipts
- Shows txId, URL (clickable), timestamp, size
- "Archive Now" button per concept

### 5.4 Dashboard Tab

Add a **"Semantic Memory"** tab to the agent detail page (`webapp/src/app/agents/[id]/page.tsx`):

- Only visible when the agent has a registered Polytician MCP server
- Tab content: `<PolyticianStats>` summary card at top, `<SemanticSearchBar>`, `<ConceptList>`, `<ConceptGraph>` (toggleable)
- Refresh interval: 30 seconds for stats, manual for search/list

---

## Task 6: CLI Subcommands

**Priority:** P2
**Effort:** Medium
**Files:** `cli/commands/polytician.ts`, `cli/index.ts`

### 6.1 Command Group

Register in `cli/index.ts`:

```typescript
import { polyticianCommand } from './commands/polytician.js';
program.addCommand(polyticianCommand);
```

### 6.2 Subcommands

**`agentvault polytician status`**
- Probes Polytician health endpoint
- Calls `get_stats` and `health_check` MCP tools
- Prints formatted status table

**`agentvault polytician search <query> [--namespace ns] [--k 10]`**
- Spawns Polytician, calls `search_concepts`
- Prints results as JSON or formatted table (--json flag)

**`agentvault polytician push-all [--namespace ns]`**
- Calls `list_concepts` to get all concept IDs
- For each, calls `vault_memory_push`
- Shows progress bar (ora spinner)
- Prints summary: pushed X concepts

**`agentvault polytician pull [--namespace ns]`**
- Calls `vault_memory_pull`
- Prints summary: pulled X concepts from branch Y

**`agentvault polytician archive <concept-id>`**
- Calls `vault_archive_concept`
- Prints Arweave receipt (txId, URL, size)

**`agentvault polytician register --entry <path> [--namespace ns] [--health-port 8787]`**
- Validates Polytician is running at the health port
- Discovers available MCP tools
- Calls `registerMCPServer()` on the canister
- Prints registration confirmation

### 6.3 MCP Client Utility

Create `src/orchestration/mcp-client.ts`:

```typescript
export class PolyticianMCPClient {
  constructor(entry: string, env?: Record<string, string>)
  connect(): Promise<void>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  disconnect(): Promise<void>
}
```

Spawns Polytician as a child process, connects via stdio using `@modelcontextprotocol/sdk/client`. Reused by CLI commands, orchestrator enricher, and webapp proxy routes.

---

## Task 7: Testing

**Priority:** P1
**Effort:** Medium

### 7.1 Unit Tests for REST Bridge

For each of the 6 API routes, write tests using Vitest:
- Mock the canister client / ArweaveClient / SecretProvider
- Verify request validation (missing fields → 400)
- Verify auth check (missing token → 401)
- Verify happy path response shape
- Verify error propagation (canister error → 502)

### 7.2 Integration Test: Polytician ↔ AgentVault Round-Trip

```
1. Start Polytician with agentVault config pointing to test server
2. Save a concept via MCP tool
3. Verify concept pushed to memory_repo (mock HTTP captured)
4. Simulate memory_repo pull with test data
5. Verify concept created in Polytician
6. Call vault_infer and verify inference request routed correctly
7. Call vault_archive_concept and verify Arweave upload request
```

### 7.3 Parser Tests

- Place a `.polytician.json` in a temp directory
- Call `detectAgentType()` → expect `'polytician'`
- Call `parsePolyticianConfig()` → validate all fields
- Test detection priority (Polytician before generic)

### 7.4 Orchestrator Enrichment Tests

- Mock Polytician MCP server responses
- Call `enrichWithPolyticianContext()` with a prompt
- Verify search was called with the prompt
- Verify concepts were read
- Verify enriched prompt format
- Verify truncation at maxContextLength

---

## Implementation Order

| Phase | Tasks | Blocking |
|-------|-------|----------|
| **Phase 1** | Task 1 (REST Bridge) | Blocks all other tasks — Polytician's HTTP clients depend on these |
| **Phase 2** | Task 2 (Parser) + Task 3 (MCP Registration) | Independent of each other |
| **Phase 3** | Task 4 (Orchestrator Enrichment) | Requires Task 3 |
| **Phase 4** | Task 5 (Dashboard) + Task 6 (CLI) | Requires Tasks 1-3 |
| **Phase 5** | Task 7 (Testing) | Runs alongside all phases |

---

## Configuration

AgentVault needs these new environment variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `AGENTVAULT_POLYTICIAN_API_TOKEN` | Shared secret for authenticating Polytician REST calls | (required if Polytician integration enabled) |
| `AGENTVAULT_POLYTICIAN_ENTRY` | Path to Polytician `dist/index.js` for MCP spawning | `./node_modules/.bin/polytician` |
| `AGENTVAULT_POLYTICIAN_NAMESPACE` | Default Polytician namespace for this agent | `default` |

---

## Success Criteria

1. Polytician can push/pull concepts to AgentVault's memory_repo canister via REST
2. Polytician can use AgentVault's inference chain as its LLM provider
3. Polytician can archive concepts to Arweave via AgentVault
4. AgentVault can detect and parse Polytician as an agent type
5. AgentVault's orchestrator enriches prompts with Polytician's semantic search
6. AgentVault's dashboard shows Polytician concept stats and search
7. AgentVault CLI provides `polytician` subcommands for manual operations
8. All new code has >80% test coverage
9. Zero new runtime dependencies in AgentVault (reuse existing: `@modelcontextprotocol/sdk`)
