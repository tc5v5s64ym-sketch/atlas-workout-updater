-- Atlas hot-path migration — S3 repair: the PLAN-EVENT version is an OPAQUE TEXT
-- identity token, not an integer counter.
--
-- Owner ruling 2026-08-12, recorded in docs/ATLAS_V1_EXECUTION_PLAN.md.
--
-- THE DEFECT. 20260808000300_session_plans.sql declared
--   atlas.session_plan_events.plan_version integer NOT NULL CHECK (plan_version >= 1)
-- The source column it replaces, `Session_Plans.plan_version`, holds an OPAQUE
-- `pv_…` token minted by the client and validated by routes/sessionPlans.js
-- (/^pv_.+/). Production forensics found 55 eligible historical plan events
-- carrying such tokens. An integer column cannot hold them, and no integer can be
-- derived from them without inventing data.
--
-- TWO COLUMNS, ONE NAME, TWO MEANINGS. `Session_Plan_Sets.plan_version` is a
-- DIFFERENT dimension: the integer set-revision counter (1 = accepted, 2,3,… =
-- successive revisions), whose `plan_version + 1`, "highest version" and
-- max-version fold are arithmetic and REQUIRE an integer
-- (services/sessionPlanLedger.js). So this file changes the plan-EVENT column and
-- deliberately leaves atlas.session_plan_set_recommendations.plan_version alone.
--
-- WHY A NEW FILE RATHER THAN AN EDIT. 20260808000300 is APPLIED to Atlas
-- Production. Editing it to claim it always said `text` would make repository
-- replay history disagree with what production actually executed. This is a
-- forward migration, and history stays true.
--
-- NOT APPLIED TO PRODUCTION BY THIS PR. Applying any schema to Atlas Production is
-- owner gate 1 (§8.5). This file only lands in the repository and in the
-- from-empty proof database.

-- The integer-only invariant is obsolete: it constrains a value space the column
-- no longer has. Dropped STRICTLY (no IF EXISTS) — a database missing it is a
-- database this repair was not written against, and it must refuse rather than
-- proceed.
ALTER TABLE atlas.session_plan_events
  DROP CONSTRAINT session_plan_events_version_check;

-- The conversion. `plan_version::text` is deterministic and total: a replay
-- database carrying historical integer rows converts each one to its exact textual
-- representation (1 → '1'), and no row is renumbered, defaulted, or given a new
-- token. NOT NULL is a column property and survives the type change; so do the
-- fold index, the closeout index, the primary key, the session foreign key and
-- every table-level grant.
ALTER TABLE atlas.session_plan_events
  ALTER COLUMN plan_version TYPE text
  USING plan_version::text;

-- The one invariant that carries forward. The live builders and the reader BOTH
-- require a present version: services/sessionPlanEvents.js throws on a blank one,
-- and services/sessionPlanReader.js marks a blank-version row malformed. `>= 1`
-- enforced that presence for integers; this enforces exactly the same thing for
-- text, and nothing more.
--
-- DELIBERATELY NOT `^pv_`. The database preserves the authoritative token; it does
-- not narrow the application contract beyond what Atlas already owns. A `pv_`
-- prefix rule would also reject the historical integer rows this file just
-- converted, which are legitimate history.
ALTER TABLE atlas.session_plan_events
  ADD CONSTRAINT session_plan_events_version_present_check
    CHECK (btrim(plan_version) <> '');
