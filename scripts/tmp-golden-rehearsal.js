#!/usr/bin/env node
'use strict';

// TEMPORARY rehearsal driver (owner ruling 2026-07-31, item 9). Lives on a throwaway
// branch, is never merged to main, and builds nothing reusable.
//
// It replays the KNOWN Golden Session beats from the single canonical fixture
// (test/fixtures/goldenSession.js) through the real production UI, READ-ONLY:
//
//   • read-only beats  → composer + #preview-btn (a test_mode dry-run)
//   • write-capable beats (client:start-this-plan / revise / closeout / seal)
//                      → NOT executed. There is no branch below that can drive one.
//
// Every safety layer of the merged harness is reused verbatim rather than
// reimplemented: synthetic provenance headers, the session login, the
// authenticated-content privacy posture, the write blockade, and the bounded
// settle condition all come from scripts/live-retest.js.

const path = require('path');
const {
  installWriteBlockade, authenticateContext, shouldProceedToNavigation,
  waitForSettledResponse, THINKING_MARKER, SYNTHETIC_HEADERS, SYNTHETIC_ORIGIN, ACCESS_CODE_ENV
} = require('./live-retest');
const { GOLDEN_SESSION } = require('../test/fixtures/goldenSession');

const READ_ONLY_SEAMS = new Set(['coach/message:plan', 'coach/message:block', 'coach/message:set', 'coach/ask']);

// Render a beat's own fixture facts as composer text. Slash notation is the parser
// contract (`225 5/2` = 225 lb × 5 reps @ RIR 2); an absent RIR is never fabricated.
function beatInput(beat) {
  const f = beat.facts || {};
  if (beat.seam === 'coach/ask') return 'why?';
  if (beat.seam === 'coach/message:plan') return f.exerciseName ? `what's the plan for ${f.exerciseName} today?` : null;
  if (!f.exerciseName || !Array.isArray(f.todaySets) || !f.todaySets.length) return null;
  const sets = f.todaySets.map(s => (s.rir === undefined || s.rir === null ? `${s.weight} ${s.reps}` : `${s.weight} ${s.reps}/${s.rir}`));
  return `${f.exerciseName} ${sets.join(' ')}`;
}

async function main() {
  const baseUrl = (process.env.ATLAS_BASE_URL || '').trim().replace(/\/+$/, '');
  const accessCode = (process.env[ACCESS_CODE_ENV] || '').trim() || null;
  if (!baseUrl) { console.error('ERROR: ATLAS_BASE_URL required'); return 1; }

  const { chromium } = require('@playwright/test');
  const executablePath = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  const blocked = [];
  const results = [];
  let exitCode = 0;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.setExtraHTTPHeaders({ ...SYNTHETIC_HEADERS });
    console.log(`[rehearsal] synthetic provenance: x-atlas-request-origin: ${SYNTHETIC_ORIGIN}`);
    await installWriteBlockade(context, { onBlocked: b => blocked.push(b) });

    const auth = await authenticateContext({ baseUrl, accessCode, context });
    const gate = shouldProceedToNavigation(auth);
    if (!gate.proceed) { console.error(`[rehearsal] ${gate.reason}`); return 1; }
    console.log(`[rehearsal] ${gate.reason}`);

    const page = await context.newPage();
    const res = await page.goto(`${baseUrl}/app/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.log(`[rehearsal] app HTTP ${res ? res.status() : 'no-response'}`);
    await page.locator('#workout-text').waitFor({ state: 'visible', timeout: 15000 });

    const bubbles = page.locator('#thread-messages .chat-bubble-atlas');
    for (const [i, beat] of GOLDEN_SESSION.beats.entries()) {
      const n = i + 1;
      if (!READ_ONLY_SEAMS.has(beat.seam)) {
        console.log(`[beat ${n}] ${beat.beat} [${beat.seam}]: WRITE-CAPABLE — not executed (no executor; blockade also active)`);
        results.push({ n, beat: beat.beat, seam: beat.seam, executed: false, blocked: true });
        continue;
      }
      const input = beatInput(beat);
      if (!input) {
        console.error(`[beat ${n}] ${beat.beat}: no derivable input — FIXTURE ERROR`);
        results.push({ n, beat: beat.beat, seam: beat.seam, executed: false, error: 'no_input' });
        exitCode = 2;
        continue;
      }
      const composer = page.locator('#workout-text');
      await composer.fill(input);
      const accepted = (await composer.inputValue()) === input;
      const baseline = await bubbles.count().catch(() => 0);
      const t0 = Date.now();
      await page.locator('#preview-btn').click();
      const settle = await waitForSettledResponse({
        readReply: async () => {
          const c = await bubbles.count().catch(() => 0);
          if (c <= baseline) return { present: false, thinking: false, text: '' };
          const text = await bubbles.last().innerText().catch(() => '');
          return { present: true, thinking: text.includes(THINKING_MARKER), text };
        },
        sleep: ms => page.waitForTimeout(ms)
      });
      const ms = Date.now() - t0;
      // Length + booleans only — an authenticated run renders the owner's private surface.
      const row = {
        n, beat: beat.beat, seam: beat.seam, executed: true, ui_accepted: accepted,
        settled: settle.settled, settle_reason: settle.reason, browser_ms: ms,
        reply_length: String(settle.text || '').length
      };
      results.push(row);
      console.log(`[beat ${n}] ${beat.beat} [${beat.seam}]: ui_accepted=${accepted} settled=${settle.settled} (${settle.reason}) ${ms}ms reply_length=${row.reply_length}`);
      if (!settle.settled) exitCode = 2;
    }

    const approveDisabled = await page.locator('#approve-btn').isDisabled().catch(() => null);
    console.log(`[rehearsal] #approve-btn disabled=${approveDisabled} (never clicked)`);
  } catch (err) {
    exitCode = 1;
    console.error(`[rehearsal] FAILED: ${(err && err.name) || 'Error'} — details withheld (authenticated run)`);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('─'.repeat(72));
  console.log('REHEARSAL RESULT');
  for (const r of results) {
    console.log(`  ${String(r.n).padStart(2)} ${r.blocked ? 'BLOCKED   ' : (r.settled ? 'SETTLED   ' : 'UNSETTLED ')} ${r.beat.padEnd(28)} ${r.browser_ms != null ? r.browser_ms + 'ms' : ''}`);
  }
  console.log(`  blocked write requests: ${blocked.length}${blocked.length ? ' → ' + [...new Set(blocked.map(b => b.path))].join(', ') : ''}`);
  console.log(`  executed beats: ${results.filter(r => r.executed).length} · settled: ${results.filter(r => r.settled).length} · write-capable not executed: ${results.filter(r => r.blocked).length}`);
  console.log('─'.repeat(72));
  return exitCode;
}

main().then(c => process.exit(c)).catch(e => { console.error(`FATAL: ${(e && e.name) || e}`); process.exit(1); });
