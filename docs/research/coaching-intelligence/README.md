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

## Long-horizon relationship research

[`source-archive/06-decade-relationship-coaching.md`](source-archive/06-decade-relationship-coaching.md) — **"The Ten-Year Athlete"** — is the long-horizon research source on what a decade-long coaching relationship requires: relationship memory, coach promises and receipts, trust dynamics, communication compression with tenure, and the distilled Atlas Coaching Principles. **Guidance only — it creates no roadmap or implementation items.** Its Part V checklist names the workstreams that must consult it before design (coach memory, relationship intelligence, proactivity, coach promises, injury memory, return-after-layoff behavior, decision-outcome learning, personalization, long-term programming, coach communication).

## Structure

```
docs/research/coaching-intelligence/
├── README.md                    ← this file
├── source-archive/              ← immutable sources (PDFs 01–05, markdown 06) + MANIFEST
└── digest/                      ← human-readable map, open debates, glossary

config/coaching/                 ← machine-usable config (separate tree)
```
