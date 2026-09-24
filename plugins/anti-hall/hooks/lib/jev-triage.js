'use strict';
// jev-triage.js — ADVISORY-ONLY mesh message triage (urgency + kind labels).
//
// Attaches a per-message triage label (urgency: urgent|normal; kind:
// question-needs-answer|blocker|status-report|done-report|fyi) to messages
// rendered for the agent — the DevSwarm broadcast/roster feed
// (hooks/devswarm-parent-inbox.js buildBroadcastSegment) and the
// `inbox messages`/`read-primary`/`peek-primary` CLI output
// (scripts/devswarm.js cmdInboxMessagesInner).
//
// HARD CONTRACT — labels are ADVISORY ONLY:
//   - Never suppress, hide, reorder-away, delay, or ack a message.
//   - Never change any Stop-gate block decision or unread count.
//   - A message with no label renders EXACTLY as today.
//   - Disabled (the default) -> triageMessagesSync returns an empty Map
//     IMMEDIATELY, before touching fs/network/any subprocess. Output is
//     byte-identical to pre-triage behavior.
//
// GATING: same ~/.anti-hall/jev.json switch as jev-client.js's `enabled`,
// PLUS a triage-specific `"triage"` key (default true once jev is enabled;
// `"triage": false` turns triage off while leaving other Jev consumers, e.g.
// speculation-judge, untouched).
//
// WHY A SUBPROCESS: jev-client.js's jevDecide/jevDecideMulti are async
// (fetch-based). Both call sites here (scripts/devswarm.js, ~16k lines, and
// hooks/devswarm-parent-inbox.js) have long-established fully SYNCHRONOUS
// main()s with a large existing test surface; making either async is a much
// bigger, riskier diff than this advisory feature justifies. Instead, the
// actual network I/O runs in jev-triage-worker.js, spawned via
// execFileSync with its OWN hard `timeout` — that timeout IS the "never
// block the hook" budget: if the worker hangs, it is killed and this
// function returns whatever it already had (cache hits only), never
// throwing past this module.
//
// CACHE: ~/.anti-hall/cache/jev-triage.json, keyed by a content hash of each
// message's text — classified once, not every turn. Bounded to
// MAX_CACHE_ENTRIES; oldest entries (by insertion) are evicted first.
//
// LOG: ~/.anti-hall/logs/jev-triage.ndjson, rotated at ~1MB. One line per
// newly-classified message: hash + labels + backend + ms. NEVER the message
// body, NEVER a credential.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const WORKER_PATH = path.join(__dirname, 'jev-triage-worker.js');
const DEFAULT_BUDGET_MS = 2000;
const DEFAULT_URGENT_THRESHOLD = 0.9;
const MAX_CACHE_ENTRIES = 500;
const CACHE_LOG_MAX_BYTES = 1024 * 1024;

function homeDir(home) {
  return (typeof home === 'string' && home) ? home : os.homedir();
}

function jevConfigPath(home) {
  return path.join(homeDir(home), '.anti-hall', 'jev.json');
}

function cachePath(home) {
  return path.join(homeDir(home), '.anti-hall', 'cache', 'jev-triage.json');
}

function logPath(home) {
  return path.join(homeDir(home), '.anti-hall', 'logs', 'jev-triage.ndjson');
}

// loadTriageConfig(home) -> {enabled, triageEnabled, confidenceThreshold,
//   urgentThreshold, timeoutMs, budgetMs}. Never throws; a missing/malformed
// jev.json degrades to fully disabled (matches jev-client.js's own contract).
function loadTriageConfig(home) {
  let fileCfg = {};
  try {
    const raw = fs.readFileSync(jevConfigPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileCfg = parsed;
  } catch (_) {
    fileCfg = {};
  }
  // v0.108.0 unified settings: ~/.anti-hall/settings.json's jev.* values win
  // over jev.json's own fields when present (jev.json is never deleted/
  // written to, only read as a fallback — see hooks/lib/settings.js).
  let settingsCfg = {};
  try {
    settingsCfg = require('./settings.js').load({ home }).jev || {};
  } catch (_) { /* settings.js unavailable/corrupt -> fall back to jev.json only */ }
  const cfg = Object.assign({}, fileCfg, settingsCfg);

  let jevEnabled = cfg.enabled === true || process.env.ANTIHALL_JEV === '1';
  if (process.env.ANTIHALL_JEV === '0') jevEnabled = false;

  // triage defaults to true once Jev itself is enabled; an explicit
  // `"triage": false` opts a jev.json-enabled user out of THIS feature only.
  const triageEnabled = jevEnabled && cfg.triage !== false;

  const confidenceThreshold = (Number.isFinite(cfg.confidenceThreshold) &&
    cfg.confidenceThreshold >= 0 && cfg.confidenceThreshold <= 1)
    ? cfg.confidenceThreshold : 0.85;

  const urgentThreshold = (Number.isFinite(cfg.triageUrgentThreshold) &&
    cfg.triageUrgentThreshold >= 0 && cfg.triageUrgentThreshold <= 1)
    ? cfg.triageUrgentThreshold : DEFAULT_URGENT_THRESHOLD;

  const timeoutMs = (Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0)
    ? cfg.timeoutMs : 1500;

  const budgetMs = (Number.isFinite(cfg.triageBudgetMs) && cfg.triageBudgetMs > 0)
    ? cfg.triageBudgetMs : DEFAULT_BUDGET_MS;

  return { enabled: triageEnabled, confidenceThreshold, urgentThreshold, timeoutMs, budgetMs };
}

function hashMessage(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
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

// writeCache — bounded to MAX_CACHE_ENTRIES, evicting the OLDEST entries by
// insertion order (`_seq`, a monotonically increasing counter stamped at
// write time) once over the cap. Best-effort; a write failure never throws.
function writeCache(home, cache) {
  try {
    const entries = Object.entries(cache);
    let bounded = cache;
    if (entries.length > MAX_CACHE_ENTRIES) {
      entries.sort((a, b) => (a[1] && a[1]._seq || 0) - (b[1] && b[1]._seq || 0));
      const keep = entries.slice(entries.length - MAX_CACHE_ENTRIES);
      bounded = {};
      for (const [k, v] of keep) bounded[k] = v;
    }
    const dir = path.dirname(cachePath(home));
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: concurrent hooks/CLI calls (a Primary's own turn plus a
    // sibling child, both triaging at once) each write a PID-unique tmp file,
    // then rename() over the shared target — rename is atomic on POSIX/NTFS,
    // so a reader never observes a partially-written (torn) JSON file. Two
    // concurrent writers still race on WHICH one's rename lands last (whole-
    // file last-write-wins), never on a corrupt merge — acceptable for a
    // best-effort advisory cache.
    const tmpPath = cachePath(home) + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(bounded), 'utf8');
    fs.renameSync(tmpPath, cachePath(home));
  } catch (_) {
    // best-effort only — a cache write failure must never break triage.
  }
}

function appendTriageLog(home, entry) {
  try {
    const dir = path.dirname(logPath(home));
    fs.mkdirSync(dir, { recursive: true });
    const p = logPath(home);
    try {
      const st = fs.statSync(p);
      if (st.size > CACHE_LOG_MAX_BYTES) fs.writeFileSync(p, '', 'utf8');
    } catch (_) {
      // no existing file — fine, created below.
    }
    fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // best-effort only.
  }
}

let cacheSeqCounter = 0;

// triageMessagesSync(items, opts) -> Map<key, {urgency?, kind?}>
//   items: [{key, text}] — `key` is the caller's own identity for the message
//     (e.g. a seq/hash it already has); `text` is the message body used ONLY
//     to compute a content hash + (if not cached) as the classifier input.
//   opts: {home} — test-only HOME override; everything else comes from
//     jev.json / env, matching jev-client.js's own convention.
//
// Returns an EMPTY Map immediately (no fs/network/subprocess) when triage is
// disabled — the default. Never throws.
function triageMessagesSync(items, opts) {
  const results = new Map();
  if (!Array.isArray(items) || items.length === 0) return results;

  // SAFETY: `home` must be an EXPLICIT non-empty string from the caller. Every
  // real call site (scripts/devswarm.js's `ctx.home`, hooks/devswarm-parent-
  // inbox.js's `os.homedir()` computed once in main()) already passes one. A
  // caller that omits it (e.g. a unit test exercising an unrelated code path)
  // gets the disabled fast path with ZERO fs access — this function never
  // silently falls back to the REAL process home. Without this guard, any
  // test in this repo that reaches this function without passing a fixture
  // home would read the ACTUAL developer machine's ~/.anti-hall/jev.json —
  // and, if that machine has ever enabled Jev for manual testing, would fire
  // REAL network calls with a REAL credential from an ordinary unit test run.
  const home = opts && opts.home;
  if (typeof home !== 'string' || !home) return results;

  let cfg;
  try {
    cfg = loadTriageConfig(home);
  } catch (_) {
    return results; // fail-open: config unreadable -> no labels, no cost
  }
  if (!cfg.enabled) return results; // BYTE-IDENTICAL fast path: the default.

  let cache;
  try {
    cache = readCache(home);
  } catch (_) {
    cache = {};
  }

  const hashed = items
    .filter((it) => it && typeof it.text === 'string' && it.text.trim())
    .map((it) => ({ key: it.key, hash: hashMessage(it.text), text: it.text }));

  const uncached = [];
  for (const it of hashed) {
    const cached = cache[it.hash];
    if (cached && (cached.urgency || cached.kind)) {
      results.set(it.key, { urgency: cached.urgency, kind: cached.kind });
    } else if (!cached) {
      uncached.push(it);
    }
    // a cached entry with neither field is a prior "no label" verdict —
    // honored as-is (no re-classification, matches "classified once").
  }

  if (uncached.length === 0) return results;

  let workerOut = null;
  try {
    const input = JSON.stringify({
      items: uncached.map((it) => ({ hash: it.hash, text: it.text })),
      timeoutMs: cfg.budgetMs,
      urgentThreshold: cfg.urgentThreshold,
    });
    const raw = execFileSync(process.execPath, [WORKER_PATH], {
      input,
      timeout: cfg.budgetMs + 500, // hard backstop above the worker's own internal budget
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    workerOut = JSON.parse(raw);
  } catch (_) {
    // timeout, non-zero exit, unparsable output — fail-open: no new labels
    // this turn, but cache hits above are still returned.
    workerOut = null;
  }

  if (workerOut && typeof workerOut === 'object') {
    const newCacheEntries = {};
    for (const it of uncached) {
      const label = workerOut[it.hash];
      if (label && (label.urgency || label.kind)) {
        results.set(it.key, { urgency: label.urgency, kind: label.kind });
        newCacheEntries[it.hash] = {
          urgency: label.urgency || undefined,
          kind: label.kind || undefined,
          _seq: ++cacheSeqCounter,
        };
        appendTriageLog(home, {
          ts: new Date().toISOString(),
          hash: it.hash,
          urgency: label.urgency || null,
          kind: label.kind || null,
          backend: label.backend || null,
          ms: Number.isFinite(label.ms) ? label.ms : null,
        });
      } else {
        // no confident label from either backend -> cache the "no label"
        // verdict too, so this message isn't re-sent to Jev/Haiku every turn.
        newCacheEntries[it.hash] = { _seq: ++cacheSeqCounter };
      }
    }
    if (Object.keys(newCacheEntries).length) {
      writeCache(home, Object.assign({}, cache, newCacheEntries));
    }
  }

  return results;
}

// pendingPath(home) — one small JSON map of (recipient, sender) pairs
// awaiting a first reply, so recordAnswered() can compute time-to-answer.
function pendingPath(home) {
  return path.join(homeDir(home), '.anti-hall', 'state', 'jev-triage-pending.json');
}

function readPending(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(home), 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writePending(home, all) {
  try {
    const p = pendingPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) {
    // best-effort only.
  }
}

// noteLabeledInbound({home, recipient, sender, label}) — record that
// `recipient` just received a labeled message (urgency and/or kind set) FROM
// `sender`, so a later recordAnswered() call (when `recipient` next sends
// `sender` a message) can log the time-to-answer. Only the most recent
// unanswered inbound per (recipient, sender) pair is kept. Best-effort:
// never throws, and a missing `home`/`recipient`/`sender`/`label` is a no-op.
function noteLabeledInbound({ home, recipient, sender, label } = {}) {
  if (!home || recipient == null || sender == null || !label || (!label.urgency && !label.kind)) return;
  try {
    const all = readPending(home);
    const key = String(recipient) + '\u0001' + String(sender);
    all[key] = { ts: Date.now(), urgency: label.urgency || null, kind: label.kind || null };
    writePending(home, all);
  } catch (_) { /* best-effort */ }
}

// recordAnswered({home, from, to}) — `from` is about to send a message TO
// `to`. If `to` (as the earlier SENDER) previously sent `from` a labeled
// message with no answer recorded yet (see noteLabeledInbound), log the
// time-to-answer: appends {type:'answered', urgency, kind, latencyMs} to
// jev-triage.ndjson (for `jev report`'s urgent-vs-non-urgent comparison) AND
// a joinable outcome row via jev-assist's recordOutcome (id 'triage').
// Best-effort, fail-open: never throws, never delays or blocks the send.
function recordAnswered({ home, from, to } = {}) {
  if (!home || from == null || to == null) return;
  try {
    const all = readPending(home);
    // noteLabeledInbound stores keys as recipient+sep+sender; here `from` is
    // the recipient of the ORIGINAL labeled message (about to answer) and
    // `to` was its sender — same (recipient, sender) order, NOT reversed.
    const key = String(from) + '\u0001' + String(to);
    const pending = all[key];
    if (!pending) return;
    const latencyMs = Date.now() - pending.ts;
    delete all[key];
    writePending(home, all);

    appendTriageLog(home, {
      ts: new Date().toISOString(),
      type: 'answered',
      urgency: pending.urgency,
      kind: pending.kind,
      latencyMs,
    });

    try {
      const { recordOutcome } = require('./jev-assist.js');
      recordOutcome({
        id: 'triage',
        h: hashMessage(key + '\u0001' + pending.ts),
        outcome: 'answered',
        source: 'triage-answer-latency',
        home,
      });
    } catch (_) { /* jev-assist unavailable — the ndjson row above still lands */ }
  } catch (_) {
    // best-effort only — a latency-tracking failure must never affect sending.
  }
}

module.exports = {
  loadTriageConfig,
  hashMessage,
  triageMessagesSync,
  noteLabeledInbound,
  recordAnswered,
  readPending,
  pendingPath,
  cachePath,
  logPath,
  MAX_CACHE_ENTRIES,
};
