'use strict';

// Shared harness preamble (PR-10). Several tests eval *slices* of app.js in an
// isolated `new Function` scope, injecting the session/plan state as local `let`s.
// After PR-10 those sliced functions call the store getters/setters (imported from
// store.js) instead of touching bare top-level `let`s. This shim declares the same
// harness-local buffers and maps the store API onto them, so a slice runs in
// isolation exactly as before. The store module itself is unit-tested in
// test/store.test.js; here it is stubbed so the app.js logic under test is exercised
// against controllable state. Interpolate as `${STORE_SHIM}` inside the Function body.
module.exports.STORE_SHIM = `
    let activePlannedSession = null;
    let sessionChromeExpanded = false;
    let coachSuggestionEngaged = false;
    let pendingSubstitution = null;
    let sessionLog = [];
    let sessionCompleted = [];
    let sessionSavedLog = [];
    let sessionRevisions = [];
    let sessionImplicitRecs = [];
    let coachDiscussionSinceLog = false;
    function getActivePlannedSession(){ return activePlannedSession; }
    function setActivePlannedSession(v){ activePlannedSession = v || null; }
    function getSessionChromeExpanded(){ return sessionChromeExpanded; }
    function setSessionChromeExpanded(v){ sessionChromeExpanded = !!v; }
    function getCoachSuggestionEngaged(){ return coachSuggestionEngaged; }
    function setCoachSuggestionEngaged(v){ coachSuggestionEngaged = !!v; }
    function getPendingSubstitution(){ return pendingSubstitution; }
    function setPendingSubstitution(v){ pendingSubstitution = v || null; }
    function getSessionLog(){ return sessionLog; }
    function setSessionLog(v){ sessionLog = Array.isArray(v) ? v : []; }
    function getSessionCompleted(){ return sessionCompleted; }
    function setSessionCompleted(v){ sessionCompleted = Array.isArray(v) ? v : []; }
    function getSessionSavedLog(){ return sessionSavedLog; }
    function setSessionSavedLog(v){ sessionSavedLog = Array.isArray(v) ? v : []; }
    function getSessionRevisions(){ return sessionRevisions; }
    function setSessionRevisions(v){ sessionRevisions = Array.isArray(v) ? v : []; }
    function getSessionImplicitRecs(){ return sessionImplicitRecs; }
    function setSessionImplicitRecs(v){ sessionImplicitRecs = Array.isArray(v) ? v : []; }
    function getCoachDiscussionSinceLog(){ return coachDiscussionSinceLog; }
    function setCoachDiscussionSinceLog(v){ coachDiscussionSinceLog = !!v; }
`;
