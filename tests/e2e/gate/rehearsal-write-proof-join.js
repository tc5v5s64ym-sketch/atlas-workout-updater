'use strict';

// ── F-SB4B trace ↔ turn-write-proof join: the LIVE write proof (TEMPORARY; sunset: F-SB4C) ──
//
// THE DEFECT THIS MODULE EXISTS TO CLOSE. Scorecard condition 19
// (trace_write_join) claims the InteractionTrace and the turn-write proof join
// "on the live write turn". The spec computed that join from a proof selected
// as: the first proof whose sheet_write is 'success', OR — the fallback — the
// LAST proof of any kind. A preview also emits a [turn-write-proof] record for
// the SAME turn_id (pairing.write_attempt 0, proof.sheet_write 'skipped'), so
// when a run produced a preview proof but NO live-write proof, the fallback
// promoted the preview record and the join passed on a turn where no live
// write ever happened — exactly the C93176 failure family (a Save whose claim
// never attached to a real write) wearing a PASS. An independent audit
// reproduced the spec computation verbatim and fed preview-proof-only evidence
// to the real scorecard: trace_write_join PASS.
//
// THE RULE: the join may only use a LIVE write proof — a record whose
// proof.sheet_write is 'success'. Verified against every real proof record in
// the rehearsal artifacts (50 records): each carries pairing.write_attempt as
// an integer at the record's top level, 0 for the preview (sheet_write
// 'skipped') and 1 for the live write (sheet_write 'success'), with no other
// combination observed. So when write_attempt is present as a number it must
// also be >= 1; sheet_write 'success' is required in all cases. No proof
// meeting the gate → no join (join_ok false), exactly as the zero-proofs case
// behaved before. There is deliberately NO fallback to any other proof.
//
// The selection lives here, pure, so it is unit-pinned
// (test/rehearsalWriteProofJoin.test.js): a preview-only proof set must not
// join; a live proof set must. The spec's join computation — the selected
// proof's turn_id must appear among the trace turn_ids — is unchanged apart
// from this selection.

// A parsed [turn-write-proof] record (services/turnCorrelation.js
// buildWriteProofRecord): the write outcome lives under `proof`, the attempt
// ordinal under the top-level `pairing`.
function isLiveWriteProof(record) {
  if (!record || typeof record !== 'object') return false;
  const proof = record.proof && typeof record.proof === 'object' ? record.proof : null;
  if (!proof || proof.sheet_write !== 'success') return false;
  const pairing = record.pairing && typeof record.pairing === 'object' ? record.pairing : null;
  const attempt = pairing ? pairing.write_attempt : undefined;
  if (typeof attempt === 'number' && !(attempt >= 1)) return false;
  return true;
}

// The first live write proof in the run's proof records, or null when the run
// produced none. Order is the server's emission order (parseMarker preserves
// it), matching the pre-extraction `find` semantics.
function selectLiveWriteProof(proofs) {
  if (!Array.isArray(proofs)) return null;
  return proofs.find(isLiveWriteProof) || null;
}

// The condition-19 observation { join_ok, turn_id, detail } from the run's
// parsed [interaction-trace] and [turn-write-proof] records.
function evaluateTraceWriteJoin(input) {
  const i = input && typeof input === 'object' ? input : {};
  const traces = Array.isArray(i.traces) ? i.traces : [];
  const proofs = Array.isArray(i.proofs) ? i.proofs : [];
  const liveProof = selectLiveWriteProof(proofs);
  const turn_id = (liveProof && liveProof.turn_id) || null;
  const join_ok = Boolean(turn_id) && traces.some((t) => t && t.turn_id === turn_id);
  return { join_ok, turn_id, detail: `${traces.length} traces, ${proofs.length} proofs` };
}

module.exports = { isLiveWriteProof, selectLiveWriteProof, evaluateTraceWriteJoin };
