'use strict';
// anti-hall :: repo-audit-baseline — constants for the repo-self-drift probe
// (hooks/repo-self-drift.js).
//
// MODEL_KB_AUDIT_DATE / STALENESS_THRESHOLD_DAYS
// ------------------------------------------------
// We deliberately do NOT probe a network API to check whether the model
// lineup named in docs/opus-4-8-features.md, docs/KB-fable-5.md, etc. is
// still current — model facts (what the current flagship is, its pricing,
// its benchmarks) are not discoverable from the local machine, and a probe
// that can't verify its own claim is worse than no probe: it would either
// have to fabricate an answer or silently do nothing, and a silent no-op
// dressed up as a "probe" is misleading.
//
// Instead we track the DATE the model KBs were last audited and advise when
// that date is more than STALENESS_THRESHOLD_DAYS old — a fact we CAN verify
// (arithmetic on a stored date, no network, no guessing). This is honest
// about what it knows: "the KB is N days old", not "the KB is wrong".
//
// MODEL_KB_AUDIT_DATE is the date the model KBs were last re-audited against
// the current model lineup — i.e. the date by which the OLDEST live
// model-routing claim in the repo was last verified. Bump this deliberately
// whenever the model KBs are re-audited against the current lineup.
//
// 2026-08-22 re-audit: docs/KB-model-modes.md, docs/KB-sonnet-5.md,
// docs/KB-fable-5.md, docs/KB-token-usage-models.md,
// docs/KB-codex-vs-opus-coding.md, and plugins/anti-hall/skills/MODEL-POLICY.md
// (+ its Codex mirror) were checked against the verified current lineup
// (Claude Fable 5 flagship, Claude Mythos 5 gated, Claude Opus 5 supersedes
// the now-deprecated Opus 4.8, Sonnet 5 unchanged at $2/$10, Haiku 4.5
// unchanged at 200k ctx) and corrected via stacked dated annotations. Prior
// baseline was 2026-05-29 (research date of docs/opus-4-8-features.md).
//
// 2026-09-03 re-audit (point-release only): claude-fable-5-1 (released
// 2026-09-01) supersedes claude-fable-5 as current Fable. docs/KB-fable-5.md,
// docs/KB-sonnet-5.md, docs/KB-model-modes.md, docs/KB-codex-vs-opus-coding.md,
// and docs/KB-token-usage-models.md were corrected via stacked dated
// annotations. Opus 5 / Sonnet 5 / Haiku 4.5 lineage unchanged — not
// re-verified this pass, no evidence found to disturb the 2026-08-22 findings
// on those. MODEL-POLICY.md (both variants) needed no change — already routes
// by tier token, resolved at call time.
const MODEL_KB_AUDIT_DATE = '2026-09-03';
const STALENESS_THRESHOLD_DAYS = 60;

module.exports = { MODEL_KB_AUDIT_DATE, STALENESS_THRESHOLD_DAYS };
