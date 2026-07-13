# Atlas Codex Compatibility Pointer

The canonical repository instructions are in [`AGENTS.md`](AGENTS.md). This file
exists for integrations that still look for `CODEX.md`; it does not define a
second roadmap or competing authority.

Codex has two distinct contexts:

1. **Implementation:** follow `AGENTS.md`, current Atlas governance, the active
   roadmap, one-concern scope, tests, and all no-write/approval protections.
   Codex may create branches, edit, test, push, and open PRs. Codex never merges.
2. **Native GitHub review:** remain read-only and review the exact current PR head
   for correctness, security, invariants, write safety, regression risk, and
   live-path test coverage. Request/re-request it with `@codex review` after the
   final push.

Native Codex GitHub Review does not replace ChatGPT's external **Atlas Contract
Review** for roadmap fit, scope, trust, product intent, and live-path fit. Both
lanes must pass before a PR can be called merge-ready, and Dale is the only merge
authority.
