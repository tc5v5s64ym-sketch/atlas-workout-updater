# No-Write Safety Contract

Atlas production dry-runs are allowed only when `test_mode=true`.

## Proof Required

Mission Control treats a dry-run as safe only when one of these proofs is present:

- `test_mode:true`, `sheet_written:false`, and `no_write_confirmed:true`
- legacy compatibility only: `test_mode:true` and `sheet_write:"skipped"`

`would_write:true` is not no-write proof. It only means the request looked valid enough that a real write might have happened if `test_mode` were off.

## Current Coverage

- Mission Control rejects `test_mode:false`.
- Mission Control rejects `sheet_written:true`.
- Mission Control rejects missing no-write proof.
- Mission Control rejects responses that only contain `would_write:true`.
- Mission Control accepts top-level, nested, and legacy skipped no-write responses.

## Deferred Endpoint Tests

Full endpoint-level no-append tests for `/api/log-workout` and `/api/complete-workout` should be added after the Express app and Sheets append dependency are modularized for injection. Doing that as a broad overnight refactor would be higher risk than useful.
