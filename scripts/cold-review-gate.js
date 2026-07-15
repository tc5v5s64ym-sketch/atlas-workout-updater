"use strict";

// Pure decision logic for the exact-head cold-review gate
// (.github/workflows/cold-review-gate.yml).
//
// Atlas governance (docs/AUTOMATION_PROTOCOL.md §2/§4, CLAUDE.md cold-review
// model) requires that before any NON-TRIVIAL PR merges, a fresh clean-context
// reviewer reviews the EXACT current head, with no unresolved P0/P1 finding. A
// review of an older head is stale and counts as a failure, not a pass.
//
// This module is deterministic and I/O-free so it can be unit-tested. The
// workflow supplies the PR's current head SHA and its comment list; this module
// decides the commit-status the workflow publishes on that head SHA under the
// context `cold-review/exact-head`. Freshness is enforced by comparing the
// reviewed SHA recorded in the marker to the current head SHA — so a new push
// turns the status red until the new head is reviewed.
//
// The signal is a structured comment marker, authored by a trusted collaborator:
//
//   Cold review: PASS
//   Reviewed head: 0bdcf281
//   P0/P1 findings: 0
//
// A trivial docs-only exemption (governance: such PRs may merge on deterministic
// CI alone) is recorded the same way:
//
//   Cold review: N/A (trivial docs-only)
//
// Only comments whose author_association is OWNER / MEMBER / COLLABORATOR count,
// so an arbitrary bot or outside commenter cannot fabricate a passing review.

const STATUS_CONTEXT = "cold-review/exact-head";

// GitHub commit-status descriptions are capped at 140 characters.
const MAX_DESCRIPTION = 140;

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function clip(text) {
  const value = String(text || "");
  return value.length <= MAX_DESCRIPTION ? value : `${value.slice(0, MAX_DESCRIPTION - 1)}…`;
}

function isTrusted(association) {
  return TRUSTED_ASSOCIATIONS.has(String(association || "").toUpperCase());
}

// Parse a cold-review marker out of a comment body. Returns null when the body
// is not a cold-review marker at all. Otherwise:
//   { verdict: 'pass' | 'na', reviewedSha: string|null, findings: number|null, reason: string|null }
function parseColdReviewMarker(body) {
  if (!body || typeof body !== "string") return null;

  // The verdict line is what identifies a marker: "Cold review: PASS" / "N/A".
  // Leading and trailing markdown emphasis / blockquote markers are tolerated,
  // e.g. "> **Cold review:** PASS".
  const verdictMatch = body.match(/^[ \t>*_-]*cold\s+review\s*:[ \t*_]*(pass|n\/?a)\b(.*)$/im);
  if (!verdictMatch) return null;

  const verdict = /^pass$/i.test(verdictMatch[1]) ? "pass" : "na";
  const reason = (verdictMatch[2] || "").replace(/[*_`]+$/, "").trim() || null;

  let reviewedSha = null;
  const shaMatch = body.match(/^[ \t>*_-]*reviewed\s+head\s*:[ \t*_]*`?([0-9a-f]{7,40})`?/im);
  if (shaMatch) reviewedSha = shaMatch[1].toLowerCase();

  let findings = null;
  const findingsMatch = body.match(/^[ \t>*_-]*p0\s*\/?\s*p1\s+findings\s*:[ \t*_]*(\d+)/im);
  if (findingsMatch) findings = Number.parseInt(findingsMatch[1], 10);

  return { verdict, reviewedSha, findings, reason };
}

// Choose the newest trusted cold-review marker from a PR comment list. Each
// comment is expected to look like the GitHub REST shape ({ body,
// author_association, created_at, updated_at, id }). Returns { marker, comment }
// or null when no trusted marker exists.
function selectLatestMarker(comments) {
  const candidates = [];
  for (const comment of comments || []) {
    if (!isTrusted(comment.author_association)) continue;
    const marker = parseColdReviewMarker(comment.body);
    if (!marker) continue;
    const ts = Date.parse(comment.updated_at || comment.created_at || "") || 0;
    candidates.push({ marker, comment, ts });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.ts - a.ts || (b.comment.id || 0) - (a.comment.id || 0));
  return { marker: candidates[0].marker, comment: candidates[0].comment };
}

// A recorded SHA matches the head when one is a hex prefix of the other (a
// marker may cite a short SHA). Requires at least 7 shared hex chars.
function shaMatches(reviewedSha, headSha) {
  if (!reviewedSha || !headSha) return false;
  const a = String(reviewedSha).toLowerCase();
  const b = String(headSha).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(a) || !/^[0-9a-f]{7,40}$/.test(b)) return false;
  const len = Math.min(a.length, b.length);
  if (len < 7) return false;
  return a.slice(0, len) === b.slice(0, len);
}

// Decide the commit status for `headSha` given the PR's comments.
// Returns { state: 'success'|'failure', context, description }.
function evaluateColdReview({ comments, headSha }) {
  const head = String(headSha || "").toLowerCase();
  const selected = selectLatestMarker(comments);

  if (!selected) {
    return {
      state: "failure",
      context: STATUS_CONTEXT,
      description: clip(
        `No cold review recorded for ${head.slice(0, 12) || "this head"}. A trusted reviewer must post "Cold review: PASS / Reviewed head: <sha> / P0/P1 findings: 0".`
      ),
    };
  }

  const { marker } = selected;

  if (marker.verdict === "na") {
    return {
      state: "success",
      context: STATUS_CONTEXT,
      description: clip(`Cold review N/A${marker.reason ? ` ${marker.reason}` : ""} — recorded exempt (trivial docs-only).`),
    };
  }

  if (!marker.reviewedSha) {
    return {
      state: "failure",
      context: STATUS_CONTEXT,
      description: clip('Cold review marker is missing "Reviewed head: <sha>". Cannot confirm the review matches the current head.'),
    };
  }

  if (!shaMatches(marker.reviewedSha, head)) {
    return {
      state: "failure",
      context: STATUS_CONTEXT,
      description: clip(
        `Stale cold review: reviewed ${marker.reviewedSha.slice(0, 12)}, head is now ${head.slice(0, 12)}. Re-review the new head.`
      ),
    };
  }

  if (marker.findings === null) {
    return {
      state: "failure",
      context: STATUS_CONTEXT,
      description: clip('Cold review marker is missing "P0/P1 findings: <n>".'),
    };
  }

  if (marker.findings > 0) {
    return {
      state: "failure",
      context: STATUS_CONTEXT,
      description: clip(`Cold review has ${marker.findings} unresolved P0/P1 finding(s). The builder must fix them and record a fresh review.`),
    };
  }

  return {
    state: "success",
    context: STATUS_CONTEXT,
    description: clip(`Cold review PASS for ${head.slice(0, 12)} · 0 P0/P1 findings.`),
  };
}

module.exports = {
  STATUS_CONTEXT,
  MAX_DESCRIPTION,
  TRUSTED_ASSOCIATIONS,
  isTrusted,
  parseColdReviewMarker,
  selectLatestMarker,
  shaMatches,
  evaluateColdReview,
};
