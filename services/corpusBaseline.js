'use strict';

// Corpus Baseline — the pure scorer + reporter behind the Corpus Baseline Runner.
//
// Owner side-instrument (Atlas Recovery Campaign, Phase 3; recorded in CAMPAIGN STATE).
// The CLI wrapper (scripts/corpus-baseline-runner.js) boots the REAL read-only coach app
// in test mode, replays the fifteen Soul Corpus V2 sessions turn-by-turn, and feeds the
// real route responses + the real assembled CoachTurnPacket into THIS module, which:
//   1. derives a per-turn observation (tagged corpus-synthetic),
//   2. reduces a session's observations to a detector bundle,
//   3. scores each session behaviourally against the synthesis's 35-capability matrix,
//   4. formats the scoreboard document.
//
// PURE / DETERMINISTIC: no I/O, no clock, no randomness (the CLI owns those). scoreCorpus
// is a total function of its inputs, so the runner test can assert run-twice-identical.
//
// HONESTY: nothing here fabricates a score. A capability rises above 'absent' only when
// the REAL engine + REAL packet demonstrably produced its signal on the replayed turns
// (corpusBaselineRubric.js documents each rule). Mirrors the divergence tool's contract:
// no observation ⇒ 'absent', never a false green. We round DOWN.

const { CAPABILITIES } = require('./corpusBaselineRubric');

const CORPUS_SYNTHETIC_TAG = 'corpus-synthetic';
const LEVELS = { absent: 0, partial: 1, pass: 2 };
const MARK = { pass: '✅ pass', partial: '🟡 partial', absent: '⬜ absent' };

function _num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function _obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

// ── 1. Per-turn observation, derived from the REAL response + REAL assembled packet ──
// `turn`     — the fixture turn (kind, facts, …).
// `response` — the route response body ({ ok, data: {…} }) or a thrown-error surrogate.
// `packet`   — { valid, embedded:{athlete_profile_goal, session, exercises, decision, safety, closeout} }
//              from the real coachTurnPacketShadow.assembleShadowPacket, or null.
function deriveTurnObservation(turn, response, packet) {
  const t = _obj(turn);
  const data = _obj(_obj(response).data);
  const facts = _obj(t.facts);
  const rec = _obj(facts.rec);
  const sets = Array.isArray(facts.todaySets) ? facts.todaySets : [];

  const isBlock = t.kind === 'block' || t.kind === 'set';
  const hadSubstitution = !!facts.substitution;
  const hadRedline = sets.some((s) => _num(_obj(s).rir) === 0);
  const clientElevation = _obj(rec.progression_verdict).level === 'new_ground'
    || _obj(rec.effort_verdict).level === 'new_ground';
  const isSignalBlock = isBlock && (hadSubstitution || hadRedline || clientElevation);
  const isRoutineBlock = isBlock && !isSignalBlock;

  const noteTier = data.note_tier != null ? data.note_tier : null;
  const noteTrigger = typeof data.note_trigger === 'string' ? data.note_trigger : null;
  const surfaced = isBlock && noteTier != null && noteTier !== 'ack_only';
  const messagePresent = typeof data.message === 'string' && data.message.trim().length > 0;

  const emb = _obj(_obj(packet).embedded);

  return {
    corpus_synthetic: true,
    tag: CORPUS_SYNTHETIC_TAG,
    kind: t.kind,
    routine_block: isRoutineBlock,
    signal_block: isSignalBlock,
    had_substitution: hadSubstitution,
    client_elevation: clientElevation,
    note_tier: noteTier,
    note_trigger: noteTrigger,
    surfaced,
    silence: isBlock && noteTier === 'ack_only',
    configured: data.configured === false ? false : (data.configured === true ? true : null),
    error_present: !!data.error,
    message_present: messagePresent,
    // future route signals — DERIVED (false today; flip when a later phase emits the field)
    readiness_applied: data.readiness_applied === true,
    knowledge_ids: Array.isArray(data.knowledge_ids) ? data.knowledge_ids.length : 0,
    signal_flags: Array.isArray(data.signal_flags) && data.signal_flags.length > 0,
    memory_read: !!data.memory_read,
    persona_authored: data.persona_authored === true,
    increment_table: data.increment_table === true,
    e1rm: data.e1rm != null && !!data.e1rm_method,
    comparable_session: data.comparable_session != null,
    armed_items: Array.isArray(data.armed_items) && data.armed_items.length > 0,
    finder_mode: data.finder_mode === true,
    session_repair: data.session_repair === true,
    adherence_ledger: data.adherence_ledger != null,
    volume_ledger: data.volume_ledger != null,
    packet_valid: _obj(packet).valid === true,
    packet: {
      athleteGoal: emb.athlete_profile_goal === true,
      session: emb.session === true,
      decision: emb.decision === true,
      safety: emb.safety === true,
      exercises: _num(emb.exercises) ? emb.exercises > 0 : false,
      closeout: emb.closeout === true,
    },
  };
}

// ── 2. Reduce a session's observations to the detector bundle score() consumes ──
function buildDetectors(observations) {
  const obs = Array.isArray(observations) ? observations : [];
  const any = (pred) => obs.some(pred);
  const packet = {
    athleteGoal: any((o) => o.packet && o.packet.athleteGoal),
    session: any((o) => o.packet && o.packet.session),
    decision: any((o) => o.packet && o.packet.decision),
    safety: any((o) => o.packet && o.packet.safety),
    exercises: any((o) => o.packet && o.packet.exercises),
    closeout: any((o) => o.packet && o.packet.closeout),
  };
  return {
    silenceOnRoutine: any((o) => o.routine_block && o.silence),
    surfaceOnSignal: any((o) => o.signal_block && o.surfaced && (o.message_present || o.note_trigger)),
    substitutionSurfaced: any((o) => o.had_substitution && o.surfaced),
    safetySurfaced: any((o) => o.note_trigger && /safe/i.test(o.note_trigger)),
    praiseGated: any((o) => o.client_elevation && o.note_tier === 'ack_only'),
    honestDegrade: any((o) => (o.configured === false || o.error_present) && !o.message_present),
    engineOwnsNumber: any((o) => o.client_elevation && o.note_tier === 'ack_only'),
    readinessApplied: any((o) => o.readiness_applied),
    knowledgeRetrieved: any((o) => o.knowledge_ids > 0),
    signalFlags: any((o) => o.signal_flags),
    memoryRead: any((o) => o.memory_read),
    personaAuthored: any((o) => o.persona_authored),
    incrementTable: any((o) => o.increment_table),
    e1rmStandardized: any((o) => o.e1rm),
    comparableSelector: any((o) => o.comparable_session),
    armedScheduler: any((o) => o.armed_items),
    finderMode: any((o) => o.finder_mode),
    sessionRepair: any((o) => o.session_repair),
    adherenceLedger: any((o) => o.adherence_ledger),
    volumeLedger: any((o) => o.volume_ledger),
    packet,
  };
}

function capabilitiesForSession(sessionId) {
  return CAPABILITIES.filter((c) => c.sessions.includes(sessionId) || c.sessions.includes('ALL'));
}

// ── 3. Score one session ──
function scoreSession(session, observations) {
  const detectors = buildDetectors(observations);
  const caps = capabilitiesForSession(session.id).map((c) => {
    let status = 'absent';
    try { status = c.score(detectors) || 'absent'; } catch (_) { status = 'absent'; }
    if (!(status in LEVELS)) status = 'absent';
    return { num: c.num, key: c.key, name: c.name, status };
  });
  const counts = { pass: 0, partial: 0, absent: 0 };
  for (const c of caps) counts[c.status] += 1;
  return {
    id: session.id, name: session.name, part: session.part,
    turns: Array.isArray(observations) ? observations.length : 0,
    detectors, capabilities: caps, counts,
  };
}

// ── 4. Score the whole corpus ──
// `observationsBySession` — { [sessionId]: observation[] }.
function scoreCorpus(sessions, observationsBySession) {
  const byId = _obj(observationsBySession);
  const sessionResults = sessions.map((s) => scoreSession(s, byId[s.id] || []));

  // Per-capability aggregate = the best (rounded-down) status the current code reaches on
  // any session that demonstrates it. Bounded by each score()'s own ceiling, so it cannot
  // overstate. Absent when no demonstrating session produced the signal.
  const perCapability = CAPABILITIES.map((c) => {
    const demoing = sessionResults.filter((sr) => c.sessions.includes(sr.id) || c.sessions.includes('ALL'));
    let best = 'absent';
    const perSession = {};
    for (const sr of demoing) {
      const hit = sr.capabilities.find((x) => x.num === c.num);
      const st = hit ? hit.status : 'absent';
      perSession[sr.id] = st;
      if (LEVELS[st] > LEVELS[best]) best = st;
    }
    return {
      num: c.num, key: c.key, name: c.name, part: c.part,
      sessions: c.sessions, builds: c.builds, status: best, perSession,
    };
  });

  const capCounts = { pass: 0, partial: 0, absent: 0 };
  for (const c of perCapability) capCounts[c.status] += 1;

  return {
    total_capabilities: CAPABILITIES.length,
    total_sessions: sessionResults.length,
    capability_counts: capCounts,
    capabilities: perCapability,
    sessions: sessionResults,
  };
}

// ── 5. Format the scoreboard document (deterministic; caller supplies dated meta) ──
function _pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }

function formatScoreboardMarkdown(result, meta = {}) {
  const r = result || {};
  const cc = r.capability_counts || { pass: 0, partial: 0, absent: 0 };
  const total = r.total_capabilities || 0;
  const phaseLabel = meta.phase || 'BASELINE (pre-Phase-4)';
  const recorded = meta.recorded || '(date set by the runner at write time)';
  const L = [];

  L.push('# Atlas Soul Corpus V2 — Baseline Scoreboard');
  L.push('');
  L.push('> **Generated by the Corpus Baseline Runner** (`npm run atlas:corpus-baseline`). Do not hand-edit the tables — rerun the instrument.');
  L.push('>');
  L.push('> The runner replays all fifteen Soul Corpus V2 sessions turn-by-turn against the **real read-only coach code** (`POST /api/coach/message` + `/api/coach/chat`) with **synthetic athlete profiles** injected in **test mode** — sheets stubbed, **never a live write** — and every turn tagged **corpus-synthetic**, fully **segregated** from the real `[coach-turn-shadow]` / divergence data (the shadow log stream is never enabled). Each of the synthesis\'s **35 behavioral capabilities** is scored **pass / partial / absent** from the real deterministic engine + the real assembled **CoachTurnPacket** — behaviour, not wording. Scores are **rounded down**; the stubbed LLM\'s phrasing is never credited.');
  L.push('>');
  L.push('> Reference input: [`docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md`](../reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md) · [`…_SYNTHESIS.md`](../reference/ATLAS_SOUL_CORPUS_V2_SYNTHESIS.md) · [`…_SECTION_F_RECONCILIATION.md`](../reference/ATLAS_SOUL_CORPUS_V2_SECTION_F_RECONCILIATION.md). This is a **measurement**, not a work-selection plan — the execution plan governs.');
  L.push('');
  L.push(`**Run:** ${phaseLabel}  ·  **Recorded:** ${recorded}`);
  L.push('');
  L.push('## Headline');
  L.push('');
  L.push(`Of **${total}** capabilities the corpus demonstrates, the current read-only code scores:`);
  L.push('');
  L.push(`- ✅ **pass — ${cc.pass}** (${_pct(cc.pass, total)}%)`);
  L.push(`- 🟡 **partial — ${cc.partial}** (${_pct(cc.partial, total)}%)`);
  L.push(`- ⬜ **absent — ${cc.absent}** (${_pct(cc.absent, total)}%)`);
  L.push('');
  L.push('A low baseline is expected and honest — most coaching capabilities live in later phases (packet consumption in Phase 4; identity/safety/context in Phase 5; knowledge in Phase 6). Each absent row names the phase (or BACKLOG intake) that builds it, so re-running at the close of Phases 4, 6, and 7 shows movement against a fixed rubric.');
  L.push('');

  // Per-capability table
  L.push('## Per-capability baseline');
  L.push('');
  L.push('| # | Capability | Part | Demonstrated in | Baseline | Builds when absent |');
  L.push('|---|---|---|---|---|---|');
  for (const c of (r.capabilities || [])) {
    const demo = c.sessions.join(', ');
    L.push(`| ${c.num} | ${c.name} | ${c.part} | ${demo} | ${MARK[c.status]} | ${c.builds} |`);
  }
  L.push('');

  // Per-session table
  L.push('## Per-session baseline');
  L.push('');
  L.push('Each session is scored only on the capabilities the synthesis says it demonstrates.');
  L.push('');
  L.push('| Session | Part | Turns | ✅ | 🟡 | ⬜ | Present today (per-session) |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of (r.sessions || [])) {
    const present = s.capabilities.filter((c) => c.status !== 'absent').map((c) => `#${c.num} ${MARK[c.status].split(' ')[0]}`).join(', ') || '—';
    L.push(`| ${s.id} ${s.name} | ${s.part} | ${s.turns} | ${s.counts.pass} | ${s.counts.partial} | ${s.counts.absent} | ${present} |`);
  }
  L.push('');

  // What's present + rerun note
  const present = (r.capabilities || []).filter((c) => c.status !== 'absent');
  L.push('## What the current code already does');
  L.push('');
  if (present.length === 0) {
    L.push('_Nothing scored above absent on this run._');
  } else {
    for (const c of present) L.push(`- ${MARK[c.status]} — **#${c.num} ${c.name}.** ${c.builds}`);
  }
  L.push('');
  L.push('## Rerun cadence (phase-boundary instrument)');
  L.push('');
  L.push('Per the owner side-instrument insertion recorded in the execution plan\'s `CAMPAIGN STATE`, the runner reruns and **appends a new dated section below** at the close of **Phase 4**, **Phase 6**, and **Phase 7** — the same rubric against the same real code, so the deltas are honest. The absent→partial→pass movement is the campaign converging on the corpus.');
  L.push('');
  L.push('---');
  L.push('_This scoreboard is generated. Segregation invariant: corpus-synthetic, test-mode, no live write, no real shadow/divergence contamination._');
  return L.join('\n');
}

// Compact section appended to the scoreboard when the runner reruns at a phase boundary
// (Phase 4/6/7 close). Deterministic; the caller supplies the dated meta.
function formatRerunSection(result, meta = {}) {
  const r = result || {};
  const cc = r.capability_counts || { pass: 0, partial: 0, absent: 0 };
  const total = r.total_capabilities || 0;
  const phaseLabel = meta.phase || '(phase unset)';
  const recorded = meta.recorded || '(date set by the runner)';
  const L = [];
  L.push(`## Rerun — ${phaseLabel} (${recorded})`);
  L.push('');
  L.push(`Headline: ✅ pass **${cc.pass}** · 🟡 partial **${cc.partial}** · ⬜ absent **${cc.absent}** of ${total}.`);
  L.push('');
  const moved = (r.capabilities || []).filter((c) => c.status !== 'absent');
  if (moved.length === 0) {
    L.push('_No capability scored above absent on this rerun._');
  } else {
    L.push('| # | Capability | Status |');
    L.push('|---|---|---|');
    for (const c of moved) L.push(`| ${c.num} | ${c.name} | ${MARK[c.status]} |`);
  }
  L.push('');
  return L.join('\n');
}

function summarizeForCli(result) {
  const r = result || {};
  const cc = r.capability_counts || { pass: 0, partial: 0, absent: 0 };
  const lines = [];
  lines.push(`Corpus Baseline — ${r.total_sessions || 0} sessions, ${r.total_capabilities || 0} capabilities.`);
  lines.push(`  ✅ pass ${cc.pass}   🟡 partial ${cc.partial}   ⬜ absent ${cc.absent}`);
  for (const c of (r.capabilities || []).filter((x) => x.status !== 'absent')) {
    lines.push(`  ${MARK[c.status]}  #${c.num} ${c.name}`);
  }
  return lines.join('\n');
}

module.exports = {
  CORPUS_SYNTHETIC_TAG,
  deriveTurnObservation,
  buildDetectors,
  capabilitiesForSession,
  scoreSession,
  scoreCorpus,
  formatScoreboardMarkdown,
  formatRerunSection,
  summarizeForCli,
};
