'use strict';

// #1626 — a natural finish line carrying a session-duration annotation
// ("Done. 58 min.", the Soul Corpus Session 6 close) never reached closeout:
// the whole-string looksLikeLogIt vocabulary has no room for the annotation,
// so the line fell into the set parser (needs_clarification) and — with the
// duration sitting in the effort field, exactly as the athlete had entered
// it — the parse-error catch's coach routing is gated off by
// hasAnyEffortInput(), leaving no reply, no closeout card, no save, no seal
// (persona run persona-marcus-20261030T002629-B6D931, PR #1624).
//
// These pins slice the REAL matchers out of the built bundle (the
// closeoutConfirmWiring harness pattern) and pin the finish-line lane:
//   • a finish statement + ONE duration annotation (trailing or leading)
//     is a closeout command;
//   • the bare finish heads the log-it vocabulary misses are closeouts;
//   • a message carrying sets, a question, or an in-progress sense of
//     "done" ("done with warmups, now squats") is NEVER a closeout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function loadMatchers() {
  const start = appSrc.indexOf('function looksLikeLogIt');
  const end = appSrc.indexOf('function showCorrectionPrompt');
  assert.ok(start > 0, 'looksLikeLogIt must exist in the bundle');
  assert.ok(end > start, 'the matcher slice must end at showCorrectionPrompt');
  const slice = appSrc.slice(start, end);
  const factory = new Function(`${slice}; return { looksLikeLogIt, looksLikeFinishLine };`);
  return factory();
}

test('#1626 gap (documents the defect): the base log-it matcher cannot see a duration-carrying finish line', () => {
  const { looksLikeLogIt } = loadMatchers();
  assert.equal(looksLikeLogIt('Done. 58 min.'), false,
    'the whole-string vocabulary has no room for the duration annotation — this is the gap the finish lane closes');
  assert.equal(looksLikeLogIt('finished in 45 min'), false);
  assert.equal(looksLikeLogIt('Finished.'), false, 'even a bare "Finished." is outside the log-it vocabulary');
  assert.equal(looksLikeLogIt('all done'), false);
  // …while the bare corpus-free forms it does know still match, unchanged.
  assert.equal(looksLikeLogIt('done'), true);
  assert.equal(looksLikeLogIt('Done, log it.'), true);
});

test('#1660 gap (documents the defect): the base log-it matcher cannot see Priya\'s compound closeout', () => {
  const { looksLikeLogIt } = loadMatchers();
  // The exact existing fixture closeout (tests/e2e/gate/personas/priya.js:147-149).
  const priya = 'Done — squat held at 35, bench revised to 25 x 8, rows 30, plank PB 40 seconds.';
  assert.equal(looksLikeLogIt(priya), false,
    'the whole-string vocabulary has no room for the recap tail — this is the gap the recap lane closes');
  // The #1634 duration-strip lane cannot see it either on its own: stripping
  // the trailing "40 seconds" leaves "…plank PB", which is no finish
  // statement — demonstrated failing-first on base (both matchers false, and
  // the parser returns needs_clarification/multiple_exercises_in_input; see
  // the build report). The recap lane below closes it.
});

test('#1660: a finish head with a dash-introduced recap tail is a closeout', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const yes = [
    'Done — squat held at 35, bench revised to 25 x 8, rows 30, plank PB 40 seconds.', // the fixture line itself
    'Done — squat 35, bench 25 x 8, rows 30, plank 40 seconds',
    'Done - squat 35, bench 25',
    'Done – squat 35, rows 30',
    'Finished — squat 35, bench 25',
    "I'm done — squat 35, rows 30",
    "that's it — squat 35, bench 25, rows 30",
    'all done — squat 35, rows 30',
    // A trailing session duration after the recap still closes out (the
    // duration strip fires first; the recap check runs on the stripped text).
    'Done — squat 35, bench 25. 58 min.',
  ];
  for (const p of yes) assert.equal(looksLikeFinishLine(p), true, `should close out: "${p}"`);
});

test('#1660: a recap tail must be a list of valued fragments, never prose or a lone value', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const no = [
    'Done — squat 35',                              // one fragment is not a recap list; it parses as a log
    'Done — squat felt easy, rows 30',              // a fragment with no number is prose, not a recap
    'Done — squat 35. Bench was heavy, rows 30',    // sentences in the tail are prose, not a recap
    'Done, squat 35, bench 25, rows 30',            // a comma head is not the dash recap marker (boundary)
    'Done. Squat 35, bench 25, rows 30',            // a period head is not the dash recap marker (boundary)
    'Done — squat 35, bench 25 8/2',                // slash-set notation is a log, never a finish
    'Done — squat 35, rows 30?',                    // a question never closes out
    'Done — squat 35, now bench',                   // in-progress sense: more work follows
    'Done — squat held at 35, bench revised',       // a valueless fragment breaks the recap
  ];
  for (const p of no) assert.equal(looksLikeFinishLine(p), false, `must NOT close out: "${p}"`);
});

test('#1668 gap (documents the defect): the base log-it matcher cannot see Tara\'s compound closeout', () => {
  const { looksLikeLogIt } = loadMatchers();
  // The exact existing fixture closeout (tests/e2e/gate/personas/tara.js:160-163).
  const tara = 'Done — landmine 70 x8 x3, bench stopped at set 2 rep 5 on the pinch, floor press 40s x8 x2 silent, rows and pull-ups as written, curls skipped for time.';
  assert.equal(looksLikeLogIt(tara), false,
    'the whole-string vocabulary has no room for the recap tail — this is the gap the recap lane closes');
});

test('#1668: a finish head with a recap tail carrying closed-status fragments is a closeout', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const yes = [
    'Done — landmine 70 x8 x3, bench stopped at set 2 rep 5 on the pinch, floor press 40s x8 x2 silent, rows and pull-ups as written, curls skipped for time.', // the fixture line itself
    'Done — squat 35, bench 25, rows as written',
    'Done — squat 35, bench 25, rows as planned',
    'Done — squat 35, bench 25, curls skipped',
    'Done — squat 35, bench 25, curls skipped for time',
    'Done - squat 35, bench 25, rows as written',
    'Finished — squat 35, bench 25, curls skipped',
    'Done — squat 35, bench 25 x 8, rows as written, curls skipped',
  ];
  for (const p of yes) assert.equal(looksLikeFinishLine(p), true, `should close out: "${p}"`);
});

test('#1668: a closed-status fragment must be closed status, and the recap must still rest on values', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const no = [
    'Done — squat felt easy, rows 30',              // a prose fragment is still prose, not a recap
    'Done — squat held at 35, bench revised',       // a valueless fragment outside the closed-status vocabulary still breaks the recap
    'Done — squat 35, bench 25, rows felt heavy',   // a prose fragment breaks the recap even with two valued fragments
    'Done — squat 35, bench skipped',               // one valued fragment plus a skip note is not a recap list; it parses as a log
    'Done — squat 35, rows as written',             // one valued fragment plus a closed status is not a recap list
    'Done — rows as written, curls skipped',        // no valued fragment at all is not a recap
    'Done — squat 35, bench 25, rows skipped today, curls felt fine', // a prose fragment breaks the recap even beside a skip
  ];
  for (const p of no) assert.equal(looksLikeFinishLine(p), false, `must NOT close out: "${p}"`);
});

test('#1681: a recap fragment opening with an addition/continuation command is new work, never a closeout', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const no = [
    'Done — squat 35, now bench 25',               // audit counterexample: "now" is a continuation, not a restatement
    'Done — add bench 25 x 8, add rows 30 x 10',   // audit counterexample: "add" is an addition command
    'Done — squat 35, add bench 25 x 8',           // a single add fragment breaks the recap
    'Done — squat 35, and add bench 25',           // "and add" is still an addition command
    'Done — squat 35, and now bench 25',           // "and now" is still a continuation
    'Done — now bench 25, rows 30 x 10',           // the command may lead the tail
    'Done — ADD bench 25, rows 30',                // the guard is case-insensitive
    'Done — squat 35, now rows 30, bench 25',      // the command may sit in a middle fragment
  ];
  for (const p of no) assert.equal(looksLikeFinishLine(p), false, `must NOT close out: "${p}"`);
});

test('#1681: the addition guard does not widen to past-tense narration or plain recaps', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const yes = [
    'Done — squat 35, bench added to 25, rows 30', // "added" is past-tense narration, not the "add" command
    'Done — squat 35, and bench 25, rows 30',      // a plain "and" recap is still a restatement
  ];
  for (const p of yes) assert.equal(looksLikeFinishLine(p), true, `should close out: "${p}"`);
});

test('#1626: a finish statement with a trailing duration annotation is a closeout', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const yes = [
    'Done. 58 min.',          // the corpus line itself (Session 6, persona finding F2)
    'Done, 58 min',
    'done. 58 min',
    'DONE. 58 MIN.',
    'Done in 58 minutes',
    'finished in 45 min',
    'Finished. 58 min.',
    'Done. 58:00',
    'Done in an hour',
    'done 58 min',
    "that's it. 58 min.",
    "we're done. 58 min.",
    'done for today. 58 min.',
  ];
  for (const p of yes) assert.equal(looksLikeFinishLine(p), true, `should close out: "${p}"`);
});

test('#1626: a finish statement with a leading duration annotation is a closeout', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const yes = [
    'Took 58 min. Done.',
    '58 min — done',
    '58 min, done',
    '58:00 — finished',
  ];
  for (const p of yes) assert.equal(looksLikeFinishLine(p), true, `should close out: "${p}"`);
});

test('#1626: the bare finish heads outside the log-it vocabulary are closeouts', () => {
  const { looksLikeFinishLine } = loadMatchers();
  for (const p of ['Finished.', 'Finished!', 'finished', 'all done', "I'm done", 'im done']) {
    assert.equal(looksLikeFinishLine(p), true, `should close out: "${p}"`);
  }
});

test('#1626: mid-workout and in-progress senses of finish words never close out', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const no = [
    'done with warmups, now squats',       // in-progress sense: more work follows
    'finished my first set',               // one set done, session continues
    'Done with bench',                     // per-exercise completion, not session end
    'done with squats, moving to bench',
    'finished squats, now bench',
    'finish the set then rack it',
    'Done. 5 min into bench',              // a duration MENTION mid-workout is not an annotation on a finish
    'Ran 45 min',                          // a modality log, not a finish statement
    '58 min',                              // a bare duration with no finish statement
    'Took 58 min',                         // a duration statement with no finish
  ];
  for (const p of no) assert.equal(looksLikeFinishLine(p), false, `must NOT close out: "${p}"`);
});

test('#1626: a message carrying sets is a log, never a finish line', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const no = [
    'Done it all. Bench 225 6/2 x3, incline 70 8/2 x3.',
    'Bench 225 5/2 x3',
    'Bench 225 5/2. Done.',
    'Done. 58 min. Bench 225 5/2',
    'done 225 5/2 x3',
  ];
  for (const p of no) assert.equal(looksLikeFinishLine(p), false, `must NOT close out: "${p}"`);
});

test('#1626: questions and prose tails are not closeouts (they stay conversational)', () => {
  const { looksLikeFinishLine } = loadMatchers();
  const no = [
    'are we done?',
    'done?',
    'Done. Next?',                                   // a question tail — the athlete is asking, not closing
    'Done. Should I be stretching after these sessions?',
    'Done. All of it.',                              // prose tail: not a duration annotation (known boundary)
    'Done. Gone.',
    'Done. Bench felt heavy.',
    'I finished the book you recommended',
    '',
  ];
  for (const p of no) assert.equal(looksLikeFinishLine(p), false, `must NOT close out: "${p}"`);
});

test('#1626 wiring: the finish lane sits at the closeout gate, after the log-it gate and before the parse', () => {
  const submitIdx = appSrc.indexOf("document.getElementById('logger-form').addEventListener('submit'");
  assert.ok(submitIdx > 0, 'the composer submit handler must exist');
  const handler = appSrc.slice(submitIdx, appSrc.indexOf('const pendingChatText =', submitIdx));
  const logItIdx = handler.indexOf('if (looksLikeLogIt(workoutTextInput.value)) {');
  const finishIdx = handler.indexOf('if (looksLikeFinishLine(workoutTextInput.value)) {');
  assert.ok(logItIdx > 0, 'the existing log-it gate must be present, unchanged');
  assert.ok(finishIdx > logItIdx, 'the finish lane must sit at the same gate, right after the log-it check');
  const block = handler.slice(finishIdx, finishIdx + 220);
  assert.match(block, /await handleLogIt\(\)/,
    'the finish lane must route through the EXISTING closeout machinery (handleLogIt), never a parallel path');
  // The clarification resolution still outranks closeout (existing order, unchanged).
  const clarifyIdx = handler.indexOf('resolvePendingClarification(workoutTextInput.value.trim(), currentSessionKey())');
  assert.ok(clarifyIdx > 0 && clarifyIdx < finishIdx,
    'a held clarification still resolves before closeout routing');
});

test('#1626 wiring: a partial effort form cannot veto the closeout re-entry, but still hard-stops a fresh submit', () => {
  // The second half of the defect: with the finish line routed, the closeout
  // re-entry submit computed the manual effort from a duration-only form and
  // collectManualEffort's all-or-nothing throw aborted the submit — no
  // preview, no card, no save — for EVERY closeout trigger in that state.
  const start = appSrc.indexOf('manualEffort = collectManualEffort(sessionId, date, location, notes);');
  assert.ok(start > 0, 'the manual-effort computation must exist in the submit handler');
  const block = appSrc.slice(start, start + 1600);
  const guardIdx = block.indexOf('if (!sessionCompiledAwaitingPreview)');
  assert.ok(guardIdx > 0,
    'the effort-validation catch must consult the closeout re-entry flag before hard-stopping');
  const guardBlock = block.slice(guardIdx, guardIdx + 200);
  assert.match(guardBlock, /setStatus\(loggerStatus, err\.message, 'error'\);\s*return;/,
    'a fresh submit (not the closeout re-entry) keeps the hard stop and its error');
  assert.match(block, /Saving the session without effort data/,
    'the re-entry path must warn visibly that the session saves without the effort data');
  // The all-or-nothing validation itself is unchanged — only its veto over
  // the closeout re-entry is scoped.
  assert.match(appSrc, /Effort needs duration, active calories, total calories, average HR, and peak HR/,
    'collectManualEffort keeps its all-or-nothing contract');
});
