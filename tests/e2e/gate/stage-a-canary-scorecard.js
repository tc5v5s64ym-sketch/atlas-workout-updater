'use strict';

// ── Phase 4 Stage-A canary scorecard (temporary Phase 4 machinery) ──────────────
//
// Scores ONE canary run against a FROZEN list of required conditions. Pure and
// deterministic: no clock, network, filesystem, Sheets, or environment access — the
// caller collects observations, this module decides what they prove.
//
// Four statuses, no fifth. There is deliberately no INCONCLUSIVE:
//
//   PASS            — every piece of evidence the condition requires is present and agrees.
//   FAIL            — the product completed the run and violated an asserted outcome.
//   ERROR           — the environment, authority, evidence, or safety precondition was
//                     absent or ambiguous. Missing evidence is ERROR, never PASS and never
//                     FAIL: "we could not tell" is a different fact from "it was wrong".
//   NOT_APPLICABLE  — permitted for EXACTLY ONE condition, by an explicit owner ruling,
//                     and only with that ruling's exact reason attached.
//
// The frozen list is the point. A scorecard that only reports the conditions its caller
// happened to supply can be made green by supplying fewer — so every condition in
// CONDITIONS is always emitted, and a condition whose observation is missing scores ERROR.
// Removing an assertion therefore turns the run RED rather than quietly shrinking the bar.

// The one condition the owner ruled may be NOT_APPLICABLE, and the exact reason that
// ruling requires. A different reason string is not the ruling and is refused.
const NA_CONDITION_ID = 'session_plans_sheet_evidence';
const NA_REQUIRED_REASON =
  'Current Phase 4 flags and sandbox schema do not make Session_Plans or Session_Plan_Sets writes part of this canary.';

const PASS = 'PASS';
const FAIL = 'FAIL';
const ERROR = 'ERROR';
const NOT_APPLICABLE = 'NOT_APPLICABLE';
const STATUSES = Object.freeze([PASS, FAIL, ERROR, NOT_APPLICABLE]);

// ── helpers ────────────────────────────────────────────────────────────────────
// `missing` returns ERROR rather than FAIL so an unobserved condition can never be
// reported as a product defect, nor absorbed into a pass.
const pass = (detail) => ({ status: PASS, detail });
const fail = (detail) => ({ status: FAIL, detail });
const err = (detail) => ({ status: ERROR, detail });
const missing = (what) => err(`no evidence recorded for ${what}`);

const isBool = (v) => v === true || v === false;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Compare a durable row's numeric-ish cell to an expected value without being fooled by
// Sheets' string/number ambiguity ('225' vs 225) — but never by treating '' as 0.
function cellEquals(cell, expected) {
  const raw = cell == null ? '' : String(cell).trim();
  if (raw === '') return false;
  if (typeof expected === 'number') return Number(raw) === expected;
  return raw.toLowerCase() === String(expected).trim().toLowerCase();
}

// ── the frozen condition list ──────────────────────────────────────────────────
//
// Each entry: { id, title, evaluate(obs) -> {status, detail} }.
// `evaluate` must tolerate a completely absent observation branch and return ERROR.
const CONDITIONS = Object.freeze([
  {
    id: 'sandbox_posture_proven',
    title: 'The server proved the declared sandbox workbook before publishing a port',
    evaluate(obs) {
      const s = obs.server;
      if (!s || !isBool(s.sandbox_live)) return missing('server sandbox posture');
      if (s.sandbox_live !== true) return fail('the server did not run in sandbox-live posture');
      const pre = s.sandbox_preflight;
      if (!pre || !arr(pre.checks)) return missing('sandbox preflight checks');
      if (pre.ok !== true) return fail('sandbox preflight did not complete');
      const failed = pre.checks.filter((c) => c.ok !== true);
      if (failed.length) return fail(`preflight checks failed: ${failed.map((c) => c.name).join(', ')}`);
      if (s.sheets_stubbed_in_memory !== false) {
        return fail('the server reported an in-memory Sheets stub while claiming sandbox-live');
      }
      return pass(`${pre.checks.length} preflight checks passed; workbook last6 ${str(s.sandbox_last6) || 'unknown'}`);
    },
  },
  {
    id: 'ambient_sheet_not_inherited',
    title: 'The ambient GOOGLE_SHEETS_ID was not inherited by the write-enabled server',
    evaluate(obs) {
      const e = obs.env;
      if (!e) return missing('child environment');
      const declared = str(e.declared_sandbox_last6);
      const child = str(e.child_sheet_id_last6);
      if (!declared || !child) return missing('resolved workbook identifiers');
      if (child !== declared) return fail(`the server resolved workbook last6 ${child}, not the declared sandbox ${declared}`);
      // The ambient value may legitimately be absent on a clean machine; what must never
      // happen is the ambient value BEING the one the server used when they differ.
      const ambient = str(e.ambient_sheet_id_last6);
      if (ambient && ambient !== declared && e.inherited_ambient === true) {
        return fail('the server inherited the ambient workbook id');
      }
      if (e.inherited_ambient !== false) return missing('an explicit non-inheritance determination');
      return pass(ambient
        ? `ambient last6 ${ambient} present and NOT used; server used declared sandbox ${declared}`
        : `no ambient workbook id present; server used declared sandbox ${declared}`);
    },
  },
  {
    id: 'production_non_contact',
    title: 'No production or unknown workbook was contacted, and no guard was tripped',
    evaluate(obs) {
      const s = obs.server;
      if (!s) return missing('server state');
      const refusals = arr(s.refusals);
      if (!refusals) return missing('guard refusal list');
      if (refusals.length) {
        return fail(`the Sheets guard refused ${refusals.length} operation(s): ${refusals.map((r) => `${r.operation}${r.tabName ? `/${r.tabName}` : ''}`).join(', ')}`);
      }
      const appends = arr(s.appends);
      if (!appends) return missing('append list');
      const offTab = appends.filter((a) => a.tabName !== 'Log_Cleaned' && a.tabName !== 'Effort');
      if (offTab.length) return fail(`appends landed outside the authorized tabs: ${offTab.map((a) => a.tabName).join(', ')}`);
      if (s.telemetry_persistence_off !== true) return fail('a telemetry persistence flag was set, so shadow rows could reach the workbook');
      return pass('zero guard refusals; every append targeted Log_Cleaned or Effort; telemetry persistence off');
    },
  },
  {
    id: 'no_schema_mutation',
    title: 'No tab or schema was created, altered, or deleted',
    evaluate(obs) {
      const s = obs.server;
      if (!s) return missing('server state');
      const ensure = arr(s.ensure_tab_calls);
      const deletes = arr(s.deletes);
      const updates = arr(s.updates);
      if (!ensure || !deletes || !updates) return missing('schema-mutation call lists');
      if (ensure.length) return fail(`ensureSheetTab was attempted for: ${ensure.join(', ')}`);
      if (deletes.length) return fail(`${deletes.length} row deletion(s) were attempted`);
      if (updates.length) return fail(`${updates.length} cell rewrite(s) were attempted`);
      return pass('zero ensureSheetTab, zero deletions, zero cell rewrites');
    },
  },
  {
    id: 'model_posture_proven',
    title: 'The declared model posture matches what the server proved',
    evaluate(obs) {
      const s = obs.server;
      const mode = str(obs.run && obs.run.mode);
      if (!s || !mode) return missing('model posture');
      if (mode !== 'model-down' && mode !== 'model-up') return err(`unrecognized run mode "${mode}"`);
      if (str(s.model_posture) !== mode) {
        return fail(`the run declared ${mode} but the server served ${str(s.model_posture) || 'an unstated posture'}`);
      }
      if (mode === 'model-down') {
        if (s.provider_key_present !== false) return fail('a provider key was present in a model-down run');
        if (s.provider_reachable === true) return fail('the server reported a reachable provider in a model-down run');
        return pass('model-down: no provider key present after app load, no provider call made');
      }
      if (s.provider_reachable !== true) return fail('model-up was declared but the server did not prove provider reachability');
      if (s.coach_scripted === true) return fail('a scripted coach cannot serve a model-up run');
      const model = str(s.coach_model);
      if (!model) return missing('the model that answered');
      const expected = str(obs.run.expected_model);
      if (expected && expected !== model) return fail(`model-up answered with ${model}, not the expected ${expected}`);
      return pass(`model-up: provider reachable, model ${model}`);
    },
  },
  {
    id: 'model_source_marker',
    title: 'An eligible coach turn exposed an unambiguous source marker for the declared posture',
    evaluate(obs) {
      const mode = str(obs.run && obs.run.mode);
      const q = obs.ui && obs.ui.grounded_question;
      if (!mode) return missing('run mode');
      if (!q) return missing('the eligible coach turn');
      const source = str(q.source);
      if (!source) return missing('an explicit source marker on the eligible coach turn');
      if (q.source_ambiguous === true) return err('the eligible turn reported an ambiguous source');
      if (mode === 'model-down') {
        if (q.provider_called === true) return fail('a model-down run made a provider call on the eligible turn');
        if (source === 'live_model') return fail('a model-down run reported a live-model source');
        return pass(`model-down: eligible turn served deterministically (source "${source}")`);
      }
      // Model-up. Absence of outage wording, a settled response, and "configured: true"
      // are each explicitly NOT proof — only a positive live-provider marker counts.
      if (q.provider_called !== true) return fail('the eligible model-up turn did not reach the provider');
      if (source !== 'live_model') {
        return fail(`the eligible model-up turn fell back to source "${source}" instead of the live model`);
      }
      return pass('model-up: eligible turn carried an unambiguous live-provider source marker');
    },
  },
  {
    id: 'synthetic_provenance',
    title: 'Every request carried synthetic provenance and cannot be read as owner evidence',
    evaluate(obs) {
      const p = obs.provenance;
      if (!p) return missing('request provenance');
      const origin = str(p.request_origin);
      if (!origin) return missing('the request-origin marker');
      const SYNTHETIC = new Set(['playwright', 'e2e', 'canary', 'test', 'test_mode', 'sim', 'simulation', 'probe', 'smoke', 'script', 'seed', 'ci', 'replay']);
      if (origin === 'athlete_ui') return fail('requests were marked athlete_ui — synthetic traffic must never claim owner provenance');
      if (!SYNTHETIC.has(origin)) return fail(`request origin "${origin}" is not a recognized synthetic marker`);
      if (p.evidence_eligible === true) return fail('the run was classified evidence-eligible; synthetic evidence may never count as owner evidence');
      if (p.evidence_class && str(p.evidence_class) !== 'synthetic') {
        return fail(`the run classified as "${p.evidence_class}" rather than synthetic`);
      }
      const sid = str(obs.run && obs.run.session_id);
      if (!sid) return missing('the synthetic session id');
      if (!/CANARY/i.test(sid)) return fail(`session id "${sid}" does not carry the synthetic canary marker`);
      return pass(`origin "${origin}", classified synthetic and evidence-ineligible; session id marked CANARY`);
    },
  },
  {
    id: 'isolated_initial_state',
    title: 'The run began from a confirmed synthetic identity and an isolated empty session',
    evaluate(obs) {
      const u = obs.ui;
      if (!u) return missing('UI observations');
      if (u.identity_confirmed !== true) return fail('the synthetic identity was not confirmed in the client');
      if (!isNum(u.initial_logged_sets)) return missing('the initial buffered-set count');
      if (u.initial_logged_sets !== 0) return fail(`the session started with ${u.initial_logged_sets} buffered sets, not an isolated empty state`);
      if (!isNum(u.durable_rows_before_run)) return missing('the pre-run durable row count for this session id');
      if (u.durable_rows_before_run !== 0) return fail(`${u.durable_rows_before_run} durable rows already existed for this session id — the id is not unique`);
      return pass('synthetic identity confirmed; zero buffered sets and zero durable rows at start');
    },
  },
  {
    id: 'plan_established',
    title: 'A workout plan was established through the current product path',
    evaluate(obs) {
      const u = obs.ui;
      if (!u) return missing('UI observations');
      if (u.plan_established !== true) return fail('no plan was established through the product path');
      const ex = arr(u.plan_exercises);
      if (!ex) return missing('the established plan exercises');
      if (ex.length < 2) return fail(`the plan carried ${ex.length} exercise(s); a genuine session needs at least 2`);
      if (u.plan_remaining_visible !== true) return fail('remaining plan state was not visible in the client');
      return pass(`plan established with ${ex.length} exercises (${ex.join(', ')}); remaining state visible`);
    },
  },
  {
    id: 'grounded_question_answered',
    title: 'A conversational question was answered from current session state',
    evaluate(obs) {
      const q = obs.ui && obs.ui.grounded_question;
      if (!q) return missing('the conversational question turn');
      if (q.asked !== true) return fail('no conversational question was asked');
      if (!str(q.reply_text)) return fail('the question produced no visible reply');
      if (q.grounded_in_session !== true) {
        return fail('the reply did not reference current session state, so grounding is unproven');
      }
      return pass('the question was answered with a reply grounded in current session state');
    },
  },
  {
    id: 'genuine_workout_logged',
    title: 'At least two exercises and enough sets to represent a genuine workout were entered',
    evaluate(obs) {
      const u = obs.ui;
      if (!u) return missing('UI observations');
      const exs = arr(u.exercises_logged);
      if (!exs) return missing('the logged exercise list');
      if (!isNum(u.logged_sets)) return missing('the buffered-set count');
      if (exs.length < 2) return fail(`only ${exs.length} exercise(s) were logged`);
      if (u.logged_sets < 4) return fail(`only ${u.logged_sets} set(s) were logged`);
      return pass(`${u.logged_sets} sets across ${exs.length} exercises (${exs.join(', ')})`);
    },
  },
  {
    id: 'no_write_before_approval',
    title: 'No durable workout row existed before the browser approval',
    evaluate(obs) {
      const u = obs.ui;
      if (!u) return missing('UI observations');
      if (!isNum(u.durable_rows_before_approval)) return missing('the pre-approval durable row count');
      if (u.durable_rows_before_approval !== 0) {
        return fail(`${u.durable_rows_before_approval} durable row(s) existed before approval — preview→approve→write was bypassed`);
      }
      if (!isNum(u.appends_before_approval)) return missing('the pre-approval append count');
      if (u.appends_before_approval !== 0) {
        return fail(`${u.appends_before_approval} append(s) were issued before approval`);
      }
      return pass('zero durable rows and zero appends before the approval click');
    },
  },
  {
    id: 'preview_before_write',
    title: 'The real preview rendered and contained only the intended synthetic sets',
    evaluate(obs) {
      const u = obs.ui;
      if (!u) return missing('UI observations');
      if (u.preview_rendered !== true) return fail('no preview was rendered');
      const shown = arr(u.preview_sets);
      const intended = arr(obs.expected && obs.expected.sets);
      if (!shown) return missing('the preview contents');
      if (!intended) return missing('the intended set list');
      if (shown.length !== intended.length) {
        return fail(`the preview showed ${shown.length} sets, expected ${intended.length}`);
      }
      const unintended = shown.filter((s) => !intended.some((i) =>
        cellEquals(s.exercise, i.exercise) && cellEquals(s.weight, i.weight) && cellEquals(s.reps, i.reps)));
      if (unintended.length) {
        return fail(`the preview contained ${unintended.length} set(s) that were not intended`);
      }
      if (u.preview_proof_present !== true) return missing('the preview proof the approval control requires');
      return pass(`preview rendered with exactly the ${shown.length} intended sets`);
    },
  },
  {
    id: 'browser_approval',
    title: 'The write was triggered by a real click on the real approval control',
    evaluate(obs) {
      const u = obs.ui;
      if (!u) return missing('UI observations');
      if (u.approval_clicked !== true) return fail('the approval control was never clicked');
      // Two distinct facts, both required. The VISIBLE control the athlete taps is the review
      // card's Save; `#approve-btn` is the gated write trigger it routes to and is never itself
      // visible. Recording only the trigger would let a run claim a browser approval it could
      // not have performed — which is exactly how the first canary attempt failed.
      if (str(u.approval_control) !== '.review:not(.done) .rv-save') {
        return fail(`the approval gesture was "${str(u.approval_control) || 'an unrecorded control'}" rather than the review card's Save — the only visible approval control`);
      }
      if (str(u.write_trigger) !== '#approve-btn') {
        return fail(`the write was triggered by "${str(u.write_trigger) || 'an unrecorded trigger'}" rather than the single gated write trigger`);
      }
      if (u.direct_write_route_used === true) {
        return fail('a write route was called directly instead of going through browser approval');
      }
      if (u.direct_write_route_used !== false) return missing('a determination that no direct write route was used');
      return pass('the write was triggered by a real review-card Save click, routed through the gated #approve-btn');
    },
  },
  {
    id: 'durable_log_rows_exact',
    title: 'Log_Cleaned holds exactly the expected rows for this synthetic session',
    evaluate(obs) {
      const d = obs.durable;
      const expected = arr(obs.expected && obs.expected.sets);
      if (!d) return missing('durable row readback');
      const rows = arr(d.log_rows);
      if (!rows) return missing('Log_Cleaned rows');
      if (!expected) return missing('the expected set list');
      if (rows.length === 0) return fail('no durable Log_Cleaned row was written');
      if (rows.length !== expected.length) {
        return fail(`Log_Cleaned holds ${rows.length} rows for this session, expected exactly ${expected.length}`);
      }
      const idx = obs.durable.log_column_index || {};
      for (const want of expected) {
        const hit = rows.find((r) =>
          cellEquals(r[idx.exercise], want.exercise)
          && cellEquals(r[idx.weight], want.weight)
          && cellEquals(r[idx.reps], want.reps)
          && cellEquals(r[idx.rir], want.rir)
          && cellEquals(r[idx.set_number], want.set_number));
        if (!hit) {
          return fail(`no durable row matches ${want.exercise} set ${want.set_number} ${want.weight}x${want.reps}@${want.rir}`);
        }
      }
      return pass(`${rows.length} Log_Cleaned rows match the expected load/reps/RIR/set identities exactly`);
    },
  },
  {
    id: 'durable_effort_row_exact',
    title: 'Effort holds exactly the evidence the current write contract requires',
    evaluate(obs) {
      const d = obs.durable;
      if (!d) return missing('durable row readback');
      const rows = arr(d.effort_rows);
      if (!rows) return missing('Effort rows');
      const expected = obs.expected && obs.expected.effort;
      if (!expected) return missing('the expected effort values');
      if (rows.length !== 1) return fail(`Effort holds ${rows.length} rows for this session, expected exactly 1`);
      const idx = (obs.durable.effort_column_index) || {};
      const row = rows[0];
      for (const [field, want] of Object.entries(expected)) {
        if (idx[field] == null) continue;
        if (!cellEquals(row[idx[field]], want)) {
          return fail(`Effort ${field} is "${row[idx[field]]}", expected "${want}"`);
        }
      }
      return pass('exactly 1 Effort row, matching the expected duration/calorie/HR evidence');
    },
  },
  {
    id: 'no_contamination',
    title: 'No extra, foreign-identity, or cross-session rows were produced',
    evaluate(obs) {
      const d = obs.durable;
      if (!d) return missing('durable row readback');
      if (!isNum(d.foreign_identity_rows)) return missing('the foreign-identity row count');
      if (d.foreign_identity_rows !== 0) {
        return fail(`${d.foreign_identity_rows} row(s) carrying a non-synthetic identity were written`);
      }
      if (!isNum(d.other_session_rows_delta)) return missing('the cross-session row delta');
      if (d.other_session_rows_delta !== 0) {
        return fail(`${d.other_session_rows_delta} row(s) outside this canary session changed`);
      }
      return pass('zero foreign-identity rows; zero rows outside this canary session changed');
    },
  },
  {
    id: 'approval_is_at_most_once',
    title: 'One approved action cannot write twice, and a retry adds no duplicate row',
    evaluate(obs) {
      const u = obs.ui;
      const d = obs.durable;
      if (!u || !d) return missing('the repeat-approval probe');
      if (u.second_approval_attempted !== true) return missing('a second approval attempt');
      if (!isNum(d.rows_added_by_second_approval)) return missing('the post-retry row delta');
      if (d.rows_added_by_second_approval !== 0) {
        return fail(`a repeated approval added ${d.rows_added_by_second_approval} duplicate durable row(s)`);
      }
      return pass('a repeated approval gesture added zero durable rows');
    },
  },
  {
    id: 'closeout_and_seal',
    title: 'The workout was completed through the real closeout path and the sealed state is valid',
    evaluate(obs) {
      const u = obs.ui;
      if (!u) return missing('UI observations');
      if (u.closeout_rendered !== true) return fail('no closeout confirmation was rendered');
      if (u.closeout_approved !== true) return fail('the closeout was never approved');
      if (u.sealed_state_valid !== true) return fail('the client did not report a valid sealed state after closeout');
      if (str(u.sealed_state_label) === '') return missing('the sealed-state label');
      return pass(`closeout rendered, approved, and sealed ("${str(u.sealed_state_label)}")`);
    },
  },
  {
    id: 'interaction_trace_present',
    title: 'A canonical InteractionTrace was captured with its contract stages',
    evaluate(obs) {
      const t = obs.trace;
      if (!t) return missing('InteractionTrace capture');
      const records = arr(t.records);
      if (!records) return missing('InteractionTrace records');
      if (records.length === 0) return fail('no InteractionTrace record was emitted');
      const invalid = records.filter((r) => r.valid !== true);
      if (invalid.length) return fail(`${invalid.length} InteractionTrace record(s) failed validation`);
      const withStages = records.filter((r) => arr(r.stages) && r.stages.length > 0);
      if (withStages.length === 0) return fail('every InteractionTrace record recorded zero stages');
      return pass(`${records.length} valid InteractionTrace record(s); ${withStages.length} carrying recorded stages`);
    },
  },
  {
    id: 'turn_write_proof_present',
    title: 'A turn-write proof identifies this synthetic session and the intended rows',
    evaluate(obs) {
      const w = obs.write_proof;
      if (!w) return missing('turn-write-proof capture');
      const records = arr(w.records);
      if (!records) return missing('turn-write-proof records');
      if (records.length === 0) return fail('no turn-write-proof record was emitted for the approved write');
      const sid = str(obs.run && obs.run.session_id);
      if (!sid) return missing('the synthetic session id');
      const mine = records.filter((r) => str(r.session_id) === sid);
      if (mine.length === 0) {
        return fail('no turn-write-proof record carries this canary session id');
      }
      // The canonical record nests the W1–W3 proof fields under `proof`; read them there
      // rather than in a flattened copy, so this consumes the real format and not a second one.
      const wrote = mine.filter((r) => r.proof && r.proof.sheet_written === true);
      if (wrote.length === 0) return fail('no turn-write-proof record reports a completed write');
      return pass(`${mine.length} turn-write-proof record(s) for this session; ${wrote.length} reporting a completed write`);
    },
  },
  {
    id: 'trace_write_join',
    title: 'The trace and the write proof join on one canonical turn_id',
    evaluate(obs) {
      const t = obs.trace;
      const w = obs.write_proof;
      if (!t || !w) return missing('the artifacts to join');
      const traceIds = arr(t.records) ? t.records.map((r) => str(r.turn_id)).filter(Boolean) : null;
      const writeIds = arr(w.records) ? w.records.map((r) => str(r.turn_id)).filter(Boolean) : null;
      if (!traceIds || !writeIds) return missing('turn ids on both artifacts');
      if (traceIds.length === 0) return fail('no InteractionTrace record carried a turn_id');
      if (writeIds.length === 0) return fail('no turn-write-proof record carried a turn_id');
      const shared = writeIds.filter((id) => traceIds.includes(id));
      if (shared.length === 0) {
        return fail('the trace and the write proof share no turn_id — the artifacts do not join');
      }
      return pass(`${shared.length} turn_id(s) join the trace to the approved write`);
    },
  },
  {
    id: 'evidence_withholding_honest',
    title: 'Withheld evidence is distinguished from absent evidence',
    evaluate(obs) {
      const w = obs.write_proof;
      if (!w) return missing('turn-write-proof capture');
      const records = arr(w.records);
      if (!records) return missing('turn-write-proof records');
      // The canonical record distinguishes the two by CARRYING a `withheld_evidence` list of
      // field NAMES. A record missing the list entirely cannot make the distinction at all,
      // which is ambiguous evidence rather than a violation.
      const withoutList = records.filter((r) => !Array.isArray(r.withheld_evidence));
      if (withoutList.length) {
        return err(`${withoutList.length} turn-write-proof record(s) carry no withheld_evidence list, so withheld and absent cannot be told apart`);
      }
      const withheld = records.reduce((n, r) => n + r.withheld_evidence.length, 0);
      // A withheld entry must name a field, never carry the rejected value.
      const leaked = records.flatMap((r) => r.withheld_evidence).filter((f) => typeof f !== 'string');
      if (leaked.length) return fail('a withheld_evidence entry carried a value rather than a field name');
      return pass(`every record carries an explicit withheld_evidence list (${withheld} withheld field name(s) total)`);
    },
  },
  {
    id: 'artifacts_privacy_safe',
    title: 'The captured artifacts carry no secret, workbook id, or unrelated data',
    evaluate(obs) {
      const p = obs.privacy;
      if (!p) return missing('the privacy scan');
      const violations = arr(p.violations);
      if (!violations) return missing('privacy scan results');
      if (!isNum(p.artifacts_scanned) || p.artifacts_scanned === 0) {
        return err('the privacy scan examined no artifacts, so it proves nothing');
      }
      if (violations.length) {
        return fail(`${violations.length} privacy violation(s): ${violations.map((v) => v.kind).join(', ')}`);
      }
      if (!isNum(p.artifact_bytes)) return missing('the artifact size bound');
      if (p.artifact_bytes > (p.artifact_bytes_limit || Infinity)) {
        return fail(`artifacts total ${p.artifact_bytes} bytes, over the ${p.artifact_bytes_limit} byte bound`);
      }
      return pass(`${p.artifacts_scanned} artifacts scanned, zero violations, ${p.artifact_bytes} bytes within bound`);
    },
  },
  {
    id: NA_CONDITION_ID,
    title: 'Sheet-level Session_Plans / Session_Plan_Sets evidence',
    evaluate(obs) {
      const s = obs.server;
      if (!s) return missing('server state');
      const appends = arr(s.appends);
      if (!appends) return missing('append list');
      const attempted = appends.filter((a) => a.tabName === 'Session_Plans' || a.tabName === 'Session_Plan_Sets');
      // The owner ruling is conditional, and this is the condition. If the exercised
      // production path DID attempt a required plan-ledger write, N/A stops being honest —
      // the result is ERROR and the run stops for owner review. It is never stubbed,
      // never hidden, and the tab is never created to make it pass.
      if (attempted.length) {
        return err(`the exercised path attempted ${attempted.length} plan-ledger write(s); the Session_Plans N/A ruling no longer applies and this needs owner review`);
      }
      const refusals = arr(s.refusals) || [];
      const ledgerRefusals = refusals.filter((r) => r.tabName === 'Session_Plans' || r.tabName === 'Session_Plan_Sets');
      if (ledgerRefusals.length) {
        return err(`the exercised path was refused ${ledgerRefusals.length} plan-ledger write(s); a required plan write failed and needs owner review`);
      }
      if (s.ledger_write_flags_off !== true) {
        return err('a ledger write-enable flag was set, so the N/A precondition did not hold');
      }
      return { status: NOT_APPLICABLE, detail: NA_REQUIRED_REASON };
    },
  },
]);

const CONDITION_IDS = Object.freeze(CONDITIONS.map((c) => c.id));

// ── the scorer ─────────────────────────────────────────────────────────────────
//
// Overall PASS requires: every non-N/A condition PASS, and the only N/A is the one
// authorized condition carrying the ruling's exact reason. Anything else is not a pass.
function scoreCanary(observations) {
  const obs = observations && typeof observations === 'object' ? observations : {};
  const results = CONDITIONS.map((condition) => {
    let outcome;
    try {
      outcome = condition.evaluate(obs);
    } catch (error) {
      // An evaluator that throws is ambiguous evidence, never a pass.
      outcome = err(`evaluator threw: ${error && error.message}`);
    }
    let status = outcome && STATUSES.includes(outcome.status) ? outcome.status : ERROR;
    let detail = outcome && typeof outcome.detail === 'string' ? outcome.detail : 'no detail recorded';
    // A silent downgrade to N/A is the exact false-green this guard exists to stop:
    // only the authorized condition may be N/A, and only with the ruling's exact reason.
    if (status === NOT_APPLICABLE) {
      if (condition.id !== NA_CONDITION_ID) {
        status = ERROR;
        detail = `NOT_APPLICABLE is not authorized for "${condition.id}" — only ${NA_CONDITION_ID} may be N/A`;
      } else if (detail !== NA_REQUIRED_REASON) {
        status = ERROR;
        detail = `NOT_APPLICABLE requires the owner ruling's exact reason; got "${detail}"`;
      }
    }
    return { id: condition.id, title: condition.title, status, detail };
  });

  const counts = { PASS: 0, FAIL: 0, ERROR: 0, NOT_APPLICABLE: 0 };
  for (const r of results) counts[r.status] += 1;

  const required = results.filter((r) => r.status !== NOT_APPLICABLE);
  const allRequiredPass = required.length > 0 && required.every((r) => r.status === PASS);
  const naAuthorized = results
    .filter((r) => r.status === NOT_APPLICABLE)
    .every((r) => r.id === NA_CONDITION_ID && r.detail === NA_REQUIRED_REASON);
  // A run in which EVERY condition is N/A must never read as a pass.
  const overall = allRequiredPass && naAuthorized ? PASS : (counts.FAIL > 0 ? FAIL : ERROR);

  return {
    schema_version: 1,
    run: {
      run_id: str(obs.run && obs.run.run_id) || null,
      mode: str(obs.run && obs.run.mode) || null,
      session_id: str(obs.run && obs.run.session_id) || null,
      athlete_id: str(obs.run && obs.run.athlete_id) || null,
      workbook_last6: str(obs.env && obs.env.declared_sandbox_last6) || null,
    },
    overall,
    counts,
    conditions: results,
    // Stated on the artifact itself so a reader can never mistake canary proof for a
    // Stage A session, and never mistake synthetic evidence for owner evidence.
    stage_a_credit: false,
    stage_a_note: 'Canary proof only. This run does not count toward the Stage A 0/5 streak and is not owner evidence.',
  };
}

function renderMarkdown(scorecard) {
  const s = scorecard;
  const icon = { PASS: '✅', FAIL: '❌', ERROR: '⚠️', NOT_APPLICABLE: '➖' };
  const lines = [
    '# Phase 4 Stage-A canary scorecard',
    '',
    `**Overall: ${s.overall}**`,
    '',
    `- Run: \`${s.run.run_id || '—'}\` (${s.run.mode || '—'})`,
    `- Synthetic session: \`${s.run.session_id || '—'}\``,
    `- Synthetic athlete: \`${s.run.athlete_id || '—'}\``,
    `- Sandbox workbook (last 6): \`${s.run.workbook_last6 || '—'}\``,
    `- PASS ${s.counts.PASS} · FAIL ${s.counts.FAIL} · ERROR ${s.counts.ERROR} · N/A ${s.counts.NOT_APPLICABLE}`,
    '',
    `> ${s.stage_a_note}`,
    '',
    '| | Condition | Status | Evidence |',
    '|---|---|---|---|',
  ];
  for (const c of s.conditions) {
    const detail = String(c.detail).replace(/\|/g, '\\|');
    lines.push(`| ${icon[c.status] || ''} | ${c.title} | \`${c.status}\` | ${detail} |`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  scoreCanary,
  renderMarkdown,
  CONDITIONS,
  CONDITION_IDS,
  STATUSES,
  NA_CONDITION_ID,
  NA_REQUIRED_REASON,
};
