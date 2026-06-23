'use strict';

// Profile-Aware Stimulus Governor — grader (Training Profile Taxonomy §5, PR 482).
//
// Applies the PR 481 rule table (services/stimulusGovernorRules.js) to a single
// logged set/effort and emits the deterministic governor facts: which metric was
// read (`effort_interpretation`), the directional `progression_verdict`
// (`+load`/`+reps`/`+rounds`/`+duration`/`hold`/`back_off`), and a `fatigue_signal`
// (`none`/`elevated`/`high`). It decides whether logged effort EARNS progression,
// HOLDS, or signals FATIGUE — by profile + modality, not the one-size barbell model.
//
// Engine facts the voice may WORD, never invent. It emits a coarse DIRECTION only —
// it never computes a load number (the load/rep math stays in recommendNextSet).
//
// PURE / read-only: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned schema
// change, and NOT wired into the coach/recommendation/write paths. Reuses the
// existing `effortVerdict` for the resistance RIR read. Wiring it into a live
// surface is a later, separately-gated slice.

const { governorRuleFor } = require('./stimulusGovernorRules');
const { effortVerdict } = require('./analytics');

/**
 * Grade one logged effort against the profile×modality rule.
 *
 * @param {object} input
 * @param {string} input.profile             one of PROFILES (strength/hypertrophy/…)
 * @param {string} input.modalityCategory    one of MODALITY_CATEGORIES (resistance/cardio/…)
 * @param {number|null} [input.rir]          logged reps-in-reserve (resistance/bodyweight)
 * @param {number} [input.target_rir=2]      the prescribed RIR target
 * @param {boolean} [input.is_heavy_compound=false]  is this a heavy compound (RIR-0 handling)
 * @param {('improved'|'steady'|'declined')} [input.metric_trend]  non-RIR modality trend
 * @returns {{effort_interpretation:string, progression_verdict:string,
 *            fatigue_signal:string, reason:string, rule:object}|null}
 */
function gradeStimulus(input = {}) {
  const { profile, modalityCategory } = input;
  const rule = governorRuleFor(profile, modalityCategory);
  if (!rule) return null;

  // The modality's primary "progress" direction is the first allowed verdict
  // (+load / +reps / +duration / +rounds); 'hold' and 'back_off' are always allowed.
  const progress = rule.allowed_verdicts[0];

  const out = (progression_verdict, fatigue_signal, reason) => ({
    effort_interpretation: rule.effort_interpretation,
    progression_verdict,
    fatigue_signal,
    reason,
    rule,
  });

  // ── Non-RIR modalities (cardio / timed / circuit): judged by metric trend ─────
  if (!rule.rir_relevant) {
    const trend = ['improved', 'steady', 'declined'].includes(input.metric_trend)
      ? input.metric_trend : 'steady';
    if (trend === 'improved') return out(progress, 'none', `${rule.effort_interpretation} improved — earn more stimulus.`);
    if (trend === 'declined') return out('back_off', 'elevated', `${rule.effort_interpretation} declined — back off and recover.`);
    return out('hold', 'none', `${rule.effort_interpretation} steady — hold and consolidate.`);
  }

  // ── RIR-relevant modalities (resistance / bodyweight) ─────────────────────────
  const rir = input.rir;
  if (rir == null || !Number.isFinite(Number(rir))) {
    return out('hold', 'none', 'No RIR logged — hold; effort not gradeable.');
  }
  const r = Number(rir);
  const targetRir = Number.isFinite(Number(input.target_rir)) ? Number(input.target_rir) : 2;
  const heavyCompound = !!input.is_heavy_compound;

  // RIR 0 (at/near failure): handled by PROFILE.
  if (r <= 0) {
    if (heavyCompound) {
      if (rule.rir0_blocks_progression) {
        return out('hold', 'high', 'RIR 0 on a heavy compound — high CNS/fatigue cost; hold, do not push the next session.');
      }
      if (rule.rir0_caution) {
        return out('hold', 'elevated', 'RIR 0 on a heavy compound — acceptable but recovery-costly; hold rather than push.');
      }
      return out('hold', 'elevated', 'RIR 0 on a heavy compound — hold and watch recovery.');
    }
    // Isolation / accessory at failure.
    if (rule.reward_consistency) {
      // General fitness: maximal effort isn't the goal — don't reward grinding.
      return out('hold', 'elevated', 'RIR 0 on an accessory — effort beyond what this profile needs; hold.');
    }
    return out(progress, 'elevated', 'RIR 0 on isolation — acceptable; the stimulus is earned.');
  }

  // RIR > 0: interpret the reserve against the target via the existing verdict.
  const v = effortVerdict(r, targetRir);
  const level = v && v.level;
  if (level === 'easy' || level === 'far_easy') {
    return out(progress, 'none', `Under target (RIR ${r} vs ${targetRir}) — room to add stimulus.`);
  }
  // on_target / hard → dialed in: hold/repeat (the load engine decides any increment).
  return out('hold', 'none', `At target (RIR ${r} vs ${targetRir}) — hold/repeat; dialled in.`);
}

module.exports = { gradeStimulus };
