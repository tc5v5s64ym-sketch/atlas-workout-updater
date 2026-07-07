# PR-09b — app.js → ES modules: computed extraction map

> Produced by AST analysis (espree + eslint-scope) of `src/app/app.js` at the
> post-PR-09a HEAD (`a8745d6`). Ground truth, not hand-tracing. Regenerate with
> `_pr09b_analyze.js` + `_pr09b_graph.js` if app.js moves.

## Inventory
- **305 top-level symbols**: 241 functions, 33 `const`, 31 reassigned `let`, 0 `var`.
- The 31 `let`s are exactly the Minefield Map §2 "31 variables".

## sharedState set — the 9 `let`s written from a FOREIGN module
An imported ES-module `let` binding is **read-only** in the importer; a `let` that
is reassigned from a module other than its owner therefore cannot be an exported
binding — it must live on a mutable `sharedState` object. Only these 9 qualify
(the other 22 reassigned `let`s are written solely within their owning module and
can be exported for cross-module **reads**):

| let | owner module | foreign writer(s) |
|---|---|---|
| `atlasLastError` | bugReport | api |
| `historyLoaded` | historyView | sessionFlow |
| `pendingWrite` | logger | sessionFlow |
| `lastParsedWorkoutText` | logger | sessionFlow |
| `lastParserStatus` | logger | sessionFlow |
| `lastIntentData` | logger | dashboard |
| `sessionCompiledAwaitingPreview` | logger | sessionFlow |
| `lastWrite` | logger | sessionFlow |
| `logDateManuallyEntered` | sessionFlow | main |

## §2c disposition (Minefield Map PR-09 checklist)
- **Group 1** (`sessionLog`, `sessionCompleted`, `sessionSavedLog`): session-owned;
  written only within the session module → stay module-local, exported for reads.
  (PR-10 moves them to the store WITH `activePlannedSession`.)
- **Group 2** (`lastWrite`, `writeInFlight`, `pendingBwWrite`, closeout trio,
  `logDateManuallyEntered`): write-path. `lastWrite` + `logDateManuallyEntered`
  are foreign-written → `sharedState`; the rest stay module-local (written only in
  their owner) and are exported. (PR-11 moves them to the store.)
- **Group 3** (caches/view-local, 9 vars): module-locals in their extracted module.

## Line-footprint problem (≤900-line acceptance gate)
Following the section comments, the named slices do NOT fit ≤900 lines:
- `dashboard` ≈ 1008 file-lines, `logger` ≈ 942 — at/over cap.
- `sessionFlow` ≈ 2,400 code-lines (the "Mobile PWA persistence/resume" section
  alone is ~2,400 lines and **contains the entire trust loop** — `emitSetLogged`,
  `previewSetsForLift`, `handleLogIt`, `runCloseout`, `generateWriteId`, proof
  helpers, `renderLogWorkoutPreview`/`renderCompleteWorkoutPreview`,
  `handleUndoLastWrite`, lines 5159–6758).

Meeting ≤900 forces ~13–14 modules, not the 10 named. The trust-loop functions
are the highest-risk to relocate (behavior-frozen, relocate-not-change).

## Module dependency graph is CYCLIC (the key finding)
Computed module→module import edges (`_pr09b_edges.js`):

| module | imports from (count) |
|---|---|
| api | bugReport(5) |
| bugReport | dashboard(1) |
| dom | api(2) |
| settingsHealth | api(1) |
| progressView | api(2), dom(3), dashboard(1) |
| historyView | api(1), dom(2), dashboard(1), logger(1) |
| **dashboard** | bugReport(12), api(2), dom(2), settingsHealth(1), **sessionFlow(16)**, **logger(6)**, main(1) |
| **sessionFlow** | api(2), dom(4), historyView(1), dashboard(2), **logger(22)**, main(1) |
| **logger** | api(2), dom(4), dashboard(1), **sessionFlow(6)** |
| main | (imports everything: sessionFlow 66, logger 33, dashboard 12, …) |

**`dashboard ↔ sessionFlow ↔ logger` form a dense import cycle, and `logger` is the
trust loop** (preview→approve→write→undo). The other six modules (api, dom, bugReport,
settingsHealth, historyView, progressView) depend mostly *downward* (api/dom) with only
thin single edges into the core, so they extract cleanly. The coupled triad does not:
a mechanical split of it yields circular ES imports through the write path.

The spec assumes the mechanical file split (PR-09) precedes the state-store extraction
(PR-10/11). For the coupled core that ordering is questionable — the coupling that makes
the triad hard to split is exactly the shared session/write **state** that PR-10/11 move
to a store. Cleanly separating dashboard/sessionFlow/logger likely wants the store to
exist first (or to happen in the same step).

## Recommended staging
1. **PR-09b (safe, low-risk):** extract the six cleanly-separable modules — `api`, `dom`,
   `bugReport`, `settingsHealth`, `historyView`, `progressView` — plus `sharedState.js`
   for the cross-boundary `let`s that this subset touches. Shrinks app.js ~800 lines with
   no trust-loop code moved, no cycles introduced. Full suite + e2e + guard tests gate it.
2. **Core triad (dashboard/sessionFlow/logger):** revisit after — either as a scrutinized
   PR-09c with byte-for-byte `atlas:*` payload tests, or folded into the PR-10/11 store
   ordering. Owner decision (touches the trust-loop file).
