<!--
Atlas Merge Card — fill every field. Empty, stale, skipped, errored, unavailable,
or incomplete required signals are failures. Dale is the only merge authority.
-->

## 🟦 Atlas Merge Card

| Field                             | Value                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| **PR**                            | #<!-- number, filled after open -->                                                   |
| **Title**                         | <!-- one line -->                                                                     |
| **Risk level**                    | <!-- low / medium / high -->                                                          |
| **Files / categories touched**    | <!-- e.g. docs-only · governance -->                                                  |
| **Tests / checks**                | <!-- command/check + result; not-run = FAIL when required -->                         |
| **Native Codex GitHub Review**    | <!-- exact head SHA + clean / changes-requested / errored(=FAIL) / not-run(=FAIL) --> |
| **ChatGPT Atlas Contract Review** | <!-- READY FOR DALE MERGE / NON-BLOCKING / BLOCKING / not-run(=FAIL) -->              |
| **Owner action required**         | <!-- No · or Yes + reserved criterion -->                                             |
| **Live test script**              | <!-- steps for Dale if needed, else n/a -->                                           |
| **Merge recommendation**          | <!-- READY FOR DALE MERGE / fix-then-review / hold-for-Dale -->                       |

<!--
Current-head rule: after the final push, comment `@codex review`. Any later push
makes that native review stale. Native Codex review and ChatGPT Atlas Contract
Review are distinct; both are required. No agent may merge.
-->

---

### Concern (one per PR)

<!-- One sentence: the single concern this PR addresses. If it grew, split it. -->

### Current-state verdict

<!-- STILL BROKEN / ALREADY FIXED / PARTIALLY FIXED / FIXED BUT UNTESTED / STALE-SUPERSEDED / NEEDS OWNER APP-TEST -->

### Vision alignment

<!-- Principle advanced · smallest safe step · invariant protected · user-facing trust change yes/no -->

### Trust / scope safety

- [ ] No product behavior change (or explicitly scoped and approved)
- [ ] No write-path change (or explicitly scoped and approved)
- [ ] No Sheet schema change (12-col Log_Cleaned / 9-col Effort / 5-col Constraints / 7-col Deload_State / 13-col Session_Plans)
- [ ] No approval-gate / trust-contract change (or explicitly scoped and approved)
- [ ] No roadmap/vision reorder (or explicitly scoped and approved)
- [ ] One concern only; no future roadmap work bundled
- [ ] Dale remains the sole merge authority; auto-merge is off

### Tests run

<!-- command/check + result; include live path or closest integration evidence -->
