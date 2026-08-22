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
// MODEL_KB_AUDIT_DATE is the research date of docs/opus-4-8-features.md
// ("Research date: 2026-05-29"), the oldest of the primary model-choice KBs
// (docs/opus-4-8-features.md, docs/KB-fable-5.md compiled 2026-06-10,
// docs/KB-model-modes.md compiled 2026-07-03) — i.e. the date by which the
// OLDEST live model-routing claim in the repo was last verified. Bump this
// deliberately whenever the model KBs are re-audited against the current
// lineup.
const MODEL_KB_AUDIT_DATE = '2026-05-29';
const STALENESS_THRESHOLD_DAYS = 60;

module.exports = { MODEL_KB_AUDIT_DATE, STALENESS_THRESHOLD_DAYS };
