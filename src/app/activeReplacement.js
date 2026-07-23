/* Active-session exercise-REPLACEMENT proposal (production trust fix
 * FR-20260723031748-ux7ogmwp).
 *
 * A direct replacement command — "replace Back Squat with Bench Press", "remove back
 * squats and change it out for bench press", "swap squats for bench", "instead of squats,
 * bench" — is ONE atomic operation: source → replacement. It must NOT immediately delete
 * the source or silently activate the replacement. Instead it stages ONE proposal that the
 * athlete approves before the plan changes:
 *
 *   Before approval: the source stays in the plan; the replacement is not active.
 *   After approval:  the source is removed and the replacement takes its SAME position, once.
 *   Reject:          the plan is left exactly as it was.
 *
 * This module owns the PURE logic of that proposal — construction, the plan fingerprint that
 * detects a stale proposal, follow-up classification (approve / reject / query), and
 * prescription formatting. The proposal STATE lives in the store (getPendingReplacement /
 * setPendingReplacement); the actual in-plan mutation on approval reuses app.js's tested
 * applySessionSubstitution executor.
 *
 * PURE / UMD: no DOM, no I/O, no clock — unit-testable in Node, loadable in the browser.
 */
const _exports = (function () {
  'use strict';

  function normalize(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/[‘’ʼ′]/g, "'").trim();
  }
  function nameKey(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function numOrNull(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return null;
  }
  function slotName(e) {
    return (e && (e.canonicalName || e.name || e.exercise)) || null;
  }
  // Significant words of a lift name (≥4 chars) — "bench press" → ["bench","press"],
  // "back squat" → ["back","squat"] — for loose message matching.
  function significantWords(name) {
    return normalize(name).split(/\s+/).filter((w) => w.length >= 4);
  }

  // Index of the pending plan slot for `name` (exact key, else significant-word overlap).
  function findSlotIndex(exercises, name) {
    const list = Array.isArray(exercises) ? exercises : [];
    const key = nameKey(name);
    if (!key) return -1;
    let idx = list.findIndex((e) => nameKey(slotName(e)) === key);
    if (idx !== -1) return idx;
    const words = significantWords(name);
    if (!words.length) return -1;
    return list.findIndex((e) => {
      const sw = significantWords(slotName(e));
      return sw.length && words.some((w) => sw.includes(w));
    });
  }

  // A stable fingerprint of the plan's slot names in order. Any plan change (a skip, a
  // prior swap, a re-order) changes it, so a proposal built against an older plan is
  // detected as stale (isProposalFresh) rather than applied to the wrong slots.
  function planFingerprint(exercises) {
    return (Array.isArray(exercises) ? exercises : [])
      .map((e) => nameKey(slotName(e)))
      .filter(Boolean)
      .join('|');
  }

  // Build the ONE pending replacement proposal. Deterministic id (no clock) from the
  // source/replacement keys + the plan fingerprint, so the same proposal is idempotent
  // across re-taps/retries. Does NOT mutate anything.
  function buildReplacementProposal(params) {
    const p = params && typeof params === 'object' ? params : {};
    const src = p.source && typeof p.source === 'object' ? p.source : {};
    const rep = p.replacement && typeof p.replacement === 'object' ? p.replacement : {};
    const exercises = Array.isArray(p.planExercises) ? p.planExercises : [];
    const fp = planFingerprint(exercises);
    const sourceName = src.name || src.exercise || null;
    const weight = numOrNull(rep.weight);
    const replacement = {
      name: rep.name || rep.exercise || null,
      lift_code: rep.lift_code || rep.liftCode || null,
      weight,
      reps: numOrNull(rep.reps),
      sets: numOrNull(rep.sets),
      rir: rep.rir == null ? null : numOrNull(rep.rir),
      load_state: weight != null ? 'resolved' : 'unresolved',
    };
    return {
      proposal_id: `repl:${nameKey(sourceName)}->${nameKey(replacement.name)}@${fp}`,
      source: { name: sourceName, lift_code: src.lift_code || src.liftCode || null },
      replacement,
      position: findSlotIndex(exercises, sourceName),
      plan_fingerprint: fp,
      status: 'pending',
    };
  }

  // A proposal is fresh only if the plan is unchanged since it was built AND the source
  // slot is still present — otherwise it is stale (e.g. after a reload onto a different
  // plan, or the source already gone) and must be discarded, never applied.
  function isProposalFresh(proposal, exercises) {
    if (!proposal || typeof proposal !== 'object') return false;
    if (proposal.plan_fingerprint !== planFingerprint(exercises)) return false;
    return findSlotIndex(exercises, proposal.source && proposal.source.name) !== -1;
  }

  // Apply a proposal to a plan array PURELY (the semantic reference for the atomic
  // replacement; app.js's approval path reuses the tested applySessionSubstitution executor,
  // which has the same in-place-at-source-position semantics). Removes EXACTLY the source and
  // puts EXACTLY the replacement in the SAME position, leaving every other slot untouched.
  // Idempotent: if the source is already gone (approved twice), it applies nothing.
  function applyReplacement(exercises, proposal) {
    const list = Array.isArray(exercises) ? exercises.slice() : [];
    const p = proposal && typeof proposal === 'object' ? proposal : {};
    const idx = findSlotIndex(list, p.source && p.source.name);
    if (idx === -1) return { exercises: list, applied: false, index: -1 };
    const r = p.replacement || {};
    list[idx] = {
      name: r.name, canonicalName: r.name, liftCode: r.lift_code || '',
      weight: r.weight != null ? r.weight : null,
      reps: r.reps != null ? r.reps : null,
      sets: r.sets != null ? r.sets : null,
      rir: r.rir != null ? r.rir : null,
      reason: 'substituted',
    };
    return { exercises: list, applied: true, index: idx };
  }

  // The prescription line for the replacement, or null when no authoritative load resolved.
  function formatReplacementPrescription(replacement) {
    const r = replacement && typeof replacement === 'object' ? replacement : {};
    const parts = [];
    if (numOrNull(r.weight) != null) parts.push(`${numOrNull(r.weight)} lb`);
    if (numOrNull(r.reps) != null) parts.push(`${numOrNull(r.reps)} reps`);
    if (r.rir != null && numOrNull(r.rir) != null) parts.push(`@ ${numOrNull(r.rir)} RIR`);
    if (numOrNull(r.sets) != null) parts.push(`× ${numOrNull(r.sets)} sets`);
    return parts.length ? parts.join(' ') : null;
  }

  // The one-line proposal statement, e.g. "Replace Back Squat with Bench Press — 175 lb 9
  // reps @ 5 RIR × 3 sets." When no load resolved, it states that explicitly (never invents
  // a number).
  function formatProposalLine(proposal) {
    const p = proposal && typeof proposal === 'object' ? proposal : {};
    const src = (p.source && p.source.name) || 'that lift';
    const repName = (p.replacement && p.replacement.name) || 'the replacement';
    const rx = formatReplacementPrescription(p.replacement);
    return rx
      ? `Replace ${src} with ${repName} — ${rx}.`
      : `Replace ${src} with ${repName}. I don't have an authoritative load for ${repName} yet — tell me the weight and I'll set it.`;
  }

  // ── follow-up classification (relative to a pending proposal) ──────────────────

  function namesLift(text, liftName) {
    const m = normalize(text);
    const words = significantWords(liftName);
    return words.length > 0 && words.some((w) => new RegExp(`\\b${w}`).test(m));
  }

  const AFFIRM_RE = /^(?:yes|yep|yeah|yup|ya|sure|ok|okay|kk?|do it|let'?s do it|go(?: for it)?|sounds (?:good|great)|perfect|please do|confirm(?:ed)?|approve[d]?|accept(?:ed)?|agreed|that works|works for me|makes sense|good|great)\b/;
  const REJECT_RE = /^(?:no|nope|nah|na|cancel|never ?mind|forget it|nvm|no thanks|scratch that|leave it|stop|don'?t|do not|undo)\s*[.!]?$/;
  // A load / prescription question the pending proposal can answer directly.
  const QUERY_RE = /\bwhat weight\b|\bhow (?:much|heavy|light)\b|\bput on the bar\b|\bwhat(?:'?s| is)?\s+(?:the\s+)?(?:load|weight)\b|\bwhat am i (?:doing|lifting|supposed to (?:do|lift))\b|\bwhat(?:'?s| are)?\s+my\s+(?:sets?|reps?|weight|load|numbers)\b/;

  function isBareAffirmation(text) { return AFFIRM_RE.test(normalize(text)); }
  function isBareRejection(text) { return REJECT_RE.test(normalize(text)); }
  function isProposalQuery(text) { return QUERY_RE.test(normalize(text)); }

  // Classify a follow-up turn against the pending proposal:
  //   'approve' — affirm the replacement (names it, or a bare yes/ok/do-it). A leading "no"
  //               that still asks for the replacement ("no, let's do bench press") is an
  //               APPROVAL — it rejects Atlas's confusion, not the bench.
  //   'reject'  — a bare no/cancel, or explicitly keeping the SOURCE ("no, keep squats").
  //   'query'   — a weight/prescription question the proposal answers directly.
  //   null      — not a response to this proposal; keep it and route the message normally.
  function classifyFollowup(text, proposal) {
    if (!proposal || typeof proposal !== 'object' || !proposal.replacement) return null;
    const m = normalize(text);
    if (!m) return null;
    const replName = proposal.replacement.name;
    const srcName = proposal.source && proposal.source.name;
    const namesRepl = replName ? namesLift(m, replName) : false;
    const namesSrc = srcName ? namesLift(m, srcName) : false;

    // A load question about the replacement (or a bare one) is answered from the proposal.
    if (isProposalQuery(m) && !namesSrc) return 'query';
    // Explicitly keeping the source, or a bare rejection.
    if (namesSrc && !namesRepl && /\b(keep|stick with|stay with|leave|not|don'?t|rather|cancel)\b/.test(m)) return 'reject';
    if (isBareRejection(m)) return 'reject';
    // Affirm the replacement — by name, or a bare yes/ok.
    if (namesRepl) return 'approve';
    if (isBareAffirmation(m)) return 'approve';
    return null;
  }

  return {
    planFingerprint,
    findSlotIndex,
    buildReplacementProposal,
    isProposalFresh,
    applyReplacement,
    formatReplacementPrescription,
    formatProposalLine,
    namesLift,
    isBareAffirmation,
    isBareRejection,
    isProposalQuery,
    classifyFollowup,
  };
})();

export const {
  planFingerprint,
  findSlotIndex,
  buildReplacementProposal,
  isProposalFresh,
  applyReplacement,
  formatReplacementPrescription,
  formatProposalLine,
  namesLift,
  isBareAffirmation,
  isBareRejection,
  isProposalQuery,
  classifyFollowup,
} = _exports;
