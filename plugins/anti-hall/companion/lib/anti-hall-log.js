'use strict';
// anti-hall :: anti-hall-log — C0 shared structured JSONL error/event logger
// (logger-foundation). Any DevSwarm component can call logError/logEvent to
// append a structured record to ONE CENTRAL machine-wide log file, and any
// component (typically a Primary orchestrator session) can call readRecent()
// to pull back a filtered, time-ordered slice — e.g. to analyze failures
// across every child project from a single place.
//
// CENTRAL, NOT PER-REPO. The path is `${os.homedir()}/.anti-hall/logs/devswarm.jsonl`
// (or `${ANTI_HALL_LOG_DIR}/devswarm.jsonl` when the env override is set — tests
// use this so they never touch the real ~/.anti-hall). This is a deliberate
// departure from the per-repo/per-worktree state shapes used elsewhere in
// DevSwarm (devswarm-repokey.js etc.) — a Primary session diagnosing "why did
// child X fail" needs ONE stream to tail/grep across every project, not N
// per-repo files it would have to discover and merge itself. repoKey is
// still recorded per-entry (from ctx.repoKey or DEVSWARM_REPO_KEY) precisely
// so a central stream can still be filtered back down to one project.
//
// FAIL-OPEN, ALWAYS. Logging must never throw into the caller and must never
// crash the host process — a companion daemon that dies because its OWN
// logging call threw would be strictly worse than one that silently drops a
// log line. Every fs operation here is wrapped in try/catch with an empty
// catch body; there is no logger-of-last-resort, by design (see ingest-health.js's
// same "fail-open never means throw" doctrine).
//
// SYNCHRONOUS APPENDS. logError/logEvent use fs.appendFileSync so that a
// single process's interleaved log lines are each written atomically as one
// write(2) syscall (POSIX guarantees atomicity for writes under PIPE_BUF /
// small appends to files opened O_APPEND) — multiple processes appending to
// the same file will not interleave partial lines within one entry. This is
// re-entrant-safe in the sense that concurrent processes each get whole,
// unbroken JSON lines; it is NOT a cross-process lock (no O_EXCL / advisory
// lock here) — for a lightweight best-effort event logger that's an accepted
// tradeoff, not something readRecent() should assume more of.
//
// ROTATION. The file is bounded to roughly MAX_LOG_BYTES; once appending
// would push it over that bound (checked BEFORE the append, via a cheap
// statSync on the destination), the current file is rotated to `.1`
// (overwriting any prior `.1`) and a fresh file is started. This keeps total
// on-disk growth bounded to ~2x MAX_LOG_BYTES without needing a full log
// rotation daemon.
//
// readRecent() TOLERATES A CORRUPT/TRUNCATED TRAILING LINE. A process that
// gets killed mid-write can leave a partial final line; JSON.parse on that
// line throws, and readRecent silently skips ONLY that one line rather than
// failing the whole read.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LOG_BYTES = 5 * 1024 * 1024; // ~5MB bound per active file (rotation.md above)
const LEVELS = ['debug', 'info', 'warn', 'error'];
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

// logDir() -> the directory the log file lives in. ANTI_HALL_LOG_DIR overrides
// the default `${os.homedir()}/.anti-hall/logs` so tests never touch the real
// home directory. Read live (not cached) so tests can set/unset the env var
// per-test without requiring a fresh module load.
//
// TEST-CONTEXT GUARD (defect class be2c6c9e81a1/f3c1bc827d89 — same class as
// devswarm-store.js's resolveHomeGuarded). This logger is DELIBERATELY
// central/home-independent (see the header comment), so passing an isolated
// `home`/`ctx.home` to a devswarm CLI call does NOT isolate it — only
// ANTI_HALL_LOG_DIR does. A test that exercises any devswarm.js verb failure
// path (logVerbOutcome -> logError) without setting it used to silently
// append into the REAL ~/.anti-hall/logs/devswarm.jsonl (confirmed live: 41+
// leaked entries found in the real log — see tests/companion/
// devswarm-supervisor-reconcile-sweep.test.js and tests/scripts/
// devswarm-lifecycle.test.js, both fixed to set it). Node sets
// NODE_TEST_CONTEXT in every `node --test` worker (and inherits it into any
// spawnSync'd child — same mechanism resolveHomeGuarded relies on), so under
// test the real-home fallback is NEVER legitimate: throw loudly instead of
// writing into the real machine home. No opt-out, matching
// resolveHomeGuarded's own contract.
function logDir() {
  const override = process.env.ANTI_HALL_LOG_DIR;
  if (override) return override;
  if (process.env.NODE_TEST_CONTEXT) {
    const err = new Error(
      'anti-hall-log: refusing to fall back to the real home (' + os.homedir() + ') while running under '
      + '`node --test` (NODE_TEST_CONTEXT is set). This test never set ANTI_HALL_LOG_DIR, which would leak '
      + 'a log entry into the real ~/.anti-hall/logs/devswarm.jsonl (defect class be2c6c9e81a1/f3c1bc827d89). '
      + 'Set process.env.ANTI_HALL_LOG_DIR to an isolated tmp dir before requiring anything that may log '
      + '(see tests/scripts/devswarm-v064.test.js for the established pattern).'
    );
    err.__antiHallLogTestGuard = true;
    throw err;
  }
  return path.join(os.homedir(), '.anti-hall', 'logs');
}

function logFilePath() {
  return path.join(logDir(), 'devswarm.jsonl');
}

function rotatedFilePath() {
  return path.join(logDir(), 'devswarm.jsonl.1');
}

function rotateLockPath() {
  return path.join(logDir(), 'devswarm.jsonl.rotate.lock');
}

// ROTATE LOCK (companion/lib/lock.js). Only the lock winner may stat->rename
// the log: without it, N processes can all observe "over the bound" and all
// renameSync the SAME target -> each rename after the first clobbers the
// previous rotate's `.1` (a 32-process repro lost content from BOTH files).
//
// Both bounds are deliberately small: the ENTIRE locked section (stat, maybe
// one rename, one append) is near-instant, and a logging call sits on a hot
// path (hooks, the ingest daemon loop) that must never meaningfully stall.
const ROTATE_LOCK_WAIT_MS = 300;   // bound on how long ONE writer waits before appending unlocked (fail-open)
const ROTATE_LOCK_STALE_MS = 3000; // a lock older than this whose holder is not alive is presumed abandoned

// acquireRotateLockBlocking() -> lock handle, or null once the wait budget
// expires (or the lock cannot be created at all) — writeEntry then appends
// WITHOUT the lock (the pre-fix race only in that rare, bounded edge case).
// C2 STEAL RULE — DEAD-OR-STALE IS NOT ENOUGH: reclaim ONLY when the lock is
// BOTH stale AND not held by a live process. A winner merely descheduled (GC/
// VM pause) past 3s must never have its lock stolen mid-rotate (the `.1`
// clobber this lock exists to prevent); the 300ms wait budget, far shorter
// than STALE_MS, is what bounds a waiter's patience instead.
function acquireRotateLockBlocking() {
  return require('./lock.js').acquire(rotateLockPath(), {
    staleMs: ROTATE_LOCK_STALE_MS,
    maxTries: Infinity,
    waitMs: ROTATE_LOCK_WAIT_MS,
    stepMs: 5,
  });
}

// serializeErr(err) -> { message, stack, code } when err is an Error (or has
// error-shaped fields), otherwise a plain string message. Never throws.
function serializeErr(err) {
  try {
    if (err instanceof Error) {
      const out = { message: err.message, stack: err.stack };
      if (err.code !== undefined) out.code = err.code;
      return out;
    }
    if (typeof err === 'string') return { message: err };
    if (err && typeof err === 'object') {
      const out = { message: err.message !== undefined ? String(err.message) : String(err) };
      if (err.stack !== undefined) out.stack = err.stack;
      if (err.code !== undefined) out.code = err.code;
      return out;
    }
    return { message: String(err) };
  } catch (_) {
    return { message: '[unserializable error]' };
  }
}

// buildEntry(component, op, level, msg, ctx) -> the plain object that gets
// JSON-stringified onto one line. repoKey/meshId are lifted to top-level
// fields when present (ctx.repoKey, ctx.meshId, or env DEVSWARM_REPO_KEY for
// repoKey); every other ctx field is preserved verbatim under `ctx`.
function buildEntry(component, op, level, msg, ctx, errObj) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const rest = {};
  for (const k of Object.keys(c)) {
    if (k === 'repoKey' || k === 'meshId') continue;
    rest[k] = c[k];
  }
  const repoKey = c.repoKey !== undefined ? c.repoKey : (process.env.DEVSWARM_REPO_KEY || null);
  const entry = {
    ts: new Date().toISOString(),
    component: component !== undefined ? component : null,
    op: op !== undefined ? op : null,
    level: level,
    repoKey: repoKey,
    meshId: c.meshId !== undefined ? c.meshId : null,
    pid: process.pid,
    msg: msg !== undefined ? msg : null,
  };
  if (errObj) entry.err = errObj;
  if (Object.keys(rest).length > 0) entry.ctx = rest;
  return entry;
}

// rotateIfNeededLocked(target, nextLineLen) -> renames target -> target.1
// (overwriting any prior .1) when appending nextLineLen bytes would push the
// file over MAX_LOG_BYTES. ASSUMES THE CALLER ALREADY HOLDS THE ROTATE LOCK
// (writeEntry, via acquireRotateLockBlocking) spanning THIS call AND the
// caller's own subsequent append — this function does no locking of its own.
// Fail-open: any error here is swallowed and the caller proceeds to append to
// whatever exists (better an oversized file than a lost log line, and NEVER a
// thrown error).
//
// WHY THE LOCK MUST SPAN THE APPEND TOO (rotation race, not just the rename):
// the old version only serialized the stat->rename step itself, then let
// EVERY writer (including ones that decided no rotation was needed, and thus
// never touched the lock at all) append unlocked afterward. That leaves a gap:
// process A takes the rotate lock and is mid stat->rename; process B, which
// either lost the lock race or never needed to rotate, opens the CURRENT file
// for its own append and is descheduled between open and write; A completes
// its rename, moving that same open inode to `.1`; B resumes and its write
// lands in `.1` — invisible to readRecent() (current-file-only) and gone for
// good on the NEXT rotation (which overwrites `.1`). Holding ONE lock across
// rotate-check + rotate + append, for every writer, closes this: no writer's
// open-to-write window can ever straddle another writer's rename.
function rotateIfNeededLocked(target, nextLineLen) {
  try {
    const st = fs.statSync(target);
    if (st.size + nextLineLen <= MAX_LOG_BYTES) return;
    fs.renameSync(target, rotatedFilePath());
  } catch (_) {
    // file doesn't exist yet, or stat/rename failed (vanished, `.1` locked on
    // some platform, …) — fall through and keep appending to whatever exists
    // rather than losing the entry.
  }
}

// writeEntry(entry) -> appends one JSON line to the central log file.
// FAIL-OPEN: every step (mkdir, lock, stat, rename, append) is individually
// try/caught; a failure at any step results in the log line being silently
// dropped, never a thrown exception reaching the caller.
function writeEntry(entry) {
  try {
    const dir = logDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* fail-open */ }

    const line = JSON.stringify(entry) + '\n';
    const target = logFilePath();
    const nextLineLen = Buffer.byteLength(line, 'utf8');

    // Hold the rotate lock across BOTH the rotate-check/rename AND this
    // writer's own append — see rotateIfNeededLocked's comment for the race
    // this closes. `lock` is null only after the bounded wait budget
    // expires (fail-open: proceed unlocked rather than hang the caller
    // forever); that residual window is the same pre-fix race, now rare and
    // time-bounded instead of the default behavior.
    const lock = acquireRotateLockBlocking();
    try {
      rotateIfNeededLocked(target, nextLineLen);
      fs.appendFileSync(target, line, 'utf8');
    } finally {
      if (lock) lock.release();
    }
  } catch (e) {
    // fail-open: logging must never throw into or crash the caller. EXCEPT:
    // the NODE_TEST_CONTEXT leak guard in logDir() above deliberately throws
    // a distinctly-tagged error so a test never gets a genuinely SILENT leak
    // — surface it once to stderr (visible in `node --test`/CI output, still
    // never re-thrown) before falling through to the same fail-open no-op
    // every other logging failure already gets.
    if (e && e.__antiHallLogTestGuard) {
      try { process.stderr.write('[anti-hall-log] ' + e.message + '\n'); } catch (_) { /* even this must never throw */ }
    }
  }
}

// logError(component, op, err, ctx = {}) -> logs a level:'error' entry. `err`
// may be an Error instance or a plain string; either is normalized via
// serializeErr into entry.err = { message, stack, code }.
function logError(component, op, err, ctx) {
  try {
    const entry = buildEntry(component, op, 'error', ctx && ctx.msg !== undefined ? ctx.msg : (err instanceof Error ? err.message : String(err)), ctx || {}, serializeErr(err));
    writeEntry(entry);
  } catch (_) {
    // fail-open
  }
}

// logEvent(component, op, level, msg, ctx = {}) -> logs a plain event with no
// error payload. level must be one of debug/info/warn/error; an invalid
// level is coerced to 'info' rather than throwing or silently dropping the
// event (fail-open prefers a slightly-mislabeled entry over a lost one).
function logEvent(component, op, level, msg, ctx) {
  try {
    const lvl = LEVELS.indexOf(level) !== -1 ? level : 'info';
    const entry = buildEntry(component, op, lvl, msg, ctx || {}, null);
    writeEntry(entry);
  } catch (_) {
    // fail-open
  }
}

// parseLogFile(filePath) -> array of parsed entries in on-disk order.
// Tolerates a corrupt/truncated trailing line (or any malformed line,
// anywhere in the file) by skipping just that line, and a missing/unreadable
// file by returning []. Shared by readRecent for BOTH the current file and
// (C1 fix, below) the rotated `.1` file — a fail-open per-file read, never a
// thrown error either way.
function parseLogFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = raw.split('\n');
  const out = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      continue; // corrupt/truncated line — skip, don't fail the whole read
    }
    out.push(parsed);
  }
  return out;
}

// readRecent(opts = {}) -> array of parsed entries, newest-last (i.e. in the
// same chronological order they were written), filtered by opts:
//   limit     — max number of entries returned (the MOST RECENT `limit`, still newest-last)
//   sinceMs   — only entries with `ts` timestamp >= (Date.now() - sinceMs)... actually
//               documented as an absolute cutoff: entries whose ts (parsed as
//               epoch ms) is >= sinceMs are kept. Callers wanting "last N ms"
//               pass `Date.now() - N`.
//   repoKey   — exact match against entry.repoKey
//   component — exact match against entry.component
//   minLevel  — keep entries whose level rank >= minLevel's rank (debug < info < warn < error)
//
// C1 FIX — ALSO CONSULTS THE ROTATED `.1` FILE WHEN THE REQUESTED WINDOW
// PREDATES THE CURRENT FILE. Rotation happens at a size bound (MAX_LOG_BYTES),
// so the highest-volume period — a failure storm — is precisely what gets
// rotated OUT of the current file and into `.1` first. A caller triaging
// "what happened in the last hour" right after such a storm would have seen
// only the sparse post-rotation tail and silently under-reported the
// incident. Now: whenever the current file's own content cannot possibly
// satisfy the requested `sinceMs` cutoff or `limit` count on its own, `.1` is
// also read and merged in (older-first, since rotation is a point-in-time cut
// — `.1`'s entries always chronologically precede the current file's), then
// the SAME filters below run over the union before the final limit-slice.
// Bounded: at most one extra file is ever read, never a deeper history walk.
// Fail-open on a missing/corrupt `.1` (parseLogFile already tolerates both).
function readRecent(opts) {
  const o = opts || {};
  const current = parseLogFile(logFilePath());

  let needRotated = false;
  if (o.sinceMs !== undefined && Number.isFinite(o.sinceMs)) {
    const earliestTs = current.length ? Date.parse(current[0] && current[0].ts) : NaN;
    if (current.length === 0 || !Number.isFinite(earliestTs) || earliestTs > o.sinceMs) {
      needRotated = true; // the window reaches back before what the current file even starts at
    }
  }
  if (Number.isFinite(o.limit) && o.limit >= 0 && current.length < o.limit) {
    needRotated = true; // the current file alone cannot supply the requested count
  }

  const entries = needRotated
    ? parseLogFile(rotatedFilePath()).concat(current) // older (.1) first, newer (current) last
    : current;

  let filtered = entries;

  if (o.repoKey !== undefined) {
    filtered = filtered.filter((e) => e && e.repoKey === o.repoKey);
  }
  if (o.component !== undefined) {
    filtered = filtered.filter((e) => e && e.component === o.component);
  }
  if (o.minLevel !== undefined && LEVEL_RANK[o.minLevel] !== undefined) {
    const minRank = LEVEL_RANK[o.minLevel];
    filtered = filtered.filter((e) => e && LEVEL_RANK[e.level] !== undefined && LEVEL_RANK[e.level] >= minRank);
  }
  if (o.sinceMs !== undefined && Number.isFinite(o.sinceMs)) {
    filtered = filtered.filter((e) => {
      if (!e || !e.ts) return false;
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= o.sinceMs;
    });
  }

  if (Number.isFinite(o.limit) && o.limit >= 0 && filtered.length > o.limit) {
    filtered = filtered.slice(filtered.length - o.limit);
  }

  return filtered;
}

module.exports = {
  MAX_LOG_BYTES,
  acquireRotateLockBlocking, rotateLockPath,
  logDir,
  logFilePath,
  rotatedFilePath,
  logError,
  logEvent,
  readRecent,
};
