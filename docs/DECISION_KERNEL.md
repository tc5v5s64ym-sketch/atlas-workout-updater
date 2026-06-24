# Atlas Decision Kernel

> **Status:** Active. The operational distillation read FIRST for routine autonomous decisions, so the full Vision / Roadmap / Architecture do not have to be re-read on every PR. Sources distilled: `docs/ATLAS_PRODUCT_VISION.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` (`docs/export/atlas-architecture.html`), `CLAUDE.md`, `docs/CONSTITUTION.md`, `docs/INVARIANTS.md`.
>
> **This kernel is a convenience, not an authority.** It never overrides `CLAUDE.md`, `docs/INVARIANTS.md`, or `docs/CONSTITUTION.md`. If the kernel and a source ever disagree, the source wins — and the kernel is wrong and must be fixed.

The kernel holds only the **durable principles** needed to make routine autonomous decisions without re-reading the full north-star documents. It is deliberately short. When a decision needs more than this, see **"When the kernel is not enough"** at the bottom.

---

## The durable principles

These are the operating rules. Each routine decision should be checkable against this list alone.

**Trust & data safety**

- **Approve-before-write.** No real Google Sheets write without explicit owner approval. The preview → approve → write trust loop and the dry-run (`sheet_written:false` / `no_write_confirmed:true`) vs live-write (`sheet_write:'success'` **and** `log_rows_written > 0`) proof fields are never weakened (`docs/INVARIANTS.md` W1–W3).
- **`test_mode` absent = live write.** Dry-runs pass `test_mode:true` explicitly; agents never omit it unless a real, approved write is intended (W2).
- **No silent state changes.** Every state change is visible and traceable — no row written, deleted, or modified outside an approved, proof-carrying path; system-state tabs are append-only with an audit trail.
- **Preserve user intent.** Valid gym language must be loggable; deterministically-loggable input must never be silently discarded or routed to the coach instead of logged.

**Engine & coach**

- **Deterministic engine owns the numbers.** Every weight, rep, RIR, set count, verdict, and rule comes from the engine. The LLM never invents a number.
- **Coach explains, not invents.** The LLM only *words* facts the engine already emits and *answers questions* grounded in a snapshot. It never writes, never decides numbers. Degrade to templated/null copy when the LLM is down — never to a guess.
- **Slash notation is fixed.** `225 5/2` = 225 lb × 5 reps @ RIR 2, always. Not configurable; parser changes require golden tests (P1–P3).

**Product behaviour**

- **Reward correct behaviour, not heroic effort.** Atlas praises the right training move (the prescribed set, the honest log), not raw volume or grinding past the plan.
- **Trust over cleverness.** When a clever feature and the trust contract conflict, trust wins. Predictability and honesty beat sophistication.
- **Depth before breadth.** Make the existing training-intelligence path correct and trustworthy before adding new surface area. No new capability when the current one is still shallow.
- **Live-test before trusting.** A UI/interaction or trust-path change is not "done" until the owner can live-test it; flag `owner-live-test` with a script (advisory, owner-initiated).

**Execution discipline**

- **Smallest safe slice.** One concern per PR, tiny diff, focused tests. If a fix spreads beyond what the item names, stop and split it.
- **Build the engine first, word it second.** Deterministic logic/data/service layer lands before any LLM voice that narrates it.
- **If a premise is wrong, stop and report with evidence.** Do not work around a false assumption.
- **Future discoveries go to `BACKLOG.md`** in the same PR — never carried in memory or chat.

**Scope boundaries (Architecture)**

- Google Sheets is the only store — no second database. Single-owner this phase (the multi-user path is Vision-future, not now). Do not build nutrition, voice, an autonomous "Atlas Brain", a Dashboard tab, or big "cleanup" refactors unless the owner explicitly asks.

---

## Document precedence — what to read, in order

### Routine execution (the common case)

1. **`CLAUDE.md`** — the operating brief and absolute safety rules.
2. **`docs/ACTIVE_ROADMAP.md`** — the live queue / current critical path.
3. **`docs/DECISION_KERNEL.md`** — this file: the durable principles for routine decisions.

**If `docs/ACTIVE_ROADMAP.md` contains eligible work** → continue roadmap execution. **Do not consult `BACKLOG.md` for work *selection*** while the roadmap has eligible items. (This is about *what to build next*, not whether to open the file: `CLAUDE.md` Backlog discipline still requires reading `BACKLOG.md` at the start of a session for awareness and appending any discovered work in the same PR — always read it, just don't pick the next task from it while the roadmap has eligible items.)

**If the roadmap is exhausted** (every step complete) →

4. **`BACKLOG.md`** — the work queue; run the Roadmap Refill Loop (`docs/AGENT_WORKFLOW.md`) to repopulate `docs/ACTIVE_ROADMAP.md` from already-filed, Vision-serving backlog items.

The Vision Alignment Check (`docs/AGENT_WORKFLOW.md`) is still required on every autonomous PR — it can be satisfied from this kernel for routine work.

### Roadmap eligibility criteria

An item is **eligible** for autonomous execution only when **all** hold:

- **Clear acceptance criteria** — what "done" means is unambiguous.
- **No unresolved dependencies** — nothing it waits on is still open.
- **Smallest safe slice** — it is one concern, sized to a tiny PR (split it if not).
- **Obvious test approach** — the live path / closest integration path is testable without inventing scaffolding.
- **No schema or destructive work** unless the item **explicitly** marks it (and such items are owner-reserved, not autonomous).

If an item fails any criterion, it is not eligible — narrow it, file the blocker in `BACKLOG.md`, or escalate per the reserved categories; do not start it.

### Risk tiers

Maps the surface of a change to who must act (the primary risk label records this on the merge card — `docs/RISK_LABELS.md`):

- **Tier 1 — autonomous.** Derivable, no reserved-category trigger; all signals green. Builder decides, merges, continues. (`auto-safe`.)
- **Tier 2 — Codex-review gated.** A genuinely non-derivable, non-reserved fork: route to the Codex / Atlas Decision Desk for a verdict, then proceed (`docs/DECISION_ROUTING.md`). Does not reach the owner.
- **Tier 3 — owner approval.** One of the **four reserved categories** (Escalation Policy v3, `docs/OWNER_CHECKIN_RULES.md`): (1) a live test only the owner can perform; (2) a change to product vision, coaching philosophy, or new product scope (incl. app/runtime model selection); (3) destructive or irreversible operations (schema, migrations, deletion, credentials, security-sensitive infra); (4) a genuine, unresolvable principle conflict. Stop and escalate. (`owner-live-test` / `owner-decision`.) **Coach wording / rendering / frontend / UX is NOT Tier 3 when derivable** — it is Tier 1 PM authority.

### Decision Kernel response format

When recording a kernel-derived decision (on the merge card, a Decision Desk issue, or a PR note), keep it short and structured:

```
Decision:           <what was decided>
Rationale:          <the kernel principle / doc it derives from>
Invariants checked: <which INVARIANTS / trust-contract rules were verified safe>
Confidence:         <high / medium / low>
Owner needed:       <yes / no — and which reserved category if yes>
```

Low confidence on a consequential fork is itself a signal to route to a decision desk (Tier 2) rather than guess.

### When the kernel is not enough — consult the full sources

Read the full **`docs/ATLAS_PRODUCT_VISION.md`**, **`docs/ROADMAP.md`**, and **`docs/ARCHITECTURE.md`** (`docs/export/atlas-architecture.html`) **only** when:

- the **roadmap is exhausted** and the refill needs the full product direction;
- a **backlog promotion / refill** is required (promoting owner-gated or `NEEDS DESIGN` scope into the active queue);
- a **major product-direction decision** is being made;
- a **trust contract changes** (a new write path, approval-gate behaviour, or coaching-authority change);
- a **genuine principle conflict** exists (the kernel/principles point to different outcomes with no documented precedent).

Those five are also the boundary where the owner or a decision desk may be involved (`docs/OWNER_CHECKIN_RULES.md`, `docs/DECISION_ROUTING.md`). Everything else is **PM authority**: decide from this kernel and proceed.

### Token-efficiency rule

**Do not re-read the full Vision / Roadmap / Architecture for routine PRs.** Use this kernel as the operational reference. The full documents are large; re-reading them on every routine loop wastes context for no decision benefit. Pull them in only for the five cases above.

---

## Operational completeness

With this kernel in place, **Atlas automation is considered operationally complete.** The decision machinery — PM authority, the four reserved categories (Escalation Policy v3, `docs/OWNER_CHECKIN_RULES.md`), the Codex and Atlas Decision Desks, risk classification, the merge card, Vision-first selection, and this kernel — is sufficient for routine autonomous execution.

**Future process changes require evidence of an actual bottleneck** — a concrete, observed friction in the loop, not a hypothetical refinement. Absent that evidence, default effort returns to **building Atlas** (the product), not refining the workflow.

### Post-merge learning rule

After a PR merges, **propose a governance/kernel update only when a real new precedent was discovered** — a decision the existing docs genuinely did not settle, whose resolution should bind future loops. **Do not create process churn for routine work:** a normal bugfix, a derivable call, or a Tier-1 merge is not a precedent and needs no doc change. When a real precedent does appear, capture it in the smallest fitting doc (this kernel or the specific governance file) in a tiny docs PR — not a broad rewrite.
