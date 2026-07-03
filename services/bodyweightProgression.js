'use strict';

// Bodyweight rep-progression — extracted from analytics.js recommendNextSet
// (One-Brain migration item 8: lifecycle decisions leave the fused file one at
// a time). Pure: no I/O, no LLM, no Sheets, no write. Behavior and wording are
// byte-identical to the inline original.
//
// Bodyweight lifts carry no external load, so progression is rep-based — never
// a weight bump (0 + increaseAmount would otherwise produce "Increase to 5 ×"
// nonsense). With a logged RIR: at/near failure → hold the rep count; anything
// above → add a rep (confidence high at RIR ≥ 2, else medium). Without an RIR
// the default is a low-confidence repeat.
//
// Returns { recommendation, reasoning, nextReps, confidence } for the caller
// to fold into its in-flight recommendation state.
function bodyweightRepProgression(lastSet) {
  let recommendation = `Repeat ${lastSet.reps} reps and keep form tight.`;
  let reasoning = 'Bodyweight movement — progress by adding reps, not load.';
  let nextReps = lastSet.reps;
  let confidence = 'low';
  if (lastSet.rir !== null && lastSet.rir !== undefined && Number.isFinite(lastSet.rir)) {
    if (lastSet.rir <= 0) {
      nextReps = lastSet.reps;
      recommendation = `Hold ${nextReps} reps — the last set was at or near failure.`;
      reasoning = 'RIR ≤ 0 means the last set was very close to failure. Bank clean reps at this count before chasing more.';
      confidence = 'high';
    } else {
      nextReps = (lastSet.reps || 0) + 1;
      recommendation = `Add a rep — target ${nextReps} reps next set.`;
      reasoning = `RIR ${lastSet.rir} leaves room to progress — add a rep before making the movement harder.`;
      confidence = lastSet.rir >= 2 ? 'high' : 'medium';
    }
  }
  return { recommendation, reasoning, nextReps, confidence };
}

module.exports = { bodyweightRepProgression };
