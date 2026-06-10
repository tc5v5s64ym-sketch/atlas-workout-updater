# First Real Write Plan

No real post-cutover write has been performed yet.

Do not perform this until the owner explicitly approves.

## Conditions Before Approval

- Cleaned-sheet read-only Mission Control is green.
- Cleaned-sheet full Mission Control is green.
- Dry-run proves `test_mode:true`.
- Dry-run proves `sheet_written:false`.
- Dry-run proves `no_write_confirmed:true`.
- Dry-run session does not appear in history.
- Owner explicitly says to perform the first real write.

## Tiny Real Write Shape

Use one unique session ID, for example:

```text
ATLAS-FIRST-REAL-WRITE-YYYYMMDD-01
```

Use the smallest useful fake workout:

- One exercise.
- One set.
- Clear notes marking it as an Atlas production smoke test.

## Verify

- Row appears in `Log_Cleaned`.
- Matching effort row appears in `Effort` if effort is included.
- `/api/history/recent` includes the session.
- `/api/session/<session-id>` returns the row.
- `/api/session/<session-id>/summary` behaves as expected.
- Duplicate protection blocks a repeated session ID.

## Cleanup

If cleanup is supported, remove or mark the test data clearly. If cleanup is not supported, leave the notes clearly marked so it is never mistaken for a real workout.
