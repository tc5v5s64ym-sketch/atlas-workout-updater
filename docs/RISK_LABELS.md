# Atlas Risk Classification Labels

> **Status:** Active. Every PR carries exactly one primary risk label plus any useful category labels. The machine-readable manifest is `.github/labels.yml`.

Risk labels describe what authority or evidence is outstanding. They do not create a second roadmap or require Dale to click merge.

## Primary labels — exactly one

| Label | Meaning |
|---|---|
| **`auto-safe`** | Authorized campaign work with no outstanding owner-reserved data-safety/product decision. The active builder merges after deterministic hard gates pass and no real P0/P1 or high-severity/systemic defect remains unresolved. |
| **`owner-live-test`** | Genuine owner/gym/device evidence is required or explicitly held. Code may still merge when safe; the campaign card remains open until the evidence is recorded. |
| **`owner-decision`** | A product direction, production-write authorization, schema/destructive/security, Constitution/Invariant, application-model, promotion, or genuine principle-conflict decision is outstanding. |
| **`blocked`** | A required hard gate failed/missed or a real P0/P1/contract violation remains unresolved. |

`blocked` overrides the others until resolved.

## Category labels — zero or more

| Label | Meaning |
|---|---|
| **`trust-sensitive`** | Touches an invariant or trust seam; apply extra focused proof. Not automatically owner-reserved. |
| **`write-path`** | Touches Sheets write orchestration, `test_mode`, append, idempotency, or proof. Real-write tests and contract changes remain owner-reserved; ordinary authorized fixes/tests are not. |
| **`approval-path`** | Touches preview → approve → write. Existing-contract fixes may proceed; changing the authority model is owner-reserved. |
| **`coach-behavior`** | Touches coach selection/rendering. Derivable wording/rendering may proceed; philosophy, new authority, sanitizer expansion, or application-model changes are owner-reserved. |
| **`parser-behavior`** | Touches parsing/ambiguity handling. Protected grammar changes are owner-reserved; active-card clarification guards may proceed. |
| **`infrastructure`** | CI, workflows, templates, labels, scripts, governance, or repository configuration. |

Decision-desk labels such as `atlas-decision-desk` and `needs-pm-decision` are workflow labels, not primary risk classifications.

## Classification loop

1. Apply category labels for the surfaces touched.
2. Check `docs/OWNER_CHECKIN_RULES.md`.
3. Use `owner-live-test` when genuine owner evidence is the remaining gate.
4. Use `owner-decision` when an actual reserved decision/authorization is outstanding.
5. Otherwise use `auto-safe`.
6. Any missing/failed hard gate or real unresolved P0/P1 makes the PR `blocked`.
7. Record the label and rationale in the Merge Card.

The Atlas Contract / Systems Review may be required by the active governance — `CLAUDE.md` holds the one trigger list — but routine campaign work does not become owner-reserved merely because it touches an important file.

## Enforcement

The Risk label gate enforces exactly one primary label on the PR head. Whether that PR is mergeable still depends on deterministic hard gates, the Merge Card, scope, and unresolved owner authorization.

Do not add `risk-label/primary` to branch protection unless Dale explicitly chooses to do so. Label enforcement must never resurrect a paid or identity-based review lane.
