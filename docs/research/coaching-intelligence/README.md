# Coach Intelligence Layer — Human Entry Point

This folder holds the human-facing material for Atlas's **Coach Intelligence Layer**: the preserved source research (`source-archive/`) and a readable map of it (`digest/`). The machine-usable config — schemas, exercise ontology, evidence tiers, and rules — lives separately under **`config/coaching/`**.

## Prime directive

The LLM is the voice; the code is the brain. This layer stores coaching *knowledge* as structured data with provenance. Decisions that need consistency will later be made by deterministic modules that read `config/coaching/`; the LLM only explains, asks, motivates, and personalizes language. It never invents numbers, verdicts, or rules.

## This PR (PR 1)

**Preserves and structures the research only. No module consumes any of this yet.**

## Rule of thumb for future PRs

Every piece of research resolves to one of:

| Category | Where it lands |
|---|---|
| **Rule** | `config/coaching/rules/` |
| **Config value** | `config/coaching/` (schemas/exercises/movement-patterns) |
| **Ontology field** | `config/coaching/exercises/` or `config/coaching/movement-patterns/` |
| **Coach-memory concept** | future per-user memory store |
| **Safety guardrail** | `config/coaching/rules/safety.rules.json` |
| **LLM explanation material** | LLM prompt layer (future) |

## Structure

```
docs/research/coaching-intelligence/
├── README.md                    ← this file
├── source-archive/              ← immutable source PDFs + MANIFEST
└── digest/                      ← human-readable map, open debates, glossary

config/coaching/                 ← machine-usable config (separate tree)
```
