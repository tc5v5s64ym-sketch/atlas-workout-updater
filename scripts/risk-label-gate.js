"use strict";

// Pure decision logic for the primary-risk-label gate
// (.github/workflows/risk-label-gate.yml).
//
// Atlas governance (docs/AUTOMATION_PROTOCOL.md §2 pass/fail table,
// docs/RISK_LABELS.md) requires that every PR carry EXACTLY ONE primary risk
// label. The auto-labeler only applies CATEGORY labels (what a PR touches) and is
// deliberately non-blocking; the primary label is a builder decision, and until
// this gate nothing verified it was present. A PR with no primary risk label — or
// with two — is not merge-ready.
//
// The four canonical primary labels are the source of truth in
// .github/labels.yml / docs/RISK_LABELS.md. `blocked` is a valid primary label
// for this count (a PR may legitimately be classified `blocked`); whether a
// `blocked` PR may merge is a separate gate, not this one's concern.
//
// This module is deterministic and I/O-free so it can be unit-tested. The
// workflow supplies the PR's current label names; this module decides whether the
// gate passes.

const PRIMARY_RISK_LABELS = ["auto-safe", "owner-live-test", "owner-decision", "blocked"];

// Evaluate the primary-risk-label rule against a PR's label names.
// Returns { ok: boolean, present: string[], message: string }.
function evaluatePrimaryRiskLabels(labelNames) {
  const names = new Set(
    (labelNames || [])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const present = PRIMARY_RISK_LABELS.filter((label) => names.has(label));

  if (present.length === 1) {
    return {
      ok: true,
      present,
      message: `Exactly one primary risk label: \`${present[0]}\`.`,
    };
  }

  if (present.length === 0) {
    return {
      ok: false,
      present,
      message: `No primary risk label. Apply exactly one of: ${PRIMARY_RISK_LABELS.map((l) => `\`${l}\``).join(", ")}.`,
    };
  }

  return {
    ok: false,
    present,
    message: `Multiple primary risk labels (${present.map((l) => `\`${l}\``).join(", ")}). Exactly one is allowed.`,
  };
}

module.exports = { PRIMARY_RISK_LABELS, evaluatePrimaryRiskLabels };
