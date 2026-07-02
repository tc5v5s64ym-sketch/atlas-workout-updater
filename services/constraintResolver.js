'use strict';

// Constraint Resolver — One-Brain architecture item 3 (docs/COACHING_ENGINE_ARCHITECTURE.md),
// composer-first Phase 0 item 3 (docs/COMPOSER_FIRST_MIGRATION.md).
//
// THE GAP THIS CLOSES: the Constraints tab (typed, owner-approved rules written
// by POST /api/constraints — kind ∈ injury|equipment|preference, rule ∈
// avoid|limit|substitute) is read by coach chat for prose context, but never
// reaches the Brain: stateAssembly does not read it and sessionGenerator only
// sees per-request envelope constraints. A saved "avoid overhead press" shapes
// what the coach SAYS but not what it GENERATES.
//
// resolveConstraints({ stored, request }) merges both sources into ONE
// engine-shape constraints object (the IntentEnvelope constraint vocabulary —
// the same keys sessionGenerator.buildSession consumes), with safety-first
// precedence and honest provenance:
//   - injuries are ADDITIVE — any rule verb on kind=injury protects the joint;
//     they are never subtracted by a request.
//   - the request is present-tense truth for circumstances: request equipment
//     intersects stored allowances, and on a hard conflict the request wins
//     (recorded, never silent).
//   - anything that cannot be mapped deterministically is returned in
//     `ignored` with a reason — intent is never silently discarded.
//
// Pure and total: no I/O, no LLM, no write, never throws. The only file read
// is the static vocabulary JSON at require time (single source of truth for
// the injury/equipment enums — no drift).
//
// v1 limits (each recorded in `ignored`, filed in BACKLOG):
//   - one injury slot: the consumer contract (constraint_keys.injury) is a
//     single enum. Request injury wins; else the most recent stored injury.
//   - rule=limit is not resolvable to a session shape yet (avoid/substitute
//     are); limit rows are surfaced, not applied.

const VOCAB = require('../config/coaching/contracts/intent.vocabulary.json');

const INJURY_VALUES = new Set(VOCAB.constraint_keys.injury.values);
const EQUIPMENT_VALUES = VOCAB.constraint_keys.equipment.values;
const EQUIPMENT_SET = new Set(EQUIPMENT_VALUES);

// target-text → injury enum. Substring match on the lowercased target; longer
// phrases first so "lower back" never half-matches something else.
const INJURY_SYNONYMS = [
  ['lower back', 'lower_back'], ['low back', 'lower_back'], ['lumbar', 'lower_back'],
  ['shoulder', 'shoulder'], ['knee', 'knee'], ['elbow', 'elbow'], ['wrist', 'wrist'],
  ['hip', 'hip'], ['ankle', 'ankle'], ['neck', 'neck'], ['back', 'lower_back'],
];

// target-text → equipment enum. Substring match on the lowercased target.
const EQUIPMENT_SYNONYMS = [
  ['barbell', 'barbell'], ['dumbbell', 'dumbbell'], ['machine', 'machine'],
  ['cable', 'cable'], ['body weight', 'bodyweight'], ['bodyweight', 'bodyweight'],
  ['kettlebell', 'kettlebell'], ['band', 'bands'],
];

function _normRow(row) {
  if (Array.isArray(row)) {
    return { date: row[0] || null, kind: row[1] || null, target: row[2] || null, rule: row[3] || null, note: row[4] || null };
  }
  if (row && typeof row === 'object') {
    return { date: row.date || null, kind: row.kind || null, target: row.target || null, rule: row.rule || null, note: row.note || null };
  }
  return null;
}

function _mapInjury(target) {
  const t = String(target || '').toLowerCase();
  for (const [needle, value] of INJURY_SYNONYMS) {
    if (t.includes(needle) && INJURY_VALUES.has(value)) return value;
  }
  return null;
}

function _mapEquipment(target) {
  const t = String(target || '').toLowerCase();
  for (const [needle, value] of EQUIPMENT_SYNONYMS) {
    if (t.includes(needle) && EQUIPMENT_SET.has(value)) return value;
  }
  return null;
}

/**
 * Merge stored Constraints-tab rows with per-request envelope constraints into
 * one engine-shape constraints object.
 *
 * @param {object} params
 * @param {Array}  params.stored   Constraints-tab rows (positional arrays or
 *                                 {date,kind,target,rule,note} objects).
 * @param {object} params.request  IntentEnvelope-style constraints (optional).
 * @returns {{ constraints: object, applied: Array, ignored: Array }}
 */
function resolveConstraints(params) {
  const p = params && typeof params === 'object' ? params : {};
  const stored = Array.isArray(p.stored) ? p.stored : [];
  const request = p.request && typeof p.request === 'object' ? p.request : {};

  const applied = [];
  const ignored = [];
  const injuries = [];            // [{ value, date }] — mapped, dated for recency
  const excludeStored = [];       // exercise names from preference rows
  const equipmentAvoided = new Set();

  for (const raw of stored) {
    const row = _normRow(raw);
    if (!row || !row.kind || !row.target || !row.rule) {
      if (raw != null) ignored.push({ row: row || raw, reason: 'malformed_row' });
      continue;
    }
    const kind = String(row.kind).toLowerCase();
    const rule = String(row.rule).toLowerCase();

    if (kind === 'injury') {
      // Safety is additive: avoid/limit/substitute all mean "protect it".
      const value = _mapInjury(row.target);
      if (value) { injuries.push({ value, date: row.date || '' }); applied.push({ row, mapped_to: { injury: value } }); }
      else ignored.push({ row, reason: 'injury_area_unrecognized' });
      continue;
    }

    if (kind === 'equipment') {
      if (rule === 'limit') { ignored.push({ row, reason: 'limit_not_resolvable_v1' }); continue; }
      const value = _mapEquipment(row.target);
      if (value) { equipmentAvoided.add(value); applied.push({ row, mapped_to: { equipment_avoided: value } }); }
      else ignored.push({ row, reason: 'equipment_unrecognized' });
      continue;
    }

    if (kind === 'preference') {
      if (rule === 'limit') { ignored.push({ row, reason: 'limit_not_resolvable_v1' }); continue; }
      const name = String(row.target).trim();
      if (name) { excludeStored.push(name); applied.push({ row, mapped_to: { exclude_exercise: name } }); }
      else ignored.push({ row, reason: 'empty_target' });
      continue;
    }

    ignored.push({ row, reason: 'unknown_kind' });
  }

  // ---- Merge (request keys pass through verbatim; stored narrows/extends) ----
  const constraints = { ...request };

  // exclude_exercises: union, case-insensitive dedupe, request entries first.
  const requestExcludes = Array.isArray(request.exclude_exercises) ? request.exclude_exercises : [];
  const seen = new Set();
  const excludes = [];
  for (const name of [...requestExcludes, ...excludeStored]) {
    const key = String(name).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    excludes.push(String(name).trim());
  }
  if (excludes.length) constraints.exclude_exercises = excludes;

  // injury: single slot (consumer contract). Request wins; else most recent
  // stored (dated rows beat undated; ISO dates sort lexicographically).
  let winner = null;
  if (typeof request.injury === 'string' && request.injury) {
    winner = request.injury;
  } else if (injuries.length) {
    winner = [...injuries].sort((a, b) => String(a.date).localeCompare(String(b.date))).pop().value;
    constraints.injury = winner;
  }
  for (const inj of injuries) {
    if (inj.value !== winner) ignored.push({ row: { kind: 'injury', target: inj.value }, reason: 'single_injury_slot_v1' });
  }

  // equipment — ONE rule (settled per PR #809 review): stored avoids narrow
  // the list per-item, UNLESS narrowing would leave nothing usable — an
  // explicit request is present-tense consent, so on a total conflict the
  // request stands. Every drop and every override is recorded; an empty list
  // is never emitted (downstream treats [] as falsy and would fall back to
  // the FULL default set, inverting the stored intent — the (d) edge).
  if (equipmentAvoided.size) {
    const requestEquipment = Array.isArray(request.equipment) && request.equipment.length
      ? request.equipment.map(e => String(e).trim().toLowerCase())
      : null;
    if (!requestEquipment) {
      const allowed = EQUIPMENT_VALUES.filter(e => !equipmentAvoided.has(e));
      if (allowed.length) {
        constraints.equipment = allowed;
      } else {
        // Every equipment type avoided and nothing requested: leave the key
        // ABSENT (consumer default applies) and say so — never emit [].
        delete constraints.equipment;
        ignored.push({ row: { kind: 'equipment', target: [...equipmentAvoided].join(', ') }, reason: 'equipment_all_avoided_default_used' });
      }
    } else {
      const intersection = requestEquipment.filter(e => !equipmentAvoided.has(e));
      if (intersection.length) {
        constraints.equipment = intersection;
        for (const dropped of requestEquipment.filter(e => equipmentAvoided.has(e))) {
          ignored.push({ row: { kind: 'equipment', target: dropped }, reason: 'equipment_stored_avoid_narrowed' });
        }
      } else {
        constraints.equipment = requestEquipment;
        ignored.push({ row: { kind: 'equipment', target: [...equipmentAvoided].join(', ') }, reason: 'equipment_conflict_request_wins' });
      }
    }
  } else if (Array.isArray(request.equipment) && request.equipment.length) {
    // Pass-through branch normalized too, so the resolver's own output is
    // uniformly enum-cased regardless of which branch produced it.
    constraints.equipment = request.equipment.map(e => String(e).trim().toLowerCase());
  }

  return { constraints, applied, ignored };
}

module.exports = { resolveConstraints };
