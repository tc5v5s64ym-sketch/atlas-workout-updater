# Atlas Simulation Harness

V1 defaults to read-only scenario runs against a local Atlas server. V1.2 adds sandbox-only synthetic workout write scenarios with varied session templates.

## Safety

- Default mode is read-only.
- Read-only runs allowlist read-oriented endpoints only.
- `--mode write --sandbox` validates harness intent, but it does not reconfigure the running Atlas server.
- Every run calls `/api/debug/config` first to verify the server's active sheet fingerprint.
- Read-only runs warn when verification is unavailable or production-pointed, then continue.
- Write/sandbox runs require `--enable-write-scenarios` and fail unless the server confirms it is using the sandbox sheet.
- Start Atlas locally with sandbox sheet env before enabling future write scenarios:

```powershell
$env:GOOGLE_SHEETS_ID='1UuprDIBoV2Y9jEraOkKaqdX1PHE6ESiF9ZLFJH3CeXE'
node index.js
```

Do not run write-capable simulation scenarios against a server configured with the production Atlas MASTER sheet ID.

## Run

```powershell
node scripts\sim\run.js --base-url http://127.0.0.1:3000
```

## Sandbox Mock Sessions

```powershell
node scripts\sim\run.js --mode write --sandbox --enable-write-scenarios --base-url http://127.0.0.1:3000
```

Batch mode cycles through push, pull, legs, upper, full body, and cardio/recovery sessions:

```powershell
node scripts\sim\run.js --mode write --sandbox --enable-write-scenarios --runs 100 --base-url http://127.0.0.1:3000
```

The harness retries transient local request failures such as Sheets quota/rate-limit responses before marking a run failed. Defaults are `--retry-attempts 5` and `--retry-delay-ms 65000`.

For live Google Sheets runs, add pacing if the Sheets read quota is tight:

```powershell
node scripts\sim\run.js --mode write --sandbox --enable-write-scenarios --runs 100 --delay-ms 9000 --base-url http://127.0.0.1:3000
```
