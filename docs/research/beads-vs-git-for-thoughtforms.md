# Research Spike: Beads vs Pure Git for Shareable ThoughtForms

**Date:** 2026-03-04
**Status:** Draft
**Goal:** Evaluate whether Beads (Steve Yegge's agent memory system) or a pure git commit-based approach is better suited for making Polytician ThoughtForms more shareable, mergeable, rebaseable, and forkable.

---

## 1. Context: What Polytician ThoughtForms Are Today

Polytician is a local-first MCP server that acts as a semantic memory store for AI agents. A **ThoughtForm** is a structured JSON representation of a concept containing:

- **Entities** — named entities with NER types, confidence scores, and character offsets
- **Relationships** — subject-predicate-object triples linking entities
- **Context Graph** — adjacency list of entity connections
- **Metadata** — timestamps, author, tags, source provenance

ThoughtForms live in a SQLite database (or PostgreSQL) alongside vector embeddings and markdown representations. They are versioned via an integer `version` column with optimistic concurrency control (OCC). There is no built-in branching, merging, forking, or distributed sync beyond namespace isolation and an event bus.

### Current Gaps

| Capability | Current State |
|---|---|
| **Sharing** | Namespace isolation only; no export/import protocol |
| **Merging** | OCC conflict detection, but no resolution strategy beyond "retry" |
| **Rebasing** | Not supported |
| **Forking** | Not supported — concepts are mutable singletons |
| **History** | No audit trail; version counter only, no snapshots |
| **Multi-agent collaboration** | Namespace partitioning, no cross-namespace merging |

---

## 2. Beads: Architecture Overview

**Beads** ([github.com/steveyegge/beads](https://github.com/steveyegge/beads)) is a distributed, git-backed graph issue tracker designed as persistent memory for AI coding agents. Written in Go (~130k LOC, half tests), it has 17.9k GitHub stars and tens of thousands of users.

### Key Design Decisions

| Decision | Implementation |
|---|---|
| **Storage engine** | Dolt — a version-controlled SQL database built on Prolly trees |
| **Identity** | Hash-based IDs (`bd-a1b2`) to prevent merge collisions |
| **Structure** | Hierarchical tasks: `bd-a3f8` → `bd-a3f8.1` → `bd-a3f8.1.1` |
| **Relationships** | Link types: `relates_to`, `duplicates`, `supersedes`, `replies_to` + dependency/blocking |
| **Sync** | Dolt remotes (push/pull) or git-backed JSONL |
| **Merge strategy** | Dolt's cell-level three-way merge with conflict detection |
| **Branching** | Native Dolt branches — each branch is an isolated DB instance |
| **Multi-agent** | Hash IDs eliminate collision; redirect files for shared DBs |
| **Context management** | Semantic "memory decay" compacts old tasks to save context window |

### How Beads Handles the Four Properties

**Shareable:** Dolt remotes work like git remotes. `bd dolt push` / `bd dolt pull` sync databases across machines. Redirect files let multiple git clones share a single Beads database.

**Mergeable:** Dolt performs three-way merge at the cell level. Content-addressed Prolly trees enable efficient diff. Hash-based IDs mean concurrent creation on different branches doesn't collide. Conflicts surface via `bd vc conflicts` and resolve via `bd vc resolve`.

**Rebaseable:** Dolt supports rebase-like operations through its commit graph, though Beads' own rebase support is still evolving (Yegge notes "broken rebases" and "conflicts that need manual resolution" are ongoing edge cases).

**Forkable:** Contributor mode (`bd init --contributor`) routes to a separate database. Stealth mode (`bd init --stealth`) enables local-only operation. Dolt's fork semantics mirror git's.

### Strengths

- Purpose-built for agent memory with dependency-aware task graphs
- Dolt gives SQL query power + git-style version control in one system
- Cell-level merge is more granular than file-level git merge
- Hash-based IDs are a proven solution for distributed identity
- Large community, rapid iteration, battle-tested in multi-agent workflows

### Weaknesses

- **Heavy dependency:** Requires Dolt runtime (~400MB binary), a non-trivial dependency
- **Complexity:** 130k LOC; merge conflicts are a known ongoing pain point
- **Opinionated data model:** Built for issues/tasks, not arbitrary structured data like ThoughtForms
- **Go ecosystem:** Polytician is TypeScript; integration would require FFI, subprocess, or a rewrite
- **Not a knowledge graph:** Beads models task dependencies, not entity-relationship-context graphs
- **Rebase maturity:** Self-admittedly still fragile for rebase workflows

---

## 3. Pure Git Commit-Based Approach

A pure git approach would serialize ThoughtForms to files in a git repository and leverage git's native branching, merging, and collaboration primitives.

### Proposed Architecture

```
.polytician/
├── concepts/
│   ├── <namespace>/
│   │   ├── <concept-id>.thoughtform.json
│   │   ├── <concept-id>.md
│   │   └── <concept-id>.embedding.bin
│   └── default/
│       └── ...
├── registry.json          # Index of all concepts with metadata
└── .polytician.yaml       # Config (remotes, sync settings)
```

Each ThoughtForm becomes a JSON file tracked by git. The concept ID serves as the filename. Changes produce git commits with structured messages.

### How Git Handles the Four Properties

**Shareable:** Git remotes, push/pull, SSH/HTTPS auth — the most widely understood collaboration protocol in software. GitHub/GitLab provide hosting, access control, and discovery. ThoughtForms become first-class citizens in a repo that can be cloned, starred, and discovered.

**Mergeable:** Git's three-way merge operates at the line level on JSON files. For structured JSON, a custom merge driver (e.g., `git-json-merge`) could provide field-level merge. Alternatively, each entity/relationship could be its own file for more granular merge units.

**Rebaseable:** Git rebase is mature and well-understood. ThoughtForm commits can be reordered, squashed, and replayed. Interactive rebase lets users curate concept histories.

**Forkable:** Git fork is the gold standard. GitHub's fork model gives every user their own copy with upstream tracking. ThoughtForm contributions flow via pull requests with code review.

### Design Considerations

#### Option A: Monolithic JSON Files

Each concept is one `.thoughtform.json` file.

- **Pro:** Simple, one file per concept, easy to read
- **Con:** Line-level merge on JSON is fragile (trailing commas, bracket alignment)
- **Mitigation:** Use a custom merge driver, or normalize JSON with sorted keys and one-property-per-line formatting

#### Option B: Exploded File Structure

```
concepts/<id>/
├── meta.json              # metadata only
├── entities/
│   ├── <entity-id>.json   # one file per entity
│   └── ...
├── relationships/
│   ├── <rel-hash>.json    # one file per relationship
│   └── ...
└── context-graph.json     # adjacency list
```

- **Pro:** Extremely granular merge — entity-level, relationship-level changes don't conflict
- **Con:** File proliferation; potentially thousands of tiny files per concept
- **Mitigation:** Only explode on export for collaboration; keep SQLite as working store

#### Option C: JSONL Append-Only Log

Each change to a ThoughtForm appends a line to a JSONL file (similar to Beads' original storage).

- **Pro:** Append-only means almost zero merge conflicts; easy to concatenate
- **Con:** Requires compaction/replay to reconstruct current state; harder to read
- **Mitigation:** Periodic snapshots + compaction (like Beads' memory decay)

#### Option D: Hybrid — SQLite Working Store + Git Sync Layer

Keep SQLite as the primary working database. Add a sync layer that:
1. Exports changed ThoughtForms to normalized JSON files on commit
2. Imports ThoughtForm JSON files from git pull/merge into SQLite
3. Uses git for branching, history, and collaboration

- **Pro:** Best of both worlds — fast local queries via SQLite, collaboration via git
- **Con:** Two sources of truth; sync layer is new code to maintain
- **This is essentially what Beads does** with Dolt replacing SQLite+git

### Strengths of Pure Git

- **Zero new dependencies** — git is already required (Polytician is a git repo)
- **Universal tooling** — GitHub, GitLab, Gitea, etc. provide hosting, PRs, access control
- **Mature rebase** — git rebase is decades-old and battle-hardened
- **Human-readable diffs** — JSON diffs are reviewable in PRs
- **TypeScript native** — libraries like `simple-git`, `isomorphic-git` integrate seamlessly
- **Proven at scale** — billions of repos, well-understood operational model
- **Composable** — ThoughtForms live alongside code, tests, docs in the same repo

### Weaknesses of Pure Git

- **Line-level merge is too coarse for JSON** — structured data needs field-level merge
- **No query engine** — git doesn't support SQL-style queries over ThoughtForms
- **File proliferation** — exploded format creates many files
- **Embedding storage** — binary blobs (384-dim float32 vectors) don't diff well in git
- **Performance** — large repos with thousands of concepts may slow git operations
- **No built-in cell-level conflict resolution** — requires custom tooling

---

## 4. Comparative Analysis

| Dimension | Beads (Dolt) | Pure Git | Winner |
|---|---|---|---|
| **Shareability** | Dolt remotes + redirects | Git remotes + GitHub ecosystem | **Git** — larger ecosystem, more familiar |
| **Mergeability** | Cell-level three-way merge | Line-level (or custom field-level) | **Beads** — cell-level merge is structurally superior |
| **Rebaseability** | Early/fragile | Mature/battle-tested | **Git** — decades of rebase refinement |
| **Forkability** | Contributor/stealth modes | GitHub fork model | **Git** — fork is a first-class primitive |
| **Query power** | Full SQL via Dolt | None (must load into memory or maintain index) | **Beads** — SQL over versioned data is powerful |
| **Dependency footprint** | Dolt binary (~400MB) + Go runtime | git (already present) | **Git** — zero marginal cost |
| **Data model fit** | Task/issue-oriented | Schema-agnostic | **Git** — ThoughtForms aren't tasks |
| **Ecosystem fit** | Go; requires integration bridge | TypeScript-native | **Git** — same language, same toolchain |
| **Operational maturity** | ~1 year old; edge cases acknowledged | 20+ years; well-understood | **Git** — proven reliability |
| **Multi-agent support** | Hash IDs + Dolt branches | Namespace dirs + git branches | **Tie** — both viable with design work |
| **Embedding storage** | Dolt BLOB columns | Git LFS or exclude from sync | **Beads** — binary data in DB is natural |
| **Context window mgmt** | Built-in compaction/decay | Must build separately | **Beads** — purpose-built for agents |

---

## 5. Recommendation

### Use a **hybrid git-based approach** (Option D) rather than adopting Beads directly.

#### Rationale

1. **Data model mismatch:** Beads is built for issue/task tracking with dependency graphs. ThoughtForms are entity-relationship-context graphs — fundamentally different structures. Adapting Beads would mean either (a) shoehorning ThoughtForms into Beads' task model, losing semantic richness, or (b) forking Beads and maintaining a parallel codebase.

2. **Dependency cost:** Adding Dolt (400MB binary, Go runtime, new operational surface) is a large cost for a project that values being "local-first" and lightweight. Git is already present.

3. **Ecosystem alignment:** Polytician is TypeScript. Git has excellent TypeScript libraries (`simple-git`, `isomorphic-git`). Dolt/Beads integration would require subprocess management or FFI.

4. **Rebase maturity:** Yegge himself acknowledges rebase is still fragile in Beads. Git rebase is mature and well-understood.

5. **Borrow the best ideas from Beads:**
   - **Hash-based IDs** — already using UUIDs, which serve the same purpose
   - **Cell-level merge concept** — implement a custom JSON merge driver for ThoughtForms
   - **Memory decay/compaction** — build a summarization layer for old ThoughtForms
   - **Contributor/stealth modes** — map to git branch strategies

### Proposed Implementation Path

```
Phase 1: Serialization Layer
  - Export ThoughtForms to normalized JSON (sorted keys, stable formatting)
  - One file per concept: concepts/<namespace>/<id>.json
  - Exclude embeddings from git (store in .gitignore'd SQLite or git-lfs)
  - Registry index file for fast lookups without reading all files

Phase 2: Git Sync Engine
  - TypeScript module wrapping simple-git
  - Auto-commit on ThoughtForm save (configurable)
  - Import from git: parse JSON files back into SQLite
  - Conflict detection: compare incoming vs local versions

Phase 3: Custom Merge Driver
  - Register .thoughtform.json merge driver in .gitattributes
  - Field-level merge: metadata, entities, relationships merged independently
  - Entity merge by entity ID (add/remove/update)
  - Relationship merge by subject+predicate+object key
  - Context graph regenerated from merged relationships

Phase 4: Collaboration Primitives
  - Fork: clone repo, modify ThoughtForms, submit PR
  - Branch: create git branch for experimental concept evolution
  - Rebase: git rebase works naturally on JSON files
  - Share: push to remote; others pull and import

Phase 5: Agent-Optimized Features (inspired by Beads)
  - Compaction: summarize old ThoughtForms to reduce context window usage
  - Dependency tracking: use relationship graph for task-like dependencies
  - Multi-agent: namespace dirs map to agent identities
```

---

## 6. Key Risks and Mitigations

| Risk | Mitigation |
|---|---|
| JSON merge conflicts on large ThoughtForms | Custom merge driver (Phase 3); normalized formatting |
| Performance with thousands of concept files | Registry index; lazy loading; periodic archival |
| Binary embedding storage in git | Exclude from git; use LFS or separate sync channel |
| Two sources of truth (SQLite + git) | SQLite is authoritative; git is the sync/collaboration layer |
| Scope creep rebuilding Dolt-like features | Stay disciplined — git provides 80% of version control; only build the JSON merge driver |

---

## 7. What to Borrow from Beads

Even without adopting Beads directly, several of its innovations are worth incorporating:

1. **Hash-based identity** — Polytician already uses UUIDs; ensure they're deterministic enough for collision-free distributed creation
2. **Hierarchical structure** — Consider parent-child concept relationships (`concept.subconcept`) for organizing complex knowledge
3. **Memory decay** — Implement semantic compaction for old/low-relevance ThoughtForms to manage context budgets
4. **Stealth mode** — Allow local-only ThoughtForm development without polluting shared repos
5. **Ready detection** — Analogous to `bd ready`: surface ThoughtForms that are complete and ready for sharing/review
6. **Link types** — Extend relationships with `supersedes` and `duplicates` predicates for concept evolution tracking

---

## 8. Sources

- [steveyegge/beads — GitHub](https://github.com/steveyegge/beads)
- [Introducing Beads — Steve Yegge (Medium)](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a)
- [Beads Best Practices — Steve Yegge (Medium)](https://steve-yegge.medium.com/beads-best-practices-2db636b9760c)
- [The Beads Revolution — Steve Yegge (Medium)](https://steve-yegge.medium.com/the-beads-revolution-how-i-built-the-todo-system-that-ai-agents-actually-want-to-use-228a5f9be2a9)
- [Beads Advanced Docs](https://github.com/steveyegge/beads/blob/main/docs/ADVANCED.md)
- [Dolt — Git for Data (GitHub)](https://github.com/dolthub/dolt)
- [Dolt Three-Way Merge](https://www.dolthub.com/blog/2024-06-19-threeway-merge/)
- [Dolt Branching](https://www.dolthub.com/blog/2024-09-18-database-branches/)
- [beads_rust — Rust Port](https://github.com/Dicklesworthstone/beads_rust)
