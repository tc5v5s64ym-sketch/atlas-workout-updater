'use strict';

// ── Evidence provenance (Soul Plan GATE A / PR-GATEA1) ───────────────────────
//
// GATE A (docs/ONE_BRAIN_PROMOTION_CRITERIA.md §3) requires a floor of genuine
// real-athlete recommendation events before a Brain decision type may be
// promoted. The owner's live review found the shadow window contaminated: the
// Brain's numbers pass tolerance (852/852 comparable progression decisions in
// band, zero errors), but the same window mixes real athlete activity with
// automated probes, simulations, canaries, Playwright, and repeated smoke
// traffic — and the rows carried no provenance to tell them apart. So the floor
// could not be counted, and progression stays EXTEND on evidence quality, not
// engine quality.
//
// This module classifies every shadow event DETERMINISTICALLY into one of three
// frozen classes and marks whether it may count toward the promotion floor. It
// is TELEMETRY-ONLY: the classification is attached to Brain_Shadow / Intent_Shadow
// diagnostic rows and NEVER touches a served coaching response.
//
// Design principle — FAIL CLOSED: only a request positively identified as genuine
// athlete-UI activity, in production, not in test mode, is `evidence_eligible`.
// Everything else — synthetic sources and anything unproven — is ineligible and
// can never inflate the promotion count. Classification depends ONLY on
// {test_mode, request_origin, production_runtime}; it is never inferred from
// traffic volume or timestamp patterns.

const EVIDENCE_CLASSES = Object.freeze({
  ATHLETE_UI: 'athlete_ui', // positively identified genuine athlete UI activity
  SYNTHETIC: 'synthetic',   // test_mode, or a known automated source (CI/Playwright/sim/canary/smoke/probe/local)
  UNKNOWN: 'unknown',       // untagged/direct API, missing or malformed provenance — fail closed
});

const VALID_CLASSES = Object.freeze(new Set(Object.values(EVIDENCE_CLASSES)));

// The single positive marker the REAL athlete UI attaches to its coach-engine /
// chat requests (via the client request seam). Nothing else sets it.
const ATHLETE_UI_ORIGIN = 'athlete_ui';

// Origin tokens a synthetic source declares about itself. Marking a source keeps
// its rows classified `synthetic` (auditable) rather than falling to `unknown`;
// either way it is ineligible, but a labelled row is clearer evidence.
const SYNTHETIC_ORIGINS = Object.freeze(new Set([
  'test', 'test_mode',
  'ci', 'playwright', 'e2e',
  'sim', 'simulation', 'replay',
  'canary', 'probe', 'smoke', 'script', 'seed',
]));

// Every origin token that is safe to persist verbatim. Anything else is collapsed
// to a fixed reason token — an attacker-controlled `x-atlas-request-origin` header
// (or any free text) can NEVER write arbitrary content, a secret, or a request
// body into a shadow row. request_origin is always one of these bounded tokens.
const KNOWN_ORIGINS = Object.freeze(new Set([ATHLETE_UI_ORIGIN, ...SYNTHETIC_ORIGINS]));

function _normOrigin(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// A safe, bounded origin token: the raw origin only if it is a recognized token,
// otherwise the caller's fixed fallback reason. Never returns free text.
function _safeOrigin(origin, fallback) {
  return origin && KNOWN_ORIGINS.has(origin) ? origin : fallback;
}

function _verdict(evidence_class, request_origin) {
  return {
    evidence_class,
    evidence_eligible: evidence_class === EVIDENCE_CLASSES.ATHLETE_UI,
    request_origin: request_origin || null,
  };
}

// classifyEvidence({ testMode, requestOrigin, productionRuntime }) →
//   { evidence_class, evidence_eligible, request_origin }
//
// Precedence (each rule from docs/ONE_BRAIN_PROMOTION_CRITERIA.md §3 / PR-GATEA1).
// `productionRuntime` is a DEFINITE boolean the server computes from its own runtime
// (NODE_ENV / CI) — `true` = known production, `false` = known non-production, and a
// missing / non-boolean value means "could not determine" and fails closed to unknown.
//   1. test_mode:true             → synthetic (always; outranks any origin claim)
//   2. a known synthetic origin   → synthetic (CI/Playwright/sim/canary/smoke/probe/…)
//   3. known non-production runtime→ synthetic (local/CI/Playwright servers, even if the
//                                     request claims athlete_ui — an E2E run driving the
//                                     real UI must never count)
//   4. athlete_ui + known prod + VERIFIED first-party browser provenance
//                                  → athlete_ui, ELIGIBLE (the only eligible path;
//                                    the marker alone is a client claim, not proof)
//   5. everything else             → unknown (untagged API / a bare marker with no
//                                     browser provenance / missing / malformed /
//                                     indeterminate runtime) — fail closed
function classifyEvidence(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const origin = _normOrigin(src.requestOrigin);

  // Rule 1 — test mode is always synthetic, regardless of everything else.
  if (src.testMode === true) return _verdict(EVIDENCE_CLASSES.SYNTHETIC, _safeOrigin(origin, 'test_mode'));

  // Rule 2 — a self-declared synthetic source.
  if (origin && SYNTHETIC_ORIGINS.has(origin)) return _verdict(EVIDENCE_CLASSES.SYNTHETIC, origin);

  // Rule 3 — a KNOWN non-production runtime (local/CI/Playwright). Overrides an
  // athlete_ui claim so a real-UI-driven E2E run can never count.
  if (src.productionRuntime === false) return _verdict(EVIDENCE_CLASSES.SYNTHETIC, _safeOrigin(origin, 'non_production_runtime'));

  // Rule 4 — positively identified genuine athlete UI: the first-party marker in
  // KNOWN production, not test, AND with VERIFIED first-party browser provenance
  // (src.firstPartyBrowser). The marker alone is only a client CLAIM — a script or a
  // direct API call can set it — so eligibility requires the browser signal to agree.
  if (src.productionRuntime === true && origin === ATHLETE_UI_ORIGIN && src.firstPartyBrowser === true) {
    return _verdict(EVIDENCE_CLASSES.ATHLETE_UI, ATHLETE_UI_ORIGIN);
  }

  // Rule 5 — untagged / unrecognized / missing / malformed / indeterminate, OR an
  // athlete_ui claim without verified first-party browser provenance → fail closed.
  // An unrecognized origin is recorded as the fixed token 'other' (never the raw
  // header text), so no arbitrary content can reach the row.
  return _verdict(EVIDENCE_CLASSES.UNKNOWN, origin ? _safeOrigin(origin, 'other') : 'missing');
}

// Read a stored evidence_class cell back to a valid class, defaulting to unknown.
// This is how OLD rows (no evidence_class column) and any malformed cell classify:
// unknown, never eligible.
function normalizeEvidenceClass(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VALID_CLASSES.has(v) ? v : EVIDENCE_CLASSES.UNKNOWN;
}

// Only athlete_ui counts toward the GATE A floor.
function isEvidenceEligible(evidenceClass) {
  return normalizeEvidenceClass(evidenceClass) === EVIDENCE_CLASSES.ATHLETE_UI;
}

// The fixed reason tokens the classifier may emit alongside the origin vocabulary.
const REASON_ORIGINS = Object.freeze(new Set(['test_mode', 'non_production_runtime', 'other', 'missing']));
const SAFE_ORIGIN_TOKENS = Object.freeze(new Set([...KNOWN_ORIGINS, ...REASON_ORIGINS]));

// Bound a request_origin to a known-safe token before it is persisted — a
// recorder's defense-in-depth against a directly-injected raw value (never the
// classifier's own output, which is already bounded). Unrecognized → 'other';
// empty → null. Guarantees no arbitrary content / secret reaches a shadow cell.
function normalizeRequestOrigin(value) {
  const v = _normOrigin(value);
  if (!v) return null;
  return SAFE_ORIGIN_TOKENS.has(v) ? v : 'other';
}

// ── Server-side adapters ─────────────────────────────────────────────────────
// The pure classifier above owns the rules; these read the actual request/runtime
// signals and hand them to it. Kept here so all shadow call sites classify identically.

function _truthyFlag(v) {
  if (v === true) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'on' || s === 'yes';
  }
  return false;
}

// Extract a bare hostname from an Origin/Referer URL or a Host header. Returns a
// bounded lowercase hostname (letters/digits/dots/hyphens) or '' — NEVER the full
// URL, path, port, or any other raw header content. Used only for an in-memory
// same-host comparison; nothing derived here is persisted.
function _hostOf(value) {
  if (typeof value !== 'string' || !value) return '';
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) {
    try { return new URL(v).hostname.toLowerCase(); } catch (_) { return ''; }
  }
  const hostPart = v.split('/')[0].split(':')[0].trim().toLowerCase();
  return /^[a-z0-9.-]+$/.test(hostPart) ? hostPart : '';
}

// Deterministic FIRST-PARTY browser provenance — honest exclusion of known automated
// and direct-API traffic, NOT cryptographic user attestation. True only when the
// request carries browser-enforced same-origin fetch metadata (`Sec-Fetch-Site:
// same-origin`, which page JavaScript cannot set — a fetch/XHR from a script omits
// it, and a cross-site request reads `cross-site`) AND any PRESENT Origin/Referer
// host matches the request host. Missing, cross-site, contradictory, or malformed
// provenance → false (fail closed). A determined non-browser client can still forge
// these headers; this raises the bar past scripts, direct API calls, cross-site
// callers, and (via the client webdriver marker) browser automation — it is not an
// identity system.
function isFirstPartyBrowser(sig) {
  const s = (sig && typeof sig === 'object') ? sig : {};
  const site = typeof s.secFetchSite === 'string' ? s.secFetchSite.trim().toLowerCase() : '';
  if (site !== 'same-origin') return false;
  const host = typeof s.requestHost === 'string' ? s.requestHost.trim().toLowerCase() : '';
  const oh = typeof s.originHost === 'string' ? s.originHost.trim().toLowerCase() : '';
  const rh = typeof s.refererHost === 'string' ? s.refererHost.trim().toLowerCase() : '';
  // A present Origin/Referer host must agree with the request host; if we cannot
  // establish the request host to compare against, fail closed.
  if (oh && (!host || oh !== host)) return false;
  if (rh && (!host || rh !== host)) return false;
  return true;
}

// Known production ONLY when NODE_ENV is 'production' AND the workbook is not the
// sandbox sheet. A definite boolean — a sandbox/staging deploy or any non-prod
// NODE_ENV is not production athlete traffic.
function isProductionRuntime({ nodeEnv, isSandboxSheet } = {}) {
  return nodeEnv === 'production' && isSandboxSheet !== true;
}

// Fold the raw request signals into a classifier verdict. A truthy simulation
// marker (x-atlas-simulation, the existing sim-harness/isolation header) always
// wins → synthetic. Pure; testable with plain values.
function classifyRequestSignals({ originHeader, simulationHeader, productionRuntime, testMode, firstPartyBrowser } = {}) {
  const simulated = _truthyFlag(simulationHeader);
  const requestOrigin = simulated ? 'sim' : (typeof originHeader === 'string' ? originHeader : null);
  return classifyEvidence({
    testMode: testMode === true,
    requestOrigin,
    productionRuntime: productionRuntime === true,
    firstPartyBrowser: firstPartyBrowser === true,
  });
}

// Express adapter: read the provenance signals off a request + runtime env and
// classify. Best-effort + TOTAL — never throws (a shadow-side helper must never
// surface an error to a coach-engine route). `bodyOrigin` lets the intent-observe
// POST (which bypasses the api.js header seam) pass its marker from the body.
// Returns { evidence_class, evidence_eligible, request_origin }.
function evidenceForRequest(req, { bodyOrigin } = {}) {
  try {
    const get = (h) => {
      if (req && typeof req.get === 'function') return req.get(h);
      if (req && req.headers && typeof req.headers === 'object') return req.headers[h];
      return undefined;
    };
    let isSandboxSheet = false;
    try { isSandboxSheet = require('../sheets').getSafeSpreadsheetConfig().isSandboxSheet === true; }
    catch (_) { /* best-effort: if the sheet config can't be read, fall back to NODE_ENV alone */ }
    const originHeader = (typeof bodyOrigin === 'string' && bodyOrigin) ? bodyOrigin : get('x-atlas-request-origin');
    // test_mode is the write-path's live-vs-dry-run flag (CLAUDE.md). The shadowed
    // routes don't normally carry it, but if a request DOES (query or body), honor
    // rule 1 on the live path — a test_mode:true request is synthetic even if it
    // also claims athlete_ui, closing the contract-vs-wiring gap.
    const q = req && req.query && typeof req.query === 'object' ? req.query.test_mode : undefined;
    const b = req && req.body && typeof req.body === 'object' ? req.body.test_mode : undefined;
    // First-party browser provenance from browser-enforced fetch metadata + a
    // same-host Origin/Referer check. Only bounded hostnames/booleans are derived;
    // no raw Origin/Referer/Host/UA/URL is kept or passed onward.
    const requestHost = _hostOf(get('x-forwarded-host') || get('host'));
    const firstPartyBrowser = isFirstPartyBrowser({
      secFetchSite: get('sec-fetch-site'),
      originHost: _hostOf(get('origin')),
      refererHost: _hostOf(get('referer') || get('referrer')),
      requestHost,
    });
    return classifyRequestSignals({
      originHeader,
      simulationHeader: get('x-atlas-simulation'),
      productionRuntime: isProductionRuntime({ nodeEnv: process.env.NODE_ENV, isSandboxSheet }),
      testMode: _truthyFlag(q) || _truthyFlag(b),
      firstPartyBrowser,
    });
  } catch (_) {
    // Fail closed on any unexpected error — unknown, ineligible, no raw content.
    return { evidence_class: EVIDENCE_CLASSES.UNKNOWN, evidence_eligible: false, request_origin: 'missing' };
  }
}

module.exports = {
  EVIDENCE_CLASSES,
  ATHLETE_UI_ORIGIN,
  SYNTHETIC_ORIGINS,
  classifyEvidence,
  normalizeEvidenceClass,
  normalizeRequestOrigin,
  isEvidenceEligible,
  isProductionRuntime,
  isFirstPartyBrowser,
  classifyRequestSignals,
  evidenceForRequest,
};
