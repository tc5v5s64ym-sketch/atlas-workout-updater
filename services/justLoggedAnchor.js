'use strict';

// In-workout just-logged anchor + the effort verdict — extracted from
// analytics.js (One-Brain migration item 8: lifecycle decisions leave the
// fused file one at a time). Pure: no I/O, no LLM, no Sheets, no write.
// Behavior is byte-identical to the analytics.js originals; analytics.js
// re-exports both so every existing consumer is unchanged.

// Effort read for a logged set: how the ACTUAL logged RIR compares to the target
// RIR. Deterministic — the rule engine owns this verdict; the coaching LLM only
// words it and must never derive its own read of how hard a set was.
//   failure   → RIR ≤ 0: at or near failure; acknowledge it and back off.
//   far_easy  → RIR ≥ target + 5: way under the target — not "on target with room",
//               it's under-effort; the read is "add real weight", not "nice work".
//   easy      → target + 2 ≤ RIR < target + 5: within reserve; room to add a bit.
//   hard      → 0 < RIR < target: a grinder, just shy of the target.
//   on_target → RIR at (or one above) the target.
// Returns null when no RIR was logged — there is nothing to read.
function effortVerdict(rir, targetRir) {
  if (rir == null || !Number.isFinite(Number(rir))) return null;
  const r = Number(rir);
  const t = Number.isFinite(Number(targetRir)) ? Number(targetRir) : 2;
  if (r <= 0) {
    return { level: 'failure', target_rir: t, headline: 'That set was at or near failure.' };
  }
  if (r - t >= 5) {
    return { level: 'far_easy', target_rir: t, headline: `Far too light — RIR ${r} against a target of ${t}, ${r - t} more in reserve than the goal. That's under-effort; add real weight next time.` };
  }
  if (r - t >= 2) {
    return { level: 'easy', target_rir: t, headline: `Well within reserve — RIR ${r} against a target of ${t}. Room to add load or reps.` };
  }
  if (r < t) {
    return { level: 'hard', target_rir: t, headline: `A grinder — RIR ${r}, just shy of the ${t} target.` };
  }
  return { level: 'on_target', target_rir: t, headline: `On target — RIR ${r}.` };
}

// Bug-1 path: when the lifter has JUST logged a set, session-level save means it
// is not in the sheet yet — so the recommendation must anchor on THAT set, not on
// stale history. RIR ≥ target + 2 → room to progress; RIR ≤ 0 → hold (near
// failure); between → repeat / add a rep. The advice can never contradict the
// logged RIR (RIR 5 can never read as "near failure").
function recommendFromJustLoggedSet(set, { targetRir, increaseAmount }) {
  const weight = Number(set.weight);
  const reps = Number(set.reps);
  const rir = set && set.rir != null && Number.isFinite(Number(set.rir)) ? Number(set.rir) : null;
  const verdict = effortVerdict(rir, targetRir);
  let recommendation;
  let reasoning;
  let nextWeight = weight;
  let nextReps = reps;
  let confidence = 'medium';

  if (rir == null) {
    recommendation = `Repeat ${weight} × ${reps} and log your RIR so I can tune the next step.`;
    reasoning = 'No RIR logged for that set — repeating the load until the effort is known.';
    confidence = 'low';
  } else if (rir <= 0) {
    recommendation = `Hold ${weight} × ${reps} — that set was at or near failure.`;
    reasoning = `RIR ${rir}: at or near failure. Keep the load and bank clean reps before adding weight.`;
    confidence = 'high';
  } else if (rir - targetRir >= 2) {
    nextWeight = weight + increaseAmount;
    recommendation = `Room to progress — move to ${nextWeight} × ${reps} next set.`;
    reasoning = `RIR ${rir} is well above the ${targetRir} target — you left ${rir} in reserve, so a ${increaseAmount} lb step up is warranted.`;
    confidence = 'high';
  } else if (rir < targetRir) {
    recommendation = `Hold ${weight} × ${reps} — you're right around target effort.`;
    reasoning = `RIR ${rir} is just shy of the ${targetRir} target. Repeat the load and keep form tight.`;
    confidence = 'medium';
  } else {
    nextReps = reps + 1;
    recommendation = `On target — keep ${weight} and chase ${nextReps} reps next set.`;
    reasoning = `RIR ${rir} matches the ${targetRir} target. Add a rep before adding load.`;
    confidence = 'medium';
  }

  return { recommendation, reasoning, next_target: { weight: nextWeight, reps: nextReps, sets: 3 }, effort_verdict: verdict, confidence };
}

module.exports = { effortVerdict, recommendFromJustLoggedSet };
