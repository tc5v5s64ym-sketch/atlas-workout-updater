# Atlas — Mobile Test App (iPhone home-screen PWA)

How to run Atlas from an iPhone home-screen icon for live gym testing — no Safari
chrome, no accidental pull-to-refresh, and no easy loss of an in-progress session.

Atlas is a PWA: a standalone `manifest.json`, the iOS web-app meta tags, and a
service worker that caches the app shell. This doc is for **testing**, not a store
release.

---

## Install Atlas to the iPhone home screen

1. Open the Atlas app URL in **Safari** (iOS only adds PWAs to the home screen from
   Safari, not Chrome): `https://<your-atlas-host>/app/`.
2. Tap the **Share** button (the square with the up-arrow).
3. Scroll down and tap **Add to Home Screen**.
4. The name should pre-fill as **Atlas** (from the manifest's `apple-mobile-web-app-title`
   / `short_name`). Tap **Add**.
5. Launch Atlas from the new home-screen icon. It opens **standalone** — full screen,
   no Safari address bar or tab bar (`display: standalone`, `apple-mobile-web-app-capable`).

> Set your API key once in **Settings** (it persists in `localStorage`).

To get the latest build after a deploy: the service worker is **network-first** for the
app shell, so just relaunch with connectivity. You can confirm the running build in
**Settings → "Running shell: vNN"**, and verify the coach LLM with **Settings → Debug
→ Test coach connection**.

---

## What protects your session during testing

- **No pull-to-refresh / bounce reload.** `overscroll-behavior-y: none` on the page
  stops an accidental downward drag at the top from reloading. (In a standalone PWA
  there's no browser chrome to refresh anyway; this also protects in-Safari testing.)
  The in-thread coach scroll still scrolls normally.
- **Unsaved-work warning.** If you've logged sets that aren't saved yet, a refresh or
  close prompts a native "Leave site?" confirmation. No warning fires when nothing is
  logged.
- **Session persistence / resume.** The in-progress session — your logged sets
  (`sessionLog`), their resolved identities (`sessionCompleted`), and the live plan
  (`activePlannedSession`) — is snapshotted to `localStorage` (key
  `atlas_session_snapshot_v1`) on each logged set, when the app is backgrounded, and
  before unload. On next launch within **12 hours**, Atlas restores it so you resume
  mid-session. The snapshot is **cleared** on a successful save and on **Start Over**,
  and a stale (>12h) or malformed snapshot is ignored — it can never resurrect an old
  or corrupt session.

This is **persistence/resume only**. It does not change coaching, parsing, or the
preview → approve → write trust loop — the snapshot stores the same buffers Atlas
already holds, and the owner still approves every real write.

---

## How to test session persistence

1. Start a session (Coach's Pick) or log a few sets in the composer.
2. **Background test:** swipe Atlas away (app switcher) or lock the phone, then
   reopen from the home-screen icon → your logged sets + active plan should still be
   there (the active-session banner reappears).
3. **Force-quit test:** swipe up to fully close Atlas, relaunch → same resume.
4. **Reload test (in Safari):** pull-to-refresh should NOT reload the page. If you
   reload via the address bar with unsaved sets, you should get the "Leave site?"
   warning; choosing to stay keeps everything; reloading anyway still resumes from the
   snapshot.
5. **Save clears it:** complete a normal save (preview → approve → write). After the
   write, relaunching should NOT resume the saved session (snapshot cleared).
6. **Start Over clears it:** tap Start Over, relaunch → no resume.
7. **Staleness:** a snapshot older than 12h is ignored on launch (fresh start).

If a resume ever looks wrong, **Settings → Debug → Show session state** dumps the live
in-memory session for diagnosis.
