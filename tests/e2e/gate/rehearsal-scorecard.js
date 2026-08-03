'use strict';

// ── F-SB4B rehearsal-session scorecard (TEMPORARY; sunset: F-SB4C) ──────────────
// Adapted from the proven Stage A scorecard (stage-a-canary-scorecard.js, sunset PR
// #1234) under the owner resolution recorded in docs/ATLAS_V1_EXECUTION_PLAN.md.
//
// Scores ONE rehearsal run against the FROZEN condition list below — the F-SB4 card's
// 25 common scorecard items made mechanical. Pure and deterministic: no clock, network,
// filesystem, Sheets, or environment access — the caller collects observations, this
// module decides what they prove.
//
// `rehearsal_eligible` is the single published field that decides whether a run may
// advance the rehearsal streak. Nothing else in the repository may grant credit.
//
// Four statuses, no fifth; missing evidence is ERROR, never PASS and never FAIL.
// NOT_APPLICABLE is legal ONLY where a scenario's declared expectation makes a
// condition genuinely outside the session (e.g. Session 4 declares no Effort data, so
// the Effort-row condition asserts ABSENCE rather than going N/A — there is no
// owner-authorized N/A in this rehearsal: "No authorized N/A may hide a seam this
// rehearsal is intended to test"). The frozen list is the point: every condition is
// always emitted, and removing an assertion turns the run RED rather than quietly
// shrinking the bar.

const {
  REHEARSAL_SESSION, REHEARSAL_STREAK_LENGTH,
  normalizePurpose, isRehearsalSessionNumber,
  workoutIdentityRefusal, runIdentityRefusal,
} = require('./rehearsal-run-purpose');

const PASS = 'PASS';
const FAIL = 'FAIL';
const ERROR = 'ERROR';
const NOT_APPLICABLE = 'NOT_APPLICABLE';

const pass = (detail) => ({ status: PASS, detail });
const fail = (detail) => ({ status: FAIL, detail });
const err = (detail) => ({ status: ERROR, detail });
const missing = (what) => err(`no evidence recorded for ${what}`);

const isBool = (v) => v === true || v === false;
const arr = (v) => (Array.isArray(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

const SHA_RE = /^[0-9a-f]{40}$/;

// Sheets string/number ambiguity ('225' vs 225) without treating '' as 0.
function cellEquals(cell, expected) {
  const raw = cell == null ? '' : String(cell).trim();
  if (raw === '') return false;
  if (typeof expected === 'number') return Number(raw) === expected;
  return raw.toLowerCase() === String(expected).trim().toLowerCase();
}

// ── the frozen condition list (card items 1–25) ────────────────────────────────
// Each entry: { id, title, evaluate(obs) -> {status, detail} }; evaluate must
// tolerate a completely absent observation branch and return ERROR.
const CONDITIONS = Object.freeze([
  // (1) clean source main, exact SHA recorded — measured by the RUN, not asserted.
  {
    id: 'source_tree_verified',
    title: 'clean main equal to origin/main, exact SHA recorded, session number legal at the canonical count',
    evaluate(obs) {
      const s = obs && obs.source;
      if (!s) return missing('the source tree');
      if (s.branch !== 'main') return err(`the run executed on "${s.branch || 'unknown'}", not main`);
      if (s.clean !== true) return err('the worktree was not clean');
      if (!SHA_RE.test(str(s.head_sha))) return err('HEAD did not resolve to a full sha');
      if (s.head_sha !== s.origin_head_sha) return err(`HEAD ${str(s.head_sha).slice(0, 7)} != origin/main ${str(s.origin_head_sha).slice(0, 7)}`);
      const n = obs.session_number;
      if (!isRehearsalSessionNumber(n)) return err(`session number ${n} is not 1..${REHEARSAL_STREAK_LENGTH}`);
      const prior = s.prior_rehearsal_count;
      if (!Number.isInteger(prior)) return err(`the canonical rehearsal count was unreadable (${s.prior_count_reason || 'no reason recorded'})`);
      if (prior !== n - 1) return err(`session ${n} is legal only at count ${n - 1}/5; the plan recorded ${prior}/5`);
      return pass(`main @ ${s.head_sha.slice(0, 12)} (= origin/main, clean); session ${n} at prior count ${prior}/5`);
    },
  },
  // (2) fresh synthetic identities — run family + the INVERTED workout check.
  {
    id: 'fresh_identities',
    title: 'fresh run/athlete identities; the workout identity was SERVER-allocated, never pre-seeded',
    evaluate(obs) {
      if (normalizePurpose(obs && obs.run_purpose) !== REHEARSAL_SESSION) {
        return err(`the run declared no rehearsal purpose (got "${(obs && obs.run_purpose) || ''}")`);
      }
      const runRef = runIdentityRefusal({ sessionNumber: obs.session_number, runId: obs.run_id });
      if (runRef) return err(runRef);
      if (!str(obs.athlete_id)) return missing('the synthetic athlete id');
      const wRef = workoutIdentityRefusal({ workoutSessionId: obs.workout_session_id });
      if (wRef) return fail(wRef);
      if (obs.workout_id_preseeded === true) return fail('the workout id was present before acceptance — pre-seeded, not allocated');
      return pass(`run ${obs.run_id}; workout ${obs.workout_session_id} allocated by the server at acceptance`);
    },
  },
  // (3) model-up proven positively.
  {
    id: 'model_posture_proven',
    title: 'model-up with the provider proven reachable and a live-provider turn observed',
    evaluate(obs) {
      const m = obs && obs.model;
      if (!m) return missing('the model posture');
      if (m.posture !== 'model-up') return err(`the harness posture was "${m.posture || 'unknown'}", not model-up`);
      if (m.provider_reachable !== true) return err('the provider was not proven reachable before the port published');
      if (!str(m.coach_model)) return err('no coach model was recorded');
      if (m.live_provider_turn_observed !== true) return fail('no turn showed an unambiguous live-provider source — model-up is unproven for this run');
      return pass(`model-up (${m.coach_model}); a live-provider turn was observed`);
    },
  },
  // (4) the exact sandbox; production non-contact.
  {
    id: 'sandbox_posture_proven',
    title: 'the combined rehearsal posture served the declared sandbox with every preflight check green',
    evaluate(obs) {
      const s = obs && obs.sandbox;
      if (!s) return missing('the sandbox posture');
      if (s.rehearsal_live !== true) return err('the harness did not report the combined rehearsal posture');
      if (!str(s.sandbox_last6)) return err('no sandbox identity (last6) was recorded');
      if (s.declared_last6 !== s.sandbox_last6) return err(`the served workbook last6 ${s.sandbox_last6} is not the declared sandbox ${s.declared_last6}`);
      if (s.preflight_ok !== true) return err('the sandbox preflight did not pass');
      const checks = arr(s.preflight_checks);
      if (!checks || !checks.length) return missing('the preflight checks');
      const bad = checks.filter((c) => c.ok !== true);
      if (bad.length) return err(`preflight checks failed: ${bad.map((c) => c.name).join(', ')}`);
      return pass(`declared sandbox last6 ${s.sandbox_last6}; ${checks.length} preflight checks green`);
    },
  },
  // (5) no ambient workbook inheritance.
  {
    id: 'ambient_sheet_not_inherited',
    title: 'no ambient GOOGLE_SHEETS_ID crossed into the run',
    evaluate(obs) {
      const s = obs && obs.sandbox;
      if (!s) return missing('the sandbox posture');
      if (s.child_carried_workbook_id === true) return err('the child environment carried a GOOGLE_SHEETS_ID');
      return pass('the workbook id was assigned from config/sandboxSheet.js, never inherited');
    },
  },
  // (6) real browser and built client.
  {
    id: 'real_browser_built_client',
    title: 'a real browser drove the BUILT client shell',
    evaluate(obs) {
      const ui = obs && obs.ui;
      if (!ui) return missing('the browser evidence');
      if (ui.real_browser !== true) return err('the run did not record a real browser');
      if (!str(ui.shell_build)) return err('the built shell recorded no build identity');
      return pass(`built shell ${ui.shell_build} in a real browser`);
    },
  },
  // (7) full production path — the gate server IS index.js; provenance marks synthetic.
  {
    id: 'synthetic_provenance',
    title: 'the full production route stack served the run and every request carried synthetic provenance',
    evaluate(obs) {
      const p = obs && obs.provenance;
      if (!p) return missing('request provenance');
      if (p.request_origin !== 'playwright') return err(`the client marked requests "${p.request_origin || 'nothing'}", not playwright`);
      if (p.real_index_js !== true) return err('the run did not record the real index.js app serving');
      return pass('real Express app; requests marked playwright (synthetic, never owner evidence)');
    },
  },
  // (8) the expected visible conversation — scenario-declared beats all observed.
  {
    id: 'declared_conversation_observed',
    title: 'every scenario-declared conversational beat was observed, in order',
    evaluate(obs) {
      const beats = arr(obs && obs.scenario && obs.scenario.beats);
      if (!beats || !beats.length) return missing('the declared conversation beats');
      const failed = beats.filter((b) => b.ok !== true);
      if (failed.length) return fail(`beats failed: ${failed.map((b) => `${b.id} (${b.detail || 'no detail'})`).join('; ')}`);
      return pass(`${beats.length} declared beats observed`);
    },
  },
  // (9) no unsupported mutation or write claim.
  {
    id: 'no_unsupported_claims',
    title: 'no completed-mutation or write claim appeared without the state to back it',
    evaluate(obs) {
      const c = obs && obs.claims;
      if (!c) return missing('the claim sweep');
      if (c.unsupported_mutation_wording === true) return fail(`completed-mutation wording appeared without a mutation: ${c.detail || ''}`);
      if (c.unsupported_write_claim === true) return fail(`a write claim appeared without a write: ${c.detail || ''}`);
      return pass('no unsupported mutation or write claims in the visible thread');
    },
  },
  // (10) canonical plan state agrees with visible wording.
  {
    id: 'canonical_state_agrees',
    title: 'canonical plan state agreed with the visible wording at every checked point',
    evaluate(obs) {
      const checks = arr(obs && obs.state_agreement);
      if (!checks || !checks.length) return missing('the state-agreement checks');
      const bad = checks.filter((c) => c.ok !== true);
      if (bad.length) return fail(`state disagreed with wording: ${bad.map((c) => `${c.id} (${c.detail || ''})`).join('; ')}`);
      return pass(`${checks.length} state-agreement checks green`);
    },
  },
  // (11) exact Session_Plans events, session-filtered.
  {
    id: 'session_plans_events_exact',
    title: 'the durable Session_Plans events match the scenario declaration exactly (this session only)',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.session_plans;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Session_Plans rows');
      if (!ex) return missing('the scenario declaration');
      const events = arr(d.event_counts) || [];
      const want = ex.session_plans_events || {};
      const got = {};
      for (const e of events) got[e.event] = e.count;
      const problems = [];
      for (const [event, count] of Object.entries(want)) {
        if ((got[event] || 0) !== count) problems.push(`${event}: expected ${count}, found ${got[event] || 0}`);
      }
      for (const [event, count] of Object.entries(got)) {
        if (!(event in want) && count > 0) problems.push(`unexpected event ${event} × ${count}`);
      }
      if (problems.length) return fail(problems.join('; '));
      return pass(Object.entries(want).map(([e, c]) => `${e}×${c}`).join(', ') + ' — exact');
    },
  },
  // (12) exact Session_Plan_Sets binding and seal.
  {
    id: 'session_plan_sets_binding_and_seal',
    title: 'the durable ledger rows carry the accepted grain, correct binding, and one seal',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.session_plan_sets;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Session_Plan_Sets rows');
      if (!ex) return missing('the scenario declaration');
      if (d.row_count !== ex.plan_set_rows) return fail(`expected ${ex.plan_set_rows} ledger rows for this session, found ${d.row_count}`);
      if (d.distinct_seals !== 1) return fail(`expected ONE closeout seal across the session's ledger rows, found ${d.distinct_seals}`);
      if (d.blank_seals !== 0) return fail(`${d.blank_seals} ledger row(s) were left unsealed`);
      if (d.accepted_grain_ok !== true) return fail(d.grain_detail || 'the accepted rows did not carry the declared per-item set counts');
      return pass(`${d.row_count} rows, one seal, accepted grain exact`);
    },
  },
  // (13) exact Log_Cleaned rows.
  {
    id: 'durable_log_rows_exact',
    title: 'the durable Log_Cleaned rows match the scenario declaration exactly (this session only)',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.log_cleaned;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Log_Cleaned rows');
      if (!ex) return missing('the scenario declaration');
      if (d.row_count !== ex.log_rows) return fail(`expected ${ex.log_rows} Log_Cleaned rows, found ${d.row_count}`);
      if (d.rows_match_declaration !== true) return fail(d.detail || 'the rows did not match the declared sets');
      return pass(`${d.row_count} rows, matching the declared sets`);
    },
  },
  // (14) Effort behavior matches whether effort was supplied.
  {
    id: 'effort_behavior_matches',
    title: 'the Effort row exists exactly when the scenario supplied effort data',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.effort;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Effort rows');
      if (!ex) return missing('the scenario declaration');
      const want = ex.effort_supplied ? 1 : 0;
      if (d.row_count !== want) {
        return fail(ex.effort_supplied
          ? `effort was supplied but ${d.row_count} Effort row(s) landed (expected 1)`
          : `no effort was supplied but ${d.row_count} Effort row(s) landed (expected 0) — absence must not fail the write`);
      }
      return pass(ex.effort_supplied ? 'one Effort row, as supplied' : 'no Effort row, and the write did not require one');
    },
  },
  // (15) a preview before the write.
  {
    id: 'preview_before_write',
    title: 'a dry-run preview with the no-write proof preceded the live write',
    evaluate(obs) {
      const w = obs && obs.write;
      if (!w) return missing('the write evidence');
      if (w.preview_seen !== true) return err('no preview was observed');
      if (w.preview_no_write_confirmed !== true) return fail('the preview did not carry the no-write proof');
      if (w.preview_before_write !== true) return fail('the preview did not precede the live write');
      return pass('preview (no_write_confirmed) → approval → write, in order');
    },
  },
  // (16) one visible approval.
  {
    id: 'browser_approval',
    title: 'exactly one visible approval action released the write',
    evaluate(obs) {
      const w = obs && obs.write;
      if (!w) return missing('the write evidence');
      if (w.approvals_clicked !== 1) return fail(`${w.approvals_clicked} approval actions were performed (expected exactly 1)`);
      if (w.write_success !== true) return fail('the approved write did not report success');
      return pass('one visible approval; the write reported success with proof fields');
    },
  },
  // (17) a repeated approval writes nothing.
  {
    id: 'approval_at_most_once',
    title: 'a repeated approval created zero duplicate durable rows',
    evaluate(obs) {
      const w = obs && obs.write;
      if (!w) return missing('the write evidence');
      if (w.repeat_attempted !== true) return err('the repeat-approval probe did not run');
      if (w.duplicate_rows !== 0) return fail(`${w.duplicate_rows} duplicate durable rows appeared after the repeated approval`);
      return pass('the repeated approval produced zero new durable rows');
    },
  },
  // (18) correct closeout state.
  {
    id: 'closeout_state_correct',
    title: 'the closeout reached the scenario-declared final state honestly',
    evaluate(obs) {
      const c = obs && obs.closeout;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!c) return missing('the closeout evidence');
      if (!ex) return missing('the scenario declaration');
      if (c.fully_verified !== ex.closeout_fully_verified) {
        return fail(`closeout_fully_verified was ${c.fully_verified}, declared ${ex.closeout_fully_verified}`);
      }
      if (c.ui_stuck_saving === true) return fail('the visible Save control stayed on "Saving…"');
      if (c.final_state_ok !== true) return fail(c.detail || 'the visible closeout state was wrong');
      return pass(`closeout_fully_verified=${c.fully_verified}, visible state correct`);
    },
  },
  // (19) InteractionTrace and turn-write proof join on the live write's turn_id.
  {
    id: 'trace_write_join',
    title: 'the InteractionTrace and the turn-write proof join on the live write turn',
    evaluate(obs) {
      const t = obs && obs.trace;
      if (!t) return missing('the trace/write-proof join');
      if (t.join_ok !== true) return fail(t.detail || 'the trace and the turn-write proof did not join on the live write turn_id');
      return pass(`joined on turn ${t.turn_id || '(recorded)'}`);
    },
  },
  // (20) the corrected review tool finds the exact session.
  {
    id: 'review_tool_adjudicates',
    title: 'atlas:review-live finds exactly this session and passes its trust criteria',
    evaluate(obs) {
      const r = obs && obs.review;
      if (!r) return missing('the review-tool adjudication');
      if (r.found_exact_session !== true) return fail('the review tool did not correlate this exact session');
      if (r.all_unknown === true) return fail('the review tool returned an all-UNKNOWN verdict');
      if (r.failed_criteria && r.failed_criteria.length) return fail(`review criteria failed: ${r.failed_criteria.join(', ')}`);
      return pass('the review tool adjudicated this exact session with no failed criterion');
    },
  },
  // (21) /api/summary/weekly succeeds.
  {
    id: 'weekly_summary_succeeds',
    title: 'GET /api/summary/weekly returns HTTP 200 with a bounded valid body',
    evaluate(obs) {
      const w = obs && obs.weekly;
      if (!w) return missing('the weekly-summary probe');
      if (w.status !== 200) return fail(`/api/summary/weekly returned ${w.status}${w.detail ? ` (${w.detail})` : ''}`);
      if (w.valid_body !== true) return fail('the weekly summary body was not a bounded valid response');
      return pass('200 with a valid bounded body');
    },
  },
  // (22) no foreign identity or cross-session rows.
  {
    id: 'no_cross_session_rows',
    title: 'every durable row read for this session carries this session\'s identity, and foreign identities are unreachable',
    evaluate(obs) {
      const d = obs && obs.durable;
      if (!d) return missing('the durable evidence');
      if (d.foreign_rows !== 0) return fail(`${d.foreign_rows} row(s) carrying another identity rode along`);
      if (d.foreign_id_probe_status !== 403) return fail(`the verifier answered ${d.foreign_id_probe_status} for a foreign identity (expected 403)`);
      return pass('all rows carry this session\'s identity; a foreign-identity read was refused (403)');
    },
  },
  // (23) no secret, token, fingerprint, or workbook ID leakage.
  {
    id: 'artifacts_privacy_safe',
    title: 'the published artifacts leak no secret, token, or full workbook id',
    evaluate(obs) {
      const a = obs && obs.artifacts;
      if (!a) return missing('the artifact sweep');
      if (a.leaks && a.leaks.length) return fail(`artifact leakage: ${a.leaks.join(', ')}`);
      if (a.swept !== true) return err('the artifact privacy sweep did not run');
      return pass('artifacts name the workbook by last6 only; no credential or token material found');
    },
  },
  // (24) bounded local artifacts with SHA-256 hashes.
  {
    id: 'artifacts_hashed',
    title: 'the run preserved bounded artifacts with SHA-256 hashes',
    evaluate(obs) {
      const a = obs && obs.artifacts;
      if (!a) return missing('the artifact record');
      const files = arr(a.files);
      if (!files || !files.length) return err('no artifacts were preserved');
      const unhashed = files.filter((f) => !/^[0-9a-f]{64}$/.test(str(f.sha256)));
      if (unhashed.length) return err(`artifacts without hashes: ${unhashed.map((f) => f.name).join(', ')}`);
      return pass(`${files.length} artifacts, each with a SHA-256`);
    },
  },
  // (25) counts and reasons — emitted by construction: the scorecard itself.
  {
    id: 'schema_and_guard_clean',
    title: 'no schema mutation and no guard refusal occurred (a refusal is a finding, never a pass)',
    evaluate(obs) {
      const g = obs && obs.guard;
      if (!g) return missing('the guard record');
      if ((g.ensure_tab_calls || 0) !== 0) return fail(`${g.ensure_tab_calls} ensureSheetTab call(s) were attempted`);
      if ((g.refusals || 0) !== 0) return fail(`${g.refusals} guard refusal(s) occurred — production attempted something this rehearsal may not do`);
      const seals = g.seal_updates;
      if (!Number.isInteger(seals) || seals < 1) return fail('the closeout seal update was not observed through the guard');
      return pass(`no refusals, no schema calls, ${seals} seal update(s) through the authorized column`);
    },
  },
]);

// ── scoring ────────────────────────────────────────────────────────────────────
function scoreRehearsalRun(observations) {
  const obs = observations && typeof observations === 'object' ? observations : {};
  const conditions = CONDITIONS.map((c) => {
    let result;
    try {
      result = c.evaluate(obs);
    } catch (e) {
      result = err(`the condition evaluator threw: ${e && e.message}`);
    }
    return { id: c.id, title: c.title, status: result.status, detail: result.detail };
  });

  const counts = { PASS: 0, FAIL: 0, ERROR: 0, NOT_APPLICABLE: 0 };
  for (const c of conditions) counts[c.status] += 1;
  const overall = counts.FAIL > 0 ? FAIL : (counts.ERROR > 0 ? ERROR : PASS);

  const eligible = overall === PASS;
  return {
    purpose: REHEARSAL_SESSION,
    session_number: obs.session_number ?? null,
    scenario: (obs.scenario && obs.scenario.id) || null,
    overall,
    counts,
    conditions,
    rehearsal_eligible: eligible,
    rehearsal_note: eligible
      ? `this run qualifies as rehearsal session ${obs.session_number} — record the count advance in the execution plan`
      : 'this run does NOT advance the rehearsal streak',
  };
}

function renderMarkdown(card) {
  const lines = [
    `# F-SB4B rehearsal session ${card.session_number ?? '?'} — ${card.overall}`,
    '',
    `Scenario: ${card.scenario || '(none)'} · PASS ${card.counts.PASS} · FAIL ${card.counts.FAIL} · ERROR ${card.counts.ERROR} · N/A ${card.counts.NOT_APPLICABLE}`,
    `rehearsal_eligible: ${card.rehearsal_eligible}`,
    '',
    '| # | condition | status | detail |',
    '|---|---|---|---|',
  ];
  card.conditions.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.id} | ${c.status} | ${String(c.detail || '').replace(/\|/g, '\\|')} |`);
  });
  return `${lines.join('\n')}\n`;
}

module.exports = { CONDITIONS, scoreRehearsalRun, renderMarkdown, PASS, FAIL, ERROR, NOT_APPLICABLE };
