'use strict';
// devswarm-reply-state — PER-PROJECT (not per-session) record of observed
// replies (PLAN §4.3), keyed by sender meshId, used by the parent Stop-gate to
// tell "read" apart from "decided and replied" so an unanswered child
// question keeps blocking past the forced-ack cap. Pure fs; never opens the
// store DB.
//
// SCOPING (fix-wave, was per-Claude-session_id — WRONG): this file originally
// keyed the reply record by Claude `session_id`, on the reasoning that a
// pendingQuestion only needed to survive one session. That premise broke the
// moment devswarm-store.js's computeSummary made `pendingQuestions` PERMANENT
// (derived from a workspace's full message history, never cursor-scoped) — a
// question no longer clears on its own, so the reply record meant to clear it
// must have the SAME durable, per-project lifetime, or every new Claude
// session starts with an EMPTY reply-state file and every historically-
// answered question resurrects as unanswered (Bug 1a). The key is now a
// durable PROJECT-scoped `repoKey` (companion/lib/devswarm-repokey.js's
// repoKeyForWorktree — the same per-project identity devswarm-parent-gate.js
// and devswarm-parent-inbox.js already resolve for their own per-project
// state), not a short-lived Claude session_id.

const fs = require('fs');
const path = require('path');

// --- recordReply lock (P0 fix, Round 5 review) ------------------------------
// recordReply's read-modify-write below used to be UNLOCKED: two processes
// racing recordReply on the SAME repoKey (e.g. two different senders both
// getting replied to at nearly the same instant) could both read the
// pre-write state, each merge in their own entry, then each write back — the
// SECOND write clobbers the FIRST, silently losing a reply entry. Since the
// gate treats a missing entry as "still unanswered" and an unanswered
// question unconditionally bypasses the forced-ack cap, a lost entry means a
// genuinely-answered question keeps blocking indefinitely. Reproduced
// empirically: 40 concurrent writers to the same file retained only
// ~30/31/30 of 40 entries across three runs.
//
// Fixed with a minimal O_EXCL lockfile scoped to JUST this read-modify-write.
// Deliberately a SELF-CONTAINED copy of this codebase's own established
// idiom (same acquire/steal/torn-read discipline as devswarm-pull.js's
// acquireExclLock, devswarm-store.js's openJournal withMessagesLock, and
// anti-hall-log.js's acquireRotateLock — "the same O_EXCL lock every
// torn-write window in this codebase treats as ambiguous", per
// hooks/devswarm-parent-gate.js's own comment on the convention) rather than
// importing one of those modules: every exported version of this primitive
// (devswarm-pull.js's acquireExclLock, recovery.js's acquireLock) transitively
// requires devswarm-store.js, which would break this file's own header
// promise ("Pure fs; never opens the store DB") for a module that sits on the
// hot Stop-hook path. Consistency with the SHAPE of the codebase's convention
// matters more than sharing one literal function.
//
// UNLIKE devswarm-pull.js's acquireExclLock (which REFUSES on a live, fresh
// holder — correct for "never drain the same queue twice concurrently"),
// this lock RETRIES WITH BACKOFF while busy (mirrors devswarm-store.js's
// withMessagesLock) — recordReply must actually wait out a genuine concurrent
// writer to close the race, not just refuse and reproduce it.
//
// FAIL-OPEN: if the retry budget is exhausted against a live holder, or any
// unexpected fs error occurs, acquireReplyLock returns null and recordReply
// skips the write entirely — matching this module's existing documented
// "never throws" contract (a skipped write just means the gate may nag one
// extra time next Stop, the safe direction), rather than writing unlocked and
// reopening the very race this fix closes.
const REPLY_LOCK_STALE_MS = 10 * 1000;  // mirrors devswarm-store's MESSAGES_LOCK_STALE_MS
const REPLY_LOCK_MAX_TRIES = 1200;      // mirrors devswarm-store's MESSAGES_LOCK_MAX_TRIES (slow-FS headroom);
                                         // widened 1000->1200 (was ~=1000*3.5ms avg = 3.5s theoretical
                                         // max wait; retry-budget exhaustion was RULED OUT as the actual
                                         // flake cause — see the TOCTOU comment below — this is just
                                         // extra headroom, kept well under the 10s hook timeout
                                         // (hooks/hooks.json: devswarm-parent-reply-tracker.js) even at
                                         // the new backoff ceiling: 1200 * 5ms(max) = 6s worst-case).

function replyLockSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch (_) {}
}

// isReplyLockHolderAlive(pid) — process.kill(pid,0) throws ESRCH for a gone
// pid; EPERM means it exists but we may not signal it (still "alive").
// Mirrors recovery.js's defaultIsAlive / anti-hall-log.js's
// isRotateLockHolderAlive.
function isReplyLockHolderAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// acquireReplyLock(lockPath) -> release() | null. O_EXCL create carrying
// {pid, ts, token}. On EEXIST, steals ONLY when the holder is BOTH
// POSITIVELY IDENTIFIED as stale (a real, resolved holder timestamp older
// than REPLY_LOCK_STALE_MS) AND not a live process — a live-but-slow holder
// is never stolen, just waited out via jittered backoff. A holder caught mid
// torn-write (0-byte file between openSync('wx') and writeSync) falls back
// to the file's mtime so that microsecond window never reads as ownerless.
// null means the retry budget was exhausted against a live, fresh holder, or
// an unexpected fs error occurred (e.g. EPERM opening the lock).
//
// TOCTOU FIX (post-Wave-5 flake investigation): the ORIGINAL steal condition
// was `stale = holderTs === null || (elapsed > REPLY_LOCK_STALE_MS)` — i.e.
// "couldn't identify a holder at all" was treated as EQUIVALENT to "found a
// confirmed-old, confirmed-dead holder," and BOTH triggered an unconditional
// `fs.unlinkSync(lockPath)`. Instrumented reproduction (40 worker_threads,
// verbose ACQUIRED/RELEASED/RELEASE-MISMATCH tracing) proved this was the
// actual entry-loss mechanism, NOT retry-budget exhaustion (zero exhaustion
// events were observed across dozens of failing runs): under heavy
// contention, "holderTs === null" usually just means the PRIOR holder
// released between our failed read/stat and this check — the lock is
// legitimately free, nothing to steal. But in that same window, a BRAND NEW
// thread can already have created its OWN fresh, live lock there. The old
// code deleted whatever was CURRENTLY at lockPath regardless — silently
// stealing that new thread's live lock out from under it (confirmed via
// RELEASE-MISMATCH: a holder's own release() found a DIFFERENT, newer token
// already occupying its lockPath). Two threads then both believed they held
// the lock simultaneously, both entered the critical section, and raced each
// other's `fs.renameSync(tmp, p)` on the SAME shared tmp path — the loser's
// rename throws ENOENT (tmp already moved away), silently swallowed by
// recordReply's catch-all, and that write is lost. FIX: only steal when a
// holder timestamp was POSITIVELY resolved (from the lock file's own `ts` or
// the torn-read guard's real mtime) and is confirmed old+dead; an
// unresolvable holder (holderTs still null after the guard) means there is
// nothing known to be stale — skip the delete and just retry the create,
// which safely no-ops against whatever (if anything) is there now.
function acquireReplyLock(lockPath) {
  for (let attempt = 0; attempt < REPLY_LOCK_MAX_TRIES; attempt++) {
    const ts = Date.now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { fs.closeSync(fd); }
      return function release() {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (cur && cur.token === token) fs.unlinkSync(lockPath);
        } catch (_) { /* not ours / unreadable -> leave it; a later dead-or-stale reclaim cleans it up */ }
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null; // unexpected fs error -> fail open (no lock)
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      let holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      if (holderTs === null) {
        // TORN-READ GUARD (mirrors devswarm-pull.js's acquireExclLock).
        try { holderTs = fs.statSync(lockPath).mtimeMs; } catch (_) { holderTs = null; }
      }
      // holderTs still null here means NEITHER the content nor the file's own
      // mtime could be resolved just now — i.e. right now there is nothing
      // positively known to be stale (most commonly: the true holder already
      // released between our EEXIST and this check). Do NOT steal on "we
      // don't know" — see the TOCTOU FIX comment above. Just retry the
      // create immediately: it transparently no-ops against whatever (if
      // anything, including a brand-new legitimate holder) occupies the path
      // right now, via the same EEXIST/wx exclusivity every other attempt
      // already relies on.
      if (holderTs === null) continue;
      const alive = holderPid !== null && isReplyLockHolderAlive(holderPid);
      const staleConfirmed = (Date.now() - holderTs) > REPLY_LOCK_STALE_MS;
      if (staleConfirmed && !alive) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        continue; // reclaimed a positively-identified dead/stale holder's lock
      }
      // Wider, continuous (non-discretized) jitter than the original
      // `2 + Math.floor(Math.random() * 4)` (only 4 possible integer
      // values — under 40-way contention many desynced-looking writers
      // collide on the SAME bucket and re-race each other immediately).
      // Continuous float jitter across a slightly wider band spreads
      // retries more evenly without materially raising the worst-case
      // total wait (max ~5ms/try * 1200 tries = 6s, still comfortably
      // under the hook's 10s timeout).
      replyLockSleep(1 + Math.random() * 4);
    }
  }
  return null; // contention budget exhausted against a live, positively-identified holder
}

// replyStatePathFor(repoKey, home) — co-located with devswarm-parent-gate.js's
// stateFileFor, same id-sanitization regex, "-replies" suffix distinguishes it.
// `repoKey` is a durable per-project key (repoKeyForWorktree), NOT a Claude
// session_id — see the header comment above for why the scoping changed.
//
// NULL/UNRESOLVABLE KEY (P2 fix, Round 3 review): a falsy `repoKey` (e.g.
// `repoKeyForWorktree` failed to resolve — reachable when `cwd` no longer
// exists on disk, or other resolution failures) returns null, NOT a path
// sanitized from a literal fallback like 'norepo'. A shared literal bucket
// would let two UNRELATED projects that both happen to hit an unresolvable-
// key condition read/write the SAME file — a cross-project state bleed. This
// follows the SAME "unresolvable key -> no state, never a shared bucket"
// convention devswarm-parent-gate.js's readOwnUnread already establishes
// (falls back through legacyHash and, failing that, returns the
// "nothing to check" shape WITHOUT ever touching a file). Callers
// (readReplyState/recordReply below) treat a null path as "no persisted
// state available": a read fails open toward `{}` and a write is a no-op —
// no file is ever created or touched.
function replyStatePathFor(repoKey, home) {
  if (!repoKey) return null;
  const safe = String(repoKey).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(home, '.anti-hall', 'devswarm', 'parent-gate', safe + '-replies.json');
}

// readReplyState(repoKey, home) -> { [meshId]: { lastReplyTs } }. Fail-open:
// missing file, malformed JSON, or wrong shape all yield {} — never throws.
// A null/unresolvable repoKey (replyStatePathFor returns null) also yields
// {} — "no persisted state available", never a shared fallback file.
function readReplyState(repoKey, home) {
  try {
    const p = replyStatePathFor(repoKey, home);
    if (!p) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    return {};
  }
}

// recordReply(repoKey, home, meshId, ts) — LOCKED (see acquireReplyLock above)
// atomic tmp+rename write, merged into the existing state. Monotonic: never
// regresses lastReplyTs on a racing/late write. Best-effort: any error —
// including lock-acquisition failure/exhaustion — is swallowed — a failed
// write just means the gate may nag one extra time next Stop, the safe
// direction. A null/unresolvable repoKey (replyStatePathFor returns null) is
// a safe no-op: no file/directory is ever created or touched.
function recordReply(repoKey, home, meshId, ts) {
  let release = null;
  try {
    const p = replyStatePathFor(repoKey, home);
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    release = acquireReplyLock(p + '.lock');
    if (!release) return; // lock unavailable -> fail open, skip this write (never write unlocked)
    const state = readReplyState(repoKey, home);
    const prior = state[meshId] && Number.isFinite(state[meshId].lastReplyTs) ? state[meshId].lastReplyTs : 0;
    state[meshId] = { lastReplyTs: Math.max(Number(ts) || 0, prior) };
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, p);
  } catch (_) {}
  finally {
    if (release) { try { release(); } catch (_) {} }
  }
}

// unansweredQuestions(pendingQuestions, replyState) -> subset of pendingQuestions
// whose ts is strictly after that sender's lastReplyTs (no entry -> unanswered).
// Pure, fail-open TOWARD unanswered on any malformed shape — never drop a real
// question because of a shape surprise. Never throws.
function unansweredQuestions(pendingQuestions, replyState) {
  if (!Array.isArray(pendingQuestions)) return [];
  const state = replyState && typeof replyState === 'object' && !Array.isArray(replyState) ? replyState : {};
  return pendingQuestions.filter((q) => {
    try {
      if (!q || typeof q !== 'object') return true; // malformed entry -> keep (fail-open)
      const entry = state[q.from];
      const lastReplyTs = entry && Number.isFinite(entry.lastReplyTs) ? entry.lastReplyTs : 0;
      const ts = Number.isFinite(q.ts) ? q.ts : Infinity; // unparsable ts -> treat as always-newer
      return ts > lastReplyTs;
    } catch (_) {
      return true; // any surprise -> unanswered
    }
  });
}

module.exports = { replyStatePathFor, readReplyState, recordReply, unansweredQuestions };
