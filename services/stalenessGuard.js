'use strict';

// Staleness guard — extracted from analytics.js recommendNextSet (One-Brain
// migration item 8: lifecycle decisions leave the fused file one at a time).
// Pure: no I/O, no LLM, no Sheets, no write. Behavior and wording are
// byte-identical to the inline original.
//
// Progression (adding load, adding a rep) assumes the last session is recent.
// After a long gap, adding weight off old data is a guess — repeat the last
// working weight to reconfirm first. Either way the age is stated so the
// advice reads honestly instead of pretending the gap isn't there.
//
//   > 10 days  → override to a repeat (reps-only for bodyweight lifts),
//                confidence downgraded (high → medium, anything else → low).
//   7–10 days  → keep the advice, append the age to the reasoning.
//   otherwise  → unchanged (including a null/unknown gap).
//
// `current` is { nextWeight, nextReps, recommendation, reasoning, confidence };
// returns the (possibly) adjusted copy — never mutates the input.
function applyStalenessGuard(current, { daysSinceLastSession, isBodyweight, lastSet }) {
  if (daysSinceLastSession != null && daysSinceLastSession > 10) {
    const out = { ...current, nextReps: lastSet.reps };
    if (isBodyweight) {
      out.recommendation = `Repeat ${out.nextReps} reps to reconfirm this lift.`;
      out.reasoning = `Based on your last session, ${daysSinceLastSession} days ago — too long a gap to assume progression. Repeat last session's reps and see where you are before adding any.`;
    } else {
      out.nextWeight = lastSet.weight;
      out.recommendation = `Repeat ${out.nextWeight} × ${out.nextReps} to reconfirm this lift.`;
      out.reasoning = `Based on your last session, ${daysSinceLastSession} days ago — too long a gap to assume progression. Repeat the last working weight and see where you are before adding load.`;
    }
    out.confidence = current.confidence === 'high' ? 'medium' : 'low';
    return out;
  }
  if (daysSinceLastSession != null && daysSinceLastSession >= 7) {
    return { ...current, reasoning: `${current.reasoning} Based on your last session, ${daysSinceLastSession} days ago.` };
  }
  return current;
}

module.exports = { applyStalenessGuard };
