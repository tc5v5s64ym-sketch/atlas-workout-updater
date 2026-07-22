'use strict';

// Atlas Soul Corpus V2 — the 35-capability rubric (Corpus Baseline Runner).
//
// This is the synthesis's Section-A coaching-capability matrix, encoded as the
// SCORING RUBRIC for the Corpus Baseline Runner. It is NOT a re-derivation of the
// engine's own capability manifest (config/coaching/manifests/capabilities.json) —
// that is an engine-module taxonomy; THIS is the owner's behavioral coaching
// taxonomy, exactly as the owner directed ("using the synthesis's 35-capability
// matrix as the rubric").
//
// Each capability declares:
//   • num / key / name / part            — identity (part: 'core' = Part I owner
//                                           standard, 'extended' = Part II athletes).
//   • sessions                            — the corpus sessions that DEMONSTRATE it
//                                           (verbatim from the synthesis Section-A table).
//   • builds                              — WHEN ABSENT, the campaign phase (and/or
//                                           BACKLOG intake) that builds it. Grounded in
//                                           the execution plan's findings→phase table and
//                                           docs/reference/ATLAS_SOUL_CORPUS_V2_SECTION_F_RECONCILIATION.md.
//   • score(det)                          — a PURE function of the observed detector
//                                           bundle → 'pass' | 'partial' | 'absent'.
//
// HONESTY CONTRACT (mirrors the divergence tool's "0 records ⇒ 0 turns, never a false
// green"): a capability only scores above 'absent' when the REAL deterministic engine +
// the REAL assembled CoachTurnPacket demonstrably produce its behaviour on the replayed
// corpus turns. The stubbed LLM's *words* are never credited — Atlas's rule is "engine
// owns numbers; LLM only words facts", so the runner scores the engine, not the phrasing.
// We round DOWN: 'pass' requires the capability's primary behaviour; 'partial' requires a
// real but incomplete facet; otherwise 'absent'.
//
// AUTO-IMPROVING BY DESIGN: most score() functions gate on packet fields
// (det.packet.session / decision / safety / exercises / closeout). Today the Phase-3
// shadow packet embeds only athlete.profile_goal and leaves the rest null (H-03/H-08/
// H-11/H-12), so most capabilities are 'absent' — the honest low baseline. As Phase 4/5
// wire the packet out, the SAME rubric re-scored against the SAME real code will move
// those capabilities up on its own. That is why the runner reruns at the close of
// Phases 4, 6, and 7.

// ── score() helpers over the detector bundle (see services/corpusBaseline.js) ──
const p = (det) => (det && det.packet) || {};

const CAPABILITIES = [
  { num: 1, key: 'context_planning', name: 'Context-aware session planning', part: 'core',
    sessions: ['S1', 'S3', 'S6', 'S9', 'S15'],
    builds: 'Phase 4 (packet consumes the WorkoutSession; plan reflects split/last-session/schedule) · H-08',
    score: (det) => (p(det).session ? 'partial' : 'absent') },

  { num: 2, key: 'purpose_framing', name: 'Plan-purpose framing', part: 'core',
    sessions: ['S1', 'S2', 'S11', 'S15'],
    builds: 'Phase 4 (the packet decision carries the session’s "why") · H-03',
    score: (det) => (p(det).decision ? 'partial' : 'absent') },

  { num: 3, key: 'readiness_prescription', name: 'Readiness-adjusted prescription', part: 'extended',
    sessions: ['S5', 'S8', 'S9', 'S10', 'S15'],
    builds: 'Phase 5e (plumb readiness from its defined source; close Issue #914)',
    score: (det) => (det.readinessApplied ? 'partial' : 'absent') },

  { num: 4, key: 'layoff_reentry', name: 'Layoff detection & re-entry logic', part: 'extended',
    sessions: ['S2', 'S11'],
    builds: 'Phase 4 (session gap in the packet) + Phase 6 (detraining/retraining knowledge)',
    score: (det) => (p(det).session && det.knowledgeRetrieved ? 'partial' : 'absent') },

  { num: 5, key: 'progression_verdicts', name: 'Progression verdicts (double progression)', part: 'core',
    sessions: ['S1', 'S6', 'S7', 'S10', 'S14', 'S15'],
    builds: 'Phase 4 (packet decision embeds server-owned counters/verdicts) · H-03',
    score: (det) => (p(det).decision ? 'partial' : 'absent') },

  { num: 6, key: 'increment_sizing', name: 'Increment sizing', part: 'core',
    sessions: ['S1', 'S10', 'S14'],
    builds: 'Phase 4 (decision) + BACKLOG §F.7 (increment/equipment-granularity tables)',
    score: (det) => (p(det).decision && det.incrementTable ? 'partial' : 'absent') },

  { num: 7, key: 'e1rm_trend', name: 'e1RM computation & trend reporting', part: 'core',
    sessions: ['S1'],
    builds: 'BACKLOG §F.3 (single-method e1RM) + Phase 4 (packet-owned numbers)',
    score: (det) => (det.e1rmStandardized ? 'partial' : 'absent') },

  { num: 8, key: 'fatigue_drift', name: 'Intra-exercise fatigue-drift reading', part: 'core',
    sessions: ['S1', 'S3', 'S5', 'S14'],
    builds: 'Phase 4 (drift metrics in the packet session/decision)',
    score: (det) => (p(det).session ? 'partial' : 'absent') },

  { num: 9, key: 'live_adaptation', name: 'Live plan adaptation', part: 'core',
    sessions: ['S1', 'S3', 'S5', 'S10'],
    builds: 'Phase 4 (packet session + decision drive downstream revision)',
    score: (det) => (p(det).session && p(det).decision ? 'partial' : 'absent') },

  { num: 10, key: 'fresh_vs_fatigued', name: 'Fresh-vs-fatigued baseline protection', part: 'core',
    sessions: ['S1', 'S3', 'S5'],
    builds: 'Phase 4 (context class in the packet session)',
    score: (det) => (p(det).session ? 'partial' : 'absent') },

  { num: 11, key: 'cross_lift', name: 'Cross-lift evidence reasoning', part: 'extended',
    sessions: ['S2', 'S8'],
    builds: 'Phase 4 (session) + BACKLOG §F.2 (comparable-session selector)',
    score: (det) => (p(det).session && det.comparableSelector ? 'partial' : 'absent') },

  { num: 12, key: 'limiter_analysis', name: 'Limiter analysis', part: 'extended',
    sessions: ['S8'],
    builds: 'Phase 6 (knowledge: limiter-vs-strength) + BACKLOG §F.12 (armed experiment scheduler)',
    score: (det) => (det.knowledgeRetrieved && det.armedScheduler ? 'partial' : 'absent') },

  { num: 13, key: 'substitution_compat', name: 'Substitution compatibility', part: 'core',
    sessions: ['S4', 'S10', 'S13'],
    builds: 'Present: swap is surfaced. Full compatibility/emphasis needs Phase 5b ExerciseIdentity · H-11',
    score: (det) => (det.substitutionSurfaced ? (p(det).exercises ? 'pass' : 'partial') : 'absent') },

  { num: 14, key: 'working_weight_finder', name: 'Working-weight finder', part: 'core',
    sessions: ['S4', 'S11'],
    builds: 'BACKLOG §F.8 (in-session finder sub-state) + existing onboarding finder',
    score: (det) => (det.finderMode ? 'partial' : 'absent') },

  { num: 15, key: 'equipment_nonequivalence', name: 'Equipment non-equivalence handling', part: 'core',
    sessions: ['S4', 'S11'],
    builds: 'Phase 5b (immutable ExerciseIdentity; per-machine baselines as distinct lifts) · H-11',
    score: (det) => (p(det).exercises ? 'partial' : 'absent') },

  { num: 16, key: 'equipment_ceiling', name: 'Equipment-ceiling progression', part: 'extended',
    sessions: ['S13'],
    builds: 'Phase 6 (progression knowledge: reps/tempo axes) + Phase 4 (decision)',
    score: (det) => (det.knowledgeRetrieved && p(det).decision ? 'partial' : 'absent') },

  { num: 17, key: 'duplicate_stimulus', name: 'Duplicate-stimulus prevention', part: 'core',
    sessions: ['S4', 'S5'],
    builds: 'Phase 4 (slot-closure lives in the packet session state)',
    score: (det) => (p(det).session ? 'partial' : 'absent') },

  { num: 18, key: 'log_correction', name: 'Conversational log correction', part: 'core',
    sessions: ['S5', 'S6'],
    builds: 'Phase 4 (session repair + re-derivation; discussion_referent promoted to a packet field)',
    score: (det) => (p(det).session && det.sessionRepair ? 'partial' : 'absent') },

  { num: 19, key: 'log_discrepancy', name: 'Log-discrepancy verification', part: 'core',
    sessions: ['S6'],
    builds: 'Phase 4 (packet session vs. plan delta triggers a neutral question)',
    score: (det) => (p(det).session ? 'partial' : 'absent') },

  { num: 20, key: 'batch_truncation', name: 'Batch-log and truncation handling', part: 'extended',
    sessions: ['S9'],
    builds: 'Phase 4 (session) + BACKLOG §F.6 (category-aware adherence accounting)',
    score: (det) => (p(det).session && det.adherenceLedger ? 'partial' : 'absent') },

  { num: 21, key: 'volume_accounting', name: 'Weekly volume accounting', part: 'core',
    sessions: ['S1', 'S14'],
    builds: 'BACKLOG §F.6 (weekly volume ledger) + Phase 6 (volume_and_frequency knowledge)',
    score: (det) => (det.volumeLedger ? 'partial' : 'absent') },

  { num: 22, key: 'exercise_order', name: 'Exercise-order reasoning', part: 'core',
    sessions: ['S3'],
    builds: 'Phase 6 (order-principle knowledge) + Phase 4 (decision)',
    score: (det) => (det.knowledgeRetrieved ? 'partial' : 'absent') },

  { num: 23, key: 'better_than_expected', name: 'Better-than-expected management', part: 'core',
    sessions: ['S6', 'S14'],
    builds: 'Phase 4 (decision) + BACKLOG §F.12 (armed-item scheduler for the booked test)',
    score: (det) => (p(det).decision && det.armedScheduler ? 'partial' : 'absent') },

  { num: 24, key: 'evidence_threshold', name: 'Evidence-threshold declarations', part: 'extended',
    sessions: ['S2', 'S11'],
    builds: 'Phase 4 (decision gates verdict on pre-stated evidence) + Phase 6 (validator)',
    score: (det) => (p(det).decision && det.knowledgeRetrieved ? 'partial' : 'absent') },

  { num: 25, key: 'conditional_forecasting', name: 'Conditional forecasting', part: 'extended',
    sessions: ['S11', 'S14', 'S15'],
    builds: 'Phase 4 (decision emits rule+condition) + Phase 6 (validator carries the condition)',
    score: (det) => (p(det).decision ? 'partial' : 'absent') },

  { num: 26, key: 'uncertainty_comm', name: 'Uncertainty communication', part: 'core',
    sessions: ['S1', 'S2', 'S5', 'S8', 'S11'],
    builds: 'Phase 4 (packet marks fact/inference/unknown) + Phase 6 (validator) · H-16',
    score: (det) => (p(det).decision ? 'partial' : 'absent') },

  { num: 27, key: 'emotion_recognition', name: 'Emotional recognition & data-grounded response', part: 'extended',
    sessions: ['S1', 'S7', 'S11', 'S12', 'S13', 'S14'],
    builds: 'BACKLOG §F.11 (engine-side emotion signal flags) + Phase 6/7',
    score: (det) => (det.signalFlags ? 'partial' : 'absent') },

  { num: 28, key: 'adherence_first', name: 'Adherence-first coaching', part: 'extended',
    sessions: ['S12', 'S9'],
    builds: 'BACKLOG §F.11 (adherence signal flags) + Phase 7',
    score: (det) => (det.signalFlags ? 'partial' : 'absent') },

  { num: 29, key: 'pain_modification', name: 'Pain/symptom-informed modification', part: 'extended',
    sessions: ['S13', 'S10', 'S9'],
    builds: 'Phase 5d (one SafetyDecision: stop rules, green-list, symptom log, referral flag) · H-12',
    score: (det) => (p(det).safety ? (det.safetySurfaced ? 'pass' : 'partial') : (det.safetySurfaced ? 'partial' : 'absent')) },

  { num: 30, key: 'education_moments', name: 'Education moments', part: 'extended',
    sessions: ['S7', 'S8', 'S14', 'S3'],
    builds: 'Phase 6 (wire the research into retrievable knowledge records) · H-06/H-16',
    score: (det) => (det.knowledgeRetrieved ? 'partial' : 'absent') },

  { num: 31, key: 'praise_economy', name: 'Praise economy', part: 'core',
    sessions: ['S1', 'S7', 'S12', 'S14'],
    builds: 'Present: the scarcity gate refuses client-claimed elevation. Itemized-from-log praise needs Phase 4 (packet decision).',
    score: (det) => (det.praiseGated ? (p(det).decision ? 'pass' : 'partial') : 'absent') },

  { num: 32, key: 'brevity_silence', name: 'Deliberate brevity / silence', part: 'core',
    sessions: ['S4', 'S6', 'S9', 'S12'],
    builds: 'Built in Phase 1 (the receipt died; routine → silence, signal → surface). Register-matching by athlete needs Phase 6/7.',
    score: (det) => (det.silenceOnRoutine ? (det.surfaceOnSignal ? 'pass' : 'partial') : 'absent') },

  { num: 33, key: 'narrative_closeouts', name: 'Narrative closeouts', part: 'core',
    sessions: ['ALL'],
    builds: 'Phase 4 (CloseoutTransaction in the packet) + Phase 5g (session-state pin) · H-17',
    score: (det) => (p(det).closeout ? 'partial' : 'absent') },

  { num: 34, key: 'voice_modulation', name: 'Per-athlete voice modulation', part: 'extended',
    sessions: ['S6', 'S7', 'S12'],
    builds: 'Phase 6/7 (persona register wired to athlete profile; the LLM words the register the engine selects)',
    score: (det) => (det.personaAuthored ? 'partial' : 'absent') },

  { num: 35, key: 'persistent_memory', name: 'Persistent athlete memory', part: 'extended',
    sessions: ['S2', 'S8', 'S9', 'S11', 'S12', 'S13'],
    builds: 'BACKLOG §F.4 (durable memory store) + Phase 4/5 (prompt-time assembly)',
    score: (det) => (det.memoryRead ? 'partial' : 'absent') },
];

// The detector fields the scorer must populate (documented here so the runner and the
// rubric never drift). Booleans unless noted. `packet.*` come from the REAL assembled
// CoachTurnPacket; the rest are DERIVED from the REAL route responses — none are
// hardcoded, so each flips to true the moment the real code starts emitting its signal.
const DETECTOR_FIELDS = [
  'silenceOnRoutine', 'surfaceOnSignal', 'substitutionSurfaced', 'safetySurfaced', 'praiseGated',
  'honestDegrade', 'engineOwnsNumber',
  // route signals that do not exist yet — false today, flip when a later phase emits them:
  'readinessApplied', 'knowledgeRetrieved', 'signalFlags', 'memoryRead', 'personaAuthored',
  'incrementTable', 'e1rmStandardized', 'comparableSelector', 'armedScheduler',
  'finderMode', 'sessionRepair', 'adherenceLedger', 'volumeLedger',
  // packet embedded truth (from the assembled CoachTurnPacket):
  'packet', // { athleteGoal, session, decision, safety, exercises, closeout }
];

module.exports = { CAPABILITIES, DETECTOR_FIELDS };
