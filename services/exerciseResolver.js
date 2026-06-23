'use strict';

// Exercise resolver — the recognition front door.
//
//   raw user text → normalize → strip set-notation → alias lookup → canonical id
//
// REFERENCE-ONLY recognition. No Sheets, no writes, no parser-grammar change. This
// resolves a user-entered exercise name to a canonical KB record BEFORE any
// coaching / progression / substitution / fatigue logic runs, so that logic never
// branches on raw strings. It does NOT (yet) feed the live write path — wiring is
// gated on the alias tests passing (see docs/EXERCISE_KB_WIRING.md).
//
// `exercise_id` (KB) is distinct from `lift_code` (Sheets/enrichment). This module
// never reads or writes lift_code.

const { normalizeExerciseText } = require('./exerciseKbSchema');

let CATALOG = [];
let ALIASES = [];
try {
  CATALOG = require('../data/exercise_catalog.v1.json');
  ALIASES = require('../data/exercise_aliases.v1.json');
} catch (_) {
  // Data not built yet — resolver returns null until the KB files exist.
  CATALOG = Array.isArray(CATALOG) ? CATALOG : [];
  ALIASES = Array.isArray(ALIASES) ? ALIASES : [];
}

const byId = new Map();
for (const rec of CATALOG) if (rec && rec.exercise_id) byId.set(rec.exercise_id, rec);

// normalized alias → { exercise_id, confidence, alias_type }
const aliasIndex = new Map();
function register(alias, exercise_id, confidence, alias_type) {
  const norm = normalizeExerciseText(alias);
  if (!norm || !byId.has(exercise_id)) return;
  // First registration wins for a given normalized form; explicit aliases are
  // loaded before synthesized name-aliases, so curated confidence is preserved.
  if (!aliasIndex.has(norm)) aliasIndex.set(norm, { exercise_id, confidence, alias_type });
}
// Canonical names are registered FIRST so a record's own name always wins — an
// alias of another exercise can never shadow a canonical name. (The committed data
// is also validated to contain no such collision; this is defense in depth.)
for (const rec of CATALOG) if (rec && rec.name) register(rec.name, rec.exercise_id, 1, 'common_name');
for (const a of ALIASES) if (a && a.alias) register(a.alias, a.exercise_id, typeof a.confidence === 'number' ? a.confidence : 1, a.alias_type || 'common_name');

// Strip a trailing set-notation tail ("Cable Fly 30 12/0" → "Cable Fly"): the lift
// name is the run of leading tokens before the first token that contains a digit.
function extractExerciseLead(text) {
  const tokens = String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
  const lead = [];
  for (const tok of tokens) {
    if (/\d/.test(tok)) break;
    lead.push(tok);
  }
  return (lead.length ? lead : tokens).join(' ');
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

// Resolve user text to a canonical exercise. Returns null when nothing matches
// (the caller should ask for clarification rather than guess). A low-confidence
// match (confidence < threshold) is returned but flagged `confident:false` so the
// caller can confirm before committing coaching logic to it.
function resolveExercise(text, { threshold = DEFAULT_CONFIDENCE_THRESHOLD } = {}) {
  const lead = extractExerciseLead(text);
  const norm = normalizeExerciseText(lead);
  if (!norm) return null;
  const hit = aliasIndex.get(norm);
  if (!hit) return null;
  const rec = byId.get(hit.exercise_id) || null;
  return {
    exercise_id: hit.exercise_id,
    name: rec ? rec.name : null,
    confidence: hit.confidence,
    alias_type: hit.alias_type,
    confident: hit.confidence >= threshold,
    matched_alias: norm,
    record: rec,
  };
}

function getExercise(exercise_id) {
  return byId.get(exercise_id) || null;
}

module.exports = {
  resolveExercise,
  extractExerciseLead,
  getExercise,
  allExercises: () => CATALOG.slice(),
  allAliases: () => ALIASES.slice(),
  DEFAULT_CONFIDENCE_THRESHOLD,
};
