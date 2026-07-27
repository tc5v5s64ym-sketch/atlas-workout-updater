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

`complete` means every included turn is reviewable and no marker record was rejected. `partial`
means at least one record exists but a turn is missing, ambiguous, rejected, unbound, withheld,
cross-session, or contradictory. A rejected marker with no recoverable `turn_id` still makes the
whole artifact partial. `empty` means there is no accepted trace or proof. CLI exit codes are 0, 1,
and 2 respectively.

## Seal and closeout honesty

Seal states are deliberately non-interchangeable:

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
