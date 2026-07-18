/* Atlas service worker.
 *
 * Strategy:
 *  - API and health requests are NEVER intercepted or cached. Every workout
 *    preview/write must hit the real backend — a cached dry-run response
 *    would silently break the approve-before-save guarantee.
 *  - App shell (HTML/CSS/JS/manifest/icons) is network-first with cache
 *    fallback: deploys take effect on next load with connectivity, and the
 *    app still opens from the home screen on a dead gym connection.
 */

const CACHE_NAME = 'atlas-shell-v145';
const SHELL_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/store.js',
  '/app/planAcceptance.js',
  '/app/planOutcome.js',
  '/app/planCloseout.js',
  '/app/planCompletion.js',
  '/app/planSlotStatuses.js',
  '/app/sessionLedger.js',
  '/app/signals-core.js',
  '/app/api.js',
  '/app/dom.js',
  '/app/bugReport.js',
  '/app/settingsHealth.js',
  '/app/historyView.js',
  '/app/progressView.js',
  '/app/atlasEntry.js',
  '/app/legacyBridge.js',
  '/app/flightRecorder.js',
  '/app/nav.js',
  '/app/drawer.js',
  '/app/workoutSheet.js',
  '/app/chat.js',
  '/app/coach-conversation.js',
  '/app/coachVoiceTemplates.js',
  '/app/hybridCompare.js',
  '/app/sessionQuestion.js',
  '/app/activeSession.js',
  '/app/planMutationIntent.js',
  '/app/identityCorrection.js',
  '/app/sessionTally.js',
  '/app/pendingClarification.js',
  '/app/displayBlockNormalizer.js',
  '/app/manifest.json',
  '/app/fonts/space-grotesk.woff2',
  '/app/fonts/jetbrains-mono.woff2',
  '/app/fonts/inter.woff2',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never touch API traffic — no caching, no interception.
  if (url.pathname.startsWith('/api') || url.pathname === '/health') return;

  if (event.request.method !== 'GET' || !url.pathname.startsWith('/app')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
