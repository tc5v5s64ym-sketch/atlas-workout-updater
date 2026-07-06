'use strict';

const globals = require('globals');

// Cross-file globals: functions/objects defined in one public/ browser script
// and consumed by another (or by e2e tests via page.evaluate). Declaring them
// here prevents false-positive no-undef errors; the real fix is Phase 1 PR-08/09
// (ES module conversion), after which these globals are replaced by imports.
const appPublicGlobals = {
  addSetRow: 'readonly',
  activeSession: 'readonly',
  api: 'readonly',
  coachVoiceTemplates: 'readonly',
  displayBlockNormalizer: 'readonly',
  fetchReaction: 'readonly',
  firstUnloggedPlannedLift: 'readonly',
  FRIENDLY_PATTERN_LABELS: 'readonly',
  FRIENDLY_STATUS_WORDS: 'readonly',
  getActiveIntentId: 'readonly',
  getActivePlannedSession: 'readonly',
  getApiKey: 'readonly',
  getPlanTodayByName: 'readonly',
  getSessionCompleted: 'readonly',
  invalidatePreview: 'readonly',
  normalizePlanExercise: 'readonly',
  plannedExerciseOrder: 'readonly',
  previewSetsForLift: 'readonly',
  remainingPlannedExercises: 'readonly',
  sessionQuestion: 'readonly',
  setCoachSuggestionEngaged: 'readonly',
  setsTableBody: 'readonly',
  startPlannedSession: 'readonly',
};

const nodeRules = {
  'no-undef': 'error',
  // caughtErrors:'none' suppresses unused catch bindings (err, error) — catching
  // without using the error is intentional in many error-swallowing paths.
  // varsIgnorePattern:'^_' follows the conventional "intentionally unused" prefix.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'eqeqeq': 'warn',
  // no-implicit-globals is intentionally omitted for Node CJS files: ESLint only
  // exempts sourceType:'module' from this rule, not 'commonjs', causing false
  // positives for every top-level declaration in CJS modules, which are already
  // module-scoped by Node's wrapper function.
  'no-var': 'error',
};

const browserRules = {
  ...nodeRules,
  // no-implicit-globals applies to browser scripts where top-level declarations
  // genuinely leak to window. Files that intentionally export globals carry a
  // file-level eslint-disable pointing to Phase 1 PR-08/09 (ES module conversion).
  'no-implicit-globals': 'error',
};

module.exports = [
  {
    ignores: ['node_modules/**'],
  },

  // Node.js CJS backend: index, sheets, middleware, services, scripts, config, tests
  {
    files: [
      'index.js',
      'sheets.js',
      'middleware.js',
      'response.js',
      'services/**/*.js',
      'scripts/**/*.js',
      'config/**/*.js',
      'test/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: nodeRules,
  },

  // Browser + Node dual: public/*.js use the UMD global-export pattern.
  // Files with pervasive top-level global declarations carry a file-level
  // eslint-disable no-implicit-globals; see Phase 1 PR-08/09 for the real fix.
  {
    files: ['public/**/*.js'],
    ignores: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...appPublicGlobals,
      },
    },
    rules: browserRules,
  },

  // Service worker (browser-adjacent runtime)
  {
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.serviceworker,
      },
    },
    rules: browserRules,
  },

  // Playwright e2e specs — run in Node but lambdas passed to page.evaluate()
  // reference browser globals and cross-file app globals defined in public/.
  {
    files: ['tests/e2e/**/*.spec.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...appPublicGlobals,
      },
    },
    rules: nodeRules,
  },
];
