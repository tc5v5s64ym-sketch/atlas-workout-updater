// Plan conformance at log time (issue #1632).
//
// A logged value that contradicts the accepted session plan (weight, reps, or
// a different exercise than prescribed) was confirmed silently: the log-time
// confirmation rendered from the parsed sets and never consulted the plan
// target, so a 285 logged against a planned 275 surfaced only when the athlete
// happened to correct it later.
//
// This module is pure (no DOM): it compares logged sets against one plan entry
// and formats the deterministic mismatch line. The caller owns the gates:
//   - only an accepted plan carries a committed target (plan.accepted === true);
//   - a lift with no plan entry is off-plan extra work, a normal flow, never a
//     mismatch (findPlanEntry returns null);
//   - a substituted lift is excluded by the caller (its slot prescription
//     changed; the substitution flow already narrates it);
//   - RIR is effort reporting, never a plan contradiction, so it is not compared;
//   - a missing target on either side is never fabricated into a mismatch:
//     a dimension is compared only when both the plan and the logged set state
//     a finite number for it.
function toFinite(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function entryNames(entry) {
  const names = [];
  for (const key of ['name', 'canonicalName']) {
    if (entry && typeof entry[key] === 'string' && entry[key].trim()) {
      names.push(entry[key].toLowerCase());
    }
  }
  return names;
}

// Case-insensitive plan-entry lookup, mirroring planStepFor in
// coach-conversation.js: exact name first, then lift-code, then substring
// fallback. The code pass is what bridges aliases: the exercise catalog
// carries variants ("RDL") labeled with their lift code, so a logged alias
// that never matches a plan name still reaches its slot — but code never
// overrides a successful exact name match, so a mis-resolved code cannot
// steal a lift that matched by name.
export function findPlanEntry(exerciseName, session, liftCode = null) {
  if (!exerciseName || typeof exerciseName !== 'string') return null;
  const entries = session && Array.isArray(session.exercises) ? session.exercises : [];
  if (!entries.length) return null;
  const key = exerciseName.toLowerCase();
  for (const entry of entries) {
    if (entryNames(entry).includes(key)) return entry;
  }
  if (liftCode && typeof liftCode === 'string' && liftCode.trim()) {
    const code = liftCode.toLowerCase();
    for (const entry of entries) {
      if (typeof entry.liftCode === 'string' && entry.liftCode.toLowerCase() === code) return entry;
    }
  }
  for (const entry of entries) {
    const names = entryNames(entry);
    if (names.some((n) => n.includes(key) || key.includes(n))) return entry;
  }
  return null;
}

// Returns null when nothing contradicts the plan, otherwise
// { planWeight, planReps, differing: [{ weight, reps, count }] } where
// differing groups consecutive identical differing sets (same readout shape
// as the readback's set grouping).
export function planMismatchForLift(loggedSets, planEntry) {
  if (!planEntry || !Array.isArray(loggedSets) || !loggedSets.length) return null;
  const planWeight = toFinite(planEntry.weight);
  const planReps = toFinite(planEntry.reps);
  if (planWeight === null && planReps === null) return null;
  const differing = [];
  for (const set of loggedSets) {
    if (!set || typeof set !== 'object') continue;
    const weight = toFinite(set.weight);
    const reps = toFinite(set.reps);
    const weightDiffers = planWeight !== null && weight !== null && weight !== planWeight;
    const repsDiffers = planReps !== null && reps !== null && reps !== planReps;
    if (!weightDiffers && !repsDiffers) continue;
    const last = differing[differing.length - 1];
    if (last && last.weight === weight && last.reps === reps) {
      last.count += 1;
    } else {
      differing.push({ weight, reps, count: 1 });
    }
  }
  if (!differing.length) return null;
  return { planWeight, planReps, differing };
}

function readoutPart(weight, reps) {
  if (weight !== null && reps !== null) return `${weight}×${reps}`;
  if (weight !== null) return `${weight} lb`;
  if (reps !== null) return `${reps} reps`;
  return '';
}

function differingReadout(differing) {
  return differing
    .map((g) => {
      const part = readoutPart(g.weight, g.reps);
      return g.count > 1 ? `${part} ×${g.count}` : part;
    })
    .join(' · ');
}

// Deterministic line: names planned vs logged and asks intent. It claims
// nothing about the write (the approve path still owns that).
export function formatPlanMismatchLine(liftName, mismatch) {
  if (!mismatch) return null;
  const planPart = readoutPart(mismatch.planWeight, mismatch.planReps);
  const loggedPart = differingReadout(mismatch.differing);
  if (!planPart || !loggedPart) return null;
  return `Plan had ${liftName} at ${planPart}; you logged ${loggedPart}. Was that intentional, or a typo?`;
}
