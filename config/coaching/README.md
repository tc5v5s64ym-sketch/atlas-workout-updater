# config/coaching — Machine-Usable Coaching Config

Machine-usable coaching config for Atlas. Every file validates against a schema in `schemas/` and every entry embeds a `provenance` block (`schemas/provenance.schema.json`).

**Status: scaffold — no module reads these files yet.**

Tuning these values is how Atlas's behavior will later be adjusted without code changes. The schemas define the shape; the rule and exercise files define the content; a future deterministic module (ProgressionModule, FatigueModule, SafetyModule) will consume them.

For the narrative, the preserved research, and the knowledge map, see `docs/research/coaching-intelligence/`.

## Structure

```
config/coaching/
├── README.md                     ← this file
├── evidence-tiers.json           ← ranked trustworthiness of knowledge sources
├── schemas/
│   ├── provenance.schema.json    ← shared block embedded in every entry
│   ├── exercise.schema.json      ← exercise ontology entry shape
│   ├── progression-rule.schema.json
│   ├── fatigue-rule.schema.json
│   └── safety-rule.schema.json
├── exercises/
│   ├── _index.json               ← registry of all exercise IDs
│   ├── back-squat.json
│   ├── conventional-deadlift.json
│   ├── bench-press.json
│   └── pull-up.json
├── movement-patterns/
│   └── patterns.json             ← movement pattern taxonomy
└── rules/
    ├── _CONVENTIONS.md           ← rules about the rules files
    ├── progression.rules.json
    ├── fatigue.rules.json
    └── safety.rules.json
```
