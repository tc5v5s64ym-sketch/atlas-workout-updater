'use strict';

// PR-H — explicit session closeout capture (src/app/planCloseout.js). Pure/DI; runs
// in Node with no DOM. Pins: identity is the accepted session's immutable session_id
// + plan_version; fail-closed for a non-accepted session or an invalid status; the
// frozen finalized|abandoned vocabulary; a sidecar failure never throws and never
// blocks the local close/discard.

const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => { mod = await import('../src/app/planCloseout.js'); });

const PLAN = { accepted: true, session_id: 'S1', session_date: '2026-07-10', plan_version: 'pv_x1' };

test('buildCloseoutPayload: finalized / abandoned → identity + status', () => {
  const fin = mod.buildCloseoutPayload(PLAN, 'finalized');
  assert.deepEqual(fin, { session_id: 'S1', session_date: '2026-07-10', plan_version: 'pv_x1', closeout_status: 'finalized' });
  const ab = mod.buildCloseoutPayload(PLAN, 'abandoned');
  assert.equal(ab.closeout_status, 'abandoned');
});

test('buildCloseoutPayload fails closed: unaccepted plan / missing plan_version / missing session_id / bad status → null', () => {
  assert.equal(mod.buildCloseoutPayload({ ...PLAN, accepted: false }, 'finalized'), null);
  assert.equal(mod.buildCloseoutPayload({ ...PLAN, plan_version: '' }, 'finalized'), null);
  assert.equal(mod.buildCloseoutPayload({ ...PLAN, session_id: '' }, 'finalized'), null);
  assert.equal(mod.buildCloseoutPayload(PLAN, 'done'), null);
  assert.equal(mod.buildCloseoutPayload(PLAN, 'completed'), null); // not a closeout status
  assert.equal(mod.buildCloseoutPayload(null, 'finalized'), null);
});

test('CLOSEOUT_STATUSES is the frozen finalized|abandoned vocabulary', () => {
  assert.deepEqual(mod.CLOSEOUT_STATUSES, ['finalized', 'abandoned']);
});

test('runCloseout: happy path posts the payload and reports captured', async () => {
  const posted = [];
  const r = await mod.runCloseout(PLAN, 'finalized', {
    postCloseout: async (p) => { posted.push(p); return { data: { session_plans: { captured: true, status: 'written' } } }; },
  });
  assert.equal(r.emitted, true);
  assert.equal(r.captured, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].closeout_status, 'finalized');
});

test('runCloseout: no identity → not emitted, never posts', async () => {
  let posts = 0;
  const r = await mod.runCloseout({ ...PLAN, accepted: false }, 'finalized', { postCloseout: async () => { posts += 1; return {}; } });
  assert.equal(r.emitted, false);
  assert.equal(r.reason, 'no_identity');
  assert.equal(posts, 0);
});

test('runCloseout: a sidecar failure is isolated — emitted:true, captured:false, never throws', async () => {
  const r = await mod.runCloseout(PLAN, 'abandoned', { postCloseout: async () => { throw new Error('network down'); } });
  assert.equal(r.emitted, true);
  assert.equal(r.captured, false);
});

test('runCloseout: a disabled/non-captured envelope → emitted:true, captured:false', async () => {
  const r = await mod.runCloseout(PLAN, 'finalized', {
    postCloseout: async () => ({ data: { session_plans: { captured: false, status: 'disabled' } } }),
  });
  assert.equal(r.emitted, true);
  assert.equal(r.captured, false);
});
