# Atlas Codex Compatibility Pointer

The canonical implementation-agent brief for Atlas is [`CLAUDE.md`](CLAUDE.md).
Read it first. This file exists only for integrations that still look for
`CODEX.md`; it defines no independent role, review, branch, or merge rules and
does not override `CLAUDE.md`.

Native Codex GitHub Review is **no longer a required gate**. If Codex
auto-comments on a PR, treat it as advisory only. The required review lanes are
the deterministic GitHub CI hard gates plus a fresh clean-context Claude cold
review before any non-trivial PR merges, with the risk-triggered ChatGPT Atlas
Contract Review as the separate owner/governance lane — all defined in
`CLAUDE.md`.
