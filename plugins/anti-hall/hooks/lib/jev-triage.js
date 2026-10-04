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
  // jevIntegrations.triage "off" (or ANTIHALL_JEV_TRIAGE=0) does the same:
  // the schema documents that key as read here, and before this it was only
  // read by jev-assist's getMode, which triage labelling never calls.
  // ("shadow" has no meaning for advisory labels and behaves like "on".)
  let integrationOff = process.env.ANTIHALL_JEV_TRIAGE === '0';
  try {
    if (require('./settings.js').get('jevIntegrations', 'triage', undefined, { home }) === 'off') integrationOff = true;
  } catch (_) { /* settings unavailable -> jev.triage alone decides */ }
  const triageEnabled = jevEnabled && cfg.triage !== false && !integrationOff;

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
      // Rotate into .1 .. .N (jev.logRotatedFiles, shared with
      // jev-assist.ndjson) instead of truncating, so `jev report` keeps triage
      // history across a size rollover.
      if (st.size > CACHE_LOG_MAX_BYTES) {
        const assist = require('./jev-assist.js');
        assist.shiftRotated(p, assist.rotatedFilesSetting(home));
      }
    } catch (_) {
      // no existing file — fine, created below.
    }
    fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // best-effort only.
  }
}

// nextCacheSeq(cache) -> one past the highest `_seq` already in `cache`.
// `_seq` MUST be monotonic ACROSS processes: writeCache() evicts the lowest
// `_seq` first, and every hook call is a fresh process. The old per-process
// counter restarted at 1, so once the cache reached MAX_CACHE_ENTRIES every
// new label got the LOWEST `_seq` and was evicted in the same write that added
// it -- the cache froze, and devswarm-store's jevQuestionCandidates lookup
// (the parentGateQuestion Jev integration's only input) never saw a label.
// Seeding from the stored max also heals an already-frozen cache in place:
// its stuck entries now sort below every new one and age out first.
function nextCacheSeq(cache) {
  let max = 0;
  for (const v of Object.values(cache || {})) {
    if (v && Number.isFinite(v._seq) && v._seq > max) max = v._seq;
  }
  return max + 1;
}

// In-flight claims (JT-1): two processes triaging the same uncached message at
// once (a Primary turn plus a sibling child, or an arrival enqueue plus a render)
// both read "uncached" and both paid for a Jev call + log row. A claim is an
// O_EXCL file per hash; a loser skips the item (the winner's label lands in the
// shared cache). A claim older than CLAIM_STALE_MS belongs to a dead process.
const CLAIM_STALE_MS = 15000;

function claimDir(home) {
  return path.join(homeDir(home), '.anti-hall', 'cache', 'jev-triage.claims');
}

const lockLib = () => require('../../companion/lib/lock.js');
const heldClaims = new Map(); // home + hash -> lock handle (this process)

function claimHash(home, hash) {
  try {
    const dir = claimDir(home);
    fs.mkdirSync(dir, { recursive: true });
    // Age-only staleness (a claim older than CLAIM_STALE_MS is a dead process's),
    // exactly as before: the same bound applies to a live-looking holder.
    const h = lockLib().acquire(path.join(dir, hash), {
      staleMs: CLAIM_STALE_MS, liveStaleMs: CLAIM_STALE_MS, maxTries: 2,
    });
    if (!h) return false; // held (or an fs error: the old code also returned false)
    heldClaims.set(home + '\u0000' + hash, h);
    return true;
  } catch (_) {
    return true; // claims are best-effort: an unusable dir must not disable triage
  }
}

function releaseClaim(home, hash) {
  const k = home + '\u0000' + hash;
  const h = heldClaims.get(k);
  heldClaims.delete(k);
  try { if (h) lockLib().release(h); } catch (_) { /* best-effort */ }
}

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

  try { require('./state-prune.js').pruneJevTriage(home); } catch (_) { /* best-effort */ }

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

  // Claim each uncached hash; re-read the cache AFTER claiming so a label a
  // concurrent process just wrote (and released its claim for) is not paid for
  // twice. Items another process holds are skipped (their label lands in the
  // shared cache; they are labelled on a later call at no extra cost).
  const claimed = [];
  const freshCache = readCache(home);
  const mine = new Set();
  for (const it of uncached) {
    if (mine.has(it.hash)) { claimed.push(it); continue; } // same text twice in ONE call: one Jev call, both keys labelled
    if (!claimHash(home, it.hash)) continue;
    const c = freshCache[it.hash];
    if (c) {
      releaseClaim(home, it.hash);
      if (c.urgency || c.kind) results.set(it.key, { urgency: c.urgency, kind: c.kind });
      continue;
    }
    mine.add(it.hash);
    claimed.push(it);
  }
  uncached.length = 0;
  for (const it of claimed) uncached.push(it);
  if (uncached.length === 0) return results;

  try {
    return runWorkerAndCache(home, cfg, cache, uncached, results);
  } finally {
    for (const it of uncached) releaseClaim(home, it.hash);
  }
}

function runWorkerAndCache(home, cfg, cache, uncached, results) {
  let workerOut = null;
  try {
    const input = JSON.stringify({
      items: uncached.filter((it, i) => uncached.findIndex((o) => o.hash === it.hash) === i)
        .map((it) => ({ hash: it.hash, text: it.text })),
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
    let seq = nextCacheSeq(cache);
    for (const it of uncached) {
      const label = workerOut[it.hash];
      if (label && (label.urgency || label.kind)) {
        results.set(it.key, { urgency: label.urgency, kind: label.kind });
        newCacheEntries[it.hash] = {
          urgency: label.urgency || undefined,
          kind: label.kind || undefined,
          _seq: seq++,
        };
        appendTriageLog(home, {
          ts: new Date().toISOString(),
          hash: it.hash,
          urgency: label.urgency || null,
          kind: label.kind || null,
          backend: label.backend || null,
          ms: Number.isFinite(label.ms) ? label.ms : null,
          ...((label.transport === 'vercel' || label.transport === 'typesafe') ? { transport: label.transport } : {}),
          ...(label.fellBack === true ? { fellBack: true } : {}),
        });
      } else if (Object.prototype.hasOwnProperty.call(workerOut, it.hash)) {
        // attempted, no confident label from either backend -> cache the "no
        // label" verdict too, so this message isn't re-sent to Jev/Haiku every
        // turn. An item ABSENT from workerOut was never attempted (the worker's
        // budget ran out first, or its call threw): caching it would store a
        // permanent no-label verdict it never earned (and, in bulk, evict every
        // real label), so it is left uncached and retried on a later call.
        // `nl` marks it a REAL verdict: before 0.200.0 budget-skipped items were
        // cached as a bare {_seq}, and migrateJevTriageCache removes those
        // (no label, no `nl`) so they are re-triaged.
        newCacheEntries[it.hash] = { _seq: seq++, nl: true };
      }
    }
    if (Object.keys(newCacheEntries).length) {
      // Re-read right before writing: a concurrent process may have written
      // entries since `cache` was read, and whole-file last-write-wins would
      // drop them. Fresh `_seq`s are re-based on the re-read max.
      const latest = readCache(home);
      let seq2 = nextCacheSeq(latest);
      for (const k of Object.keys(newCacheEntries)) newCacheEntries[k]._seq = seq2++;
      writeCache(home, Object.assign({}, latest, newCacheEntries));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// LABEL AT ARRIVAL — ONE bounded worker per HOME.
//
// enqueueArrival() never spawns per message. It appends {h, t} to a small
// capped queue file, then tries an O_EXCL lock; ONLY the winner spawns the
// single detached drain worker (jev-triage-arrival.js -> runArrivalWorker),
// every other caller returns immediately (no spawn, nothing awaited). The
// worker drains the queue in small batches through the SAME triageMessagesSync
// (same worker/budget/claims/cache/log), then releases the lock. Fail-open at
// every step; Jev disabled or an already-cached message never reaches the queue.
// ---------------------------------------------------------------------------
const ARRIVAL_QUEUE_MAX_BYTES = 256 * 1024;   // bounded: over this, new arrivals are dropped (labelled at render instead)
const ARRIVAL_TEXT_MAX_CHARS = 16000;         // longer bodies are not queued (hash needs the full text)
const ARRIVAL_LOCK_STALE_MS = 30000;          // worker touches the lock every batch
const ARRIVAL_BATCH_SIZE = 3;                 // keeps a batch inside the 2 s triage budget
const ARRIVAL_MAX_BATCHES = 60;               // total cap per worker run
const ARRIVAL_MAX_WALL_MS = 120000;
const ARRIVAL_MAX_ATTEMPTS = 3;               // a budget/claim-skipped message is retried this many times

function arrivalQueuePath(home) { return path.join(homeDir(home), '.anti-hall', 'cache', 'jev-triage-arrival.queue'); }
function arrivalLockPath(home) { return path.join(homeDir(home), '.anti-hall', 'cache', 'jev-triage-arrival.lock'); }

function arrivalTrace(line) {
  const p = process.env.ANTIHALL_TRIAGE_ARRIVAL_TRACE; // test observability only
  if (!p) return;
  try { fs.appendFileSync(p, line + ' ' + Date.now() + '\n'); } catch (_) { /* ignore */ }
}

function appendArrival(home, text) {
  try {
    if (text.length > ARRIVAL_TEXT_MAX_CHARS) return false;
    const p = arrivalQueuePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try { if (fs.statSync(p).size > ARRIVAL_QUEUE_MAX_BYTES) return false; } catch (_) { /* no queue yet */ }
    fs.appendFileSync(p, JSON.stringify({ h: hashMessage(text), t: text }) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// The drain lock lives in companion/lib/lock.js. The spawning hook acquires it
// and hands the token to the detached worker (env), which adopts it; the worker
// re-points the record's pid at itself and refreshes it every batch. A lock not
// refreshed for ARRIVAL_LOCK_STALE_MS belongs to a dead worker: reclaimed.
let arrivalHandle = null;
function tryArrivalLock(home) {
  try {
    const p = arrivalLockPath(home);
    arrivalHandle = lockLib().acquire(p, { staleMs: ARRIVAL_LOCK_STALE_MS, liveStaleMs: ARRIVAL_LOCK_STALE_MS, maxTries: 2 });
    return !!arrivalHandle;
  } catch (_) { arrivalHandle = null; return false; }
}
// Detached worker: take over the lock the spawning hook acquired.
function adoptArrivalLock(home, token) {
  try {
    arrivalHandle = lockLib().adopt(arrivalLockPath(home), token);
    if (arrivalHandle) arrivalHandle.refresh({ pid: process.pid });
    return !!arrivalHandle;
  } catch (_) { arrivalHandle = null; return false; }
}
function touchArrivalLock() { try { if (arrivalHandle) arrivalHandle.refresh(); } catch (_) { /* best-effort */ } }
function releaseArrivalLock() {
  const h = arrivalHandle;
  arrivalHandle = null;
  try { if (h) lockLib().release(h); } catch (_) { /* best-effort */ }
}

// takeQueue(home) -> [{h,t}] — atomically claims the whole queue (rename), so a
// concurrent append starts a fresh file and nothing is read twice or lost.
function takeQueue(home) {
  const q = arrivalQueuePath(home);
  const work = q + '.work.' + process.pid;
  try { fs.renameSync(q, work); } catch (_) { return []; }
  const out = [];
  try {
    for (const line of fs.readFileSync(work, 'utf8').split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e && typeof e.t === 'string' && e.t.trim()) out.push(e); } catch (_) { /* skip torn line */ }
    }
  } catch (_) { /* unreadable: nothing to do */ }
  try { fs.unlinkSync(work); } catch (_) { /* best-effort */ }
  return out;
}

function queueNonEmpty(home) {
  try { return fs.statSync(arrivalQueuePath(home)).size > 0; } catch (_) { return false; }
}

// runArrivalWorker(home) — called by the detached child that already owns the lock.
function runArrivalWorker(home, token) {
  if (token) adoptArrivalLock(home, token); // lock-less when stolen: still drains (claims + cache keep it safe)
  arrivalTrace('start ' + process.pid);
  const t0 = Date.now();
  let batches = 0;
  const attempts = new Map(); // hash -> tries
  let pending = [];
  try {
    for (;;) {
      for (const e of takeQueue(home)) pending.push(e);
      // dedupe by hash, drop what is already cached
      const seen = new Set();
      const cache = readCache(home);
      pending = pending.filter((e) => {
        if (seen.has(e.h) || cache[e.h]) return false;
        seen.add(e.h);
        return true;
      });
      if (pending.length === 0) {
        releaseArrivalLock();
        // an arrival that landed between the last drain and the release has a
        // lock-less queue: re-take the lock and keep going instead of stranding it.
        if (queueNonEmpty(home) && tryArrivalLock(home)) continue;
        return;
      }
      if (batches >= ARRIVAL_MAX_BATCHES || Date.now() - t0 > ARRIVAL_MAX_WALL_MS) {
        releaseArrivalLock();
        return; // total cap: leftovers are labelled at render time as before
      }
      touchArrivalLock();
      const batch = pending.splice(0, ARRIVAL_BATCH_SIZE);
      batches++;
      try {
        triageMessagesSync(batch.map((e, i) => ({ key: i, text: e.t })), { home });
      } catch (_) { /* fail-open */ }
      const after = readCache(home);
      for (const e of batch) {
        if (after[e.h]) continue;
        const n = (attempts.get(e.h) || 0) + 1;
        attempts.set(e.h, n);
        if (n < ARRIVAL_MAX_ATTEMPTS) pending.push(e); // budget/claim-skipped: retry
      }
    }
  } catch (_) {
    releaseArrivalLock();
  } finally {
    arrivalTrace('end ' + process.pid);
  }
}

// enqueueArrival({home, text}) -> true when queued. Never waits on Jev or the
// worker, never throws. Disabled / already-cached -> false with zero fs writes.
function enqueueArrival({ home, text } = {}) {
  try {
    if (typeof home !== 'string' || !home || typeof text !== 'string' || !text.trim()) return false;
    const cfg = loadTriageConfig(home);
    if (!cfg.enabled) return false;
    if (readCache(home)[hashMessage(text)]) return false; // already classified
    if (!appendArrival(home, text)) return false;
    if (!tryArrivalLock(home)) return true; // a live worker will drain it: NO spawn
    const { spawn } = require('child_process');
    const lockToken = arrivalHandle && arrivalHandle.token;
    let child;
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'jev-triage-arrival.js')], {
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, { ANTIHALL_TRIAGE_ARRIVAL_HOME: home, ANTIHALL_TRIAGE_ARRIVAL_TOKEN: lockToken, HOME: home, USERPROFILE: home }),
      });
    } catch (_) { releaseArrivalLock(); return true; }
    child.on('error', () => { releaseArrivalLock(); });
    arrivalTrace('spawn');
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
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
  enqueueArrival,
  runArrivalWorker,
  arrivalQueuePath,
  arrivalLockPath,
  ARRIVAL_QUEUE_MAX_BYTES,
  ARRIVAL_LOCK_STALE_MS,
  noteLabeledInbound,
  recordAnswered,
  readPending,
  pendingPath,
  cachePath,
  logPath,
  MAX_CACHE_ENTRIES,
};
