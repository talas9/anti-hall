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
function logDir() {
  const override = process.env.ANTI_HALL_LOG_DIR;
  if (override) return override;
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

// isRotateLockHolderAlive(pid) -> bool. Same isAlive discipline as every other
// lock in this codebase (devswarm-pull.js's acquireExclLock, recovery.js's
// acquireLock, devswarm-supervisor.js's acquireSweepLock): process.kill(pid,0)
// throws ESRCH for a gone pid; EPERM means it exists but we may not signal it
// (still "alive").
function isRotateLockHolderAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// acquireRotateLock() -> a per-acquisition TOKEN STRING iff THIS call won the
// right to perform the rotate (stat->rename) below; null means another
// process is rotating concurrently right now (EEXIST) OR the lock could not
// be created at all (fail-open — either way, skip rotation this cycle and
// just append). O_EXCL makes the create+check atomic at the OS level, closing
// the concurrent-rotation race: without this, N processes can all observe
// "over the bound" via statSync, then all renameSync the SAME target ->
// each rename after the first clobbers the previous rotate's `.1`, so a
// 32-process concurrent-rotation repro can lose the current file's content
// from BOTH the live file and the `.1` backup. Only the single lock-winner
// may rename; every loser's appendFileSync (in writeEntry, right after this
// returns) lands either in the pre-rotation file (which the winner then
// renames intact into `.1`) or in the fresh post-rotation file created by
// the winner — never lost either way.
//
// The lock file's CONTENT ({pid, ts, token}) is what lets a waiter tell a
// merely-slow-but-alive holder apart from a genuinely abandoned one (C2 fix —
// see acquireRotateLockBlocking below); a bare empty marker file (the pre-fix
// shape) carried no pid at all, so staleness was the ONLY signal a waiter had.
function acquireRotateLock() {
  const ts = Date.now();
  const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
  try {
    const fd = fs.openSync(rotateLockPath(), 'wx');
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { fs.closeSync(fd); }
    return token;
  } catch (_) {
    return null; // held by another process, or creation failed — skip rotation this cycle
  }
}

// releaseRotateLock(token) — unlinks the lock file ONLY when its on-disk token
// still matches the one THIS acquisition wrote (mirrors every other lock's
// release() in this codebase). Never unlinks a lock some OTHER acquisition
// (e.g. a waiter that dead-or-stale-reclaimed ours after we somehow vanished)
// now owns.
function releaseRotateLock(token) {
  try {
    const cur = JSON.parse(fs.readFileSync(rotateLockPath(), 'utf8'));
    if (cur && cur.token === token) fs.unlinkSync(rotateLockPath());
  } catch (_) { /* fail-open: not ours / unreadable — leave it; a later dead-or-stale reclaim cleans it up */ }
}

// Both bounds are deliberately small: the ENTIRE locked section (stat, maybe
// one rename, one append) is a near-instant synchronous sequence, so a
// genuinely healthy holder releases in well under a millisecond. A logging
// call sits on a hot path (hooks, the ingest daemon loop) and must never
// meaningfully stall it — 300ms is already generous slack for real
// contention, and a holder still gone after 3s is for-practical-purposes
// abandoned (crashed mid-critical-section), not just "briefly busy".
const ROTATE_LOCK_WAIT_MS = 300;   // bound on how long ONE writer will wait for the rotate lock before giving up and appending unlocked (fail-open: never block the caller indefinitely on a logging call)
const ROTATE_LOCK_STALE_MS = 3000; // a lock file older than this is presumed abandoned by a crashed holder and may be forcibly reclaimed by a waiter rather than waited out

// sleepBriefly(ms) -> best-effort synchronous micro-sleep between lock
// acquisition retries (mirrors devswarm-ingest.js's own sleepSync pattern).
// Never throws: an unavailable SharedArrayBuffer/Atomics just busy-retries
// with no delay instead of sleeping.
function sleepBriefly(ms) {
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, Math.max(0, ms | 0));
  } catch (_) { /* proceed without the micro-sleep */ }
}

// acquireRotateLockBlocking() -> the acquisition TOKEN STRING iff the lock was
// acquired (possibly after reclaiming a dead-or-stale lock file left by a
// crashed holder); null if the wait budget expired first. Bounded, not
// indefinite: a logging call must never hang the caller forever waiting on a
// lock (fail-open) — see writeEntry, which proceeds WITHOUT the lock
// (accepting the pre-fix race only in this rare, bounded-timeout edge case)
// rather than blocking.
//
// THE DEADLINE CHECK MUST RUN ON EVERY ITERATION, BEFORE ANY `continue` —
// this is not merely defensive: a PERSISTENTLY unwritable/unreadable log
// directory (e.g. the fail-open test's blocked-directory scenario, or a real
// permissions error) makes BOTH acquireRotateLock() AND the readFileSync()
// below fail on EVERY single iteration. An earlier version `continue`d
// straight from the read-failure catch without ever reaching a deadline
// check — with a persistent (not transient) failure that is a genuine
// 100%-CPU infinite loop, not a rare race, since neither failing call ever
// yields or changes outcome. The deadline is now checked immediately after
// the acquire attempt, before anything else, so it is reachable on every
// iteration regardless of which branch below is taken.
//
// C2 FIX — DEAD-OR-STALE, NOT STALENESS ALONE. The pre-fix version reclaimed
// on mtime-staleness alone (>3s), with no pid/liveness check at all: a winner
// merely DESCHEDULED (GC pause, VM pause, OS scheduling jitter) mid rotate for
// slightly over 3s had its lock STOLEN by a waiter, and the two then raced
// stat->rename->append against each other — exactly the `.1` clobber this
// lock exists to prevent (the bug-E shape). The fix matches the STEAL RULE
// already used by this codebase's OTHER short-critical-section, fs-race-
// sensitive locks (devswarm-pull.js's acquireExclLock / devswarm-ingest.js's
// acquireIngestLock — deliberately NOT the longer-running-operation locks'
// `dead || stale` OR-rule, which accepts stealing from a live-but-ancient
// holder as a hard TTL backstop): reclaim ONLY when the lock is BOTH stale
// AND not held by a live process. A KNOWN-LIVE holder — however old its
// timestamp looks — is NEVER stolen; the bounded 300ms wait budget above
// (ROTATE_LOCK_WAIT_MS, far shorter than the 3s STALE_MS bound, so this
// deadline is what actually triggers for a live-but-slow holder) is what
// bounds a waiter's patience instead, degrading to the pre-existing,
// documented "append unlocked" fallback rather than a steal-and-collide.
function acquireRotateLockBlocking() {
  const deadline = Date.now() + ROTATE_LOCK_WAIT_MS;
  for (;;) {
    const token = acquireRotateLock();
    if (token) return token;
    if (Date.now() >= deadline) return null;
    try {
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(rotateLockPath(), 'utf8')); } catch (_) { holder = null; }
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      let holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      if (holderTs === null) {
        // TORN-READ GUARD (mirrors devswarm-pull.js's acquireExclLock): a live
        // winner is briefly a 0-byte file between openSync('wx') and the
        // writeSync that fills in {pid, ts, token} above. A reader that
        // catches that window must NOT treat the lock as ownerless/ancient —
        // fall back to the file's own mtime so a fresh-but-still-empty lock
        // still reads as fresh, not stale.
        try { holderTs = fs.statSync(rotateLockPath()).mtimeMs; } catch (_) { holderTs = null; }
      }
      const alive = holderPid !== null && isRotateLockHolderAlive(holderPid);
      const isStale = holderTs === null || (Date.now() - holderTs) > ROTATE_LOCK_STALE_MS;
      // See this function's header: reclaim ONLY when BOTH stale AND not
      // alive. A holder we cannot positively identify (corrupt/legacy lock
      // content with no parseable pid) counts as "not alive" here, so it
      // still degrades to the pre-fix staleness-only behavior once genuinely
      // stale — never a regression for that already-tolerated case.
      if (isStale && !alive) {
        try { fs.unlinkSync(rotateLockPath()); } catch (_) {}
        continue; // reclaimed (or someone else did) — retry the create immediately; the deadline check above runs again next iteration
      }
      // live holder, or a fresh-but-indeterminate lock -> fall through to the
      // sleep below and retry rather than stealing it.
    } catch (_) {
      // lock file vanished (released) between our failed create and this
      // read, OR this read itself failed (e.g. unwritable/unreadable
      // directory) — either way, fall through to the sleep below and retry
      // rather than looping back immediately (see this function's own
      // header comment for why an unconditional `continue` here is unsafe).
    }
    sleepBriefly(5);
  }
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
    // this closes. `token` is null only after the bounded wait budget
    // expires (fail-open: proceed unlocked rather than hang the caller
    // forever); that residual window is the same pre-fix race, now rare and
    // time-bounded instead of the default behavior.
    const token = acquireRotateLockBlocking();
    try {
      rotateIfNeededLocked(target, nextLineLen);
      fs.appendFileSync(target, line, 'utf8');
    } finally {
      if (token) releaseRotateLock(token);
    }
  } catch (_) {
    // fail-open: logging must never throw into or crash the caller.
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
  logDir,
  logFilePath,
  rotatedFilePath,
  logError,
  logEvent,
  readRecent,
};
