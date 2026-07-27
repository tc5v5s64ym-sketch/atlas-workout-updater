# Issue #1165 Slice 3 — Turn/Write Review Artifact

## Purpose

The coach turn and the write it authorizes happen on different HTTP requests. Slice 1 created the
server correlation registry and `[turn-write-proof]` record; slice 2 carried the canonical
`turn_id` and preview pairing through the real client approval paths. Slice 3 is the read-only
consumer that makes those two records reviewable together.

Run it against a captured deployment log:

```text
npm run atlas:turn-write-artifact -- <logfile>
npm run atlas:turn-write-artifact -- <logfile> --json
```

It also accepts the log stream on stdin. The tool is offline and deterministic: it has no
credentials, network access, Sheet access, write route, or application-state mutation.

## Input and join contract

The consumer recognizes only:

- `[interaction-trace]` records emitted by `services/interactionTraceShadow.js`;
- `[turn-write-proof]` records emitted by `services/turnCorrelation.js`.

Records join only on the existing canonical `turn_id`. No second trace identity is minted. Log
completion order does not affect the join. One trace may have up to the existing bounded five write
attempts because the documented closeout seal retry legitimately re-mints `write_id`.

The log stream is untrusted input. `services/turnWriteArtifact.js` rebuilds both record types under
closed field whitelists, validates bounded shapes and canonical stage order, and rejects malformed,
unknown-route, over-limit, capability-bearing, or fingerprint-bearing records. The artifact has no
field for pairing tokens, payload fingerprints, workout rows, prompts, coach prose, credentials,
Sheet identifiers, or arbitrary nested values. Client-controlled string proof fields that can carry
arbitrary prose (`write_id`, top-level `reason`, and append-range strings) are omitted; bounded
attempt identity and numeric/boolean write evidence remain.

## Reviewability

A turn is reviewable only when all of these hold:

1. exactly one structurally valid interaction trace exists for the turn;
2. at least one structurally valid write-proof record exists for the same `turn_id`;
3. the server pairing says `established_at_preview:true` and `payload_bound:true`;
4. the proof contains positive write evidence, explicit W1–W3 no-write evidence, or a bounded
   idempotent no-write outcome;
5. no relevant projection was withheld and no seal/closeout contradiction remains.

The explicit no-write tuple outranks incidental preview bookkeeping such as `effortWritten:true`.
Conversely, `sheet_write:'unverified'`, `partial`, or `skipped_duplicate_in_progress` never counts as
a confirmed/reviewable write even if another field is positive.
Contradictory positive-write and explicit no-write claims fail closed. Seal evidence with a positive
new-seal count but `sheet_written:false`, and skipped closeout evidence without a positive skip
count, are likewise non-reviewable rather than inferred as successful replays.
Explicit no-write proof additionally requires `test_mode:true`. A live `/api/log-workout` success
requires at least one positive Log or Effort row count, and **every** positive count must carry its
own append range naming that tab, spanning exactly that tab's contract columns, and covering exactly
that many rows — one range-backed tab never substantiates the other's count. The expected column
width is derived from `config/columns.js` (`Log_Cleaned` A:L, `Effort` A:I), so a schema migration
cannot silently widen what counts as W3 evidence. The range itself is reduced to an internal
presence verdict and is never emitted. Seal mismatch-only count fields cannot coexist with a
successful seal classification.

A claimed main write must substantiate itself. The seal and the closeout event are *independent
sidecar writes*: on the all-rows-duplicate branch — which claims no main write at all — their own
positive evidence legitimately makes the turn reviewable, but they describe a different write and
never stand in for a claimed main append whose own W1–W3 tuple does not hold.

`ledger_seal_reason` is a closed vocabulary taken from the real producers — `sealCloseout`
(`services/sessionPlanSetsStore.js`) plus the `seal_error` the route itself synthesizes when that
call throws (`index.js`) — and every value in it describes an outcome that did **not** stamp a row:
a dry run, a verified no-op, a failure, or a proof mismatch. A genuine fresh stamp carries no reason
at all, so any reason presented beside a positive stamp claim is a mismatch, and a reason outside
the vocabulary makes the record rejected rather than reflected. The vocabulary must stay complete:
omitting a reason a producer really emits would reject that whole record and lose the join, so a
genuine failure could not be reviewed at all.

**Every positive state requires its producer's complete tuple**, not merely the fields that look
affirmative — absent means unknown throughout:

- `sealed` — `sheet_written:true`, `no_write_confirmed:false`, positive `sealed`, and the sibling
  `already_sealed` count the producer always emits beside it. (`column` is *not* required: the
  `ledger_seal` projection does not carry it, so it never reaches this consumer.)
- `already_sealed` — the replay booleans and counts **plus** `reason:'all_sealed'`. Other
  non-writing outcomes share those booleans, so the discriminator is what separates them.
- `verified_no_new_seal` — only `tab_missing` and `no_rows` reach it, and both carry
  `no_ledger:true`, `already_sealed:0`, and their own reason.
- closeout counts — `writeSessionCloseout` appends exactly one event, so only `written:1,skipped:0`
  and `written:0,skipped:1` are producible.
- `idempotent_no_write` — the all-rows-duplicate closeout path is the only correlated duplicate
  producer (an ordinary early replay is never recorded), so its whole tuple is required rather than
  any single duplicate or replay signal.

Append ranges are validated against the **configured** tab names (`LOG_SHEET_NAME` /
`EFFORT_SHEET_NAME`, `sheets.js`), not hard-coded defaults: the real routes append to the configured
tab and Google echoes it, so hard-coding would call every genuine append on an overridden
deployment insufficient.

Positive-write **classification** and **contradiction detection** are separate questions, and
tightening the first must never weaken the second. A row count cannot substantiate a generic-route
write — `/api/log-modality` and `/api/bodyweight` emit `sheet_written:true` and no count at all —
but any append indicator still contradicts an explicit no-write claim. Both contradiction arms
therefore test the broad positive signal rather than the narrower classification predicates: a
success claiming `sheet_written:false` beside real append evidence is a corrupted record whichever
route emitted it, and stays `contradictory` even when it also fails the complete-tuple check.

Two impossibilities are **state-independent** and are diagnosed before any terminal-state
classification: the explicit W1 no-write tuple beside real append evidence, and a dry run beside any
positive append signal. Neither can be true whatever `sheet_write` claims, so a corrupted record
must not hide behind its own claimed state. The `!claimsSuccess` arm deliberately stays *below* the
terminal returns: the genuine `partial` and `unverified` bodies really do carry `sheet_written:true`
with a positive log count, and the in-progress duplicate spreads the original's counts, so hoisting
it would call every real one of those contradictory and discard the records that most need review.

Both per-tab success bodies emit **both** row counts as numbers on every live write —
`/api/complete-workout` at `index.js:2723` (an explicit `0` on an effort-only completion) and
`:2745`, `/api/log-workout` at `index.js:3416-3417`. An absent count therefore means the projection
lost part of the producer tuple, not that zero rows were intended, and both are required on a
claimed success. Without that, a missing count vacuously satisfies the "every positive count carries
its own range" clause and a truncated record reads as a confirmed write.

`/api/complete-workout` is held to the same **per-tab range-backed** tuple as `/api/log-workout`,
since it verifies those exact row counts against the ranges before returning. `sheet_written`
remains authoritative there: the Effort append is unconditional and the success gate requires
`effortRowsWritten === 1` regardless of log rows, so every genuine success carries
`effortWritten:true` and therefore `sheet_written:true`. An "effort-less completion" is not an
emitter shape, and a success claiming `sheet_written:false` is a corrupted record. The genuinely
variable case is the reverse — an **effort-only** completion, where `logProofOk` is vacuously true
with no log rows; the per-tab rule already accepts that because a zero count needs no range.

That route additionally requires the **Effort** tuple on every success (`effort_rows_written === 1`
with its range), because the Effort append is unconditional and the success gate demands it
regardless of log rows — so a log-only success is unreachable there, unlike `/api/log-workout`,
whose ordinary shape is an effort-less log append.

`no_ledger` and `read_failed` are emitted only on non-stamping seal outcomes, so no positive seal
state accepts them. The `disabled` and `no_plan` closeout envelopes require `captured:false` with
zero-or-absent counts, matching their producers.

`closeout_fully_verified` is the **route's own verdict** and is honored, never recomputed. It is
also **required** whenever seal or closeout evidence is present: both emitting branches attach it
whenever they attach `ledger_seal`, so its absence there is unknown evidence, not an implicit
positive verdict. A plain main write carries no such evidence and needs no verdict.

The CLI's `source` label is a filename the operator chose, so it is free text on the same footing as
`session_id`: only a bare opaque basename is published, directory components are dropped, and
anything else is omitted.
`closeoutVerification` (`index.js`) returns false for a failed event capture and for a planned
closeout whose ledger is missing, even when the seal reports `sealed_ok:true` and the Session_Plans
event was written; a present `false` therefore makes the write non-reviewable.

`session_id` is free text as far as any contract goes — neither the server nor the client
constrains it beyond "nonempty, bounded, trimmed" — so it can carry workout prose or a Sheet range.
There is no producer shape to validate against, so the artifact publishes only ids that are already
opaque identifiers and marks anything else `unpublishable`: the record and its join are retained,
the raw value never reaches machine or human output, and the unusable identity makes the turn
non-reviewable. `unpublishable` stays distinct from `absent` — an identity that exists but cannot be
shown is not one that was never recorded.

Nullability is defined **per proof key**, never globally: a blanket allowance would bypass every
field-specific shape check and admit values no producer emits (a present-but-null `test_mode` is
malformed, not the absent field W2 reads as a live write). Only `ledger_seal_updated_cells` and
`session_plans_closeout_plan_version` are genuinely emitted as null, and rejecting either would
discard a real record.

Seal evidence is read **seal-locally**. `ledger_seal_sheet_written` is the only evidence that the
independent sidecar write occurred; the main write's `sheet_written` describes a different write and
is never borrowed. Absent means unknown, not false, so a positive stamp count with no seal-local
write evidence is indeterminate rather than a successful seal.

`complete` means every included turn is reviewable and no marker record was rejected. `partial`
means at least one record exists but a turn is missing, ambiguous, rejected, unbound, withheld,
cross-session, or contradictory. A rejected marker with no recoverable `turn_id` still makes the
whole artifact partial. `empty` means there is no accepted trace or proof. CLI exit codes are 0, 1,
and 2 respectively.

## Seal and closeout honesty

Seal states are deliberately non-interchangeable:

A verified seal that stamped nothing must carry the producer's complete tuple
(`sheet_written:false`, `no_write_confirmed:true`, `sealed:0`); a bare `sealed_ok:true` with no
seal-local write flag, counts, or reason is indeterminate, not verified.

- `sealed` — a positive new seal stamp (`sealed_ok:true`, `sheet_written:true`, positive `sealed`);
- `already_sealed` — an idempotent replay verified existing seals but wrote no new stamp;
- `seal_proof_mismatch` — seal write evidence coexists with `sealed_ok:false`;
- `failed`, `withheld`, or `indeterminate` — never reviewable as a successful seal.

`seal_proof_mismatch` always has `successfully_sealed:false`. A replay may be verified, but
`new_seal_write:false` keeps it distinguishable from a fresh stamp.

The Session_Plans closeout projection includes validated `plan_version`, the closeout row
discriminator. A claimed written or idempotently skipped closeout with that discriminator missing
or withheld is unidentified and cannot substantiate which closeout row was written or replayed.

## Withheld versus absent

Projection validation remains strict. When an intended projected field is present but fails its
shape, length, or field validator, the write-proof record adds its fixed projected field name to
`withheld_evidence`. It never includes the rejected value. A field that was genuinely absent has no
marker. This gives the artifact the required distinction without weakening projection validation
or exposing malformed client input.

## Evidence

- `test/turnWriteArtifact.test.js` — ordering, cross-turn/cross-session refusal, attempt bounds,
  integer proof counts, proof sufficiency, effort-bearing preview no-write precedence,
  unverified/partial/in-progress and contradictory proof refusal, explicit test-mode no-write
  proof, range-backed live Log/Effort success, positive-evidence closeout discriminators for writes
  and replays, impossible seal-count refusal, seal classifications, withheld/absent distinction,
  leakage refusal (including client-controlled proof strings and source labels), CLI output, and
  non-zero partial/empty behavior.
- `test/turnWriteArtifactIntegration.test.js` — captures the actual interaction-trace emitter and a
  real registry preview → pairing → live resolution → write-proof emitter, then joins their log
  lines.
- `test/turnWriteProofCloseoutIntegration.test.js` — both Session Plan lanes enabled against
  stubbed Sheets; the genuine new stamp, idempotent replay, and conflicting seal are passed through
  the artifact classifier.

No W1–W3 field is renamed or weakened. No Render flag changes. Phase 4 remains **NOT YET**, Phase 5
has not begun, and no owner gate is authorized by this artifact.
