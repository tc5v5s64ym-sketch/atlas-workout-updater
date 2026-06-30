# Rules File Conventions

Every rule file in this directory carries:

1. A `_meta` block at the top with these fields:
   - `status: "scaffold"` — the file is data, not active configuration
   - `behavior` — a plain-English statement that **no module reads it yet** and that building the consuming module is OUT OF SCOPE for this PR
   - `purpose` — what a future deterministic module will use it for
   - `derived_from` — array of canonical source archive IDs

2. A `provenance` block on individual entries where a source exists, matching `schemas/provenance.schema.json`.

## Rules are data, not code

These files describe what a future deterministic module **should do**. Nothing executes them in PR 1. The consuming module (ProgressionModule, FatigueModule, SafetyModule) is a future PR.

## Values are heuristics with confidence levels

Every numeric value or threshold is a heuristic, not a measurement. Entries carry `confidence` and `contested` fields. `contested: true` entries **must be surfaced honestly by the LLM later** — never asserted as settled fact.

## Tuning without code changes

Once a consuming module exists, adjusting a value here changes Atlas behavior without a code deploy. That is the architectural goal: tunable coaching knowledge, deterministic execution.
