# Training SME Layer (on-demand education)

An **on-demand subject-matter-expert layer** so Atlas can answer resistance-training questions
intelligently when the user asks — without forcing education into normal workout logging.

## Core product rule

Atlas stays **quiet and practical during active logging**, and goes deeper only when the user asks
("why", "explain", "compare", "teach me", or a direct training/programming question).

```
log a set            → log_only       → no SME explanation
"what should I do?"  → coach_brief     → one practical line
"why 190?"           → explain         → a practical explanation
"strength vs size?"  → compare_options → a clear comparison
"teach me X"         → teach_me        → ground-up detail
"go deep on X"       → deep_dive       → fuller detail
```

## Structured, testable knowledge — not a giant prompt

Material lives in `services/trainingKnowledgeCards.js` as structured cards (20 to start), each with:
`id`, `title`, `shortAnswer`, `detailedAnswer`, `appliesToGoals`, `whenToUse`, `whenToAvoid`,
`commonMistakes`, `atlasDecisionImpact`, `confidenceLevel`, `relatedTopics`. Cards are compact, and
schema/quality tests keep them structured (`appliesToGoals` uses only canonical goal ids;
`confidenceLevel` ∈ `high | moderate | emerging | context_dependent`; ids unique; all fields present).

## Pieces

- `services/trainingQuestionClassifier.js` — deterministic `selectResponseDepth(text)` → one of the
  six depths. Logging-shaped input returns `log_only`.
- `services/trainingKnowledgeCards.js` — the cards (`CARDS`, `getCardById`, `allCardIds`).
- `services/trainingSME.js` — `findTrainingKnowledgeCards`, `selectResponseDepth`,
  `buildTrainingSMEAnswer`. Answers are **assembled from card fields**, deterministically.

## Guarantees / boundaries

- Deterministic: answers come from the cards, not invented by an LLM. (A model may later *polish*
  wording; that wiring is out of scope here.)
- This layer **does not change recommendation numbers** and **does not replace the rule engine**
  from PR #209/#210 — it explains, it does not prescribe.
- Default logging stays brief; deeper explanations happen only when the user asks.

## Not in this layer

No endpoint wiring, UI, Gemini/LLM prompt wiring, Sheets/write/approval/auth changes, analytics, or
profile schema. Pure services + tests + docs.
