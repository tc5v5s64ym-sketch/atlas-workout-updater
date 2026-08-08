-- Atlas hot-path migration — S2, file 1 of 8: the schema and its extensions.
--
-- Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3 (conventions).
-- Selection authority: docs/ATLAS_V1_EXECUTION_PLAN.md (OWNER INSTRUCTION 2026-08-07).
--
-- Every Atlas object lives in the `atlas` schema, never in `public`. Nothing in
-- this migration set touches `public`, so a Supabase project's own objects are
-- untouched by an apply.
--
-- APPLYING THIS SET TO `Atlas Production` IS AN OWNER ACTION. CI applies it only
-- to a disposable database created from empty (§6.1 P2); scripts/apply-supabase-
-- migrations.js refuses any target that is not proven empty.

CREATE SCHEMA IF NOT EXISTS atlas;

-- btree_gist is required by atlas.sheets_mirror_allocations' exclusion constraint
-- (§3.9), which mixes an equality operator on `tab` with a range-overlap operator
-- on the reserved rows. Without it the constraint cannot be declared, so the
-- extension is created here rather than beside the table: an extension is
-- cluster state, and creating it once at the head of the set keeps every later
-- file a plain table definition.
CREATE EXTENSION IF NOT EXISTS btree_gist;
