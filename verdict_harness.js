// TEMP merge-gate harness (throwaway branch). Runs the REAL
// generateVerdictReaction from this branch's services/coach.js.
// Prints sanitized payload + LIVE Atlas response + VOICE SPEC check.
// Never prints the API key (only isConfigured() as a boolean).
const coach = require('./services/coach.js');

const scenarios = [
  { name: '1) Beat expectation, no rule issue',
    verdict: { outcome: 'beat', why: 'RIR 1 vs target 3 — pushed 2 below target.', prescribedRir: 3, actualRir: 1, rirDelta: -2 },
    ruleDecisions: [],
    context: { exercise: 'Bench Press', lift_code: 'BENCH', sets: [{ weight: 205, reps: 6, rir: 1 }], first_weight: 185, best_weight: 205 } },
  { name: '2) Fell short — too much left in reserve',
    verdict: { outcome: 'fell_short', why: 'RIR 4 vs target 2 — 2 reps left in the tank.', prescribedRir: 2, actualRir: 4, rirDelta: 2 },
    ruleDecisions: [],
    context: { exercise: 'Leg Press', lift_code: 'LEGPRESS', sets: [{ weight: 300, reps: 10, rir: 4 }], first_weight: 250, best_weight: 320 } },
  { name: '3) Met expectation, pain_flag rule fired',
    verdict: { outcome: 'met', why: 'RIR 2 — right on the 2 target.', prescribedRir: 2, actualRir: 2, rirDelta: 0 },
    ruleDecisions: [{ decision: 'caution', rule_id: 'pain_flag', severity: 'error',
      reasoning: 'Pain/discomfort mentioned in notes ("shoulder pain"). Hold load increases on the affected lift until it clears.',
      criterion_progress: null, lift_code: 'OHP' }],
    context: { exercise: 'Overhead Press', lift_code: 'OHP', sets: [{ weight: 105, reps: 8, rir: 2 }], first_weight: 95, best_weight: 115 } },
];

const payloadFor = s => ({
  verdict: coach.sanitizeVerdictFacts(s.verdict),
  rule_decisions: coach.sanitizeRuleDecisions(s.ruleDecisions),
  context: s.context ? coach.sanitizeReactionContext(s.context) : null,
});

function voiceSpec(text) {
  if (!text) return '(no output)';
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length;
  const exclaim = /!{2,}/.test(text) || (text.match(/!/g) || []).length > 1;
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text);
  return `words=${words} (<=60:${words<=60}) | sentences=${sentences} (<=4:${sentences<=4}) | no-exclaim-stack:${!exclaim} | no-emoji:${!emoji}`;
}

(async () => {
  console.log('GEMINI key present:', coach.isConfigured(), '| model:', coach.coachModel());
  for (const s of scenarios) {
    console.log('\n=== ' + s.name + ' ===');
    console.log('PAYLOAD: ' + JSON.stringify(payloadFor(s)));
    let out = null, err = null;
    try { out = await coach.generateVerdictReaction(s.verdict, { ruleDecisions: s.ruleDecisions, context: s.context }); }
    catch (e) { err = e.message; }
    console.log('ATLAS_LIVE_START>>>');
    console.log(out == null ? '(null)' : out);
    console.log('<<<ATLAS_LIVE_END');
    if (err) console.log('ERROR: ' + err);
    console.log('VOICE_SPEC: ' + voiceSpec(out));
  }
})().catch(e => { console.error('HARNESS_FATAL:', e); process.exit(1); });
