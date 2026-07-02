# Bug Triage Ledger

**Single shared record of every `Bug_Reports` row → its triage, fix status, and owner.**
Purpose: stop two work sessions from re-fixing the same bug ("double-dipping") when the
Google Sheet itself carries no resolved/open status.

This ledger is the human-readable join of three things that currently live apart:
1. The `Bug_Reports` tab (read via `GET /api/bug-report`) — user-submitted rows, **no status column**.
2. `BACKLOG.md` — where shipped fixes are recorded, **often under a different report ID** than the sheet row.
3. Git history — the authoritative record of what actually shipped.

---

## How "done" is tracked (the convention)

**Every fix PR/commit MUST cite the `Bug ID`(s) it closes in the commit message** (e.g.
`BUG-20260629-002910`). This is already the de-facto convention (PRs A–E did it). With it,
open-vs-done is always re-derivable:

```bash
git log --all --grep='BUG-20260629-002910'   # empty => still open; a commit => shipped
```

When a fix merges, **update this ledger in the same PR**: set Status → ✅ and record the PR/commit.

### Two gotchas this ledger exists to absorb

- **UTC bug IDs read a day ahead.** Bug IDs are stamped in **UTC**, so a report filed at
  8:40 PM Pacific on 06-28 gets ID `BUG-20260629-...`. The **Local (PT)** column is authoritative
  for "what day did I actually log this."
- **The sheet ID ≠ the BACKLOG ID.** The owner often files the same bug as several rows across a
  session; a fix may cite one of those IDs (e.g. BACKLOG cites `…-003415` for incline/decline)
  while the row still sitting in the sheet is a sibling (`…-002520`). Same bug, different row.
  This ledger maps the **sheet's current rows** to the fix regardless of which sibling ID shipped.

---

## Read-feed status

✅ **Verified working** (2026-06-28 PT): `GET /api/bug-report?limit=50&full=1` → `HTTP 200`, 17 rows,
column-mapped, payloads on `?full=1`.

⚠️ **Env gotcha (resolved):** `ATLAS_API_KEY` kept collapsing to a single `X` because the key
**began with `X#…`** and the environment stores vars in `.env` format, where `#` starts a comment —
so `ATLAS_API_KEY=X#…` parses as just `X`. **Fix: rotate the key to a value with no `#` (and ideally
no `$`)**, set it identically on Render + the environment, then a *fresh* session reads it correctly
(a running session never re-reads `process.env`).

---

## Ledger — current `Bug_Reports` rows (newest first)

Legend: ✅ fixed (shipped) · 🟡 improved / needs live re-test · 🔴 open · ⚪ noise (empty/test)

| Sheet Bug ID | Local (PT) | Report | Distinct bug | Status | Resolved by | Owner |
|---|---|---|---|---|---|---|
| *(owner chat report, no sheet row)* | 07-02 10:12 | "It offers a recovery session plan then tells me I'm not lifting enough" (screenshots: Recovery/Pump plan → per-set notes "below your working range… get back in the groove" / "right on track to add weight" + "Next time: Room to progress — move to 60 × 15") | **Second recurrence of -204817 / -034034, two NEW gaps.** (1) The client sends `?intentId=recovery_pump` on the reaction call and `recommendNextSet` honors `options.intentId` — but the `GET /api/recommend/next/:liftCode` **route never read the query param**, so the engine judged the prescribed light set against a normal-day target RIR and emitted the add-load card + polluted `rec` facts. (2) The prescribed intent never reached the **LLM facts** (`sanitizeFacts` had no field for it), so even the properly-gated coach note could word `under_shot`/`far_easy` as a scold ("get back in the groove"). | ✅ fixed (**live-verified by owner 07-02 10:58**: same Recovery/Pump session shape — OHP 90×12@RIR5 → "Dialled in — right on target" + "Next time: keep 90"; Seated Row 145×13@RIR4 → on target; no scold, no load bump) | #788 — route now passes a whitelisted `intentId` (`recovery_pump`/`deload_reset`) into `recommendNextSet`; `sanitizeFacts` forwards `session_intent` and the set prompt frames a recovery session's light work as ON-PLAN by design (never "add weight" / "back in the groove"). | this lane |
| BUG-20260629-204817 | 06-29 13:48 | "Coaches pick called for a recovery session then called me out on not lifting enough" | **Recurrence of -034034.** A recovery-INTENT Coach's Pick (`recovery_pump` / `deload_reset`) still nudged add-load via TWO voices: the per-set "Too much left in the tank. Bump coming." (`effort_note`) AND the "Next time: move to 175 × 9" (`recommendNextSet`). #704 fixed the first but sourced the intent from `activePlannedSession.intentId`, which is **null** for an engaged-but-unmaterialized pick — so live (shell v77) it still fired (owner repro 06-29). | ✅ fixed (completed by #788; owner live-verified 07-02) | #704 (partial) + `getActiveIntentId()` fallback + `recommendNextSet` recovery hold. **Live re-test 07-02 initially FAILED** — the route never read `?intentId`, so the engine wiring was dead in production; completed by #788 (see the 07-02 chat-report row above), then live-verified same day. | this lane |
| BUG-20260629-153312 | 06-29 08:33 | "told Atlas it missed [rows] and it came back with the generic 'coach isn't available' message" | Dup of -153258 | 🟡 fixed, live re-test | trigger #699/#701; LLM-down reveal removed (this PR) | this lane |
| BUG-20260629-153258 | 06-29 08:32 | "informed Atlas it missed rows; it returned the generic 'coach isn't available'" — *Last error: "Not a recognized modality input (cardio / interval / circuit / timed hold)"* | "You missed rows" feedback dead-ended at the generic "coach isn't available" fallback. **Investigated:** the modality 422 is a *benign, caught* fall-through (`tryPreviewModality`); the real symptom was the LLM-down `chatFallback` revealing the outage. Two parts: the **trigger** (rows actually dropped) and the **reveal** (the generic message). | 🟡 fixed, live re-test | trigger fixed by #699 + #701; **LLM-down reveal removed** — `chatFallback` now answers naturally for high-probability cases (incl. "you missed a set → re-type it") and never says the coach is unavailable (this PR) | this lane |
| BUG-20260629-153217 | 06-29 08:32 | *(empty note)* | — | ⚪ noise | — | — |
| BUG-20260629-152824 | 06-29 08:28 | "put a bunch of workouts in at once and it missed rows; also says there's no historical working weight for knee raises (false)" | (a) multi-exercise paste dropped rows; (b) bodyweight lift falsely reported "no recent working sets" | ✅ fixed | #699 (multiline merge) + #700 (bodyweight history) + #701 (single bare BW rep) | this lane |
| BUG-20260629-054925 | 06-28 22:49 | "tapped to view a restored session's sets, nothing showed" | Restored session's logged rows `<details>` stayed collapsed ("tap to view" showed nothing) | ✅ fixed | PR G #691 (`2a1407f`) | other session |
| BUG-20260629-034034 | 06-28 20:40 | "coach said too much in the tank, lift more — but it picked a recovery workout" | Per-set "bump / add-load" reaction contradicts a Recovery/deload prescription | ✅ fixed | #696 (`9bf216c` — suppress bump + stimulus-grade on recovery/deload). **Note:** #696 gated on the convergence read only; the intent-driven case recurred as -204817 and is fixed there. | other session |
| BUG-20260629-003636 | 06-28 17:36 | *(empty note)* | — | ⚪ noise | — | — |
| BUG-20260629-003505 | 06-28 17:35 | "tapped restore session, nothing happened" | Restore-banner tap was a no-op | 🟡 fixed, live re-test | PR #678 (interactive restore banner) | other session |
| BUG-20260629-003208 | 06-28 17:32 | "tried to log effort, got an error" | rir=40 poison row rejected the **whole** session write | ✅ fixed | PR A #680 (`94f0379`) | other session |
| BUG-20260629-003118 | 06-28 17:31 | "composer won't let me type" | same rir=40 lockup (write blocked) | ✅ fixed | PR A #680 | other session |
| BUG-20260629-003028 | 06-28 17:30 | "typed done to end session, it bugged" | same rir=40 lockup | ✅ fixed | PR A #680 | other session |
| BUG-20260629-002945 | 06-28 17:29 | "no confirmation card for knee raises" | "Knee raises 20 20 20" → 422 from `/api/log-modality`, silently dropped | 🟡 improved, live re-test (now prompts "bodyweight reps?") | PR A #680 | other session |
| BUG-20260629-002910 | 06-28 17:29 | "push ups 40 40 40 logged as RIR" | Bodyweight push-ups parsed positionally as weight/reps/**rir** | ✅ fixed (verified in HEAD) | PR A #680 | other session |
| BUG-20260629-002714 | 06-28 17:27 | "decline bench logged as bench" | incline/decline collapsed to plain "Bench Press" | ✅ fixed (verified) | PR B #681 (`57c8d98`) | other session |
| BUG-20260629-002630 | 06-28 17:26 | "didn't recognize tricep pulls" | "tricep pulls" fell through to unknown-exercise | ✅ fixed (verified) | PR D #682 (`688a6da`) | other session |
| BUG-20260629-002520 | 06-28 17:25 | "incline bench logged as bench" | incline/decline collapsed to plain "Bench Press" | ✅ fixed (verified) | PR B #681 | other session |
| BUG-20260629-002433 | 06-28 17:24 | "shouldn't offer what to lift next in freestyle" | Freestyle auto-guided a "next up" lift | ✅ fixed | B4 + PR E #683 | other session |
| BUG-20260629-000725 | 06-28 17:07 | "next-session tile reads like it's today's workout" | Prescription card "→ Next" header was ambiguous | ✅ fixed (relabeled "Next time:") | PR E #683 (`c022ba7`) | other session |
| BUG-20260629-000316 | 06-28 17:03 | *(empty note)* | — | ⚪ noise | — | — |
| BUG-20260627-030017 | 06-26 20:00 | "in freestyle Atlas shouldn't suggest a next workout" | Freestyle auto-guide (dup of -002433) | ✅ fixed | B4 | other session |
| BUG-20260627-025603 | 06-26 19:56 | "Test" | — | ⚪ noise | — | — |
| BUG-20260627-025552 | 06-26 19:55 | *(empty note)* | — | ⚪ noise | — | — |

**Bottom line (24 rows, updated 2026-07-02 PT):** 18 shipped (incl. the recovery-scold lane:
-204817 initially failed its 07-02 live re-test, was completed by #788 — route `?intentId`
passthrough + LLM `session_intent` — and **live-verified by the owner the same day**),
**4 fixed pending an owner live re-test** (the coach-fallback pair -153258/-153312, the restore
banner -003505, the knee-raise prompt -002945), **0 open**, 4 noise (one a near-dup). All
known-actionable rows now have a shipped fix; the remaining work is owner live validation — see
the live-test items in `BACKLOG.md` / the QA campaign.

---

## No open bugs

Every actionable `Bug_Reports` row now has a shipped fix. Four are 🟡 *fixed pending an owner live
re-test* — they should be confirmed in the real app: -153258/-153312 (coach-fallback), -003505
(restore banner), -002945 (knee-raise bodyweight prompt).

### Resolved this lane — the coach-fallback pair (-153258 / -153312)

**Investigation verdict:** not a routing defect. The captured `Last error: "Not a recognized modality
input"` is a *benign, caught* 422 from the modality dry-run probe (`tryPreviewModality` in
`public/app.js` catches it and falls through to the coach) — never surfaced, never blocking. The real
symptom was twofold: (1) the **trigger** — rows actually got dropped (the missed-rows bug, fixed by
**#699** + **#701**); and (2) the **reveal** — with Gemini momentarily down, the client `chatFallback`
told the lifter *"I couldn't reach the coach just now."*

**Fix (owner directive — "when the LLM is down I don't want to know; give a natural response for
high-probability cases"):** `public/coach-conversation.js` `chatFallback` now answers naturally for the
common mid-session messages (greeting, thanks/ack, *"you missed a set" → re-type it*, how-am-I-doing,
workout-notation, skip) and the catch-all is a productive nudge — with **no "couldn't reach" /
"unavailable" / "ask again" wording**. The deterministic engine still owns logging and never invents a
number; the LLM outage is simply invisible.

### Previously open, now shipped

✅ **BUG-20260629-034034 — recovery session nudged "add load"** — shipped in **#696** (`9bf216c`):
the recovery/deload read now suppresses the per-set `bump` + stimulus-grade steer, including on the
LLM-prose path. Kept here as a worked example of the open→shipped transition this ledger tracks.

---

## Proposed enhancement — make status visible *in the sheet* (owner-gated)

This ledger lives in git. To surface done-vs-open **in the Google Sheet** (so the owner sees it
without reading the repo), the recommended next step is an **append-only `Bug_Resolutions` tab**:

```
bug_id | status | resolved_at | commit_or_pr | note
```

written when a fix merges; the review feed joins `Bug_Reports ⟕ Bug_Resolutions` to show status.
Append-only keeps the user-submitted `Bug_Reports` rows immutable (matching how `Deload_State` works)
and avoids mutating a report row. **This is a new tab + a new write path → schema/contract change →
owner approval required** before building (it is not started).

A smaller companion idea: **localize the bug-ID timestamp to PT** so IDs stop reading a day ahead of
the owner's "today." That changes the ID format, so it is also owner-gated.
