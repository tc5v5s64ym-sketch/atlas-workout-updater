# Atlas Governance Spine

This file defines where Atlas truth lives so no decision depends on chat memory and no second roadmap competes for execution authority.

## The hierarchy

```text
Dream / Vision
      ↓
Constitution + Invariants
      ↓
Canonical Execution Plan
      ↓
Backlog / Evidence / Specs
```

## The layers

**Dream and Vision** — why Atlas exists and what the finished product should feel like. Lives in `docs/ATLAS_PRODUCT_VISION.md`.

**Constitution and Invariants** — laws Atlas must not break: approve-before-write, deterministic numbers, truthful state, and absolute data safety. Lives in `docs/CONSTITUTION.md` and `docs/INVARIANTS.md`.

**Canonical Execution Plan** — the one ordered campaign currently being built. Lives in `docs/ATLAS_V1_EXECUTION_PLAN.md`. It is the sole authority for selecting the next PR until V1 stabilization ends.

**Backlog** — the intake and deferred-work ledger. Lives in `BACKLOG.md`. While the canonical plan has eligible work, the backlog records discoveries but does not reorder the campaign.

**Evidence and specs** — `docs/TEST_QUEUE.md`, `docs/BUG_TRIAGE_LEDGER.md`, promotion criteria, architecture, narrow design specs, audits, and research. They prove, constrain, or explain work; they do not independently select it.

## The curator rule

Every significant idea must be assigned to one primary home. The owner is not responsible for filing it.

- Product direction → Vision.
- Non-negotiable rule → Constitution/Invariants.
- Approved current campaign work → canonical execution plan.
- New or deferred work → Backlog.
- Validation result → evidence ledger.
- Narrow implementation contract → spec.

## One-plan rule

Atlas may have only one active execution plan.

Do not create another roadmap, phase plan, fix-it document, campaign controller, or giant session prompt. A narrow spec may exist when a plan card needs design, but `docs/ATLAS_V1_EXECUTION_PLAN.md` remains the sequencing authority.

Git history is the archive for retired plans. Compatibility-pointer files must redirect to the canonical plan and carry no independent queue.
