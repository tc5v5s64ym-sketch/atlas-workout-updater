-- Atlas hot-path migration — S4, file 1 of 2: Supabase becomes the SOLE authority
-- for Exercise_Catalog.
--
-- Authority: OWNER CORRECTION 2026-08-13, recorded in
-- docs/ATLAS_V1_EXECUTION_PLAN.md. It supersedes ruling D1, which kept Google
-- Sheets as the EDITING authority and made Supabase a freshness-bounded read
-- mirror.
--
-- WHY THE CORRECTION EXISTS. Google Sheets quota exhaustion invalidated Phase 4
-- testing. Under D1 the athlete Save path still depended on Google Sheets through
-- a chain of four links:
--
--     Sheets Exercise_Catalog
--       -> background sync (npm run atlas:catalog-sync)
--       -> atlas.exercise_catalog_sync freshness clock
--       -> a mirror older than CATALOG_MIRROR_MAX_AGE
--       -> the Save fails closed with 503
--
-- A Google Sheets quota of any kind must not invalidate or block an active Atlas
-- workout or the high-volume Phase 4 test campaign. The owner ruled: one winner,
-- Supabase; remove the loser.
--
-- CLASSIFICATION: authority defect / incomplete authority cutover. The loser
-- removed is the Sheets Exercise_Catalog runtime and editing dependency. No
-- compatibility bridge survives this file: there is no sync, no freshness clock,
-- no maximum age, no stale-serving mode, and no fallback from Supabase to Sheets.
--
-- DATA IS PRESERVED, NOT REBUILT. The catalog rows already validated into
-- `Atlas Production` are kept in place by RENAME. This file deletes no catalog
-- row and re-derives no catalog content from any source.

-- ── 1. The content table stops being a mirror, so it stops being named one ────
--
-- `exercise_catalog_mirror` was an honest name while Sheets decided the content.
-- It is a false name once Supabase is the authority, and a permanently misleading
-- table name is a defect a future reader pays for. One ALTER, every row kept.
ALTER TABLE atlas.exercise_catalog_mirror RENAME TO exercise_catalog;

-- The lift-code index carries the old name too. Renaming it keeps the schema
-- readable and touches no data.
ALTER INDEX atlas.exercise_catalog_mirror_lift_idx RENAME TO exercise_catalog_lift_idx;

-- ── 2. The freshness clock is removed, because there is nothing to be fresh
--       against ───────────────────────────────────────────────────────────────
--
-- `sync_id` recorded which sync generation projected a row out of Google Sheets.
-- With Sheets removed from the catalog path there are no generations, so the
-- column records nothing and its foreign key points at a table that must go.
--
-- DROP COLUMN takes the foreign key and the `exercise_catalog_mirror_sync_idx`
-- index with it, so neither is dropped separately here.
ALTER TABLE atlas.exercise_catalog DROP COLUMN sync_id;

-- The freshness AUTHORITY itself. Every column on it — verified_at, content_hash,
-- source_row_count, last_error, status — answers one question: how stale is the
-- projection of a Google Sheets tab. That question no longer exists.
--
-- This is a DROP of migration-era control machinery, not of workout data. It
-- holds no athlete row, and the execution plan records the owner authorization
-- for it. IF EXISTS keeps a fresh replay of migration history convergent.
DROP TABLE IF EXISTS atlas.exercise_catalog_sync;

-- ── 3. The runtime may read the catalog and may not change it ─────────────────
--
-- Under D1 the runtime role performed the generation swap, so it held INSERT,
-- DELETE and a column-scoped UPDATE here. Those grants existed only to serve the
-- sync. With the sync gone they are standing authority to rewrite the catalog
-- from inside a request path, which is exactly what "explicitly owner-controlled
-- mutation" forbids.
--
-- atlas_app keeps SELECT — granted by 20260808000800_roles_and_grants.sql through
-- GRANT SELECT ON ALL TABLES — and nothing else.
REVOKE INSERT, DELETE ON atlas.exercise_catalog FROM atlas_app;

-- The UPDATE grant named atlas.exercise_catalog_sync, which the DROP above
-- removed with the table. No REVOKE is needed for it and none is written, because
-- a REVOKE against a dropped table is an error, not a control.

-- ── 4. The one owner-controlled maintenance principal ─────────────────────────
--
-- The smallest mechanism that can maintain the catalog: the EXISTING owner-held
-- migration role, which is never configured in the server runtime
-- (20260808000800_roles_and_grants.sql records and test/supabaseRoleSeparation.test.js
-- proves that). No new role, no new table, no admin framework, and no UI.
--
-- Its consumer is `npm run atlas:catalog` (scripts/atlas-catalog-admin.js), which
-- is dry-run by default and writes only under an explicit --apply flag.
GRANT INSERT, UPDATE, DELETE, SELECT ON atlas.exercise_catalog TO atlas_migrate;
