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
                                         // max wait). CORRECTION: an earlier version of this comment
                                         // claimed retry-budget exhaustion was "ruled out" as the stress-
                                         // test flake cause in favor of the TOCTOU window described below
                                         // — that claim did not hold up. Traced failures showed the
                                         // exhaustion signature (acquireReplyLock returning null), not a
                                         // clobber; see the "MEASURED RESIDUAL" comment ahead of
                                         // RECORD_REPLY_MAX_ATTEMPTS for the full correction. This 1200
                                         // ceiling remains headroom against genuine slow-FS/contention
                                         // waits, kept well under the 10s hook timeout (hooks/hooks.json:
                                         // devswarm-parent-reply-tracker.js) even at the backoff ceiling:
                                         // 1200 * 5ms(max) = 6s worst-case.

// A single, module-level sleep buffer, reused for every jittered backoff
// call rather than allocating a fresh SharedArrayBuffer(4) per retry (found
// empirically, not reasoned about — see below). Nothing about Atomics.wait
// requires a fresh buffer per call: it just blocks the calling thread until
// either the timeout elapses or index 0's value changes from 0 (which
// nothing here ever does), so a single private buffer, read-only in
// practice, is safe to reuse indefinitely from a single isolate.
//
// WHY THIS MATTERS: under REPLY_LOCK_MAX_TRIES=1200 worst-case contention,
// a single acquireReplyLock call can hit this path up to ~1200 times; with
// many worker_threads racing simultaneously (the steal-CAS tests run 40+),
// that is tens of thousands of SharedArrayBuffer(4) allocations across the
// process. SharedArrayBuffers are backed by V8's process-wide shared-memory
// allocator (they have to be, since by design they CAN be shared across
// isolates) — unlike a normal ArrayBuffer, allocating one is not purely
// isolate-local. Instrumented reproduction proved this directly: a
// completely unrelated, otherwise-clean 2-worker/40-round test measured
// clean and fast (sub-second) in isolation, but reliably degraded to
// multi-second acquireReplyLock exhaustion (genuine NO_LOCK returns, not
// corruption — REPLY_LOCK_MAX_TRIES actually exhausted) whenever it ran
// AFTER a preceding, otherwise-unrelated 40-worker burst in the SAME
// process — pointing at cross-isolate contention on shared-memory
// allocation as the mechanism, not scheduling noise. Reusing one buffer per
// isolate removes essentially all of that allocation churn.
const replyLockSleepBuf = new Int32Array(new SharedArrayBuffer(4));
function replyLockSleep(ms) {
  try { Atomics.wait(replyLockSleepBuf, 0, 0, Math.max(0, ms | 0)); } catch (_) {}
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
//
// RESIDUAL TOCTOU (two-stealer chain): the fix above was NECESSARY but not
// SUFFICIENT. It stops stealing on an UNRESOLVED holder, but once two
// separate attempts BOTH positively resolve the SAME dead/stale holder H —
// entirely possible; there is nothing that serializes the "read H, decide
// staleConfirmed && !alive" step across concurrent attempts — both still
// proceeded to an unconditional `fs.unlinkSync(lockPath)`. Trace the
// remaining race: attempt A and attempt B both read H, both compute
// staleConfirmed && !alive. A unlinks H and loops; A's `openSync(lockPath,
// 'wx')` succeeds — A now holds a legitimate, live, freshly-created lock. B
// is still acting on ITS observation of H, made before A did anything; B's
// `fs.unlinkSync(lockPath)` doesn't check whose lock is there, it just
// deletes whatever currently occupies the path — so B deletes A's live lock.
// A third attempt (or B itself, on its next loop) then creates a lock at the
// now-free path while A still believes it holds one: two writers back in the
// critical section, the exact lost-write / RELEASE-MISMATCH failure the
// unlink-vs-unresolved fix above was meant to eliminate — just gated behind
// a narrower window (both attempts must have positively identified H) instead
// of the wide-open one that fix already closed. A's own token-checked
// release() (see `release` above) silently no-ops when it finds someone
// else's token at lockPath, so this corruption is invisible from A's side.
//
// FIX: replace the unconditional delete with a compare-and-swap steal.
// `fs.renameSync(lockPath, stealPath)` (a unique per-attempt path) is atomic
// at the filesystem level — of two racing renames from the same lockPath,
// exactly one succeeds and captures whatever currently occupies the path; the
// other gets ENOENT (nothing left to rename) and just retries the outer loop,
// which is always safe. The attempt that wins the rename then VERIFIES what
// it actually captured is the SAME holder it positively identified a moment
// earlier (matching on `token` when both the original read and the moved
// file parse; falling back to `pid`+`ts` if content was present but lacked a
// token; and — only for the torn-read-guard case, where the original
// identification never had parseable content to compare, just an mtime —
// treating another still-unparsable moved file as confirmation it is the
// same abandoned/torn file, never treating a NOW-parseable file as a match,
// since that could just as easily be a brand-new legitimate holder we have
// no way to positively rule out). A match means the reclaim was legitimate:
// discard the captured file and retry the create. A MISMATCH means the
// rename captured someone else's live lock — exactly the chain above — so it
// is restored rather than discarded: `fs.linkSync(stealPath, lockPath)` is
// itself non-clobbering (EEXIST if the path has since been reoccupied by yet
// another holder, which is fine — nothing to restore onto in that case), the
// steal file is then removed either way, and the attempt goes back to
// retrying the loop WITHOUT ever entering the critical section on a
// mismatch. No path through this branch leaves an orphaned `.steal.*` file
// behind, and every fs call stays wrapped so an unexpected error degrades to
// "didn't steal, keep retrying" — never to "assume we hold it" — preserving
// this module's "never throws" contract.
//
// STILL A GAP EVEN WITH THE ABOVE (found empirically, not just reasoned
// about — see recordReply's commit-time check below for the actual fix):
// no version of the steal branch, however tightly windowed, can be made
// airtight using only path-based rename/link/unlink. Reclaiming and
// verifying are always at least two separate syscalls; under enough
// contention (proven with as few as 4 concurrent worker_threads, reliably
// with 40) a brand-new, entirely unrelated, perfectly legitimate
// `openSync(lockPath,'wx')` can land in the gap between "we decided this
// generation is stale" and "we act on that decision," no matter how narrow
// the gap. When that happens, our rename captures THAT caller's live lock
// instead of the dead one we meant to reclaim; the mismatch check below
// correctly detects it and tries to restore it, but the restore can itself
// lose a further race (another party takes the path before the restore
// lands) and has to give up. At that point the ORIGINAL holder we
// accidentally stole from has no lock at lockPath anymore and no way to
// find out — it already returned from this function believing it holds the
// lock. Closing that requires the HOLDER, not just the stealer, to
// re-verify ownership before it acts on its belief — which is exactly what
// recordReply's pre-commit check (right before the tmp -> real rename)
// does with `stillOwned` below. This function still does everything it
// reasonably can to avoid ever creating that situation; the commit-time
// check is what makes it safe even on the rare occasions this function
// can't.
function acquireReplyLock(lockPath) {
  for (let attempt = 0; attempt < REPLY_LOCK_MAX_TRIES; attempt++) {
    const ts = Date.now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { fs.closeSync(fd); }
      // stillOwned() — a fresh read confirming OUR token is still the one at
      // lockPath right now. Exposed as a property on `release` (not a
      // second return value) so the primary "acquire returns release() |
      // null" shape callers already rely on is unchanged; it's an add-on
      // capability, not a different contract.
      function stillOwned() {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          return !!(cur && cur.token === token);
        } catch (_) { return false; }
      }
      const release = function release() {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (cur && cur.token === token) fs.unlinkSync(lockPath);
        } catch (_) { /* not ours / unreadable -> leave it; a later dead-or-stale reclaim cleans it up */ }
      };
      release.stillOwned = stillOwned;
      return release;
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
        // Reconfirm identity IMMEDIATELY before touching the filesystem —
        // one more fresh read, taken as close to the actual steal as
        // possible, with no vacancy created either side of it. This is what
        // actually closes the residual two-(or-more)-stealer chain; see the
        // "RESIDUAL TOCTOU" comment above. A first version of this fix did
        // the rename FIRST and decided identity AFTER (rename, then parse,
        // then compare, then maybe restore) — that left lockPath genuinely
        // EMPTY for the whole verify-and-maybe-restore window, and that
        // vacancy is not just exploitable by another stealer racing the SAME
        // holder: ANY unrelated caller's ordinary `openSync(lockPath,'wx')`
        // can legitimately move into it. Reproduced directly (4-worker and
        // 40-worker instrumented traces): stealer A vacates lockPath,
        // legitimate acquirer C creates a fresh live lock in the gap, THEN
        // stealer B's post-rename verify (still comparing against the
        // original dead holder it identified, not against C) finds a
        // mismatch and tries to restore — but `fs.linkSync` back to lockPath
        // fails EEXIST because C is already there, so B's stolen file (which
        // was actually C's live lock, captured out from under it) has
        // nowhere left to go and gets discarded. C now believes it holds the
        // lock; nothing does. Two believed-held locks can never both be
        // satisfied by one mutable path once that happens — restoring
        // AFTER the fact cannot undo it, so the fix is to make the vacancy
        // itself far less likely to be observed empty-handed: reconfirm
        // BEFORE vacating, so the common case never creates a vacancy at
        // all (a stale reading that's gone stale-r or already reclaimed is
        // caught here and the attempt just retries, untouched).
        let recheck = null;
        try { recheck = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) { recheck = null; }
        const stillMatches = holder
          ? (!!recheck && (
              (typeof holder.token === 'string' && typeof recheck.token === 'string')
                ? recheck.token === holder.token
                : (recheck.pid === holder.pid && recheck.ts === holder.ts)
            ))
          : recheck === null; // torn-read case: must still be unparsable right now to count as the same abandoned file
        if (!stillMatches) continue; // holder changed since identification -> not positively ours; retry fresh, nothing touched

        // Reconfirmed an instant ago -> reclaim via an atomic rename-based
        // capture. Of any attempts racing this same reclaim, exactly one
        // rename can succeed against a given source path; the rest get
        // ENOENT and retry untouched. The captured file is verified once
        // more against the reconfirmed snapshot (covering the now much
        // narrower window between the reconfirm read and this rename call)
        // before being discarded — a mismatch here means even the reconfirm
        // was beaten by another acquirer in that narrower window, so it's
        // restored rather than dropped, same reasoning as before: linkSync
        // is itself non-clobbering (EEXIST means a newer holder has already
        // reoccupied lockPath, nothing to restore onto, that's fine).
        const stealPath = lockPath + '.steal.' + token;
        let renamed = false;
        try { fs.renameSync(lockPath, stealPath); renamed = true; } catch (_) { /* lost the race for the path itself */ }
        if (!renamed) continue;
        let moved = null;
        try { moved = JSON.parse(fs.readFileSync(stealPath, 'utf8')); } catch (_) { moved = null; }
        const captureMatches = recheck
          ? (!!moved && (
              (typeof recheck.token === 'string' && typeof moved.token === 'string')
                ? moved.token === recheck.token
                : (moved.pid === recheck.pid && moved.ts === recheck.ts)
            ))
          : moved === null;
        if (captureMatches) {
          try { fs.unlinkSync(stealPath); } catch (_) {}
          continue; // reclaimed a positively-identified dead/stale/torn holder's lock
        }
        try { fs.linkSync(stealPath, lockPath); } catch (_) {}
        try { fs.unlinkSync(stealPath); } catch (_) {}
        continue; // never take the lock on a mismatch — just keep retrying
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
//
// PRE-COMMIT OWNERSHIP CHECK + RETRY (closes the gap acquireReplyLock's own
// comment documents it cannot close by itself): acquiring the lock only
// proves we held it at the moment acquireReplyLock returned. Everything in
// between — reading the prior state and building the merged write — never
// re-checked that. Empirically (worker_threads stress test, both 4- and
// 40-way), another attempt's steal-branch mismatch/restore can still
// occasionally yank the lockfile out from under a holder who is already
// past the acquire step and has no way to notice on its own.
// `release.stillOwned()` (a fresh read of the lockfile, same token check
// `release()` itself already does) catches this right before the commit: if
// our token is no longer the one at lockPath, our read-modify-write is
// stale and must not be committed. Rather than just dropping the write here
// (which would trade "corrupted" for "silently missing," still a real
// reply the gate would keep treating as unanswered), it discards its own
// staging file and retries the whole acquire-read-write cycle fresh,
// bounded by RECORD_REPLY_MAX_ATTEMPTS.
//
// PER-ATTEMPT STAGING PATH (found empirically, not reasoned about — see
// below): `stillOwned()` alone was NOT enough. Every attempt originally
// staged its write at the SAME fixed path, `p + '.tmp'`, shared across every
// concurrent recordReply call for a given repoKey — the assumption being
// that the lock alone made that safe, since only the "current holder"
// should ever be touching it. But an attempt that has JUST lost ownership
// still executes fs.writeFileSync(tmp, ...) UNCONDITIONALLY, before it ever
// checks stillOwned() — the check only gates the FINAL commit, not the
// staging write. Instrumented traces caught it directly: attempt A
// (legitimately holding the lock, `stillOwned()` about to read true) writes
// its content to the shared tmp path; attempt B — which lost ownership in
// the same narrow window acquireReplyLock's own comments describe — reaches
// its own "not owned, discard" branch and calls `fs.unlinkSync` on that
// SAME shared path, deleting A's in-flight write out from under it. A's own
// subsequent `fs.renameSync(tmp, p)` then throws ENOENT and A's whole write
// is lost — the identical symptom the original P0 fix was built to prevent,
// just reached through the staging file instead of the lock file. Giving
// every attempt its OWN uniquely-named staging path removes this
// interference structurally: no other attempt, past or present, legitimate
// or not, can ever reference this attempt's staging file, so nothing but
// this attempt's own code can write or remove it. `stillOwned()` is still
// necessary on top of that — it stops an attempt whose lock was legitimately
// reclaimed by someone else from clobbering that someone else's newer,
// already-committed state with its own stale snapshot.
// recordReplyTmpCounter — module-level, folded into every staging path below
// alongside pid + timestamp + random, matching this repo's own established
// convention for per-call-unique tmp staging (devswarm-store.js's
// summaryTmpCounter, guarded by "writeSummaryAtomic stages to a UNIQUE tmp
// path per call" in tests/companion/devswarm-store.test.js). A counter alone
// is NOT sufficient here the way it is there: this function is raced across
// real worker_threads (see the steal-CAS tests above), and each worker
// thread gets its OWN module instance with its OWN counter starting back at
// 0 — sharing process.pid with every other racing thread. Counter+pid alone
// would therefore collide in lockstep across threads (thread A's 3rd call
// and thread B's 3rd call would both land on the same path). The
// timestamp+random suffix is what actually carries the cross-thread
// uniqueness guarantee (proven by the steal-CAS tests above running clean
// at N=40 concurrent OS threads); the counter is added on top of that, not
// instead of it, so a single thread issuing several calls in the same
// millisecond (where Date.now() alone would tie) still gets a monotonically
// distinct path without relying on Math.random() to break the tie.
let recordReplyTmpCounter = 0;

// --- opportunistic stale-staging sweep (P2 fix, deadly-loop wave 2b) -------
// recordReply's per-call-unique staging path (see "PER-ATTEMPT STAGING PATH"
// above) and the lock's per-attempt steal path (acquireReplyLock's
// `stealPath = lockPath + '.steal.' + token`) were both deliberately made
// UNIQUE per attempt to close two lost-write races (see the comments on
// those fixes). That fix has a cost the older shared-path scheme never had:
// a shared `p + '.tmp'` was self-healing (the next writer's write simply
// overwrote it), but a uniquely-named file is NEVER overwritten by anything
// else. If a process dies between creating one of these files and its own
// cleanup — most realistically the parent-reply-tracker hook getting
// SIGKILLed at its 10s hook timeout mid-recordReply, or death between
// renameSync and unlinkSync in the lock's steal branch — that file is
// orphaned forever. Correctness is unaffected either way (lockPath itself
// always ends up free one way or another; a commit either landed before the
// death or it didn't), so this is purely unbounded disk growth over the life
// of a project, not a correctness bug. This sweep is the cleanup.
//
// SWEEP_STALE_MS is deliberately set FAR above REPLY_LOCK_STALE_MS (10s):
// the lock's own staleness window bounds how long a LOCK HOLDER can be
// presumed dead, but the files this sweep removes are staging/steal
// artifacts whose entire legitimate lifetime is a handful of synchronous fs
// calls (write+rename, or rename+read+unlink) — normally sub-millisecond,
// worst case maybe low seconds under a badly thrashing disk. 60s is a full
// order of magnitude past REPLY_LOCK_STALE_MS and several orders of
// magnitude past any legitimate in-flight window, so a file old enough for
// this sweep to remove can only be a genuine orphan from a dead process — a
// LIVE writer's file can never reach this age while the writer is still
// running. That is the safety property the whole fix rests on: never delete
// something a live process might still be about to rename/read, and it is
// stated here explicitly because it is the entire justification for the
// threshold, not just a number picked out of the air.
const SWEEP_STALE_MS = 60 * 1000;

// sweepStaleSiblings(p) — best-effort, fail-open, ONE readdir + a stat+unlink
// per match, no recursion (cheap: this sits on the hot Stop-hook path via
// recordReply). Scoped STRICTLY to files that start with THIS state file's
// own basename followed by '.tmp.' or '.lock.steal.' — matching recordReply's
// and acquireReplyLock's actual staging-path prefixes exactly, so it can
// never touch: the `.lock` file itself (no match — '.lock' alone is not a
// '.lock.steal.' prefix), a DIFFERENT repoKey's state file or its siblings in
// the same directory (different basename -> different prefix, no match), or
// anything else in `~/.anti-hall/devswarm/parent-gate/` unrelated to this
// exact state file. A readdir/stat/unlink failure (permissions, a
// concurrent process winning a delete race, etc.) is swallowed per-entry or
// per-call — this function must never throw, matching this module's
// documented "never throws" contract.
function sweepStaleSiblings(p) {
  try {
    const dir = path.dirname(p);
    const base = path.basename(p);
    const tmpPrefix = base + '.tmp.';
    const stealPrefix = base + '.lock.steal.';
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    const now = Date.now();
    for (const name of names) {
      if (name.indexOf(tmpPrefix) !== 0 && name.indexOf(stealPrefix) !== 0) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if ((now - st.mtimeMs) > SWEEP_STALE_MS) fs.unlinkSync(full);
      } catch (_) { /* stat/unlink race (already gone) or unexpected error -> skip; next sweep catches it */ }
    }
  } catch (_) { /* best-effort; never throw */ }
}

// --- MEASURED RESIDUAL: stillOwned()->rename commit gap (accepted, NOT fixed) ---
// Even with everything above (CAS steal, per-attempt staging, the sweep),
// `release.stillOwned()` and `fs.renameSync(tmp, p)` just below are still TWO
// SEPARATE SYSCALLS with no atomicity between them. If lock ownership changes
// hands in that exact window — stillOwned() reads true, then before the
// renameSync actually executes a new holder legitimately steals the lock and
// commits its own newer entry — this attempt's rename could still proceed
// and clobber that newer holder's already-landed write. stillOwned() proves
// ownership AT THE MOMENT IT WAS CHECKED, not at the moment the rename
// actually lands a few instructions later; no combination of rename/link/
// unlink can close that window — closing it for real needs OS-level mutual
// exclusion (flock), which this module deliberately does not take on (see
// the header: "Pure fs; never opens the store DB", and every lock primitive
// here is intentionally self-contained rather than importing
// devswarm-store.js's own locking). This paragraph describes a real,
// still-open, still-theoretical gap; the paragraph below corrects what was
// previously claimed about how often it actually fires.
//
// CORRECTED ATTRIBUTION (retracts an earlier version of this comment that
// blamed the gap above for measured stress-test failures): stress runs of
// the steal-CAS test (tests/companion/devswarm-reply-state.test.js, the
// 2-worker/40-round test) did fail intermittently, but tracing every
// observed failure found the retry-budget-EXHAUSTION signature —
// acquireReplyLock returning null after ~4000-4800ms, matching this file's
// 1200-try x ~5ms worst-case backoff budget — never a clobber signature. An
// exhausted call never enters the critical section at all: it returns at
// `if (!release) return;` below, so nothing is written and nothing is
// clobbered. A skipped write and a clobbered write fail the exact same test
// assertion ("both entries must survive the steal race", actual 1 expected
// 2) and are indistinguishable from that assertion alone, which is how they
// were conflated in the earlier version of this comment. Two independent,
// unrelated causes of that exhaustion signature were found and fixed: the
// test harness was re-spawning 2 fresh worker_threads PER ROUND (~80 thread
// creates across the run), starving later rounds on its own — now a
// persistent worker pool (tests/helpers/reply-state-persistent-race-
// worker.js); and replyLockSleep (below) was allocating a fresh
// SharedArrayBuffer(4) on every backoff retry, up to ~1200x per call, and
// that allocator pressure drove genuine retry-budget exhaustion in later
// tests sharing the same process — now a single reused module-level buffer.
// The earlier "15%" (3/20) and a separately reported "9/20" figures were
// both gathered on a machine simultaneously running many parallel agents and
// repeated full test suites; contention-driven exhaustion is exactly what
// that inflates, so neither number was a clean measurement, and neither is a
// production incidence rate.
// HONEST LIMIT: no check was ever built that would positively CONFIRM a
// clobber (e.g. comparing written content across two successful commits
// landing in the same round), so a clobber is NOT ruled out by any of this —
// there is simply zero positive evidence one has occurred. The theoretical
// window in the paragraph above is unchanged and still unfixed; only the
// attribution of the MEASURED stress-test failures to that window is
// retracted here. Separately, the earlier claim that this reproduces with as
// few as TWO concurrent writers (not just "40 concurrent threads / beyond
// realistic load") still stands for the phenomenon actually observed —
// retry-budget exhaustion reproduced at 2 workers after a crash leaves a
// stale lock behind (the seeded dead-holder scenario the steal-CAS tests
// construct) — it does not stand as evidence of a clobber at 2 workers,
// because no clobber was observed at any worker count.
//
// IMPACT DIRECTION (always this way, never the other): fail-open. Whether a
// write is skipped (retry-budget exhaustion — the only mechanism actually
// observed) or, in the still-open theoretical window above, a write is
// clobbered, the consequence is the same: a reply record is lost, not the
// pendingQuestions data itself. Losing it means one already-answered
// question is treated as still unanswered, so the parent Stop-gate nags one
// extra time next round. It is NEVER corruption of the state file, NEVER two
// holders' writes both silently vanishing, and NEVER an orphaned lock/
// staging file left behind — every failure mode observed or theorized lands
// on "one skipped write, gate re-nags," nothing worse.
//
// WHY NOT FIXED HERE: fully closing the theoretical stillOwned()->rename
// window requires either (a) flock — real OS-level locking, out of scope for
// a pure-fs module — or (b) redesigning recordReply from read-modify-write to
// APPEND-ONLY: each call appends a small `{meshId, ts}` record instead of
// rewriting the whole merged state, and readers fold the log down to "max ts
// per sender" on read. Appends to a unique-per-call path can never race each
// other the way a shared read-modify-write can, which would make a lost
// update structurally impossible rather than merely rare. That is
// deliberately deferred to a follow-up, not done here, because it changes
// this file's ON-DISK SHAPE (single merged JSON object -> an append log) and
// any persisted-shape change needs a real forward-migration path for
// existing state files, which is its own change, not a drive-by inside this
// hardening pass.
const RECORD_REPLY_MAX_ATTEMPTS = 25;
function recordReply(repoKey, home, meshId, ts) {
  let p;
  try {
    p = replyStatePathFor(repoKey, home);
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch (_) { return; }

  // Swept ONCE per recordReply call (not on every retry-loop attempt, and
  // not on the read-only paths readReplyState/unansweredQuestions) — this is
  // the one place recordReply is already guaranteed to touch the filesystem
  // (mkdir just above), so piggybacking the sweep here adds no new hot-path
  // touch beyond what recordReply already does, while still running often
  // enough (every reply recorded) that orphans never accumulate for long.
  sweepStaleSiblings(p);

  for (let attempt = 0; attempt < RECORD_REPLY_MAX_ATTEMPTS; attempt++) {
    let release = null;
    let committed = false;
    let tmp = null; // hoisted OUTSIDE the inner try so the catch below can always find it and clean up, on ANY exception path (write, stillOwned, or rename), not just the ordinary discard-and-retry branch
    try {
      release = acquireReplyLock(p + '.lock');
      if (!release) return; // lock unavailable -> fail open, skip this write (never write unlocked)
      const state = readReplyState(repoKey, home);
      const prior = state[meshId] && Number.isFinite(state[meshId].lastReplyTs) ? state[meshId].lastReplyTs : 0;
      state[meshId] = { lastReplyTs: Math.max(Number(ts) || 0, prior) };
      tmp = p + '.tmp.' + process.pid + '.' + (recordReplyTmpCounter++) + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
      fs.writeFileSync(tmp, JSON.stringify(state));
      // MEASURED RESIDUAL (see the block above RECORD_REPLY_MAX_ATTEMPTS):
      // stillOwned() and renameSync are two separate syscalls, not one
      // atomic check-and-commit — a steal landing in between could still let
      // this rename clobber a newer holder's already-committed write. That
      // window is still open and unfixed, but no stress run has ever
      // positively confirmed a clobber happening here — traced stress
      // failures were all retry-budget exhaustion instead (see the block
      // above); a clobber is unevidenced, not ruled out.
      if (release.stillOwned()) {
        fs.renameSync(tmp, p);
        committed = true;
      } else {
        try { fs.unlinkSync(tmp); } catch (_) {} // stale write, discard and retry below
      }
    } catch (_) {
      // Any failure past the point `tmp` was assigned (writeFileSync,
      // stillOwned, or renameSync throwing) must not leak the staged file —
      // unlike the shared-path era, a leaked unique-named tmp never gets
      // silently overwritten by the next attempt, so this cleanup is load-
      // bearing, not cosmetic.
      if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    }
    finally {
      if (release) { try { release(); } catch (_) {} }
    }
    if (committed) return;
  }
  // Retry budget exhausted -> fail open, matching every other path in this
  // function: a skipped write just means the gate may nag one extra time.
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
