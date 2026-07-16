'use strict';

// Atlas Control Tower — the single, bounded, redacted operational-status assembler (F04B).
//
// Purpose: any agent (Claude/Codex/ChatGPT/fresh) — or the public — can answer
// "where are we / is prod healthy / did the latest write+undo hold" from ONE
// contract, without being handed spreadsheet IDs, tab names, session IDs, or doc
// paths. The full contract lives in docs/ATLAS_OPERATIONS_CONTRACT.md.
//
// Safety rules baked in here:
//   * REDACTION IS A CLOSED WHITELIST. The status document may only contain the
//     keys in ALLOWED_KEYS. This module never spreads an arbitrary source object
//     into the output; it copies scalar fields it chose by name. Secrets, sheet
//     IDs/ranges, emails, workout/health data, and raw transcripts can never
//     reach the output because they are never read into it.
//   * NEVER FABRICATE HEALTH. Missing or unparseable sources degrade to
//     unknown/degraded; `healthy` requires positive evidence (build known, sheet
//     + coach LLM configured, and the latest trusted test PASS). Configuration
//     presence alone is necessary but never sufficient — no false green.
//   * READ-ONLY. Nothing here writes a sheet, calls an LLM, or mutates state.
//
// The parsers are pure (text in → facts out) so they are fully unit-testable; the
// thin fs/env wrappers are best-effort and degrade to "unavailable" rather than
// throwing.

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0';

const ROOT = path.join(__dirname, '..');
const PLAN_PATH = path.join(ROOT, 'docs', 'ATLAS_V1_EXECUTION_PLAN.md');
const TEST_QUEUE_PATH = path.join(ROOT, 'docs', 'TEST_QUEUE.md');

// The exact, closed set of top-level keys the status document may contain. This
// is both the machine contract and the redaction whitelist — tests assert the
// output's keys are a subset of this and that no disallowed/private key appears.
const ALLOWED_KEYS = [
  'schema_version',
  'generated_at',
  'generated_by',
  'overall_status',
  'status_reason_codes',
  'deployed_commit',
  'app_version',
  'deployed_at',
  'active_milestone',
  'active_card',
  'active_card_title',
  'active_card_status',
  'sheets_configured',
  'llm_configured',
  'llm_provider',
  'llm_model',
  'flight_recorder_enabled',
  'latest_test_id',
  'latest_test_verdict',
  'latest_test_write_verdict',
  'latest_test_undo_verdict',
  'latest_test_freshness_days',
  'synthetic_rows_remaining',
  'owner_action_required',
  'owner_action_codes',
  'source_freshness',
  'unavailable_sources'
];

const OVERALL = { HEALTHY: 'healthy', DEGRADED: 'degraded', UNKNOWN: 'unknown' };

function dedupe(arr) {
  return [...new Set(arr)];
}

function shortCommit(value) {
  const s = value == null ? '' : String(value).trim();
  if (!s || s === 'unknown') return 'unknown';
  return s.slice(0, 12);
}

function toBoolOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function pushUnavailable(list, source, reason) {
  if (list.some(x => x && x.source === source)) return;
  list.push({ source, reason });
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

// --- Pure parsers -----------------------------------------------------------

// A card status counts as "complete" only when it literally says COMPLETE. This
// mirrors the campaign's "first eligible unfinished card" selection rule.
function isCompleteStatus(status) {
  if (!status) return false;
  return /\bCOMPLETE\b/i.test(status);
}

// Parse docs/ATLAS_V1_EXECUTION_PLAN.md text → the active milestone and the first
// non-complete card (id, title, status). Bounded to each card's own block so a
// card without its own **Status:** line can never borrow a later card's status.
function parseActivePlanCard(planText) {
  const out = {
    available: false,
    active_milestone: null,
    active_card: null,
    active_card_title: null,
    active_card_status: null
  };
  if (typeof planText !== 'string' || !planText.trim()) return out;
  out.available = true;

  // The header declares it as a blockquote line: "> **Current active milestone:** …".
  const milestoneMatch = planText.match(/^\s*>?\s*\*\*Current active milestone:\*\*\s*(.+?)\s*$/m);
  if (milestoneMatch) out.active_milestone = milestoneMatch[1].trim();

  const cardRe = /^###\s+(F\d+[A-Z]?)\s+—\s+(.+?)\s*$/gm;
  let m;
  while ((m = cardRe.exec(planText)) !== null) {
    const id = m[1];
    const title = m[2].trim();
    const rest = planText.slice(cardRe.lastIndex);
    const nextHeadingIdx = rest.search(/^###\s+/m);
    const block = nextHeadingIdx >= 0 ? rest.slice(0, nextHeadingIdx) : rest;
    const statusMatch = block.match(/\*\*Status:\*\*\s*(.+?)\s*$/m);
    const status = statusMatch ? statusMatch[1].trim() : null;
    if (!isCompleteStatus(status)) {
      out.active_card = id;
      out.active_card_title = title;
      out.active_card_status = status;
      break;
    }
  }
  return out;
}

// Split the ledger into per-LT-card blocks. Each card starts at a "### … LT-<n> …"
// heading and runs to the next such heading (or EOF). LT numbering is NOT
// chronological (LT-010 was resolved after LT-011), so callers select by date.
function splitLtCards(text) {
  const headingRe = /^###\s+(?:Retired:\s+)?LT-(\d+)\b[^\n]*$/gm;
  const heads = [];
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    heads.push({ num: Number(m[1]), idx: m.index });
  }
  const cards = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].idx;
    const end = i + 1 < heads.length ? heads[i + 1].idx : text.length;
    const block = text.slice(start, end);
    cards.push({ num: heads[i].num, id: `LT-${String(heads[i].num).padStart(3, '0')}`, block, newestDate: newestDateMs(block) });
  }
  return cards;
}

function newestDateMs(block) {
  const dates = [...block.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)]
    .map(x => Date.parse(`${x[1]}-${x[2]}-${x[3]}T00:00:00Z`))
    .filter(n => !Number.isNaN(n));
  return dates.length ? Math.max(...dates) : null;
}

// Read the verdict from the card's "Owner result" cell, ignoring the empty
// "PASS / FAIL — (fill in after testing)" template. Falls back to a decisive
// "✅ PASS" card-heading marker (LT-011 records its result in the heading, not a
// cell). Never treats the template placeholder as a real PASS.
function detectVerdict(block) {
  const ownerLine = (block.match(/Owner result[^\n]*/i) || [''])[0];
  const isTemplate = /PASS\s*\/\s*FAIL\s*[—-]/i.test(ownerLine);
  if (!isTemplate && ownerLine) {
    const hasPass = /✅|\bPASS\b/i.test(ownerLine);
    const hasFail = /❌|\bFAIL\b/i.test(ownerLine);
    if (hasPass && !hasFail) return 'PASS';
    if (hasFail && !hasPass) return 'FAIL';
    if (hasPass && hasFail) return /✅/.test(ownerLine) ? 'PASS' : 'UNKNOWN';
  }
  if (/^###[^\n]*✅[^\n]*\bPASS\b/im.test(block)) return 'PASS';
  return 'UNKNOWN';
}

// Only claim a VERIFIED write when the ledger explicitly says the write was
// verified via the trusted path. "attempted"/"would write" must never read as
// verified — that is the "completed vs merely-attempted" confusion the card bans.
function detectWriteVerdict(block) {
  if (/verified[-\s]write|verify-range[^.\n]*\b(reported|confirmed|no rows remaining)\b|written via the trusted[^.\n]*verified/i.test(block)) {
    return 'verified';
  }
  if (/\battempt(?:ed|ing)?\b|would[-\s]?write|would_write/i.test(block)) return 'attempted';
  return 'unknown';
}

// Only claim a CONFIRMED undo when the ledger states the rows were actually
// removed (matched count / none remaining). A bare "undo" mention is "attempted".
function detectUndoVerdict(block) {
  if (/fully undone|deleted-row count matched|no rows remaining|zero leftover synthetic rows/i.test(block)) {
    return 'confirmed';
  }
  if (/\bundo(?:ne|ing)?\b|undo-last/i.test(block)) return 'attempted';
  return 'unknown';
}

function detectFreshnessDays(block, nowMs) {
  const dates = [...block.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)]
    .map(x => Date.parse(`${x[1]}-${x[2]}-${x[3]}T00:00:00Z`))
    .filter(n => !Number.isNaN(n));
  if (!dates.length) return null;
  const newest = Math.max(...dates);
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const days = Math.floor((now - newest) / 86400000);
  return days >= 0 ? days : 0;
}

// Parse docs/TEST_QUEUE.md text → newest LT card's verdict + write/undo verdicts +
// freshness. Newest = highest LT number. Every field defaults conservatively to
// unknown so a parse gap can never manufacture a green result.
function parseLatestTest(testQueueText, nowMs) {
  const out = {
    available: false,
    id: null,
    verdict: 'UNKNOWN',
    write_verdict: 'unknown',
    undo_verdict: 'unknown',
    freshness_days: null
  };
  if (typeof testQueueText !== 'string' || !testQueueText.trim()) return out;
  out.available = true;

  const cards = splitLtCards(testQueueText);
  if (!cards.length) return out;

  // "Latest trusted test" = the card with the most recent recorded activity
  // (newest date in its block); ties and dateless ledgers fall back to the
  // highest LT number. This is chronological, unlike raw LT numbering.
  let best = cards[0];
  for (const c of cards) {
    const cHas = c.newestDate != null;
    const bHas = best.newestDate != null;
    if (cHas && !bHas) { best = c; continue; }
    if (cHas && bHas && c.newestDate > best.newestDate) { best = c; continue; }
    if (!cHas && !bHas && c.num > best.num) { best = c; continue; }
    if (cHas && bHas && c.newestDate === best.newestDate && c.num > best.num) best = c;
  }

  out.id = best.id;
  out.verdict = detectVerdict(best.block);
  out.write_verdict = detectWriteVerdict(best.block);
  out.undo_verdict = detectUndoVerdict(best.block);
  out.freshness_days = detectFreshnessDays(best.block, nowMs);
  return out;
}

// --- Overall-status logic ---------------------------------------------------

function computeOverall(facts) {
  const reasons = [];
  const ownerCodes = [];

  if (!facts.deployed_commit || facts.deployed_commit === 'unknown') reasons.push('BUILD_UNKNOWN');
  if (!facts.plan_available) reasons.push('PLAN_SOURCE_UNAVAILABLE');
  if (!facts.test_available) reasons.push('TEST_SOURCE_UNAVAILABLE');

  if (facts.sheets_configured === false) { reasons.push('SHEETS_NOT_CONFIGURED'); ownerCodes.push('SHEETS_NOT_CONFIGURED'); }
  if (facts.llm_configured === false) { reasons.push('LLM_NOT_CONFIGURED'); ownerCodes.push('LLM_NOT_CONFIGURED'); }
  if (facts.latest_test_verdict === 'FAIL') { reasons.push('LATEST_TEST_FAILED'); ownerCodes.push('LATEST_TEST_FAILED'); }
  if (typeof facts.synthetic_rows_remaining === 'number' && facts.synthetic_rows_remaining > 0) {
    reasons.push('SYNTHETIC_ROWS_PRESENT');
    ownerCodes.push('SYNTHETIC_ROWS_PRESENT');
  }

  const hardFail = ['SHEETS_NOT_CONFIGURED', 'LLM_NOT_CONFIGURED', 'LATEST_TEST_FAILED', 'SYNTHETIC_ROWS_PRESENT']
    .some(c => reasons.includes(c));
  const unknownish = ['BUILD_UNKNOWN', 'PLAN_SOURCE_UNAVAILABLE', 'TEST_SOURCE_UNAVAILABLE']
    .some(c => reasons.includes(c));

  let overall;
  if (hardFail) {
    overall = OVERALL.DEGRADED;
  } else if (facts.latest_test_verdict !== 'PASS') {
    // Config can be perfect, but without a positive trusted test we do NOT assert
    // health — that would be a green off env vars alone.
    reasons.push('LATEST_TEST_UNCONFIRMED');
    overall = OVERALL.UNKNOWN;
  } else if (unknownish) {
    overall = OVERALL.UNKNOWN;
  } else {
    overall = OVERALL.HEALTHY;
  }

  return {
    overall_status: overall,
    status_reason_codes: dedupe(reasons),
    owner_action_required: ownerCodes.length > 0,
    owner_action_codes: dedupe(ownerCodes)
  };
}

// --- Assembler (the redaction boundary) -------------------------------------

function assembleStatus(input = {}) {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const generatedBy = input.generated_by === 'cli' ? 'cli' : 'endpoint';

  const plan = input.plan || parseActivePlanCard(input.plan_text || '');
  const test = input.test || parseLatestTest(input.test_text || '', now);

  const deployedCommit = shortCommit(input.deployed_commit);
  const sheetsConfigured = toBoolOrNull(input.sheets_configured);
  const llmConfigured = toBoolOrNull(input.llm_configured);
  const synthetic = typeof input.synthetic_rows_remaining === 'number' ? input.synthetic_rows_remaining : null;

  const unavailable = Array.isArray(input.unavailable_sources) ? input.unavailable_sources.slice() : [];
  if (!plan.available) pushUnavailable(unavailable, 'execution_plan', 'plan file unreadable');
  if (!test.available) pushUnavailable(unavailable, 'test_queue', 'test ledger unreadable');
  if (synthetic === null) {
    pushUnavailable(unavailable, 'sheet_synthetic_scan', input.synthetic_reason || 'not scanned (requires authenticated read-only sheet access)');
  }

  const overall = computeOverall({
    deployed_commit: deployedCommit,
    plan_available: plan.available,
    test_available: test.available,
    sheets_configured: sheetsConfigured,
    llm_configured: llmConfigured,
    latest_test_verdict: test.verdict,
    synthetic_rows_remaining: synthetic
  });

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date(now).toISOString(),
    generated_by: generatedBy,
    overall_status: overall.overall_status,
    status_reason_codes: overall.status_reason_codes,
    deployed_commit: deployedCommit,
    app_version: input.app_version != null ? String(input.app_version) : null,
    deployed_at: input.deployed_at != null ? String(input.deployed_at) : null,
    active_milestone: plan.active_milestone,
    active_card: plan.active_card,
    active_card_title: plan.active_card_title,
    active_card_status: plan.active_card_status,
    sheets_configured: sheetsConfigured,
    llm_configured: llmConfigured,
    llm_provider: input.llm_provider != null ? String(input.llm_provider) : null,
    llm_model: input.llm_model != null ? String(input.llm_model) : null,
    flight_recorder_enabled: input.flight_recorder_enabled === true,
    latest_test_id: test.id,
    latest_test_verdict: test.verdict,
    latest_test_write_verdict: test.write_verdict,
    latest_test_undo_verdict: test.undo_verdict,
    latest_test_freshness_days: test.freshness_days,
    synthetic_rows_remaining: synthetic,
    owner_action_required: overall.owner_action_required,
    owner_action_codes: overall.owner_action_codes,
    source_freshness: {
      execution_plan: plan.available ? 'available' : 'unavailable',
      test_queue: test.available ? 'available' : 'unavailable',
      build_info: deployedCommit && deployedCommit !== 'unknown' ? 'available' : 'unavailable'
    },
    unavailable_sources: unavailable
  };
}

// --- Best-effort environment/doc derivation (server + CLI share this) --------

// Configuration-presence only — never a live sheet read or LLM ping. Each probe
// degrades to null (unknown) rather than throwing.
function deriveServiceFacts() {
  let sheetsConfigured = null;
  try {
    sheetsConfigured = require('../sheets').getSafeSpreadsheetConfig().canVerify === true;
  } catch (_) { /* sheets module/env unavailable → unknown */ }

  let llmConfigured = null;
  let llmModel = null;
  try {
    const coach = require('./coach');
    llmConfigured = coach.isConfigured() === true;
    llmModel = coach.coachModel();
  } catch (_) { /* coach module/env unavailable → unknown */ }

  let flight = false;
  try {
    flight = require('./flightRecorder').isFlightRecorderEnabled() === true;
  } catch (_) { /* flag reader unavailable → treat as off */ }

  return {
    sheets_configured: sheetsConfigured,
    llm_configured: llmConfigured,
    llm_provider: 'gemini',
    llm_model: llmModel,
    flight_recorder_enabled: flight
  };
}

// The authoritative server-side document (public endpoint). Reads the campaign
// plan + test ledger from the deployed checkout and env-presence flags. Never
// runs an authenticated sheet scan, so synthetic_rows_remaining stays null with
// its source marked unavailable.
function buildServerStatus(deploy = {}) {
  const facts = deriveServiceFacts();
  return assembleStatus({
    generated_by: 'endpoint',
    now: deploy.now,
    deployed_commit: deploy.deployed_commit,
    app_version: deploy.app_version,
    deployed_at: deploy.deployed_at,
    plan_text: readFileSafe(PLAN_PATH) || '',
    test_text: readFileSafe(TEST_QUEUE_PATH) || '',
    sheets_configured: facts.sheets_configured,
    llm_configured: facts.llm_configured,
    llm_provider: facts.llm_provider,
    llm_model: facts.llm_model,
    flight_recorder_enabled: facts.flight_recorder_enabled,
    synthetic_rows_remaining: null
  });
}

// The offline fallback the CLI assembles when the deployed endpoint is
// unreachable. Local docs/env still answer "where are we / latest test"; the
// deployed commit is unknown offline, so health honestly degrades to unknown.
function buildLocalCliStatus(opts = {}) {
  const facts = deriveServiceFacts();
  const unavailable = [];
  pushUnavailable(unavailable, 'deployed_endpoint', opts.deployed_reason || 'deployed status endpoint unreachable — local view only');
  return assembleStatus({
    generated_by: 'cli',
    now: opts.now,
    deployed_commit: null,
    app_version: null,
    deployed_at: null,
    plan_text: readFileSafe(PLAN_PATH) || '',
    test_text: readFileSafe(TEST_QUEUE_PATH) || '',
    sheets_configured: facts.sheets_configured,
    llm_configured: facts.llm_configured,
    llm_provider: facts.llm_provider,
    llm_model: facts.llm_model,
    flight_recorder_enabled: facts.flight_recorder_enabled,
    synthetic_rows_remaining: null,
    unavailable_sources: unavailable
  });
}

// --- Human rendering (must agree with the JSON it is derived from) -----------

function fmtBool(v, onWord, offWord) {
  if (v === true) return onWord;
  if (v === false) return offWord;
  return 'unknown';
}

function renderHuman(status) {
  const s = status || {};
  const lines = [];
  lines.push(`Atlas Control Tower — ${String(s.overall_status || 'unknown').toUpperCase()}`);
  lines.push(`  Deployed:    ${s.deployed_commit || 'unknown'}${s.app_version ? ` (${s.app_version})` : ''}`);
  const cardBits = [s.active_card, s.active_card_title].filter(Boolean).join(' ');
  lines.push(`  Campaign:    ${cardBits || 'unknown'}${s.active_card_status ? ` [${s.active_card_status}]` : ''}${s.active_milestone ? ` · ${s.active_milestone}` : ''}`);
  lines.push(`  Services:    sheets=${fmtBool(s.sheets_configured, 'configured', 'MISSING')} · llm=${fmtBool(s.llm_configured, 'configured', 'MISSING')}${s.llm_model ? ` (${s.llm_model})` : ''} · flight_recorder=${s.flight_recorder_enabled ? 'on' : 'off'}`);
  const fresh = s.latest_test_freshness_days == null ? '' : ` · ${s.latest_test_freshness_days}d ago`;
  lines.push(`  Latest test: ${s.latest_test_id || 'none'} ${s.latest_test_verdict || 'UNKNOWN'} (write=${s.latest_test_write_verdict || 'unknown'}, undo=${s.latest_test_undo_verdict || 'unknown'}${fresh})`);
  lines.push(`  Synthetic rows remaining: ${s.synthetic_rows_remaining == null ? 'unknown (not scanned)' : s.synthetic_rows_remaining}`);
  lines.push(`  Owner action: ${s.owner_action_required ? (s.owner_action_codes || []).join(', ') || 'yes' : 'none'}`);
  const unavail = (s.unavailable_sources || []).map(x => x && x.source).filter(Boolean);
  if (unavail.length) lines.push(`  Unavailable:  ${unavail.join(', ')}`);
  if ((s.status_reason_codes || []).length) lines.push(`  Reasons:      ${s.status_reason_codes.join(', ')}`);
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  ALLOWED_KEYS,
  OVERALL,
  PLAN_PATH,
  TEST_QUEUE_PATH,
  parseActivePlanCard,
  parseLatestTest,
  computeOverall,
  assembleStatus,
  deriveServiceFacts,
  buildServerStatus,
  buildLocalCliStatus,
  renderHuman,
  readFileSafe
};
