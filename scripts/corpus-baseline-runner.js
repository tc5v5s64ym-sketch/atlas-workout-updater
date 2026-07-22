#!/usr/bin/env node
'use strict';

// Atlas Corpus Baseline Runner — owner side-instrument (Atlas Recovery Campaign, Phase 3;
// recorded in the execution plan's CAMPAIGN STATE).
//
// Replays all fifteen Soul Corpus V2 sessions turn-by-turn against the REAL read-only
// coach code and scores an honest behavioural baseline against the synthesis's 35-capability
// matrix. Publishes docs/verification/CORPUS_BASELINE_SCOREBOARD.md.
//
//   npm run atlas:corpus-baseline                 # score + write the scoreboard
//   npm run atlas:corpus-baseline -- --json       # machine-readable result to stdout
//   npm run atlas:corpus-baseline -- --stdout     # print the markdown, do not write
//   npm run atlas:corpus-baseline -- --out <path> # write to a specific path
//   npm run atlas:corpus-baseline -- --append --phase "Phase 4"   # append a rerun section
//
// SEGREGATION / SAFETY (the invariants this instrument must never break):
//   • TEST MODE: sheets.js is require-cache stubbed; appendRows THROWS, so a live write is
//     impossible. vision + the coach LLM are stubbed deterministically.
//   • NO SHADOW CONTAMINATION: ATLAS_INTERACTION_TRACE is force-unset, so the real
//     [coach-turn-shadow] log stream / Coach_Shadow tab / divergence pipeline never see a
//     corpus turn. The CoachTurnPacket is assembled OUT OF BAND (assembleShadowPacket)
//     purely to score it — it is never logged to the shadow stream.
//   • CORPUS-SYNTHETIC: every turn id is `corpus-synthetic:*` and every observation is
//     tagged corpus-synthetic (services/corpusBaseline.deriveTurnObservation).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'verification', 'CORPUS_BASELINE_SCOREBOARD.md');

// ── test-mode env, BEFORE anything loads the app ──
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ATLAS_API_KEY = process.env.ATLAS_API_KEY || 'corpus-baseline-key';
process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'stub-private-key-sheets-is-stubbed';
// Hard segregation: the shadow log stream must never see a corpus turn.
delete process.env.ATLAS_INTERACTION_TRACE;
// The replay fires hundreds of read-only requests; lift the /api rate cap so repeated
// runs (e.g. the determinism test) can't trip a 429 and skew the deterministic score.
process.env.ATLAS_API_RATE_LIMIT_MAX = process.env.ATLAS_API_RATE_LIMIT_MAX || '1000000';
process.env.ATLAS_API_RATE_LIMIT_WINDOW_MS = process.env.ATLAS_API_RATE_LIMIT_WINDOW_MS || '60000';

// ── require-cache stubs (mirror test/soulGoldenTranscripts.test.js) ──
const sheetState = { appendCalls: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('corpus-baseline: appendRows must never be called (read-only replay)');
  },
  deleteRowsByRange: async () => {},
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};
const fakeVision = { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) };
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: fakeVision,
};
const fakeCoach = {
  isConfigured: () => true,
  coachModel: () => 'stub-coach',
  generateCoachMessage: async () => 'corpus-synthetic deterministic line',
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const { app } = require('../index');
const { assembleShadowPacket } = require('../services/coachTurnPacketShadow');
const corpusBaseline = require('../services/corpusBaseline');
const { SESSIONS } = require('../test/fixtures/corpusBaseline/sessions');

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { json: a.includes('--json'), stdout: a.includes('--stdout'), append: a.includes('--append') };
  const outIdx = a.indexOf('--out');
  out.outPath = outIdx !== -1 && a[outIdx + 1] ? path.resolve(a[outIdx + 1]) : DEFAULT_OUT;
  const phaseIdx = a.indexOf('--phase');
  out.phase = phaseIdx !== -1 && a[phaseIdx + 1] ? a[phaseIdx + 1] : null;
  return out;
}

// Drive one turn through the real read-only seam and assemble its packet out of band.
async function replayTurn(baseUrl, session, turn, index) {
  const headers = { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY };
  let responseBody = {};
  try {
    if (turn.kind === 'chat') {
      const res = await fetch(`${baseUrl}/api/coach/chat`, {
        method: 'POST', headers, body: JSON.stringify({ message: turn.text, context: {} }),
      });
      responseBody = await res.json().catch(() => ({}));
    } else {
      const kind = turn.kind === 'plan' ? 'plan' : (turn.kind === 'set' ? 'set' : 'block');
      const res = await fetch(`${baseUrl}/api/coach/message`, {
        method: 'POST', headers, body: JSON.stringify({ kind, facts: turn.facts || {} }),
      });
      responseBody = await res.json().catch(() => ({}));
    }
  } catch (e) {
    responseBody = { ok: false, data: { error: String(e && e.message || e) } };
  }
  // Assemble the CoachTurnPacket exactly as the Phase-3 shadow does — out of band, tagged
  // corpus-synthetic, never logged to the shadow stream.
  let packet = null;
  try {
    const assembled = assembleShadowPacket({
      turnId: `corpus-synthetic:${session.id}:${index}`,
      profileGoal: session.athlete && session.athlete.profileGoal != null ? session.athlete.profileGoal : null,
    });
    packet = { valid: assembled.valid, embedded: null };
    // Re-derive embedded presence from the assembled packet (same shape the shadow logs).
    const pkt = assembled.packet || {};
    packet.embedded = {
      athlete_profile_goal: !!(pkt.athlete && pkt.athlete.profile_goal != null),
      session: pkt.session != null,
      exercises: Array.isArray(pkt.exercises) ? pkt.exercises.length : 0,
      decision: pkt.decision != null,
      safety: pkt.safety != null,
      closeout: pkt.closeout != null,
    };
  } catch (_) { packet = null; }
  return corpusBaseline.deriveTurnObservation(turn, responseBody, packet);
}

// Boot the real app, replay every session's turns, return the raw observations. Exposed
// so the runner test can assert segregation (corpus-synthetic tagging) and no-write safety.
async function replayAll() {
  // Silence the app's per-request logger so stdout stays clean for --json / the summary.
  const saved = { log: console.log, info: console.info, warn: console.warn, debug: console.debug };
  console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.debug = () => {};
  const restore = () => { console.log = saved.log; console.info = saved.info; console.warn = saved.warn; console.debug = saved.debug; };
  const server = await new Promise((resolve) => {
    const l = app.listen(0, '127.0.0.1', () => resolve(l));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const observationsBySession = {};
  try {
    for (const session of SESSIONS) {
      const obs = [];
      for (let i = 0; i < session.turns.length; i += 1) {
        obs.push(await replayTurn(baseUrl, session, session.turns[i], i));
      }
      observationsBySession[session.id] = obs;
    }
  } finally {
    await new Promise((res) => server.close(() => res()));
    restore();
  }
  return observationsBySession;
}

async function run() {
  const observationsBySession = await replayAll();
  // Hard safety assertion: the read-only replay must never have attempted a write.
  if (sheetState.appendCalls.length > 0) {
    throw new Error(`corpus-baseline: ${sheetState.appendCalls.length} write attempt(s) during a read-only replay — aborting`);
  }
  return corpusBaseline.scoreCorpus(SESSIONS, observationsBySession);
}

function todayISO() {
  // Scripts (unlike Workflow scripts) may use the clock. Date only, so the committed
  // scoreboard is dated but its SCORE TABLES stay deterministic (the test asserts on
  // scoreCorpus(), not on this date line).
  return new Date().toISOString().slice(0, 10);
}

function writeScoreboard(result, opts) {
  const recorded = todayISO();
  if (opts.append) {
    const phase = opts.phase || 'Rerun';
    const section = corpusBaseline.formatRerunSection(result, { phase, recorded });
    let existing = '';
    try { existing = fs.readFileSync(opts.outPath, 'utf8'); } catch (_) { existing = ''; }
    if (!existing) {
      // No baseline yet — write a full doc, then the rerun section.
      existing = corpusBaseline.formatScoreboardMarkdown(result, { phase: 'BASELINE (pre-Phase-4)', recorded });
    }
    const marker = '\n---\n_This scoreboard is generated.';
    const at = existing.indexOf(marker);
    const body = at !== -1
      ? existing.slice(0, at) + '\n' + section + existing.slice(at)
      : existing + '\n' + section;
    fs.writeFileSync(opts.outPath, body);
    return opts.outPath;
  }
  const md = corpusBaseline.formatScoreboardMarkdown(result, { phase: 'BASELINE (pre-Phase-4)', recorded });
  fs.writeFileSync(opts.outPath, md);
  return opts.outPath;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const result = await run();
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(corpusBaseline.summarizeForCli(result) + '\n');
  if (opts.stdout) {
    process.stdout.write('\n' + corpusBaseline.formatScoreboardMarkdown(result, { phase: 'BASELINE (pre-Phase-4)', recorded: todayISO() }) + '\n');
    return 0;
  }
  const written = writeScoreboard(result, opts);
  process.stdout.write(`\nScoreboard written: ${path.relative(ROOT, written)}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`corpus-baseline runner failed: ${e && e.stack || e}\n`);
    process.exit(1);
  });
}

module.exports = { main, run, replayAll, _sheetState: sheetState };
