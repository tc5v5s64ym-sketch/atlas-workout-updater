'use strict';

// ── D7(a) refuse-and-ask gate (Decision Desk #942, owner verdict) ─────────────
//
// Wired at the per-line parser ORCHESTRATION boundary: AFTER the parser has
// resolved the recognized lines and the KB resolver is available, and BEFORE the
// client assembles preview rows. A set line whose exercise NEITHER the parser's
// (deliberately narrow) alias table NOR the Exercise KB recognizes must refuse and
// ask ("didn't catch that lift — which one?") with ZERO rows, instead of silently
// logging a made-up, titlecased lift the coach never actually understood (AC8
// credibility floor). KB-known-but-parser-narrow lifts (e.g. Front Squat, Cable
// Fly) keep logging exactly as before — the refusal is KB-AWARE, so it only ever
// REDUCES what reaches the preview, and only for genuinely-unrecognized names.
//
// The KB resolver is INJECTED by the caller (never imported here) so the owner's
// held KB→parser decoupling boundary stays intact and this stays pure/testable.
// Read-only: it changes only the dry-run parse shape — never a write, proof field,
// schema, or the parser grammar itself (existing parser goldens are untouched).
//
// applyUnresolvedLiftGate(parsed, resolveFn) → parsed' (possibly downgraded)
//   - resolveFn(name) → a confident KB hit ({ confident:true, ... }) or falsy.

// The D7-ratified ask copy: name the lift when we have it, make clear nothing logged.
function d7Ask(name) {
  const n = String(name || '').trim();
  return n
    ? `I didn't catch that lift — "${n}". Which one is it? (nothing's logged yet)`
    : `I didn't catch that lift. Which one is it? (nothing's logged yet)`;
}

function _kbKnows(resolveFn, name) {
  if (typeof resolveFn !== 'function') return false;
  const n = String(name || '').trim();
  if (!n) return false;
  try {
    const hit = resolveFn(n);
    return !!(hit && hit.confident);
  } catch (_) {
    // A KB failure must never crash the dry-run; treat as "not confidently known".
    return false;
  }
}

// A parsed entry (single log_sets, or one exercise of a log_sets_multi) is
// genuinely unresolved only when the parser flagged it `unknown_exercise` AND the
// KB also can't resolve it confidently.
function _entryUnresolved(entry, resolveFn) {
  const warnings = Array.isArray(entry && entry.warnings) ? entry.warnings : [];
  if (!warnings.includes('unknown_exercise')) return false;
  const name = (entry && (entry.canonical_name || entry.exercise || entry.raw_name)) || '';
  return !_kbKnows(resolveFn, name);
}

function _withheld(entry) {
  const name = (entry && (entry.canonical_name || entry.exercise || entry.raw_name)) || '';
  return { line: name, message: d7Ask(name), warnings: ['unknown_exercise'] };
}

function applyUnresolvedLiftGate(parsed, resolveFn) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  // Single recognized-set line.
  if (parsed.intent === 'log_sets') {
    if (!_entryUnresolved(parsed, resolveFn)) return parsed;
    const w = _withheld(parsed);
    return {
      intent: 'needs_clarification',
      raw_text: parsed.raw_text,
      message: w.message,
      warnings: [...new Set([...(parsed.warnings || []), 'unresolved_lift'])],
      unresolved: [w],
    };
  }

  // Multi-line: survivors keep logging; genuinely-unknown lines are withheld + asked.
  if (parsed.intent === 'log_sets_multi' && Array.isArray(parsed.exercises)) {
    const survivors = [];
    const withheld = [];
    for (const ex of parsed.exercises) {
      if (_entryUnresolved(ex, resolveFn)) withheld.push(_withheld(ex));
      else survivors.push(ex);
    }
    if (!withheld.length) return parsed;

    const unresolved = [...(Array.isArray(parsed.unresolved) ? parsed.unresolved : []), ...withheld];

    // Nothing recognized survived → refuse the whole thing (zero rows).
    if (!survivors.length) {
      return {
        intent: 'needs_clarification',
        raw_text: parsed.raw_text,
        message: unresolved[0].message,
        warnings: [...new Set([...(parsed.warnings || []), 'unresolved_lift'])],
        unresolved,
      };
    }

    // Some survived → known rows log, the unknown ones ride along as asks.
    return {
      ...parsed,
      exercises: survivors,
      unresolved,
      warnings: [...new Set([
        ...survivors.flatMap(s => s.warnings || []),
        'unresolved_lines',
        'unresolved_lift',
      ])],
    };
  }

  // Any other intent (needs_clarification, small talk, etc.) is untouched.
  return parsed;
}

module.exports = { applyUnresolvedLiftGate };
