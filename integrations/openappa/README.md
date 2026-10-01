# OpenAPPA integration

[OpenAPPA](https://github.com/archestra-ai/OpenAPPA) gates an agent's tool
calls with information-flow labels: who may read what a call returns, and
whether its input can be trusted. This directory holds an OpenAPPA
*battery* for Polytician, pinned to **OpenAPPA 0.30.0**.

| Path | What it is |
|---|---|
| [`polytician/`](polytician/) | The battery, in the marketplace package format (`appa-package.toml`, `appa.toml`, the `polytician` audience source and its tests). Its [README](polytician/README.md) explains every rule, the readers file, the root config it needs and its limits. |
| [`replay/`](replay/) | A root config with a fixed roster and a readers fixture, and `.appa` traces that check the battery's decisions offline. |

Canonical tool ids are `mcp/polytician/<tool>`. Namespaces are label
compartments: what a call reads from namespace *N* may reach only *N*'s
readers, and a write into *N* needs data *N*'s readers may already see.

Check it from the repository root:

```sh
npm run appa:check
```

This runs the audience source's Python tests, then `appa describe --check`
and `appa replay` over `replay/traces/` when `appa` is on `PATH` (or `APPA`
names the binary). Without `appa` those two steps are skipped with a
message. `tests/openappa-battery.test.ts`, part of `npm test`, checks that
the battery has a contract for every tool the server registers.

The battery is meant to be upstreamed to OpenAPPA's marketplace, whose
installer accepts only its own catalog. Until then, install it by hand as
the battery README describes.
