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
// LOG: ~/.anti-hall/logs/jev-assist.ndjson, rotated at 1MB (keeps one .1
// backup). One line per ask()/askSync() call:
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
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { jevDecide, loadJevConfig } = require('./jev-client.js');

const CACHE_MAX_ENTRIES = 500;
const LOG_MAX_BYTES = 1024 * 1024; // 1MB, one rotated backup kept (.1)
const QUESTION_VERSION = 'v1';
const WORKER_PATH = path.join(__dirname, 'jev-assist-worker.js');
const DETACHED_WORKER_PATH = path.join(__dirname, 'jev-assist-detached-worker.js');
const DEFAULT_SYNC_TIMEOUT_MS = 1500;

// Integrations that predate the per-integration modes map and must keep
// their current ("Jev fully trusted") behavior with zero jev.json changes.
const LEGACY_ON_DEFAULT = new Set(['speculation', 'triage']);

function homeDir(home) {
  return (typeof home === 'string' && home) ? home : os.homedir();
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
// Every one of the 12 0.108.4 integration ids has its own settings-schema
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
function getMode(id, fileCfg, home) {
  const cfg = fileCfg || {};
  let jevEnabled = cfg.enabled === true || process.env.ANTIHALL_JEV === '1';
  if (process.env.ANTIHALL_JEV === '0') jevEnabled = false;
  if (!jevEnabled) return 'off';

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

// scrubSecrets(text) -> text with common secret shapes replaced by a
// bracketed placeholder. Best-effort, not a security boundary by itself --
// combined with the 200-char cap and the opt-in default, it bounds what a
// snippet can leak. Order matters: named shapes (Bearer tokens, known key
// prefixes, key=/token= assignments, emails) are scrubbed BEFORE the generic
// long-alnum-run catch-all, so their placeholders (short) never re-trigger it.
function scrubSecrets(text) {
  if (typeof text !== 'string') return '';
  let s = text;
  // PEM blocks first (multi-line): header, body and footer all go.
  s = s.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[REDACTED_PEM]');
  // URL credentials: scheme://user:pass@host -> scheme://[REDACTED]@host
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  // JWTs (three base64url segments, first starts with eyJ).
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9\-_.=]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/\b(sk|pk)-[A-Za-z0-9]{10,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, '[REDACTED_KEY]');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_KEY]');
  // AWS access key ids (long-term AKIA, temporary ASIA).
  s = s.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  // Any identifier CONTAINING secret/password/passwd/token/apikey/api_key/key,
  // then optional spaces and ':' or '=' — AWS_SECRET_ACCESS_KEY=…,
  // DB_PASSWORD=short, "apiKey": "…". Values of any length (>=1 char).
  s = s.replace(/\b([A-Za-z0-9_.-]*(?:secret|password|passwd|token|apikey|api_key|key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)[^\s"',}]+\3/gi, '$1$2[REDACTED]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  // Generic catch-all: any remaining long base64/hex-ish run (>=32 chars) is
  // treated as a likely token/credential fragment, whatever it actually is.
  s = s.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[REDACTED_TOKEN]');
  return s;
}

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
function maybeWriteAuditSnippet({ home, id, hash, state, changed, wouldChange }) {
  try {
    const trigger = changed || wouldChange;
    if (!trigger || typeof state !== 'string' || !state) return;
    if (!readAuditConfig(home).snippets) return;
    const scrubbed = scrubSecrets(state.slice(0, 2000));
    const snippet = scrubbed.slice(0, 200);
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

let cacheSeq = 0;
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

function rotateIfNeeded(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > LOG_MAX_BYTES) {
      const old = p + '.1';
      try { fs.rmSync(old, { force: true }); } catch (_) { /* no prior backup */ }
      fs.renameSync(p, old);
    }
  } catch (_) {
    // file doesn't exist yet — nothing to rotate
  }
}

function appendLog(home, entry) {
  try {
    const p = logPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfNeeded(p);
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

function jevDecideSync({ question, state, timeoutMs, home }) {
  const budget = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : DEFAULT_SYNC_TIMEOUT_MS;
  try {
    const input = JSON.stringify({ question, state, timeoutMs: budget });
    const env = Object.assign({}, process.env);
    if (home) env.HOME = home; // propagate a test fixture HOME to the worker
    const raw = execFileSync(process.execPath, [WORKER_PATH], {
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

function finalize({ id, home, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare, state, project, sessionId }) {
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
  const wouldChangeDirection = directionFor(trust, (r && r.ok) ? (wouldBe !== baseline) : false);

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
    ...(mode !== 'on' ? { wouldChange: wouldChangeDirection } : {}),
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
  if (r && !r.ok && r.reason) entry.reason = r.reason;
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
  const { id, question, state, trust, baseline, judge, cacheKey, budgetMs, home, compare, project, sessionId } = opts;
  const { h, mode, hash, threshold, skip } = prepare({ id, home, trust, baseline, cacheKey, state });

  if (skip) {
    return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r: null, cachedFlag: false, compare, state, project, sessionId });
  }

  const cache = readCache(h);
  const cached = cache[hash];
  let r; let cachedFlag = false;
  if (cached) {
    r = { ok: true, answer: cached.answer, confidence: cached.confidence, ms: 0 };
    cachedFlag = true;
  } else {
    try {
      r = await jevDecide({ question, state, timeoutMs: budgetMs });
    } catch (_) {
      r = { ok: false, reason: 'error' };
    }
    if (r.ok) {
      writeCache(h, Object.assign({}, cache, {
        [hash]: { answer: r.answer, confidence: r.confidence, _seq: ++cacheSeq },
      }));
    }
  }

  return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare, state, project, sessionId });
}

// askSync(...) — same contract as ask(), but fully synchronous: the network
// call runs in a subprocess (jev-assist-worker.js) with its OWN hard
// `timeout`, spawned via execFileSync, the same pattern jev-triage.js already
// uses. For callers (e.g. model-routing-guard) whose main() is synchronous
// and cannot await.
function askSync(opts = {}) {
  const { id, question, state, trust, baseline, judge, cacheKey, budgetMs, home, compare, project, sessionId } = opts;
  const { h, mode, hash, threshold, skip } = prepare({ id, home, trust, baseline, cacheKey, state });

  if (skip) {
    return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r: null, cachedFlag: false, compare, state, project, sessionId });
  }

  const cache = readCache(h);
  const cached = cache[hash];
  let r; let cachedFlag = false;
  if (cached) {
    r = { ok: true, answer: cached.answer, confidence: cached.confidence, ms: 0 };
    cachedFlag = true;
  } else {
    r = jevDecideSync({ question, state, timeoutMs: budgetMs, home: h });
    if (r.ok) {
      writeCache(h, Object.assign({}, cache, {
        [hash]: { answer: r.answer, confidence: r.confidence, _seq: ++cacheSeq },
      }));
    }
  }

  return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare, state, project, sessionId });
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
    const { id, question, state, trust, baseline, cacheKey, budgetMs, home, compare, project, sessionId } = opts;
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
      finalize({ id, home: h, hash, mode, trust, baseline, judge: null, threshold, r: null, cachedFlag: false, compare, state, project, sessionId });
      return;
    }
    const input = JSON.stringify({ id, question, state, trust, baseline, cacheKey, budgetMs, home, compare, project, sessionId });
    const child = spawn(process.execPath, [DETACHED_WORKER_PATH], {
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

module.exports = {
  ask,
  askSync,
  askDetached,
  consultRelax,
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
  CACHE_MAX_ENTRIES,
};
