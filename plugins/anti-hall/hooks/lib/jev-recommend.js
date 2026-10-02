'use strict';
// anti-hall :: jev-recommend — the "Recommended: enable Jev" notice.
//
// ONE source of truth for the notice wording. The README blocks, the doctor
// line and the SessionStart notice all derive from these constants, and
// tests/hooks/jev-recommend.test.js checks every claim below against the shipped
// code/docs, so the text cannot drift into an unsourced claim.
//
// WHY THE WORDING IS SO CAREFUL: this plugin exists to stop unverified claims.
// Every statement here is either true by design (verifiable in code) or a dated,
// scoped measurement with its source. There is deliberately NO end-to-end
// "improves accuracy by X%" figure: none has been measured (see
// docs/KB-jev-classifier.md section 7 caveats). Do not add one without data.
//
// Delivery: SessionStart additionalContext carrying a "Tell the user now"
// directive (the same user-visible channel version-alert.js uses; the model
// relays it, so the markdown bold renders in the terminal). No network, no
// new hook registration: it rides jev-review-reminder.js.
//
// Gating: shown only while Jev is NOT enabled and jev.recommendNotice !== false.
// Dedupe: once on first run, then at most every REMIND_EVERY_MS. State:
// ~/.anti-hall/state/jev-recommend-notice.json. Fail-open: any error -> no notice.

const fs = require('fs');
const path = require('path');

const REMIND_EVERY_MS = 30 * 24 * 60 * 60 * 1000;

// MEASURED FIGURE (the only one). Source: docs/KB-jev-classifier.md section 7
// ("findingDedup offline benchmark [measured, 2026-09]") and CHANGELOG 0.108.4:
// finding pairs drawn from 30 days of real deadly-loop reviews across 3
// projects; Jev answered 65/65 correct at confidence >= 0.85; a same-file
// +-10-lines heuristic was 45% precise on the same pairs. One narrow task, raw
// pairs not shipped. The test asserts these numbers still appear in that KB.
const FINDING_DEDUP_EVIDENCE = Object.freeze({
  correct: 65,
  total: 65,
  minConfidence: 0.85,
  heuristicPrecisionPct: 45,
  date: '2026-09',
  projects: 3,
});

// Jev integrations whose shipped default mode is "on" once Jev is enabled
// (hooks/lib/settings-schema.js, section jevIntegrations). The test derives this
// list from the schema and fails on any difference.
const ON_BY_DEFAULT_IDS = Object.freeze([
  'speculation', 'triage', 'findingDedup', 'dispatchTier',
  'devswarmOnBrief', 'devswarmExtraSanctioned', 'devswarmWaitKind', 'devswarmLoop', 'devswarmStepMap',
]);

const E = FINDING_DEDUP_EVIDENCE;

const HEADLINE = '**Recommended: enable Jev, the optional classifier, for more accurate guards.**';

const WHAT = 'Without it, guards such as the speculation check rely on pattern matching alone. ' +
  'With Jev on, they also get a model\'s second opinion: by default it can only add blocks the patterns miss ' +
  '(it never removes one), and nine integrations are on by default once it is enabled ' +
  '(speculation, message triage, duplicate-finding grouping, dispatch-tier hints, five DevSwarm supervision labels).';

const MEASURED = `Measured so far: one offline check (${E.date}, ${E.total} deadly-loop finding pairs from ` +
  `${E.projects} projects) had Jev's duplicate-finding judgments ${E.correct}/${E.total} correct at confidence >= ` +
  `${E.minConfidence}, against ${E.heuristicPrecisionPct}% precision for a same-file proximity heuristic. ` +
  'That is one narrow task; no end-to-end accuracy figure exists for the other guards yet (docs/KB-jev-classifier.md, section 7).';

const COSTS = '**Costs:** optional and off by default; needs your own Vercel AI Gateway or TypeSafe API key; ' +
  'sends the text a guard judges (prompts, assistant messages, test output, commit text; up to 8000 characters per call, ' +
  'known secret shapes redacted on a best-effort basis) to the provider you choose; uses provider credits. Details: PRIVACY.md.';

const ENABLE = 'Enable: say "activate jev" (runs the `jev` skill: stores your key, enables, tests). ' +
  'Silence this reminder: set `jev.recommendNotice` to false.';

// noticeText() -> the FULL notice (markdown), used in the README blocks' wording.
function noticeText() {
  return [HEADLINE, WHAT, MEASURED, COSTS, ENABLE].join('\n\n');
}

// shortNotice() -> the SessionStart version (at most 4 lines, no measured
// figure; the README "Enable Jev" section and doctor carry the full text).
const SHORT = [
  HEADLINE,
  'Without it the guards rely on pattern matching alone; with it they also get a model\'s second opinion ' +
    '(by default it can only add blocks the patterns miss, never remove one).',
  'Optional and off by default: needs your own API key, sends the text a guard judges to the provider you choose, ' +
    'uses credits. Details: README "Enable Jev" and PRIVACY.md.',
  'Enable: say "activate jev". Turn this reminder off: set `jev.recommendNotice` to false.',
];
function shortNotice() {
  return SHORT.join('\n');
}

// doctorLines() -> the full text as plain lines for `doctor` (no markdown).
function doctorLines() {
  return [HEADLINE, WHAT, MEASURED, COSTS, ENABLE].map((t) => t.replace(/\*\*/g, ''));
}

function settingsGet(key, dflt, o) {
  try { return require('./settings.js').get('jev', key, dflt, { home: o.home, env: o.env }); } catch (_) { return dflt; }
}

// applicable(o) -> true when the recommendation applies at all: Jev not enabled
// and the notice not switched off. No dedupe, no I/O beyond settings reads.
function applicable(o) {
  try {
    if (settingsGet('enabled', false, o) === true) return false;
    return settingsGet('recommendNotice', true, o) !== false;
  } catch (_) {
    return false;
  }
}

function statePath(home) {
  return path.join(home, '.anti-hall', 'state', 'jev-recommend-notice.json');
}

// sessionNotice({home, env, now}) -> directive string or null. Writes the
// dedupe stamp BEFORE returning, and returns null when the stamp cannot be
// written (an unwritable state dir must never turn into a notice every session).
function sessionNotice(o) {
  try {
    const opts = o || {};
    if (!opts.home || !applicable(opts)) return null;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const file = statePath(opts.home);
    let last = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Number.isFinite(parsed.lastShownTs)) last = parsed.lastShownTs;
    } catch (_) { last = 0; }
    if (last > 0 && last <= now && now - last < REMIND_EVERY_MS) return null;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastShownTs: now }) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return 'Tell the user now, verbatim, bold kept:\n' + shortNotice();
  } catch (_) {
    return null;
  }
}

module.exports = {
  REMIND_EVERY_MS, FINDING_DEDUP_EVIDENCE, ON_BY_DEFAULT_IDS, HEADLINE,
  noticeText, shortNotice, doctorLines, SHORT, applicable, sessionNotice, statePath,
};
