'use strict';

// INFRA-5 — process-level backstop for unhandled promise rejections.
//
// The route handlers are bare async functions on Express 4, which never
// forwards an async rejection to the error middleware: an unguarded
// `await` that throws becomes an unhandledRejection, and Node's default
// kills the process — potentially mid-write. This backstop is the one
// registration home: it logs the rejection loudly as a structured event
// and keeps the process alive. It never throws (even if the logger does)
// and never swallows silently — the log line is the surface.

const installedOn = new WeakSet();

function installUnhandledRejectionBackstop({ proc = process, log = console.error } = {}) {
  if (installedOn.has(proc)) return false;
  installedOn.add(proc);
  proc.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try {
      log(JSON.stringify({
        event: 'unhandled_rejection',
        error: error.message,
        stack: error.stack || null,
      }));
    } catch { /* the backstop never throws */ }
  });
  return true;
}

module.exports = { installUnhandledRejectionBackstop };
