# polytician battery

Rules for the [Polytician](../../../README.md) MCP server, all 20 tools:
the 14 core tools and the 6 `vault_*` tools it registers when AgentVault is
configured. Namespaces are label compartments: a call that names a
namespace is labelled with that namespace's readers, which the bundled
`polytician` audience source reads from a file the operator keeps. One
namespace, `polytician`, is bound to the server:

```toml
include = ["batteries/polytician/appa.toml"]   # see "Install" below
```

## Versions

- **OpenAPPA 0.30.0.** The policy (version 2), the package manifest
  (schema 1) and the replay traces are checked with `appa` 0.30.0. OpenAPPA
  does not keep its TOML dialect compatible across releases, so re-run the
  checks before moving to another version.
- **Polytician 3.0** (this repository). The tool names and arguments are the
  ones `src/server.ts`, `src/mcp/tools/backup.ts` and
  `src/integrations/agent-vault/tools/vault-tools.ts` register;
  `tests/openappa-battery.test.ts` fails when a tool is added or removed
  without a contract here.

## Rules

*Compartments.* `read_concept`, `list_concepts`, `search_concepts`,
`get_stats` and `health_check` with a `namespace` restrict the result to
`@polytician:namespace/<namespace>`, the readers the audience source
reports for that namespace. `save_concept` returns the whole concept, so
its result gets the same label, and it needs trusted data that the
namespace's readers may already see (`audience.contains`); so does
`batch_save_concepts`. Data read from a namespace can therefore go only to
its readers, and cannot be written into a namespace with readers outside
them. `convert_concept` (labelled like a read) and `reembed_concepts`
derive content from the namespace's own concepts, so they need trusted
data but no audience.

*Omitted namespace.* Polytician applies `"default"` when `namespace` is
omitted, and an argument selector does not match a missing argument, so
each namespaced tool has a second rule labelled with
`@polytician:namespace/default`. A `search_concepts` call without
`namespace` is either a default-namespace search or a `crossNamespace`
search over every namespace the server allows; `crossNamespace` is a
boolean, which a selector cannot match, so both get the narrowest label,
`self`. Pass `namespace: "default"` to get the default namespace's label
instead. Polytician refuses `namespace` together with `crossNamespace`
(`VALIDATION_ERROR`), so a cross-namespace search cannot carry a single
namespace's label.

*Trust.* Every write into memory needs trusted data, so reads keep the
session's trust: suspicious text cannot enter memory and come back
trusted. `delete_concept` and `export_backup` need trusted data and record
`polytician.deleted` and `polytician.backup`; writes record
`polytician.changed`.

*Reviewed.* `import_backup` and `vault_memory_pull` write content that no
step of this trajectory wrote; `vault_memory_push` and
`vault_archive_concept` send concept content off the machine (AgentVault's
memory_repo, a permanent Arweave upload). Each needs trusted data and the
`polytician-review` mark.

*AgentVault inference.* `vault_infer` sends its prompt to AgentVault's
inference chain (Bittensor, Venice AI), so the input must be sharable with
`public`; its answer was written outside the organisation and lowers the
trajectory to `suspicious`. With `saveAsConceptNamespace` it also writes
that answer into memory, which needs trusted data and `polytician-review`.
Both record `polytician.egress`.

*Neutral and metadata reads.* `embed_text` embeds text locally and stores
nothing (`delta = {}`). `list_backups` returns file names, sizes and key
ids (`delta = {}`). `vault_get_secret` returns secret metadata (`self`), and
`vault_memory_repo_log` the memory_repo head and concept keys
(`internal`).

## Audience source

`audience-source.py` serves the selector template `namespace/<namespace>`.
`POLYTICIAN_NAMESPACE_READERS` names a JSON file, by absolute path, mapping
every namespace the server serves to its readers:

```json
{
  "version": 1,
  "namespaces": {
    "default": ["alice@corp.example", "bob@corp.example"],
    "finance": ["alice@corp.example"]
  }
}
```

Readers are email addresses, the reader IDs other audience sources report,
or `polytician:<id>` for a reader no other source knows. A namespace the
file does not list, and a missing or malformed file, are refused: OpenAPPA
gets no answer and blocks the call, so a namespace nobody mapped is neither
readable nor writable. OpenAPPA reads `namespace/default` once at start, so
the file must list `default`. The script needs `python3` and no credential.

## Root config

The battery binds its audience source and names no credential. A root
config adds:

- `[policy.audience]` `self` and `internal`, used by the cross-namespace
  search, `vault_get_secret` and `vault_memory_repo_log` rules.
- An authority permitting `polytician-review`, and data below `trusted`
  when a person may approve a write from a trajectory that read untrusted
  text. The Claude Code and kagent plugin defaults ship a human authority
  permitting both. Another root declares one:

  ```toml
  [[policy.authority]]
  name = "polytician-operator"
  hint = "Review the exact Polytician change."
  permits = { trust_below = "trusted", attention = ["polytician-review"] }

  [externals.authorities.polytician-operator]
  builtin = "hitl"
  ```

- To label one namespace with a named group instead of the file, a root
  rule ahead of the battery's (root rules match first):

  ```toml
  [[policy.tool]]
  name = "mcp/polytician/read_concept(namespace:finance)"
  delta = { audience = ["@finance"] }
  ```

  Repeat it for each tool that names the namespace, writes included.

## Install

The battery is not in the OpenAPPA marketplace yet, so `appa battery
install polytician` does not find it. Copy this directory beside the root
config as `batteries/polytician/` and add it to the root's `include`, then
bind the server name your host reports for Polytician (Claude Code reports
`mcp__<name>__<tool>`) to the `polytician` namespace if it differs:

```toml
include = ["batteries/polytician/appa.toml"]

[server_aliases]
polytician = ["<server-name>"]
```

`appa battery list` and `remove` do not manage a hand-written include; an
upgrade is a copy of the new directory.

## Limits

- Polytician does not authenticate callers per namespace: whoever holds the
  server's token may name any namespace in `POLYTICIAN_NAMESPACES`. The
  readers file states who *should* read each namespace; it is enforced
  only on trajectories APPA protects.
- Reads keep the session's trust only while every writer of these
  namespaces goes through this policy. Concepts written by an unprotected
  client, by the AgentVault sync connector (which pulls on start and on a
  timer, outside any tool call), or before the battery was installed are
  trusted on read as well. If that is not acceptable for a namespace, add
  a root rule that gives its reads `trust = "suspicious"`.
- The `source.createdBy` provenance a caller writes and a concept's
  `assertionStatus` are what the caller said; neither is checked, and the
  rules do not read them.
- With `POLYTICIAN_LLM_PROVIDER=agentvault`, LLM conversions send the
  concept's text and its neighbours' text to AgentVault inference. That
  flow is inside Polytician and outside the policy; `convert_concept`
  annotates it with `openWorldHint`.
- A `batch_save_concepts` call writes every entry into its one top-level
  `namespace`, so one contract covers the batch.

## Tests

`test_audience_source.py` covers the source without the readers file or a
network: answers, an unlisted namespace, malformed files, mismatched
templates (refused before the file is read) and other consult kinds.
`../replay/` holds a root config with a fixed roster and five traces:
compartments, the omitted namespace, cross-namespace search, an untrusted
trajectory and reviewed operations.

```sh
npm run appa:check      # from the repository root; skips appa when it is not on PATH
# or by hand:
python3 -m unittest discover -s integrations/openappa/polytician -p 'test_*.py'
export POLYTICIAN_NAMESPACE_READERS=$PWD/integrations/openappa/replay/namespace-readers.json
appa describe --config integrations/openappa/replay/appa.toml --check
appa replay --config integrations/openappa/replay/appa.toml integrations/openappa/replay/traces/
```
