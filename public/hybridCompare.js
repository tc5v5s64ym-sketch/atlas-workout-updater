/* Hybrid Coach Compare v1 — pure helpers shared between the Settings → Debug
 * "Hybrid Coach Compare (dev)" panel (browser) and the Node test suite. UMD
 * wrapper: exports in Node, sets window.hybridCompare in the browser.
 *
 * Developer-only evaluation tooling. No DOM, no Sheets, no fetch — these
 * functions only read an already-fetched /api/recommend/next response and
 * (optionally) write to an injected storage object. They never mutate the
 * recommendation and never touch the write/proof/trust-loop path.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'atlas_hybrid_compare_v1';
  const MAX_STORED_ENTRIES = 200;
  const MAX_NOTE_LENGTH = 500;
  const PREFERENCES = ['legacy', 'brian', 'neither'];

  function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

  // The compare card is dev/hybrid-only: it must never appear unless the
  // engine is explicitly in hybrid mode AND the response actually carries a
  // validated Brian decision (index.js only attaches recommendation.brian
  // when ATLAS_COACH_ENGINE==='hybrid' and validateCoachingDecision passed).
  // Gating on both is deliberate belt-and-suspenders, not redundant: it keeps
  // the card off even if one of the two signals is ever wrong in isolation.
  function shouldShowCompareCard(coachEngineMode, recommendation) {
    return coachEngineMode === 'hybrid' && _isObj(recommendation) && _isObj(recommendation.brian);
  }

  // Legacy (analytics.js) summary — the same fields the production coach
  // plan card already reads (recommendation, reasoning, next_target,
  // target_rir). Read-only projection; never touches the source object.
  function summarizeLegacy(recommendation) {
    const r = _isObj(recommendation) ? recommendation : {};
    const nt = _isObj(r.next_target) ? r.next_target : null;
    return {
      verdict: typeof r.recommendation === 'string' ? r.recommendation : null,
      reasoning: typeof r.reasoning === 'string' ? r.reasoning : null,
      target_weight: nt && typeof nt.weight === 'number' ? nt.weight : null,
      target_reps: nt && typeof nt.reps === 'number' ? nt.reps : null,
      target_sets: nt && typeof nt.sets === 'number' ? nt.sets : null,
      target_rir: typeof r.target_rir === 'number' ? r.target_rir : null
    };
  }

  // Brian (One-Brain orchestrator) summary — projects the CoachingDecision
  // attached at recommendation.brian. Returns null when absent so the card
  // logic can stay a simple truthiness check.
  function summarizeBrian(recommendation) {
    const b = _isObj(recommendation) && _isObj(recommendation.brian) ? recommendation.brian : null;
    if (!b) return null;
    const payload = _isObj(b.payload) ? b.payload : {};
    const confidence = _isObj(b.confidence) ? b.confidence : {};
    const safety = _isObj(b.safety) ? b.safety : {};
    return {
      decision_type: typeof b.decision_type === 'string' ? b.decision_type : null,
      status: typeof b.status === 'string' ? b.status : null,
      action: typeof payload.action === 'string' ? payload.action : null,
      target_weight: typeof payload.target_weight === 'number' ? payload.target_weight : null,
      target_reps: typeof payload.target_reps === 'number' ? payload.target_reps : null,
      rationale: typeof payload.rationale === 'string' ? payload.rationale : null,
      confidence_tier: typeof confidence.tier === 'string' ? confidence.tier : null,
      confidence_action: typeof confidence.action === 'string' ? confidence.action : null,
      safety_level: typeof safety.level === 'string' ? safety.level : null
    };
  }

  // Build one comparison-feedback entry. Pure — throws on an invalid
  // preference rather than silently coercing it, so a UI bug fails loudly
  // instead of writing junk into storage.
  function buildComparisonEntry(params) {
    const p = _isObj(params) ? params : {};
    if (!PREFERENCES.includes(p.preference)) {
      throw new Error(`preference must be one of ${PREFERENCES.join(', ')}`);
    }
    const note = typeof p.note === 'string' ? p.note.trim().slice(0, MAX_NOTE_LENGTH) : '';
    return {
      timestamp: typeof p.timestamp === 'string' ? p.timestamp : null,
      liftCode: typeof p.liftCode === 'string' ? p.liftCode : null,
      preference: p.preference,
      note,
      legacy: summarizeLegacy(p.recommendation),
      brian: summarizeBrian(p.recommendation)
    };
  }

  // storage: an injected Storage-like object ({getItem, setItem}) — real
  // localStorage in the browser, a plain fake in tests. Never throws on a
  // corrupt/missing value; degrades to an empty list instead.
  function loadComparisons(storage) {
    if (!storage || typeof storage.getItem !== 'function') return [];
    try {
      const raw = storage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  // Appends one entry, capped to the most recent MAX_STORED_ENTRIES so the
  // dev-only log can't grow unbounded. Returns the updated list.
  function saveComparisonEntry(storage, entry) {
    const list = loadComparisons(storage);
    list.push(entry);
    const capped = list.slice(-MAX_STORED_ENTRIES);
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(STORAGE_KEY, JSON.stringify(capped));
    }
    return capped;
  }

  const exported = {
    STORAGE_KEY,
    MAX_STORED_ENTRIES,
    MAX_NOTE_LENGTH,
    PREFERENCES,
    shouldShowCompareCard,
    summarizeLegacy,
    summarizeBrian,
    buildComparisonEntry,
    loadComparisons,
    saveComparisonEntry
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.hybridCompare = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
