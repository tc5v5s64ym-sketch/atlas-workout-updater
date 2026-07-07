// Atlas frontend build — Stage-1 Vite wrapper (see docs/ARCHITECTURE.md → "Frontend build").
//
// This is intentionally a *pass-through* stage: the frontend sources live in
// `src/app/` and Vite copies them to `public/` byte-for-byte — no bundling, no
// hashing, no ES-module conversion. `express.static('public')` (index.js) and the
// service worker's `/app/*` SHELL_ASSETS URLs stay exactly as they are, so the
// built app is behaviorally identical to hand-serving the old `public/` tree.
//
// The classic (non-module) `<script>` tags cannot pass through Rollup as entries,
// so the build treats `src/app` as Vite's `publicDir` (verbatim copy) and uses a
// virtual no-op entry only to satisfy Rollup's mandatory `input`. That entry's
// empty chunk is dropped in `generateBundle`, leaving a clean copy.
//
// Later phases (PR-08+) convert the satellites to ES modules and let Vite actually
// bundle; until then, output URLs must not change.

const path = require('node:path');
const { defineConfig } = require('vite');

const APP_SRC = path.resolve(__dirname, 'src/app');
const OUT_DIR = path.resolve(__dirname, 'public');
// The dev proxy points at the same Express backend index.js binds to.
const BACKEND_PORT = process.env.PORT || 3000;

// Vite build requires a Rollup entry. We have none (nothing is bundled in
// Stage-1), so inject a virtual module and delete its emitted chunk. The real
// output is the verbatim `publicDir` copy.
function verbatimCopyOnly() {
  const VIRTUAL = '\0atlas-noop-entry';
  return {
    name: 'atlas-verbatim-copy-only',
    options(options) {
      return { ...options, input: VIRTUAL };
    },
    resolveId(id) {
      return id === VIRTUAL ? VIRTUAL : null;
    },
    load(id) {
      return id === VIRTUAL ? 'export default 0;' : null;
    },
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        const chunk = bundle[name];
        if (chunk.facadeModuleId === VIRTUAL || name.includes('atlas-noop-entry')) {
          delete bundle[name];
        }
      }
    }
  };
}

module.exports = defineConfig(({ command }) => {
  if (command === 'serve') {
    // `npm run dev`: Vite dev server (HMR) serving the sources under /app/, with
    // /api proxied to the backend (run `npm run dev:server` in another terminal).
    return {
      root: APP_SRC,
      base: '/app/',
      publicDir: false,
      server: {
        proxy: {
          '/api': { target: `http://localhost:${BACKEND_PORT}`, changeOrigin: false }
        }
      }
    };
  }

  // `npm run build`: verbatim copy src/app -> public. emptyOutDir:false so the
  // build never deletes the gitignored public/build-info.json (written by
  // scripts/write-build-info.js at install/build time) or any other runtime file.
  return {
    root: __dirname,
    publicDir: APP_SRC,
    plugins: [verbatimCopyOnly()],
    logLevel: 'warn',
    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      copyPublicDir: true,
      rollupOptions: {
        // The virtual entry legitimately produces an empty chunk; don't warn.
        onwarn(warning, defaultHandler) {
          if (warning.code === 'EMPTY_BUNDLE') return;
          defaultHandler(warning);
        }
      }
    }
  };
});
