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
