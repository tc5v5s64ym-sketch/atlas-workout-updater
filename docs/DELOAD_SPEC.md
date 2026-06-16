# Atlas — Deload Spec

**Status: DRAFT — awaiting owner (Dale) approval.** Single source of truth for what a deload *is* in Atlas. Code follows this; if behavior is ever wrong, change this section first, then the code.

---

## 0. Design decision: a real feature, recommended *intelligently*

Deload is a first-class Atlas feature (Atlas is becoming a product, not just Dale's logger). But the recommendation is **conditional on training stress, not on a naive weight stall** — because the need for a deload scales with frequency, volume, and fatigue:

- A high-frequency user (4–6x/week) grinding low-RIR for weeks → Atlas **recommends** a deload.
- A low-frequency user (1–3x/week, e.g. current-Dale) with a flat weight → Atlas **stays quiet** and suggests "add a rep / nudge load." Their rest days already are their deload.
- Any user can **invoke** a deload on demand ("ease me off," "deload week").

Same feature, same code, correct behavior for both. It must **never** fire just because the top weight was flat for N sessions.

## Decisions to confirm (the knobs)

| Knob | Default | Change if… |
|---|---|---|
| How a deload starts | owner-invoked, **or** recommended when frequency + fatigue warrant | you want different gating |
| Recommendation gate | trains ~4+ days/week **and** effort grinding (RIR ≤ 1) over several sessions, **or** a pain flag | too eager / too shy |
| Movements in a deload session | keep the normal **4–6** | you want fewer |
| Weight | **held** (no drop) | you'd rather drop load |
| Volume | cut working sets ~in half (e.g. 3 → 1–2 per movement) | bigger/smaller cut |
| Effort | easy — **RIR 4+** | harder/easier |
| Duration | **1 session**, re-evaluate | you want a full week |

## 1. When a deload happens (and when it must NOT)

**Owner-invoked (always available):** Dale/the user asks — "deload week," "ease me off," "I'm wiped."

**Recommended (conditional):** Atlas *offers* a deload only when training stress is genuinely high — roughly **4+ sessions/week AND effort grinding (RIR ≤ 1) across several sessions**, or a logged **pain flag**. Even then it's a question, never an automatic prescription.

**Must NOT trigger on:**
- ❌ a flat top weight for N sessions (NOT a deload signal — especially at low frequency),
- ❌ rep progress at the same weight (that's progress),
- ❌ a single hard session or a PR.

## 2. What a deload prescribes (volume-first)

**Keep your movements, hold the weight, cut the sets, keep it easy.**
- Same **4–6 movements** you'd train that day — a full session, not a stripped one.
- **Same working weight** per movement (no drop).
- **Fewer working sets** — roughly half (3 → 1–2).
- **RIR 4+** — comfortably easy.
- **One session**, then re-evaluate.

## 3. What the coach says during a deload

While a deload is active, the coach must: know it's a deload **for the whole session**, **name the held weight**, **frame easy sets as the point**, and **never** say "you left a lot in the tank, bump it next time."

- *"Deload set — 205 held, RIR 4, nice and easy. Banking recovery, not chasing reps."*
- *"That's the deload doing its job — light dose this week so next week's sharp."*

## 4. How a lift returns to normal

After the deload session: next session returns to the **same pre-deload working weight** (205, not lower), **full working-set count**, **progression target unchanged** (chase 10 clean reps @ RIR 3, then 215).

## 5. Worked examples (real numbers — these are the acceptance tests)

### Example A — Owner-invoked, Bench Press @ 205

Dale types *"give me a deload this week."* → prescription: normal bench day, `205 × 1–2 sets × ~5 @ RIR 4+`, other movements cut the same. → logs `205 5/4` → coach: *"Deload set — 205 held, 4 in reserve. Easy week so bench comes back fresh."* → next bench day: `205 × full sets`, resume toward 10 @ RIR 3 → 215.

### Example B — Recommendation correctly STAYS QUIET, Back Squat @ 205

Current-Dale (1–3x/week) hits `205 × 7` after a few flat sessions. Weight flat, but reps progressing and frequency low → Atlas does **NOT** recommend a deload; it says *"add a rep / hold for 10 @ RIR 3."* (For a 5x/week user grinding RIR ≤ 1 for weeks, the same engine *would* offer one — that's the conditional gate working.)

## 6. What this spec deliberately does NOT do

- ❌ recommend deloads from a flat-weight stall,
- ❌ drop the working weight (volume-first, not load-cut),
- ❌ reset progression or the 215 target,
- ❌ strip the session below the normal 4–6 movements,
- ❌ let the coach push for more during a deload.
