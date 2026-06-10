# Atlas First Real Write Approval

This checklist is the owner approval gate before Atlas performs the first real production write to the cleaned sheet.

## Preconditions

- [ ] Backup Google Sheet copy exists.
- [ ] Mission Control `full` with sheet label `cleaned` passes.
- [ ] Secrets have been rotated.
- [ ] `.env` is untracked.
- [ ] Dashboard remains optional.
- [ ] Owner explicitly approves the first real write.

## Exact Approval Phrase

Use this exact phrase when approving the first real production write:

```text
I approve Atlas to perform the first real production write to the cleaned sheet.
```

## Write Options

### Option A - Tiny Smoke Write

- Use a unique session ID.
- Write one tiny clearly marked test workout.
- Mark notes clearly as a smoke write.
- Verify the row appears where expected.
- Decide whether to leave it marked or clean it up manually.

### Option B - Next Real Workout

- Use the next actual workout.
- Keep normal workout notes.
- Verify all read APIs after the write.

Recommendation: the next real workout is cleaner if the owner is comfortable waiting.

## Verification Checklist

- [ ] `Log_Cleaned` row appears for the unique session ID.
- [ ] `Effort` row appears if effort data was included.
- [ ] `Session_Summary` updates.
- [ ] `/api/history/recent` includes the session.
- [ ] `/api/session/:sessionId` returns the session.
- [ ] `/api/session/:sessionId/summary` returns the summary.
- [ ] No duplicate row appears.
- [ ] Mission Control `read-only` passes after the write.

## Rollback Checklist

- [ ] Stop immediately if the write fails or looks wrong.
- [ ] Do not repeat blind writes.
- [ ] Identify the exact session ID.
- [ ] Inspect `Log_Cleaned` and `Effort` rows.
- [ ] Compare against the backup sheet.
- [ ] Restore or correct manually only after confirming the backup exists.
- [ ] Run Mission Control `read-only`.
- [ ] Run Mission Control `full` only when a `test_mode=true` dry-run is appropriate.
