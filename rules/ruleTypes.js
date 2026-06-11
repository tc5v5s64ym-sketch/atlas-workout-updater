'use strict';

// Shared rule-decision shape — treat as a frozen interface.
// Every rule returns this shape (or null when the rule does not apply).
// Consumed by API responses, preview rule_flags, and (later) the AI coaching layer.

const DECISION_TYPES = Object.freeze(['hold', 'load', 'build_reps', 'deload', 'no_data', 'caution', 'reject']);
const SEVERITY_TYPES = Object.freeze(['info', 'warning', 'error']);

function decision(opts) {
  const {
    decision: dec,
    rule_id,
    severity = 'info',
    reasoning,
    criterion_progress = null,  // e.g. "2 of 3 sessions met"
    lift_code = null,
  } = opts;

  if (!DECISION_TYPES.includes(dec)) throw new Error(`Invalid decision type: ${dec}`);
  if (!SEVERITY_TYPES.includes(severity)) throw new Error(`Invalid severity: ${severity}`);
  if (!rule_id) throw new Error('rule_id is required');
  if (!reasoning) throw new Error('reasoning is required');

  return { decision: dec, rule_id, severity, reasoning, criterion_progress, lift_code };
}

module.exports = { decision, DECISION_TYPES, SEVERITY_TYPES };
