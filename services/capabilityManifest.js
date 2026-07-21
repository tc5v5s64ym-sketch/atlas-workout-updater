'use strict';

// CapabilityManifest — contract #2 of the One-Brain coaching engine.
//
// Pure / deterministic. The ONLY thing this module imports is node:path + node:fs
// + the two declarative JSON manifests. It imports NO Brain decision module — the
// routing layer must hold no coaching rule (the "orchestrator-is-rule-free"
// guarantee; pinned by test/capabilityManifest.test.js). The Coach Orchestrator
// reads this to turn an intent into an ordered module run.
//
// Spec: docs/COACHING_CONTRACTS_SPEC.md §2
// Architecture: docs/COACHING_ENGINE_ARCHITECTURE.md
//
// Public API:
//   validateManifest()        → { valid, errors[] }  — referential integrity + acyclicity
//   resolve(intentType)       → resolution | null    — closure + topo-ordered capabilities
//   listIntents()             → string[]
//   getCapability(id)         → descriptor | null
//   getIntent(type)           → intent entry | null
//   DECISION_TYPES, INPUT_KEYS

const path = require('node:path');
const fs   = require('node:fs');

const MANIFEST_DIR = path.join(__dirname, '..', 'config', 'coaching', 'manifests');
const INTENTS_FILE = path.join(MANIFEST_DIR, 'intent-capabilities.json');
const CAPS_FILE    = path.join(MANIFEST_DIR, 'capabilities.json');

const SCHEMA_VERSION = 1;

// The completion ladder (Phase 2 Work item 3; H-05/H-15). Ordered low→high. A
// capability's honesty is this nine-rung ladder, NOT a single self-declared
// status. The ladder is monotonic: a higher rung may not be true while a lower
// rung is false. Rung definitions + the published assessment live in
// docs/CAPABILITY_COMPLETION_LADDER.md.
const LADDER_RUNGS = Object.freeze([
  'built', 'unit_tested', 'runner_wired', 'inputs_available',
  'route_consumed', 'user_visible', 'validator_covered', 'live_proven', 'owner_accepted',
]);
// The first rung at/above which a capability must name the live consumer that
// consumes it (owner ruling 2026-07-20: "nothing claims route-consumed or higher
// without naming its consumer").
const CONSUMER_REQUIRED_FROM = LADDER_RUNGS.indexOf('route_consumed');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  const intents = JSON.parse(fs.readFileSync(INTENTS_FILE, 'utf8'));
  const caps    = JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8'));
  _cache = Object.freeze({
    intents:        Object.freeze(intents.intents),
    capabilities:   Object.freeze(caps.capabilities),
    inputKeys:      Object.freeze(new Set(caps.input_keys)),
    decisionTypes:  Object.freeze(new Set(intents.decision_types)),
    raw:            Object.freeze({ intents, caps }),
  });
  return _cache;
}

function _resetForTesting() { _cache = null; }

// ─── lookups ──────────────────────────────────────────────────────────────────

function listIntents() { return Object.keys(_load().intents); }
function getCapability(id) { return _load().capabilities[id] || null; }
function getIntent(type) { return _load().intents[type] || null; }

// ─── validation (referential integrity + acyclicity) ──────────────────────────

/**
 * Validate the whole manifest: every referenced capability resolves, every
 * depends_on resolves, requires/optional draw from input_keys, decision_types
 * are legal, read-only intents map to progress_readout, and the global
 * dependency graph is acyclic.
 * Total / pure: { valid, errors[] }, never throws.
 */
function validateManifest() {
  const errors = [];
  let m;
  try { m = _load(); }
  catch (e) { return { valid: false, errors: [`manifest load failed: ${e.message}`] }; }

  const capIds = new Set(Object.keys(m.capabilities));

  // ── capability descriptors ──
  for (const [id, cap] of Object.entries(m.capabilities)) {
    for (const field of ['requires', 'optional', 'depends_on', 'produces']) {
      if (!Array.isArray(cap[field])) errors.push(`capability '${id}': ${field} must be an array`);
    }
    if (!cap.module || typeof cap.module.file !== 'string' || typeof cap.module.export !== 'string') {
      errors.push(`capability '${id}': module must be { file, export }`);
    }
    _validateLadder(id, cap, errors);
    // requires/optional must be input keys (NOT produces — produces is its own namespace)
    for (const k of [...(cap.requires || []), ...(cap.optional || [])]) {
      if (!m.inputKeys.has(k)) errors.push(`capability '${id}': input key '${k}' not in input_keys vocabulary`);
    }
    // depends_on must resolve to a capability
    for (const dep of cap.depends_on || []) {
      if (!capIds.has(dep)) errors.push(`capability '${id}': depends_on '${dep}' does not resolve`);
    }
  }

  // ── acyclicity (global) ──
  const cycle = _findCycle(m.capabilities);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' → ')}`);

  // ── intent entries ──
  for (const [type, intent] of Object.entries(m.intents)) {
    if (!Array.isArray(intent.capabilities)) {
      errors.push(`intent '${type}': capabilities must be an array`);
      continue;
    }
    for (const id of intent.capabilities) {
      if (!capIds.has(id)) errors.push(`intent '${type}': capability '${id}' does not resolve`);
    }
    if (intent.brain === false) {
      if (typeof intent.routes_to !== 'string') {
        errors.push(`intent '${type}': brain:false requires routes_to`);
      }
    } else {
      if (!m.decisionTypes.has(intent.decision_type)) {
        errors.push(`intent '${type}': decision_type must be one of ${[...m.decisionTypes].join(', ')}`);
      }
      if (intent.read_only === true && intent.decision_type !== 'progress_readout') {
        errors.push(`intent '${type}': read_only intents must yield decision_type 'progress_readout'`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Validate one capability's completion ladder: all nine rungs present as
// booleans, monotonic (no true rung above a false rung), and — at route_consumed
// or higher — a named consumer. The linked-evidence requirement for
// route_consumed/live_proven is Drift Guard 4's job (scripts/check-completion-ladder.js),
// kept out of the pure in-code validator so the runtime reader stays I/O-free.
function _validateLadder(id, cap, errors) {
  const l = cap && cap.ladder;
  if (!l || typeof l !== 'object' || Array.isArray(l)) {
    errors.push(`capability '${id}': ladder must be an object with the nine completion rungs`);
    return;
  }
  for (const rung of LADDER_RUNGS) {
    if (typeof l[rung] !== 'boolean') {
      errors.push(`capability '${id}': ladder.${rung} must be a boolean`);
    }
  }
  // Monotonic ladder: a higher rung true requires the rung directly below it true.
  for (let i = 1; i < LADDER_RUNGS.length; i++) {
    if (l[LADDER_RUNGS[i]] === true && l[LADDER_RUNGS[i - 1]] === false) {
      errors.push(`capability '${id}': ladder is non-monotonic — '${LADDER_RUNGS[i]}' is true but '${LADDER_RUNGS[i - 1]}' is false`);
    }
  }
  // Name the consumer at route_consumed or higher.
  const claimsConsumption = LADDER_RUNGS.slice(CONSUMER_REQUIRED_FROM).some(r => l[r] === true);
  if (claimsConsumption && !(typeof cap.consumer === 'string' && cap.consumer.trim())) {
    errors.push(`capability '${id}': claims route_consumed or higher but names no 'consumer'`);
  }
}

// DFS cycle finder over the depends_on graph. Returns a cycle path or null.
function _findCycle(capabilities) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  const stack = [];
  for (const id of Object.keys(capabilities)) color[id] = WHITE;

  function visit(id) {
    color[id] = GRAY;
    stack.push(id);
    for (const dep of (capabilities[id] && capabilities[id].depends_on) || []) {
      if (!(dep in color)) continue; // unresolved dep — reported separately
      if (color[dep] === GRAY) {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (color[dep] === WHITE) {
        const c = visit(dep);
        if (c) return c;
      }
    }
    stack.pop();
    color[id] = BLACK;
    return null;
  }

  for (const id of Object.keys(capabilities)) {
    if (color[id] === WHITE) {
      const c = visit(id);
      if (c) return c;
    }
  }
  return null;
}

// ─── resolve: closure + topological order ─────────────────────────────────────

/**
 * Resolve an intent to its ordered capability run.
 * Computes the transitive depends_on closure of the intent's requested
 * capabilities, then returns them in dependency order (a capability always
 * appears after everything it depends on).
 *
 * Returns null for an unknown intent type.
 * Returns:
 *   {
 *     intent, brain, read_only,
 *     decision_type | null, routes_to | null,
 *     requested: string[],            // top-level capabilities named by the intent
 *     order: descriptor[],            // topologically ordered (with id + ladder)
 *     missing: string[],              // ids whose ladder.built === false (skip-with-flag)
 *   }
 */
function resolve(intentType) {
  const m = _load();
  const intent = m.intents[intentType];
  if (!intent) return null;

  const requested = Array.isArray(intent.capabilities) ? intent.capabilities : [];

  // transitive closure over depends_on
  const closure = new Set();
  const stackArr = [...requested];
  while (stackArr.length) {
    const id = stackArr.pop();
    if (closure.has(id)) continue;
    const cap = m.capabilities[id];
    if (!cap) continue; // unresolved — validateManifest reports it
    closure.add(id);
    for (const dep of cap.depends_on || []) stackArr.push(dep);
  }

  // Kahn topological sort restricted to the closure subgraph
  const inClosure = id => closure.has(id);
  const indegree = {};
  for (const id of closure) indegree[id] = 0;
  for (const id of closure) {
    for (const dep of m.capabilities[id].depends_on || []) {
      if (inClosure(dep)) indegree[id]++;
    }
  }
  // ready = no unmet deps; process in stable (sorted) order for determinism
  const ready = [...closure].filter(id => indegree[id] === 0).sort();
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    // decrement dependents
    for (const other of closure) {
      const deps = m.capabilities[other].depends_on || [];
      if (deps.includes(id) && inClosure(other)) {
        indegree[other]--;
        if (indegree[other] === 0) {
          ready.push(other);
          ready.sort();
        }
      }
    }
  }

  const descriptors = order.map(id => ({ id, ...m.capabilities[id] }));
  // "missing" = not built (ladder.built === false). This is the skip-with-flag
  // signal the retired status:'missing' used to carry; the runtime meaning is
  // unchanged (the Orchestrator skips it, never drops it).
  const missing = descriptors.filter(d => !(d.ladder && d.ladder.built === true)).map(d => d.id);

  return {
    intent:        intentType,
    brain:         intent.brain !== false,
    read_only:     intent.read_only === true,
    decision_type: intent.brain === false ? null : (intent.decision_type || null),
    routes_to:     intent.routes_to || null,
    requested,
    order:         descriptors,
    missing,
  };
}

module.exports = {
  SCHEMA_VERSION,
  LADDER_RUNGS,
  validateManifest,
  resolve,
  listIntents,
  getCapability,
  getIntent,
  get DECISION_TYPES() { return [..._load().decisionTypes]; },
  get INPUT_KEYS() { return [..._load().inputKeys]; },
  _resetForTesting,
};
