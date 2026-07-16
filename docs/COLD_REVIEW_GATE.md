# Cold Review Gate — Temporary Branch-Protection Compatibility

Cold review is retired as an Atlas governance requirement. No separate reviewer, reviewer account, paid API, human sign-off, or marker is required by `CLAUDE.md`.

The legacy `cold-review/exact-head` workflow/script/tests remain temporarily because the status may still be listed in `main` branch protection. Until Dale removes that required-status entry, Claude may post the legacy exact-head PASS marker itself after completing its normal review so an obsolete repository setting does not block an otherwise clean PR.

After `cold-review/exact-head` is removed from branch protection, delete together:

- `.github/workflows/cold-review-gate.yml`
- `scripts/cold-review-gate.js`
- `test/cold-review-gate.test.js`
- `docs/COLD_REVIEW_GATE.md`

Do not add the status back, build a replacement identity gate, or treat this compatibility mechanism as execution policy. Deterministic GitHub CI remains the hard gate; Codex comments and optional clean-context review are advisory.
