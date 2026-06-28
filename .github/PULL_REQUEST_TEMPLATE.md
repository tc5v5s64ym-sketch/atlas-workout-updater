<!--
Atlas Merge Card — keep it to one screen.
Fill every field. An empty field is treated as a FAILURE (see docs/AUTOMATION_PROTOCOL.md §2).
A green card requires positive evidence that each signal ran and passed — not the absence of a failure.
Full rules: docs/AUTOMATION_PROTOCOL.md · docs/OWNER_CHECKIN_RULES.md · docs/RISK_LABELS.md
-->

## 🟦 Atlas Merge Card

| Field | Value |
|---|---|
| **PR** | #<!-- number, filled after open --> |
| **Title** | <!-- one line --> |
| **Risk level** | <!-- low / medium / high --> |
| **Files / categories touched** | <!-- e.g. docs-only · infrastructure · services/analytics.js (engine) --> |
| **Tests** | <!-- pass / fail / not-run — not-run = FAIL --> |
| **Codex status** | <!-- READY FOR OWNER MERGE / NON-BLOCKING / BLOCKING / not-run(=FAIL) --> |
| **Claude status** | <!-- review passed / changes-requested / errored(=FAIL) / not-run(=FAIL) --> |
| **Owner action required** | <!-- No · or Yes + which check-in criterion 2–8 from OWNER_CHECKIN_RULES.md — criterion 1 (live test) is NEVER "Yes": live tests are post-merge, not pre-merge gates --> |
| **Live test script** | <!-- steps for the owner after deployment if owner-live-test, else "n/a" --> |
| **Merge recommendation** | <!-- merge-ready / fix-then-merge / hold-for-owner — owner-live-test never produces hold-for-owner --> |

<!--
Reminder: skipped / errored / unavailable / incomplete review = FAILURE, not a pass.
merge-ready requires: tests pass · required reviews pass · no P0/P1 · no unresolved contract
violation · risk classification done · this card complete.
-->

---

### Concern (one per PR)

<!-- One sentence: the single concern this PR addresses. If it grew to two, split it. -->

### Current-state verdict

<!-- STILL BROKEN / ALREADY FIXED / PARTIALLY FIXED / FIXED BUT UNTESTED / STALE-SUPERSEDED / NEEDS OWNER APP-TEST -->

### Model

Opus 4.8 (builder runs on Opus for all work — owner standing instruction). Risk level: see merge card.

### Trust / scope safety

- [ ] No write-path change (or write-path change is explicitly scoped + owner-flagged)
- [ ] No Sheet schema change (12-col Log_Cleaned / 9-col Effort / 5-col Constraints / 7-col Deload_State)
- [ ] No approval gate / coach / trust-contract behavior change (or owner-flagged)
- [ ] No roadmap/vision reorder (or owner-flagged)
- [ ] Discovered future work filed in `BACKLOG.md` in this PR

### Tests run

<!-- command + result, e.g. `npm test` → pass; live path or closest integration path covered -->
