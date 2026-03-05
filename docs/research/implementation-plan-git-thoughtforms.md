# Implementation Plan: Git-Based Shareable ThoughtForms

**Date:** 2026-03-05
**Derived From:** [Research Spike: Beads vs Pure Git](./beads-vs-git-for-thoughtforms.md)
**Architecture:** Hybrid — SQLite working store + Git sync layer

---

## Epic 1: Serialization Layer

Establish a deterministic, diff-friendly file format for ThoughtForms and build the read/write layer that bridges SQLite and the filesystem.

| # | Task | Description | Depends On |
|---|------|-------------|------------|
| 1.1 | Define canonical JSON serialization format | Design a normalized JSON schema for `.thoughtform.json` files: sorted keys, 2-space indent, one-property-per-line for arrays, stable entity/relationship ordering (by ID then predicate). Write a Zod schema for the on-disk format that extends `ThoughtFormSchema`. | — |
| 1.2 | Implement `ThoughtFormSerializer` class | Create `src/sync/serializer.ts` with `serialize(concept): string` and `deserialize(json: string): Concept` methods. Serialize must produce byte-identical output for identical inputs (deterministic). Handle round-trip fidelity for all fields including tags, metadata, timestamps. | 1.1 |
| 1.3 | Define filesystem layout convention | Implement path resolution: `<syncRoot>/concepts/<namespace>/<id>.thoughtform.json`. Create `src/sync/paths.ts` with `conceptPath(syncRoot, namespace, id)`, `namespacePath(syncRoot, namespace)`, `registryPath(syncRoot)`. Handle default namespace, path sanitization, and OS-safe filenames. | — |
| 1.4 | Build registry index file | Create `src/sync/registry.ts` that maintains `<syncRoot>/registry.json` — a lightweight index mapping concept IDs to namespace, updated_at timestamp, tags, and representation availability (has_markdown, has_thoughtform, has_embedding). Registry must be deterministically serialized for clean diffs. | 1.3 |
| 1.5 | Implement concept export (SQLite → files) | Create `src/sync/exporter.ts` with `exportConcept(id)` and `exportAll(namespace?)`. Read from SQLite via `DatabaseAdapter`, serialize via `ThoughtFormSerializer`, write to filesystem layout. Update registry on each export. Skip embeddings (binary; handled separately). | 1.2, 1.3, 1.4 |
| 1.6 | Implement concept import (files → SQLite) | Create `src/sync/importer.ts` with `importConcept(filePath)` and `importAll(syncRoot)`. Parse `.thoughtform.json` files, validate with Zod schema, upsert into SQLite via `ConceptService.save()`. Detect new vs updated concepts. Report import summary (created/updated/skipped/errored). | 1.2, 1.4 |
| 1.7 | Handle embedding exclusion strategy | Create `.gitignore` rules for embedding binary data. Implement `src/sync/embedding-manifest.ts` that writes a `<id>.embedding.meta.json` sidecar file containing dimension, model name, and content hash — but not the vector itself. On import, flag concepts that need re-embedding. | 1.3 |
| 1.8 | Add `export_concepts` MCP tool | Register a new `export_concepts` tool in `server.ts` that exposes export functionality. Parameters: namespace (optional), tag filter (optional), output directory (optional, defaults to `.polytician/sync`). Returns list of exported file paths and count. | 1.5 |
| 1.9 | Add `import_concepts` MCP tool | Register a new `import_concepts` tool in `server.ts` that exposes import functionality. Parameters: source directory, namespace override (optional), dry_run flag. Returns import summary with created/updated/skipped/errored counts. | 1.6 |
| 1.10 | Write serialization round-trip tests | Create `tests/sync/serializer.test.ts` with tests for: deterministic output, round-trip fidelity, edge cases (empty entities, unicode text, null fields, large ThoughtForms), and format stability (snapshot tests). | 1.2 |

---

## Epic 2: Git Sync Engine

Build a TypeScript module that wraps `simple-git` to provide commit, push, pull, and status operations scoped to ThoughtForm files.

| # | Task | Description | Depends On |
|---|------|-------------|------------|
| 2.1 | Add `simple-git` dependency and configure | Add `simple-git` to `package.json`. Create `src/sync/git-client.ts` that initializes a `SimpleGit` instance pointed at the sync root. Detect whether sync root is inside an existing git repo or needs `git init`. Handle git availability detection (graceful fallback if git not installed). | Epic 1 |
| 2.2 | Implement `GitSyncService` core class | Create `src/sync/git-sync.service.ts` with lifecycle methods: `initialize(syncRoot)`, `status()`, `isClean()`, `currentBranch()`. The service wraps `simple-git` and adds ThoughtForm-aware logic. Singleton pattern consistent with other services. | 2.1 |
| 2.3 | Implement auto-commit on concept save | Add `commit(conceptId, message?)` method to `GitSyncService`. Stage only the changed `.thoughtform.json` file and registry. Generate structured commit messages: `thoughtform(<namespace>): <verb> <concept-id>` where verb is create/update/delete. Hook into `ConceptService` event bus (`concept.created`, `concept.updated`, `concept.deleted`). | 2.2, 1.5 |
| 2.4 | Implement configurable commit strategies | Create `src/sync/commit-strategy.ts` with three modes: (a) `immediate` — commit on every save, (b) `batched` — collect changes and commit on explicit flush or timer, (c) `manual` — only commit when user triggers. Add `POLYTICIAN_GIT_COMMIT_STRATEGY` config option. | 2.3 |
| 2.5 | Implement push/pull operations | Add `push(remote?, branch?)` and `pull(remote?, branch?)` to `GitSyncService`. After pull, detect changed `.thoughtform.json` files via `git diff` and trigger selective import for only changed concepts. Handle authentication passthrough (SSH agent, credential helpers). | 2.2, 1.6 |
| 2.6 | Implement conflict detection on pull | After `git pull`, check for merge conflicts in `.thoughtform.json` files. Create `src/sync/conflict-detector.ts` that parses `git status` for conflicted paths, extracts ours/theirs/base versions using `git show`, and returns structured conflict objects: `{ conceptId, base, ours, theirs }`. | 2.5 |
| 2.7 | Add `sync_push` and `sync_pull` MCP tools | Register MCP tools: `sync_push` (export changed concepts + commit + push) and `sync_pull` (pull + import changed concepts). Parameters: remote name, branch, commit message override. Return summary of synced concepts and any conflicts. | 2.5, 1.8, 1.9 |
| 2.8 | Add `sync_status` MCP tool | Register MCP tool that returns: current branch, remote tracking info, uncommitted ThoughtForm changes (new/modified/deleted), unpushed commits count, last sync timestamp. Combine `git status`, `git log`, and registry diff. | 2.2 |
| 2.9 | Implement sync root initialization | Create `src/sync/init.ts` with `initSyncRoot(path, options)`. Options: `standalone` (new git repo), `embedded` (subdirectory of existing repo), `stealth` (gitignored local-only, inspired by Beads). Write `.polytician.yaml` config file with sync settings. Add `init_sync` MCP tool. | 2.1 |
| 2.10 | Write git sync integration tests | Create `tests/sync/git-sync.test.ts` using temporary git repos. Test: init, commit, push/pull between two repos, conflict detection, auto-commit on save, batched commits, status reporting. Use `simple-git` to set up test fixtures. | 2.2–2.6 |

---

## Epic 3: Custom Merge Driver

Build a git merge driver that understands ThoughtForm structure and performs field-level three-way merge instead of line-level text merge.

| # | Task | Description | Depends On |
|---|------|-------------|------------|
| 3.1 | Design three-way merge algorithm for ThoughtForms | Document the merge strategy for each ThoughtForm component: (a) metadata — last-writer-wins for scalar fields, set-union for tags, (b) entities — merge by entity ID, detect add/remove/modify, (c) relationships — merge by (subject, predicate, object) key, (d) contextGraph — regenerate from merged relationships. Write decision table for conflict cases. | Epic 1 |
| 3.2 | Implement `ThoughtFormMerger` class | Create `src/sync/merger.ts` with `merge(base, ours, theirs): MergeResult`. `MergeResult` contains merged ThoughtForm + list of conflicts (if any). Each conflict identifies the component (entity/relationship/metadata), the field, and the three values. | 3.1, 1.2 |
| 3.3 | Implement entity-level merge | Within `ThoughtFormMerger`, add `mergeEntities(base, ours, theirs)`. Match entities by ID. Handle: both sides add same entity (identical = auto-merge, different = conflict), one side deletes while other modifies (conflict), both modify same entity field (conflict on that field, auto-merge others). | 3.2 |
| 3.4 | Implement relationship-level merge | Within `ThoughtFormMerger`, add `mergeRelationships(base, ours, theirs)`. Key relationships by `(subjectId, predicate, objectId)` tuple. Handle: new relationships from both sides (union), deleted relationships (remove if either side deleted and other didn't modify), confidence changes (last-writer-wins or average). | 3.2 |
| 3.5 | Implement context graph regeneration | After merging entities and relationships, regenerate `contextGraph` from the merged relationship set. Create `src/sync/graph-builder.ts` with `buildContextGraph(entities, relationships): Record<string, string[]>`. This avoids merging the graph directly (which is a derived structure). | 3.3, 3.4 |
| 3.6 | Build git merge driver executable | Create `src/sync/merge-driver.ts` as a CLI entry point that git calls during merge. Reads `%O` (base), `%A` (ours), `%B` (theirs) file paths from argv. Runs `ThoughtFormMerger`, writes result to `%A`. Exit 0 on clean merge, exit 1 on conflicts (writing conflict markers as structured JSON comments). Add to `package.json` bin field. | 3.2 |
| 3.7 | Generate `.gitattributes` configuration | In `initSyncRoot()`, write `.gitattributes` with: `*.thoughtform.json merge=thoughtform-merge`. Provide setup instructions or auto-configure via `git config merge.thoughtform-merge.driver "npx polytician-merge %O %A %B"`. | 3.6, 2.9 |
| 3.8 | Implement conflict resolution UI helpers | Create `src/sync/conflict-resolver.ts` with resolution strategies: `acceptOurs(conflict)`, `acceptTheirs(conflict)`, `acceptBoth(conflict)` (for additive changes), `manual(conflict, resolution)`. Add `resolve_conflict` MCP tool that accepts concept ID + resolution strategy per conflicted component. | 3.2, 2.6 |
| 3.9 | Handle partial merge with conflict report | When merge produces conflicts, write the clean-merged portions to the output file and append a `_conflicts` sidecar file (`<id>.thoughtform.conflicts.json`) listing unresolved conflicts with base/ours/theirs values. The `sync_status` tool should surface these. | 3.6, 3.8, 2.8 |
| 3.10 | Write merge driver unit and integration tests | Create `tests/sync/merger.test.ts` with cases: clean merge (no conflicts), entity add/add (same), entity add/add (different), entity modify/delete, relationship add from both sides, tag set union, metadata timestamp conflict, full integration test simulating `git merge` with the custom driver. | 3.2–3.6 |

---

## Epic 4: Collaboration Primitives

Build the workflows that let users fork, branch, share, and contribute ThoughtForms using familiar git collaboration patterns.

| # | Task | Description | Depends On |
|---|------|-------------|------------|
| 4.1 | Implement branch management for ThoughtForms | Add `createBranch(name)`, `switchBranch(name)`, `listBranches()`, `deleteBranch(name)` to `GitSyncService`. On branch switch, re-import all ThoughtForms from the new branch's files into SQLite (or maintain branch-indexed SQLite state). Handle dirty state warnings. | Epic 2 |
| 4.2 | Implement fork detection and upstream tracking | Create `src/sync/remote-manager.ts` with `addRemote(name, url)`, `listRemotes()`, `setUpstream(branch, remote)`. Detect fork relationship by checking if remote URL differs from origin. Track upstream/downstream for `sync_status` reporting. | 2.2 |
| 4.3 | Build `fork_concepts` MCP tool | Create a tool that: (a) creates a new git branch, (b) optionally filters to a subset of concepts by namespace/tags, (c) copies selected concepts to the new branch, (d) sets up tracking. This enables "fork this knowledge domain" workflows where an agent branches a subset of concepts to evolve independently. | 4.1, 1.5 |
| 4.4 | Build `share_concepts` MCP tool | Create a tool that packages selected concepts for sharing: (a) export to normalized JSON, (b) commit with descriptive message, (c) push to specified remote/branch. Parameters: concept IDs or tag/namespace filter, remote, branch, commit message. Returns push result + shareable URL if GitHub remote detected. | 2.5, 1.5 |
| 4.5 | Implement pull request description generator | Create `src/sync/pr-generator.ts` that analyzes ThoughtForm diffs between branches and generates a structured PR description: summary of concepts added/modified/deleted, entity count changes, new relationships, tag changes. Output as markdown suitable for GitHub PR body. | 1.2, 2.2 |
| 4.6 | Build `merge_branch` MCP tool | Create a tool that merges a source branch into the current branch for ThoughtForm files. Uses the custom merge driver (Epic 3). Reports clean merges, auto-resolved merges, and conflicts requiring manual resolution. Optionally auto-commit on clean merge. | 4.1, Epic 3 |
| 4.7 | Implement rebase support for ThoughtForm branches | Add `rebaseBranch(onto)` to `GitSyncService`. Rebase replays ThoughtForm commits from the current branch onto the target. After rebase, re-import to sync SQLite with the rebased file state. Handle rebase conflicts by surfacing them through the conflict resolution flow (Epic 3). | 4.1, 3.8 |
| 4.8 | Build contributor mode (inspired by Beads) | Implement `--contributor` mode from `initSyncRoot()`: route ThoughtForm files to a separate directory (e.g., `~/.polytician/contributions/<project>/`) instead of the main repo. This keeps experimental concepts out of PRs until explicitly promoted. Add `promote_concepts` tool to move from contributor space to main repo. | 2.9, 1.5, 1.6 |
| 4.9 | Build stealth mode (inspired by Beads) | Implement `--stealth` mode: ThoughtForm sync files are written to a gitignored directory within the repo (`.polytician/local/`). Concepts are versioned locally via git but never pushed. Useful for personal knowledge on shared projects. Add mode switching: stealth → tracked promotion. | 2.9 |
| 4.10 | Write collaboration workflow integration tests | Create `tests/sync/collaboration.test.ts` simulating multi-user workflows: (a) user A creates concepts, pushes; user B pulls, modifies, pushes; user A pulls and merges, (b) fork + diverge + PR merge, (c) rebase workflow, (d) contributor mode promote flow. Use temp git repos with multiple clones. | 4.1–4.9 |

---

## Epic 5: Agent-Optimized Features

Build features specifically designed for AI agent workflows, inspired by Beads' innovations around context management, readiness detection, and multi-agent coordination.

| # | Task | Description | Depends On |
|---|------|-------------|------------|
| 5.1 | Implement semantic memory compaction | Create `src/sync/compaction.ts` with `compactConcept(id)` that uses the LLM provider to summarize old/low-activity ThoughtForms into condensed versions. Preserve entity IDs and key relationships but reduce `rawText` and collapse low-confidence entities. Store compaction metadata (original size, compacted size, compaction date). Add `POLYTICIAN_COMPACTION_THRESHOLD_DAYS` config. | Epic 1 |
| 5.2 | Build compaction scheduling and triggers | Create `src/sync/compaction-scheduler.ts` that identifies compaction candidates: concepts not updated in N days, concepts with low search hit counts, concepts exceeding a size threshold. Run on a configurable interval or on-demand via `compact_concepts` MCP tool. Respect a `never_compact` tag. | 5.1 |
| 5.3 | Implement concept readiness detection | Create `src/sync/readiness.ts` with `assessReadiness(id): ReadinessReport`. A concept is "ready" (for sharing/review) when: (a) it has all three representations (markdown + thoughtform + embedding), (b) entity confidence scores are above threshold, (c) no unresolved conflicts, (d) no `draft` tag. Add `list_ready_concepts` MCP tool that surfaces share-ready concepts. | Epic 1, Epic 3 |
| 5.4 | Add `supersedes` and `duplicates` relationship types | Extend the ThoughtForm relationship predicates (inspired by Beads' link types) to include `supersedes` (this concept replaces an older one) and `duplicates` (this concept overlaps with another). Add `link_concepts` MCP tool for creating these meta-relationships. Update search to optionally follow/exclude superseded concepts. | — |
| 5.5 | Implement concept lineage tracking | Create `src/sync/lineage.ts` that tracks concept provenance through git history. `getLineage(id)` returns: creation commit, all modification commits, which branches it exists on, fork/merge points, authors. Uses `git log -- <file>` for file-level history. Add `concept_history` MCP tool. | Epic 2 |
| 5.6 | Build multi-agent coordination layer | Create `src/sync/agent-coordinator.ts` that manages multi-agent workflows: (a) agent identity registration (agent ID ↔ namespace mapping), (b) concept locking (advisory, via lock files in git), (c) work-in-progress signaling (WIP tags), (d) handoff protocol (agent A marks concepts for agent B's namespace). Add `register_agent` and `handoff_concepts` MCP tools. | Epic 2, Epic 4 |
| 5.7 | Implement context budget advisor | Create `src/sync/context-advisor.ts` with `adviseForContext(budgetTokens, query?)`. Given a token budget, return the optimal set of concepts to include in an agent's context: prioritize by relevance (vector similarity to query), recency, readiness, and relationship density. Use compacted versions for older concepts. Add `get_context_pack` MCP tool. | 5.1, 5.3 |
| 5.8 | Build change digest for agent catch-up | Create `src/sync/digest.ts` with `generateDigest(since: Date | commitHash)`. Produces a structured summary of all ThoughtForm changes since a point in time: new concepts, modified concepts (with diff summaries), deleted concepts, new relationships, conflict resolutions. Designed for agents resuming work after a gap. Add `get_change_digest` MCP tool. | Epic 2, 1.2 |
| 5.9 | Implement concept dependency graph | Create `src/sync/dependency-graph.ts` that builds a DAG from ThoughtForm relationships. `getBlockers(id)` returns concepts that must be finalized before this one (based on relationship predicates). `getReadyQueue()` returns concepts with no open blockers (inspired by Beads' `bd ready`). Useful for agents planning knowledge-building sequences. Add `concept_dependencies` MCP tool. | 5.4 |
| 5.10 | Write agent workflow integration tests | Create `tests/sync/agent-features.test.ts` testing: compaction round-trip (original → compacted → still searchable), readiness assessment, lineage tracking through branches, multi-agent lock/handoff, context budget optimization, change digest accuracy, dependency graph ordering. | 5.1–5.9 |

---

## Dependency Graph (Epic Level)

```
Epic 1: Serialization Layer
    ↓
Epic 2: Git Sync Engine ←──────────────────┐
    ↓                                       │
Epic 3: Custom Merge Driver                 │
    ↓                                       │
Epic 4: Collaboration Primitives ───────────┘
    ↓
Epic 5: Agent-Optimized Features
```

Epics are sequential at the macro level, but tasks within each epic can be parallelized along the dependency chains shown in each table.

---

## Success Criteria

| Property | Metric |
|---|---|
| **Shareable** | Two separate Polytician instances can push/pull ThoughtForms via git remotes with zero data loss |
| **Mergeable** | Concurrent edits to different entities within the same ThoughtForm auto-merge cleanly; conflicting edits surface structured conflict objects |
| **Rebaseable** | A branch of ThoughtForm changes can be rebased onto an updated main branch with the custom merge driver handling conflicts |
| **Forkable** | A user can fork a concept namespace, evolve it independently, and submit changes back via PR with a generated description |

---

## Estimated Scope

- **50 tasks** across 5 epics
- **New files:** ~20 TypeScript modules in `src/sync/`
- **New MCP tools:** ~15 tools
- **New test files:** ~5 test suites in `tests/sync/`
- **New dependencies:** `simple-git`
- **No new infrastructure:** git is the only external dependency
