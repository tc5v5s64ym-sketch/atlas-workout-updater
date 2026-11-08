# State Machines of the Atlas Workout Updater — a map

Read-only survey of the app at `s3-maintenance` head `afcf5d3d` (the build live in
production on 2026-11-08). No code was changed for this document.

Method: every "thing" that moves through stages was traced to the code that decides
its moves — status fields, flag clusters, dates, and if/then logic spread across
files. Each section names the stages in plain words, every allowed move and its
trigger, and the exact files/functions that decide it. Contradictions (states the
code allows that should not be able to coexist) and dual deciders (two pieces of
code deciding the same fact separately) are called out per machine. Problems are
ranked by user harm at the end, with one small proposed fix for each of the top 3.

A note on vocabulary: this app has no orders, payments, or bookings. Its "things
that move through stages" are workout sessions, planned slots, staged writes,
server write receipts, plan events, sync/mirror records, and the deload program.

---

## 1. Workout session lifecycle (client) + Session_Plans closeout (server sidecar)

**Stages.** There is no status field. The stage is the shape of one object,
`_activePlannedSession` (`src/app/store.js:25`):

- *No session* — the object is `null`. This means both "never started" and "ended";
  the two are indistinguishable locally.
- *Suggested* — a Coach's Pick is engaged (`coachSuggestionEngaged`, `store.js:27`)
  but no session object exists yet.
- *Started, unaccepted* — session object exists with `index: 0` but no `accepted`
  flag and no `items[]` (`startPlannedSession`, `src/app/app.js:2115`).
- *Accepted* — the object gains `accepted: true`, `items[]` (each item's `outcome`
  starts `'planned'`), `session_id`, `plan_version`, `session_date`
  (`src/app/planAcceptance.js:227`).
- *In progress* — implicit: object non-null; progress lives in separate buffers
  (`sessionLog`, `sessionCompleted`, `store.js:30`), not on the session object.
- *Resumed* — object + buffers restored from the localStorage snapshot
  (`store.js:216`, shape v6, max age 12 h).
- *Saved* — orthogonal: sets are written via the staged-write machine (§4) while
  the session may still be active; a session can also end without ever being saved.
- *Closed out (server only)* — `closeout_status ∈ {finalized, abandoned}` recorded
  as an event in the Session_Plans tab (`src/app/planCloseout.js:16`). The local
  lifecycle never reads it.

**Moves.**

- none → suggested: Coach's Pick tap; promoted to a live session on the first
  swap/skip (`ensureActivePlannedSession`, `app.js:2360`).
- none → started: `startPlannedSession` (`app.js:2115`).
- displayed plan → accepted: `acceptDisplayedPlan` (`app.js:2167`) →
  `runAcceptance` (`planAcceptance.js:207`). Refused outright if any exercise
  lacks a canonical lift code. The `session_id` starts null and is *adopted from
  the server's /accept response* (`planAcceptance.js:258`).
- any → resumed: `hydrateSessionSnapshot` (`store.js:216`).
- in progress → ended: `endPlannedSession()` (`app.js:3185`) — also fired
  implicitly when advancing past the last slot or when the plan empties. Emits
  nothing.
- in progress → closeout `finalized`, **two triggers with opposite timing**:
  the banner **End session** button emits *immediately at click, before any save*
  (`app.js:3092`); the **Finish session** flow emits *only when the athlete
  approves the save* (`app.js:5453`, comment at 5453–5458 states this rule).
- in progress → closeout `abandoned`: Start Over (`app.js:6999`), trash-discarding
  a restored session (`app.js:5890`).
- finalized → undo refused: a durable `finalized` blocks
  `/api/log-workout/undo-last` (`services/closeoutFinality.js:46`, consulted at
  `index.js:3977`).

**Contradictions the code allows.**

- `finalized` with **no workout saved**: via the End-session button, Session_Plans
  can assert a finalized workout that has no Log rows at all — and that assertion
  blocks undo. The same status word means "saved and approved" on one path and
  "button clicked" on the other.
- An accepted session can end with **no closeout record at all** (implicit
  `endPlannedSession` never emits), so the server fold (§8) leaves it `open`
  forever.
- *Plan-complete ∧ session-active*: all slots resolved leaves the session live
  and loggable while `isPlanCloseoutAwaitingSave` (`app.js:6059`) reads the same
  state as "closeout awaiting save."
- *Finalized ∧ locally resumed*: `hydrateSessionSnapshot` never consults server
  finality; a snapshot not cleared at closeout can resurrect a session the server
  holds as `finalized` (inside the 12 h window) and logging continues into it.
- Ending a deload session without an approved write ends the session but does not
  advance the deload machine (`app.js:3189`, gated on `deloadWritten`).

**Dual deciders.** "Is the workout over?" is decided three times — local object
nullness, the Session_Plans `closeout_status`, and the save path's staged-write
state — and none of the three reads the others. Closeout timing is decided twice
with opposite rules (above).

---

## 2. Planned-slot completion (per exercise inside a session)

**Stages.** Three parallel representations of the same fact:

- Canonical model (`src/app/activeSession.js:22`): each exercise
  `status ∈ {pending, completed, skipped}`, `source ∈ {planned, substituted, inserted}`;
  the cursor is derived — current = first `pending` (`activeSession.js:324`).
- F10 slot selector (`src/app/planSlotStatuses.js:147`): per-slot
  `status ∈ {pending, completed, skipped}` plus `performedSets` / `requiredSets`.
  "In progress" is not a value — it is `pending` with sets attributed but
  `performedSets < requiredSets` (`planSlotStatuses.js:217`).
- Accepted-item outcome lane (`planAcceptance.js:102`, `planOutcome.js:16`):
  `items[].outcome ∈ {planned, completed, skipped, substituted}` by `plan_item_id`.
- Two "completed" lists with different meanings: `sessionCompleted` = exercises
  with **≥1 logged set** (`app.js:6497`); `completedSlotNames()` = full
  prescription done (`app.js:6045`).

**Moves.**

- pending → sets logged: `emitSetLogged` (`app.js:6451`) — the exercise enters
  `sessionCompleted` on its **first** set.
- pending → completed (log lane): `planSlotStatuses` attribution tiers — exact
  name → exact lift code → recognized variant (`activeSession.js:385`) → unique
  substring (ambiguous → refuse). Completion requires `performedSets >=
  requiredSets` **only when the caller passes the per-set log**
  (`planSlotStatuses.js:226`).
- pending → completed (explicit lane): "Done with ⟨exercise⟩" button →
  `completePlanItemById` (`app.js:3117`); target = most recently logged,
  not-yet-completed item (`planCompletion.js:36`).
- pending → skipped: **two different mechanics** — the live store *splices the
  slot out* of the plan (`skipPlannedExercise`, `app.js:2312`) while the canonical
  model *retains it as a status* (`activeSession.js:176`).
- pending → substituted: `applySessionSubstitution` (`app.js:1653`), preserving
  `plan_item_id` and `accepted_set_count`; canonical twin `replaceExercise`
  (`activeSession.js:148`, pending-only).
- The canonical model is **rebuilt, not mutated, on every read**:
  `getCanonicalSession` (`app.js:1588`) replays only what `planSlotStatuses`
  judges completed; unattributed logged names become inserted+completed.

**Contradictions the code allows.**

- One set completes a slot — or doesn't — **depending on the caller**: the
  set-count rule applies only when the caller passes `sessionLog`
  (`planSlotStatuses.js:164`, `:226`).
- Client vs server disagree on the same slot: server `computePlanState`
  (`services/sessionPlanExecutor.js:73`) attributes by exact name/code with **no
  set-count rule and no variant tiers** — one logged set claims a 3-set slot
  server-side while the client keeps it pending. The server verdict feeds
  closeout math (`services/sessionCloseout.js:28`).
- `isComplete` is true for an **all-skipped** session (`activeSession.js:349`);
  `hasLoggedWork` (`:358`) exists as a patch — a consumer checking only
  `isComplete` treats zero logged work as a completed workout.
- `'substituted'` is a terminal outcome in `planOutcome.js:16` but seeds the slot
  as **pending** in `planSlotStatuses.js:185`.
- A skipped exercise is indistinguishable from never-planned in the rebuilt
  canonical session (the splice erases it before the rebuild).
- Two slots with the same name can never both complete by logging
  (`sessionCompleted` is name-deduped, `app.js:6497`; deliberate fail-closed,
  `planSlotStatuses.js:33`) — only the Done button closes the second.
- The tally marks a log "planned" by exact name (`sessionTally.js:60`) while the
  slot selector attributes aliases — an "RDL" log tallies as off-plan in the
  coach context while its slot reads completed.

**Dual deciders.** Slot completion: `planSlotStatuses` (client) vs server
`computePlanState` vs the canonical replay. Skip: splice vs status vs sidecar
event — three representations of one event.

---

## 3. "Next exercise" derivation

Not a stored state — "next" is re-derived per surface, by **four** deciders:

- **A. Remaining order (declared authority).** `remainingPlannedExercises()`
  (`app.js:6036`); next = `remaining[0]` (`firstUnloggedPlannedLift`,
  `app.js:6159`). Recomputed at every log (`app.js:6514`).
- **B. Stored cursor.** `activePlannedSession.index` drives the plan banner;
  advanced by `advancePlannedSession` (`app.js:3148`) on "Next" taps, reconciled
  against A **forward-only, by exact lowercase name**, at banner render
  (`syncPlannedIndexToCanonical`, `app.js:3133`).
- **C. Position arithmetic (completion-blind).**
  `getNextExerciseInPlan` (`src/app/coach-conversation.js:1412`) returns plan
  entry *idx+1* for the just-logged lift and never consults completion; server
  twin `nextExerciseFromPlan` (`services/sessionPlanExecutor.js:111`) kept in
  sync by comment only.
- **D. Server fatigue advisory.** `routeNextMove` (`routes/coachOps.js:370`)
  sets `next_exercise = queue[0]` from the client-supplied `planned_queue`;
  rendered at `coach-conversation.js:1242`. Multi-lift turns send an empty queue
  (`coach-conversation.js:~1749`), so no advisory exists for them.

The post-log handoff arbitrates: it prefers A and uses C only behind guards
(discard if already completed or not in the engaged plan,
`coach-conversation.js:1804`).

**Contradictions the code allows.**

- C can name an already-logged lift as "next" (the "wanted weighted dips again"
  bug class); only the one handoff call site guards it — any other caller gets
  the resurrected lift.
- Cursor (B) vs remaining (A) can name different "current" lifts: the cursor
  moves on taps and renders, not on logs, and an alias-named current slot never
  matches B's exact-name reconciliation — banner and handoff disagree.
- Advisory (D) is a snapshot taken at request time; handoff (A) re-derives live
  after the coach-LLM awaits. A concurrent log between them lets one turn's
  advisory line and handoff line name different lifts.

---

## 4. Staged write — the client's `pendingWrite`

**Stages** (one nullable object + two monotonic counters; no status field —
`src/app/app.js:4509`):

- *None* — `pendingWrite === null`; Approve disabled.
- *Staged, unproven* — object exists but `pendingWriteHasPreviewProof()` fails
  (`app.js:7181`: requires `test_mode===true`, `sheet_written===false`,
  `no_write_confirmed===true`, per-mode `sheet_write==='skipped'`).
- *Staged, proven (approvable)* — proof passes; Approve enabled (`app.js:7289`,
  `:8397`). Four sub-modes with different payloads: `manual`, `screenshot`,
  `effort-only`, `modality`.
- *In flight* — `writeInFlight === true` in the approve handler (`app.js:8874`).
- *Already-saved* (sub-state) — `duplicateSession === true` gates Approve off
  before any write (`app.js:8397`).

**Moves.**

- none → staged-proven: a `test_mode` dry-run response whose sequence number
  still matches (`submitSeq === previewRequestSeq`); stale responses are dropped
  and can never re-stage (guards at `app.js:7250`, `:8266`, `:8370`).
- staged → none (invalidated): **any** form `input` event, cancel, or start-over
  → `invalidatePreview()` (`app.js:6938`): bumps the sequence, retires the
  correlation, nulls the object, neutralizes stale in-thread Save cards.
- staged → written: approve click → per-mode POST → success teardown.
- in flight → staged (retryable, same write_id): a throw in the approve handler
  re-enables the button and keeps the object (`app.js:9176`). The server receipt
  (§5) is the dedupe safety net.
- in flight → staged, **re-keyed** (fresh write_id): two deliberate re-keys —
  closeout-seal retry (`app.js:9058`) and partial-effort repair
  (`keyPartialRepair`, `app.js:9335`), which also mutates the object's mode to
  `effort-only`.

**Contradictions the code allows.**

- The three lanes accept a "duplicate" under three different predicates:
  screenshot requires `original_sheet_written===true` (`app.js:8913`), modality
  requires only `sheet_written===false` (`:8958`), manual requires
  `original_sheet_write==='success'` (`:8976`). The same server condition is
  client-true in one lane and client-false in another.
- `keyPartialRepair` carries a preview proof earned by a screenshot dry-run onto
  an effort-only write that was never previewed (`app.js:9343`).

**Dual deciders.** Bodyweight has a **twin implementation** of this whole
machine (`pendingBwWrite`, own invalidation, own proof predicate,
`app.js:9240`) — with no verdict gate and no partial state. The two can drift.

---

## 5. Server write receipt (idempotency record) — two implementations

### 5a. File-backed store — the live authority (`services/idempotency.js`)

**Stages** (per `write_id`): `in_progress` → `completed` | `failed`; orthogonal
`token` (attempt token, nulled on fail) and `rehydrated` (loaded from disk);
24 h TTL (`:4`); 5-minute staleness window (`:12`). Seven routes use it
(`/api/log-workout`, `/api/complete-workout`, `/api/log-modality`,
`/api/bodyweight`, `/api/coaching-notes`, `/api/constraints`, undo-last).

**Moves.**

- absent/failed → `in_progress`: `beginWrite` (`:152`) mints a token.
- `in_progress`/`completed` → duplicate: `beginWrite` returns the stored record;
  a completed record's stored **response body is replayed verbatim** to the
  retrying client.
- `in_progress` → `completed`: `completeWrite` (`:215`), token-checked. Note:
  "completed" means *operation finished and response recorded* — **not** "write
  succeeded" (see §6/§7: partial and unverified bodies are stored as completed).
- `in_progress` → `failed`: `failWrite` (`:235`), token-checked, retryable.
- `in_progress` (rehydrated, >5 min old) → `failed`: downgraded at load
  (`:91`) or at claim time (`:165`, WRITE-3) — **only if `rehydrated`**. An
  in-progress record created by the current process is never downgraded: a hung
  write wedges its write_id as a duplicate until TTL or restart.

**Contradictions the code allows.**

- **Durability is best-effort by design.** The default file is
  `/tmp/atlas-idempotency.json` (`:19`). On the current free Render plan /tmp is
  ephemeral (this is the deferred #1363 disk). If `persist()` fails once,
  `persistDisabled` latches and the process runs memory-only with one warning
  (`:139`). A restart then loses every `completed` receipt: a retried write_id
  is *absent* → admitted → re-appended, wherever no second line of defence
  exists (§6, modality).
- A corrupt store file starts empty (`:66`): every prior `completed` record
  vanishes — fail-open by explicit design, the opposite posture from the write
  freeze (§11).
- Two authorities inside one store: the live map vs the JSON file;
  `exportLiveReceipts()` itself returns a `disk_vs_map` comparison with a
  `disk_is_complete` flag (`:~370`). Anything reading the file directly decides
  duplicates differently from `beginWrite`.

### 5b. Supabase receipts — `atlas.write_receipts` (built, **no production caller yet**)

Same machine, second implementation (`services/supabaseAdapter.js:259`):
`status ∈ {in_progress, completed, failed, ambiguous}` + `attempt`,
`attempt_token`, `owner_instance_id`, and `effect_authority ∈ {supabase, sheets}`
bound for the row's life. It adds the `ambiguous` state the file store lacks:
a sheets-authority receipt whose owner died mid-attempt becomes `ambiguous`
(`:330`), resolvable only by an operator supplying destination-side proof
(`resolveAmbiguousReceipt`, `:357`) — deliberately no third outcome. `ambiguous`
rows are never pruned and stay visible past TTL so refusals can explain
themselves. The header (`:230`) states the file store "remains the sole receipt
authority through S2 and S3." The reclaim rules were deliberately aligned with
§5a, but the two are separate code and can drift (e.g. §5a's stale downgrade
requires `rehydrated===true`; the SQL substitutes an owner-instance comparison).
`completeWriteReceipt` (`:374`) has no status predicate — only token match —
so the SQL does not itself encode "only from in_progress."

---

## 6. The main save — `/api/log-workout` pipeline (`index.js:3253`)

**Stages** (encoded across the receipt + response fields `sheet_write` /
`sheet_written`):

- *Dry-run* — `test_mode`: appends nothing; returns `sheet_write:'skipped'`,
  `no_write_confirmed:true`, with a mirrored row partition so the preview shows
  what the live write would append (`:3491`).
- *Admitted* — live request must carry a write_id (`:3520`) and pass the
  writes-frozen gate (`:3528`), then `beginWrite` (`:3533`).
- *Duplicate-replay* — stored response echoed with
  `sheet_write:'skipped_duplicate'`, or 409 while in progress (`:3541`).
- *Claimed* — a session-scoped claim (§6a) wraps the whole read-check-append.
- *Refused-duplicate-session* — the Effort tab already holds the session_id →
  fail + 409 (`:3584`).
- *All-rows-duplicate* — the partition leaves nothing new: nothing appended;
  receipt completed with a synthetic body claiming
  `original_sheet_write:'success'`, `log_rows_written:0` (`:3621`).
- *Partial* — Log append landed, Effort append threw → receipt **completed**
  with `sheet_write:'partial'`, `sheet_written:true`, `effort_rows_written:0`;
  HTTP 500 (`:3743`).
- *Success* — both appends done → `sheet_write:'success'` + the append-proof
  verdict (§7) → `completeWrite` (`:3855`).
- *Committed-unrecorded window* — if finalization throws **after** the rows
  committed, the catch force-completes the receipt with
  `sheet_write:'success'` and no verification (`:~3895`, comment: "never
  failWrite a committed write") — while the original client received HTTP 500
  and believes the write failed.

**Duplicate-ness has four independent deciders**: (1) the write_id receipt,
(2) the Effort session-id guard, (3) the Log composite-key partition
`partitionLogRowsByExisting` (`:3621`), (4) the session claim. The dry-run
preview runs decider (3) best-effort — on a read failure it falls back to
previewing **all** rows (`:3462`), so the preview can promise rows the live
write then skips.

### 6a. Session write claim (`services/sessionWriteClaim.js`)

Free → held (synchronous check-and-set, `:50`) → released (token-checked,
`:75`). A refused caller waits up to 30 s on the holder, then re-acquires and
re-reads; timeout → refusal, never an append. A claim older than 120 s is
**silently evicted** by the next acquirer (`:57`) — the stale holder's release
becomes a no-op, so during a >120 s Sheets stall two writers can be inside the
guarded section at once, with only the row partition preventing duplicates.
In-process only, and it covers **only** `/api/log-workout` —
`/api/complete-workout` appends to the same tabs with no claim (the boundary is
stated at `:31`).

---

## 7. "Did the rows land?" — the saved claim, three deciders

1. **Append receipt (declared authority)** — `verifyAppendReceipt()`
   (`services/appendWriteProof.js:44`): pure check of the append's own
   `updates` envelope (range parses, tab matches, span == rows submitted, every
   row carries the session_id). Attached as `log_write_verification` by
   `/api/log-workout` **only**. Client gate `saveClaimBlockedByVerdict()`
   (`app.js:9258`): a present-but-unverified verdict blocks the saved claim —
   but a **missing** verdict does not block.
2. **Read-back fallback** — `reportWriteVerification()` (`app.js:6774`) →
   `GET /api/log-workout/verify-range` (`index.js:4092`), reached only when the
   response carried no verdict. Its soft "verification was inconclusive" note
   is effectively dead code in the manual lane, because the verdict gate
   returns first — hard block and soft note coexist for the same fact in
   different paths.
3. **Client field checks** — the approve handler independently re-decides
   success per lane from raw response fields (manual: `app.js:8984`;
   screenshot/effort-only: `:8922`; modality: `:8962`). Those lanes receive **no**
   receipt verdict at all — their "written" claim rests on the server's
   self-asserted fields in the same response.

**Contradiction.** `/api/complete-workout` implements its **own, weaker**
append proof inline (`index.js:2946`: range present && counts match — no tab
check, no span arithmetic, no session-ownership check). Two routes can disagree
about what counts as a proven append for identical Sheets behaviour.

---

## 8. `/api/complete-workout` (screenshot / effort-only lane) + plan-event fold

**Stages** — same receipt store (§5a) plus a route vocabulary on `sheet_write`:
`success` / `partial` / **`unverified`** (appends landed but the inline proof
disagreed → receipt **completed** with `{sheet_write:'unverified',
sheet_written:true, proof_mismatch:true}`, HTTP 500, `index.js:2946`) /
`skipped_duplicate`. Two booleans (`writeCommitted`, `liveWriteRecorded`,
`:2422`) hand-roll the two-phase state that §6 expresses structurally.

**Contradictions.**

- The receipt for an unverified write reads status `completed` and
  `sheet_written:true` while the route tells the client "not confirmed as
  saved" — record-level and body-level state assert opposite things; every
  consumer must know to read the body. Uniquely, a retry of that write_id
  re-throws the stored 500 instead of replaying it (`:2817`).
- Session-identity reuse: with no client session_id, a prior attempt's
  server-minted id is recovered **only if the prior record is not `completed`**
  (`:2604`) — a completed prior record mints fresh, and the duplicate-session
  hard-stop is then bypassed for the fresh id (`:2665`).

**The plan-event fold** (`services/sessionPlanEvents.js`,
`services/sessionPlanReader.js`): item `outcome ∈ {planned → completed |
skipped | substituted}` and session `closeout_status ∈ {finalized, abandoned,
(null = open)}` exist **only as appended events**; current state is a fold.
Last `item_outcome` wins (`sessionPlanReader.js:124`); `session_closeout` is
also last-wins (`:117`); any malformed row folds the whole session to `error`,
outranking `finalized` (`:139`).

**Contradictions.**

- The event stream permits a `finalized` closeout **before** later item
  outcomes for the same session; the fold applies those outcomes anyway —
  a session folds as `finalized` while its completion set is still changing.
  Nothing in `buildItemOutcomeEvent` refuses an outcome for a closed session.
- A `substituted` item also counts as `completed` under its performed code
  (`sessionPlanReader.js:143`) — outcome and membership overlap by design.
- Completion is derived three ways that must agree: this fold (which
  explicitly forbids deriving it from `closeout_status`), the client's slot
  list (§2), and closeout finality (§1).
- The same event machine is implemented twice — Sheets store and Supabase
  mirror (`supabaseAdapter.js:172`) — with collision semantics re-implemented
  in each.

---

## 9. `/api/log-modality` — the unguarded append

**Stages** — none of its own; it borrows the receipt (§5a) and then appends
**unconditionally**: `appendRows('Modality_Log', [row])` (`index.js:1611`).
There is no row-level dedupe (no composite-key partition, no session guard)
and no append proof.

**The trap, in the code's own words.** `sheets.js:40` documents that a
500/503/timeout append is *ambiguous* — the row may already be committed —
and must never be retried in-loop; recovery "defers to the upstream write_id
idempotency + composite-key dedupe, which make the client's retry
at-most-once." For this route neither backstop fully exists (no composite-key
dedupe at all; receipts in ephemeral /tmp, §5a). Worse, the handler's catch
calls `failWrite` **unconditionally** (`index.js:1636`) — marking the write
retryable in exactly the case where the append may have landed. Client re-tap
(same write_id, receipt now `failed` → admitted) appends a second, identical
Modality_Log row. A service restart between the ambiguous failure and the
re-tap loses the receipt entirely, with the same result.

---

## 10. Undo and correction of already-written rows

**Undo-last** (`POST /api/log-workout/undo-last`, `index.js:3931`): the client
holds `lastWrite` = {range, session_id, rows} (`app.js:9010`) → rows deleted by
absolute range (`sheets.js:970`), guarded by a read-back session-ownership
check and by `isSessionFinalized` (§1). Terminal; no redo.

**Contradictions.**

- Undo deletes **only the Log rows** — the session's Effort row is never
  removed, leaving an orphan Effort row whose session has no sets (readers
  keying "has effort" on row existence, e.g. the session allocator's existence
  union, then treat the session as trained).
- Undo does not touch the original write's receipt: the write_id stays
  `completed`, so re-approving the same staged write replays
  `skipped_duplicate` — **the undone workout can never be re-written under
  that id**.
- The delete is addressed by absolute row indices captured at write time; any
  intervening insert/delete above that range shifts rows, and only the
  read-back session check stands between that and deleting another session's
  rows.

**Correction** is not an edit: the session loader copies written rows into the
editor and re-writes them as a fresh save (`app.js:9193`); the §6 partition
skips unchanged rows and appends changed ones as **new** rows — a correction
that changes exercise or set_number is an addition, not a replacement, and the
sheet can hold both versions under one session_id.

**Pre-write corrections** (buffer-level, no sheet contact): set-revision
proposals (`src/app/setRevisionProposal.js`) move proposed → approved/rejected,
with *ask-why* deliberately non-terminal (proposal preserved,
`src/app/coach-conversation.js:2308`); consent for the same proposal is decided
twice — the card's endorsement token and the typed lane's
`isExplicitEndorsement` classifier (`src/app/endorsedSetRevision.js:168`) —
two implementations that must agree on what counts as "yes."

---

## 11. Pending decisions that compete for the same utterance

Three pending states can be live at once, each with its own classifier for the
athlete's next message:

- **Pending clarification** (`src/app/pendingClarification.js`): parser-detected
  bodyweight sets held behind a yes/no question. One module-scoped slot
  (`:61`): `{exercise, sets, rows}` — **no session binding, no timestamp, no
  expiry, not persisted**. Held sets are frozen at capture.
- **Replacement proposal** (`src/app/activeReplacement.js:83`):
  `status:'pending'`, staleness by plan fingerprint.
- **Set-revision proposal** (store-held, §10).

Replacement ↔ set-revision have a store-level mutual exclusion (`store.js:97`).
The clarification slot lives **outside** the store and has none.

**Moves (clarification).** none → held: parser returns `needs_clarification`
carrying detected sets (`app.js:7751`). held → committed: an affirmation
matching `CLARIFY_YES_RE` (`pendingClarification.js:18` — "yes / yep / correct /
confirm / do it / …") resolves at the **top of the submit handler, before
finish routing** (`app.js:7569`), committing the frozen rows verbatim into the
current session buffer. held → cleared: a new clarification supersedes it, or a
successful parse-path log clears it — the **only** clear call site in the app
(`app.js:8117`).

**Contradictions the code allows.**

- **The hold survives the session it belongs to.** The module header promises
  "any successful log / session reset clears it" — but no reset path calls the
  clear (grep: `clearPendingClarification` appears in `app.js` only at
  `:8117`). End the session, start a new one, and a bare "yes" commits the
  **previous session's sets into the new session's buffer**.
- **Two affirmation consumers compete for "yes."** `CLARIFY_YES_RE` and the
  replacement lane's `AFFIRM_RE` (`activeReplacement.js:164`) both match bare
  "yes/ok/do it/confirm"; there is no shared arbiter — which pending state
  consumes the turn is an accident of submit-handler ordering.
- **Stale-prescription proposals read as fresh.** The replacement fingerprint
  covers only slot *names in order* (`activeReplacement.js:72`): a numbers-only
  plan change (sets/weight revised) leaves it identical, so a proposal carrying
  the old weight passes `isProposalFresh` (`:103`) and can be approved onto
  changed numbers.
- Proposal slot matching falls back to first significant-word overlap with no
  ambiguity refusal (`activeReplacement.js:52`), where the canonical matcher
  refuses ambiguous matches (`activeSession.js:84`) — "Row" can bind a proposal
  to a slot the canonical session would not touch.
- The armed `pendingSubstitution` token is deliberately not persisted
  (`store.js:170`): a reload between "instead of" and the log silently drops
  the swap; the set logs as an off-plan insert instead.

---

## 12. Session snapshot / resume (`src/app/store.js`)

**Stages.** localStorage snapshot (shape v6, `:170`): absent → persisted →
resumed | discarded. Persisted only when the session has logged sets or an
active plan (`:186`).

**Moves.** Persist on every state change; resume iff shape ∈ [1,6], age ≤
`SNAPSHOT_MAX_AGE_MS` = **12 h** (`:171`), and buffers valid; discard otherwise.

**Contradictions.**

- The 12 h wall-clock age is the only freshness test — **not a date test**: a
  snapshot saved at 23:30 resumes at 07:00 next morning (7.5 h old, different
  training day, same session identity), while one saved at 06:00 is discarded
  at 18:30 the same day, mid-evening-workout.
- Shape versions 1–6 all resume with missing fields defaulted (`:222`): a v1
  snapshot resumes with silently-empty `sessionRevisions`, indistinguishable
  from a v6 session that genuinely had none.
- "Same session" is decided three ways that can disagree: this 12 h clock, the
  server fold's `open`-until-closeout (§8 — a client-discarded session folds as
  open forever, since abandonment is never inferred), and the session-id
  allocator's existence union (§13).

---

## 13. Session identity — the date-driven allocator (`services/sessionId.js`)

**Stages.** `session_id = YYYYMMDD-{AM|PM}-{01..99}`: slot free → allocated.
The **period** comes from the allocation-time clock (hour <12 = AM, `:18`);
the **date** comes from a separately supplied `dateValue`.

**Moves.** `nextAvailableSessionId` (`:66`) scans 01–99 against the durable
existence union (Effort ∪ Log_Cleaned ∪ Session_Plans) and throws
`SESSION_SLOTS_EXHAUSTED` at 99 (fail-closed; the old silent wrap to `-01`,
which merged eleven acceptances into one sealed session, is documented at
`:56`). But the naïve `generateSessionId` (`:22`) — always slot `-01` —
**still exists and is still called**: `buildEffortRowFromParsedMetrics`
(`index.js:874`) stamps an Effort row with `-01` when no session_id is
supplied, even if `-01` belongs to a different workout allocated safely.

**Contradictions.**

- Date/period mismatch is encodable: `dateValue` and the clock are independent
  parameters — an id can carry tomorrow's date with this evening's PM suffix,
  unchecked.
- "Today" has two deciders: server `localTodayIso` under `ATLAS_TIMEZONE`
  (`services/analytics.js:28`) vs the browser-local date the client stamps as
  `session_date` (`planAcceptance.js:214`). Near midnight, or with the timezone
  unset, the same workout is assigned to different days by client and server.
- Session identity itself has three allocators: the client's provisional id,
  and the server's — implemented twice (§6 route and §8 route, `index.js:~3300`
  and `:~2604`).

---

## 14. Effort_Log and Modality_Log entry completeness

**Effort** (`index.js`): an Effort row is *complete*, *placeholder*, or
*absent* — with **no field marking which**.

- Complete contract: `normalizeAndValidateParsedMetrics` (`:914`) — duration,
  active calories (1–3000), total calories (1–4000), average HR (40–220)
  required; peak HR optional. Physically impossible rows (total < active,
  peak < average) are **warnings, not refusals** (`:937`), and persist as
  "complete."
- Placeholder contract: `EMPTY_EFFORT_METRICS` (`:986`) — **all metrics
  blank**, written when a screenshot is unreadable but sets exist, "so session
  linkage and duplicate protection stay intact."
- Row assembly (`:874`) coerces any missing metric to `''` and does not
  distinguish the two contracts. Any reader keying "has effort" on row
  existence (the allocator's union, analytics) treats a placeholder as a real
  effort record.
- A duration-only manual finish passes the entry gate (`hasManualEffortMetrics`,
  `:2419`) but fails the strict validator's calories/HR requirements — the
  open #1635 question lives exactly in this seam.

**Modality** (`services/modalityLogRow.js`): a recognizer record is
*persistable* iff its modality is known (`:77`); `toModalityLogRow` (`:91`)
emits every missing metric as `''`. There is **no completeness floor**: a
`timed_hold` with `duration_sec = null` (a named hold, no time captured)
produces a row whose reason-to-exist value is blank; likewise a
`cardio_steady` with neither duration nor distance. And `duration_sec` means
*per-rep work seconds* for `cardio_interval` but *total seconds* for
`cardio_steady` (`:65` vs `:57`) — same column, two meanings; any consumer
summing it adds per-rep and total durations together.

---

## 15. Deload / training state (`services/deloadStateMachine.js` et al.)

**Stages.** `training_state ∈ {NORMAL, RECOVERY_CANDIDATE, DELOAD_RECOMMENDED,
DELOAD_ACTIVE, POST_DELOAD_EVALUATION}` (`:20`), persisted append-only in the
`Deload_State` tab; current state = **last row** (`services/deloadState.js:102`);
empty/missing/unreadable tab ⇒ `NORMAL`. Legal edges are frozen in
`TRANSITIONS` (`:52`); `transition()` throws on illegal/self edges.

**Moves (only three are persisted).** → `DELOAD_ACTIVE`:
`deloadEngine.beginDeload` (`services/deloadEngine.js:202`), counter set.
`DELOAD_ACTIVE` → counter −1, or → `POST_DELOAD_EVALUATION` at 0:
`recordDeloadSession` (`:226`) — triggered by a **manual route call**
(`routes/coachOps.js:2194`), not by the session-closeout path.
`POST_DELOAD_EVALUATION` → `NORMAL`: `resolvePostDeload` (`:248`), the only
exit. The middle states exist only as per-request *suggestions* from the
fatigue ladder (`services/deloadEscalationLadder.js:44`).

**Contradictions.**

- **`RECOVERY_CANDIDATE` and `DELOAD_RECOMMENDED` can never be persisted** —
  no code path appends them. Every fresh read returns `NORMAL` until a deload
  is accepted, so "Atlas recommended a deload yesterday" has no durable state;
  the ladder re-derives it from today's score or loses it.
- `rowToState` (`deloadState.js:57`) coerces an **unrecognized** stored state
  to `NORMAL` on read, while the writer throws on persisting one: a corrupt
  last row silently reads as "not in a deload" **in the middle of
  `DELOAD_ACTIVE`** — the exact memory loss the module header says must not
  happen.
- `DELOAD_ACTIVE` with counter 0 is a stable readable state; nothing forces
  the decrement to happen — if workouts complete without the manual route
  call, the deload never advances.
- **Three deload deciders with no bridge**: this machine;
  `recoveryDeloadSelection` (`services/recoveryDeloadSelection.js:85`) with an
  unrelated vocabulary (`recovery_state ∈ {cease, peak, deload, reduced,
  monitor, recovered}`) whose `decision:'deload'` never touches `Deload_State`;
  and the 5/3/1 wave's `isDeload` week flag (§16) plus starter-program stall
  deloads, which reduce load without entering `DELOAD_ACTIVE`. A lifter can be
  in all three "deloads" at once, or any one without the others.
- The suggestion is computed even when it contradicts the persisted state
  (e.g. `POST_DELOAD_EVALUATION` + fatigue >90 still suggests
  `DELOAD_RECOMMENDED`, a transition the machine forbids from there).

---

## 16. Program progression — position-derived, no stored state

5/3/1 (`services/intermediateProgramModule.js:51`): position is *derived* from
a caller-supplied `sessionCount` — `cyclePosition = count mod 16`, week 1–4
(week 4 = `isDeload`), day 1–4; `isCycleBoundary` signals the **caller** to
increment training maxes (a comment-level obligation, `:44`). Block/DUP models
(`services/periodizationModule.js:68`) return static phase lists with no
position at all. Starter program: per-lift stall counter → hold → deload
(`services/starterProgramModule.js:114`).

**Contradictions.** `sessionCount` counts *sessions*, not completed positions:
a skipped session and a completed one advance the wave identically, and two
callers deriving the count differently place the same lifter in different
weeks — there is no stored "current week" to arbitrate. The boundary flag
stays true on every call until the count moves; if the caller fails to
increment maxes, nothing remembers the boundary was already presented.
Athlete goals (`services/athleteGoals.js`) are not a state machine at all:
hand-seeded target rows with no achieved flag — goal completion is never
computed as state anywhere.

---

## 17. Migration machinery (S2/S3 — built, mostly dormant)

- **Migration divergences** (`atlas.migration_divergences.state ∈ {open,
  repairing, closed}`): detection by the sweep (`services/migrationSweep.js`),
  repair under a lease token (`services/supabaseAdapter.js:477`); release
  returns a row to `open` — "it NEVER closes it" (`:487`); close requires a
  non-empty proof in the statement + a schema CHECK (`:495`). *Contradiction:*
  `repair_attempts` has **no cap** — a poison divergence can be
  claimed/released forever, never escalating out of `open`. Detection itself
  is decided three ways (sweep, backfill reconciliation
  `services/migrationBackfill.js:235`, shadow-write path) that share identity
  resolvers but compute equality separately.
- **Catalog mirror** (`atlas.exercise_catalog_sync.status ∈ {in_progress,
  verified, failed}` + a *derived* currency verdict by age,
  `services/exerciseCatalogMirror.js:143`): a generation can be `verified`
  yet immediately *not servable* (unparseable `verified_at` ⇒
  `catalog_mirror_generation_unverified`, `:149`). A source-read failure
  records **no generation row at all** (`:97`) — the commonest failure leaves
  no durable `failed` evidence. Not wired into the save path in S2.
- **Sheets-export queue** (`atlas.workout_sessions.sheets_export_state ∈
  {queued, retry_backoff, blocked}`, schema-only, no production caller before
  S4): there is **no `exported` state** — exported-ness is a separate column
  (`sheets_exported_at`). "queued ∧ exported" is the *normal* terminal
  combination; the queue index keys on the timestamp, the state text is
  decided by nothing (`supabase/migrations/20260808000200_workout_core.sql:30`).
  `blocked` is documented as leaving the queue entirely, but the index still
  matches a blocked, unexported row — the invariant is enforced by no code.

---

## 18. Write freeze (`services/writeFreeze.js`)

**Stages.** *Disarmed* (Supabase role never observed configured) → *armed*
(monotonic process latch, `:82`); when armed, each request reads the single
row: `open` iff exactly one valid row says `frozen=false`; every read failure,
timeout (2500 ms), missing/duplicate/malformed row ⇒ **frozen** for that
request (fail-closed, `:154`). Deliberately a single decider — no env, file,
or header override (`:40`).

**Contradiction.** `armed` is process-local memory: two instances can disagree
about whether the control exists — one booted while configured is armed
forever (later config loss ⇒ frozen reads), one never configured answers
`not_armed` ⇒ **open** (`:160`). During a config rollout, "writes open because
the control is absent" and "writes frozen because the control is unreachable"
are both live states of the same deployment.

---

## 19. App authentication state (client, `src/app/api.js`)

**Stages.** `serverAuthState ∈ {unknown, authenticated, unauthenticated}`
(`:21`), written only by server responses. Any protected 2xx → authenticated;
any 401 → unauthenticated; transport failure → **no transition** (last
confirmed value stands). `isConnected()` (`:43`) is optimistic: `unknown`
counts as connected.

**Contradictions.** With sessions disabled, the probe deliberately leaves the
state `unknown` forever while the app works fine on the legacy key — Settings
(raw tri-state) and the optimistic gate present different answers about the
same working connection. `sessionLogout` sets `unauthenticated`
unconditionally (`:127`) even when the server logout failed and the cookie is
still valid — the next probe flips it back: a logout→probe→authenticated
oscillation. A third, independent health verdict lives in
`src/app/settingsHealth.js` (binary reachability), and a fourth server-side in
`services/atlasStatus.js` (§20).

---

## 20. Service health (server, `services/atlasStatus.js`)

**Stages.** `overall_status ∈ {healthy, degraded, unknown}` (`:70`), computed
by `computeOverall` (`:347`): hard-fail codes (Sheets/LLM unconfigured, latest
test FAIL, synthetic rows present) ⇒ `degraded`; **no positive trusted-test
PASS ⇒ `unknown` even with perfect config**. Test verdicts are regex-parsed
from a doc file (`docs/TEST_QUEUE.md` LT cards, `:243`): a card containing
both ✅ and FAIL words resolves by ✅ presence (`:249`); freshness is *days
since the newest date string in the card* (`:271`).

**Contradictions.** The same deployment can be healthy in Settings (backend
reachable) while the Control Tower says `unknown`/`degraded` (no recent
trusted PASS in a doc). The public status endpoint always reports
`supabase_migration: observed:false` (`:470`) while the CLI observes real
counts — "not observed" and real numbers for the same contract, depending on
the surface.

---

## 21. Coach-engine mode (env-driven, per request)

**Stages.** `ATLAS_COACH_ENGINE ∈ {legacy (unset/other), hybrid, brian}` read
**directly from env at each request** at three separate sites in `index.js`
(`:1679`, `:1787`, `:2010`) plus `services/brainShadow.js:75`. `hybrid`: the
Brain decision is computed and attached as shadow; legacy numbers serve.
`brian`: a validated Brain `progression` decision drives `next_target`,
falling back per-lift to legacy on any error or active deload. Shadow
persistence is a second flag (`ATLAS_BRAIN_SHADOW_PERSIST`, `:84`). A
promotion rail (`services/coachEnginePromotion.js`) computes whether `brian`
*may* drive — "never done implicitly" (`:15`).

**Contradictions.** Mode has no recorded transition: flipping the var
mid-session changes which authority computes the next recommendation, and
nothing in the Log rows records which mode served (with shadow persistence
off, there is no durable record at all). The promotion rail can judge `brian`
**ineligible while `ATLAS_COACH_ENGINE=brian` keeps serving it** — eligibility
is computed, never enforced; the drive sites check only the env var. Parallel
flags with identical shape (`ATLAS_INTENT_ROUTER`, `ATLAS_DRIFT_SHADOW`,
`ATLAS_INTERACTION_TRACE`, `ATLAS_SESSION_PLANS_WRITE`,
`ATLAS_SUPABASE_SHADOW_WRITE`) multiply the combinations.

---

## 22. Onboarding calibration (derived, per lift — `services/onboardingState.js`)

`calibration_status ∈ {calibrating, graduated}` mapped from
`lift_confidence ∈ {none, low, medium, high}` (produced by
`services/exerciseBenchmark.js`): medium/high → graduated; none/low/**unknown**
→ calibrating (fail-safe, `:46`). Nothing is stored; "graduation" happens
implicitly when the ladder crosses medium (≥3 logged sessions). The module
forbids collapsing to a session-level gate (`:20`) but still exports
`all_graduated` / `any_calibrating` booleans — the invariant is
comment-enforced only, and any future consumer can collapse it.

---

## 23. Flight Recorder & bug reports — telemetry with no lifecycle

Both are write-once sinks, listed because their rows *look* like state:

- **Flight Recorder** (`services/flightRecorder.js`): buffer tiers only — ring
  (in-memory, cap 100) → pending flush (≤2000 ms or 100 rows) → appended to
  the `Flight_Recorder` tab. Flush is fire-and-forget with errors swallowed
  (`:272`): an event can be visible via the read endpoint while its durable
  append silently failed — "recorded" has two tiers with no marker
  distinguishing them. No recorded→reviewed→resolved progression exists.
- **Bug reports** (`services/bugReport.js`): derived flag cells (`Stale Shell`,
  `UI Blocked`) are capture-time snapshots stored permanently — a report keeps
  asserting a stale shell after the user updates. Nothing can be marked
  triaged/fixed in any store.

**Retry/queue note (cross-cutting).** There is **no write queue anywhere** in
the app. Retry exists in exactly four places: Sheets transport retry
(`sheets.js:82`, appends only on unambiguous pre-write rejections; reads use a
different predicate, deliberately never shared), the client dry-run's
transport retry, receipt-level retryability (§5a), and the session claim's
30 s wait (§6a) — which is a refusal on timeout, not an enqueue.

---

# Ranked problem list (worst user harm first)

1. **A "yes" can log a previous session's sets into a new session** (§11).
   The pending-clarification hold has no session binding, no expiry, and is
   never cleared by session end/reset — despite its own header promising it
   is. *User harm:* sets silently enter the wrong workout's record; the
   athlete may never notice their log contains work from another day.
2. **Modality writes can duplicate silently** (§9 + §5a). An ambiguous append
   failure is marked retryable by the handler itself; Modality_Log has no
   row-level dedupe; the receipt that would catch the retry lives in
   ephemeral /tmp and degrades to memory-only after one persist failure.
   *User harm:* duplicate plank/cardio rows in the permanent record — wrong
   PBs, wrong history — with no signal anything went wrong.
3. **`finalized` can be recorded for a workout that was never saved — and it
   blocks undo** (§1). The banner End-session button emits `finalized` at
   click; the Finish path emits it only on an approved save. *User harm:*
   the record claims a completed workout that doesn't exist, and the finality
   gate then refuses the undo that would fix a genuinely wrong save.
4. **Receipts assert "completed/success" for writes that failed or were never
   verified** (§6, §8). Partial writes and unverified writes are stored as
   `completed`; the log-workout finalize-catch stores `sheet_write:'success'`
   with no verification after the client was told HTTP 500. *User harm:* the
   athlete is told (on retry/replay) that a save is proven when it isn't —
   the trust contract the whole preview→approve design exists to protect.
5. **Client and server disagree about whether a slot is complete** (§2).
   The server completes a 3-set slot on 1 logged set; the client requires the
   full count. *User harm:* server closeout math (remaining work, completion)
   can declare work done that the athlete's own screen says is unfinished.
6. **A locally-resumed session can resurrect a server-finalized one** (§1,
   §12). The snapshot never consults finality. *User harm:* logging continues
   into a session the record considers closed; two versions of the workout
   diverge.
7. **Undo leaves an orphan Effort row, and the undone workout can never be
   re-written under its write_id** (§10). *User harm:* the sheet keeps
   claiming an effort record for a deleted workout, and the obvious recovery
   (re-approve the same preview) is refused as a "duplicate."
8. **A corrupt Deload_State row silently reads as NORMAL mid-deload** (§15).
   *User harm:* the app forgets an active deload and prescribes full loads
   again — the one machine whose whole job is load safety fails open.
9. **"Next" has four deciders that can disagree inside one turn** (§3).
   *User harm:* the coach names a lift that's already done, or the banner and
   the handoff point at different lifts — visible, trust-eroding, and the
   historical source of several named bug fixes.
10. **The same session is "the same session" by three different clocks**
    (§12, §13). 12-hour snapshot age vs calendar date vs server fold.
    *User harm:* yesterday's workout resumes as today's (or today's evening
    workout is discarded as stale), splitting one day's training across two
    records.
11. **Coach-engine mode can change mid-session with no record of which
    authority served** (§21), and the promotion rail that judges eligibility
    is never enforced. *User harm:* inconsistent prescriptions within one
    session, unexplainable afterward.
12. **Entry completeness has no floor and two contradictory contracts**
    (§14). Placeholder Effort rows are indistinguishable from real ones; a
    timed hold with no duration still writes a row; `duration_sec` has two
    meanings in one column. *User harm:* history and analytics quietly absorb
    empty and mis-summed records.
13. **Health has four independent verdicts** (§19, §20), one of them parsed
    from a Markdown doc's ✅/FAIL words. *User harm:* Settings says connected
    while the status page says degraded (or vice versa) — support and
    diagnosis chase ghosts.
14. **Dormant-machinery traps** (§5b, §17): a second receipt machine, an
    export queue whose terminal state is "queued ∧ exported," a divergence
    repair loop with no attempt cap. *User harm:* none today (no production
    callers) — listed because each becomes a live contradiction the day its
    cutover lands without a single-owner decision.

---

# Proposed fixes for the top 3 (proposals only — nothing here is implemented)

## Fix 1 — Bind the clarification hold to its session (§11)

**Change:** give the held record an owner. Capture the live session's identity
(`session_id` when established, else the snapshot's session date + plan
fingerprint) into the held object in `setPendingClarification`; make
`resolvePendingClarification` refuse (and clear) when the live identity
differs; and call `clearPendingClarification()` from `endPlannedSession()` so
the header's documented contract becomes true. One owner for the decision:
`pendingClarification.js` holds and judges the hold; `app.js` only tells it
when a session ends.
**Files:** `src/app/pendingClarification.js`, `src/app/app.js` (capture site
`:7751`, resolve site `:7569`, `endPlannedSession` `:3185`).
**Proving test:** hold sets in session A → end session → start session B →
send "yes" → nothing is committed and the hold is gone; same-session "yes"
still commits exactly the held sets.

## Fix 2 — Make modality writes at-most-once like the main save (§9)

**Change:** stop marking ambiguous modality failures retryable. In the
`/api/log-modality` catch, mirror the discipline `sheets.js` already documents:
on an ambiguous error (500/503/timeout), decide from evidence before releasing
the write_id — read back the session's Modality_Log rows; if the row is
present, `completeWrite` with the success body; if proven absent, `failWrite`;
if the read-back itself fails, complete the receipt as `unverified` (the §8
vocabulary) instead of failed, so a re-tap replays a refusal rather than
appending again. The receipt becomes the single owner of "did this modality
write land," as it already is for `/api/log-workout`.
**Files:** `index.js` (`/api/log-modality` handler, `:1593`), possibly one
read-back helper beside `services/appendWriteProof.js`. No client change.
**Proving test:** simulate an append that commits server-side then returns
500 → the receipt does not become `failed`; a client retry with the same
write_id appends **no** second row; simulate a proven-absent failure → retry
is admitted and appends exactly once.

## Fix 3 — One timing rule for `finalized`: emit on approved save, nowhere else (§1)

**Change:** make the banner End-session button behave like the Finish flow it
duplicates: route it through the same closeout path (`handleLogIt` →
approve), and let the approve handler be the **only** emitter of
`finalized`. If the athlete ends with nothing saved, emit `abandoned` (the
vocabulary already exists) or nothing — but never `finalized`. One owner:
the approve handler at `app.js:5453`.
**Files:** `src/app/app.js` only (End-session handler `:3092`; emitter
`:5453`).
**Proving test:** start an accepted plan, log sets, tap End session, dismiss
the save → Session_Plans holds **no** `finalized` event for the session (and
undo-last is not finality-blocked); approve the save instead → exactly one
`finalized` event, emitted once.
