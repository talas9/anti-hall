'use strict';
// jev-assist.js — shared Jev integration layer: per-integration on/shadow/off
// modes, a trust rule that bounds how far Jev may move a caller's own baseline
// verdict, a content-hash cache, and one metrics line per decision.
//
// This module NEVER decides anything on its own authority — every result is
// gated by the caller's `baseline` and `trust` rule. Any failure (disabled,
// no key, timeout, bad response, cache/log I/O error) degrades to `baseline`.
//
// MODES (~/.anti-hall/jev.json):
//   {
//     "enabled": true,                        // master switch (default false)
//     "integrations": {
//       "speculation": "on",                  // "on" | "shadow" | "off"
//       "triage": "on",
//       "modelRouting": "shadow"
//     },
//     "triage": true,                          // LEGACY: pre-integrations-map
//                                               // triage on/off switch, still
//                                               // honored when "triage" is
//                                               // absent from `integrations`.
//     "confidenceThreshold": 0.85,
//     "costPerCall": 0.0004,                   // optional, MANUAL fallback consumed by jev-report
//     "prices": {                              // optional, PER-TOKEN fallback (see computeCostUsd)
//       "typesafe-ai/jev": { "inPerMTok": 0.5, "outPerMTok": 1.5 },
//       "default": { "inPerMTok": 0.5, "outPerMTok": 1.5 }
//     },
//     "audit": { "snippets": false }           // OFF by default; see maybeWriteAuditSnippet
//   }
//
//   Unlisted integration defaults: "speculation" and "triage" default "on"
//   once `enabled` is true (matches pre-jev-assist behavior — no migration
//   needed for an existing {"enabled":true} config). Every OTHER integration
//   (modelRouting, claimLedger, mergeGate, ...) defaults to "shadow": Jev is
//   consulted and logged, but never allowed to change the outcome, until an
//   owner explicitly promotes it to "on" in jev.json.
//
//   "shadow" ALWAYS logs (backend 'jev'/'cache'/'baseline-only' as usual) so
//   `jev report` can show what Jev WOULD have changed before it is trusted.
//
// ENV OVERRIDES:
//   ANTIHALL_JEV=0                 force-disable everything (wins over jev.json)
//   ANTIHALL_JEV_<ID>=0            force that one integration to "off"
//     (id -> env name: camelCase is split on capitals, e.g. modelRouting ->
//     ANTIHALL_JEV_MODEL_ROUTING)
//
// TRUST RULES — the only three shapes any integration needs:
//   'add-block'   : Jev may only turn a non-blocking baseline INTO a block.
//                   final = baseline || (confident && jev===true)
//   'relax-block' : Jev may only turn a blocking baseline into a non-block.
//                   Jev is consulted ONLY when baseline would already block.
//                   final = baseline && !(confident && jev===false)
//   'advisory'    : no boolean baseline to protect; final = jev when
//                   confident, else baseline (baseline may be null/undefined).
//   Any Jev failure, low confidence, or `mode !== 'on'` -> final = baseline.
//
// A caller whose Jev answer is not itself a boolean (e.g. a `choice`
// question) passes `judge(answer) -> boolean` to normalize it into the same
// true/false space the trust rules above operate on.
//
// CACHE: ~/.anti-hall/cache/jev-assist.json, keyed by
//   sha256(id + questionVersion + (cacheKey ?? state)).slice(0,16), bounded to
//   500 entries (oldest evicted by insertion order), atomic tmp+rename write.
//
// LOG: ~/.anti-hall/logs/jev-assist.ndjson, rotated at 2MB into .1 .. .N
// (N = setting jev.logRotatedFiles, default 10: about 20 days at 2026-09's
// ~1MB/day). Just before each rotation, writeDailyRollups() folds every
// retained row into ~/.anti-hall/logs/jev-daily/<YYYY-MM-DD>.json (per
// id x backend x mode counts, changed, timeouts, cost, p50/p95), so a seat
// audit outlives the raw rows. Rollups are only removed when the owner sets
// jev.rollupRetentionDays > 0 (default 0 = keep all). One line per
// ask()/askSync() call:
//   {ts, id, h, base, jev, conf, ms, backend, final, changed, cached, mode,
//    reason?, compare?, costUsd?, costSource?, tokensIn?, tokensOut?}
//   costUsd/costSource ('cache'|'gateway'|'price-table'|null) are written
//   whenever a decision was actually evaluated (see computeCostUsd). A cache
//   hit always costs $0; a gateway-reported cost (verified against Vercel's
//   own docs, see jev-client.js's extractCostAndUsage) is preferred over the
//   `prices` per-token table above; if neither is available, costUsd is
//   null -- NEVER fabricated, and computing it never makes an extra network
//   call.
//   changed is 'added' | 'relaxed' | null. No message bodies, no credentials.
//   `compare` (optional, boolean) is a caller-supplied INDEPENDENT verdict
//   (e.g. a regex/lexical heuristic evaluated alongside Jev) used ONLY by
//   `jev report`'s agreement metric. It is separate from `base`, which is
//   trust-rule math and, for some callers (e.g. speculation-guard's
//   add-block baseline), a hardcoded constant rather than a real verdict --
//   comparing `jev` against `base` there is NOT a measure of agreement.
//
// recordOutcome({id, h, outcome, project}) appends a second line shape
//   {ts, type:'outcome', id, h, outcome, project} so `jev report` can join a
//   later observed result (e.g. 'evidence-added', 'user-override') back to
//   the decision by hash. `project` uses the same cwd-basename fallback as
//   finalize()'s decision rows (see defaultProject() below).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('./lazy-node.js').crypto; // lazy: loaded on first use
const cp = require('./lazy-node.js').lazy('child_process'); // lazy: loaded on first spawn
const { jevDecide, loadJevConfig, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } = require('./jev-client.js');
const testHomeGuard = require('../../companion/lib/test-home-guard.js');
const { scrubSecrets } = require('./secret-scrub.js');

const CACHE_MAX_ENTRIES = 500;
const LOG_MAX_BYTES = 1024 * 1024; // 1MB, jev-audit.ndjson (one .1 backup)
const DECISION_LOG_MAX_BYTES = 2 * 1024 * 1024; // jev-assist.ndjson, see LOG above
const DEFAULT_ROTATED_FILES = 10;
const QUESTION_VERSION = 'v1';
const WORKER_PATH = path.join(__dirname, 'jev-assist-worker.js');
const DETACHED_WORKER_PATH = path.join(__dirname, 'jev-assist-detached-worker.js');
const DEFAULT_SYNC_TIMEOUT_MS = 1500;
// askDetached callers never wait on the answer (it lands in the log/cache for a
// later turn), so latency is free: default to the client's hard ceiling instead
// of the 1500ms interactive default, which timed out 7-50% of detached calls
// (successful calls take ~550-1350ms, timeouts landed at ~1500-1700ms). An
// explicitly configured jev.timeoutMs (anything but the 1500 default) still wins.
const DETACHED_DEFAULT_BUDGET_MS = MAX_TIMEOUT_MS;

// Integrations that predate the per-integration modes map and must keep
// their current ("Jev fully trusted") behavior with zero jev.json changes.
const LEGACY_ON_DEFAULT = new Set(['speculation', 'triage']);

function homeDir(home) {
  return testHomeGuard.resolveHome(typeof home === 'string' && home ? home : null);
}
function jevConfigPath(home) {
  return path.join(homeDir(home), '.anti-hall', 'jev.json');
}
function cachePath(home) {
  return path.join(homeDir(home), '.anti-hall', 'cache', 'jev-assist.json');
}
function logPath(home) {
  return path.join(homeDir(home), '.anti-hall', 'logs', 'jev-assist.ndjson');
}

// turnRefFromTranscript(transcriptPath) -> a short, best-effort pointer to
// WHICH turn a decision row was about: the ISO `timestamp` field of the LAST
// JSONL line in the transcript (assistant or otherwise -- the goal is "what
// turn was this decision made during", not role-filtering), read via a cheap
// tail scan (last 64KB) so a large transcript never costs a full read. Falls
// back to the transcript's own line count (e.g. "L123") when no line in the
// window carries a parseable `timestamp`. Returns null on any error, a
// missing/non-string path, or an empty file -- callers pass this straight
// through as ask()/askSync()/askDetached()'s optional `turnRef`, which is
// itself omitted (not logged as null) when this returns null. Never throws.
function turnRefFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  try {
    const WINDOW = 65536;
    const size = fs.statSync(transcriptPath).size;
    let data;
    if (size <= WINDOW) {
      data = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const buf = Buffer.alloc(WINDOW);
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const bytesRead = fs.readSync(fd, buf, 0, WINDOW, size - WINDOW);
        data = buf.toString('utf8', 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
    }
    const lines = data.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry && typeof entry.timestamp === 'string' && entry.timestamp) return entry.timestamp;
      } catch (_) { /* partial/invalid line at a window boundary -- skip */ }
    }
    return 'L' + lines.length;
  } catch (_) {
    return null;
  }
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

// envNameFor('modelRouting') -> 'ANTIHALL_JEV_MODEL_ROUTING'
function envNameFor(id) {
  return 'ANTIHALL_JEV_' + String(id).replace(/([A-Z])/g, '_$1').toUpperCase();
}

// getMode(id, fileCfg) -> 'on' | 'shadow' | 'off'. Never throws.
// Every integration id (the 13 from 0.108.4, plus postHandoverGate in 0.109.0) has its own settings-schema
// entry (jevIntegrations.<id>) and resolves through the unified settings
// store (env > settings.json > /config > legacy jev.json "integrations" map
// > default). A future id with no schema entry falls through to undefined
// here, and getMode() below falls back to reading fileCfg.integrations[id]
// directly (the pre-schema behavior).
function schemaIntegrationMode(id, home) {
  try {
    const schema = require('./settings-schema.js');
    if (!schema.findSetting('jevIntegrations', id)) return undefined;
    return require('./settings.js').get('jevIntegrations', id, undefined, { home: homeDir(home) });
  } catch (_) { return undefined; }
}

// schemaIntegrationSource(id, home) -> the precedence tier that answered
// schemaIntegrationMode(id, home) ('env'|'file'|'plugin-option'|'legacy'|
// 'default'), or undefined when the id has no schema entry. Used only for
// the pre-integrations-map triage:false legacy check below. Never throws.
function schemaIntegrationSource(id, home) {
  try {
    const schema = require('./settings-schema.js');
    if (!schema.findSetting('jevIntegrations', id)) return undefined;
    return require('./settings.js').source('jevIntegrations', id, { home: homeDir(home) });
  } catch (_) { return undefined; }
}

// getMode(id, fileCfg, home) -> 'on' | 'shadow' | 'off'. Never throws.
// opts.assumeEnabled skips the Jev-enabled gate (jev-setup status shows the
// configured modes even while Jev is off).
function getMode(id, fileCfg, home, opts) {
  const cfg = fileCfg || {};
  let jevEnabled = cfg.enabled === true || process.env.ANTIHALL_JEV === '1';
  // `enabled` resolves through the unified settings store (env > settings.json
  // > /config > legacy jev.json > the caller's value), the same chain
  // jev-client.js uses; the raw jev.json alone would ignore a settings.json
  // value and the hooks would disagree with the client.
  try {
    jevEnabled = require('./settings.js').get('jev', 'enabled', cfg.enabled === true, { home: homeDir(home) }) === true;
  } catch (_) { /* keep the raw value */ }
  if (process.env.ANTIHALL_JEV === '0') jevEnabled = false;
  if (!jevEnabled && !(opts && opts.assumeEnabled)) return 'off';

  if (process.env[envNameFor(id)] === '0') return 'off';

  const integrations = (cfg.integrations && typeof cfg.integrations === 'object' &&
    !Array.isArray(cfg.integrations)) ? cfg.integrations : {};
  const schemaValue = schemaIntegrationMode(id, home);
  const value = schemaValue !== undefined ? schemaValue : integrations[id];

  // Legacy PRE-integrations-map switch: a bare {"triage": false} in jev.json
  // (no "integrations" map at all) still disables triage. This predates the
  // integrations map and ranks below every real precedence tier: only
  // applies when nothing more specific (env/settings.json/plugin-option/the
  // nested "integrations.triage" legacy key) resolved a value, i.e.
  // schemaIntegrationMode fell all the way through to its own schema default.
  if (id === 'triage' && cfg.triage === false && schemaIntegrationSource(id, home) === 'default') {
    return 'off';
  }

  if (value === 'on' || value === 'shadow' || value === 'off') return value;

  return LEGACY_ON_DEFAULT.has(id) ? 'on' : 'shadow';
}

// readPrices(home) -> jev.prices (settings.json, or legacy jev.json `prices`) map: {model: {inPerMTok, outPerMTok}}.
// Optional, owner-supplied, consumed ONLY when a call's response includes
// real token counts but no gateway-reported cost (see computeCostUsd below
// and jev-client.js's extractCostAndUsage doc comment for why that is the
// common case on this endpoint today). Never throws.
// jevSetting(home, key, dflt) -> jev.<key> from the unified settings store
// (hooks/lib/settings.js: env > ~/.anti-hall/settings.json > /config >
// jev.json legacy (same nested key) > default). Never throws.
function jevSetting(home, key, dflt) {
  try {
    return require('./settings.js').get('jev', key, dflt, { home: homeDir(home) });
  } catch (_) {
    return dflt;
  }
}

function readPrices(home) {
  const prices = jevSetting(home, 'prices', null);
  return (prices && typeof prices === 'object' && !Array.isArray(prices)) ? prices : {};
}

// computeCostUsd({r, cachedFlag, home}) -> {costUsd, costSource}
//   'cache'       : a cache hit represents no new inference -- always $0.
//   'gateway'     : the response itself carried a real cost (see
//                   jev-client.js's extractCostAndUsage -- verified against
//                   Vercel's docs, not guessed).
//   'price-table' : the response carried real token counts but no cost, and
//                   the owner configured a per-token price for this model
//                   (or a "default" entry) in jev.json `prices`.
//   'default-price': same shape as 'price-table' (real tokensIn/tokensOut,
//                   pure arithmetic), but from the BUILT-IN default rate
//                   (jev.priceUsdPerMInput/jev.priceUsdPerMOutput) rather
//                   than an owner-configured `prices` entry -- this is what
//                   makes every jev-assist row carry a real costUsd out of
//                   the box instead of staying permanently null until an
//                   owner manually populates `prices`. Defaults are Jev's
//                   OWN published rate (verified: typesafe.ai,
//                   vercel.com/ai-gateway/models/jev, openrouter.ai/typesafe
//                   -- $0.042/1M input tokens, output free) so they are
//                   accurate for the actual judge model this file calls
//                   UNLESS the owner overrides them (e.g. a custom
//                   judgeModel) via those two settings keys.
//   null          : neither is available. NEVER fabricated, and NEVER an
//                   extra network call -- this is pure arithmetic over data
//                   the call already returned.
function computeCostUsd({ r, cachedFlag, home }) {
  if (cachedFlag) return { costUsd: 0, costSource: 'cache' };
  if (!r || !r.ok) return { costUsd: null, costSource: null };
  if (Number.isFinite(r.cost)) return { costUsd: r.cost, costSource: 'gateway' };
  if (Number.isFinite(r.tokensIn) && Number.isFinite(r.tokensOut)) {
    const prices = readPrices(home);
    const entry = (r.model && prices[r.model]) || prices.default;
    if (entry && Number.isFinite(entry.inPerMTok) && Number.isFinite(entry.outPerMTok)) {
      const costUsd = (r.tokensIn / 1e6) * entry.inPerMTok + (r.tokensOut / 1e6) * entry.outPerMTok;
      return { costUsd, costSource: 'price-table' };
    }
    const inPerMTok = jevSetting(home, 'priceUsdPerMInput', 0.042);
    const outPerMTok = jevSetting(home, 'priceUsdPerMOutput', 0);
    if (Number.isFinite(inPerMTok) && Number.isFinite(outPerMTok)) {
      const costUsd = (r.tokensIn / 1e6) * inPerMTok + (r.tokensOut / 1e6) * outPerMTok;
      return { costUsd, costSource: 'default-price' };
    }
  }
  return { costUsd: null, costSource: null };
}

// --- Budget watch (opt-in, NEVER auto-disables Jev) -------------------------
//
// Settings jev.budget.{mode,usdPerDay,usdPerWeek} (/anti-hall:settings, or
// legacy ~/.anti-hall/jev.json {"budget": {"mode": "watch", "usdPerDay": 5}}).
//   mode defaults to "unlimited" (no warnings at all). "watch" requires a
//   positive `usdPerDay`; `usdPerWeek` is optional (jev-report can still show
//   a 7d window without it -- see jev-report.js).
//
// In watch mode, once the rolling DAY's real cost exceeds usdPerDay, the
// assist layer logs ONE warning per calendar day (a `type:'budget-warning'`
// line in jev-assist.ndjson) -- there is no existing Jev user-facing notice
// path in this codebase (checked: no notice/systemMessage/additionalContext
// plumbing in any jev-*.js hook), so "report only" applies: the warning
// surfaces via `jev report`, never injected into a hook's own output. Jev is
// NEVER auto-disabled by this path, under any configuration.
function budgetStatePath(home) {
  return path.join(homeDir(home), '.anti-hall', 'state', 'jev-budget.json');
}

function readBudgetConfig(home) {
  const mode = jevSetting(home, 'budget.mode', 'unlimited') === 'watch' ? 'watch' : 'unlimited';
  const d = jevSetting(home, 'budget.usdPerDay', null);
  const w = jevSetting(home, 'budget.usdPerWeek', null);
  const usdPerDay = (Number.isFinite(d) && d > 0) ? d : null;
  const usdPerWeek = (Number.isFinite(w) && w > 0) ? w : null;
  return { mode, usdPerDay, usdPerWeek };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function readBudgetState(home) {
  try {
    const raw = fs.readFileSync(budgetStatePath(home), 'utf8');
    const parsed = JSON.parse(raw);
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

// maybeWarnBudget({home, costUsd}) — best-effort, never throws, NEVER
// disables Jev. Called only when watch mode is on and this call's real cost
// is known; a whole-file skip (mode !== 'watch') costs nothing beyond the
// one readJevJson() readBudgetConfig() already needs to check the mode.
function maybeWarnBudget({ home, costUsd }) {
  try {
    const budget = readBudgetConfig(home);
    if (budget.mode !== 'watch' || !Number.isFinite(costUsd)) return;

    const today = todayUtc();
    let state = readBudgetState(home);
    // A new calendar day resets BOTH the running spend and warn eligibility
    // -- carrying yesterday's warnedDate forward would silently suppress the
    // "one warning per day" cadence on a fresh, unwarned day.
    if (state.date !== today) state = { date: today, spentUsd: 0, warnedDate: null };
    state.spentUsd = (Number.isFinite(state.spentUsd) ? state.spentUsd : 0) + costUsd;

    if (Number.isFinite(budget.usdPerDay) && state.spentUsd > budget.usdPerDay && state.warnedDate !== today) {
      appendLog(home, {
        ts: new Date().toISOString(), type: 'budget-warning', window: 'daily',
        spentUsd: state.spentUsd, budgetUsd: budget.usdPerDay,
      });
      state.warnedDate = today;
    }
    writeBudgetState(home, state);
  } catch (_) {
    // best-effort only -- must never affect the caller's decision.
  }
}

function contentHash(parts) {
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

// --- Audit snippets (opt-in, OFF by default) --------------------------------
//
// Setting jev.audit.snippets (legacy jev.json {"audit": {"snippets": true}}). When on, a REDACTED
// snippet (first ~200 chars of the judged `state`, after scrubbing) is
// stored ONLY for a decision that actually CHANGED the outcome (added/
// relaxed/changed -- never for an unchanged call), so this never accumulates
// data for the common case. Stored separately from jev-assist.ndjson, in
// ~/.anti-hall/logs/jev-audit.ndjson, mode 600, rotated like the other logs.
// No scrubber existed anywhere in this codebase before this (checked: no
// scrub/redact/mask utility in hooks/ or scripts/) -- scrubSecrets() below is
// intentionally minimal and scoped to this one feature, not a new general
// abstraction.
function auditLogPath(home) {
  return path.join(homeDir(home), '.anti-hall', 'logs', 'jev-audit.ndjson');
}

function readAuditConfig(home) {
  return { snippets: jevSetting(home, 'audit.snippets', false) === true };
}

// scrubSecrets lives in ./secret-scrub.js (shared with the outbound senders).

function rotateAuditIfNeeded(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > LOG_MAX_BYTES) {
      const old = p + '.1';
      try { fs.rmSync(old, { force: true }); } catch (_) { /* no prior backup */ }
      fs.renameSync(p, old);
    }
  } catch (_) {
    // file doesn't exist yet -- nothing to rotate
  }
}

// maybeWriteAuditSnippet({home, id, hash, state, changed, wouldChange}) —
// best-effort, never throws. Writes when jev.audit.snippets is true AND
// EITHER this decision actually changed the outcome (`changed`, an 'on'-mode
// row) OR it WOULD have changed the outcome had mode been 'on' (`wouldChange`
// — a shadow-mode row; shadow is the default mode for every integration
// under evaluation, so gating on `changed` alone meant a shadow decision
// never got a snippet, even with snippets on -- the exact decisions the
// owner/agent needs to label). Either is the direction string ('added' /
// 'relaxed' / 'changed'), or falsy for no (would-)change. When the write is
// triggered by `wouldChange` only (not `changed`), the stored row carries
// `shadow: true` so `jev-report label` can tell an actual change from a
// would-have-changed one.
// Integrations whose verdict lives at the END of the judged text store a
// head+tail snippet (200 + 400 chars + joiner, <= 700 total) instead of head-only.
const TAIL_SNIPPET_IDS = new Set(['outputVerifyGuard']);
const SNIPPET_HEAD = 200;
const SNIPPET_TAIL = 400;

function maybeWriteAuditSnippet({ home, id, hash, state, changed, wouldChange }) {
  try {
    const trigger = changed || wouldChange;
    if (!trigger || typeof state !== 'string' || !state) return;
    if (!readAuditConfig(home).snippets) return;
    let snippet;
    if (TAIL_SNIPPET_IDS.has(id)) {
      // Head+tail: the verdict (pass/fail summary) sits at the END of the
      // output. Scrub the WHOLE text first so a secret straddling a cut
      // boundary can't survive half-redacted, then keep head + tail.
      const scrubbed = scrubSecrets(state);
      snippet = scrubbed.length <= SNIPPET_HEAD + SNIPPET_TAIL
        ? scrubbed
        : scrubbed.slice(0, SNIPPET_HEAD) + ' \u2026 ' + scrubbed.slice(-SNIPPET_TAIL);
    } else {
      snippet = scrubSecrets(state.slice(0, 2000)).slice(0, 200);
    }
    const p = auditLogPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateAuditIfNeeded(p);
    const prevUmask = process.umask(0o077);
    try {
      const row = { ts: new Date().toISOString(), id, h: hash, snippet };
      if (!changed && wouldChange) row.shadow = true;
      fs.appendFileSync(p, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(p, 0o600); // belt-and-suspenders: appendFileSync's mode only applies when it CREATES the file
    } finally {
      process.umask(prevUmask);
    }
  } catch (_) {
    // best-effort only -- must never affect the caller's decision.
  }
}

function readCache(home) {
  try {
    const raw = fs.readFileSync(cachePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// nextCacheSeq(cache) -> one past the highest `_seq` in `cache`. Eviction
// drops the lowest `_seq` first and each hook is a fresh process, so a
// per-process counter (the old `++cacheSeq`, restarting at 1) made new entries
// sort among the OLDEST and pinned any higher-seq entry forever. Seeding from
// the stored max keeps insertion order across processes.
function nextCacheSeq(cache) {
  let max = 0;
  for (const v of Object.values(cache || {})) {
    if (v && Number.isFinite(v._seq) && v._seq > max) max = v._seq;
  }
  return max + 1;
}
function writeCache(home, cache) {
  try {
    const entries = Object.entries(cache);
    let bounded = cache;
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => ((a[1] && a[1]._seq) || 0) - ((b[1] && b[1]._seq) || 0));
      bounded = {};
      for (const [k, v] of entries.slice(entries.length - CACHE_MAX_ENTRIES)) bounded[k] = v;
    }
    const dir = path.dirname(cachePath(home));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = cachePath(home) + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(bounded), 'utf8');
    fs.renameSync(tmp, cachePath(home));
  } catch (_) {
    // best-effort only
  }
}

function dailyDir(home) {
  return path.join(homeDir(home), '.anti-hall', 'logs', 'jev-daily');
}

// rotatedFilesSetting(home) -> jev.logRotatedFiles as an integer >= 1.
function rotatedFilesSetting(home) {
  const n = Number(jevSetting(home, 'logRotatedFiles', DEFAULT_ROTATED_FILES));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_ROTATED_FILES;
}

// shiftRotated(p, keep): p.(keep-1) -> p.keep, ..., p -> p.1. The rename onto
// p.keep replaces the oldest generation, exactly as the old single-backup
// rotation replaced p.1. Files past `keep` (after lowering the setting) are
// left alone. Throws on the final rename so a caller can fall back.
function shiftRotated(p, keep) {
  for (let i = keep - 1; i >= 1; i--) {
    try { fs.renameSync(p + '.' + i, p + '.' + (i + 1)); } catch (_) { /* gap in the chain */ }
  }
  fs.renameSync(p, p + '.1');
}

// retainedLogFiles(p) -> [p.K, ..., p.1, p] that exist, oldest first. Reads
// every numeric suffix present, not just up to the current setting, so a
// lowered jev.logRotatedFiles never hides data still on disk.
function retainedLogFiles(p) {
  let names = [];
  try { names = fs.readdirSync(path.dirname(p)); } catch (_) { return []; }
  const base = path.basename(p);
  const gens = [];
  for (const n of names) {
    if (n === base) continue;
    const m = n.startsWith(base + '.') ? /^\d+$/.exec(n.slice(base.length + 1)) : null;
    if (m) gens.push(Number(m[0]));
  }
  gens.sort((a, b) => b - a);
  const out = gens.map((g) => p + '.' + g);
  if (fs.existsSync(p)) out.push(p);
  return out;
}

function readNdjsonFiles(files) {
  const rows = [];
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch (_) { /* corrupt line */ }
    }
  }
  return rows;
}

function pctile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// buildDailyRollups(rows) -> Map<'YYYY-MM-DD', rollup>. Per UTC day, one group
// per id x backend x mode: n rows, fresh (non-cache) rows, changed = distinct
// fresh hashes whose trust rule moved the baseline (`changed` for mode on,
// `wouldChange` otherwise; label-only string answers excluded, as in
// jev-report), timeouts, fellBack (rows served by the fallback transport; the
// day also gets `transports`: rows per vendor), failures (baseline-only with a reason), costUsd (sum
// of reported cost, null when none reported), p50/p95 of `ms`. Outcome rows
// are counted per id x outcome. Other row types are skipped.
function buildDailyRollups(rows) {
  const days = new Map();
  for (const r of rows) {
    if (!r || typeof r.ts !== 'string' || !r.id) continue;
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, { groups: new Map(), outcomes: new Map(), transports: {} });
    const d = days.get(day);
    if (r.type === 'outcome') {
      const k = r.id + '\u0001' + String(r.outcome);
      d.outcomes.set(k, (d.outcomes.get(k) || 0) + 1);
      continue;
    }
    if (r.type) continue;
    if (r.transport === 'vercel' || r.transport === 'typesafe') d.transports[r.transport] = (d.transports[r.transport] || 0) + 1;
    const backend = r.backend || 'unknown';
    const mode = r.mode || 'unknown';
    const k = r.id + '\u0001' + backend + '\u0001' + mode;
    if (!d.groups.has(k)) {
      d.groups.set(k, { id: r.id, backend, mode, n: 0, fresh: 0, changedHashes: new Set(), timeouts: 0, failures: 0, fellBack: 0, cost: 0, costKnown: false, ms: [] });
    }
    const g = d.groups.get(k);
    g.n++;
    if (backend !== 'cache') g.fresh++;
    const dir = r.mode === 'on' ? r.changed : r.wouldChange;
    if (dir && typeof r.jev !== 'string' && backend !== 'cache' && r.h) g.changedHashes.add(r.h);
    if (r.reason === 'timeout') g.timeouts++;
    if (r.fellBack === true) g.fellBack++;
    if (backend === 'baseline-only' && r.reason) g.failures++;
    if (Number.isFinite(r.costUsd)) { g.cost += r.costUsd; g.costKnown = true; }
    if (Number.isFinite(r.ms)) g.ms.push(r.ms);
  }
  const out = new Map();
  for (const [day, d] of days) {
    const groups = [...d.groups.values()].map((g) => {
      const ms = g.ms.sort((a, b) => a - b);
      return {
        id: g.id, backend: g.backend, mode: g.mode, n: g.n, fresh: g.fresh,
        changed: g.changedHashes.size, timeouts: g.timeouts, failures: g.failures, fellBack: g.fellBack,
        costUsd: g.costKnown ? Math.round(g.cost * 1e8) / 1e8 : null,
        p50Ms: pctile(ms, 0.5), p95Ms: pctile(ms, 0.95),
      };
    }).sort((a, b) => (a.id + a.backend + a.mode).localeCompare(b.id + b.backend + b.mode));
    const outcomes = [...d.outcomes.entries()].map(([k, n]) => {
      const [id, outcome] = k.split('\u0001');
      return { id, outcome, n };
    });
    out.set(day, { v: 1, day, groups, outcomes, transports: d.transports });
  }
  return out;
}

// writeDailyRollups(home) -> number of rollup files written. Reads every
// retained jev-assist.ndjson generation. A day is (re)written only when all
// of its rows are still on disk (its UTC start is at/after the oldest
// retained row) or when it has no rollup yet; a day whose early rows already
// rotated away keeps its earlier, complete rollup. `complete` records which
// case produced the file. Atomic tmp+rename writes. Never throws.
function writeDailyRollups(home) {
  let written = 0;
  try {
    const rows = readNdjsonFiles(retainedLogFiles(logPath(home)));
    let oldest = Infinity;
    for (const r of rows) {
      const t = r && typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (Number.isFinite(t) && t < oldest) oldest = t;
    }
    const dir = dailyDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const generatedAt = new Date().toISOString();
    for (const [day, rollup] of buildDailyRollups(rows)) {
      const file = path.join(dir, day + '.json');
      const complete = Date.parse(day + 'T00:00:00Z') >= oldest;
      if (!complete && fs.existsSync(file)) continue;
      const tmp = file + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(Object.assign({ generatedAt, complete }, rollup)), 'utf8');
      fs.renameSync(tmp, file);
      written++;
    }
    pruneDailyRollups(home);
  } catch (_) { /* best-effort */ }
  return written;
}

// pruneDailyRollups(home): OWNER OPT-IN ONLY. jev.rollupRetentionDays
// defaults to 0 = never remove anything; only an explicit N > 0 removes
// rollup files for days older than N days.
function pruneDailyRollups(home) {
  const days = Number(jevSetting(home, 'rollupRetentionDays', 0));
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let names = [];
  try { names = fs.readdirSync(dailyDir(home)); } catch (_) { return; }
  for (const n of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n);
    if (m && m[1] < cutoff) {
      try { fs.unlinkSync(path.join(dailyDir(home), n)); } catch (_) { /* best-effort */ }
    }
  }
}

function rotateIfNeeded(p, home) {
  try {
    const st = fs.statSync(p);
    if (st.size > DECISION_LOG_MAX_BYTES) {
      writeDailyRollups(home); // before the oldest generation is replaced
      shiftRotated(p, rotatedFilesSetting(home));
    }
  } catch (_) {
    // file doesn't exist yet — nothing to rotate
  }
}

function appendLog(home, entry) {
  try {
    const p = logPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfNeeded(p, home);
    fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // best-effort only — logging must never affect the decision
  }
}

// recordOutcome({id, h, outcome, source, home, project}) — best-effort,
// never throws.
// `source` ('jev'|'regex'|...) is optional and lets a caller whose block did
// NOT go through ask() (e.g. a pure regex/lexical block) still report an
// outcome that `jev report` can compare against Jev-sourced outcomes, even
// though no decision row for it exists in this log.
// `project`: same cwd-basename convention as finalize()'s decision rows (see
// defaultProject() above) — an outcome row groups by its own project field
// exactly like a decision row, so it must carry the same fallback rather
// than always landing in 'unknown' (jev-report's groupRowsBy already reads
// row.project generically; this just stops outcome rows being the one row
// shape that never had it).
function recordOutcome({ id, h, outcome, source, home, project } = {}) {
  if (!id || !h || !outcome) return;
  const entry = { ts: new Date().toISOString(), type: 'outcome', id, h, outcome };
  if (source) entry.source = source;
  entry.project = (typeof project === 'string' && project) ? project : defaultProject();
  appendLog(homeDir(home), entry);
}

// computeFinal(trust, baseline, jevBool, confident) -> the pure trust math,
// exported for tests. jevBool is already normalized to true/false/null.
function computeFinal(trust, baseline, jevBool, confident) {
  if (trust === 'add-block') {
    if (baseline === true) return true;
    return !!(confident && jevBool === true);
  }
  if (trust === 'relax-block') {
    if (baseline !== true) return baseline; // nothing to relax
    return !(confident && jevBool === false);
  }
  // advisory
  return confident ? jevBool : baseline;
}

function directionFor(trust, changed) {
  if (!changed) return null;
  if (trust === 'add-block') return 'added';
  if (trust === 'relax-block') return 'relaxed';
  return 'changed';
}

// askSyncResultMemo — in-process memo of askSync()'s underlying network/
// subprocess result (`r`), keyed by the SAME content hash prepare() computes.
// PROCESS-LIFETIME ONLY — never persisted to disk, unlike the on-disk cache
// in ~/.anti-hall/cache/jev-assist.json (which only ever stores an OK
// answer). This additionally memoizes a FAILED/unavailable result (timeout,
// no key, disabled backend, bad response) — a miss that isn't `ok:true` is
// never written to the disk cache (see askSync below), so a caller asking
// the identical text hundreds of times within one process (e.g.
// git-guard.js scanning 500 commit-creating segments with Jev enabled and no
// key configured — R6REV-P1-1) used to spawn the jevDecideSync subprocess
// fresh on every single call, ~12s for 500 segments. Keyed by hash rather
// than raw text/state so a caller using `cacheKey` still memoizes correctly.
const askSyncResultMemo = new Map();

function jevDecideSync({ question, state, timeoutMs, home }) {
  const budget = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : DEFAULT_SYNC_TIMEOUT_MS;
  try {
    const input = JSON.stringify({ question, state, timeoutMs: budget }); // jev-client scrubs outbound text
    const env = Object.assign({}, process.env);
    if (home) env.HOME = home; // propagate a test fixture HOME to the worker
    const raw = cp.execFileSync(process.execPath, [WORKER_PATH], {
      input,
      timeout: budget + 500, // hard backstop above the worker's own internal timeout
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env,
    });
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : { ok: false, reason: 'bad-response' };
  } catch (_) {
    return { ok: false, reason: 'timeout' };
  }
}

// finalize(...) — the shared post-decision path for ask()/askSync(): mode
// gating (shadow never changes the outcome), trust math, cache write, and the
// one metrics line. Never throws.
// defaultProject() -> path.basename(process.cwd()), best-effort, never throws.
// The cwd-basename convention the whole codebase already uses for anything
// project-agnostic (never an absolute path, never a repo URL/owner — see
// CLAUDE.md's "keep shipped files agnostic" rule); a jev-report reader groups
// by this value, not a resolved identity, so two different machines' checkouts
// of the same repo name group together and a renamed checkout does not.
function defaultProject() {
  try { return path.basename(process.cwd()) || 'unknown'; } catch (_) { return 'unknown'; }
}

function finalize({ id, home, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare, state, project, sessionId, turnRef, recordDisagreement }) {
  const confident = !!(r && r.ok && Number.isFinite(r.confidence) && r.confidence >= threshold);
  const jevBool = (r && r.ok)
    ? (typeof judge === 'function' ? !!judge(r.answer) : r.answer)
    : null;

  const wouldBe = (r && r.ok) ? computeFinal(trust, baseline, jevBool, confident) : baseline;
  const changed = mode === 'on' && wouldBe !== baseline;
  const final = mode === 'on' ? wouldBe : baseline;
  const direction = directionFor(trust, changed);
  // wouldChange -- the SAME trust-rule outcome computed WITHOUT the mode==='on'
  // gate above. `changed`/`direction` are null-by-construction for shadow/off
  // rows (mode gates them so a shadow row never actually changes anything),
  // which meant `jev-report.js` could never see a shadow integration's yield --
  // it read only `changed` and a shadow row's was always null, so changedRate
  // was always 0 and REMOVE fired regardless of how good Jev's shadow answers
  // actually were. This field reports what the trust rule WOULD have done had
  // mode been 'on', for every mode -- `jev-report.js` uses it for shadow rows
  // only (an 'on' row's `wouldChange` is identical to `changed` by construction,
  // so the report keeps reading `changed` there).
  // recordDisagreement (opt-in, label-only integrations such as modelRouting):
  // report a would-change whenever Jev's answer DIFFERS from the rule-based
  // verdict, regardless of confidence or mode, so an 'on' row (whose `changed`
  // is null unless Jev confidently relaxed) is still a labelable decision.
  const wouldChangeDirection = directionFor(trust, (r && r.ok)
    ? (recordDisagreement ? (jevBool !== baseline) : (wouldBe !== baseline))
    : false);

  const backend = !r ? 'baseline-only' : (cachedFlag ? 'cache' : (r.ok ? 'jev' : 'baseline-only'));
  const { costUsd, costSource } = r ? computeCostUsd({ r, cachedFlag, home }) : { costUsd: null, costSource: null };

  const entry = {
    ts: new Date().toISOString(),
    id,
    h: hash,
    base: baseline,
    jev: (r && r.ok) ? r.answer : null,
    conf: (r && r.ok && Number.isFinite(r.confidence)) ? r.confidence : null,
    ms: (r && Number.isFinite(r.ms)) ? r.ms : 0,
    backend,
    final,
    changed: direction,
    // wouldChange: only written when it differs in meaning from `changed`
    // (mode !== 'on') -- an 'on' row's value would just duplicate `changed`,
    // and older/other readers never expect this field at all.
    ...((mode !== 'on' || recordDisagreement) ? { wouldChange: wouldChangeDirection } : {}),
    cached: !!cachedFlag,
    mode,
    // project: always populated (cwd-basename fallback, `jev report --by
    // project`); sessionId: only when the caller actually has one to thread
    // through (not every integration is session-scoped, e.g.
    // devswarm-supervisor.js's background sweep) -- omitted (not `null`)
    // when absent, matching every other optional field's convention here.
    // `jev report`'s groupKeyOf treats a missing value as 'unknown' either way.
    project: (typeof project === 'string' && project) ? project : defaultProject(),
  };
  if (typeof sessionId === 'string' && sessionId) entry.sessionId = sessionId;
  // turnRef: a short, caller-supplied pointer to WHICH turn this decision was
  // about (e.g. the ts of the last assistant message the caller judged, or a
  // transcript line count) — see turnRefFromTranscript() below. Optional,
  // same omitted-not-null convention as sessionId/compare.
  if (typeof turnRef === 'string' && turnRef) entry.turnRef = turnRef;
  if (r && !r.ok && r.reason) entry.reason = r.reason;
  // transport: which vendor served (or last failed) a FRESH call; fellBack:
  // true when the fallback transport answered after the primary failed. Both
  // omitted for cache hits / skipped calls (no network call happened).
  if (r && !cachedFlag && (r.transport === 'vercel' || r.transport === 'typesafe')) entry.transport = r.transport;
  if (r && !cachedFlag && r.fellBack === true) entry.fellBack = true;
  // costUsd/costSource are only written when a decision was actually
  // evaluated (r truthy) -- an 'off'/skipped call logs no cost fields at
  // all, matching how it already logs no jev/conf. See computeCostUsd above.
  if (r) {
    entry.costUsd = costUsd;
    entry.costSource = costSource;
    if (Number.isFinite(r.tokensIn)) entry.tokensIn = r.tokensIn;
    if (Number.isFinite(r.tokensOut)) entry.tokensOut = r.tokensOut;
  }
  // `compare` is an OPTIONAL, caller-supplied independent verdict (e.g. a
  // regex/lexical heuristic run alongside Jev) for jev-report's agreement
  // metric -- distinct from `base`, which is trust-rule math (often a
  // hardcoded constant, e.g. speculation-guard's add-block baseline of
  // `false`) and must never be read as "the real baseline verdict". Only
  // written when the caller actually passes a boolean; omitted otherwise so
  // older/other callers' rows are unaffected.
  if (typeof compare === 'boolean') entry.compare = compare;
  // Budget watch: best-effort, only touches disk when watch mode is on, and
  // never affects `final`/`entry` above -- see maybeWarnBudget's own comment.
  if (r) maybeWarnBudget({ home, costUsd });
  // Audit snippet: opt-in, off by default, for a changed OR would-change
  // decision -- see maybeWriteAuditSnippet's own comment.
  maybeWriteAuditSnippet({ home, id, hash, state, changed: direction, wouldChange: wouldChangeDirection });
  appendLog(home, entry);

  return {
    final,
    jev: (r && r.ok) ? r.answer : null,
    baseline,
    confidence: (r && r.ok) ? r.confidence : null,
    confident: (r && r.ok) ? confident : null,
    ms: (r && Number.isFinite(r.ms)) ? r.ms : 0,
    backend,
    reason: (r && !r.ok) ? r.reason : undefined,
    h: hash,
    costUsd,
    costSource,
  };
}

// Shared prep: resolve mode/hash/threshold/cache once for both ask/askSync.
// Returns null via the `skip` field when there is nothing to do (off, or
// relax-block with a non-blocking baseline) — callers still get a full
// baseline-only result in that case, without ever touching the network.
function prepare({ id, home, trust, baseline, cacheKey, state }) {
  const h = homeDir(home);
  const fileCfg = readJevJson(h);
  const mode = getMode(id, fileCfg, h);
  const hash = contentHash([id, QUESTION_VERSION, cacheKey != null ? String(cacheKey) : String(state)]);

  const cfg = loadJevConfig();
  const threshold = (Number.isFinite(fileCfg.confidenceThreshold) &&
    fileCfg.confidenceThreshold >= 0 && fileCfg.confidenceThreshold <= 1)
    ? fileCfg.confidenceThreshold
    : cfg.confidenceThreshold;

  // Nothing to consult Jev for: mode off, or relax-block guarding a baseline
  // that isn't blocking in the first place.
  const skip = (mode === 'off') || (trust === 'relax-block' && baseline !== true);

  return { h, mode, hash, threshold, skip };
}

// ask({id, question, state, trust, baseline, judge, cacheKey, budgetMs, home})
//   -> Promise<{final, jev, baseline, confidence, ms, backend, h}>
async function ask(opts = {}) {
  const { id, question, state, trust, baseline, judge, cacheKey, budgetMs, home, compare, project, sessionId, turnRef, recordDisagreement } = opts;
  const { h, mode, hash, threshold, skip } = prepare({ id, home, trust, baseline, cacheKey, state });

  if (skip) {
    return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r: null, cachedFlag: false, compare, state, project, sessionId, turnRef, recordDisagreement });
  }

  const cache = readCache(h);
  const cached = cache[hash];
  let r; let cachedFlag = false;
  if (cached) {
    r = { ok: true, answer: cached.answer, confidence: cached.confidence, ms: 0 };
    cachedFlag = true;
  } else {
    try {
      r = await jevDecide({ question, state, timeoutMs: budgetMs }); // jev-client scrubs outbound text
    } catch (_) {
      r = { ok: false, reason: 'error' };
    }
    if (r.ok) {
      writeCache(h, Object.assign({}, cache, {
        [hash]: { answer: r.answer, confidence: r.confidence, _seq: nextCacheSeq(cache) },
      }));
    }
  }

  return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare, state, project, sessionId, turnRef, recordDisagreement });
}

// askSync(...) — same contract as ask(), but fully synchronous: the network
// call runs in a subprocess (jev-assist-worker.js) with its OWN hard
// `timeout`, spawned via execFileSync, the same pattern jev-triage.js already
// uses. For callers (e.g. model-routing-guard) whose main() is synchronous
// and cannot await.
function askSync(opts = {}) {
  const { id, question, state, trust, baseline, judge, cacheKey, budgetMs, home, compare, project, sessionId, turnRef, recordDisagreement } = opts;
  const { h, mode, hash, threshold, skip } = prepare({ id, home, trust, baseline, cacheKey, state });

  if (skip) {
    return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r: null, cachedFlag: false, compare, state, project, sessionId, turnRef, recordDisagreement });
  }

  let r; let cachedFlag = false;
  if (askSyncResultMemo.has(hash)) {
    // Repeated identical ask WITHIN this process (see askSyncResultMemo's
    // doc comment). An earlier ok:true result behaves exactly like a disk
    // cache hit (no new inference, cost $0); a memoized FAILURE just skips
    // re-spawning the subprocess — it is still reported as `baseline-only`,
    // never as `cache`, since no answer was actually cached for it.
    r = askSyncResultMemo.get(hash);
    cachedFlag = !!(r && r.ok);
  } else {
    const cache = readCache(h);
    const cached = cache[hash];
    if (cached) {
      r = { ok: true, answer: cached.answer, confidence: cached.confidence, ms: 0 };
      cachedFlag = true;
    } else {
      r = jevDecideSync({ question, state, timeoutMs: budgetMs, home: h });
      if (r.ok) {
        writeCache(h, Object.assign({}, cache, {
          [hash]: { answer: r.answer, confidence: r.confidence, _seq: nextCacheSeq(cache) },
        }));
      }
    }
    askSyncResultMemo.set(hash, r);
  }

  return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare, state, project, sessionId, turnRef, recordDisagreement });
}

// askDetached(opts) — fire-and-forget variant for callers on the user's
// CRITICAL PATH (UserPromptSubmit, PostToolUse) that must add ZERO latency.
// Spawns jev-assist-detached-worker.js DETACHED (own process group), pipes
// the (JSON-serializable) opts to its stdin, ignores its stdout/stderr, and
// unref()s it immediately — this function returns synchronously without
// ever waiting on the network call or even on the child starting up. The
// worker performs the FULL ask() flow itself (mode/cache/trust/log) in its
// own process, so a decision row still lands in jev-assist.ndjson exactly as
// it would for ask()/askSync() — this caller just never sees the result.
//
// LIMIT: `judge` (a function) cannot cross the stdin JSON boundary, so
// callers needing custom answer normalization must use ask()/askSync()
// instead. Every other option (id, question, state, trust, baseline,
// cacheKey, budgetMs, home) works exactly as documented above.
//
// Never throws; a spawn failure is swallowed (best-effort, matches every
// other I/O path in this file).
function askDetached(opts = {}) {
  try {
    const { id, question, state, trust, baseline, cacheKey, budgetMs, home, compare, project, sessionId, turnRef } = opts;
    // Check the integration mode BEFORE spawning — an 'off' integration (or
    // Jev disabled entirely, or a relax-block guard on a non-blocking
    // baseline) must cost this caller a single sync config read, never a
    // process spawn. Same skip logic ask()/askSync() use via prepare(); the
    // decision row still lands (every ask()/askSync()/askDetached() call
    // always logs, matching finalize()'s contract for call-volume/failure-
    // rate tracking) — written synchronously here since there's no network
    // call to wait on either way, so a spawn would only add overhead.
    const { h, mode, hash, threshold, skip } = prepare({ id, home, trust, baseline, cacheKey, state });
    if (skip) {
      finalize({ id, home: h, hash, mode, trust, baseline, judge: null, threshold, r: null, cachedFlag: false, compare, state, project, sessionId, turnRef });
      return;
    }
    let detachedBudgetMs = DETACHED_DEFAULT_BUDGET_MS;
    if (Number.isFinite(budgetMs) && budgetMs > 0) detachedBudgetMs = budgetMs;
    else {
      const cfgTimeout = loadJevConfig().timeoutMs;
      if (cfgTimeout !== DEFAULT_TIMEOUT_MS) detachedBudgetMs = cfgTimeout;
    }
    const input = JSON.stringify({ id, question, state, trust, baseline, cacheKey, budgetMs: detachedBudgetMs, home, compare, project, sessionId, turnRef });
    const child = cp.spawn(process.execPath, [DETACHED_WORKER_PATH], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
    });
    // A spawn failure surfaces as an 'error' event, not a throw — swallow it
    // so a broken/missing node binary can never crash the caller's hook.
    child.on('error', () => {});
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch (_) { /* best-effort */ }
    child.unref();
  } catch (_) {
    // best-effort only — this path must never affect the caller's own hook.
  }
}

// consultRelax(opts) -> the askSync decision when the integration is `on`,
// else null (after logging via askDetached, zero latency). For a relax-block
// consult inside a hook that is ABOUT to nudge/block: `on` asks synchronously
// with a hard cap (budgetMs <= 1500) so the answer can actually change the
// outcome; a timeout/failure falls back to the baseline (fail-open to
// today's verdict). shadow/off never wait on the network.
const RELAX_SYNC_CAP_MS = 1500;
function consultRelax(opts) {
  const o = opts || {};
  try {
    const h = homeDir(o.home);
    if (getMode(o.id, readJevJson(h), h) !== 'on') { askDetached(o); return null; }
    const budgetMs = Math.min(Number.isFinite(o.budgetMs) ? o.budgetMs : RELAX_SYNC_CAP_MS, RELAX_SYNC_CAP_MS);
    return askSync(Object.assign({}, o, { budgetMs }));
  } catch (_) { return null; }
}

// speculationBackend(home) -> {backend:'jev'|'api'|'lexical', apiJudgeFlag, jevMode}.
// WHO is the semantic speculation judge right now, mirroring the real hooks:
// Jev enabled + integration "speculation" on -> speculation-guard asks Jev and
// speculation-judge.js (the paid API judge) exits early; otherwise the API judge
// when jev.semanticJudge is true; otherwise lexical speculation-guard only.
// Does not check that a key resolves. Never throws.
function speculationBackend(home) {
  let jevMode = 'off';
  let apiJudgeFlag = false;
  try { jevMode = getMode('speculation', readJevJson(home), home); } catch (_) { /* off */ }
  try { apiJudgeFlag = require('./settings.js').get('jev', 'semanticJudge', false, { home: homeDir(home) }) === true; } catch (_) { /* off */ }
  const backend = jevMode === 'on' ? 'jev' : (apiJudgeFlag ? 'api' : 'lexical');
  return { backend, apiJudgeFlag, jevMode };
}

module.exports = {
  ask,
  askSync,
  askDetached,
  consultRelax,
  turnRefFromTranscript,
  speculationBackend,
  RELAX_SYNC_CAP_MS,
  // finalize is exported for the small set of callers that already HAVE a
  // Jev answer from a cache another feature populated (e.g. jev-triage.js's
  // own confidence-gated kind/urgency cache) and want the SAME mode-gating +
  // trust-math + metrics-logging machinery ask()/askSync() use, WITHOUT
  // spawning a second, redundant network call — see devswarm-parent-gate.js's
  // and devswarm-supervisor.js's `parentGateQuestion`/`supervisorBlockerLabel`
  // integrations. Callers pass a fully-formed `r` ({ok:true, answer,
  // confidence, ms}) and `cachedFlag:true` (this IS a cache hit, by
  // definition — the classification already happened elsewhere) so the
  // logged `backend` reads 'cache', never 'jev', and no cost is ever
  // attributed to a call that made no network request.
  finalize,
  // prepare resolves {mode, hash, threshold, skip} — the same pre-flight a
  // finalize() caller (above) needs so it never has to reimplement
  // getMode()/contentHash()/confidenceThreshold resolution itself.
  prepare,
  recordOutcome,
  readJevJson,
  getMode,
  envNameFor,
  computeFinal,
  computeCostUsd,
  readBudgetConfig,
  budgetStatePath,
  maybeWarnBudget,
  readAuditConfig,
  scrubSecrets,
  auditLogPath,
  maybeWriteAuditSnippet,
  cachePath,
  logPath,
  dailyDir,
  retainedLogFiles,
  readNdjsonFiles,
  shiftRotated,
  rotatedFilesSetting,
  buildDailyRollups,
  writeDailyRollups,
  CACHE_MAX_ENTRIES,
  DECISION_LOG_MAX_BYTES,
};
