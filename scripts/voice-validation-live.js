#!/usr/bin/env node
'use strict';

// ── Advisory voice-validation sampler (Soul Plan PR-B7, Part 4) ──────────────
//
// Samples Atlas's live coach wording for the owner-ratified Set C scenarios
// (test/fixtures/voiceCorpusSetC.js) and prints, per scenario: the id, the
// engine-decided coach_mode + register grant, the returned wording, and any
// detected voice violations — for OWNER REVIEW, never as a verdict.
//
// IRON CONSTRAINTS (do not relax):
//   * ADVISORY ONLY. Model wording is nondeterministic; this MUST NEVER become a
//     CI gate. It is not wired into `npm test`, and it always exits 0.
//   * NEVER writes to Google Sheets (the coach set-reaction voice performs no
//     Sheets access) and never mutates anything.
//   * DEFAULTS to a safe, offline path: with no flags it scores the corpus's OWN
//     ✅/❌ exemplars through the detectors (deterministic, no network), so the
//     owner can see the checks without a live key.
//   * A LIVE request requires BOTH `--live` AND a configured GEMINI_API_KEY; it
//     refuses otherwise. It NEVER prints the key or any secret.
//   * The violation surface reuses the REAL production suppressor
//     (services/coach.findRegisterViolations) for the profanity / earned-vocab
//     gate, plus the advisory heuristics in test/helpers/voiceViolationDetectors
//     for filler, hype, cliché, emoji, uncited numbers, length, and question
//     shape. It surfaces evidence; it does not "solve taste".
//
// Usage:
//   node scripts/voice-validation-live.js                 # offline demo (exemplars)
//   node scripts/voice-validation-live.js --scenario C3,C16
//   node scripts/voice-validation-live.js --live          # requires GEMINI_API_KEY
//   node scripts/voice-validation-live.js --live --scenario C14 --timeout 20000

const coach = require('../services/coach');
const { grantRegister } = require('../services/registerPermissions');
const { SET_C } = require('../test/fixtures/voiceCorpusSetC');
const det = require('../test/helpers/voiceViolationDetectors');

// ── args (tiny, dependency-free) ─────────────────────────────────────────────
function parseArgs(argv) {
  const args = { live: false, scenarios: null, timeout: 15000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--scenario' || a === '--scenarios') args.scenarios = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--timeout') args.timeout = Math.max(1000, Number(argv[++i]) || 15000);
  }
  return args;
}

function selectScenarios(ids) {
  if (!ids || !ids.length) return SET_C;
  const wanted = new Set(ids);
  return SET_C.filter(s => wanted.has(s.id.toUpperCase()));
}

// Build the smallest honest facts payload for the set-reaction voice from a
// fixture. This is an ADVISORY sampler, not a production facts assembler — it
// forwards the engine-granted register + coach_mode and the fixture's citable
// numbers as reference grounding, so the model has real numbers to word and the
// uncited-number check is meaningful.
function factsForFixture(s) {
  const register = s.expected_register || grantRegister({ mode: s.expected_mode, scarcity: s.scarcity });
  return {
    coach_mode: s.expected_mode,
    register,
    scenario_note: s.situation,
    reference_sets: (s.citable_numbers || []).map(n => ({ weight: n })),
  };
}

// Run every check over a candidate line and return a list of {code, detail}.
function findViolations(line, s) {
  const out = [];
  const register = s.expected_register || grantRegister({ mode: s.expected_mode, scarcity: s.scarcity });

  // Production suppressor — the real gate: profanity without permission, and
  // earned-moment (PR/celebration) vocabulary outside celebrate/praise.
  for (const v of coach.findRegisterViolations(line, { mode: s.expected_mode, register })) {
    out.push({ code: v.code, detail: v.phrase });
  }

  // Advisory heuristics.
  const filler = [...det.detectFiller(line), ...det.detectCliche(line)];
  if (filler.length) out.push({ code: 'forbidden_filler', detail: filler.join(', ') });
  const hype = det.detectHype(line);
  if (hype.length) out.push({ code: 'hype_vocabulary', detail: hype.join(', ') });
  const pet = det.detectPetNames(line);
  if (pet.length) out.push({ code: 'pet_name', detail: pet.join(', ') });
  const emoji = det.detectEmoji(line);
  if (emoji.length) out.push({ code: 'emoji', detail: emoji.join(' ') });
  const stack = det.detectExclamationStacking(line);
  if (stack) out.push({ code: 'exclamation_stacking', detail: `${stack.count} exclamation marks` });
  const uncited = det.detectUncitedNumbers(line, s.citable_numbers);
  if (uncited.length) out.push({ code: 'uncited_numbers', detail: `${uncited.join(', ')} not in facts` });
  if (det.exceedsLength(line)) {
    const { words, sentences } = det.measureLength(line);
    out.push({ code: 'excessive_length', detail: `${words} words / ${sentences} sentences` });
  }
  // Question-shape is a REQUIREMENT for challenge/pattern moments — flag its absence.
  if (s.requires_question_shape && !det.isQuestionShaped(line)) {
    out.push({ code: 'missing_question_shape', detail: 'challenge must ASK, not lecture' });
  }
  return out;
}

function fmtRegister(r) {
  if (!r) return '— (silence)';
  return `${r.intensity} | casual:${r.casual_ok} humor:${r.humor_ok} profanity:${r.profanity_ok}`;
}

function printScenarioHeader(s) {
  console.log('');
  console.log(`── ${s.id} — ${s.description}`);
  console.log(`   situation:  ${s.situation}`);
  console.log(`   expected:   mode=${s.expected_mode}   register: ${fmtRegister(s.expected_register)}`);
  if (!s.drives_select_mode) console.log(`   mode source: ${s.mode_source}`);
  if (s.register_annotation_divergence) console.log('   ⚠ register-label divergence on file (see fixture / BACKLOG)');
}

function printViolations(label, violations) {
  if (!violations.length) {
    console.log(`   ${label}: clean ✓`);
    return;
  }
  console.log(`   ${label}: ${violations.length} flag(s)`);
  for (const v of violations) console.log(`       • ${v.code}: ${v.detail}`);
}

// ── offline demo: score the corpus's OWN exemplars (no network) ──────────────
function runOffline(scenarios) {
  console.log('MODE: offline demo — scoring the ratified Set C exemplars through the detectors.');
  console.log('      (no LLM call, no key needed; pass --live to sample real wording.)');
  let approvedClean = 0;
  let approvedTotal = 0;
  let rejectedFlagged = 0;
  let rejectedTotal = 0;
  for (const s of scenarios) {
    printScenarioHeader(s);
    if (s.outcome_type === 'silence') {
      console.log('   outcome:    SILENCE — the fixture asserts no LLM fetch occurs.');
    }
    for (const line of s.approved) {
      approvedTotal++;
      const v = findViolations(line, s);
      if (!v.length) approvedClean++;
      console.log(`   ✅ "${line}"`);
      printViolations('   checks', v);
    }
    for (const line of s.rejected) {
      rejectedTotal++;
      const v = findViolations(line, s);
      if (v.length) rejectedFlagged++;
      console.log(`   ❌ "${line}"`);
      printViolations('   checks', v);
    }
  }
  console.log('');
  console.log(`SUMMARY (advisory): approved-clean ${approvedClean}/${approvedTotal}, rejected-flagged ${rejectedFlagged}/${rejectedTotal}.`);
  console.log('Some ❌ lines are out of character for SEMANTIC reasons (caving, over-apology) that lexical detectors cannot catch — absence of a flag is not a pass.');
}

// ── live sampler: real wording from the coach voice ──────────────────────────
async function runLive(scenarios, timeout) {
  if (!coach.isConfigured()) {
    console.error('REFUSED: --live requires GEMINI_API_KEY to be configured in the environment.');
    console.error('         (The key is never printed. Set it and re-run, or drop --live for the offline demo.)');
    return;
  }
  console.log('MODE: live sampler — sampling real coach wording. ADVISORY ONLY (never a CI gate).');
  console.log(`      model=${coach.coachModel()} timeout=${timeout}ms  (no Sheets access on this path.)`);
  for (const s of scenarios) {
    printScenarioHeader(s);
    if (s.outcome_type === 'silence') {
      console.log('   outcome:    SILENCE expected — a live line here would itself be a finding.');
    }
    let wording = null;
    let error = null;
    try {
      wording = await coach.generateCoachMessage(factsForFixture(s), { timeoutMs: timeout });
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
    if (error) {
      // Never surface a raw key; generateCoachMessage errors carry only status text.
      console.log(`   returned:   (no wording — ${error})`);
      continue;
    }
    if (!wording || !String(wording).trim()) {
      console.log('   returned:   (empty — coach fell back to deterministic copy)');
      continue;
    }
    console.log(`   returned:   "${String(wording).trim()}"`);
    printViolations('   violations', findViolations(String(wording), s));
  }
  console.log('');
  console.log('Reminder: this is evidence for owner review, not an objective taste score.');
}

function printHelp() {
  console.log([
    'Atlas voice-validation sampler (advisory only — never a CI gate).',
    '',
    'Usage:',
    '  node scripts/voice-validation-live.js                  offline demo (no key)',
    '  node scripts/voice-validation-live.js --scenario C3,C16',
    '  node scripts/voice-validation-live.js --live           requires GEMINI_API_KEY',
    '  node scripts/voice-validation-live.js --live --timeout 20000',
    '',
    'Flags:',
    '  --scenario <ids>  comma-separated Set C ids (default: all)',
    '  --live            sample real wording (needs a configured GEMINI_API_KEY)',
    '  --timeout <ms>    live request timeout (default 15000)',
    '  --help            this message',
  ].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  const scenarios = selectScenarios(args.scenarios);
  if (!scenarios.length) {
    console.error(`No matching scenarios for ${JSON.stringify(args.scenarios)}. Known ids: ${SET_C.map(s => s.id).join(', ')}`);
    return;
  }
  if (args.live) await runLive(scenarios, args.timeout);
  else runOffline(scenarios);
}

main().catch(err => {
  // Advisory tool: report and exit 0 (never a gate). Message only — no secrets.
  console.error(`voice-validation-live: ${err && err.message ? err.message : err}`);
});
