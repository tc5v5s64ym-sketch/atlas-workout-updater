# Changelog

## [Unreleased]

### Added — Coach Intelligence Layer scaffold (PR 1)

Added `docs/research/coaching-intelligence/` and `config/coaching/` trees:

**`docs/research/coaching-intelligence/`**
- `README.md` — layer overview and prime directive
- `source-archive/README.md` — immutable source record instructions
- `source-archive/MANIFEST.json` — four-document registry with canonical IDs, titles, topics, and placeholder checksums (PDFs to be placed by Dale before merge)
- `digest/coaching-knowledge-map.md` — eleven-domain disposition table and per-domain summaries (A–K)
- `digest/open-debates.md` — seven contested areas with Atlas's explicit stance on each
- `digest/glossary.md` — plain-language definitions for 19 coaching terms

**`config/coaching/`**
- `README.md` — machine-config layer overview
- `evidence-tiers.json` — five-tier knowledge trustworthiness ranking
- `schemas/provenance.schema.json` — shared provenance block (JSON Schema draft 2020-12)
- `schemas/exercise.schema.json` — exercise ontology entry shape
- `schemas/progression-rule.schema.json` — shape of progression.rules.json
- `schemas/fatigue-rule.schema.json` — shape of fatigue.rules.json
- `schemas/safety-rule.schema.json` — shape of safety.rules.json
- `exercises/_index.json` — exercise registry (4 seeded)
- `exercises/back-squat.json`
- `exercises/conventional-deadlift.json`
- `exercises/bench-press.json`
- `exercises/pull-up.json`
- `movement-patterns/patterns.json` — 12-pattern taxonomy
- `rules/_CONVENTIONS.md` — rules-file conventions
- `rules/progression.rules.json` — six-scenario decision table, lever order, increment defaults
- `rules/fatigue.rules.json` — recovery priors, readiness inputs, deload triggers
- `rules/safety.rules.json` — traffic-light classifier, red-flag list, safe defaults

**`test/coachingIntelligence.test.js`** — 8 structural validation tests (required fields, enum values, provenance shape, index integrity, rule _meta); no coaching logic.

**Static data + docs only. No module consumes any config. No behavior, no LLM wiring, no Sheets/user-data access.**

Contested entries flagged by design: `conventional-deadlift.json` (`contested: true` — deadlift systemic-fatigue heuristic), `fatigue.rules.json` recovery priors (`contested: true`) and deload triggers (`contested: true`).
