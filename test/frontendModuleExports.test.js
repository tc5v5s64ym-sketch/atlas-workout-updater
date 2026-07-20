'use strict';

// PR-08 export-parity guard.
//
// The satellite scripts were converted from UMD (`const exported = {…}`) to ES
// modules with explicit named exports. This test pins each converted module's
// public surface to the exact key set the old UMD object exposed, so a forgotten
// or renamed export fails CI here instead of at runtime in some corner flow
// (potentially mid-workout). Update EXPECTED only alongside a deliberate,
// reviewed change to a module's public API.

const test = require('node:test');
const assert = require('node:assert/strict');

// The historical UMD key sets (what `root.X = exported` exposed on window before PR-08).
const EXPECTED = {
  activeSession: [
    'STATUS', 'createActiveSession', 'replaceExercise', 'skipExercise', 'markCompleted',
    'correctIdentity', 'insertExercise', 'reorderExercise', 'currentExercise', 'nextUp', 'remaining',
    'completedExercises', 'isComplete', 'hasLoggedWork', 'reconcileSubstitutedRemaining',
    'variantSatisfies',
    'entryMatches', 'findMatchIndex', 'toEntry',
  ],
  planMutationIntent: ['classifyMutationIntent', 'cleanName', 'splitTargets', 'resolvePlanTargets'],
  identityCorrection: ['classifyIdentityCorrection', 'cleanName'],
  displayBlockNormalizer: [
    'normalizeDisplayBlocks', 'looksLikeDisplayBlock', 'parseDisplaySetLine', 'isSetLine',
    'setLineHasLeftoverSets', 'isHeaderLine', 'cleanHeaderName',
  ],
  sessionQuestion: ['isSessionStateQuestion', 'isPlannedLiftQuestion'],
  coachVoiceTemplates: [
    'liftLabel', 'templatedSubstitutionLine', 'formatSubstituteCoachLine',
    'templatedNextMoveAdvisoryLine', 'templatedRecoveryAdvisoryLine',
    'governorOverridesProgressionInvite', 'templatedGovernorHoldLine', 'isBriefTier',
    'templatedAckLine', 'templatedOnPlanWrapLine',
  ],
  hybridCompare: [
    'STORAGE_KEY', 'MAX_STORED_ENTRIES', 'PREFERENCES', 'shouldShowCompareCard',
    'summarizeLegacy', 'summarizeBrian', 'buildComparisonEntry', 'loadComparisons', 'saveComparisonEntry',
  ],
  flightRecorder: [
    'FLUSH_AT', 'FLUSH_INTERVAL_MS', 'RING_MAX', 'ATLAS_EVENT_MAP', 'redactString', 'truncate',
    'buildClientEvent', 'shouldFlush', 'boundTailForKeepalive', 'KEEPALIVE_MAX_BYTES',
    'markIssue', 'getSessionId', 'requestHeaders', 'latestCoachMessage',
  ],
};

for (const [name, keys] of Object.entries(EXPECTED)) {
  test(`${name}.js exports exactly its historical UMD key set`, async () => {
    const ns = await import(`../src/app/${name}.js`);
    const actual = Object.keys(ns).filter(k => k !== 'default').sort();
    assert.deepEqual(actual, [...keys].sort(),
      `${name}.js export surface drifted from the pinned UMD contract`);
    for (const k of keys) {
      assert.notEqual(ns[k], undefined, `${name}.js export "${k}" is undefined`);
    }
  });
}
