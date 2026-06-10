# Atlas API Audit

All `/api/*` endpoints require `x-atlas-api-key`. Public endpoints are limited to health, version, routes, and root.

## Public Endpoints

| Method | Path | Writes | Purpose | Readiness |
| --- | --- | --- | --- | --- |
| GET | `/` | No | Basic service info | Ready |
| GET | `/health` | No | Render health check | Ready |
| GET | `/version` | No | Version/deploy identity | Ready |
| GET | `/routes` | No | Route inventory | Ready |

## Protected Read-Only Endpoints

| Method | Path | Purpose | Risk |
| --- | --- | --- | --- |
| GET | `/api/health/sheets` | Validate sheet reachability and required tabs | Low |
| GET | `/api/health/openai` | Confirm OpenAI configuration presence | Low |
| GET | `/api/history/recent` | Recent sessions and effort | Medium: private workout summary |
| GET | `/api/session/:sessionId` | Session detail | Medium: private workout data |
| GET | `/api/session/:sessionId/summary` | Sheet-backed session summary | Medium |
| GET | `/api/exercises/:liftCode` | Exercise detail | Low |
| GET | `/api/exercises/:liftCode/progress` | Exercise progress | Medium |
| GET | `/api/recommend/next/:liftCode` | Next set recommendation | Medium |
| GET | `/api/volume/muscle-groups` | Muscle group volume | Medium |
| GET | `/api/search/sessions` | Session search | Medium |
| GET | `/api/prs/recent` | Recent PRs | Medium |
| GET | `/api/catalog/search` | Catalog search | Low |
| GET | `/api/pending-exercises` | Pending unknown exercises | Low |
| GET | `/api/bodyweight/history` | Bodyweight history | Medium |
| GET | `/api/debug/config` | Safe config diagnostics | Medium: keep protected |
| GET | `/api/debug/exercise-match` | Exercise matching diagnostics | Low |
| GET | `/api/schema/log` | Log schema | Low |
| GET | `/api/schema/effort` | Effort schema | Low |
| GET | `/api/schema/complete-workout` | Complete-workout schema | Low |

## Protected Write-Capable Endpoints

| Method | Path | test_mode | Purpose | Risk |
| --- | --- | --- | --- | --- |
| POST | `/api/log-workout` | Yes | Append workout rows and optional effort | High |
| POST | `/api/parse-workout-image` | No sheet write intended | Parse Apple Watch screenshot | Medium |
| POST | `/api/complete-workout` | Yes | Parse/enrich/validate/append complete session | High |
| POST | `/api/bodyweight` | No | Append bodyweight entry | High |
| POST | `/api/admin/preview-test-rows` | Preview only | Preview row formatting | Medium |

## Recommended Tests

- Auth rejection for every protected endpoint.
- Response shape tests for success/error helpers.
- Endpoint-level no-append tests for `test_mode=true` after app dependency injection is available.
- Duplicate session protection tests.
- Bodyweight endpoint tests before heavy use.
- Debug/admin endpoint visibility tests.

## Production Notes

- Do not expose raw credentials.
- Do not print API keys.
- Keep debug/admin endpoints protected.
- Use Mission Control before and after any production cutover.
