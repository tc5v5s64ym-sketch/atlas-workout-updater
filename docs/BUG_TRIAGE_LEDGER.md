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
| BUG-20260629-153312 | 06-29 08:33 | "told Atlas it missed [rows] and it came back with the generic 'coach isn't available' message" | Dup of -153258 | 🔴 **OPEN** | — | **new (this lane)** |
| BUG-20260629-153258 | 06-29 08:32 | "informed Atlas it missed rows; it returned the generic 'coach isn't available'" — *Last error: "Not a recognized modality input (cardio / interval / circuit / timed hold)"* | Conversational "you missed rows" feedback appears misrouted to the modality parser → rejected → generic coach-unavailable fallback (or a transient Gemini outage). **Needs investigation** — note text read via a degraded CSV export, confirm against the sheet | 🔴 **OPEN** | — | **new (this lane)** |
| BUG-20260629-153217 | 06-29 08:32 | *(empty note)* | — | ⚪ noise | — | — |
| BUG-20260629-152824 | 06-29 08:28 | "put a bunch of workouts in at once and it missed rows; also says there's no historical working weight for knee raises (false)" | (a) multi-exercise paste dropped rows; (b) bodyweight lift falsely reported "no recent working sets" | ✅ fixed | #699 (multiline merge) + #700 (bodyweight history) + #701 (single bare BW rep) | this lane |
| BUG-20260629-054925 | 06-28 22:49 | "tapped to view a restored session's sets, nothing showed" | Restored session's logged rows `<details>` stayed collapsed ("tap to view" showed nothing) | ✅ fixed | PR G #691 (`2a1407f`) | other session |
| BUG-20260629-034034 | 06-28 20:40 | "coach said too much in the tank, lift more — but it picked a recovery workout" | Per-set "bump / add-load" reaction contradicts a Recovery/deload prescription | ✅ fixed | #696 (`9bf216c` — suppress bump + stimulus-grade on recovery/deload, incl. the LLM-prose path) | other session |
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

**Bottom line (22 rows, updated 2026-06-29 PT):** 16 shipped, 2 fixed pending an owner live re-test,
**2 open** (the coach-fallback pair -153258/-153312, same bug), 4 noise. The previously-"one open"
recovery-bump bug (-034034) shipped in #696; the live-test re-tests (-003505 restore banner,
-002945 knee-raise prompt) are still pending owner confirmation.

---

## The open bug

🔴 **BUG-20260629-153258 (and its dup -153312) — "you missed rows" feedback dead-ends at "coach isn't
available."** After the multi-exercise paste dropped rows (since fixed for the bare-bodyweight case in
#701), the owner told Atlas *"you missed rows."* Instead of a useful reply, Atlas returned the generic
**"coach isn't available"** fallback. The captured `Last error` — *"Not a recognized modality input
(cardio / interval / circuit / timed hold)"* — strongly suggests the conversational complaint was
**routed to the modality parser** (`/api/log-modality` or equivalent), rejected as not-a-modality, and
then surfaced as the generic coach-unavailable line rather than a grounded answer.

- **Two candidate roots (investigate before fixing):** (a) a **routing bug** — free-form coach
  feedback misclassified as a modality-log attempt; or (b) a **transient Gemini outage** at 08:32 PT,
  in which case the bug is only the *generic* fallback wording (the deterministic engine should still
  answer "here's what I logged"). The `Last error` points at (a).
- **Note text caveat:** the sheet rows were read via a degraded CSV export (truncation + note/row
  misalignment across fetches); **confirm the verbatim notes against the sheet** (or `GET
  /api/bug-report?full=1`) before implementing.
- **Lane:** correctness/routing — not started. Queued for a focused investigation PR (run the
  Current-State Verification Gate first; the modality-routing path may already have changed).

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
