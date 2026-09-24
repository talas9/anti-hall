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
//     "costPerCall": 0.0004                    // optional, consumed by jev-report
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
//    reason?, compare?}
//   changed is 'added' | 'relaxed' | null. No message bodies, no credentials.
//   `compare` (optional, boolean) is a caller-supplied INDEPENDENT verdict
//   (e.g. a regex/lexical heuristic evaluated alongside Jev) used ONLY by
//   `jev report`'s agreement metric. It is separate from `base`, which is
//   trust-rule math and, for some callers (e.g. speculation-guard's
//   add-block baseline), a hardcoded constant rather than a real verdict --
//   comparing `jev` against `base` there is NOT a measure of agreement.
//
// recordOutcome({id, h, outcome}) appends a second line shape
//   {ts, type:'outcome', id, h, outcome} so `jev report` can join a later
//   observed result (e.g. 'evidence-added', 'user-override') back to the
//   decision by hash.

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
function getMode(id, fileCfg) {
  const cfg = fileCfg || {};
  let jevEnabled = cfg.enabled === true || process.env.ANTIHALL_JEV === '1';
  if (process.env.ANTIHALL_JEV === '0') jevEnabled = false;
  if (!jevEnabled) return 'off';

  if (process.env[envNameFor(id)] === '0') return 'off';

  const integrations = (cfg.integrations && typeof cfg.integrations === 'object' &&
    !Array.isArray(cfg.integrations)) ? cfg.integrations : {};
  const value = integrations[id];

  // Legacy pre-integrations-map switch: {"triage": false} alone still
  // disables triage when the new map says nothing about it.
  if (id === 'triage' && value === undefined && cfg.triage === false) return 'off';

  if (value === 'on' || value === 'shadow' || value === 'off') return value;

  return LEGACY_ON_DEFAULT.has(id) ? 'on' : 'shadow';
}

function contentHash(parts) {
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16);
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

// recordOutcome({id, h, outcome, source, home}) — best-effort, never throws.
// `source` ('jev'|'regex'|...) is optional and lets a caller whose block did
// NOT go through ask() (e.g. a pure regex/lexical block) still report an
// outcome that `jev report` can compare against Jev-sourced outcomes, even
// though no decision row for it exists in this log.
function recordOutcome({ id, h, outcome, source, home } = {}) {
  if (!id || !h || !outcome) return;
  const entry = { ts: new Date().toISOString(), type: 'outcome', id, h, outcome };
  if (source) entry.source = source;
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
function finalize({ id, home, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare }) {
  const confident = !!(r && r.ok && Number.isFinite(r.confidence) && r.confidence >= threshold);
  const jevBool = (r && r.ok)
    ? (typeof judge === 'function' ? !!judge(r.answer) : r.answer)
    : null;

  const wouldBe = (r && r.ok) ? computeFinal(trust, baseline, jevBool, confident) : baseline;
  const changed = mode === 'on' && wouldBe !== baseline;
  const final = mode === 'on' ? wouldBe : baseline;
  const direction = directionFor(trust, changed);

  const backend = !r ? 'baseline-only' : (cachedFlag ? 'cache' : (r.ok ? 'jev' : 'baseline-only'));

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
    cached: !!cachedFlag,
    mode,
  };
  if (r && !r.ok && r.reason) entry.reason = r.reason;
  // `compare` is an OPTIONAL, caller-supplied independent verdict (e.g. a
  // regex/lexical heuristic run alongside Jev) for jev-report's agreement
  // metric -- distinct from `base`, which is trust-rule math (often a
  // hardcoded constant, e.g. speculation-guard's add-block baseline of
  // `false`) and must never be read as "the real baseline verdict". Only
  // written when the caller actually passes a boolean; omitted otherwise so
  // older/other callers' rows are unaffected.
  if (typeof compare === 'boolean') entry.compare = compare;
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
  };
}

// Shared prep: resolve mode/hash/threshold/cache once for both ask/askSync.
// Returns null via the `skip` field when there is nothing to do (off, or
// relax-block with a non-blocking baseline) — callers still get a full
// baseline-only result in that case, without ever touching the network.
function prepare({ id, home, trust, baseline, cacheKey, state }) {
  const h = homeDir(home);
  const fileCfg = readJevJson(h);
  const mode = getMode(id, fileCfg);
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
  const { id, question, state, trust, baseline, judge, cacheKey, budgetMs, home, compare } = opts;
  const { h, mode, hash, threshold, skip } = prepare({ id, home, trust, baseline, cacheKey, state });

  if (skip) {
    return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r: null, cachedFlag: false, compare });
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

  return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare });
}

// askSync(...) — same contract as ask(), but fully synchronous: the network
// call runs in a subprocess (jev-assist-worker.js) with its OWN hard
// `timeout`, spawned via execFileSync, the same pattern jev-triage.js already
// uses. For callers (e.g. model-routing-guard) whose main() is synchronous
// and cannot await.
function askSync(opts = {}) {
  const { id, question, state, trust, baseline, judge, cacheKey, budgetMs, home, compare } = opts;
  const { h, mode, hash, threshold, skip } = prepare({ id, home, trust, baseline, cacheKey, state });

  if (skip) {
    return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r: null, cachedFlag: false, compare });
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

  return finalize({ id, home: h, hash, mode, trust, baseline, judge, threshold, r, cachedFlag, compare });
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
    const { id, question, state, trust, baseline, cacheKey, budgetMs, home, compare } = opts;
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
      finalize({ id, home: h, hash, mode, trust, baseline, judge: null, threshold, r: null, cachedFlag: false, compare });
      return;
    }
    const input = JSON.stringify({ id, question, state, trust, baseline, cacheKey, budgetMs, home, compare });
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

module.exports = {
  ask,
  askSync,
  askDetached,
  recordOutcome,
  getMode,
  envNameFor,
  computeFinal,
  cachePath,
  logPath,
  CACHE_MAX_ENTRIES,
};
