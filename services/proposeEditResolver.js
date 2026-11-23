'use strict';

// Issue #1737 — Fable fix 11 (P1): PROPOSE_EDIT — model names the operation
// and row only; values from the athlete or dropped; athlete accepts a card.
//
// The Fable 5.2 re-audit findings (B-01 P1, B-04 P2, B-23 P3, #1706
// NEW-VARIANT): the model's PROPOSE_EDIT sets weight/reps/RIR the athlete
// never stated (athlete said 'really 140'; 410 was written to Log_Cleaned
// on Save), can delete_set an athlete-logged set out of the approved write,
// and a mid-session add_set plants an exercise-less row that blocks closeout.
// The server checked range only and the client applied with no accept step.
//
//   resolveProposeEdit(edit, athleteMessage, previewRows) → resolved edit | null
//
// - A model proposal may identify the operation and the row ONLY. Every
//   value in the resolved edit is extracted deterministically from the
//   athlete's own message (extractAthleteValues); model-supplied
//   weight/reps/RIR are discarded, never trusted — the same discipline as
//   planEditResolver (#1707), where the deterministic planner re-resolves
//   every prescription field.
// - `update_set`: the index must name a row in the preview the client sent
//   as context; the resolved edit carries only athlete-stated fields. No
//   athlete-stated value → the whole edit is null (fail closed).
// - `delete_set`: identity-only — no values exist to re-resolve, so the
//   operation + validated index pass through unchanged (like
//   planEditResolver's remove_exercises). The athlete accept card on the
//   client is its guard (B-plan-1); a bad index is dropped here.
// - `add_set`: values from the athlete message or dropped; dropped outright
//   when the preview is empty, because the client attaches the new set to
//   the last preview row's exercise — with no row there is no exercise,
//   and the planted exercise-less row blocks closeout (B-write-4).
// - Anything else (unknown action, malformed shape, out-of-range value)
//   → null.
//
// Pure — no I/O, no LLM, no Sheets, no write. The schema + bounds checks
// mirror services/coach.isValidEditSchema / editNumbersValid so this module
// stays importable from route tests that stub services/coach.

const NUM = '(\\d+(?:\\.\\d+)?)';

// Issue #1769 — [P2][Astra D06] Correction extraction binds the wrong
// actor's number; stale provenance markers bless replacements.
//
// Regression family of #1737/#1732. #1737 took the FIRST number-with-unit
// in the athlete's message, whoever stated it and whenever: 'my friend
// lifted 315 lb; my set was actually 140 lb' resolved to 315 (the
// friend's number). The extractor below binds numbers only to explicit
// current-athlete correction claims:
//
// - Clause-split: the message is split into clauses (on ; . , and/but/so/
//   then/yet) — a number belongs to the clause that states it. The split
//   never breaks a decimal (140.5) or a thousands group (1,000).
// - Actor/time filter: a clause that attributes its number to another actor
//   (my friend / he / she / they / we …), to the past (yesterday / last
//   time …) or to the future (will / next set …) contributes nothing. Only
//   surviving (current-athlete) clauses are parsed.
// - Guards on every candidate: a number the athlete negated ('not 315'),
//   signed ('-140'), inside a fraction ('140 1/2', '140/2'), or stated in
//   kg ('140 kg') is never read as a lb weight. A kg number is refused,
//   never silently converted.
// - Ambiguity is refused: two different values for one field across the
//   surviving clauses drop that field (first-match no longer wins).
//
// Single-clause messages behave exactly as before (the #1737 pinned cases);
// the change only fires when a message carries more than one number, actor,
// time, sign, fraction, or unit. The client half of #1769 — a stale
// userEdited marker blessing a replacement value — is fixed in
// src/app/coach-conversation.js applyProposedEdit (the marker is cleared
// when a value is set programmatically).
//
// Extract weight/reps/RIR the ATHLETE stated in their own message.
// Deterministic, conservative: only the patterns below count as stated.
// - "140x8" / "140 x 8" / "235×5" → weight + reps.
// - "140 lb" / "137.5 pounds" → weight.
// - "8 reps" → reps.
// - "rir 2" / "rir: 2" → rir.
// - Correction shorthand — "really 140", "actually 140", "change set 1 to
//   235", "make it 140x8": a single stated number read as the load. The
//   audit pins "really 140" → weight 140; athletes correcting reps say
//   "8 reps", which the reps pattern claims first, so the shorthand never
//   steals a number already claimed as reps/RIR.
// A number outside the sane rule-engine bounds (weight 0..2000, reps int
// 1..100, rir 0..10) is dropped, not carried.

// Split on clause boundaries, never inside a decimal (140.5) or a thousands
// group (1,000) — and never inside 'and a half/quarter' ('140 and a half'
// is one mixed fraction, not two clauses).
const CLAUSE_SPLIT = /[;]+|\.(?!\d)|,(?!\d)(?!\s+or\b)|\s+and\s+(?!a\s+(?:half|quarter)\b)|\s+but\s+|\s+so\s+|\s+then\s+|\s+yet\s+/;
// A clause attributes its number to someone other than the athlete — a named
// other ('my friend', 'the spotter', 'my training partner'), a third-person
// pronoun, or the group ('we', 'our': the group's lift is not the athlete's
// own correction). Up to two words may sit between the possessive and the
// role ('my old gym buddy'). Bare 'coach' is not listed: 'coach, my set was
// 140' addresses the coach, and the comma split already separates that
// vocative from the correction.
const OTHER_ACTOR = /\b(?:my|the|their|his|her)\s+(?:[a-z]+\s+){0,3}(?:friend|partner|buddy|mate|spotter|brother|sister|sibling|roommate|teammate|coach|trainer|lifter|guy|girl|wife|husband|spouse|son|daughter|child|kid)s?\b|\b(?:he|she|they|him|her|them|their|his|we|us|our)\b/;
// A first-person subject in the clause ('I', 'mine') makes it mixed-actor,
// not purely other-actor — the clause survives and its numbers compete (a
// conflicting athlete number then refuses the edit, and a sole athlete
// number still binds: 'I did 140 lb with my friend' is the athlete's own
// correction, not the friend's).
const FIRST_PERSON = /\b(?:i|mine|myself)\b/;
// A clause places its number in the past — a previous session, not this one.
// 'last set' is deliberately NOT past: 'my last set was 140' is the set just
// done in this session, a legitimate current correction.
const PAST_TIME = /\b(?:yesterday|last\s+time|last\s+session|last\s+week|last\s+month|last\s+year|previous\s+session|previous\s+workout)\b/;
// A clause places its number in the future — a plan, not this set.
const FUTURE_TIME = /\b(?:will|gonna|going\s+to|next\s+set|next\s+time|next\s+session|next\s+week|tomorrow|plan\s+to|aiming|target)\b/;
// A number stated in kilograms is not a pound weight.
const KG_UNIT = /^\s*(?:kg|kgs|kilo|kilos|kilogram|kilograms)\b/;

// Index of the captured number inside a regex match.
function numberIndex(match) {
  return match.index + match[0].indexOf(match[1]);
}
// The number is the object of a negation ('not 315', 'not really 140').
function isNegated(text, idx) {
  return /not\s+(?:really\s+|actually\s+)?$/.test(text.slice(0, idx));
}
// The number carries a minus sign ('-140', '- 140').
function isSigned(text, idx) {
  let i = idx - 1;
  while (i >= 0 && text[i] === ' ') i -= 1;
  return i >= 0 && (text[i] === '-' || text[i] === '\u2013' || text[i] === '\u2014' || text[i] === '\u2212');
}
// The number is the head of a thousands group ('1,000') — not the whole
// number. ('140, 8 reps' has a space after the comma, so it is unaffected.)
function isThousandsHead(text, idx, len) {
  return text[idx + len] === ',' && /\d/.test(text[idx + len + 1] || '');
}
// The number is half of a fraction ('140 1/2' denominator, '140/2'
// numerator) or the whole part of a mixed fraction ('140 1/2' — the 140).
function isFraction(text, idx, len) {
  if (idx > 0 && text[idx - 1] === '/') return true;
  let j = idx + len;
  if (j < text.length && text[j] === '/') return true;
  // Mixed fraction: a number, spaces, digits, then a slash ('140 1/2').
  let k = j;
  while (k < text.length && text[k] === ' ') k += 1;
  if (k < text.length && /\d/.test(text[k])) {
    let e = k;
    while (e < text.length && /\d/.test(text[e])) e += 1;
    let f = e;
    while (f < text.length && text[f] === ' ') f += 1;
    if (f < text.length && text[f] === '/') return true;
  }
  // Word-form mixed fraction: '140 and a half' — the 140 is not the weight.
  if (/^\s+and\s+a\s+(?:half|quarter)\b/.test(text.slice(j))) return true;
  // 'half of 140' / 'a quarter of 140' — the number is the fraction's base, not the weight.
  if (/(?:half|quarter)\s+of\s+$/.test(text.slice(0, idx))) return true;
  // Digit form: '1/2 of 140' / '3/4 of 200'.
  if (/\d+\s*\/\s*\d+\s+of\s+$/.test(text.slice(0, idx))) return true;
  return false;
}
// The number sits in an 'N or M' alternative ('140 or 150') — the athlete
// expressed uncertainty between two values, so neither binds.
function isOrAmbiguous(text, idx, len) {
  if (/^\s*,?\s*or\s+\d/.test(text.slice(idx + len))) return true;
  if (/\d\s*,?\s*or\s+$/.test(text.slice(0, idx))) return true;
  return false;
}
// The number is stated in kilograms ('140 kg') — not a pound weight.
function isKg(text, endIdx) {
  return KG_UNIT.test(text.slice(endIdx));
}

// Extract values from ONE surviving clause. Returns { values, conflicts } —
// a field with two different passing candidates in this clause is
// conflicted (dropped, not first-matched). `claimed` is the reps/RIR claimed
// anywhere in the surviving message, so the correction shorthand in this
// clause never steals a number another clause already claimed as reps/RIR.
function extractClauseValues(clause, claimed) {
  const values = {};
  const conflicts = new Set();
  const wxrRepsIdx = new Set();
  const take = (field, value) => {
    if (value === undefined) return;
    if (values[field] === undefined) values[field] = value;
    else if (values[field] !== value) { delete values[field]; conflicts.add(field); }
  };
  // Weight x reps — '140x8' / '140 x 8' / '235×5'.
  for (const m of clause.matchAll(new RegExp(`${NUM}\\s*[x×]\\s*(\\d+)`, 'g'))) {
    const wIdx = numberIndex(m);
    if (isNegated(clause, wIdx) || isSigned(clause, wIdx) || isFraction(clause, wIdx, m[1].length) || isThousandsHead(clause, wIdx, m[1].length)) continue;
    if (isKg(clause, wIdx + m[1].length)) continue;
    const rIdx = m.index + m[0].lastIndexOf(m[2]);
    if (isFraction(clause, rIdx, m[2].length)) continue;
    if (isKg(clause, m.index + m[0].length)) continue;
    if (isOrAmbiguous(clause, wIdx, m[1].length) || isOrAmbiguous(clause, rIdx, m[2].length)) continue;
    wxrRepsIdx.add(rIdx);
    take('weight', Number(m[1]));
    take('reps', Number(m[2]));
  }
  // Weight with a unit — '140 lb' / '137.5 pounds'.
  for (const m of clause.matchAll(new RegExp(`${NUM}\\s*(?:lb|lbs|pounds?)\\b`, 'g'))) {
    const wIdx = numberIndex(m);
    if (wxrRepsIdx.has(wIdx)) continue;
    if (claimed && claimed.reps.has(Number(m[1]))) continue;
    if (isNegated(clause, wIdx) || isSigned(clause, wIdx) || isFraction(clause, wIdx, m[1].length) || isThousandsHead(clause, wIdx, m[1].length)) continue;
    if (isOrAmbiguous(clause, wIdx, m[1].length)) continue;
    take('weight', Number(m[1]));
  }
  // Reps — '8 reps'.
  for (const m of clause.matchAll(/(\d+)\s*reps?\b/g)) {
    const rIdx = numberIndex(m);
    if (isNegated(clause, rIdx) || isSigned(clause, rIdx) || isFraction(clause, rIdx, m[1].length) || isThousandsHead(clause, rIdx, m[1].length)) continue;
    if (isOrAmbiguous(clause, rIdx, m[1].length)) continue;
    take('reps', Number(m[1]));
  }
  // RIR — 'rir 2' / 'rir: 2'.
  for (const m of clause.matchAll(/rir\s*(?:of|:|=)?\s*(\d+(?:\.\d+)?)/g)) {
    const rIdx = numberIndex(m);
    if (isNegated(clause, rIdx) || isSigned(clause, rIdx) || isFraction(clause, rIdx, m[1].length) || isThousandsHead(clause, rIdx, m[1].length)) continue;
    if (isOrAmbiguous(clause, rIdx, m[1].length)) continue;
    take('rir', Number(m[1]));
  }
  // Correction shorthand — 'really 140', 'actually 140', 'change set 1 to
  // 235', 'make it 140x8', 'no wait 150' (a self-correction: the 'no wait'
  // number supersedes, so it competes with — and can refuse — an earlier
  // number in the message): a single stated number read as the load. Never
  // steal a number already claimed as reps/RIR — in this clause or anywhere
  // else in the surviving message ('that was 8 reps' / 'really 8').
  for (const m of clause.matchAll(/(?:really|actually|meant|should be|was|it was|to|at|no\s+wait)\s+(\d+(?:\.\d+)?)\b/g)) {
    const wIdx = numberIndex(m);
    if (wxrRepsIdx.has(wIdx)) continue;
    if (isNegated(clause, wIdx) || isSigned(clause, wIdx) || isFraction(clause, wIdx, m[1].length) || isThousandsHead(clause, wIdx, m[1].length)) continue;
    if (isKg(clause, wIdx + m[1].length)) continue;
    if (isOrAmbiguous(clause, wIdx, m[1].length)) continue;
    // 'was 140 x 8 kg' — the number heads a WxR phrase stated in kg.
    if (/^\s*[x\u00d7]\s*\d+\s*(?:kg|kgs|kilo|kilos|kilogram|kilograms)\b/.test(clause.slice(wIdx + m[1].length))) continue;
    const v = Number(m[1]);
    if (v === values.reps || v === values.rir) continue;
    if (claimed && (claimed.reps.has(v) || claimed.rir.has(v))) continue;
    take('weight', v);
  }
  return { values, conflicts };
}

function extractAthleteValues(message) {
  const text = String(message || '').toLowerCase();
  const clauses = text.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean)
    .filter((c) => !(OTHER_ACTOR.test(c) && !FIRST_PERSON.test(c)) && !PAST_TIME.test(c) && !FUTURE_TIME.test(c));
  // First pass: reps/RIR claimed anywhere in the surviving message, so the
  // correction shorthand in any one clause never steals a number another
  // clause already claimed as reps/RIR. (Only reps/RIR are collected here;
  // weights come from the second pass.)
  const claimed = { reps: new Set(), rir: new Set() };
  for (const c of clauses) {
    const { values } = extractClauseValues(c, null);
    if (values.reps !== undefined) claimed.reps.add(values.reps);
    if (values.rir !== undefined) claimed.rir.add(values.rir);
  }
  const values = {};
  const conflicted = new Set();
  for (const c of clauses) {
    const { values: cv, conflicts } = extractClauseValues(c, claimed);
    for (const field of conflicts) { delete values[field]; conflicted.add(field); }
    for (const [field, value] of Object.entries(cv)) {
      if (conflicted.has(field)) continue;
      if (values[field] === undefined) values[field] = value;
      else if (values[field] !== value) { delete values[field]; conflicted.add(field); }
    }
  }
  if (values.weight !== undefined && !(values.weight > 0 && values.weight <= 2000)) delete values.weight;
  if (values.reps !== undefined && !(Number.isInteger(values.reps) && values.reps >= 1 && values.reps <= 100)) delete values.reps;
  if (values.rir !== undefined && !(values.rir >= 0 && values.rir <= 10)) delete values.rir;
  return values;
}

// Structural schema check + numeric bounds. Mirrors
// services/coach.isValidEditSchema: update_set / delete_set need a valid
// index; add_set needs no index; a present value must be finite and within
// sane rule-engine bounds.
function isValidEditSchema(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const numbersValid = (o) => {
    if (o.weight !== null && o.weight !== undefined && !(Number.isFinite(o.weight) && o.weight > 0 && o.weight <= 2000)) return false;
    if (o.reps !== null && o.reps !== undefined && !(Number.isInteger(o.reps) && o.reps >= 1 && o.reps <= 100)) return false;
    if (o.rir !== null && o.rir !== undefined && !(Number.isFinite(o.rir) && o.rir >= 0 && o.rir <= 10)) return false;
    return true;
  };
  if (obj.action === 'update_set') {
    return Number.isInteger(obj.index) && obj.index >= 0 && numbersValid(obj);
  }
  if (obj.action === 'delete_set') {
    return Number.isInteger(obj.index) && obj.index >= 0;
  }
  if (obj.action === 'add_set') {
    return numbersValid(obj);
  }
  return false;
}

function resolveProposeEdit(edit, athleteMessage, previewRows) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null;
  if (!isValidEditSchema(edit)) return null;
  const rows = Array.isArray(previewRows) ? previewRows : [];
  if (edit.action === 'update_set' || edit.action === 'delete_set') {
    if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= rows.length) return null;
  }
  if (edit.action === 'update_set') {
    const values = extractAthleteValues(athleteMessage);
    if (values.weight === undefined && values.reps === undefined && values.rir === undefined) return null;
    const resolved = { action: 'update_set', index: edit.index };
    if (values.weight !== undefined) resolved.weight = values.weight;
    if (values.reps !== undefined) resolved.reps = values.reps;
    if (values.rir !== undefined) resolved.rir = values.rir;
    return resolved;
  }
  if (edit.action === 'delete_set') {
    return { action: 'delete_set', index: edit.index };
  }
  if (edit.action === 'add_set') {
    if (!rows.length) return null;
    const values = extractAthleteValues(athleteMessage);
    if (values.weight === undefined && values.reps === undefined && values.rir === undefined) return null;
    const resolved = { action: 'add_set' };
    if (values.weight !== undefined) resolved.weight = values.weight;
    if (values.reps !== undefined) resolved.reps = values.reps;
    if (values.rir !== undefined) resolved.rir = values.rir;
    return resolved;
  }
  return null;
}

module.exports = { resolveProposeEdit, extractAthleteValues };
