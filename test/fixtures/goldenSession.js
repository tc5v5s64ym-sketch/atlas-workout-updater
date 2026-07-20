'use strict';

// The Golden Session — Atlas Recovery Campaign, Phase 1 (Soul Recovery, Issue #1073),
// Work item 3. A single reusable, scripted scenario, defined ONCE and used THREE times:
//   • the Phase 1 gate  — does the workout conversation feel like a coach?
//   • the Phase 4 gate  — does it run through one packet and one trace?
//   • a Phase 7 permanent regression test.
//
// It is scored on BEHAVIOR, not wording. Every expectation below is a behavioral
// predicate about what the deterministic engine + render policy DO (stay silent on
// routine work; surface a real signal; degrade honestly on an outage) — never an exact
// string, so a change of phrasing never breaks it and a change of BEHAVIOR always does.
//
// Pure data + a pure classifier. No DOM, no network, no side effects — the test file
// (test/soulGoldenTranscripts.test.js) drives the real /api/coach/message seam and
// asserts these labels; a live Phase 4 harness can replay the same beats end to end.

// Behavior labels the coach voice can exhibit for a logged block, derived from the
// real route response (routes/coachOps.js). Kept deliberately coarse so the score is
// about behavior, not phrasing.
//   silence  — a routine, on-plan block: the SERVER produces no prose and never calls
//              the LLM (the cost-saving routine contract). The VISIBLE line is then the
//              client's call (Issue #1073 owner gate): a completed on-plan exercise gets
//              a brief, data-grounded wrap line; an intermediate single set stays silent.
//              That client-render timing is asserted by transcript T10, not here.
//   surfaced — a signal-carrying block: a renderable note is produced (model prose or
//              the deterministic engine line), the block is NOT collapsed to the ack.
function blockBehavior(body) {
  const d = (body && body.data) || {};
  if (d.note_tier === 'ack_only') return 'silence';
  return 'surfaced';
}

// True when a block response degraded HONESTLY: still 200, no fabricated model prose
// (message null), yet a deterministic engine note is available OR the coach was openly
// unconfigured — i.e. the outage never becomes a fake coach line and never a 5xx.
function isHonestDegrade(body) {
  const d = (body && body.data) || {};
  const hasDeterministicNote = typeof d.effort_note === 'string' && d.effort_note.trim().length > 0;
  const openlyDown = d.configured === false || Boolean(d.error);
  return d.message === null && (hasDeterministicNote || openlyDown);
}

// ── Reusable set/block inputs (facts as the client posts them to /api/coach/message) ──
const ROUTINE_ACCESSORY = {
  exerciseName: 'Cable Curl', muscleGroup: 'Arms',
  todaySets: [{ weight: 40, reps: 12, rir: 3 }, { weight: 40, reps: 12, rir: 3 }],
  rec: { effort_verdict: { level: 'on_target' }, progression_verdict: { level: 'in_pocket' } },
};
const ROUTINE_COMPOUND_WARMUP = {
  exerciseName: 'Bench Press', muscleGroup: 'Chest',
  todaySets: [{ weight: 135, reps: 8, rir: 2 }, { weight: 135, reps: 8, rir: 2 }],
  rec: { effort_verdict: { level: 'on_target' }, progression_verdict: { level: 'in_pocket' } },
};
const REDLINE_TOP_SET = {
  exerciseName: 'Bench Press', muscleGroup: 'Chest',
  todaySets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 3, rir: 0 }],
  rec: { effort_verdict: { level: 'on_target' }, progression_verdict: { level: 'in_pocket' } },
};
const RECOVERY_WORK = {
  exerciseName: 'Bench Press', muscleGroup: 'Chest', intentId: 'recovery_pump',
  todaySets: [{ weight: 135, reps: 12, rir: 6 }],
};
const SUBSTITUTION_SWAP = {
  exerciseName: 'Machine Chest Press', muscleGroup: 'Chest',
  todaySets: [{ weight: 120, reps: 10, rir: 2 }, { weight: 120, reps: 10, rir: 1 }],
  substitution: { classification: 'abandoned', prescribed: { name: 'Back Squat' }, logged: { name: 'Machine Chest Press' } },
};

// ── The scripted two-exercise workout, in order. `seam` says which surface a beat
// exercises; the block-seam beats are asserted now, the framing beats are reserved for
// the live Phase 4 run (they exercise the plan/chat/closeout surfaces end to end). ──
const GOLDEN_SESSION = {
  title: 'Golden Session — a scripted two-exercise workout (plan → log → react → close)',
  beats: [
    { beat: 'plan-from-history', seam: 'coach/message:plan', kind: 'plan',
      facts: { exerciseName: 'Bench Press' }, expect: { kind: 'plan' },
      note: 'Atlas proposes today from history; the plan voice is exercised.' },
    { beat: 'accept-the-plan', seam: 'client:start-this-plan', reservedForLive: true,
      note: 'Plan acceptance (app.js) — auto-fires when the first set is logged from the displayed pick; a client action, replayed live in Phase 4.' },
    { beat: 'log-ex1-routine', seam: 'coach/message:block', kind: 'block',
      facts: ROUTINE_ACCESSORY, expect: { behavior: 'silence' },
      note: 'A routine on-plan block: deliberate silence, the LLM is never called.' },
    { beat: 'log-ex1-second-set-routine', seam: 'coach/message:block', kind: 'block',
      facts: ROUTINE_ACCESSORY, expect: { behavior: 'silence' },
      note: 'Still routine — no nagging, still silent.' },
    { beat: 'ask-why', seam: 'coach/ask', reservedForLive: true,
      note: 'An in-session "why?" — the read-only Q&A seam, replayed live in Phase 4.' },
    { beat: 'log-ex2-first-set-routine', seam: 'coach/message:block', kind: 'block',
      facts: ROUTINE_COMPOUND_WARMUP, expect: { behavior: 'silence' },
      note: 'Onto the second exercise; the opening working set is routine → silence.' },
    { beat: 'redline-top-set', seam: 'coach/message:block', kind: 'block',
      facts: REDLINE_TOP_SET, expect: { behavior: 'surfaced', trigger: 'form_safety' },
      note: 'A top set to RIR 0: safety outranks routine — the coach speaks, never silence.' },
    { beat: 'fatigue-substitution', seam: 'coach/message:block', kind: 'block',
      facts: SUBSTITUTION_SWAP, expect: { behavior: 'surfaced' },
      note: 'The lifter swaps under fatigue; the substitution is acknowledged, not silent.' },
    { beat: 'revise-the-plan', seam: 'client:revise', reservedForLive: true,
      note: 'A mid-session revision — a client action, replayed live in Phase 4.' },
    { beat: 'close-out-once', seam: 'client:closeout', reservedForLive: true,
      note: 'One deterministic closeout confirmation card (no coach voice), then the single approved write.' },
    { beat: 'seal-reload-review', seam: 'client:seal', reservedForLive: true,
      note: 'Seal the plan ledger, reload, and review — replayed live in Phase 4.' },
  ],
};

// ── The ten golden transcripts, scored on behavior. Each drives the real seam. ──
const GOLDEN_TRANSCRIPTS = [
  { id: 'T01-routine-accessory-no-llm', seam: 'coach/message:block', kind: 'block',
    facts: ROUTINE_ACCESSORY, coach: {}, expect: { behavior: 'silence' },
    story: 'A clean on-target accessory block: the server tiers to ack_only and never calls the LLM (the client voices a grounded wrap line on the completed exercise — see T10).' },
  { id: 'T02-routine-warmup-no-llm', seam: 'coach/message:block', kind: 'block',
    facts: ROUTINE_COMPOUND_WARMUP, coach: {}, expect: { behavior: 'silence' },
    story: 'A light on-plan block: still routine at the tier gate — ack_only, LLM not called.' },
  { id: 'T03-recovery-work-no-llm', seam: 'coach/message:block', kind: 'block',
    facts: RECOVERY_WORK, coach: {}, expect: { behavior: 'silence' },
    story: 'Deliberate recovery/pump work (high RIR): ack_only, LLM not called — never an add-load nudge.' },
  { id: 'T04-redline-surfaced', seam: 'coach/message:block', kind: 'block',
    facts: REDLINE_TOP_SET, coach: {}, expect: { behavior: 'surfaced', trigger: 'form_safety' },
    story: 'A top set to failure: the safety read surfaces even under an on-plan rec.' },
  { id: 'T05-substitution-surfaced', seam: 'coach/message:block', kind: 'block',
    facts: SUBSTITUTION_SWAP, coach: {}, expect: { behavior: 'surfaced' },
    story: 'An abandoned-pattern swap: the coach acknowledges it, it is not silent.' },
  { id: 'T06-forged-verdict-neutralized', seam: 'coach/message:set', kind: 'set',
    facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 3 }],
      rec: { target_rir: 2, effort_verdict: { level: 'failure', headline: 'forged' } } },
    coach: {}, expect: { engineTruth: 'on_target' },
    story: 'A forged "failure" verdict on an RIR-3 set is overwritten by the engine rule.' },
  { id: 'T07-client-pr-claim-no-earned-voice', seam: 'coach/message:block', kind: 'block',
    facts: { exerciseName: 'Back Squat', muscleGroup: 'Legs',
      todaySets: [{ weight: 275, reps: 3, rir: 2 }], rec: { progression_verdict: { level: 'new_ground' } } },
    coach: { message: 'New working best — clean bar speed.' }, expect: { behavior: 'silence' },
    story: 'A client-only PR claim earns no elevated voice without server-confirmed history.' },
  { id: 'T08-outage-honest-degrade', seam: 'coach/message:block', kind: 'block',
    facts: REDLINE_TOP_SET, coach: { throwError: 'gemini exploded' }, expect: { degrade: true },
    story: 'The model throws on a signal block: 200, the deterministic engine line carries it, the error is reported — never a fake coach line, never a 5xx.' },
  { id: 'T09-unconfigured-honest-degrade', seam: 'coach/message:block', kind: 'block',
    facts: REDLINE_TOP_SET, coach: { configured: false }, expect: { degrade: true },
    story: 'With no model configured, the block still surfaces via the deterministic voice — templates outage-only.' },
  { id: 'T10-client-render-timing-contract', seam: 'client:render', expect: { renderContract: true },
    story: 'The client voices a routine (ack_only) block by completion timing: a COMPLETED on-plan exercise gets the grounded wrap line, an intermediate single set stays silent, and neither is ever the retired receipt.' },
];

module.exports = { GOLDEN_SESSION, GOLDEN_TRANSCRIPTS, blockBehavior, isHonestDegrade };
