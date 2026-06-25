# Atlas Architecture

## Current System

- User/AI interface prepares workout data.
- Node/Express backend validates, enriches, and writes data.
- Render hosts production.
- Google Sheets is the primary data store.
- OpenAI Vision parses workout screenshots.
- GitHub Actions Mission Control runs production smoke tests.
- API key auth protects `/api/*`.

## Data Flow

1. User logs a workout or uploads an Apple Watch screenshot.
2. Vision parses effort details when an image is provided.
3. Manual or extracted set rows are normalized.
4. Backend validates row shape and duration/date values.
5. Exercise catalog enrichment fills canonical exercise, muscle group, and lift code.
6. `test_mode=true` previews the result without writing.
7. Owner/client approves a real write later.
8. Backend appends rows to `Log_Cleaned` and `Effort`.
9. Sheet formulas update summary views.
10. History, progress, recommendation, and volume endpoints read from the sheet.

## LLM Layer

Atlas uses LLM providers (OpenAI, Gemini) for two purposes only:

1. **Vision** — parsing Apple Watch / workout screenshot images (`services/vision.js`).
2. **Coaching voice** — wording facts the deterministic engine emits and answering grounded session questions (`services/coach.js`).

The deterministic engine is authoritative. LLMs are an optional coaching layer, never a source of truth. A provider outage must never interrupt workout logging, preview, save, or session mutation.

See [`docs/LLM_ARCHITECTURE.md`](./LLM_ARCHITECTURE.md) for:
- Core principles (P1–P6): determinism-first, optional coaching layer, error boundary, provider interface, cost via determinism
- Routing tiers: Tier 0 deterministic / Tier 1 cheap+fast coach / Tier 2 capable model
- Provider candidate scoring (June 2026 data, with sources)
- Error boundary specification and error class taxonomy
- Provider interface definition
- Implementation PR sequence (8 slices, boundary-first order)
- Sequencing rule: build only after P0 workout reliability is stable in live use

---

## Future Options

### Option A: Sheets Primary

Best while the system is small and owner-operated. Lowest complexity, easiest manual recovery.

### Option B: Database Primary Plus Sheets Export

Best when Atlas needs stronger query speed, transactions, and app UX. Sheets remains reporting/export.

### Option C: Full App Backend

Best when Atlas has multi-user auth, mobile clients, richer coaching, and long-term analytics.

## Technical Risks

- Google Sheets scalability.
- Duplicate writes.
- Formula drift.
- Secret hygiene.
- Vision parsing variance.
- Mobile review/approval UX.
- Debug/admin endpoint exposure if auth is weakened.

## Near-Term Architecture Recommendation

Stay Sheets-primary for v1. Add tests, no-write safety, better docs, and a future migration plan before introducing a database.
