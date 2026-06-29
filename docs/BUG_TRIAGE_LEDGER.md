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
| BUG-20260629-034034 | 06-28 20:40 | "coach said too much in the tank, lift more — but it picked a recovery workout" | Per-set "bump / add-load" reaction contradicts a Recovery/deload prescription | 🔴 **OPEN** | — | **new (this lane)** |
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

**Bottom line:** 11 of 17 already shipped, 2 fixed pending an owner live re-test, 1 genuinely open, 3 noise.

---

## The one open bug

🔴 **BUG-20260629-034034 — recovery session still nudges "add load."**
Coach's Pick generated an explicit **Recovery / Pump** session ("weekly fatigue 2.2× baseline,
light loads 12–15 reps"). The lifter logged the prescribed light sets, and the per-set reaction
replied **"Too much left in the tank. Bump coming. → move to 175 / 50 / 135"** — telling him to add
load during a deliberate deload/recovery day.

- **Root:** the per-set effort/progression voice evaluates each set in isolation and emits a
  `bump` (progression invite) without reading the session's recovery/deload **objective**.
- **Related, already half-built:** BACKLOG slice 6 made the recovery read **override `bump` on the
  deterministic / LLM-down path**, and slice 7's deferred note flags that the `bump` path is not yet
  reconciled against the governor grade. This report shows the **LLM-prose path (Gemini up) still
  emitting the bump** — so the suppression needs to extend to that path too.
- **Lane:** correctness fix (a recovery prescription must not tell you to add load), not a coaching-
  philosophy change. Filed in `BACKLOG.md`. **Not started** here — queued behind the active fix lane.

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
