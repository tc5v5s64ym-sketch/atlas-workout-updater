'use strict';

// Coach + deload + debug/flight/bug-report/schema/health routes (Remediation PR-17).
//
// Extracted VERBATIM from index.js into an Express Router, same pattern as
// routes/reads.js. Byte-identical paths and handler bodies. Auth, rate-limiters
// (the global api / write / flight-ingest limiters), and the flight-recorder are
// GLOBAL `app.use('/api', …)` middleware in index.js and run before this router
// regardless of mount position, so no per-route middleware moves here.
//
// The only shared mutable state is the sheet-rows cache, INJECTED as `getSheetRows`
// so a write elsewhere still invalidates what these reads see. Every ring buffer,
// shadow store, and deload/flight/bug write is owned by its own service. The coach
// and deload slice-local helper functions moved in with their routes.

const express = require('express');
const { success: standardSuccess, error: standardError } = require('../response');
const {
  getSpreadsheetTabs, getExerciseCatalog, ensureSheetTab, appendRows,
  getRecentRows,
  // Destructuring default preserved verbatim from index.js: the test harness stubs
  // sheets.js without this export, so the fallback must survive the extraction.
  getSafeSpreadsheetConfig = () => ({ canVerify: false, source: 'GOOGLE_SHEETS_ID' }),
  logSheetName, effortSheetName,
} = require('../sheets');
const coach = require('../services/coach');
const trainingSME = require('../services/trainingSME');
const coachPolish = require('../services/coachPolish');
const { scoreIntents, buildRecentSessions, detectStalls, computeFatigueStatus, recommendNextSet, suggestDeloads, todayIso, normalizeLogRow } = require('../services/analytics');
const { enrichCoachFacts, confirmTodayNewGround } = require('../services/liveIntelligence');
const { buildAthleteIdentity } = require('../services/athleteIdentity');
const { readAthleteGoals } = require('../services/athleteGoals');
const { selectCoachMode } = require('../services/coachMode');
const { deriveChatCoachMode } = require('../services/chatCoachMode');
const { detectDiscouragement } = require('../services/discouragementSignal');
const { grantRegister } = require('../services/registerPermissions');
const { computeCelebrationScarcity } = require('../services/celebrationScarcity');
const { assessLayoff } = require('../services/layoffGuard');
const { getProfileGoal } = require('../services/profileGoal');
const { renderSetVoice, findForbiddenContradictions, renderSubstitutionVoice, findSubstitutionContradictions } = require('../services/coachVoiceRenderer');
const { analyzeSetSequence, assessNextMoveConflict, suppressBumpForRecovery, holdStimulusForRecovery } = require('../services/setEffortSignals');
const { effortVerdict } = require('../services/justLoggedAnchor');
const { assessRecoveryDeload } = require('../services/recoveryDeloadSelection');
const { profileForGoal, modalityCategoryFor } = require('../services/trainingIntelligenceAdapter');
const { gradeStimulus } = require('../services/stimulusGovernor');
const { effortNote: buildEffortNote, rerouteNote: buildRerouteNote } = require('../services/setEffortCopy');
const { routeNextMove } = require('../services/fatigueRouter');
const { patternFor } = require('../services/movementPattern');
const { musclesFor } = require('../services/muscleCoverage');
const { assembleBatchNoteFacts } = require('../services/batchNoteFacts');
const { detectExtraWork } = require('../services/extraWorkDetector');
const { buildSessionQuestionAnswer, buildSessionAdviceFallback, answerBareShorthand, isBareSessionShorthand, answerPlannedLiftQuestion, answerTotalRepsQuestion } = require('../services/sessionQuestionAnswer');
const { isTirednessExpression, buildTirednessRecoveryAnswer } = require('../services/recoveryRouting');
const { planStateFromContext, buildSessionCloseAnswer } = require('../services/sessionPlanExecutor');
const { generateLiftCode, buildExerciseCatalogMap, normalizeExerciseKey, closestExerciseMatches } = require('../services/exerciseEnrichment');
const { getShadowLog, observeChatMessage } = require('../services/intentShadow');
const { getBrainShadowLog } = require('../services/brainShadow');
// PR-GATEA1 — evidence provenance for the Intent_Shadow diagnostics row.
const { evidenceForRequest } = require('../services/evidenceProvenance');
const { getFlightRecorderLog, isFlightRecorderEnabled, recordClientBatch } = require('../services/flightRecorder');
const { BUG_REPORT_TAB, BUG_REPORT_COLUMNS, buildBugReportRow } = require('../services/bugReport');
const { readCurrentDeloadState } = require('../services/deloadState');
const driftShadow = require('../services/driftShadow');
const { beginDeload, recordDeloadSession, resolvePostDeload } = require('../services/deloadEngine');
const { selectProtocol } = require('../services/deloadProtocols');
const { buildSheetContractStatus } = require('../config/sheetContract');

module.exports = function registerCoachOpsRoutes({ getSheetRows }) {
  const router = express.Router();

  // GET /api/health/sheets
  router.get('/api/health/sheets', async (req, res) => {

    try {
      const tabs = await getSpreadsheetTabs();
      const contractStatus = buildSheetContractStatus(tabs);
      const status = Object.entries(contractStatus.required).reduce((acc, [tab, exists]) => {
        acc[tab] = { exists };
        return acc;
      }, {});
      const optional = Object.entries(contractStatus.optional).reduce((acc, [tab, exists]) => {
        acc[tab] = { exists, required: false };
        return acc;
      }, {});
      return standardSuccess(req, res, 'Google Sheets health check', {
        tabs: status,
        optionalTabs: optional,
        availableTabs: tabs,
        missingRequiredTabs: contractStatus.missingRequiredTabs
      });
    } catch (error) {
      return standardError(req, res, 'Failed to verify Google Sheets tabs', error.message, 500);
    }
  });

  // GET /api/health/openai
  router.get('/api/health/openai', (req, res) => {
    return standardSuccess(req, res, 'OpenAI health check', { configured: Boolean(process.env.OPENAI_API_KEY) });
  });

  // GET /api/health/gemini
  router.get('/api/health/gemini', (req, res) => {
    return standardSuccess(req, res, 'Gemini health check', {
      configured: coach.isConfigured(),
      model: coach.coachModel()
    });
  });

  // POST /api/coach/message — turn deterministic facts into coach prose via
  // Gemini. body.kind selects the voice: "set" (default) reacts to a logged set;
  // "plan" explains why today's recommended session fits. READ-ONLY: this endpoint
  // never touches Google Sheets. When Gemini is unconfigured or fails, it returns
  // message:null so the client falls back to its templated copy — never blocked.
  // Deterministic set-effort signals (Training Intelligence PR 477 wiring). Reads
  // the client-provided set sequence + remaining planned queue and runs the pure
  // engine (services/setEffortSignals.js) to produce short engine-backed copy: a
  // per-set effort note and, when the next planned move shares a fatigued prime
  // mover, a suggestion-only reroute line. Computed independent of Gemini so the
  // copy survives an LLM outage; this route never writes, so proof fields /
  // Log_Cleaned are untouched. The LLM never sees or words these here (that is
  // PR 484) — this is the deterministic floor only.
  // Resolve a planned-queue item to its exercise name (string or object), mirroring
  // setEffortSignals' exerciseNameOf so the fatigue-router wiring reads the same shape.
  function nextExerciseName(item) {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
      return String(item.name || item.canonicalName || item.exercise || item.canonical_exercise || '').trim();
    }
    return '';
  }

  // Tiny adapter (PR 484/485): map the ALREADY-COMPUTED live verdicts (trend +
  // readiness_signal) into the recovery/deload SELECTION engine's signal snapshot.
  // Deliberately conservative — only confident verdicts become signals, and a single
  // signal never converges (the engine needs a stack), so weak/ambiguous evidence
  // stays silent. No new deload math; the engine owns the decision. `loads_feel_hard`
  // is the milder readiness tier — a moderate warning that must STACK with a
  // performance signal before recovery_reload, and it never trips the strong deload
  // trigger (which needs subjective_fatigue/high_soreness).
  function deriveRecoverySignals(rec, profile) {
    const r = rec && typeof rec === 'object' ? rec : {};
    const trend = r.trend && typeof r.trend === 'object' ? r.trend : {};
    const readiness = r.readiness_signal && typeof r.readiness_signal === 'object' ? r.readiness_signal : {};
    const declining = trend.trend === 'declining' && (trend.confidence === 'high' || trend.confidence === 'medium');
    const likelyFatigue = readiness.signal === 'likely_fatigue' && (readiness.confidence === 'high' || readiness.confidence === 'medium');
    const possibleFatigue = readiness.signal === 'possible_fatigue';
    return {
      profile: profile || null,
      performance_decline: declining,
      subjective_fatigue: likelyFatigue,
      loads_feel_hard: possibleFatigue && !likelyFatigue,
    };
  }

  function computeSetEffortExtras(rawFacts) {
    // voiceBase is the deterministic Coach Voice Renderer output WITHOUT the prose
    // contradiction check (candidateProse is finalized per response path below). null
    // when there is no weighted/RIR signal to read.
    const out = { effort_note: null, reroute: null, voiceBase: null, set_grade: null, next_move_advisory: null, recovery_advisory: null };
    try {
      const todaySets = Array.isArray(rawFacts.todaySets) ? rawFacts.todaySets : [];
      // Only analyze the current weighted/RIR workflow: at least one set must carry
      // a finite weight or RIR. Empty/cardio-shaped input is left alone.
      const hasSignal = todaySets.some(s => s && (Number.isFinite(Number(s.weight)) || Number.isFinite(Number(s.rir))));
      if (!hasSignal) return out;
      const rec = rawFacts.rec && typeof rawFacts.rec === 'object' ? rawFacts.rec : {};
      const exerciseName = rawFacts.exerciseName || rec.exercise_name || '';
      let analysis = analyzeSetSequence(todaySets, {
        exerciseName,
        targetRir: rec.target_rir,
      });
      if (!analysis) return out;

      // Recovery/deload objective read — computed UP HERE (before any voice renders)
      // so it can gate the under-dose 'bump'. CONSERVATIVE (PR 484/485): a deload is
      // active, OR the convergence engine signals a recovery-oriented decision. We
      // surface ONLY 'deload' / 'recovery_reload'; stay silent for normal /
      // micro_adjustment (too weak) and taper / complete_rest (no live signal), and
      // when a deload is ALREADY active (the existing `deload` fact owns that voice).
      const deloadActive = rec.deload && rec.deload.in_deload === true;
      if (!deloadActive) {
        try {
          const sel = assessRecoveryDeload(deriveRecoverySignals(rec, profileForGoal(getProfileGoal())));
          if (sel && (sel.decision === 'deload' || sel.decision === 'recovery_reload')) {
            out.recovery_advisory = {
              decision: sel.decision,
              recovery_state: sel.recovery_state,
              converged_signals: sel.converged_signals,
              rationale: sel.rationale,
              deload_style: sel.deload_style,
            };
          }
        } catch (_) { /* best-effort — a recovery read must never block the reaction */ }
      }
      // BUG-20260629-034034: a recovery/deload prescription must never tell the lifter
      // to add load. Neutralize the under-dose 'bump' verdict when a recovery objective
      // is active — this gates BOTH deterministic voices below (effort_note + voiceBase)
      // and is mirrored by a precedence rule in the LLM prompt (services/coach.js).
      //
      // BUG-20260629-204817 (recurrence of -034034): the deload-convergence read
      // (assessRecoveryDeload) is independent of which session Coach's Pick prescribed,
      // so a recovery-INTENT session (recovery_pump / deload_reset) whose convergence
      // signal hasn't fired still emitted "Too much left in the tank. Bump coming." The
      // session's prescribed intent IS a recovery objective — honor it directly so the
      // add-load nudge is suppressed regardless of the re-derived signal.
      const recoveryIntentActive = ['recovery_pump', 'deload_reset'].includes(String(rawFacts.intentId || ''));
      const recoveryActive = deloadActive || out.recovery_advisory !== null || recoveryIntentActive;
      analysis = suppressBumpForRecovery(analysis, recoveryActive);

      // Profile-aware Stimulus Governor grade (PR 484 wiring slice 2 — read-only fact).
      // Grades the hardest logged set by the user's PROFILE + the exercise MODALITY
      // (via the slice-1 adapter), so the same RIR reads differently for a strength vs
      // a general-fitness lifter. Additive only — it does NOT change the existing
      // `voiceBase`/message here; a later slice words it. Best-effort; engine-vocab out.
      try {
        const workRirs = todaySets.map(s => Number(s && s.rir)).filter(Number.isFinite);
        const grade = gradeStimulus({
          profile: profileForGoal(getProfileGoal()),
          modalityCategory: modalityCategoryFor(exerciseName),
          rir: workRirs.length ? Math.min(...workRirs) : null,
          target_rir: rec.target_rir,
          is_heavy_compound: !!analysis.is_compound,
        });
        if (grade) {
          // Same recovery guard as the bump (BUG-20260629-034034 review follow-up): on a
          // recovery/deload day a high-RIR set grades as "+load" ("room to add stimulus"),
          // which the prompt would word as an add-load steer — downgrade it to 'hold' so
          // no voice nudges adding load on a deliberately-light day.
          out.set_grade = holdStimulusForRecovery({
            profile: grade.rule.profile,
            effort_interpretation: grade.effort_interpretation,
            progression_verdict: grade.progression_verdict,
            fatigue_signal: grade.fatigue_signal,
          }, recoveryActive);
        }
      } catch (_) { /* grade is best-effort; never block the reaction */ }
      out.effort_note = buildEffortNote(analysis);
      // Reroute only when a remaining planned queue exists (engine also guards this).
      const queue = Array.isArray(rawFacts.planned_queue) ? rawFacts.planned_queue : [];
      let conflict = null;
      if (queue.length) {
        conflict = assessNextMoveConflict(analysis, queue);
        const line = buildRerouteNote(conflict);
        if (conflict && conflict.conflict && line) {
          out.reroute = {
            type: conflict.suggestion && conflict.suggestion.type,
            next_exercise: conflict.next_exercise,
            reason_codes: conflict.reason_codes,
            line,
          };
        }
      }
      // PR 484 fatigue-router voicing slice — generalize the next-move read beyond the
      // pressing-specific `reroute` above (PR 477). Feeds the slice-2 governor
      // `fatigue_signal` + the just-logged pattern/muscles + the planned next move
      // (pattern/muscles/modality) into the read-only fatigue router (PR 483) to surface
      // a cross-pattern / cross-modality next-move SUGGESTION the coach can word.
      // GATED so the two systems never contradict: only emitted when the pressing
      // reroute did NOT fire (out.reroute null) and the router returns a non-'keep'
      // action. Best-effort; engine vocab only; never auto-applies or writes.
      if (!out.reroute && queue.length && out.set_grade && out.set_grade.fatigue_signal) {
        const nextName = nextExerciseName(queue[0]);
        if (nextName) {
          const jm = analysis.muscles || {};
          const nMus = musclesFor(nextName) || {};
          // NOTE: the router's `block_pr` branch needs BOTH `repeated_rir0` and
          // `is_pr_attempt`, but there is no live PR-attempt signal at this set-reaction
          // call site yet — so that branch is inert here regardless. Both inputs are
          // omitted (the router treats them as falsy) rather than computing a dead
          // `repeated_rir0`; wiring real PR intent is a future slice (see BACKLOG).
          const advisory = routeNextMove({
            justLogged: {
              pattern: analysis.pattern || null,
              muscles: [...(jm.primary || []), ...(jm.secondary || [])],
              fatigue_signal: out.set_grade.fatigue_signal,
            },
            nextMove: {
              pattern: patternFor(nextName).pattern || null,
              muscles: [...(nMus.primary || []), ...(nMus.secondary || [])],
              modalityCategory: modalityCategoryFor(nextName),
            },
            // A heavy lower-body compound just logged gates the cardio-after-legs case.
            heavy_lower_block_done: !!analysis.is_compound && ['squat', 'hinge'].includes(analysis.pattern),
          });
          if (advisory && advisory.action && advisory.action !== 'keep') {
            out.next_move_advisory = {
              action: advisory.action,
              reason: advisory.reason || null,
              target: advisory.target || null,
              next_exercise: nextName,
              next_modality: modalityCategoryFor(nextName) || null,
            };
          }
        }
      }

      // (Recovery/deload SELECTION read + the under-dose 'bump' suppression were
      // computed at the top of this function so they could gate the deterministic
      // voices; see the BUG-20260629-034034 note above.)
      // Deterministic set-feedback voice (Coach Voice Renderer slice 1). The engine
      // decides the coaching MEANING; the prose contradiction check is applied per
      // response path in finalizeSetVoice (the candidate prose differs LLM-up vs
      // LLM-down). recVerdict comes from the recommendation engine's effort verdict.
      out.voiceBase = renderSetVoice({
        analysis,
        conflict,
        recVerdict: rec.effort_verdict || null,
        candidateProse: '',
      });
    } catch (_) {
      // Best-effort — a signal failure must never block the coach response.
    }
    return out;
  }

  // Finalize the deterministic voice against the candidate prose for THIS response
  // path and decide whether the generic/LLM prose may speak. The engine wins: when a
  // non-neutral fatigue/underdose signal is present, or the prose contradicts a
  // reason code, the prose is suppressed (message → null) so it can never dilute or
  // contradict the engine's read. Returns { message, voice } (voice null when there
  // is no set-effort signal). Read-only — never writes.
  function finalizeSetVoice(message, voiceBase) {
    // An empty/whitespace-only model reply is NOT a coach message — normalize it to
    // null so the endpoint never serializes `message: ""` (PR-11 Bug 4). The client
    // then falls back to its templated voice instead of rendering a blank.
    const msg = (typeof message === 'string' && !message.trim()) ? null : message;
    if (!voiceBase) return { message: msg, voice: null };
    const contradictions = findForbiddenContradictions(voiceBase.reason_codes, msg);
    const suppress = voiceBase.suppress_generic_prose || contradictions.length > 0;
    return {
      message: suppress ? null : msg,
      voice: { ...voiceBase, contradictions },
    };
  }

  // Finalize BOTH the set-effort voice and the substitution-pivot voice (Coach Voice
  // Renderer slice 2) against the candidate prose for THIS response path. The
  // deterministic engine wins: the LLM prose is suppressed (message → null) when a
  // non-neutral set signal owns the reaction OR the prose contradicts a set reason
  // code (finalizeSetVoice), OR the swap is a good pivot whose deterministic line
  // owns the acknowledgement / the prose would lecture it. Returns
  // { message, voice, sub_voice }. Read-only — never writes.
  function finalizeCoachVoice(message, voiceBase, subVoiceBase, registerCtx = null) {
    const setFin = finalizeSetVoice(message, voiceBase);
    let outMessage = setFin.message;
    let sub_voice = null;
    if (subVoiceBase) {
      const goodPivot = subVoiceBase.severity === 'pivot';
      const contradictions = findSubstitutionContradictions(goodPivot, message);
      sub_voice = { ...subVoiceBase, contradictions };
      if (subVoiceBase.suppress_generic_prose || contradictions.length > 0) outMessage = null;
    }
    // PR-B4 slice 3 — register suppressor. The deterministic engine wins here too:
    // if the LLM prose outran its granted register (a swear word without
    // profanity_ok, or celebration/PR vocabulary outside an earned celebrate/praise
    // moment), suppress the prose (→ null) so the client falls back to the
    // deterministic line — exactly like a reason-code contradiction.
    if (outMessage && registerCtx && typeof coach.findRegisterViolations === 'function') {
      const violations = coach.findRegisterViolations(outMessage, registerCtx);
      if (violations.length > 0) outMessage = null;
    }
    return { message: outMessage, voice: setFin.voice, sub_voice };
  }

  router.post('/api/coach/message', async (req, res) => {
    let rawFacts = req.body && req.body.facts;
    if (!rawFacts || typeof rawFacts !== 'object') {
      return standardError(req, res, 'facts object is required', null, 400);
    }
    // 'block' (PR-3) is a per-exercise batch note. It words like a set reaction, but
    // the deterministic coachNoteTier decides WHETHER / HOW MUCH to say first; a
    // routine block short-circuits to acknowledgment-only below and never calls Gemini.
    const kind = req.body.kind === 'plan' ? 'plan' : (req.body.kind === 'block' ? 'block' : 'set');
    const isSetLike = kind === 'set' || kind === 'block';

    // effort_verdict is ENGINE-RULE-BOUND on the set path (sibling of the engine-only
    // athlete_identity / progression_history overwrites below): recompute it from the
    // just-logged set the client sent — the LAST todaySets entry, the same set the
    // engine anchors on (justLoggedAnchor.recommendFromJustLoggedSet) — against
    // rec.target_rir, via the SAME pure rule (effortVerdict), and ALWAYS overwrite.
    // A forged level ("failure" on an RIR-3 set) can never reach the prompt OR the
    // deterministic set voice (computeSetEffortExtras reads this corrected object);
    // an honest echo recomputes to the identical value; a set with no RIR carries no
    // verdict (nothing to read). Zero extra Sheets reads — the rule needs only the
    // claimed set + target already in the payload. Done UP FRONT so every consumer
    // (voiceBase recVerdict, enrichment, sanitizeFacts) sees the engine value. Block
    // notes carry their own per-block recs (see BACKLOG).
    if (kind === 'set' && rawFacts.rec && typeof rawFacts.rec === 'object') {
      const sets = Array.isArray(rawFacts.todaySets) ? rawFacts.todaySets : [];
      const last = sets.length ? sets[sets.length - 1] : null;
      rawFacts = { ...rawFacts, rec: { ...rawFacts.rec, effort_verdict: effortVerdict(last && last.rir, rawFacts.rec.target_rir) } };
    }

    // PR-3 block-note tier: engine-owned classification of the just-logged block via
    // the pure batchNoteFacts → coachNoteTier fold (over the block's own sets plus any
    // caller-supplied rec/flags). Returned to the client to gate rendering; it is
    // NEVER forwarded to the model (not in sanitizeFacts' whitelist).
    const noteMeta = { note_tier: null, note_trigger: null, note_reason_code: null };
    const modeNoteMeta = { note_tier: null, note_trigger: null };
    if (kind === 'block') {
      const assembled = assembleBatchNoteFacts(
        { exerciseName: rawFacts.exerciseName, muscleGroup: rawFacts.muscleGroup, targetRir: rawFacts.targetRir, sets: rawFacts.todaySets },
        { rec: rawFacts.rec, substitution: rawFacts.substitution, injury: rawFacts.injury, unexpected_excellence: rawFacts.unexpected_excellence, regression: rawFacts.regression, recovery_active: rawFacts.recovery_active, confidence: rawFacts.confidence, asked_why: rawFacts.asked_why }
      );
      const t = assembled && assembled.tier ? assembled.tier : null;
      noteMeta.note_tier = t ? t.tier : 'ack_only';
      noteMeta.note_trigger = t ? t.trigger : null;
      noteMeta.note_reason_code = t ? t.reason_code : null;

      // Mode/register authority gets a separate deterministic fold over the set
      // measurements only. The legacy response tier above intentionally retains
      // its existing caller-shaped inputs, but those flags/verdicts cannot grant
      // a mode or register permission.
      const modeAssembled = assembleBatchNoteFacts(
        { exerciseName: rawFacts.exerciseName, muscleGroup: rawFacts.muscleGroup, sets: rawFacts.todaySets },
        {}
      );
      const mt = modeAssembled && modeAssembled.tier ? modeAssembled.tier : null;
      modeNoteMeta.note_tier = mt ? mt.tier : 'ack_only';
      modeNoteMeta.note_trigger = mt ? mt.trigger : null;
    }

    // Engine-backed extras are deterministic and Gemini-independent — compute them
    // up front so they ride along on every response path below (incl. LLM-down).
    // voiceBase is the deterministic Coach Voice Renderer read; finalizeSetVoice
    // applies the prose contradiction check per path and rides `voice` along too.
    const computed = isSetLike
      ? computeSetEffortExtras(rawFacts)
      : { effort_note: null, reroute: null, voiceBase: null, set_grade: null, next_move_advisory: null, recovery_advisory: null };
    const effortExtras = { effort_note: computed.effort_note, reroute: computed.reroute, set_grade: computed.set_grade, next_move_advisory: computed.next_move_advisory, recovery_advisory: computed.recovery_advisory };
    const voiceBase = computed.voiceBase;
    // Substitution-pivot voice (slice 2). Read straight from the client-provided swap;
    // only the classification/quality/logged-name fields are consulted. Best-effort —
    // a bad shape just yields a neutral voice and changes nothing.
    const subVoiceBase = (rawFacts.substitution && typeof rawFacts.substitution === 'object')
      ? renderSubstitutionVoice({ substitution: rawFacts.substitution, candidateProse: '' })
      : null;

    // PR-3: a routine block (tier ack_only) is acknowledged by the client-side ✅
    // receipt alone — return NO coaching prose and DO NOT call Gemini. Keeps routine
    // blocks silent and the LLM off the path entirely for the common case.
    if (kind === 'block' && noteMeta.note_tier === 'ack_only') {
      return standardSuccess(req, res, 'Routine block — acknowledgment only', {
        message: null, voice: null, sub_voice: null, configured: coach.isConfigured(), model: coach.coachModel(), kind, ...noteMeta,
        effort_note: null, reroute: null, set_grade: null, next_move_advisory: null, recovery_advisory: null
      });
    }
    if (!coach.isConfigured()) {
      const fin = finalizeCoachVoice(null, voiceBase, subVoiceBase);
      return standardSuccess(req, res, 'Coach voice unavailable — use templated fallback', {
        message: fin.message, voice: fin.voice, sub_voice: fin.sub_voice, configured: false, model: coach.coachModel(), ...noteMeta, ...effortExtras
      });
    }

    // Server-side intelligence enrichment: when a liftCode is present compute
    // working_weight, trend, readiness_signal, deviation, and evidence_context
    // from the lift's history. Failure is best-effort — never blocks the response.
    let facts = rawFacts;
    // PR-A7 — athlete identity is ENGINE-ONLY: computed below from the log rows the
    // enrichment path already fetches (zero additional Sheets reads), and ALWAYS
    // overwritten onto the facts so a client-supplied athlete_identity can never
    // reach the coach. No liftCode → no rows in hand → null (a missing story is
    // honest; we never add a read for it — docs/READ_BUDGET.md discipline).
    let athleteIdentity = null;
    // PR-B4 (slice 1) — celebration scarcity is derived from the SAME allLog the
    // enrichment path fetches (zero additional Sheets reads); null when there is no
    // liftCode (no rows in hand — the mode falls back to its scarcity-clear default,
    // which only ever downgrades celebrate→praise, never up).
    let scarcity = null;
    // PR-B4 slice 3 — the engine's OWN read of whether today's set is new_ground,
    // recomputed server-side (never trusting the client's rec.progression_verdict).
    // Gates the profanity permission below so a forged verdict can't reach the cell.
    let engineNewGround = false;
    // progression_history is engine-only (services/progressionHistory, via
    // enrichCoachFacts). Captured from a SUCCESSFUL enrichment and ALWAYS overwritten
    // below (engine value, or null when the Sheets read / enrichment fails) so a client
    // can never inject a forged checkpoint that survives on the Sheets-down fallback.
    let progressionHistory = null;
    // Retain the successful enrichment read for the remaining engine-only mode
    // inputs below. null means no trustworthy read was available; [] is a real,
    // successful empty read. This never adds another Sheets call.
    let engineLogRows = null;
    let enrichmentFailed = false;
    if (rawFacts.liftCode) {
      try {
        const allLog = await getSheetRows(logSheetName);
        engineLogRows = allLog;
        facts = enrichCoachFacts(rawFacts, allLog);
        progressionHistory = facts.progression_history || null;
        athleteIdentity = buildAthleteIdentity(allLog, { asOf: todayIso() });
        scarcity = computeCelebrationScarcity(allLog, { asOf: todayIso() });
        engineNewGround = confirmTodayNewGround(rawFacts, allLog);
      } catch (_) {
        // Keep client facts as-is if Sheets read or enrichment fails.
        enrichmentFailed = true;
      }
    }
    // Fail closed on engine-only signals, mirroring the layoff / athlete_identity
    // discipline: progression_history is the engine value or null in EVERY path, and on
    // a genuine enrichment failure the client's unconfirmed rec.progression_verdict is
    // also nulled (the server-side new_ground gate already failed closed:
    // engineNewGround=false) so a forged verdict can't reach the prompt. The successful
    // path is unchanged — progressionHistory holds the engine value and rec is untouched.
    facts = { ...facts, athlete_identity: athleteIdentity, progression_history: progressionHistory };
    if (enrichmentFailed && facts.rec && typeof facts.rec === 'object' && facts.rec.progression_verdict != null) {
      facts = { ...facts, rec: { ...facts.rec, progression_verdict: null } };
    }

    // Plan voice: derive the return-after-layoff signal from the log server-side so
    // a "volume pulled back" claim can only come from the engine, never the client.
    // Always overwrite facts.layoff (engine value or null) so a client cannot inject
    // one; on a read failure it stays null and the coach simply won't mention it.
    // volume_reduced must reflect the *recommended* session the client narrates —
    // scoreIntents only caps the training intents (build_strength / build_muscle /
    // fix_blind_spots / balanced), so it is true only when the recommended intent
    // actually carries the returning_from_layoff cut.
    if (kind === 'plan') {
      let layoffFact = null;
      try {
        const [allLog, allEffort] = await Promise.all([
          getSheetRows(logSheetName),
          getSheetRows(effortSheetName),
        ]);
        const layoff = assessLayoff(allLog);
        if (layoff.returning_from_layoff) {
          const rec = scoreIntents(allLog, allEffort, { goal: getProfileGoal() });
          const top = rec.intents.find(i => i.recommended);
          const volume_reduced = !!(top && Array.isArray(top.reason_codes) &&
            top.reason_codes.includes('returning_from_layoff'));
          layoffFact = {
            severity: layoff.severity,
            days_since_last_session: layoff.days_since_last_session,
            volume_reduced,
          };
        }
      } catch (_) {
        // Best-effort — omit the layoff signal if the read fails.
      }
      facts = { ...facts, layoff: layoffFact };
    }

    // PR 484 slice 3: let the set-reaction coach WORD the profile-aware Stimulus
    // Governor grade (computed read-only in slice 2). The model only words this
    // engine verdict — sanitizeFacts bounds it to controlled enums and the prompt
    // forbids inventing numbers. ALWAYS overwrite (engine value or null) so a
    // client-supplied `stimulus_grade` can never reach the coach — engine-only.
    facts = { ...facts, stimulus_grade: isSetLike ? (computed.set_grade || null) : null };

    // PR 484 fatigue-router voicing: let the set-reaction coach WORD the cross-pattern
    // next-move SUGGESTION (computed read-only above, gated to not collide with the
    // pressing reroute). sanitizeFacts bounds the action to the router's vocabulary and
    // the prompt forbids inventing numbers / auto-applying. ALWAYS overwrite (engine
    // value or null) so a client-supplied advisory can never reach the coach.
    facts = { ...facts, next_move_advisory: isSetLike ? (computed.next_move_advisory || null) : null };

    // PR 484 recovery/deload voicing: let the set-reaction coach WORD the conservative
    // recovery SELECTION (computed read-only above; under-triggered + recovery-oriented
    // only). sanitizeFacts bounds the decision to the engine's recovery vocabulary and
    // the prompt forbids commanding a deload / inventing numbers. ALWAYS overwrite
    // (engine value or null) so a client-supplied advisory can never reach the coach.
    facts = { ...facts, recovery_advisory: isSetLike ? (computed.recovery_advisory || null) : null };

    // S5 — coaching MODE + granted REGISTER for the set/block voice. Every selector
    // input is built here from existing pure engines. Client-shaped rule decisions,
    // verdicts, memory, layoff, substitution decisions, effort verdicts, and
    // progression verdicts are never consulted for mode/register. The successful
    // enrichment read is reused for history-backed inputs (zero extra Sheets reads),
    // and a missing/bad read floors those inputs to []/null.
    let registerCtx = null;
    if (isSetLike) {
      const sets = Array.isArray(rawFacts.todaySets) ? rawFacts.todaySets : [];
      // /api/coach/message receives an echoed recommendation, not an authoritative
      // recommendation identity. There is no server-owned target_rir at this boundary,
      // so target-dependent effort/expectation verdicts fail quiet for MODE instead of
      // trusting the echo or silently substituting the wrong training-goal target.
      // The separately recomputed set effort fact remains available to the prompt; it
      // cannot grant mode/register permissions.
      const modeEffortVerdict = null;
      const verdict = null;

      let ruleDecisions = [];
      let memoryPatterns = [];
      let layoff = null;
      let historyRows = [];
      try {
        historyRows = Array.isArray(engineLogRows) ? engineLogRows.map(normalizeLogRow) : [];
      } catch (_) {
        historyRows = [];
      }
      try {
        const { evaluateSessionSafety } = require('../rules/safetyRules');
        const currentRows = sets.map((set, index) => normalizeLogRow({
          ...(Array.isArray(set)
            ? { weight: set[0], reps: set[1], rir: set[2] }
            : (set && typeof set === 'object' ? set : {})),
          session_id: rawFacts.sessionId || rawFacts.session_id || 'coach-message-current',
          lift_code: rawFacts.liftCode || '',
          canonical_exercise: rawFacts.exerciseName || '',
          muscle_group: rawFacts.muscleGroup || '',
          set_number: index + 1,
          // Structured client safety claims are not selector authority. The rule
          // reads only the logged set measurements here; note-tier safety remains
          // on its existing deterministic path above.
          notes: '',
        }));
        ruleDecisions = evaluateSessionSafety(currentRows, '', historyRows);
      } catch (_) {
        ruleDecisions = [];
      }
      try {
        if (Array.isArray(engineLogRows) && rawFacts.liftCode) {
          const { detectPatterns } = require('../services/coachMemory');
          const { buildSubstitutionHistory } = require('../services/substitutionHistory');
          const liftCode = String(rawFacts.liftCode).trim().toUpperCase();
          const substitutionHistory = buildSubstitutionHistory(engineLogRows)
            .filter(event => String(event.liftCode || '').trim().toUpperCase() === liftCode);
          const detected = detectPatterns(liftCode, engineLogRows, { substitutionHistory });
          if (detected.patterns.length) memoryPatterns = [{ liftCode, patterns: detected.patterns }];
          layoff = assessLayoff(engineLogRows);
        }
      } catch (_) {
        // Total/fail-quiet contract: malformed history or a failed read cannot
        // elevate the voice. An unrelated memory failure must not erase a safety
        // decision already computed from the current set.
        memoryPatterns = [];
        layoff = null;
      }

      const progressionVerdict = engineNewGround ? { level: 'new_ground' } : null;
      const scarcityClear = scarcity ? scarcity.scarcityClear !== false : true;
      const mode = selectCoachMode({
        note_trigger: modeNoteMeta.note_trigger,
        note_tier: modeNoteMeta.note_tier,
        rule_decisions: ruleDecisions,
        verdict,
        effort_verdict: modeEffortVerdict,
        progression_verdict: progressionVerdict,
        substitution: null,
        memory_patterns: memoryPatterns,
        layoff,
      }, { scarcityClear }).mode;
      // Profanity is OFF in production by default — activated only by the owner
      // setting ATLAS_COACH_PROFANITY=on on Render (after reviewing mode/register in
      // the flight recorder, per the plan's live-validation gate). This mirrors the
      // ATLAS_COACH_ENGINE / ATLAS_INTENT_ROUTER staging pattern; the ratified D1
      // calibration file stays enabled:true, and this env gate defaults it off.
      const profanityLive = process.env.ATLAS_COACH_PROFANITY === 'on';
      const register = grantRegister({
        mode,
        scarcity: { scarcityClear },
        ownerPrefs: { profanity_enabled: profanityLive },
      });
      // Engine-confirmed-new_ground gate (trust): profanity requires the engine's OWN
      // recompute, not just the client-derivable celebrate mode. Belt-and-suspenders
      // over grantRegister's cell + the finalizeCoachVoice suppressor.
      if (register.profanity_ok && !engineNewGround) register.profanity_ok = false;
      registerCtx = { mode, register };
      // Forward the same engine evidence that selected challenge so the voice can
      // name the grounded pattern instead of receiving an unsupported elevated mode.
      facts = { ...facts, coach_mode: mode, register, memory_patterns: memoryPatterns };
    } else {
      facts = { ...facts, coach_mode: null, register: null };
      // Plan / non-set voices carry no register grant, but the suppressor should
      // still backstop them (layer 3 must cover every LLM voice): a conservative
      // floor ctx strips any un-granted profanity the plan model emits. profanity_only
      // skips the earned-moment celebration/PR-vocab check — the plan "why today"
      // voice may legitimately reference a real personal best in its rationale.
      registerCtx = { mode: null, register: { profanity_ok: false }, profanity_only: true };
    }

    try {
      const message = kind === 'plan'
        ? await coach.generatePlanMessage(facts)
        : await coach.generateCoachMessage(facts);
      // Deterministic engine controls the coaching meaning: suppress the LLM prose
      // when it contradicts (or would speak over) a non-neutral set-effort signal,
      // or when it outruns its granted register (slice 3).
      const fin = finalizeCoachVoice(message, voiceBase, subVoiceBase, registerCtx);
      return standardSuccess(req, res, 'Coach message', { message: fin.message, voice: fin.voice, sub_voice: fin.sub_voice, configured: true, model: coach.coachModel(), source: 'gemini', kind, ...noteMeta, ...effortExtras });
    } catch (error) {
      // Degrade gracefully: tell the client to use its templated fallback rather
      // than surfacing an error in the chat.
      const fin = finalizeCoachVoice(null, voiceBase, subVoiceBase);
      return standardSuccess(req, res, 'Coach generation failed — use templated fallback', {
        message: fin.message, voice: fin.voice, sub_voice: fin.sub_voice, configured: true, model: coach.coachModel(), error: error.message, ...noteMeta, ...effortExtras
      });
    }
  });

  // Assemble a compact, read-only training snapshot for the chat coach from the
  // deterministic engine — recent sessions, movement-pattern readiness, today's
  // recommended focus, stalled lifts, and under-coverage gaps. Bounded here and
  // bounded again in coach.sanitizeChatContext. The lifter's current preview rows
  // (if any) ride along from the client so "is this set good?" can be answered.
  function buildChatContext(logRows, effortRows, clientContext, coachingNotes, constraints, modeOpts = {}) {
    const intents = scoreIntents(logRows, effortRows);
    const recent = buildRecentSessions(logRows, effortRows, { limit: 5 });
    const stalls = detectStalls(logRows);
    const read = intents.todays_read || {};
    const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
    const sessions = recent.sessions || [];

    // Lazily required to avoid a load-time cycle possibility; under-coverage is
    // a read-only data layer with no dependency on index.js.
    const { computeUnderCoverage } = require('../services/underCoverage');
    const muscle_gaps = computeUnderCoverage(logRows)
      .filter(r => r.status === 'under')
      .sort((a, b) => (a.currentEffectiveSets - a.targetRange.min) - (b.currentEffectiveSets - b.targetRange.min))
      .slice(0, 6)
      .map(r => ({ muscle: r.muscle, currentEffectiveSets: r.currentEffectiveSets, targetMin: r.targetRange.min }));

    // Coach memory: compute recurring patterns for any lift that shows one.
    // Empty-pattern results are filtered out, so context stays compact.
    const { detectPatterns } = require('../services/coachMemory');
    const { buildSubstitutionHistory } = require('../services/substitutionHistory');
    const substitutionHistory = buildSubstitutionHistory(logRows);
    const COL_LIFT_IDX = 5;
    const uniqueLifts = [...new Set((Array.isArray(logRows) ? logRows : []).map(r => r[COL_LIFT_IDX]).filter(Boolean))];
    const memory_patterns = uniqueLifts
      .map(liftCode => {
        const liftSubHistory = substitutionHistory.filter(e => String(e.liftCode).toUpperCase() === String(liftCode).toUpperCase());
        return { liftCode, ...detectPatterns(liftCode, logRows, { substitutionHistory: liftSubHistory }) };
      })
      .filter(item => item.patterns.length > 0)
      .slice(0, 5);

    // Session plan state: remaining = planned - completed. Only emitted when the
    // client explicitly sends plan_completed — if it's absent, plan_state stays
    // null so the coach isn't told "all exercises still outstanding" using stale
    // data. Frontend wiring (PR 358) is required before this becomes non-null.
    // The gate lives in planStateFromContext so the LLM-down session-close fallback
    // (Step 377) decides "is there an authoritative session state?" identically.
    const plan_state = planStateFromContext(cc);

    // Unprogrammed / extra-work signal for the LIVE session: prescribed = today's
    // plan (current_plan.sets = target sets), logged = the live preview grouped to
    // per-exercise set counts. Both are "now", so no stale-session mismatch. The
    // engine (detectExtraWork) decides; missing target_sets are never guessed.
    const previewRows = Array.isArray(cc.current_preview) ? cc.current_preview : [];
    const loggedCounts = new Map();
    for (const r of previewRows) {
      const name = r && (r.exercise || r.canonical_exercise || r.name);
      const clean = name ? String(name).trim() : '';
      if (!clean) continue;
      const key = clean.toLowerCase();
      loggedCounts.set(key, { exercise: clean, sets: (loggedCounts.get(key)?.sets || 0) + 1 });
    }
    const prescribedForExtra = (Array.isArray(cc.current_plan) ? cc.current_plan : [])
      .map(e => (e && typeof e === 'object'
        ? { exercise: String(e.name || e.exercise || '').trim(), target_sets: typeof e.sets === 'number' ? e.sets : undefined }
        : { exercise: String(e || '').trim() }))
      .filter(e => e.exercise);
    // Gate on a real prescribed plan: with no plan there is nothing to exceed, so
    // detectExtraWork([], logged) would wrongly flag every logged lift as an
    // "extra_exercise". No plan → no-extra shape (sanitizeChatContext → null).
    const extra_work = prescribedForExtra.length > 0
      ? detectExtraWork(prescribedForExtra, [...loggedCounts.values()])
      : { extra_sets: [], extra_exercises: [], has_extra: false };

    // Failure-work signal for the LIVE session: exercises with a logged set at RIR ≤ 0,
    // so the coach can answer "why to/from failure?" from a real signal (read-only,
    // invents no loads). Both the flattening and the detection live in the shared
    // helper so this and the unit tests can't drift.
    const { detectFailureSets, sessionSetsFromContext } = require('../services/failureSets');
    const failure_sets = detectFailureSets(sessionSetsFromContext(cc));

    const coach_mode = deriveChatCoachMode(
      { memory_patterns },
      { discouraged: modeOpts.discouraged === true }
    );
    // S5 / B4-4: the chat voice receives the same engine-owned register contract
    // as set reactions. Free-form chat has no earned new-ground event of its own,
    // so profanity stays explicitly OFF regardless of client context or runtime
    // activation. The client never participates in this grant.
    const register = grantRegister({
      mode: coach_mode,
      ownerPrefs: { profanity_enabled: false }
    });

    return {
      recommended_label: read.recommended_label || null,
      recommended_focus: read.recommended_reason || null,
      readiness: (read.patterns || []).map(p => ({ pattern: p.label || p.pattern, status: p.status, detail: p.detail })),
      recent_sessions: sessions.map(s => ({
        date: s.date, exercises: s.exercises, sets: s.sets_count, volume: s.total_volume,
        lift_sets: s.lift_sets || {}
      })),
      stalls: stalls.map(s => ({ exercise: s.exercise || s.liftCode, weight: s.last_best_weight, sessions_stalled: s.sessions_stalled })),
      muscle_gaps,
      memory_patterns,
      plan_state,
      current_preview: Array.isArray(cc.current_preview) ? cc.current_preview : [],
      current_plan: Array.isArray(cc.current_plan) ? cc.current_plan : [],
      // session_tally is assembled by the client (buildSessionTally in src/app/sessionTally.js)
      // from the in-memory session buffer and forwarded here so sanitizeChatContext can
      // pass the per-exercise set facts to the LLM. Without this line the sanitizer never
      // sees it and session-count/weight/planned-vs-extra questions revert to sheet history.
      session_tally: cc.session_tally && typeof cc.session_tally === 'object' && !Array.isArray(cc.session_tally) ? cc.session_tally : null,
      extra_work,
      failure_sets,
      session_count: sessions.length,
      coaching_notes: Array.isArray(coachingNotes) ? coachingNotes.slice(0, 10) : [],
      constraints: Array.isArray(constraints) ? constraints.slice(0, 12) : [],
      // PR-A7 — the longitudinal athlete story, computed from the SAME logRows this
      // context is already built from (zero additional Sheets reads). Constructed
      // fresh here — never read from clientContext — so it is engine-only; bounded
      // again by coach.sanitizeChatContext's explicit whitelist.
      athlete_identity: buildAthleteIdentity(logRows, { asOf: todayIso() }),
      // PR-B8a — structured goals (what the lifter is training TOWARD), read from the
      // SAME Constraints rows the route already fetched. Goal-kind rows carry no
      // `rule`, so they were filtered out of `constraints` above — hence the raw rows.
      // Engine-only (never from clientContext); zero additional Sheets read; bounded
      // again by coach.sanitizeChatContext. `[]` when the lifter has seeded no goals.
      athlete_goals: readAthleteGoals(modeOpts.constraintRows),
      // B5 — the engine-decided coaching MODE for the chat voice, derived
      // (deriveChatCoachMode) from the snapshot facts assembled above plus the
      // message-derived discouragement signal (B5b Part 2). `memory_patterns` →
      // `challenge`; an explicit discouragement message → `reassure`; else `silent`.
      // B4-4 derives the matching register server-side with profanity forced OFF.
      // The route resolves the
      // higher-precedence tiredness/recovery moment before the LLM, so this mode only
      // ever rides the non-tired turn — recovery/safety are never softened into
      // reassurance.
      coach_mode,
      register
    };
  }

  // POST /api/coach/chat — free-form, two-way coaching chat. READ-ONLY: it reads
  // recent training to ground the reply and never writes to Google Sheets. Body:
  // { message: string, history?: [{role,text}], context?: { current_preview } }.
  // When Gemini is unconfigured or fails, returns message:null so the client shows
  // a deterministic fallback — the chat is never blocked by an LLM outage.
  // True when the chat client context carries an active session (a previewed lift or a
  // planned lift). Used to gate the engine-fill Sheets read so it only happens during a
  // real session, never on a bare-shorthand message typed with no active workout.
  function hasActiveSessionContext(ctx) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    return (Array.isArray(c.current_preview) && c.current_preview.length > 0)
      || (Array.isArray(c.current_plan) && c.current_plan.length > 0);
  }

  // Engine target for a lift name, used by the LLM-down chat fallback. Resolves the
  // lift code from the name and reads the same recommendNextSet the "Next" card uses,
  // so a deterministic answer reports the exact numbers the engine already owns.
  function recommendTargetForLift(liftName, logRows) {
    const code = generateLiftCode(liftName);
    if (!code) return null;
    const rec = recommendNextSet(Array.isArray(logRows) ? logRows : [], code);
    if (!rec || !rec.next_target) return null;
    return {
      exercise_name: rec.exercise_name || liftName,
      weight: rec.next_target.weight ?? null,
      reps: rec.next_target.reps ?? null,
      sets: rec.next_target.sets ?? null,
      rir: rec.target_rir ?? null,
      reasoning: rec.reasoning || null
    };
  }

  // Gemini timeout for the interactive coach chat. Higher than coach.js's 8s default
  // because the chat client waits 15s (CHAT_REPLY_TIMEOUT_MS) — a slow-but-successful
  // reply should land rather than be aborted early and dead-end on "Coach unavailable".
  const COACH_CHAT_TIMEOUT_MS = 12000;

  // GET /api/coach/health — READ-ONLY coach LLM connectivity probe. No Sheets, no
  // writes. Surfaces WHY coaching degrades to deterministic templates: returns
  // { configured, model, ok, reason } so the owner can distinguish a missing key,
  // bad model id (404), bad key (401/403), quota (429), or timeout — instead of the
  // silent "Coach is unavailable" fallback.
  router.get('/api/coach/health', async (req, res) => {
    const configured = coach.isConfigured();
    const model = coach.coachModel();
    if (!configured) {
      return standardSuccess(req, res, 'coach health', { configured: false, model, ok: false, reason: 'GEMINI_API_KEY not set' });
    }
    try {
      await coach.pingGemini();
      return standardSuccess(req, res, 'coach health', { configured: true, model, ok: true, reason: null });
    } catch (error) {
      return standardSuccess(req, res, 'coach health', { configured: true, model, ok: false, reason: error.message });
    }
  });

  router.post('/api/coach/chat', async (req, res) => {
    const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return standardError(req, res, 'message string is required', null, 400);
    }
    const clientCtx = req.body && req.body.context;
    const history = Array.isArray(req.body && req.body.history) ? req.body.history : [];

    // Message-scoped mode signals, computed up front (both are pure, message-only).
    //   - `tired`: a tiredness/recovery expression — the route resolves it before the
    //     LLM (recovery routing owns it), so recovery outranks reassure.
    //   - `discouraged`: an EXPLICIT discouragement/frustration phrase this turn.
    // Owner Decision 1 (LT-011): an explicit discouragement message must reach the
    // reassure voice, not be swallowed by the deterministic lift-answer lanes below —
    // so evaluate it before them. But recovery still wins: a message that is ALSO
    // tired is NOT bypassed (recovery routing resolves it). Message-scoped only — the
    // next ordinary turn recomputes and the standing challenge pattern fires again.
    const tired = isTirednessExpression(message);
    const discouraged = detectDiscouragement(message, {}).discouraged;
    const reassureBypass = discouraged && !tired;

    // Phase C2 — intent-router SHADOW observation is NOT here anymore. This route
    // only ever saw the RESIDUE that fell through every deterministic composer lane
    // (and only when the SME didn't answer first), so the shadow log missed most
    // typed messages (owner evidence 2026-07-03: 2 entries across many sessions).
    // Observation moved to the single composer chokepoint — the frontend posts EVERY
    // free-text submission to POST /api/debug/intent-observe (below), so the shadow
    // lane sees all typed messages exactly once. Still fire-and-forget, still no-op
    // when the flag is off; the reply below is unchanged.

    // The deterministic lift-answer lanes (bare shorthand → planned total → planned
    // value) answer factual "what's my RIR/reps/total" questions before the LLM. They
    // are SKIPPED for an explicit-discouragement message (Owner Decision 1): a phrase
    // like "my bench reps are going nowhere" names a lift and asks a value, so a lane
    // would otherwise swallow it as a terse fact instead of letting it reach the
    // reassure voice. A tired message is NOT bypassed here — recovery still owns it.
    if (!reassureBypass) {
      // P0 follow-up (2026-06-21): BARE in-session shorthand ("RIR?", "Reps?",
      // "How much?", "How many sets?") is answered deterministically from the CURRENT
      // lift — whether or not Gemini is up — so the lifter gets the current-lift fact,
      // not generic education. Ambiguous current lift → ask which one. No active lift
      // context → returns null so the normal flow (SME education) still applies.
      // Context-only (no Sheets/LLM): the live plan/preview already carries the target.
      let bare = answerBareShorthand(message, clientCtx);
      // Preview-of-unplanned-lift parity (#452 follow-up): when the current lift is in an
      // active PREVIEW that isn't in current_plan, the preview row carries sets:null, so
      // the context-only attempt above can't answer a bare "how many sets?" and would drop
      // to the LLM. Engine-fill via recommendNextSet — the SAME resolveTarget the named-lift
      // fallback (deterministicAnswer) uses — so the lifter gets the deterministic target,
      // not an LLM guess. Gated to bare shorthand during an active session that the context
      // couldn't answer, so the Sheets read is rare (not on every chat message).
      if (!bare && isBareSessionShorthand(message) && hasActiveSessionContext(clientCtx)) {
        const bareLog = await getSheetRows(logSheetName).catch(() => []);
        bare = answerBareShorthand(message, clientCtx, (liftName) => recommendTargetForLift(liftName, bareLog));
      }
      if (bare) {
        return standardSuccess(req, res, bare.kind === 'clarify'
          ? 'Coach chat — clarify which lift'
          : 'Coach chat — deterministic engine answer', {
          message: bare.text, configured: coach.isConfigured(), model: coach.coachModel(), source: 'engine'
        });
      }

      // Plan-first answer (2026-06-21): when the lifter NAMES a lift that is in today's
      // plan/preview and asks its prescribed value ("what's the RIR for bench?", "how
      // many reps for bench?"), answer from the CURRENT PLAN — before Gemini, which
      // would otherwise narrate from history. The current plan beats history and
      // generic education for "today's" prescription. Deferred (null) for past-tense
      // ("...last time?"), unnamed-lift ("what is RIR?"), or off-plan lifts, so
      // education / history / clarification routing is untouched. Context-only: no
      // Sheets, no LLM, no invented numbers.
      // "Total?" (reps total) — answer the ENGINE-computed planned total (sets × reps),
      // worded as planned, before Gemini. Otherwise the LLM multiplies the numbers
      // itself and mis-tenses the result as completed work ("you've done 45 reps" for
      // a lift not yet logged). Resolves the lift from the recent turns, so a bare
      // "total?" follow-up works. Context-only: no Sheets, no LLM, no invented numbers.
      const totalReps = answerTotalRepsQuestion(message, { history, clientContext: clientCtx });
      if (totalReps) {
        return standardSuccess(req, res, 'Coach chat — planned total answer', {
          message: totalReps, configured: coach.isConfigured(), model: coach.coachModel(), source: 'engine'
        });
      }

      const planned = answerPlannedLiftQuestion(message, clientCtx);
      if (planned) {
        return standardSuccess(req, res, 'Coach chat — current plan answer', {
          message: planned, configured: coach.isConfigured(), model: coach.coachModel(), source: 'engine'
        });
      }
    }

    // Slice 3 — recovery routing: when the lifter SAYS they're tired/cooked/drained,
    // the deterministic engine owns the reply and routes on the actual recovery state,
    // so the LLM never defaults to motivation hype. Grounded below (configured path)
    // from computeFatigueStatus + readiness + days-since; `tired` was flagged up top.

    // Deterministic, LLM-free answer used whenever the Gemini coach is unavailable
    // (unconfigured / errored / timed out / empty) so the lifter is never dead-ended.
    // Step 377: a session-close question ("are we done?") answers from plan_state.
    // P0 follow-up (2026-06): in-session shorthand ("RIR?", "reps?", "how much")
    // answers from the engine's recommendation for the lift in question, so an LLM
    // outage no longer turns workout-state questions into "Coach is unavailable".
    // logRowsForTarget supplies recommendNextSet history; [] when Sheets weren't read.
    const deterministicAnswer = (logRowsForTarget) => {
      const close = buildSessionCloseAnswer(message, planStateFromContext(clientCtx));
      if (close) return close;
      const valueAnswer = buildSessionQuestionAnswer(message, {
        history,
        clientContext: clientCtx,
        resolveTarget: (liftName) => recommendTargetForLift(liftName, logRowsForTarget)
      });
      if (valueAnswer) return valueAnswer;
      return buildSessionAdviceFallback(message, {
        history,
        clientContext: clientCtx,
        resolveTarget: (liftName) => recommendTargetForLift(liftName, logRowsForTarget)
      });
    };

    if (!coach.isConfigured()) {
      // No Sheets read on the unconfigured path — answer from client context only.
      // A tired lifter still gets recovery routing (no engine signals available here,
      // so the safe no-numbers recovery line), never a dead-end or hype.
      const answer = tired
        ? buildTirednessRecoveryAnswer({ readiness: Array.isArray(clientCtx && clientCtx.readiness) ? clientCtx.readiness : null })
        : deterministicAnswer([]);
      return standardSuccess(req, res, answer
        ? 'Coach chat unavailable — deterministic engine answer'
        : 'Coach chat unavailable — Gemini not configured', {
        message: answer, configured: false, model: coach.coachModel(),
        ...(answer ? { source: 'engine' } : {})
      });
    }

    let allLog = [];
    let chatError = null;
    try {
      const [logR, allEffort, notesRows, constraintRows] = await Promise.all([
        getSheetRows(logSheetName),
        getSheetRows(effortSheetName),
        getSheetRows('Coaching_Notes').catch(() => []),
        getSheetRows('Constraints').catch(() => [])
      ]);
      allLog = logR;
      const coachingNotes = notesRows
        .map(row => Array.isArray(row) ? { date: row[0] || null, note: row[1] || null } : { date: row.date || null, note: row.note || null })
        .filter(n => n.note);
      const constraints = constraintRows
        .map(row => Array.isArray(row)
          ? { date: row[0] || null, kind: row[1] || null, target: row[2] || null, rule: row[3] || null, note: row[4] || null }
          : { date: row.date || null, kind: row.kind || null, target: row.target || null, rule: row.rule || null, note: row.note || null })
        .filter(c => c.kind && c.target && c.rule);
      // B5b Part 2 — explicit discouragement/frustration in THIS message routes the
      // chat coach mode to `reassure` (computed up top as `discouraged`; the lift-answer
      // lanes above are already bypassed for it). Pure tiredness never fires it — that
      // stays the recovery read below, which short-circuits before the LLM, so recovery
      // outranks reassure (Owner Decision 1: safety and recovery stay above reassure).
      const context = buildChatContext(allLog, allEffort, clientCtx, coachingNotes, constraints, { discouraged, constraintRows });
      // ── Soul Plan PR-B5a Part 2a — DARK drift shadow (ATLAS_DRIFT_SHADOW, default
      // OFF). Fire-and-forget: reads FINALIZED-ONLY Session_Plans history (TTL-cached,
      // so never an uncached per-message read) + runs the pure detectDrift, and emits a
      // structured diagnostic to the shadow observation surface. NOTHING here reaches
      // the athlete — the drift result is NEVER passed to the LLM, never changes
      // coach_mode/challenge/copy, and the reply never awaits or depends on it. logRows
      // + memory_patterns are REUSED from the reads above (no extra read for them). OFF
      // ⇒ inert: no Session_Plans read at all.
      driftShadow.observeDrift({ logRows: allLog, memoryPatterns: context.memory_patterns, asOf: new Date().toISOString().slice(0, 10) });
      // Slice 3 — recovery routing owns a tired lifter's reply, grounded in the real
      // recovery state (weekly-load fatigue, days since last session, fatigued
      // patterns). Deterministic + read-only; the LLM is bypassed so it can't hype.
      if (tired) {
        const recoveryReply = buildTirednessRecoveryAnswer({
          fatigueStatus: computeFatigueStatus(allLog),
          readiness: context.readiness,
          daysSinceLastSession: assessLayoff(allLog).days_since_last_session,
        });
        return standardSuccess(req, res, 'Coach chat — recovery routing', {
          message: recoveryReply, configured: true, model: coach.coachModel(), source: 'engine'
        });
      }
      // Chat is interactive and the client waits 15s (CHAT_REPLY_TIMEOUT_MS), so give
      // Gemini more than the 8s default before aborting — a merely-SLOW (not-down)
      // response then lands instead of being killed early and dead-ending the lifter
      // on "Coach is unavailable." Stays under the client budget with network margin.
      const { reply, propose_edit, propose_note, propose_constraint, propose_plan_edit } =
        await coach.generateChatReply({ message, context, history }, { timeoutMs: COACH_CHAT_TIMEOUT_MS });
      const hasReply = Boolean(reply && String(reply).trim());
      const personalBestFacts = Object.entries(
        context.athlete_identity && context.athlete_identity.lift_prs
          ? context.athlete_identity.lift_prs
          : {}
      ).map(([exercise, entry]) => ({
        exercise,
        weight: entry && entry.current_best ? entry.current_best.weight : null,
        reps: entry && entry.current_best ? entry.current_best.reps : null
      })).filter(f => typeof f.weight === 'number' && Number.isFinite(f.weight));
      // Enforce the engine mode/register on free-form chat. A neutral "personal
      // best" history reference remains legal only when its lift/load/reps exactly
      // match the engine-owned athlete identity. New-PR/new-record/crushed-it
      // language, invented facts, and profanity still require the matching earned
      // grant. Violating prose is dropped while any structured proposal survives.
      const registerViolations = hasReply
        ? (typeof coach.findRegisterViolations === 'function'
          ? coach.findRegisterViolations(reply, {
            mode: context.coach_mode,
            register: context.register,
            allow_personal_best_reference: true,
            personal_best_facts: personalBestFacts
          })
          : ['register_guard_unavailable'])
        : [];
      const hasSafeReply = hasReply && registerViolations.length === 0;
      // Return the Gemini result when it has usable prose OR carries a structured
      // proposal (edit/note/constraint) — a proposal must never be dropped just
      // because the prose came back empty. Only a truly empty result (no prose, no
      // proposal) falls through to the deterministic engine fallback below.
      if (hasSafeReply || propose_edit || propose_note || propose_constraint || propose_plan_edit) {
        return standardSuccess(req, res, 'Coach chat reply', {
          message: hasSafeReply ? reply : null, propose_edit: propose_edit || null, propose_note: propose_note || null, propose_constraint: propose_constraint || null, propose_plan_edit: propose_plan_edit || null, configured: true, model: coach.coachModel(), source: 'gemini'
        });
      }
      // Empty reply and no proposal → fall through to the deterministic fallback below.
    } catch (error) {
      // Degrade gracefully — never an error bubble. Fall through to the deterministic
      // fallback. allLog may be populated (throw came from Gemini after the read) or
      // empty (the Sheets read itself failed); the fallback handles both.
      chatError = error.message;
    }
    const answer = deterministicAnswer(allLog);
    return standardSuccess(req, res, answer
      ? 'Coach chat — deterministic engine answer'
      : 'Coach chat failed — use fallback', {
      message: answer, configured: true, model: coach.coachModel(),
      ...(answer ? { source: 'engine' } : (chatError ? { error: chatError } : {}))
    });
  });

  // POST /api/coach/ask — on-demand training SME answer. Deterministic and LLM-FREE:
  // routes a training question to structured knowledge cards. READ-ONLY (no Sheets, no
  // writes). Logging-shaped input returns depth "log_only" with answer:null so the chat
  // stays quiet and practical during logging. Body: { message: string }.
  router.post('/api/coach/ask', async (req, res) => {
    const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return standardError(req, res, 'message string is required', null, 400);
    }
    const result = trainingSME.buildTrainingSMEAnswer({ question: message });
    // Optional Gemini polish: natural wording, numbers locked. Degrades to the deterministic
    // card-grounded answer when Gemini is unconfigured, slow, or drifts a number.
    let answer = result.answer;
    if (answer) {
      try { answer = await coachPolish.polishSmeAnswer(answer); } catch { answer = result.answer; }
    }
    return standardSuccess(req, res, 'Training SME answer', {
      depth: result.depth,
      answer,
      cards: result.cards,
      confidenceLevel: result.confidenceLevel,
      source: 'training_sme'
    });
  });

  // GET /api/debug/intent-shadow — Phase C2 read-only observability for the
  // intent-router shadow lane: the capped in-memory ring of classifications
  // (enabled flag + entries, newest first). Auth-gated like every /api route;
  // no Sheets, no writes, resets on restart by design.
  router.get('/api/debug/intent-shadow', (req, res) => {
    return standardSuccess(req, res, 'Intent-router shadow log', getShadowLog());
  });

  // GET /api/debug/brain-shadow — read-only observability for the Brain ORCHESTRATOR
  // shadow lane (services/brainShadow): the capped in-memory ring of EVERY
  // orchestration at the three coach-engine gates — wins AND failures (declined /
  // invalid / crashed) — with decision_type/status/confidence tier, the declared
  // capabilities that were skipped, and legacy-vs-brian target-number divergence, plus
  // aggregate hit/failure counts. This is the flip blocker: it makes hybrid keep a
  // reviewable record of what the new engine WOULD have said. Auth-gated like every
  // /api route; no Sheets read, no writes, resets on restart by design.
  router.get('/api/debug/brain-shadow', (req, res) => {
    return standardSuccess(req, res, 'Brain orchestrator shadow log', {
      mode: process.env.ATLAS_COACH_ENGINE || 'legacy',
      ...getBrainShadowLog(),
    });
  });

  // GET /api/flight/recent — read-only Flight Recorder ring (docs/FLIGHT_RECORDER_SPEC.md):
  // the capped in-memory transcript (newest first) + aggregate counts, powering the
  // Settings → Debug surface. Auth-gated like every /api route; no Sheets read, no writes,
  // resets on restart by design. Empty/inert when ATLAS_FLIGHT_RECORDER is off.
  router.get('/api/flight/recent', (req, res) => {
    return standardSuccess(req, res, 'Flight Recorder log', getFlightRecorderLog());
  });

  // POST /api/flight/ingest — the CLIENT batch sink (docs/FLIGHT_RECORDER_SPEC.md). The
  // frontend (public/flightRecorder.js) buffers the UI-only events the server can't see
  // (screen_rendered / user_action / ui_snapshot / coach_message_rendered / card_rendered /
  // session_state_changed / bug_marker) and flushes a batch here. Flag-gated: a NO-OP 202
  // when ATLAS_FLIGHT_RECORDER is off, so a stale client can never force a write. When on,
  // best-effort appends the whole batch in one call to the optional Flight_Recorder tab on
  // the server's OWN sheet — never a workout/trust tab, no write_id, outside the trust loop.
  // Simulation-marked batches are never persisted to a non-sandbox sheet (isolation guard).
  // The append is fire-and-forget; this handler always returns promptly and never fails the
  // client (telemetry must never surface a user error).
  router.post('/api/flight/ingest', (req, res) => {
    try {
      if (!isFlightRecorderEnabled()) {
        return standardSuccess(req, res, 'Flight Recorder disabled', { enabled: false, written: 0 }, 202);
      }
      const isSimulation = /^(1|true|on|yes)$/i.test(String(req.get('x-atlas-simulation') || '').trim());
      const result = recordClientBatch(req.body, {
        sheetIsSandbox: getSafeSpreadsheetConfig(process.env.NODE_ENV).isSandboxSheet === true,
        isSimulation
      });
      return standardSuccess(req, res, 'Flight Recorder batch accepted', result, 202);
    } catch (error) {
      // TOTAL: never surface a telemetry error to the client.
      return standardSuccess(req, res, 'Flight Recorder batch accepted', { enabled: true, written: 0 }, 202);
    }
  });

  // POST /api/debug/intent-observe — Phase C2 (widened 2026-07-03). The single
  // composer chokepoint posts EVERY free-text submission here so the shadow lane
  // observes all typed messages, not just the residue that reached /api/coach/chat.
  // OBSERVE-ONLY: forwards to observeChatMessage (which itself no-ops unless
  // ATLAS_INTENT_ROUTER=shadow) and returns immediately. No Sheets, no reply, no
  // write; auth-gated like every /api route. The classification runs fire-and-forget
  // inside observeChatMessage — this handler never awaits it and never reflects it.
  router.post('/api/debug/intent-observe', (req, res) => {
    const message = req.body && typeof req.body.message === 'string' ? req.body.message : '';
    const appVersion = req.body && typeof req.body.app_version === 'string' ? req.body.app_version : '';
    // PR-GATEA1 — the composer marks its intent-observe POST body with
    // request_origin:'athlete_ui' (this POST bypasses the api.js header seam).
    // Classify from that body marker + the sim header + runtime; fail closed.
    const bodyOrigin = req.body && typeof req.body.request_origin === 'string' ? req.body.request_origin : undefined;
    const evidence = evidenceForRequest(req, { bodyOrigin });
    // route/source label the Intent_Shadow diagnostics row; the classifier's own
    // source stays 'chat'. Fire-and-forget inside observeChatMessage — no-op when
    // the flag is off / message is blank.
    observeChatMessage(message, { route: 'composer', source: 'chat', appVersion, evidence });
    return standardSuccess(req, res, 'observed', { observed: Boolean(message.trim()) });
  });

  // GET /api/debug/config
  router.get('/api/debug/config', (req, res) => {
    return standardSuccess(req, res, 'Safe debug configuration', {
      serviceName: 'atlas-workout-updater',
      environment: process.env.NODE_ENV || 'development',
      sheetTabs: {
        logSheetName,
        effortSheetName
      },
      sheetVerification: getSafeSpreadsheetConfig(process.env.NODE_ENV),
      apiKeyAuthEnabled: Boolean(process.env.ATLAS_API_KEY),
      openAiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
      coachEngineMode: process.env.ATLAS_COACH_ENGINE || 'legacy',
      brainShadowPersistEnabled: ['1', 'true', 'on'].includes(String(process.env.ATLAS_BRAIN_SHADOW_PERSIST || '').toLowerCase()),
      intentRouterMode: process.env.ATLAS_INTENT_ROUTER || 'off'
    });
  });

  // POST /api/bug-report — dev-only state capture sink. The browser builds the
  // diagnostic payload; the server redacts it again before appending so secrets do
  // not land in the sheet even if a client accidentally includes them.
  router.post('/api/bug-report', async (req, res) => {
    try {
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const row = buildBugReportRow(payload);
      await ensureSheetTab(BUG_REPORT_TAB, BUG_REPORT_COLUMNS);
      await appendRows(BUG_REPORT_TAB, [row]);
      return standardSuccess(req, res, 'Bug report saved', {
        bug_id: row[1],
        tab: BUG_REPORT_TAB
      }, 201);
    } catch (error) {
      return standardError(req, res, 'Failed to save bug report', error.message, 500);
    }
  });

  // GET /api/bug-report — read-only review feed of the Bug_Reports tab. Returns the most
  // recent rows (newest first) mapped to the column names, so a reviewer (or an agent with
  // the API key) can triage bugs without opening the sheet. Read-only: no append, no schema
  // touch. The heavy Payload JSON cell is dropped by default — the summary columns + note +
  // last error cover triage; pass ?full=1 to include the raw payload per row.
  router.get('/api/bug-report', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
      const includePayload = req.query.full === '1' || req.query.full === 'true';
      const rows = await getRecentRows(BUG_REPORT_TAB, limit);
      const reports = rows.map(row => {
        const obj = {};
        BUG_REPORT_COLUMNS.forEach((col, i) => { obj[col] = row[i] !== undefined ? row[i] : ''; });
        if (!includePayload) delete obj['Payload JSON'];
        return obj;
      }).reverse(); // newest first
      return standardSuccess(req, res, 'Bug reports', {
        count: reports.length,
        tab: BUG_REPORT_TAB,
        reports
      });
    } catch (error) {
      return standardError(req, res, 'Failed to read bug reports', error.message, 500);
    }
  });

  // GET /api/schema/log
  router.get('/api/schema/log', (req, res) => {
    return standardSuccess(req, res, 'Log_Cleaned schema', {
      schema: ['Date_Clean', 'Session ID', 'Exercise', 'Canonical_Exercise', 'Muscle_Group', 'Lift Code', 'Set #', 'Weight', 'Reps', 'RIR', 'Notes', 'Volume_Calc']
    });
  });

  // GET /api/schema/effort
  router.get('/api/schema/effort', (req, res) => {
    return standardSuccess(req, res, 'Effort schema', {
      schema: ['Date', 'Session ID', 'Duration', 'Active Calories', 'Total Calories', 'Average HR', 'Peak HR', 'Location', 'Notes']
    });
  });

  // GET /api/schema/complete-workout
  router.get('/api/schema/complete-workout', (req, res) => {
    return standardSuccess(req, res, 'Complete-workout multipart schema', {
      required: ['log_rows_json'],
      required_for_screenshot_flow: ['image'],
      required_for_effort_only_flow: ['image or manual effort fields'],
      optional: ['session_id', 'date', 'location', 'notes', 'test_mode', 'effort_json']
    });
  });

  // GET /api/coaching/insights
  router.get('/api/coaching/insights', async (req, res) => {
    try {
      const allLog = await getSheetRows(logSheetName);
      const stalls = detectStalls(allLog, 3);
      const deloadSuggestions = suggestDeloads(allLog, 4);
      const fatigue = computeFatigueStatus(allLog);
      return standardSuccess(req, res, 'Coaching insights', {
        fatigue,
        stalls,
        deload_suggestions: deloadSuggestions
      });
    } catch (error) {
      return standardError(req, res, 'Failed to compute coaching insights', error.message, 500);
    }
  });

  // ---- Deload lifecycle (engine-driven, system-state) -------------------------
  // These read/write the Deload_State tab via the deload engine. They are NOT
  // logged sets: append-only system state, outside the preview→approve→write trust
  // loop, no write_id (see CLAUDE.md "Deload_State tab"). Illegal lifecycle moves
  // (begin while already deloading, advance when not deloading, resolve outside
  // post-evaluation) are rejected by the state machine and surface as 409.

  // GET /api/deload/status — the lifter's current training state.
  router.get('/api/deload/status', async (req, res) => {
    try {
      const state = await readCurrentDeloadState();
      return standardSuccess(req, res, 'Deload status', { state });
    } catch (error) {
      return standardError(req, res, 'Failed to read deload status', error.message, 500);
    }
  });

  // A deload lifecycle error is a state-machine CONFLICT (illegal move) only when it
  // matches these patterns; anything else (Sheets I/O, etc.) is infra, not a 409.
  function isDeloadConflict(error) {
    return /Illegal training-state transition|not in a deload|not in POST_DELOAD_EVALUATION/i
      .test(error && error.message ? error.message : '');
  }

  // Deload_State is an optional tab and appendRows cannot create it — so a write
  // lifecycle action needs the tab to exist, mirroring /api/constraints' 503.
  const DELOAD_STATE_MISSING_MSG =
    'Deload_State tab not found — create it in Google Sheets first (columns: updated_at, training_state, deload_protocol, deload_reason, deload_start_date, deload_sessions_remaining, deload_exit_criteria)';

  async function deloadStateTabPresent() {
    const tabs = await getSpreadsheetTabs().catch(() => []);
    return tabs.includes('Deload_State');
  }

  // Classify a lifecycle write failure: 409 for a genuine illegal move, else 500
  // with a fixed message (raw error as the detail, never the user-facing message).
  function sendDeloadError(req, res, error, friendlyConflict) {
    if (isDeloadConflict(error)) {
      return standardError(req, res, friendlyConflict, error.message, 409);
    }
    return standardError(req, res, 'Failed to update deload state', error.message, 500);
  }

  // POST /api/deload/begin — owner invokes a deload. The protocol is selected from
  // the training focus (deterministic); nothing is invented.
  router.post('/api/deload/begin', async (req, res) => {
    const body = req.body || {};
    const focus = typeof body.focus === 'string' ? body.focus : 'strength';
    const protocol = selectProtocol(focus);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'owner invoked';
    const sessionsRaw = Number(body.sessions_remaining);
    const sessions_remaining = Number.isFinite(sessionsRaw) && sessionsRaw > 0
      ? Math.floor(sessionsRaw)
      : protocol.duration_min_exposures;
    const exit_criteria = typeof body.exit_criteria === 'string' && body.exit_criteria.trim()
      ? body.exit_criteria.trim().slice(0, 200)
      : protocol.exit;
    if (!(await deloadStateTabPresent())) {
      return standardError(req, res, DELOAD_STATE_MISSING_MSG, null, 503);
    }
    try {
      const state = await beginDeload({ protocol, reason, sessions_remaining, exit_criteria });
      return standardSuccess(req, res, 'Deload started', { state });
    } catch (error) {
      return sendDeloadError(req, res, error, 'Cannot start a deload from the current training state');
    }
  });

  // POST /api/deload/advance — record that a deload session was completed.
  router.post('/api/deload/advance', async (req, res) => {
    if (!(await deloadStateTabPresent())) {
      return standardError(req, res, DELOAD_STATE_MISSING_MSG, null, 503);
    }
    try {
      const state = await recordDeloadSession({});
      return standardSuccess(req, res, 'Deload session recorded', { state });
    } catch (error) {
      return sendDeloadError(req, res, error, 'No active deload to advance');
    }
  });

  // POST /api/deload/resolve — close out the post-deload evaluation back to NORMAL.
  router.post('/api/deload/resolve', async (req, res) => {
    if (!(await deloadStateTabPresent())) {
      return standardError(req, res, DELOAD_STATE_MISSING_MSG, null, 503);
    }
    try {
      const state = await resolvePostDeload({});
      return standardSuccess(req, res, 'Deload resolved', { state });
    } catch (error) {
      return sendDeloadError(req, res, error, 'No post-deload evaluation to resolve');
    }
  });


  router.get('/api/debug/exercise-match', async (req, res) => {
    const input = String(req.query.q || '').trim();
    if (!input) return standardError(req, res, 'Query param q is required', null, 400);

    try {
      const catalogRows = await getExerciseCatalog();
      const catalogMap = buildExerciseCatalogMap(catalogRows);
      const normalized_key = normalizeExerciseKey(input);
      const match = catalogMap.get(normalized_key);
      if (match) {
        return standardSuccess(req, res, 'Exercise match debug', {
          input,
          normalized_key,
          catalog_match: true,
          canonical_exercise: match.canonical_exercise,
          muscle_group: match.muscle_group,
          lift_code: match.lift_code,
          warning: match.lift_code ? null : 'Lift code is blank for this catalog match.',
          closest_matches: []
        });
      }

      return standardSuccess(req, res, 'Exercise match debug', {
        input,
        normalized_key,
        catalog_match: false,
        canonical_exercise: '',
        muscle_group: '',
        lift_code: '',
        warning: null,
        closest_matches: closestExerciseMatches(input, catalogMap)
      });
    } catch (error) {
      return standardError(req, res, 'Failed to debug exercise match', error.message, 500);
    }
  });

  return router;
};
