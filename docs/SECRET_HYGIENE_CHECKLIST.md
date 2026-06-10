# Atlas Secret Hygiene Checklist

## Repo Protection Complete

- [ ] PR #29 merged.
- [ ] PR #30 merged.
- [ ] `.env` removed from Git tracking.
- [ ] `.env.example` exists with placeholders only.
- [ ] `.gitignore` protects local secret files.
- [ ] Service account JSON files, key files, and secret folders are ignored.
- [ ] Changed-file secret scan passes.

## Manual Rotation Complete

- [ ] `ATLAS_API_KEY` rotated.
- [ ] Render updated.
- [ ] GitHub Actions secret updated.
- [ ] OpenAI key rotated if it was ever committed.
- [ ] Google service account key rotated if it was ever committed.
- [ ] Old exposed keys revoked or retired.

## Mission Control Verification Complete

- [ ] Mission Control `read-only` with sheet label `cleaned` passed.
- [ ] Mission Control `full` with sheet label `cleaned` passed.
- [ ] Dry-run proof showed `test_mode=true`.
- [ ] Dry-run proof showed `sheet_written=false`.
- [ ] Dry-run proof showed `no_write_confirmed=true`.
- [ ] No-mutation check passed.
- [ ] No real write performed during rotation.
- [ ] Dashboard remained optional.

## Remaining Optional Work

- [ ] Decide whether Git history cleanup is needed.
- [ ] If wanted, prepare a separate owner-approved history cleanup plan.
- [ ] Confirm all local clones have fresh `.env` files that are not tracked.

## Do-Not-Do List

- [ ] Do not paste secrets into AI chats, GitHub comments, docs, logs, screenshots, or commits.
- [ ] Do not ask AI agents to rotate secrets.
- [ ] Do not rewrite Git history without explicit owner approval.
- [ ] Do not change `GOOGLE_SHEETS_ID` without a cutover or rollback plan.
- [ ] Do not run real workout ingestion during secret rotation.
- [ ] Do not restore Dashboard as a required tab.
