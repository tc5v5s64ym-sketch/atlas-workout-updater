'use strict';

// ---------------------------------------------------------------------------
// The bare "row" / "rows" clarification must offer DISTINCT exercise identities.
//
// The defect: the prompt listed `barbell, seated, cable, or machine`, but `seated`,
// `cable`, and `machine` all canonicalize to Seated Row. Three of the four choices were
// labels for ONE lift, so the athlete was asked to choose between a lift and itself, and
// picking "cable" instead of "seated" looked like a different answer while producing the
// same row.
//
// The rule pinned here: every group the prompt displays maps to EXACTLY ONE canonical
// exercise, and the groups map to different ones. Athlete wording is preserved inside a
// group — "cable" and "machine" stay sayable, they are just no longer offered as separate
// identities.
//
// The strong test reads the groups OUT OF THE SHIPPED PROMPT rather than restating them,
// so a future edit that reintroduces a non-distinct choice fails here even if nobody
// updates this file. Read-only: no canonical exercise is created or split, no history is
// touched, and substitute selection and load derivation are unchanged.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeExerciseName, AMBIGUOUS_ALIASES } = require('../services/workoutTextParser');

const PROMPT = AMBIGUOUS_ALIASES.row;

/**
 * The choice groups the prompt actually displays. "Which row — a/b, or c/d/e?" reads as
 * two groups, [a, b] and [c, d, e]. Parsed from the string so the assertions below are
 * about what the athlete is shown, never about a copy of it kept in this file.
 */
function displayedGroups(prompt) {
  const body = String(prompt)
    .replace(/^[^—:-]*[—:-]\s*/, '')  // drop "Which row — " / "Which row - "
    .replace(/\?\s*$/, '')
    .trim();
  return body
    .split(/\s*,?\s*\bor\b\s*/i)
    .map((group) => group.split('/').map((s) => s.trim()).filter(Boolean))
    .filter((group) => group.length);
}

/** A displayed phrase is a modifier; the athlete says it with the noun ("cable row"). */
function canonicalFor(phrase) {
  const singular = canonicalizeExerciseName(`${phrase} row`);
  const plural = canonicalizeExerciseName(`${phrase} rows`);
  assert.ok(singular && singular.canonicalName, `"${phrase} row" must resolve to a lift`);
  assert.ok(plural && plural.canonicalName, `"${phrase} rows" must resolve to a lift`);
  assert.equal(plural.canonicalName, singular.canonicalName,
    `"${phrase} row" and "${phrase} rows" must be the same lift`);
  return singular.canonicalName;
}

test('the prompt is parsed into exactly two displayed groups', () => {
  const groups = displayedGroups(PROMPT);
  assert.equal(groups.length, 2, `expected two groups in ${JSON.stringify(PROMPT)}, got ${JSON.stringify(groups)}`);
  assert.deepEqual(groups, [['barbell', 'bent-over'], ['seated', 'cable', 'machine']]);
});

test('every displayed phrase resolves, singular and plural', () => {
  for (const group of displayedGroups(PROMPT)) {
    for (const phrase of group) canonicalFor(phrase);
  }
});

test('THE INVARIANT: every displayed group maps to exactly one canonical exercise', () => {
  for (const group of displayedGroups(PROMPT)) {
    const canonicals = new Set(group.map(canonicalFor));
    assert.equal(canonicals.size, 1,
      `group ${JSON.stringify(group)} spans ${canonicals.size} lifts (${[...canonicals].join(', ')}) — `
      + 'each displayed group must be exactly one exercise identity');
  }
});

test('THE INVARIANT: the displayed groups are different exercises from each other', () => {
  const groups = displayedGroups(PROMPT);
  const canonicals = groups.map((group) => canonicalFor(group[0]));
  assert.equal(new Set(canonicals).size, groups.length,
    `the prompt offers ${groups.length} groups but only ${new Set(canonicals).size} distinct lift(s): ${canonicals.join(', ')}`);
});

test('barbell and bent-over resolve to Bent-Over Row', () => {
  for (const phrase of ['barbell row', 'barbell rows', 'bb row', 'bent-over row', 'bent over row', 'bent row']) {
    const hit = canonicalizeExerciseName(phrase);
    assert.equal(hit && hit.canonicalName, 'Bent-Over Row', phrase);
  }
});

test('seated, cable and machine resolve to Seated Row', () => {
  for (const phrase of ['seated row', 'seated rows', 'cable row', 'cable rows', 'machine row', 'machine rows']) {
    const hit = canonicalizeExerciseName(phrase);
    assert.equal(hit && hit.canonicalName, 'Seated Row', phrase);
  }
});

test('bare row / rows stays ambiguous — never a silent lift', () => {
  for (const bare of ['row', 'rows', 'Row', 'ROWS']) {
    const hit = canonicalizeExerciseName(bare);
    assert.ok(hit && hit.ambiguous, `"${bare}" must stay ambiguous`);
    assert.equal(hit.canonicalName, undefined, `"${bare}" must not resolve to a lift`);
    assert.equal(hit.message, PROMPT, `"${bare}" must carry the shared prompt`);
  }
  assert.equal(AMBIGUOUS_ALIASES.rows, PROMPT, 'singular and plural must share one prompt');
});

test('no new canonical exercise was created — the prompt names only lifts that already exist', () => {
  const { EXERCISE_ALIASES } = require('../services/workoutTextParser');
  const known = new Set(EXERCISE_ALIASES.map(([canonical]) => canonical));
  for (const group of displayedGroups(PROMPT)) {
    const canonical = canonicalFor(group[0]);
    assert.ok(known.has(canonical), `${canonical} must already be a canonical exercise`);
  }
  // Exactly the two row identities that existed before this change, and no third.
  const rowCanonicals = [...known].filter((n) => /row/i.test(n)).sort();
  assert.deepEqual(rowCanonicals, ['Bent-Over Row', 'Seated Row']);
});

test('the pre-fix prompt would FAIL the distinctness invariant', () => {
  // The exact string this change replaces. Kept so the invariant above cannot pass
  // vacuously: it must genuinely reject the wording that shipped before.
  const PRE_FIX = 'Which row - barbell, seated, cable, or machine?';
  const groups = displayedGroups(PRE_FIX);
  const canonicals = groups.map((group) => canonicalFor(group[0]));
  assert.ok(groups.length > new Set(canonicals).size,
    `the pre-fix prompt must offer more groups (${groups.length}) than distinct lifts (${new Set(canonicals).size})`);
});
