'use strict';

// SafetyDecision — canonical contract (Phase 2 Work item 2; charter row in
// docs/CANONICAL_CONTRACTS.md).
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON.
// No LLM, no Sheets, no write path, no route.
//
// The single safety VERDICT consumed by the live route and the Brain alike:
// presentation may differ, the decision may not (finding H-12). One versioned
// verdict — a traffic-light `state` (green/yellow/red), whether it is `blocking`,
// the `confidence` in it, the matched `signals` that drove it, and a grounded
// `reason`. It names and versions the shape that today lives scattered across
// services/safetyClassifierModule.js (which resolves { state, confidence,
// matchedSignals, … } from config/coaching/rules/safety.rules.json) and the
// `safety: { level, flags, blocking }` sub-object embedded in a CoachingDecision.
// It is ratified read-only here and is NOT yet wired (hence its staged entry in
// config/wiring-allowlist.json); Phase 5d wires it as the most-conservative
// override and retires the duplicate classifiers.
//
// This module is the single OWNER of the safety-state vocabulary. The states are
// severity-ordered green < yellow < red. Safety is the most conservative layer
// and can override all others (safety.rules.json _meta) — encoded as validator
// rules: a `red` state MUST block; a `green` state MUST NOT block; a `yellow`
// state may or may not block (the confidence_inversion escalation is a Phase 5d
// concern, faithfully NOT invented here). `signals` are observed evidence
// (unique, non-empty strings), not a canonically ordered vocabulary.
//
// Public API:
//   buildSafetyDecision(params)      → verdict object (does NOT validate)
//   validateSafetyDecision(verdict)  → { valid, errors[] }  (total, never throws)
//   fromClassification(classification)→ canonical SafetyDecision from the live
//                                       services/safetyClassifierModule.js output
//   SCHEMA_VERSION, STATES, CONFIDENCE_LEVELS

const path = require('node:path');
const fs   = require('node:fs');

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'safety-decision.contract.json');

const SCHEMA_VERSION = 1;

let _contract = null;
function _loadContract() {
  if (!_contract) _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}
function _resetForTesting() { _contract = null; }

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// Dedupe a signal list to non-empty strings, unique under the SAME
// case/whitespace-insensitive key the validator uses, preserving order and each
// key's first-seen original casing. Keeps a well-formed but repetitive source
// (the classifier permits repeated observations) valid under the unique-signal rule.
function _dedupeSignals(list) {
  const seen = new Set();
  const out = [];
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!_isNonEmptyString(s)) continue;
    const key = s.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble a SafetyDecision. Stamps schema_version; defaults confidence to 'none'
 * (the most conservative tier), signals to [], and reason to null. `state` is NOT
 * invented — it passes through, so an unspecified state fails validation (fail
 * closed) rather than silently reading as green/proceed. `blocking` defaults to
 * the safe derivation `state === 'red'` when unspecified. Does NOT validate.
 */
function buildSafetyDecision(params) {
  const p = _isPlainObject(params) ? params : {};
  return {
    schema_version: SCHEMA_VERSION,
    state:          p.state,
    blocking:       typeof p.blocking === 'boolean' ? p.blocking : (p.state === 'red'),
    confidence:     p.confidence != null ? p.confidence : 'none',
    signals:        Array.isArray(p.signals) ? p.signals : [],
    reason:         p.reason != null ? p.reason : null,
  };
}

// ─── validator (total; never throws) ────────────────────────────────────────────

function validateSafetyDecision(verdict) {
  if (!_isPlainObject(verdict)) return { valid: false, errors: ['verdict: must be an object'] };

  let contract;
  try { contract = _loadContract(); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }
  const states = contract.states;
  const confidenceLevels = new Set(contract.confidence_levels);
  const mustBlock = new Set(contract.must_block_states);
  const mustNotBlock = new Set(contract.must_not_block_states);

  const errors = [];
  const _has = (k) => Object.prototype.hasOwnProperty.call(verdict, k);

  if (verdict.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  const stateKnown = states.includes(verdict.state);
  if (!stateKnown) errors.push(`state: must be one of ${states.join(', ')}`);

  // blocking: a boolean, and consistent with the safety ladder — a red state MUST
  // block (safety overrides all others), a green state MUST NOT block (proceed).
  // yellow may be either (a low-confidence yellow can escalate to blocking in
  // Phase 5d without a contract change).
  if (typeof verdict.blocking !== 'boolean') {
    errors.push('blocking: must be a boolean');
  } else if (stateKnown) {
    if (mustBlock.has(verdict.state) && verdict.blocking !== true) {
      errors.push(`blocking: state '${verdict.state}' must block (blocking must be true)`);
    }
    if (mustNotBlock.has(verdict.state) && verdict.blocking !== false) {
      errors.push(`blocking: state '${verdict.state}' must not block (blocking must be false)`);
    }
  }

  if (!confidenceLevels.has(verdict.confidence)) {
    errors.push(`confidence: must be one of ${contract.confidence_levels.join(', ')}`);
  }

  // signals: an array of unique, non-empty strings (observed evidence; order is
  // not significant, so no canonical-order check — only membership + uniqueness).
  if (!Array.isArray(verdict.signals)) {
    errors.push('signals: must be an array');
  } else {
    const seen = new Set();
    verdict.signals.forEach((s, i) => {
      if (!_isNonEmptyString(s)) { errors.push(`signals[${i}]: must be a non-empty string`); return; }
      const key = s.trim().toLowerCase();
      if (seen.has(key)) errors.push(`signals[${i}]: duplicate signal '${s}'`);
      seen.add(key);
    });
  }

  // reason follows the explicit-null rule: PRESENT as an own property whose value
  // is null (no grounded meaning) or a non-empty string. An omitted key or an
  // explicit undefined is rejected — a deserialized verdict cannot quietly drop it.
  if (!_has('reason')) errors.push('reason: must be present (null or a non-empty string)');
  else if (verdict.reason !== null && !_isNonEmptyString(verdict.reason)) errors.push('reason: must be a non-empty string or null');

  return { valid: errors.length === 0, errors };
}

// ─── boundary adapter: live classifier output → canonical SafetyDecision ─────────

// Convert the live classifier's output (services/safetyClassifierModule.js —
// `{ state, meaning, action, matchedSignals, unmatchedSignals, confidence }`)
// into a canonical, valid SafetyDecision. This is the single boundary Phase 5d
// crosses when the safety layer becomes the shared verdict:
//   state           → state
//   confidence      → confidence          (count-based tier: none|low|moderate|high)
//   matchedSignals  → signals             (the evidence that drove the tier, deduped —
//                                          the classifier permits repeated observations)
//   meaning         → reason (or null)    (grounded prose, never LLM-authored)
//   blocking is DERIVED as `state === 'red'` — the classifier carries no blocking
//   concept, so this contract supplies the minimal safe derivation and does NOT
//   invent the confidence_inversion escalation (a Phase 5d decision). Pure;
//   validates clean for any well-formed classification.
function fromClassification(classification) {
  const c = _isPlainObject(classification) ? classification : {};
  return buildSafetyDecision({
    state:      c.state,
    confidence: c.confidence,
    signals:    _dedupeSignals(c.matchedSignals),
    reason:     _isNonEmptyString(c.meaning) ? c.meaning : null,
    blocking:   c.state === 'red',
  });
}

module.exports = {
  SCHEMA_VERSION,
  buildSafetyDecision,
  validateSafetyDecision,
  fromClassification,
  get STATES() { return [..._loadContract().states]; },
  get CONFIDENCE_LEVELS() { return [..._loadContract().confidence_levels]; },
  _resetForTesting,
};
