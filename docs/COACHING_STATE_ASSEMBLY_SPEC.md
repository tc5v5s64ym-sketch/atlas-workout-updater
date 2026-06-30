# Atlas Coaching Engine — State Assembly Spec (Layer ③)

> **Status:** Narrow spec doc. Implements layer ③ of `docs/COACHING_ENGINE_ARCHITECTURE.md`.
> **Scope:** the read-model hydration layer the CapabilityManifest input keys draw from. Spec only — the module is the next build step.
> **Sequence:** One-Brain build step 4 (`BACKLOG.md` → "One-Brain Coaching Engine").

---

## Why this layer exists

The Brain modules are **pure functions over a state snapshot** — they never read Sheets. Something must read Sheets *once* per request and hand the same snapshot to every module the Orchestrator runs. That is **State Assembly**: the single place all coaching-read I/O is quarantined, so the Brain stays pure and offline-testable.

It is the one seam the three contracts reference (`requires`/`optional` input keys in `CapabilityManifest`) but do not themselves define.

**Read-only.** State Assembly never writes. The preview→approve→write trust loop is untouched and lives entirely outside the Brain. This layer is the first in the One-Brain build that touches Sheets *at all*, and it touches them **read-only**.

---

## The input-key vocabulary it hydrates

State Assembly produces every **state-derived** input key in `config/coaching/manifests/capabilities.json` (`input_keys`). The **intent-derived** keys (`constraint.*`, `readiness_inputs`, `signal`) come from the IntentEnvelope, not from here.

| Input key | Source | Notes |
|---|---|---|
| `log_history` | `trainingStore.getLogRows()` (or `getRecentLogRows(limit)`) | The `Log_Cleaned` rows. The backbone — most capabilities derive from it. |
| `deload_state` | `deloadState.readCurrentDeloadState()` | Already-live read of the `Deload_State` tab (last row = current). |
| `profile_goal` | profile reader (`getProfileGoal`) | Owner goal. Source exists; wire as a reader. |
| `training_level` | profile reader | beginner / intermediate / advanced. |
| `population` | profile reader | general / older-adult / youth / busy-parent / home-gym. |
| `memory_snapshot` | **derived** from `log_history` via `memoryModule.buildMemorySnapshot` | Computed, not separately read. |
| `bodyweight_history` | **derived** from `log_history` via `analytics.buildBodyweightHistory` | Computed, not separately read. |
| `equipment_profile` | **not yet persisted** → `null` | No durable source today; per-request equipment arrives via `constraint.equipment` on the envelope. Hydrate when a source exists. |

**Derived vs read:** State Assembly performs the minimum reads (`log`, `deload_state`, `profile`) and *derives* the rest from `log_history` so the snapshot is internally consistent and reads are not duplicated.

---

## The injected-reader contract (the testability core)

State Assembly must **not** import `sheets.js` directly — `sheets.js` pulls in `googleapis` and performs live I/O, which would make the Brain layer untestable offline. Instead it takes its readers by **dependency injection**, defaulting to the existing `services/trainingStore.js` + `services/deloadState.js`:

```
assembleState({ readers?, asOf, options? }) → Promise<StateSnapshot>

readers = {
  getLogRows:            () => Promise<row[]>,      // default: trainingStore.getLogRows
  readDeloadState:       () => Promise<object|null>,// default: deloadState.readCurrentDeloadState
  getProfile:            () => Promise<profile>,    // default: profile reader
}
```

- **Production:** `assembleState({ asOf })` uses the default readers (real Sheets via `trainingStore`).
- **Tests:** `assembleState({ readers: stubReaders, asOf })` injects in-memory fixtures — **no live Sheets, no `googleapis`**, fully deterministic. This mirrors the existing test discipline (the suite stubs `sheets.js` via `require.cache`; State Assembly makes the seam explicit instead).

State Assembly itself contains **no coaching logic** — it reads and shapes. Interpretation belongs to the Brain modules.

---

## The snapshot shape

```
StateSnapshot {
  asOf:               ISO-8601 string,          // echoed from the request; drives all "days since" math
  log_history:        row[],                     // Log_Cleaned rows (normalized)
  deload_state:       object | null,             // current Deload_State (last row) or null
  profile: {
    profile_goal:     string | null,
    training_level:   string | null,
    population:       string | null,
  },
  memory_snapshot:    object | null,             // derived from log_history
  bodyweight_history: object | null,             // derived from log_history
  equipment_profile:  null,                      // until a durable source exists
  provenance: {
    reads:            string[],                  // which readers ran ('log','deload_state','profile')
    derived:          string[],                  // which keys were computed ('memory_snapshot',...)
    state_asOf:       ISO-8601 string,
  }
}
```

The Orchestrator passes this snapshot (plus the IntentEnvelope's constraints) to each resolved capability; a capability reads only the keys its descriptor declares in `requires`/`optional`.

### Resolving "known" for the missing-info handshake

State Assembly also exposes which input keys are **present** (non-null) in the snapshot, so the Orchestrator can diff a capability's `requires` against the hydrated state + envelope constraints to compute the missing-info set (the "know when it knows enough" handshake, `COACHING_CONTRACTS_SPEC.md §4`). This is bookkeeping, not coaching:

```
knownKeys(snapshot, envelope) → Set<inputKey>   // state keys present ∪ constraint keys provided
```

---

## Failure & degradation

- A reader that throws or returns empty does **not** crash assembly: the corresponding key is `null`/`[]` and recorded in `provenance` (not in `reads`). Downstream this surfaces as a `requires`-unmet capability → clarification or degraded decision, never a 500.
- Even the **default-reader layer failing to load** (e.g. the Sheets client cannot initialize) degrades to an empty snapshot rather than throwing — `_defaultReaders()` is wrapped so a load failure yields no readers and an all-null snapshot with empty `provenance.reads`.
- A provider/Sheets outage degrades the coaching read path gracefully; it must never interrupt logging, preview, save, or session mutation (Constitution: the engine and write path do not depend on the coaching read layer).

---

## Tests to eventually prove

- `assembleState` with stub readers builds a snapshot of the documented shape — **no live Sheets, no `googleapis` import path executed**.
- Derived keys (`memory_snapshot`, `bodyweight_history`) are computed from the injected `log_history`, not separately read.
- A throwing/empty reader yields `null`/`[]` for its key + correct `provenance`, never throws.
- `knownKeys` returns the union of present state keys and provided envelope constraint keys.
- `assembleState` is read-only: no write-path function is reachable from it (a guard test asserting it imports no writer).
- Purity of shaping: same readers + same `asOf` → same snapshot.

---

## What this unblocks

With State Assembly defined, the **Orchestrator `hybrid` shadow attach** (build step 5) can run the real substrate modules on a real snapshot and attach a `CoachingDecision` to `/api/recommend/next/:liftCode` under `ATLAS_COACH_ENGINE=hybrid` — observe-only, zero behavior change. That is the first step that touches `index.js`; it stays gated (`default legacy`) and is treated as high-risk per the trust rules.

**Owner-gated reminder:** nothing here is owner-gated (read-only, no schema, no LLM, no write). The owner-gated items remain the input-LLM provider/model and the proactivity policy, neither of which this layer needs.
