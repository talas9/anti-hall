#!/usr/bin/env node
'use strict';
// anti-hall :: jev report — read-only summary of ~/.anti-hall/logs/jev-assist.ndjson.
//
// USAGE
//   node plugins/anti-hall/scripts/jev-report.js [--days 7] [--json] [--window 24h|7d]
//     [--by project|session] [--project <name>] [--weekly]
//     [--since <iso>] [--until <iso>] [--exclude-window <iso>..<iso>]
//   node plugins/anti-hall/scripts/jev-report.js label <hash> [tp|fp]
//   node plugins/anti-hall/scripts/jev-report.js prune-audit --days N
//
// --since/--until filter rows to those with `ts` inside [since, until]
// (either end optional); --exclude-window <iso>..<iso> additionally drops any
// row with `ts` inside that one closed interval (repeat the flag for more than
// one window). All three apply BEFORE --project/--by/--weekly and before any
// other filtering, to every row read from jev-assist.ndjson and
// jev-triage.ndjson alike. Use this to exclude a known-accidental run from a
// report, e.g. the 2026-09-24T19:56Z..22:23Z supervisorBlockerLabel run:
//   --exclude-window 2026-09-24T19:56:00Z..2026-09-24T22:23:00Z
//
// --project <name> filters rows to that project (a cwd basename, e.g.
// "anti-hall" -- see hooks/lib/jev-assist.js's defaultProject(); a row with no
// project matches "unknown") BEFORE the rest of the report runs. --by
// project|session instead prints (or --json returns) one full report PER
// distinct value of that field, grouped by groupRowsBy() below -- 'unknown'
// covers any row missing the field, including every row logged before this
// feature existed.
//
// --weekly prints a compact, ALWAYS-7-day per-integration summary (mode,
// suggestion, a short reason, call count) instead of the full table -- see
// buildWeeklyScorecard() below. This is the SAME data hooks/jev-weekly-
// scorecard.js's SessionStart notice reads (at most once every 7 days,
// main-thread-only, never changes a mode) to point the user at this report
// when an integration has earned a KEEP/REMOVE verdict jev.json hasn't caught
// up to yet.
//
// For each integration id seen in the log, reports: calls, jev-answered %
// (backend 'jev' or 'cache' vs 'baseline-only'), cache hits, agreement %
// (Jev's answer vs the caller-supplied `compare` field -- an INDEPENDENT
// heuristic verdict, e.g. speculation-guard's regex check -- only counted
// where both exist; rows with no `compare` field are excluded from this
// metric and counted separately as `excludedNoCompare`, since `base` is
// trust-rule math, not a real verdict, for some callers (e.g.
// speculation-guard's baseline is a hardcoded `false`) and comparing jev
// against it would silently measure something else, e.g. "rate Jev said
// not-speculative"), decisions changed (split by direction:
// 'added'/'relaxed'/'changed'), outcome rates (from recordOutcome lines,
// joined back to a decision by hash — an outcome is counted as "good" unless
// its name matches BAD_OUTCOME_RE below), latency p50/p95, an ESTIMATED cost
// (calls * jev.json `costPerCall`, or "n/a" if unset — this is a rough
// estimate, not a bill), and a KEEP / REVIEW / REMOVE suggestion.
//
// THRESHOLDS (documented here, not buried in code — tune by editing these):
//   MIN_CALLS_FOR_VERDICT = 50     below this, always "REVIEW (not enough data)"
//   MIN_LABELED_FOR_VERDICT = 20   below this many labelled outcomes (tp+fp,
//     human+auto combined), KEEP and REMOVE are BOTH withheld -- the verdict is
//     "REVIEW (needs labels: n/20)" instead. A high changed-decision rate or a
//     low one proves nothing about whether Jev is RIGHT without labelled
//     outcomes behind it (this is what let a 3-changed/304-fresh integration
//     hit REMOVE with zero labelled outcomes -- see the fix note below). This
//     guard, and the label-only guard right after it, run BEFORE either
//     KEEP or REMOVE is evaluated.
//   Label-only integrations (a `choice` classifier with a string `jev`
//     answer, e.g. newRequest — see "LABEL-ONLY INTEGRATIONS" below) NEVER use
//     changedRate at all: they have no boolean baseline to have "changed", so
//     their `changedHashByFresh` stays empty and they report
//     "REVIEW (label-only, no outcome signal yet)" until a human labels some
//     outcomes.
//   REMOVE if, over >= 200 calls AND at least MIN_LABELED_FOR_VERDICT labelled
//     outcomes:
//     - good-outcome rate < 60% among changed decisions with a known outcome, OR
//     - failure rate (backend baseline-only due to a real jevDecide error,
//       i.e. NOT counting 'disabled'/'off'/'not-applicable') > 20%
//     A changed-decision rate < 1% is LOW YIELD, not evidence of a wrong
//     verdict on its own -- it is reported as a note on whatever REVIEW/KEEP/
//     REMOVE verdict the other numbers already produced, and can never trigger
//     REMOVE by itself.
//   KEEP if changed-decision rate >= 5% AND good-outcome rate >= 80% AND at
//     least MIN_LABELED_FOR_VERDICT labelled outcomes exist (a NULL
//     good-outcome rate — no outcome signal at all yet — can NEVER earn KEEP,
//     regardless of changed-decision rate; it earns REVIEW instead).
//   REVIEW otherwise (includes: p95 latency > the integration's own configured
//     budget, or anything not meeting KEEP/REMOVE above).
//
// SHADOW-MODE YIELD (fix, v0.108.1): a shadow-mode row's `changed` field is
// ALWAYS null by construction (jev-assist.js's finalize() only applies/reports
// a change when mode==='on' — shadow never changes the real outcome), so
// reading `row.changed` for a shadow integration always saw changedRate=0 and
// could hit REMOVE at >=200 calls no matter how good Jev's shadow answers
// were. Shadow (and off) rows now also carry `row.wouldChange` -- the SAME
// trust-rule direction computed WITHOUT the mode gate (see jev-assist.js's
// finalize()) -- and this script uses `row.wouldChange` for shadow rows,
// `row.changed` for 'on' rows (identical by construction), and neither for
// label-only rows (string `jev` answers never have a real "changed" concept;
// see MIN_LABELED_FOR_VERDICT above).
//
// DEDUPE BY DECISION (content hash `h`): a Stop-hook retry (or any caller
// re-asking the same content) produces MULTIPLE log rows sharing one hash --
// one fresh call, then N cache hits. `changed`/`changedUnique`/`changedRate`,
// the outcome join, and `costEstimate` all count/charge each UNIQUE hash
// ONCE, from its fresh row only -- a cache hit is never a new decision and
// never costs anything, so it is excluded from all three, not just
// de-duplicated. `calls` stays the raw row count (fresh+cached, shown as
// "calls (fresh/cached)"); `changedRate` and `costEstimate` are computed
// against `freshCalls` (`calls - cachedCalls`), never `calls`.
//
// LABEL-ONLY INTEGRATIONS (e.g. newRequest, a `choice` classifier with no
// boolean baseline to agree/disagree against): `agreementPct` is n/a (no
// baseline), so the table instead reports a `label%` column — the top Jev
// answer's share of calls — with the full distribution available via --json.
// These integrations report a suggestion of their own too, but per the KEEP
// rule above can never reach KEEP until a human-supplied outcome exists.
//
// TRIAGE ANSWER-TIME (hooks/lib/jev-triage.js recordAnswered): a SEPARATE
// section (not part of the per-integration table, since it's latency data
// keyed by urgency label, not a jev-assist.ndjson decision row) reads
// jev-triage.ndjson's {type:'answered', urgency, latencyMs} rows and reports
// p50/p95 time-to-answer for urgent vs non-urgent labeled messages.
//
// PRECISION LABELS (tp/fp) -- `jev report label <id> tp|fp` is the ONE
// command this script offers that writes: it appends {ts, h, label, source:
// 'human'} to a SEPARATE, append-only ~/.anti-hall/logs/jev-labels.ndjson,
// keyed by the decision's own content hash `h` (already a stable per-decision
// id -- no new id scheme needed). AUTO labels are derived, at report time,
// from the SAME already-logged `type:'outcome'` rows recordOutcome() writes
// (see hooks/lib/jev-assist.js) using the existing BAD_OUTCOME_RE
// classification: a good outcome (e.g. 'evidence-added', the mechanical
// signal that the next main-thread turn cited a tool/file, per
// speculation-guard.js's hasAcknowledgment check) auto-labels 'tp'; a bad one
// (e.g. 'repeat-speculation', 'user-override') auto-labels 'fp'. This reuses
// the mechanical signal the codebase ALREADY computes rather than re-parsing
// transcripts here -- computing tp/fp FROM that logged text still happens
// entirely offline, at report time, never in the hook path. A human label
// always wins over an auto one for the same hash; auto labels are reported
// SEPARATELY and are NEVER presented as ground truth. A changed decision
// with neither stays unlabeled (excluded from tp/fp counts, not counted as
// either).
//
// EFFICIENCY (per integration, per window via --window/buildCostWindows):
//   yield        : changedPer100 = changedUnique/freshCalls*100,
//                  tpPer100Human / tpPer100Auto = human/auto TP /freshCalls*100
//   cost         : costPerTp = realCostTotal/(humanTP+autoTP), costPerChanged
//                  (existing realCostPerChangedDecision) -- both null when
//                  cost or the denominator is unknown/zero, never fabricated.
//   overhead     : p50/p95 (existing), pctCallsOver1s, timeouts (reason
//                  'timeout' count), fallbackCount (backend 'baseline-only'
//                  while mode is 'on', i.e. Jev was consulted but a real
//                  failure fell back to baseline).
//   headline     : one line combining the above with the existing
//                  KEEP/REVIEW/REMOVE suggestion, e.g. "speculation: 6
//                  changed/window · 5 TP (3 human, 2 auto) · $0.0x/TP ·
//                  p50=120ms · KEEP".
//
// This script only READS jev-assist.ndjson/jev.json; `label` is the sole
// exception, and it only ever appends to the separate jev-labels.ndjson.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_CALLS_FOR_VERDICT = 50;
const MIN_LABELED_FOR_VERDICT = 20; // tp+fp (human+auto), required before KEEP or REMOVE
const REMOVE_MIN_CALLS = 200;
const REMOVE_GOOD_OUTCOME_RATE = 0.60;
const REMOVE_FAILURE_RATE = 0.20;
const KEEP_CHANGED_RATE = 0.05;
const KEEP_GOOD_OUTCOME_RATE = 0.80;
const LOW_YIELD_CHANGED_RATE = 0.01; // note-only -- never a REMOVE trigger by itself

// Outcome names treated as evidence Jev's changed decision was WRONG. Every
// other named outcome (e.g. 'evidence-added', 'answered') counts as "good".
const BAD_OUTCOME_RE = /^(user-override|false-positive|wrong|bad|reverted|repeat-speculation)/i;

// A jevDecide-level failure (real error), as opposed to the integration
// simply being off/shadow/not-applicable for this call.
const FAILURE_REASONS = new Set([
  'timeout', 'network-error', 'no-key', 'parse-error', 'bad-response', 'error',
]);
function isHttpFailure(reason) {
  return typeof reason === 'string' && (/^http-/.test(reason) || FAILURE_REASONS.has(reason));
}

function logPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'logs', 'jev-assist.ndjson');
}

function triageLogPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'logs', 'jev-triage.ndjson');
}

// labelsLogPath(home) -> ~/.anti-hall/logs/jev-labels.ndjson -- a SEPARATE,
// append-only file for human tp/fp labels (`jev report label <h> tp|fp`),
// kept apart from jev-assist.ndjson so decision rows stay untouched.
function labelsLogPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'logs', 'jev-labels.ndjson');
}

function readLabels(home) {
  const rows = [];
  try {
    const raw = fs.readFileSync(labelsLogPath(home), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch (_) { /* skip a corrupt line */ }
    }
  } catch (_) {
    // file doesn't exist yet -- fine, nothing labeled
  }
  return rows;
}

// latestHumanLabelByHash(labelRows) -> Map<hash, 'tp'|'fp'> — the LAST human
// label wins if a hash was labeled more than once (a correction).
function latestHumanLabelByHash(labelRows) {
  const map = new Map();
  for (const row of labelRows) {
    if (!row || row.source !== 'human' || !row.h || (row.label !== 'tp' && row.label !== 'fp')) continue;
    map.set(row.h, row.label);
  }
  return map;
}

// auditLogPath/readAuditSnippet mirror hooks/lib/jev-assist.js's own
// auditLogPath so jev-report never has to import a hooks/ module -- same
// path convention, read-only here.
function auditLogPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'logs', 'jev-audit.ndjson');
}

// readAuditSnippet(home, hash) -> the LATEST stored snippet for `hash`, or
// null if audit snippets were never on for that decision (the common case --
// off by default). Reads both the live file and its .1 backup.
function readAuditSnippet(home, hash) {
  let latest = null;
  for (const suffix of ['.1', '']) {
    try {
      const raw = fs.readFileSync(auditLogPath(home) + suffix, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          if (row && row.h === hash) latest = row;
        } catch (_) { /* skip a corrupt line */ }
      }
    } catch (_) {
      // file doesn't exist -- fine
    }
  }
  return latest ? latest.snippet : null;
}

// cmdLabel(hash, label, home) -> `jev-report label <hash>` (label omitted)
// prints the current human label (if any) and the stored audit snippet (if
// any) for that hash, read-only. `jev-report label <hash> tp|fp` appends a
// human label -- never touches jev-assist.ndjson -- then prints the same
// snippet as a courtesy so the caller can eyeball what they just labeled.
// Does not require the hash to already exist in the decision log (labeling
// ahead of a report run is harmless).
function cmdLabel(hash, label, home) {
  if (!hash) {
    console.error('label: usage is `jev-report label <hash> [tp|fp]`');
    process.exitCode = 1;
    return;
  }
  if (label !== undefined && label !== 'tp' && label !== 'fp') {
    console.error('label: usage is `jev-report label <hash> tp|fp`');
    process.exitCode = 1;
    return;
  }

  if (label === undefined) {
    const existing = latestHumanLabelByHash(readLabels(home)).get(hash);
    console.log(`${hash}: ${existing ? `labeled ${existing} (human)` : 'unlabeled'}`);
  } else {
    const p = labelsLogPath(home);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), h: hash, label, source: 'human' }) + '\n', 'utf8');
      console.log(`labeled ${hash} as ${label}`);
    } catch (err) {
      console.error(`label: failed to write ${p}: ${err && err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const snippet = readAuditSnippet(home, hash);
  console.log(snippet ? `snippet: ${snippet}` : 'snippet: none (audit.snippets is off, or this decision predates it)');
}

// cmdPruneAudit(days, home) -> MANUAL-ONLY deletion of jev-audit.ndjson
// entries older than `days`. Never invoked automatically by anything in this
// codebase -- the only way audit data is ever removed is this explicit
// command.
function cmdPruneAudit(days, home) {
  if (!Number.isFinite(days) || days <= 0) {
    console.error('prune-audit: usage is `jev-report prune-audit --days N` (N > 0)');
    process.exitCode = 1;
    return;
  }
  const cutoff = Date.now() - days * 86400000;
  const p = auditLogPath(home);
  let kept = 0; let removed = 0;
  const lines = [];
  for (const suffix of ['.1', '']) {
    try {
      const raw = fs.readFileSync(p + suffix, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          const ts = row && row.ts ? Date.parse(row.ts) : NaN;
          if (Number.isFinite(ts) && ts < cutoff) { removed++; continue; }
          lines.push(t);
          kept++;
        } catch (_) { removed++; }
      }
    } catch (_) {
      // file doesn't exist -- fine
    }
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (lines.length > 0) {
      fs.writeFileSync(p, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(p, 0o600);
    } else {
      fs.rmSync(p, { force: true });
    }
    fs.rmSync(p + '.1', { force: true });
  } catch (err) {
    console.error(`prune-audit: failed: ${err && err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`prune-audit: kept ${kept}, removed ${removed} (older than ${days}d)`);
}

function jevConfigPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'jev.json');
}

function readJevJson(home) {
  try {
    const raw = fs.readFileSync(jevConfigPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function readCostPerCall(home) {
  try {
    const raw = fs.readFileSync(jevConfigPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && Number.isFinite(parsed.costPerCall)) ? parsed.costPerCall : null;
  } catch (_) {
    return null;
  }
}

// readBudgetConfig(home) -> {mode, usdPerDay, usdPerWeek, minCreditUsd} from
// the unified settings store (jev.budget.*; legacy jev.json {"budget": {...}}
// still read as a fallback). mode defaults "unlimited" (report shows no
// budget section at all). `minCreditUsd` is optional and only meaningful in
// "watch" mode -- see maybeWarnLowCredit.
function readBudgetConfig(home) {
  try {
    const settings = require('../hooks/lib/settings.js');
    const opts = { home: home || os.homedir() };
    const pos = (v) => ((Number.isFinite(v) && v > 0) ? v : null);
    return {
      mode: settings.get('jev', 'budget.mode', 'unlimited', opts) === 'watch' ? 'watch' : 'unlimited',
      usdPerDay: pos(settings.get('jev', 'budget.usdPerDay', null, opts)),
      usdPerWeek: pos(settings.get('jev', 'budget.usdPerWeek', null, opts)),
      minCreditUsd: pos(settings.get('jev', 'budget.minCreditUsd', null, opts)),
    };
  } catch (_) {
    return { mode: 'unlimited', usdPerDay: null, usdPerWeek: null, minCreditUsd: null };
  }
}

// computeBudgetStatus(rows, budget) -> null (mode !== 'watch') or
// {'24h': {spentUsd, budgetUsd, exceeded}|null, '7d': {...}|null} — spend is
// summed across ALL integrations (budget is a single global daily/weekly
// cap, not per-integration), from the SAME real costUsd field jev-assist.js
// writes. A window with no configured budget for it (e.g. usdPerWeek unset)
// reports null for that window, not a fabricated 0/0.
function computeBudgetStatus(rows, budget) {
  if (!budget || budget.mode !== 'watch') return null;
  const sumWindow = (days) => {
    const cutoff = Date.now() - days * 86400000;
    let sum = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || row.type === 'outcome') continue;
      const ts = row.ts ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (Number.isFinite(row.costUsd)) sum += row.costUsd;
    }
    return sum;
  };
  const status = {};
  if (Number.isFinite(budget.usdPerDay)) {
    const spentUsd = sumWindow(1);
    status['24h'] = { spentUsd, budgetUsd: budget.usdPerDay, exceeded: spentUsd > budget.usdPerDay };
  } else {
    status['24h'] = null;
  }
  if (Number.isFinite(budget.usdPerWeek)) {
    const spentUsd = sumWindow(7);
    status['7d'] = { spentUsd, budgetUsd: budget.usdPerWeek, exceeded: spentUsd > budget.usdPerWeek };
  } else {
    status['7d'] = null;
  }
  return status;
}

// --- Low-credit warning (opt-in, needs budget.mode "watch" + minCreditUsd) -
//
// Reuses the SAME jev-budget.json state file hooks/lib/jev-assist.js's
// maybeWarnBudget() writes (a different field, `creditWarnedDate`, so the
// two "once per day" cadences never collide). The credit BALANCE itself is
// never fetched here -- jev-client.js's getCreditBalanceCached() (report/
// status-time only, 15-min cache, see its own doc comment) is the caller's
// job; this function only decides whether today's warning has already fired
// and, if not, marks it fired. Never disables Jev.
function budgetStatePath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'state', 'jev-budget.json');
}
function readBudgetState(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(budgetStatePath(home), 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}
function writeBudgetState(home, state) {
  try {
    const p = budgetStatePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch (_) {
    // best-effort only
  }
}

// maybeWarnLowCredit({home, budget, creditResult}) -> null (not applicable:
// mode isn't "watch", minCreditUsd unset, or the balance is unknown) or
// {belowThreshold, warnedNow, balanceUsd, minCreditUsd}. `warnedNow` is true
// only the FIRST time this is called below-threshold on a given calendar
// day; subsequent calls the same day report belowThreshold:true,
// warnedNow:false so a caller can distinguish "still low, already told you"
// from "just crossed the line".
function maybeWarnLowCredit({ home, budget, creditResult }) {
  if (!budget || budget.mode !== 'watch' || !Number.isFinite(budget.minCreditUsd)) return null;
  if (!creditResult || !creditResult.ok || !Number.isFinite(creditResult.balanceUsd)) return null;

  const belowThreshold = creditResult.balanceUsd < budget.minCreditUsd;
  const result = { belowThreshold, warnedNow: false, balanceUsd: creditResult.balanceUsd, minCreditUsd: budget.minCreditUsd };
  if (!belowThreshold) return result;

  const today = new Date().toISOString().slice(0, 10);
  const state = readBudgetState(home);
  if (state.creditWarnedDate !== today) {
    state.creditWarnedDate = today;
    writeBudgetState(home, state);
    result.warnedNow = true;
  }
  return result;
}

// readLines(home) -> array of parsed rows (decision rows + outcome rows),
// reading BOTH the live file and its one rotated backup (.1) so a report run
// right after a rotation doesn't silently lose the older half.
function readLines(home) {
  const rows = [];
  for (const suffix of ['.1', '']) {
    try {
      const raw = fs.readFileSync(logPath(home) + suffix, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch (_) { /* skip a corrupt line */ }
      }
    } catch (_) {
      // file doesn't exist — fine, nothing to add
    }
  }
  return rows;
}

// readTriageLines(home) -> array of parsed jev-triage.ndjson rows (both the
// per-message classification lines and the recordAnswered() 'answered'
// lines), same live+.1-backup read as readLines() above.
function readTriageLines(home) {
  const rows = [];
  for (const suffix of ['.1', '']) {
    try {
      const raw = fs.readFileSync(triageLogPath(home) + suffix, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch (_) { /* skip a corrupt line */ }
      }
    } catch (_) {
      // file doesn't exist — fine, nothing to add
    }
  }
  return rows;
}

// buildTriageAnswerReport(triageRows) -> {urgent:{n,p50,p95}, normal:{n,p50,p95}}
// from {type:'answered', urgency, latencyMs} rows. `normal` buckets every
// non-'urgent' labeled answer (kind-only or urgency:'normal').
function buildTriageAnswerReport(triageRows) {
  const buckets = { urgent: [], normal: [] };
  for (const row of triageRows) {
    if (!row || row.type !== 'answered' || !Number.isFinite(row.latencyMs)) continue;
    const bucket = row.urgency === 'urgent' ? 'urgent' : 'normal';
    buckets[bucket].push(row.latencyMs);
  }
  const summarize = (arr) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return { n: sorted.length, p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95) };
  };
  return { urgent: summarize(buckets.urgent), normal: summarize(buckets.normal) };
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

const COST_WINDOWS = { '24h': 1, '7d': 7 };

// parseIsoMs(s) -> epoch ms, or null when `s` doesn't parse as a date (never
// throws, matches every other best-effort Date.parse use in this file).
function parseIsoMs(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function parseArgs(argv) {
  const opts = { days: null, json: false, window: null, since: null, until: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') opts.days = Number(argv[++i]);
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--home') opts.home = argv[++i]; // test-only override
    else if (argv[i] === '--window') opts.window = argv[++i];
    else if (argv[i] === '--by') opts.by = argv[++i]; // 'project' | 'session'
    else if (argv[i] === '--project') opts.project = argv[++i];
    else if (argv[i] === '--weekly') opts.weekly = true;
    else if (argv[i] === '--since') opts.since = parseIsoMs(argv[++i]);
    else if (argv[i] === '--until') opts.until = parseIsoMs(argv[++i]);
    else if (argv[i] === '--exclude-window') {
      // <iso>..<iso> -- repeatable; a malformed value is silently dropped
      // (never throws), matching this script's fail-open convention.
      const raw = argv[++i];
      const parts = typeof raw === 'string' ? raw.split('..') : [];
      if (parts.length === 2) {
        const s = parseIsoMs(parts[0]);
        const e = parseIsoMs(parts[1]);
        if (s !== null && e !== null) {
          if (!opts.excludeWindows) opts.excludeWindows = [];
          opts.excludeWindows.push([Math.min(s, e), Math.max(s, e)]);
        }
      }
    }
  }
  return opts;
}

// filterByTimeWindow(rows, opts) -> rows within [opts.since, opts.until] and
// outside every opts.excludeWindows interval, applied by `ts`. A row with no
// parseable `ts` is left in place (unaffected, not silently dropped) — this
// filter can only exclude what it can actually date.
function filterByTimeWindow(rows, opts) {
  if (opts.since === null && opts.until === null && (!opts.excludeWindows || opts.excludeWindows.length === 0)) {
    return rows;
  }
  return rows.filter((row) => {
    const ts = row && row.ts ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(ts)) return true;
    if (opts.since !== null && ts < opts.since) return false;
    if (opts.until !== null && ts > opts.until) return false;
    if (opts.excludeWindows) {
      for (const [s, e] of opts.excludeWindows) {
        if (ts >= s && ts <= e) return false;
      }
    }
    return true;
  });
}

// describeWindow(opts, rawCount, filteredCount) -> {since, until,
// excludeWindows, rowsTotal, rowsInWindow, rowsExcluded}. Reproducibility
// (jev-report item 3): two analyses run against the SAME --since/--until
// only produce comparable agreement/changed-rate numbers if both runs can
// SEE they used the same window and the same row counts -- printing this
// alongside the report is the only way to confirm that after the fact
// (e.g. when comparing a "before" and "after" run pasted into two different
// places). since/until report null when not passed (the full log was read);
// excludeWindows always reports as ISO pairs, [] when none were given.
function describeWindow(opts, rawCount, filteredCount) {
  return {
    since: opts.since !== null ? new Date(opts.since).toISOString() : null,
    until: opts.until !== null ? new Date(opts.until).toISOString() : null,
    excludeWindows: (opts.excludeWindows || []).map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]),
    rowsTotal: rawCount,
    rowsInWindow: filteredCount,
    rowsExcluded: rawCount - filteredCount,
  };
}

// printWindow(windowInfo) -> one line, text-mode only (JSON output carries
// the same object verbatim under `window`). Always printed (even with no
// --since/--until given) so a reader never has to guess whether the report
// covers the whole log.
function printWindow(windowInfo) {
  const since = windowInfo.since || '(log start)';
  const until = windowInfo.until || '(log end)';
  const excl = windowInfo.excludeWindows.length
    ? windowInfo.excludeWindows.map(([s, e]) => `${s}..${e}`).join(', ')
    : '(none)';
  console.log(
    `window: ${since} .. ${until}  exclude: ${excl}  ` +
    `rows: ${windowInfo.rowsInWindow} in window / ${windowInfo.rowsTotal} total ` +
    `(${windowInfo.rowsExcluded} excluded)`
  );
}

// groupKeyOf(row, by) -> the row's project/session key, or 'unknown' when
// absent — EVERY row missing the field (not just ones logged before this
// feature existed) falls into 'unknown', so a caller that never threads a
// project/session through (some integrations legitimately have no session,
// e.g. devswarm-supervisor.js's background sweep) degrades the same way an
// old pre-feature row would, rather than needing a special "legacy" bucket.
function groupKeyOf(row, by) {
  if (by === 'session') return (row && row.sessionId) || 'unknown';
  return (row && row.project) || 'unknown'; // by === 'project' (default when --by is set at all)
}

// groupRowsBy(rows, by) -> Map<groupKey, rows[]>. Outcome rows (type:
// 'outcome') DO join to a decision row by hash, but computing "every group
// whose id had rows in this window" per outcome is not tractable cheaply, so
// (documented, simple, and safe) they are instead grouped by their OWN
// project/session fields exactly like a decision row -- 'unknown' when
// absent, same as everything else. recordOutcome() populates `project` with
// the same cwd-basename fallback finalize() uses for decision rows, but
// never had a sessionId to thread through, so outcome rows still fall into
// 'unknown' for --by session. A row logged before either field existed
// simply reports under 'unknown', same as any other pre-feature row.
function groupRowsBy(rows, by) {
  const groups = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = groupKeyOf(row, by);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

// buildCostWindows(rows, { costPerCall, windows }) -> { '24h': {generatedAt,
// integrations}, '7d': {...} } -- reuses buildReport's own per-window cutoff
// (`days`) so real-cost figures come from the exact same aggregation as the
// main table, just re-run per window. `windows` defaults to both 24h and 7d;
// pass a single-key object (e.g. {'--window 24h'}) to report just one.
function buildCostWindows(rows, opts = {}) {
  const windows = opts.windows || COST_WINDOWS;
  const out = {};
  for (const label of Object.keys(windows)) {
    out[label] = buildReport(rows, {
      days: windows[label], costPerCall: opts.costPerCall,
      humanLabelByHash: opts.humanLabelByHash, windowLabel: label,
    });
  }
  return out;
}

// buildReport(rows, { days, costPerCall, budgetMsById }) -> { generatedAt, integrations: [...] }
// buildHeadline(r, windowLabel) -> one-line summary (item 5), e.g.
// "speculation: 6 changed/24h · 5 TP (3 human, 2 auto) · $0.0x/TP ·
// p50=120ms · KEEP". Extends the existing KEEP/REVIEW/REMOVE suggestion --
// see the module doc comment / the THRESHOLDS block above for the rule.
function buildHeadline(r, windowLabel) {
  const tpTotal = r.humanTP + r.autoTP;
  const tpPart = `${tpTotal} TP (${r.humanTP} human, ${r.autoTP} auto)`;
  const costPart = r.costPerTp == null ? 'cost n/a' : `$${r.costPerTp.toFixed(4)}/TP`;
  const p50Part = r.p50 == null ? 'p50 n/a' : `p50=${r.p50}ms`;
  // Label-only integrations never populate changedUnique (no boolean
  // baseline to diff against — see labelOnlyNote above), so "0 changed/24h"
  // would read as "Jev did nothing" here instead of "nothing boolean to
  // measure"; swap in the distinct-decision count instead.
  const changedPart = r.isLabelOnly
    ? `${r.labelDistinctDecisions} distinct decisions/${windowLabel} (label-only)`
    : `${r.changedUnique} changed/${windowLabel}`;
  return `${r.id}: ${changedPart} · ${tpPart} · ${costPart} · ${p50Part} · ${r.suggestion}`;
}

function buildReport(rows, opts = {}) {
  const now = Date.now();
  const cutoff = Number.isFinite(opts.days) ? now - opts.days * 86400000 : null;

  const byId = new Map();
  const outcomesByHash = new Map(); // hash -> [outcome, ...]
  const outcomesBySource = new Map(); // id -> { <source>: {good, known} }

  // triage decisions (jev-triage.ndjson, a SEPARATE file/schema — see
  // hooks/lib/jev-triage.js) never go through jev-assist.js's ask()/
  // askSync(), so they never land in jev-assist.ndjson: `triage` was
  // entirely invisible in this per-integration table even though it makes
  // real Jev calls exactly like every other integration (verified against
  // the real log: 372 jev-triage.ndjson rows with backend:'jev', zero
  // 'triage' decision rows in jev-assist.ndjson — only its unrelated
  // recordAnswered() outcome rows, which never carry backend by the
  // documented two-shape contract above and must stay that way).
  //
  // Normalize each REAL classification row (has `hash`, never `type` — see
  // appendTriageLog) into the same shape the loop below expects, so
  // `triage` gets counted/shown like any other integration. Explicitly
  // excludes recordAnswered's `{type:'answered', latencyMs}` reply-
  // turnaround rows (no `hash`) — those stay confined to
  // buildTriageAnswerReport and must never leak into this classifier-ms/
  // backend comparison (see the "no mixing" tests below).
  const triageDecisionRows = (Array.isArray(opts.triageRows) ? opts.triageRows : [])
    .filter((r) => r && typeof r.hash === 'string' && r.type !== 'answered')
    .map((r) => ({
      id: 'triage',
      h: r.hash,
      ts: r.ts,
      // backend is ALWAYS one of the three known values here — never left
      // undefined — even if a malformed worker/cache entry omitted it.
      backend: (r.backend === 'jev' || r.backend === 'cache') ? r.backend : 'baseline-only',
      ms: r.ms,
      jev: (typeof r.kind === 'string' && r.kind) ? r.kind : null,
      mode: 'on',
    }));

  for (const row of rows.concat(triageDecisionRows)) {
    if (!row || typeof row !== 'object') continue;
    const ts = row.ts ? Date.parse(row.ts) : NaN;
    if (cutoff !== null && Number.isFinite(ts) && ts < cutoff) continue;

    if (row.type === 'outcome') {
      if (!row.h) continue;
      const arr = outcomesByHash.get(row.h) || [];
      arr.push(row.outcome);
      outcomesByHash.set(row.h, arr);
      // Per-decision-source breakdown (independent of hash-joining a decision
      // row — a pure regex/lexical block never logs one): lets `jev report`
      // compare Jev-added vs regex-only outcome rates directly.
      if (row.id && row.source) {
        if (!outcomesBySource.has(row.id)) outcomesBySource.set(row.id, {});
        const bySource = outcomesBySource.get(row.id);
        if (!bySource[row.source]) bySource[row.source] = { good: 0, known: 0 };
        bySource[row.source].known++;
        if (!BAD_OUTCOME_RE.test(String(row.outcome))) bySource[row.source].good++;
      }
      continue;
    }

    if (!row.id) continue;
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id, calls: 0, jevAnswered: 0, cacheHits: 0,
        excludedNoCompare: 0,
        // changedHashByFresh: hash -> direction, populated ONLY from
        // non-cached rows. A decision (content hash) is counted ONCE
        // regardless of how many cache-hit retries share that hash, and a
        // pure cache hit never enters this map at all (cost $0, and it
        // isn't a NEW decision) -- see the dedupe fix comment above.
        changedHashByFresh: new Map(),
        failures: 0, latencies: [],
        labelCounts: new Map(), labeled: 0,
        // labelHashesAll/labelHashesFresh: distinct content hashes for
        // `choice`-style rows (typeof row.jev === 'string') -- these never
        // populate changedHashByFresh (no boolean baseline to compare
        // against), so a label-only integration's changed%/changedUnique
        // read as a bare 0 that looks like "nothing happened" rather than
        // "there is no boolean signal to measure". Tracked separately so
        // the report can show a real distinct-decision count instead.
        labelHashesAll: new Set(), labelHashesFresh: new Set(),
        // labelWouldChangeHashesFresh: distinct content hashes for a
        // `choice`-style row (typeof row.jev === 'string') whose trust-rule
        // outcome (row.changed for mode:'on', row.wouldChange otherwise) is
        // truthy and fresh (backend !== 'cache'). These never enter
        // changedHashByFresh (no boolean baseline -- added/relaxed/changed
        // semantics don't apply to a choice answer), but a would-change
        // choice decision is still a real decision an owner can label
        // tp/fp on, so it joins the SAME precision/labelled-sample pipeline
        // as changedHashByFresh below (see the tp/fp + known/good loops).
        labelWouldChangeHashesFresh: new Set(),
        // agreeHashesFresh: hash -> bool(jev===compare), FRESH calls only
        // (backend !== 'cache'), one entry per distinct content hash -- the
        // SAME dedupe/exclude-cache discipline changedHashByFresh already
        // applies a few lines below. A repeated cache-hit retry of the SAME
        // decision used to add its OWN +1 to agreeTotal/agree every single
        // time (root cause of wildly inconsistent agreement% across windows:
        // verified against the real log, one popular disagreeing decision
        // re-asked as a cache hit 5 times inflated its own weight 5x in the
        // denominator). A distinct decision must count once, no matter how
        // many times a cache retry re-logs it.
        agreeHashesFresh: new Map(),
        realCostSum: 0, realCostKnown: false,
        timeouts: 0, fallbackCount: 0, overOneSecFresh: 0,
      });
    }
    const bucket = byId.get(row.id);
    bucket.calls++;
    if (row.backend === 'jev' || row.backend === 'cache') bucket.jevAnswered++;
    if (row.backend === 'cache') bucket.cacheHits++;
    if (row.backend === 'baseline-only' && isHttpFailure(row.reason)) bucket.failures++;
    // OVERHEAD (item 4): timeouts and fallbacks across every row (not just
    // fresh -- a timeout still happened even if a later retry hit cache);
    // "over 1s" is fresh-only since a cache hit has ms:0 by construction.
    if (row.reason === 'timeout') bucket.timeouts++;
    if (row.backend === 'baseline-only' && row.mode === 'on') bucket.fallbackCount++;
    if (row.backend !== 'cache' && Number.isFinite(row.ms) && row.ms > 1000) bucket.overOneSecFresh++;
    // Real (gateway/price-table-reported) cost, summed across every FRESH
    // call in the window (never deduped -- two independent fresh calls for
    // the same content each cost real money). A cache hit's costUsd is
    // always 0 (see jev-assist.js's computeCostUsd), so including it is
    // harmless.
    if (Number.isFinite(row.costUsd)) {
      bucket.realCostSum += row.costUsd;
      bucket.realCostKnown = true;
    }
    // Agreement is computed ONLY from the caller-supplied `compare` field
    // (an independent heuristic verdict), never from `base` (trust-rule
    // math, sometimes a hardcoded constant -- see the module comment above).
    // A boolean `jev` answer with no `compare` field is excluded from the
    // metric, not silently folded into it. Deduped by content hash and
    // FRESH-ONLY (backend !== 'cache') -- same discipline as
    // changedHashByFresh below: a cache-hit retry of an already-counted
    // decision must not add its own extra vote to the agreement rate.
    if (typeof row.jev === 'boolean' && typeof row.compare === 'boolean') {
      if (row.h && row.backend !== 'cache') {
        bucket.agreeHashesFresh.set(row.h, row.jev === row.compare);
      }
    } else if (typeof row.jev === 'boolean' && (row.backend === 'jev' || row.backend === 'cache')) {
      bucket.excludedNoCompare++;
    }
    // LABEL DISTRIBUTION: a non-boolean `jev` answer (a `choice` question,
    // e.g. newRequest's new-request/follow-up/correction/question) has no
    // boolean baseline to agree/disagree against, so it is tallied here
    // instead — the top label's share becomes the table's `label%` column;
    // the full distribution is available via --json.
    if (typeof row.jev === 'string') {
      bucket.labeled++;
      bucket.labelCounts.set(row.jev, (bucket.labelCounts.get(row.jev) || 0) + 1);
      if (row.h) {
        bucket.labelHashesAll.add(row.h);
        if (row.backend !== 'cache') bucket.labelHashesFresh.add(row.h);
      }
    }
    // Dedupe changed decisions by content hash, and EXCLUDE cache hits
    // entirely: a cache hit is a retry of an already-counted decision, not a
    // new one, and it costs $0 -- counting it would inflate both the
    // changed-decision rate and any cost-per-decision metric. Same hash from
    // multiple fresh calls (e.g. a cache eviction re-triggers the same
    // content) still collapses to one entry via the Map key.
    //
    // Which direction field to read depends on mode (see the SHADOW-MODE
    // YIELD doc note above): an 'on' row's real, applied direction is
    // `row.changed`; a shadow (or off) row's `row.changed` is ALWAYS null by
    // construction, so `row.wouldChange` (the same trust-rule outcome,
    // computed without the mode gate) is read instead. A label-only row
    // (`typeof row.jev === 'string'` -- a `choice` classifier with no boolean
    // baseline) is excluded from changedRate entirely, regardless of mode.
    const isLabelOnly = typeof row.jev === 'string';
    const rawDirection = row.mode === 'on' ? row.changed : row.wouldChange;
    const effectiveDirection = isLabelOnly ? null : rawDirection;
    if (row.h && effectiveDirection && row.backend !== 'cache') {
      bucket.changedHashByFresh.set(row.h, effectiveDirection);
    }
    // A choice row's own would-change signal (rawDirection) doesn't feed
    // changedHashByFresh (see above), but it still marks a real decision
    // the owner can tp/fp-label -- collect its hash separately so the
    // precision/labelled-sample loops below can join it the same way a
    // boolean integration's changed decision would be.
    if (isLabelOnly && row.h && rawDirection && row.backend !== 'cache') {
      bucket.labelWouldChangeHashesFresh.add(row.h);
    }
    if (Number.isFinite(row.ms)) bucket.latencies.push(row.ms);
  }

  const integrations = [];
  for (const bucket of byId.values()) {
    const changed = { added: 0, relaxed: 0, changed: 0 };
    for (const direction of bucket.changedHashByFresh.values()) {
      if (direction === 'added') changed.added++;
      else if (direction === 'relaxed') changed.relaxed++;
      else if (direction === 'changed') changed.changed++;
    }
    const totalChangedUnique = bucket.changedHashByFresh.size;
    const freshCalls = bucket.calls - bucket.cacheHits;
    // Yield is computed on FRESH calls only -- a cache hit never represents
    // a new Jev decision, so it must not dilute the rate.
    const changedRate = freshCalls > 0 ? totalChangedUnique / freshCalls : 0;
    // agreeTotal is the DENOMINATOR jev-report actually shows/prints: the
    // count of DISTINCT fresh decisions (by content hash) that carried both
    // a boolean `jev` answer and a `compare` signal -- never raw row count
    // (a cache-hit retry of the same decision no longer adds its own vote;
    // see agreeHashesFresh's own comment above for why that mattered).
    const agreeTotal = bucket.agreeHashesFresh.size;
    const agree = [...bucket.agreeHashesFresh.values()].filter(Boolean).length;
    const agreementPct = agreeTotal > 0 ? agree / agreeTotal : null;

    // Precision/outcome join set: the deduped changed-decision hashes PLUS
    // (for a choice integration) the would-change label-candidate hashes
    // collected above. changedRate/changedUnique above deliberately read
    // ONLY changedHashByFresh (a choice answer has no added/relaxed/changed
    // baseline), but tp/fp labelling and outcome join apply to a would-change
    // choice decision exactly like a boolean one -- so this wider set feeds
    // ONLY the loops below, never the yield metrics above.
    // Materialized as a real array (not a live Map/Set iterator) -- it is
    // consumed by TWO separate loops below (known/good, then tp/fp), and an
    // iterator can only be walked once.
    const precisionHashes = [...bucket.changedHashByFresh.keys(), ...bucket.labelWouldChangeHashesFresh];

    // Outcome join is by the SAME deduped unique-hash set (fresh, changed
    // decisions only) -- iterating raw per-row hashes would count a cache
    // hit's outcome once per retry instead of once per decision.
    let good = 0; let known = 0;
    for (const h of precisionHashes) {
      const outcomes = outcomesByHash.get(h);
      if (!outcomes || outcomes.length === 0) continue;
      for (const o of outcomes) {
        known++;
        if (!BAD_OUTCOME_RE.test(String(o))) good++;
      }
    }
    const goodOutcomeRate = known > 0 ? good / known : null;

    // PRECISION (item 1): tp/fp per changed decision, human labels win over
    // auto. Auto is derived from the SAME outcome rows above (see the module
    // doc comment) via BAD_OUTCOME_RE -- never re-parsed here, never treated
    // as ground truth, and always reported separately from human labels.
    let humanTP = 0; let humanFP = 0; let autoTP = 0; let autoFP = 0;
    const humanLabelByHash = opts.humanLabelByHash || new Map();
    for (const h of precisionHashes) {
      const human = humanLabelByHash.get(h);
      if (human === 'tp') { humanTP++; continue; }
      if (human === 'fp') { humanFP++; continue; }
      const outcomes = outcomesByHash.get(h);
      if (!outcomes || outcomes.length === 0) continue; // unlabeled
      const anyBad = outcomes.some((o) => BAD_OUTCOME_RE.test(String(o)));
      if (anyBad) autoFP++; else autoTP++;
    }
    const tpTotal = humanTP + autoTP;

    const bySource = outcomesBySource.get(bucket.id) || {};
    const outcomeRateBySource = {};
    for (const src of Object.keys(bySource)) {
      const s = bySource[src];
      outcomeRateBySource[src] = s.known > 0 ? s.good / s.known : null;
    }

    const sorted = bucket.latencies.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.50);
    const p95 = percentile(sorted, 0.95);
    const failureRate = bucket.calls > 0 ? bucket.failures / bucket.calls : 0;
    const budgetMs = opts.budgetMsById && opts.budgetMsById[bucket.id];

    // Labelled sample size (tp+fp, human+auto combined) -- KEEP and REMOVE
    // BOTH require at least MIN_LABELED_FOR_VERDICT of these before either can
    // fire (see the module doc note above); below that, the verdict is always
    // REVIEW, regardless of calls/changedRate/goodOutcomeRate/failureRate.
    const labeledSample = humanTP + humanFP + autoTP + autoFP;
    const lowYieldNote = changedRate < LOW_YIELD_CHANGED_RATE
      ? `low yield: changed ${pct(changedRate)} < 1%` : null;

    // Label-only integration (a `choice` classifier, e.g. newRequest's
    // new-request/follow-up/correction/question, or a plain string label
    // like supervisorBlockerLabel's "wedged"): it has no boolean baseline,
    // so changedUnique/changedRate are ALWAYS 0 by construction (see
    // labelHashesAll/labelHashesFresh above and the effectiveDirection
    // comment) -- a bare "0 changed" reads as "Jev never did anything here"
    // when the real story is "there is nothing boolean to compare". Same
    // `bucket.labeled > 0 && known === 0` condition the suggestion branch
    // below already uses to detect this case. `known === 0` alone used to
    // short-circuit straight to "label-only, no outcome signal yet" even
    // when owner-delegated tp/fp labels on would-change choice decisions
    // (labeledSample) already gave it a real signal -- gate on labeledSample
    // too, so a labelled choice integration falls through to the normal
    // labelled-sample/KEEP/REMOVE checks below instead of getting stuck here.
    const isLabelOnly = bucket.labeled > 0 && known === 0 && labeledSample === 0;
    const labelOnlyNote = isLabelOnly
      ? `label-only: no boolean outcome to compare; ${bucket.labelHashesAll.size} distinct decisions (${bucket.labelHashesFresh.size} fresh)`
      : null;

    // A choice integration (bucket.labeled > 0) never populates
    // changedHashByFresh (no added/relaxed/changed baseline -- see the
    // effectiveDirection comment above), so changedRate stays 0 by
    // construction and can never clear the KEEP_CHANGED_RATE floor below.
    // labelWouldChangeRate is the same "how often did Jev's would-change
    // signal actually fire, on fresh calls" question, computed from the
    // would-change label-candidate hashes instead -- used ONLY to gate KEEP
    // for a choice integration; changedRate/changedUnique above are left
    // untouched (still 0) so the reported/displayed yield never lies about
    // there being a boolean baseline.
    const isChoiceIntegration = bucket.labeled > 0;
    const labelWouldChangeRate = freshCalls > 0
      ? bucket.labelWouldChangeHashesFresh.size / freshCalls : 0;
    const keepYieldRate = isChoiceIntegration ? labelWouldChangeRate : changedRate;

    let suggestion;
    if (bucket.calls < MIN_CALLS_FOR_VERDICT) {
      suggestion = `REVIEW (not enough data: ${bucket.calls} < ${MIN_CALLS_FOR_VERDICT} calls)`;
    } else if (isLabelOnly) {
      // Label-only integration (a `choice` classifier, no boolean baseline):
      // changedHashByFresh is never populated for these rows at all (see
      // above), so this MUST run before the labelled-sample/REMOVE/KEEP
      // checks below -- otherwise it would always read as "0/20 labels" and
      // report the wrong reason.
      suggestion = 'REVIEW (label-only, no outcome signal yet)';
    } else if (labeledSample < MIN_LABELED_FOR_VERDICT) {
      // Neither KEEP nor REMOVE may fire on an unlabelled sample -- a
      // changed-decision rate (high OR low) says nothing about whether Jev's
      // moves were actually RIGHT without labelled outcomes behind it (this is
      // what previously let e.g. 3 changed / 304 fresh hit REMOVE on
      // changedRate alone, with zero labelled outcomes).
      suggestion = `REVIEW (needs labels: ${labeledSample}/${MIN_LABELED_FOR_VERDICT})`;
    } else if (
      bucket.calls >= REMOVE_MIN_CALLS &&
      ((goodOutcomeRate !== null && goodOutcomeRate < REMOVE_GOOD_OUTCOME_RATE) ||
        failureRate > REMOVE_FAILURE_RATE)
    ) {
      // A changed-decision rate < 1% is NOT a REMOVE trigger on its own (see
      // LOW_YIELD_CHANGED_RATE above) -- only a proven bad-outcome rate or a
      // real failure rate ever earns REMOVE.
      suggestion = 'REMOVE';
    } else if (
      keepYieldRate >= KEEP_CHANGED_RATE &&
      goodOutcomeRate !== null && goodOutcomeRate >= KEEP_GOOD_OUTCOME_RATE
    ) {
      // KEEP requires an ACTUAL outcome signal (goodOutcomeRate !== null) —
      // a high changed-decision rate alone (Jev moving lots of decisions)
      // proves nothing about whether those moves were good ones.
      suggestion = 'KEEP';
    } else if (Number.isFinite(budgetMs) && Number.isFinite(p95) && p95 > budgetMs) {
      suggestion = 'REVIEW (p95 latency exceeds budget)';
    } else {
      suggestion = lowYieldNote ? `REVIEW (${lowYieldNote})` : 'REVIEW';
    }

    let topLabel = null; let labelPct = null;
    const labelDistribution = {};
    if (bucket.labeled > 0) {
      for (const [label, n] of bucket.labelCounts) {
        labelDistribution[label] = n / bucket.labeled;
        if (topLabel === null || n > bucket.labelCounts.get(topLabel)) topLabel = label;
      }
      labelPct = bucket.labelCounts.get(topLabel) / bucket.labeled;
    }

    const integrationRow = {
      id: bucket.id,
      calls: bucket.calls,
      freshCalls,
      cachedCalls: bucket.cacheHits,
      jevAnsweredPct: bucket.calls > 0 ? bucket.jevAnswered / bucket.calls : 0,
      cacheHits: bucket.cacheHits,
      agreementPct,
      // agreeTotal: the denominator behind agreementPct above -- DISTINCT
      // fresh decisions with a compare signal, never a raw row count. Always
      // exposed (even when agreementPct is null, i.e. agreeTotal === 0) so a
      // reader/caller can tell "no comparable decisions this window" apart
      // from "comparable decisions exist but happen to be 0% agreement".
      agreeTotal,
      excludedNoCompare: bucket.excludedNoCompare,
      topLabel,
      labelPct,
      labelDistribution,
      changed,
      changedUnique: totalChangedUnique,
      changedRate,
      isLabelOnly,
      labelOnlyNote,
      labelDistinctDecisions: bucket.labelHashesAll.size,
      labelDistinctFresh: bucket.labelHashesFresh.size,
      // Additive (item: choice tp/fp fix) -- distinct fresh would-change
      // choice decisions that joined the precision/labelled-sample pipeline
      // above; 0 for a boolean integration or a choice integration with no
      // would-change rows.
      labelWouldChangeUnique: bucket.labelWouldChangeHashesFresh.size,
      goodOutcomeRate,
      knownOutcomes: known,
      outcomeRateBySource,
      failureRate,
      p50,
      p95,
      // Cache hits cost $0 -- estimate from FRESH calls only.
      costEstimate: Number.isFinite(opts.costPerCall) ? freshCalls * opts.costPerCall : null,
      // REAL cost (gateway-reported or price-table-computed, never a manual
      // guess) -- null when no row in the window carried a costUsd at all.
      realCostTotal: bucket.realCostKnown ? bucket.realCostSum : null,
      realCostPerCall: (bucket.realCostKnown && freshCalls > 0) ? bucket.realCostSum / freshCalls : null,
      realCostPerChangedDecision: (bucket.realCostKnown && totalChangedUnique > 0)
        ? bucket.realCostSum / totalChangedUnique : null,
      // PRECISION / YIELD (items 1-2): tp/fp per changed decision, human and
      // auto reported separately -- auto is a heuristic, never ground truth.
      humanTP, humanFP, autoTP, autoFP,
      changedPer100: freshCalls > 0 ? (totalChangedUnique / freshCalls) * 100 : 0,
      tpPer100Human: freshCalls > 0 ? (humanTP / freshCalls) * 100 : 0,
      tpPer100Auto: freshCalls > 0 ? (autoTP / freshCalls) * 100 : 0,
      // COST EFFICIENCY (item 3): null whenever cost or the denominator is
      // unknown/zero -- never fabricated.
      costPerTp: (bucket.realCostKnown && tpTotal > 0) ? bucket.realCostSum / tpTotal : null,
      // OVERHEAD (item 4): from the existing ms/backend/reason fields only.
      pctCallsOver1s: freshCalls > 0 ? bucket.overOneSecFresh / freshCalls : null,
      timeouts: bucket.timeouts,
      fallbackCount: bucket.fallbackCount,
      suggestion,
    };
    integrationRow.headline = buildHeadline(integrationRow, opts.windowLabel || 'window');
    integrations.push(integrationRow);
  }

  integrations.sort((a, b) => b.calls - a.calls);
  const triageAnswers = buildTriageAnswerReport(opts.triageRows || []);
  return {
    generatedAt: new Date(now).toISOString(),
    costPerCallKnown: Number.isFinite(opts.costPerCall),
    integrations,
    triageAnswers,
  };
}

function pct(n) {
  return n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}

// weeklyReason(r) -> a short human-readable reason string for r.suggestion,
// built from the SAME numbers buildReport already computed (changedRate/
// goodOutcomeRate/failureRate/calls) — never re-derives the KEEP/REVIEW/
// REMOVE thresholds themselves (those live only in buildReport, above).
function weeklyReason(r) {
  if (r.suggestion.startsWith('REVIEW')) {
    const m = /\((.+)\)$/.exec(r.suggestion);
    return m ? m[1] : 'not enough data yet';
  }
  if (r.suggestion === 'KEEP') {
    return `changed ${pct(r.changedRate)}, good-outcome ${pct(r.goodOutcomeRate)} over ${r.calls} calls`;
  }
  if (r.suggestion === 'REMOVE') {
    // changedRate < 1% is low-yield-only, never a REMOVE reason on its own
    // (see LOW_YIELD_CHANGED_RATE) -- only a proven bad-outcome or failure
    // rate ever earns REMOVE, so those are the only reasons listed here.
    const reasons = [];
    if (r.goodOutcomeRate !== null && r.goodOutcomeRate < 0.60) reasons.push(`good-outcome ${pct(r.goodOutcomeRate)} < 60%`);
    if (r.failureRate > 0.20) reasons.push(`failure-rate ${pct(r.failureRate)} > 20%`);
    return reasons.length ? reasons.join(', ') : `${r.calls} calls`;
  }
  return r.suggestion;
}

// buildWeeklyScorecard(rows) -> {generatedAt, integrations: [{id, calls,
// suggestion, reason, mode}]}. Always the LAST 7 DAYS (the "weekly" in the
// name), reusing buildReport's own thresholds/aggregation verbatim — no
// separate logic to drift. `mode` is read live from jev.json (not from the
// log) so the CLI caller (or a human reading it) can see whether a
// KEEP/REMOVE verdict has already been acted on.
function buildWeeklyScorecard(rows, opts = {}) {
  const report = buildReport(rows, { days: 7, costPerCall: opts.costPerCall, humanLabelByHash: opts.humanLabelByHash, windowLabel: '7d' });
  const { getMode } = require('../hooks/lib/jev-assist.js');
  const cfg = opts.jevCfg || {};
  const integrations = report.integrations.map((r) => ({
    id: r.id,
    calls: r.calls,
    suggestion: r.suggestion,
    reason: weeklyReason(r),
    mode: getMode(r.id, cfg),
  }));
  return { generatedAt: report.generatedAt, integrations };
}

function printWeekly(scorecard) {
  console.log(`jev weekly scorecard — generated ${scorecard.generatedAt} (last 7 days)`);
  if (scorecard.integrations.length === 0) {
    console.log('No jev-assist.ndjson activity in the last 7 days.');
    return;
  }
  for (const r of scorecard.integrations) {
    console.log(`  ${r.id} [${r.mode}]: ${r.suggestion} — ${r.reason} (${r.calls} calls)`);
  }
}

function printTable(report) {
  console.log(`jev report — generated ${report.generatedAt}`);
  if (report.integrations.length === 0) {
    console.log('No jev-assist.ndjson activity found for this window.');
    return;
  }
  // "agree% (n=X)" -- X is agreeTotal, the DISTINCT fresh decisions with a
  // compare signal this pct is computed over (never a raw row count; a
  // cache-hit retry of the same decision no longer adds an extra vote --
  // see agreeHashesFresh's comment in buildReport). Stating the denominator
  // inline is what lets a reader tell "56% of 45 real decisions" apart from
  // "56% of 3" without cross-referencing --json.
  const header = ['integration', 'calls (fresh/cached)', 'jev%', 'agree% (n=distinct)', 'label%', 'added', 'relaxed', 'changed%', 'good-outcome%', 'outcome(jev/regex)', 'p50ms', 'p95ms', 'cost', 'suggestion'];
  const rows = report.integrations.map((r) => [
    r.id, `${r.calls} (${r.freshCalls}/${r.cachedCalls})`, pct(r.jevAnsweredPct),
    r.agreementPct == null
      ? (r.excludedNoCompare > 0 ? 'n/a (no comparison signal)' : 'n/a')
      : `${pct(r.agreementPct)} (n=${r.agreeTotal})`,
    r.topLabel != null ? `${pct(r.labelPct)} (${r.topLabel})` : 'n/a',
    String(r.changed.added), String(r.changed.relaxed),
    r.isLabelOnly ? `n/a (${r.labelDistinctDecisions} distinct)` : pct(r.changedRate),
    pct(r.goodOutcomeRate),
    `${pct(r.outcomeRateBySource.jev)}/${pct(r.outcomeRateBySource.regex)}`,
    r.p50 == null ? 'n/a' : String(r.p50), r.p95 == null ? 'n/a' : String(r.p95),
    r.costEstimate == null ? 'n/a' : `$${r.costEstimate.toFixed(4)}`, r.suggestion,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  const labelOnlyRows = report.integrations.filter((r) => r.isLabelOnly);
  if (labelOnlyRows.length > 0) {
    console.log('\nlabel-only integrations (changed% above reads "n/a" — a choice/label classifier has no boolean outcome to compare):');
    for (const r of labelOnlyRows) console.log(`  ${r.id}: ${r.labelOnlyNote}`);
  }
  if (!report.costPerCallKnown) {
    console.log('\ncost: n/a — set jev.json "costPerCall" (owner-supplied $/call estimate) to enable.');
  }

  const ta = report.triageAnswers;
  if (ta && (ta.urgent.n > 0 || ta.normal.n > 0)) {
    console.log('\ntriage answer-time (ms, time from a labeled inbound to the next outbound reply):');
    console.log(`  urgent:     n=${ta.urgent.n}  p50=${ta.urgent.p50 == null ? 'n/a' : ta.urgent.p50}  p95=${ta.urgent.p95 == null ? 'n/a' : ta.urgent.p95}`);
    console.log(`  non-urgent: n=${ta.normal.n}  p50=${ta.normal.p50 == null ? 'n/a' : ta.normal.p50}  p95=${ta.normal.p95 == null ? 'n/a' : ta.normal.p95}`);
  }
}

// printCostWindows(costWindows) — real (gateway/price-table) cost per
// integration for each window in `costWindows` ({'24h': report, '7d':
// report, ...}). Separate from the main table's manual `costPerCall`
// estimate: this is only ever populated from a real costUsd (see
// hooks/lib/jev-assist.js's computeCostUsd), never fabricated.
function printCostWindows(costWindows) {
  const labels = Object.keys(costWindows);
  if (labels.length === 0) return;
  console.log('\nreal cost (gateway/price-table-reported, not the manual costPerCall estimate):');
  for (const label of labels) {
    const report = costWindows[label];
    const known = report.integrations.filter((r) => r.realCostTotal !== null);
    if (known.length === 0) {
      console.log(`  ${label}: n/a — no row in this window carried a real cost (see jev-client.js's extractCostAndUsage, or set jev.json "prices").`);
      continue;
    }
    console.log(`  ${label}:`);
    for (const r of known) {
      const perCall = r.realCostPerCall == null ? 'n/a' : `$${r.realCostPerCall.toFixed(4)}/call`;
      const perChanged = r.realCostPerChangedDecision == null ? 'n/a' : `$${r.realCostPerChangedDecision.toFixed(4)}/changed`;
      console.log(`    ${r.id}: calls=${r.freshCalls} $total=${r.realCostTotal.toFixed(4)} ${perCall} ${perChanged}`);
    }
  }
}

// printRealCostSummary(report) — the SAME real (gateway/price-table/default-
// price) cost figures printCostWindows shows for the top-level report, but
// for ONE already-built report (e.g. a single `--by project`/`--by session`
// group) rather than a {24h,7d} window map. Reuses report.integrations[]'s
// existing realCostTotal/realCostPerCall fields (buildReport computes these
// identically regardless of which rows it was given) — no new aggregation,
// just a render for a shape printCostWindows does not otherwise reach. Skips
// silently when nothing in this group carried a real cost.
function printRealCostSummary(report) {
  const known = report.integrations.filter((r) => r.realCostTotal !== null);
  if (known.length === 0) return;
  let total = 0;
  for (const r of known) total += r.realCostTotal;
  console.log(`  real cost: $${total.toFixed(4)} total`);
  for (const r of known) {
    const perCall = r.realCostPerCall == null ? 'n/a' : `$${r.realCostPerCall.toFixed(4)}/call`;
    console.log(`    ${r.id}: calls=${r.freshCalls} $${r.realCostTotal.toFixed(4)} ${perCall}`);
  }
}

// printBudgetStatus(status) — status is null when budget.mode !== 'watch'
// (nothing printed: unlimited is the silent default). Never suggests
// disabling Jev; a budget in "watch" mode is observability only.
function printBudgetStatus(status) {
  if (!status) return;
  const lines = [];
  for (const label of ['24h', '7d']) {
    const s = status[label];
    if (!s) continue;
    const flag = s.exceeded ? 'EXCEEDED' : 'ok';
    lines.push(`  ${label}: $${s.spentUsd.toFixed(4)} / $${s.budgetUsd.toFixed(2)} budget (${flag})`);
  }
  if (lines.length === 0) return;
  console.log('\nbudget (watch mode -- observability only, Jev is never auto-disabled):');
  for (const line of lines) console.log(line);
}

// printCredit(credit, lowCredit) — credit is a getCreditBalanceCached()
// result; prints nothing at all when unsupported/disabled/no-key (the
// common, expected case for "typesafe" transport or Jev off), since that is
// not a warning-worthy condition, just "not applicable here".
function printCredit(credit, lowCredit) {
  if (!credit) return;
  if (!credit.ok) {
    if (credit.reason === 'unsupported-transport' || credit.reason === 'disabled' || credit.reason === 'no-key') return;
    console.log(`\ncredit balance: n/a (${credit.reason})`);
    return;
  }
  const cachedNote = credit.cached ? ' (cached)' : '';
  console.log(`\ncredit balance: $${credit.balanceUsd.toFixed(2)}${cachedNote}`);
  if (lowCredit && lowCredit.belowThreshold) {
    console.log(`  LOW CREDIT: below configured minCreditUsd ($${lowCredit.minCreditUsd.toFixed(2)}) -- Jev is never auto-disabled by this.`);
  }
}

function printHeadlines(report) {
  if (report.integrations.length === 0) return;
  console.log('\nheadlines:');
  for (const r of report.integrations) console.log(`  ${r.headline}`);
}

async function main() {
  const argv = process.argv.slice(2);

  // `label <hash> [tp|fp] [--home <dir>]` — the one write path (verdict
  // omitted = read-only inspect). Dispatched before the read-only report so
  // it never touches report state. argv[2] is a verdict only when it's
  // literally 'tp'/'fp' -- otherwise it's the start of flags (e.g. --home),
  // and the label is treated as omitted.
  if (argv[0] === 'label') {
    const hasVerdict = argv[2] === 'tp' || argv[2] === 'fp';
    const opts = parseArgs(argv.slice(hasVerdict ? 3 : 2));
    cmdLabel(argv[1], hasVerdict ? argv[2] : undefined, opts.home);
    return;
  }

  // `prune-audit --days N [--home <dir>]` — the ONLY way jev-audit.ndjson
  // entries are ever removed; never automatic.
  if (argv[0] === 'prune-audit') {
    const opts = parseArgs(argv.slice(1));
    cmdPruneAudit(opts.days, opts.home);
    return;
  }

  const opts = parseArgs(argv);
  const home = opts.home;
  let rows = readLines(home);
  let triageRows = readTriageLines(home);
  const costPerCall = readCostPerCall(home);
  const humanLabelByHash = latestHumanLabelByHash(readLabels(home));

  // --since/--until/--exclude-window: applied BEFORE --project/--by/--weekly
  // and before anything else -- see the module doc comment. Excludes a known-
  // accidental run from the report without touching jev-assist.ndjson itself.
  // windowInfo (item 3, reproducibility) captures the row counts BEFORE and
  // AFTER this filter runs, so the window + what it counted/excluded can be
  // printed alongside the report -- see describeWindow()'s own header.
  const rowsBeforeWindow = rows.length;
  rows = filterByTimeWindow(rows, opts);
  triageRows = filterByTimeWindow(triageRows, opts);
  const windowInfo = describeWindow(opts, rowsBeforeWindow, rows.length);

  // --project <name>: filter to rows tagged with that project key BEFORE
  // anything else (report, cost windows, budget) -- 'unknown' matches rows
  // that never got a project tagged (see groupKeyOf's own header).
  //
  // triageRows (jev-triage.ndjson, see hooks/lib/jev-triage.js's
  // appendTriageLog) are scoped the SAME way, via the same groupKeyOf --
  // otherwise a triage-decision row (which never carries `project`/
  // `sessionId` at all, so it always groups as 'unknown') would leak into
  // EVERY --project group's triage counts instead of being excluded like
  // any other project-less row. This is a real behavior change from before:
  // real triage rows now only ever appear under `--project unknown` (or
  // unfiltered), never duplicated into a named project's report.
  if (opts.project) {
    rows = rows.filter((r) => groupKeyOf(r, 'project') === opts.project);
    triageRows = triageRows.filter((r) => groupKeyOf(r, 'project') === opts.project);
  }

  // --weekly: a compact, ALWAYS-7-day per-integration summary (verdict +
  // reason), independent of --days/--window (which stay for the full table).
  if (opts.weekly) {
    const jevCfg = readJevJson(home);
    const scorecard = buildWeeklyScorecard(rows, { costPerCall, humanLabelByHash, jevCfg });
    if (opts.json) {
      process.stdout.write(JSON.stringify(scorecard, null, 2) + '\n');
    } else {
      printWeekly(scorecard);
    }
    return;
  }

  // --by project|session: split the (already --project-filtered, if given)
  // rows into one report PER distinct value and print/json each separately,
  // instead of the single combined report below.
  if (opts.by === 'project' || opts.by === 'session') {
    const groups = groupRowsBy(rows, opts.by);
    // triageRows split by the SAME key (groupKeyOf), so each group's triage
    // counts are scoped to that group instead of every group showing the
    // combined total (see the --project comment above for why this matters
    // -- real triage rows, having no project/session of their own, all fall
    // under the 'unknown' group here, disjoint from every named group).
    const triageGroups = groupRowsBy(triageRows, opts.by);
    const byGroup = {};
    for (const [key, groupRows] of groups) {
      byGroup[key] = buildReport(groupRows, {
        days: opts.days, costPerCall, triageRows: triageGroups.get(key) || [], humanLabelByHash, windowLabel: 'window',
      });
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ by: opts.by, window: windowInfo, groups: byGroup }, null, 2) + '\n');
    } else {
      printWindow(windowInfo);
      for (const [key, groupRows] of groups) {
        console.log(`\n=== ${opts.by}: ${key} (${groupRows.length} row(s)) ===`);
        printTable(byGroup[key]);
        printHeadlines(byGroup[key]);
        // Real cost, per integration, WITHIN this project/session — sums
        // costUsd (see hooks/lib/jev-assist.js computeCostUsd) exactly like
        // the top-level printCostWindows, just scoped to this one group.
        printRealCostSummary(byGroup[key]);
      }
    }
    return;
  }

  const report = buildReport(rows, { days: opts.days, costPerCall, triageRows, humanLabelByHash, windowLabel: 'window' });

  const windows = opts.window
    ? { [opts.window]: COST_WINDOWS[opts.window] != null ? COST_WINDOWS[opts.window] : Number(opts.window) }
    : COST_WINDOWS;
  const costWindows = buildCostWindows(rows, { costPerCall, windows, humanLabelByHash });
  const budget = readBudgetConfig(home);
  const budgetStatus = computeBudgetStatus(rows, budget);

  // Credit balance: report/status-time only (never the hook path), served
  // from jev-client.js's own 15-minute cache -- see getCreditBalanceCached's
  // doc comment. Fail-open: a network/config problem here must never break
  // the rest of the report.
  let credit = null; let lowCredit = null;
  try {
    const { getCreditBalanceCached } = require('../hooks/lib/jev-client.js');
    credit = await getCreditBalanceCached({});
    lowCredit = maybeWarnLowCredit({ home, budget, creditResult: credit });
  } catch (_) {
    credit = { ok: false, reason: 'error' };
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({}, report, { window: windowInfo, costWindows, budget, budgetStatus, credit, lowCredit }), null, 2) + '\n');
  } else {
    printWindow(windowInfo);
    printTable(report);
    printHeadlines(report);
    printCostWindows(costWindows);
    printBudgetStatus(budgetStatus);
    printCredit(credit, lowCredit);
  }
}

module.exports = {
  buildReport, readLines, readTriageLines, buildTriageAnswerReport, percentile,
  buildCostWindows, COST_WINDOWS, readBudgetConfig, computeBudgetStatus,
  buildHeadline, labelsLogPath, readLabels, latestHumanLabelByHash, cmdLabel,
  auditLogPath, readAuditSnippet, cmdPruneAudit, maybeWarnLowCredit, budgetStatePath,
  parseArgs, groupKeyOf, groupRowsBy, buildWeeklyScorecard, weeklyReason, readJevJson,
  parseIsoMs, filterByTimeWindow, MIN_LABELED_FOR_VERDICT, printRealCostSummary,
  describeWindow, printWindow,
};

if (require.main === module) {
  main();
}
