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
    // Formatting is guarded separately from logging: String(reason) can
    // throw (a null-prototype object), JSON.stringify can throw, and a
    // hostile getter can throw — every one of those must still produce the
    // fallback line instead of crashing the process from inside its own
    // backstop (review nit on the first INFRA-5 head).
    let line;
    try {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      line = JSON.stringify({
        event: 'unhandled_rejection',
        error: error.message,
        stack: error.stack || null,
      });
    } catch {
      line = '{"event":"unhandled_rejection","error":"unformattable rejection reason","stack":null}';
    }
    try { log(line); } catch { /* the backstop never throws */ }
  });
  return true;
}

module.exports = { installUnhandledRejectionBackstop };
