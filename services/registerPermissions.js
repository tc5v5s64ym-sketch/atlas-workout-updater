'use strict';

// ── Register permissions (Soul Plan PR-B2) ───────────────────────────────────
//
// The volume knob the model can't touch. The engine computes how loud the coach
// may get — routine / elevated / max — plus whether casual language, humor, and
// (if the owner allowed it) profanity are licensed, from the coaching mode
// (PR-B1), the celebration-scarcity state (PR-B3 supplies it), and the owner's
// ratified calibration. The model RECEIVES permissions; it never grants itself
// any (PR-B4 wires the grant into the prompts + the deterministic suppressor).
//
// PURE + UNWIRED in this PR: no I/O beyond the one config require at load, no
// LLM, no route. Total — every input, including garbage, returns a valid grant
// (garbage → the most-conservative grant).
//
// Owner calibration is DATA, not prose: config/coaching/register.calibration.json
// (ratified D1–D5, docs/ATLAS_VOICE_RATIFICATION_V1.md v1.4). This module
// schema-validates it at load and fails fast on a malformed file, so taste can
// never silently drift in code.
//
// Iron invariants (pinned by test/registerPermissions.test.js):
//   - casual_ok is true by default (casual IS the register — D2 buddy-direct,
//     not a reward) EXCEPT safety/refuse contexts → false. Pain arrives as the
//     `safety` mode (coachMode maps PAIN_INJURY → safety), so pain is covered.
//   - humor_ok only in low-stakes modes (nod / note / educate — D5); never in
//     correct, challenge, safety, reassure, refuse — or celebrations.
//   - profanity_ok ⟹ intensity === 'max' ∧ mode === 'celebrate' ∧ scarcity
//     explicitly clear ∧ the owner ceiling permits (D1) — unreachable in
//     safety/pain/correction/uncertainty by construction. The D1 "earned
//     comeback beat" moment can reach MAX intensity (praise + comeback flag)
//     but NOT profanity in this module — that certified cell needs the engine
//     comeback fact PR-B4/B6 wires; until then celebrate is the only cell.
//   - 'max' only for celebrate (and, owner-enabled via calibration, a
//     comeback-beat praise).
//   - safety forces { routine, casual_ok:false, humor_ok:false, profanity_ok:false }.
//
// Scarcity is an INPUT here (PR-B3 computes it). For the profanity grant an
// absent/ambiguous scarcity reads as NOT clear — the conservative direction.

const CALIBRATION = require('../config/coaching/register.calibration.json');

const INTENSITIES = Object.freeze(['routine', 'elevated', 'max']);

// Known coach modes (kept in lockstep with services/coachMode.js by test).
const KNOWN_MODES = Object.freeze([
  'silent', 'nod', 'note', 'praise', 'celebrate',
  'correct', 'challenge', 'reassure', 'educate', 'refuse', 'safety',
]);

// Fail fast on a malformed calibration file — taste is owner data; a broken
// shape must never silently degrade into different permissions.
function validateCalibration(cfg) {
  const fail = (msg) => { throw new Error(`register.calibration.json invalid: ${msg}`); };
  if (!cfg || typeof cfg !== 'object') fail('not an object');
  if (cfg.schema_version !== 1) fail('schema_version must be 1');
  const i = cfg.intensity;
  if (!i || i.default !== 'routine') fail('intensity.default must be "routine"');
  if (!Array.isArray(i.elevated_modes) || !Array.isArray(i.max_modes)) fail('intensity mode lists required');
  if (typeof i.max_on_comeback_beat_praise !== 'boolean') fail('intensity.max_on_comeback_beat_praise must be boolean');
  if (!cfg.casual || cfg.casual.default !== true || !Array.isArray(cfg.casual.banned_modes)) fail('casual block malformed');
  if (!cfg.humor || !Array.isArray(cfg.humor.allowed_modes)) fail('humor block malformed');
  const p = cfg.profanity;
  if (!p || typeof p.enabled !== 'boolean' || !p.requires) fail('profanity block malformed');
  if (p.requires.mode !== 'celebrate' || p.requires.intensity !== 'max' || p.requires.scarcity_clear !== true) {
    fail('profanity.requires must pin the celebrate/max/scarcity-clear cell (D1)');
  }
  if (!p.cap || !(p.cap.max_per_window >= 0) || !(p.cap.rolling_days > 0)) fail('profanity.cap malformed');
  for (const m of [...i.elevated_modes, ...i.max_modes, ...cfg.casual.banned_modes, ...cfg.humor.allowed_modes]) {
    if (!KNOWN_MODES.includes(m)) fail(`unknown mode "${m}" in calibration`);
  }
  return cfg;
}
validateCalibration(CALIBRATION);

const CONSERVATIVE = Object.freeze({
  intensity: 'routine', casual_ok: false, humor_ok: false, profanity_ok: false,
});

function grantRegister(input) {
  const { mode, scarcity, ownerPrefs, moment } = input && typeof input === 'object' ? input : {};
  const cfg = CALIBRATION;
  if (typeof mode !== 'string' || !KNOWN_MODES.includes(mode)) {
    return { ...CONSERVATIVE }; // unknown moment shape → quietest possible grant
  }

  // Owner prefs: a bounded runtime override of the two owner-adjustable knobs.
  // Everything else comes from the calibration file only.
  const prefs = ownerPrefs && typeof ownerPrefs === 'object' ? ownerPrefs : {};
  const profanityEnabled = prefs.profanity_enabled === false ? false : cfg.profanity.enabled === true;
  const comebackMaxEnabled = prefs.max_on_comeback_beat_praise === false
    ? false
    : cfg.intensity.max_on_comeback_beat_praise === true;

  // Safety (which includes pain — coachMode maps PAIN_INJURY → safety) is the
  // hard floor: nothing casual, nothing funny, nothing loud.
  if (mode === 'safety' || mode === 'refuse') {
    return { ...CONSERVATIVE };
  }

  // Scarcity: only an explicit true counts as clear (conservative default).
  const scarcityClear = scarcity === true
    || (scarcity && typeof scarcity === 'object' && scarcity.scarcityClear === true);

  // Intensity — the engine's volume. MAX is celebrate-only, plus the owner-enabled
  // comeback-beat praise (D1's second certified moment, intensity only).
  const comebackBeat = !!(moment && typeof moment === 'object' && moment.comeback_beat === true);
  let intensity = cfg.intensity.default;
  if (cfg.intensity.max_modes.includes(mode)) intensity = 'max';
  else if (mode === 'praise' && comebackBeat && comebackMaxEnabled) intensity = 'max';
  else if (cfg.intensity.elevated_modes.includes(mode)) intensity = 'elevated';

  // Casual is the register (D2), not a reward — banned only where the floor demands.
  const casual_ok = !cfg.casual.banned_modes.includes(mode);

  // Humor: low-stakes modes only (D5).
  const humor_ok = cfg.humor.allowed_modes.includes(mode);

  // Profanity: the single certified cell (D1) — celebrate × max × scarcity clear
  // × owner ceiling. By construction unreachable from safety/pain/correction/
  // uncertainty (those modes never reach here with mode === 'celebrate').
  const profanity_ok = profanityEnabled
    && mode === cfg.profanity.requires.mode
    && intensity === cfg.profanity.requires.intensity
    && scarcityClear === true;

  return { intensity, casual_ok, humor_ok, profanity_ok };
}

module.exports = Object.freeze({
  grantRegister,
  validateCalibration,
  INTENSITIES,
  KNOWN_MODES,
  CALIBRATION,
});
