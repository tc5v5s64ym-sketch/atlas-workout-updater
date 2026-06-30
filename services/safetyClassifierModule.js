'use strict';

// SafetyClassifierModule — composite safety classification engine.
// Combines SafetyRulesModule (traffic-light classifier, safe defaults)
// with active signal inputs to produce structured safety classifications.
// No Sheets access, no side effects, no LLM involvement.
//
// Prime directive: the engine computes the tier; the LLM only words the response.
// Safety override rule: red overrides yellow overrides green — most severe wins.
// Confidence inversion: low confidence about a possible red flag triggers more caution.

const {
  getTrafficLight,
  getTrafficLightState,
  getSafeDefaults,
} = require('./safetyRulesModule');

const SEVERITY = { red: 2, yellow: 1, green: 0 };

// Match an active signal string against the config signal list for one state.
// A match occurs when the active signal is a substring of a config signal,
// OR a config signal is a substring of the active signal (case-insensitive).
function _matchesAny(activeSignal, configSignals) {
  const lower = activeSignal.toLowerCase();
  return configSignals.some(cs => {
    const csLower = cs.toLowerCase();
    return lower.includes(csLower) || csLower.includes(lower);
  });
}

// Classify safety tier from an array of observed signal strings.
// Priority: red > yellow > green (most severe state wins).
// Signals that match no config entry go into unmatchedSignals and do not
// influence the state — but see notes below on confidence.
//
// activeSignals: string[] — observed signals (e.g. ["chest pain", "low readiness"])
//
// Returns:
// {
//   state: 'green' | 'yellow' | 'red',
//   meaning: string,
//   action: string,
//   matchedSignals: string[],
//   unmatchedSignals: string[],
//   confidence: 'none' | 'low' | 'moderate' | 'high'
// }
// or null for non-array input.
function classifyTrafficLight(activeSignals) {
  if (!Array.isArray(activeSignals)) return null;

  const trafficLight = getTrafficLight();
  let highestSeverity = -1;
  let resolvedState = null;
  const matchedSignals = [];
  const unmatchedSignals = [];

  for (const sig of activeSignals) {
    if (typeof sig !== 'string' || sig.trim() === '') continue;

    let matched = false;
    for (const tier of trafficLight) {
      if (_matchesAny(sig, tier.signals)) {
        matched = true;
        const sev = SEVERITY[tier.state] ?? 0;
        if (sev > highestSeverity) {
          highestSeverity = sev;
          resolvedState = tier.state;
        }
      }
    }

    if (matched) {
      matchedSignals.push(sig);
    } else {
      unmatchedSignals.push(sig);
    }
  }

  // No matches or empty input → default to green (normal coaching context).
  const state = resolvedState ?? 'green';
  const stateRecord = getTrafficLightState(state);

  const confidence =
    matchedSignals.length === 0 ? 'none' :
    matchedSignals.length === 1 ? 'low' :
    matchedSignals.length <= 3 ? 'moderate' : 'high';

  return {
    state,
    meaning: stateRecord.meaning,
    action: stateRecord.action,
    matchedSignals,
    unmatchedSignals,
    confidence,
  };
}

// Return a specific safe-default value by field name.
// Exposed fields: 'on_uncertainty' | 'never' | 'onboarding_screen' | 'confidence_inversion'
// Returns null for unknown, internal, or non-string field names.
const EXPOSED_DEFAULTS = new Set([
  'on_uncertainty',
  'never',
  'onboarding_screen',
  'confidence_inversion',
]);

function getSafeDefault(field) {
  if (typeof field !== 'string' || !EXPOSED_DEFAULTS.has(field)) return null;
  const defaults = getSafeDefaults();
  return defaults[field] ?? null;
}

module.exports = {
  classifyTrafficLight,
  getSafeDefault,
};
