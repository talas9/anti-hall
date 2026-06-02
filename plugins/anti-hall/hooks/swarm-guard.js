#!/usr/bin/env node
// anti-hall :: swarm-guard (PreToolUse Agent/Task — anti-fork-bomb)
//
// Limits agent spawn rate to prevent runaway swarms that can make the OS unusable.
// Checks two conditions on every agent spawn:
//   1. SPAWN RATE: if >= CAP spawns occurred in the last 60 seconds, BLOCK.
//   2. MEMORY PRESSURE: if AVAILABLE RAM < 4% of total, BLOCK.
//
// Both checks are conservative. The spawn-rate cap (default 20 per 60s) is a
// ceiling against runaway loops, not a parallelism budget — normal parallel
// workflows rarely exceed it. The memory threshold (4%) is a last-resort OS
// safety guard; at that level the system is already under extreme pressure.
//
// IMPORTANT: "available" RAM is NOT os.freemem(). On macOS and Linux, os.freemem()
// reports only truly-free pages and EXCLUDES reclaimable cache (inactive / file-
// backed / speculative), so it chronically reads near-zero on a healthy machine
// (e.g. 2 GB "free" of 64 GB while 17 GB of cache is instantly reclaimable and
// memory pressure is green). Using it caused false-positive blocks. We compute real
// available memory per-platform (macOS vm_stat, Linux /proc/meminfo MemAvailable).
// On macOS/Linux we NEVER fall back to os.freemem() — see availableBytes() — because
// a failed real-memory read would otherwise produce a misleadingly-low number and
// could BLOCK a spawn when memory is actually fine. We only use os.freemem() where it
// is genuinely accurate (Windows). Elsewhere a parse failure SKIPS the memory gate.
//
// Fail-open on ANY error: a bug here must never prevent legitimate agent spawns.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input, ... }
//   stdout : JSON { decision: "block", reason: "..." } to block
//   exit 2 : to block; exit 0: allow
//   Fail-open on any error (exit 0).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SPAWN_CAP = 20;          // max spawns allowed in WINDOW_MS
const WINDOW_MS = 60000;       // 60-second rolling window
const MEM_FLOOR_RATIO = 0.04;  // block if availableMem/totalMem < 4%

// Real available memory (reclaimable cache included), per-platform. os.freemem()
// undercounts on macOS/Linux because it excludes reclaimable pages — see header.
//
// FAIL-CLOSED ON PARSE FAILURE (memory gate skipped, NOT blocked): returns a real
// available-byte count ONLY when it was SUCCESSFULLY read; otherwise returns null.
// A null tells the caller to SKIP the memory gate entirely (treat memory as OK).
// We must NOT fall back to os.freemem() on macOS/Linux: it excludes reclaimable
// cache and reads near-zero on a healthy box, so using it after a parser failure
// would falsely trip the < 4% floor and BLOCK a spawn when memory is actually fine.
// The only place os.freemem() is the genuine primary source is Windows.
function availableBytes() {
  try {
    if (process.platform === 'darwin') {
      // vm_stat: available ~= free + inactive + speculative pages (all reclaimable
      // on demand). Inactive/speculative are what Activity Monitor counts as cache.
      const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1500 });
      const psM = out.match(/page size of (\d+) bytes/);
      const ps = psM ? parseInt(psM[1], 10) : 4096;
      const pages = (label) => {
        const m = out.match(new RegExp('Pages ' + label + ':\\s+(\\d+)'));
        return m ? parseInt(m[1], 10) : 0;
      };
      const avail = pages('free') + pages('inactive') + pages('speculative');
      if (avail > 0) return avail * ps;
      // Parsed but got nothing usable -> unavailable, skip the gate (not a block).
      return null;
    } else if (process.platform === 'linux') {
      // MemAvailable is the kernel's own reclaimable-aware estimate (kB).
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const m = mi.match(/MemAvailable:\s+(\d+)\s+kB/);
      if (m) return parseInt(m[1], 10) * 1024;
      // /proc parsed but MemAvailable missing -> unavailable, skip the gate.
      return null;
    }
    // Windows (and any other platform): os.freemem() is the genuine primary source.
    return os.freemem();
  } catch (_) {
    // Real-memory read failed (exec/read/parse error). Return null so the caller
    // SKIPS the memory gate instead of blocking on a bogus low number. Fail-CLOSED
    // for the GATE (don't block), fail-open for spawning.
    return null;
  }
}

// Cross-process state under ~/.anti-hall/ (not os.tmpdir) so the spawn log is
// visible across runners and survives tmpdir variation between processes.
const LOG_DIR = path.join(os.homedir(), '.anti-hall');
const LOG_FILE = path.join(LOG_DIR, 'swarm-spawns.log');
const LOCK_FILE = path.join(LOG_DIR, 'swarm-spawns.lock');
const LOCK_STALE_MS = 5000;    // steal a lock whose mtime is older than this
const LOCK_RETRY_MS = 50;      // bounded total spin time trying to acquire
const LOCK_SPIN_STEP_MS = 5;   // busy-wait granularity (no async in a sync hook)

// OWNERSHIP INVARIANT (TOCTOU fix): every lock file carries a unique owner token
// written at O_EXCL-create time. A process may unlink the lock ONLY when it can
// prove the token is the one it expects:
//   - releaseLock: unlink ONLY if the on-disk token === OUR token. Never blind-
//     unlink, so we can never delete a lock a *different* process now holds (which
//     would let two holders run). If the token can't be read or doesn't match, we
//     leave the file untouched — a later stale-steal will reclaim it.
//   - stale-steal: read the token, re-stat to confirm it's still stale AND the token
//     is unchanged, then unlink that exact token. Best-effort; if anything shifts
//     under us we just retry the O_EXCL create.
// MY_TOKEN is unique per process invocation: pid + create-time + a counter, so two
// fast successive locks from the same pid still get distinct tokens.
let LOCK_TOKEN_SEQ = 0;
function newToken() {
  // Date.now() is fine here — real runtime, only needs to be locally unique.
  return process.pid + ':' + Date.now() + ':' + (++LOCK_TOKEN_SEQ);
}

// Best-effort cross-process mutex via O_EXCL lock file. On success returns a handle
// { fd, token } — the token is written into the lock file and proves ownership so
// release can never delete a lock a different process now holds (see OWNERSHIP
// INVARIANT above). Returns null if it could not be acquired (caller fails open).
// Steals a stale lock (mtime older than LOCK_STALE_MS) so a crashed holder cannot
// wedge spawns forever. Bounded spin — never blocks long, never deadlocks.
function acquireLock() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
  const deadline = Date.now() + LOCK_RETRY_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx'); // O_CREAT | O_EXCL
      const token = newToken();
      // Stamp ownership into the lock so release can verify it's ours. A write
      // failure isn't fatal: release simply won't match and will leave the file,
      // and a later stale-steal reclaims it — still fail-open, still safe.
      try { fs.writeSync(fd, token); } catch (_) {}
      return { fd, token };
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        // Held by someone else — steal ONLY if stale AND the owner token is
        // unchanged across a re-stat (best-effort). This avoids stealing a lock
        // that a fresh holder just re-created under the same path.
        try {
          const st = fs.statSync(LOCK_FILE);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            const tok1 = readLockToken();
            // Re-stat: confirm still present, still stale, same token. If any of
            // these shifted, someone else is acting on it — back off and retry.
            const st2 = fs.statSync(LOCK_FILE);
            const tok2 = readLockToken();
            if (Date.now() - st2.mtimeMs > LOCK_STALE_MS &&
                tok1 !== null && tok1 === tok2) {
              try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
            }
            continue; // retry the O_EXCL create immediately
          }
        } catch (_) { /* lock vanished between calls — retry */ }
        if (Date.now() >= deadline) return null; // give up -> fail-open
        const until = Date.now() + LOCK_SPIN_STEP_MS;
        while (Date.now() < until) { /* short busy-wait */ }
        continue;
      }
      return null; // any other error -> fail-open (no lock)
    }
  }
}

// Best-effort read of the owner token stored in the lock file. Returns the trimmed
// token string, or null if it can't be read/parsed (caller treats null as "unknown
// owner" and does NOT unlink).
function readLockToken() {
  try {
    const t = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch (_) {
    return null;
  }
}

// Release ONLY our own lock. Per the OWNERSHIP INVARIANT, unlink iff the on-disk
// token still equals the token we wrote at acquire time. If it differs (a stale-
// steal handed the lock to another process) or can't be read, we leave the file
// alone — never blind-unlink — so we cannot delete a lock a different holder owns.
function releaseLock(handle) {
  if (!handle) return;
  const { fd, token } = handle;
  try { if (fd !== null && fd !== undefined) fs.closeSync(fd); } catch (_) {}
  try {
    if (token && readLockToken() === token) {
      fs.unlinkSync(LOCK_FILE);
    }
    // else: not ours (or unreadable) -> leave it; a later stale-steal reclaims it.
  } catch (_) { /* fail-open: leave the file rather than risk a wrong unlink */ }
}

function readTimestamps() {
  try {
    const data = fs.readFileSync(LOG_FILE, 'utf8');
    return data.trim().split(/\r?\n/)
      .map(line => parseInt(line.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0);
  } catch (_) {
    return [];
  }
}

function writeTimestamps(timestamps) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, timestamps.join('\n') + '\n', 'utf8');
  } catch (_) {
    // Fail-open: if we can't persist, don't block
  }
}

function main() {
  // Read stdin (not strictly needed for logic but required by hook protocol)
  try { fs.readFileSync(0, 'utf8'); } catch (_) {}

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('swarm-guard')) process.exit(0);

  const now = Date.now();

  // --- Memory pressure check (real available memory, reclaimable cache included) ---
  try {
    const avail = availableBytes();
    const total = os.totalmem();
    // Only block on a SUCCESSFULLY-READ real available value below the floor.
    // avail === null means the platform parser failed/was unavailable -> SKIP the
    // gate (treat memory as OK) rather than block on a misleading os.freemem() number.
    if (avail !== null && total > 0 && (avail / total) < MEM_FLOOR_RATIO) {
      const availMb = Math.round(avail / 1024 / 1024);
      const totalMb = Math.round(total / 1024 / 1024);
      const reason =
        'anti-hall swarm-guard: memory pressure critical (' + availMb + ' MB available of ' +
        totalMb + ' MB total, < 4%). Blocking new agent spawn to protect OS stability. ' +
        'Let running agents finish and free memory before spawning more.';
      process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
      process.exit(2);
    }
  } catch (_) {
    // Fail-open: if the availability check throws, skip it
  }

  // --- Spawn rate check (atomic across concurrent hook invocations) ---
  // The prune -> count -> cap-check -> append must be a single critical section,
  // or concurrent spawns each read a stale pre-cap log and race past the ceiling.
  // We serialize it with a best-effort O_EXCL lock. FAIL-OPEN: if the lock can't
  // be acquired, proceed WITHOUT blocking (never deadlock a spawn). The cap check
  // happens INSIDE the lock on a FRESH read so it sees concurrent appends.
  const lock = acquireLock();
  if (lock === null) {
    // Could not lock -> fail-open: allow without recording (don't risk a deadlock).
    process.exit(0);
  }

  let blockReason = null;
  try {
    let timestamps;
    try {
      timestamps = readTimestamps();
    } catch (_) {
      process.exit(0); // fail-open (finally releases the lock)
    }

    // Prune entries older than WINDOW_MS (re-read INSIDE the lock).
    const cutoff = now - WINDOW_MS;
    const recent = timestamps.filter(t => t > cutoff);

    // Cap check BEFORE appending/persisting `now`: a blocked spawn must NOT be
    // logged, otherwise repeated blocked retries keep extending the window and the
    // guard can never recover. Only an ALLOWED spawn is recorded (below).
    if (recent.length >= SPAWN_CAP) {
      blockReason =
        'anti-hall swarm-guard: agent spawn-rate ceiling reached (' + recent.length +
        ' spawns in the last 60s, cap is ' + SPAWN_CAP + '). Pause new agents to avoid ' +
        'a runaway swarm that can make the OS unusable. Let running agents finish, ' +
        'then continue. Respect the concurrency cap (~min(16, cores-2)): never spawn ' +
        'unbounded agents; let in-flight agents finish before launching more waves.';
    } else {
      // Spawn is allowed: record its timestamp INSIDE the lock so concurrent
      // spawns observe it. A persist failure is fail-open (allow without recording).
      recent.push(now);
      writeTimestamps(recent);
    }
  } finally {
    releaseLock(lock);
  }

  if (blockReason !== null) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason }) + '\n');
    process.exit(2);
  }

  process.exit(0);
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);
