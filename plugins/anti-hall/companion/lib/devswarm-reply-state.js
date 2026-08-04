'use strict';
// devswarm-reply-state — PER-PROJECT (not per-session) record of observed
// replies (PLAN §4.3), keyed by sender meshId, used by the parent Stop-gate to
// tell "read" apart from "decided and replied" so an unanswered child
// question keeps blocking past the forced-ack cap. Pure fs; never opens the
// store DB.
//
// APPEND-ONLY ON DISK (this file's Task #4 redesign — replaces the previous
// single-merged-JSON-object read-modify-write). Each observed reply is written
// as its OWN newline-delimited record `{"m":<meshId>,"t":<ts>}` appended to the
// state file; readers FOLD the whole log down to "max ts per sender" on read.
// This structurally eliminates the read-modify-write TOCTOU the merged-object
// shape had:
//
//   * The old shape read the whole `{ [meshId]: { lastReplyTs } }` object,
//     merged one entry in memory, and wrote the whole object back. Two
//     processes racing that on the same file could each read the pre-write
//     state, each merge their own entry, then each write back — the SECOND
//     write clobbering the FIRST, silently losing a reply. An entire lockfile
//     apparatus (O_EXCL acquire + CAS-steal + pre-commit stillOwned() recheck +
//     per-attempt staging + orphan sweep) existed only to narrow that window,
//     and its own comments documented a residual it could never fully close
//     with pure-fs primitives (a stillOwned()->rename gap that needs flock).
//
//   * Append-only has no read-modify-write to race. `recordReply` does a single
//     `fs.appendFileSync(path, record)` with the 'a' flag (O_APPEND). POSIX
//     guarantees a write to an O_APPEND fd goes to the current end-of-file
//     ATOMICALLY when the payload is <= PIPE_BUF (>=512 bytes by POSIX, 4096 on
//     Linux/macOS) — and a reply record is a few dozen bytes — so concurrent
//     appends can never interleave or overwrite each other. No lock is needed,
//     so none is taken. A lost update is now STRUCTURALLY impossible rather than
//     merely rare, which is exactly what the old code's "MEASURED RESIDUAL /
//     WHY NOT FIXED HERE: redesign to APPEND-ONLY" comment deferred to this
//     change.
//
// FAIL-OPEN, EVERY PATH (unchanged contract): a read fails open toward {} on
// any parse/shape/IO surprise; a write swallows every error; a null/
// unresolvable repoKey is a safe no-op (no file/dir ever created). The
// consequence of any dropped write is always the same benign direction — one
// already-answered question is treated as still-unanswered, so the parent
// Stop-gate nags one extra time next round. Never corruption.
//
// BACKWARD-COMPATIBLE READER (why migration is normalization, not correctness):
// foldReplyLog below tolerates, in the SAME file, both the new append records
// AND the legacy single merged-object `{ [meshId]: { lastReplyTs } }` line, and
// any MIX of the two (a legacy file that a new-code append has since added a
// record to). So an old state file keeps folding correctly even before the
// forward migration runs, and appending onto an un-migrated file is lossless.
// migrateReplyState() below normalizes old files to pure append-only shape, but
// the reader never depends on it having run.
//
// SCOPING: keyed by a durable PROJECT-scoped `repoKey` (companion/lib/
// devswarm-repokey.js's repoKeyForWorktree — the same per-project identity
// devswarm-parent-gate.js and devswarm-parent-inbox.js already resolve for
// their own per-project state), NOT a short-lived Claude session_id: a
// pendingQuestion derived from a workspace's full message history is permanent
// and never clears on its own, so the reply record that clears it must have the
// same durable, per-project lifetime (else every new session starts with empty
// reply-state and every historically-answered question resurrects as
// unanswered — the original per-session_id bug).

const fs = require('fs');
const path = require('path');

// replyStatePathFor(repoKey, home) — co-located with devswarm-parent-gate.js's
// stateFileFor, same id-sanitization regex, "-replies" suffix distinguishes it.
// `repoKey` is a durable per-project key (repoKeyForWorktree), NOT a Claude
// session_id. The path/filename is UNCHANGED across the append-only redesign
// (the file now holds newline-delimited records instead of one JSON object) so
// there is no path migration — only an in-place content normalization.
//
// NULL/UNRESOLVABLE KEY: a falsy `repoKey` returns null, NOT a path sanitized
// from a literal fallback like 'norepo'. A shared literal bucket would let two
// UNRELATED projects that both hit an unresolvable-key condition read/write the
// SAME file — a cross-project state bleed. Callers treat a null path as "no
// persisted state available": a read fails open toward {} and a write is a
// no-op — no file is ever created or touched.
function replyStatePathFor(repoKey, home) {
  if (!repoKey) return null;
  const safe = String(repoKey).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(home, '.anti-hall', 'devswarm', 'parent-gate', safe + '-replies.json');
}

// isAppendRecord(o) — true iff o is a plain object of the append shape
// `{ m: <string meshId>, t: <finite ts> }`. The two discriminators (a STRING
// `m` and a FINITE `t`) can never collide with a legacy merged-map object,
// whose VALUES are objects (`{ lastReplyTs }`) and which has no top-level
// finite `t`: even a legacy map that literally keys a sender named "m" stores
// an OBJECT at o.m, so `typeof o.m === 'string'` is false for it.
function isAppendRecord(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o)
    && typeof o.m === 'string' && Number.isFinite(o.t);
}

// foldReplyLog(raw) -> { [meshId]: { lastReplyTs } }. The single fold used by
// both readReplyState and migrateReplyState. Splits on newlines and folds each
// parseable line to max-ts-per-sender. Tolerant of: pure append-only logs, a
// legacy single merged-object line, and any mix of the two. Every per-line
// surprise (unparseable JSON, array, wrong shape) is skipped, never thrown —
// the same fail-open-toward-{} posture the whole module keeps.
function foldReplyLog(raw) {
  // NULL-PROTOTYPE accumulator (not a plain `{}`): a sender id can legitimately
  // be any isSafeId-permitted string, INCLUDING `__proto__`, `constructor`, or
  // `prototype` (the id regex allows underscores). On a plain `{}`, assigning
  // `out['__proto__'] = ...` would mutate the object's PROTOTYPE instead of
  // creating an own key — the entry would then vanish from Object.keys(out) and
  // be silently dropped on both read and re-serialization. Object.create(null)
  // has no prototype, so every sender string is stored as a real own key and
  // survives folding, reading, and migration serialization.
  const out = Object.create(null);
  const bump = (meshId, ts) => {
    if (typeof meshId !== 'string' || !meshId || !Number.isFinite(ts)) return;
    const prior = out[meshId] && Number.isFinite(out[meshId].lastReplyTs) ? out[meshId].lastReplyTs : -Infinity;
    if (ts > prior) out[meshId] = { lastReplyTs: ts };
    else if (!out[meshId]) out[meshId] = { lastReplyTs: ts };
  };
  const lines = String(raw).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch (_) { continue; } // skip an unparseable line, keep the rest
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (isAppendRecord(o)) {
      bump(o.m, o.t);
    } else {
      // Legacy merged-map line: { [meshId]: { lastReplyTs } }.
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object' && Number.isFinite(v.lastReplyTs)) bump(k, v.lastReplyTs);
      }
    }
  }
  return out;
}

// readReplyState(repoKey, home) -> { [meshId]: { lastReplyTs } }. Fail-open:
// missing file, unreadable file, or any malformed content all yield {} (or the
// successfully-folded subset) — never throws. A null/unresolvable repoKey
// yields {} without touching disk.
function readReplyState(repoKey, home) {
  try {
    const p = replyStatePathFor(repoKey, home);
    if (!p) return {};
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return {}; }
    return foldReplyLog(raw);
  } catch (_) {
    return {};
  }
}

// recordReply(repoKey, home, meshId, ts) — appends ONE `{"m":meshId,"t":ts}`
// record. Lock-free by construction (see the header): a single O_APPEND write
// of a sub-PIPE_BUF payload is atomic, so concurrent writers cannot lose each
// other. Best-effort: any error (including IO failure) is swallowed — a skipped
// write just means the gate may nag one extra time, the safe direction. A
// null/unresolvable repoKey, a non-string/empty meshId, or a non-finite ts are
// all safe no-ops (no file/dir ever created for a null key; a bad meshId/ts is
// simply not recorded rather than written as garbage).
function recordReply(repoKey, home, meshId, ts) {
  try {
    if (typeof meshId !== 'string' || !meshId) return;
    const p = replyStatePathFor(repoKey, home);
    if (!p) return;
    const t = Number(ts);
    if (!Number.isFinite(t)) return;
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) { return; }
    // JSON.stringify a fixed-key object -> compact single-line record. meshId+ts
    // is a few dozen bytes.
    const record = JSON.stringify({ m: meshId, t }) + '\n';
    // LEGACY-LINE SEPARATION (no-loss append onto an un-migrated file), FAIL-CLOSED:
    // a legacy reply-file was written by the old code as `JSON.stringify(state)`
    // with NO trailing newline (a single line `{"<meshId>":{"lastReplyTs":N}}`).
    // If the forward migration has not yet run, appending our record directly
    // would concatenate onto that line -> `{...}{"m":...}` = invalid JSON on line
    // 1, which foldReplyLog then skips, losing BOTH the legacy state AND this
    // reply.
    //
    // The separator decision FAILS CLOSED (safe direction): we DEFAULT to
    // prepending the '\n' and only SKIP it when we have POSITIVELY confirmed the
    // file is empty/absent or already ends in '\n'. A leading blank line on an
    // already-\n-terminated (or empty/fresh) file is harmless — foldReplyLog
    // skips empty lines — so defaulting to the prepend on ANY read uncertainty
    // costs nothing, whereas the OLD fail-OPEN default (append with NO separator
    // whenever the last-byte read threw) could concatenate onto an un-terminated
    // legacy line and recur the exact data-loss above. So: a stat/open/read error,
    // or a short read, keeps needSep=true (prepend); only a size-0 file, a missing
    // file (ENOENT), or a byte we actually read AND confirmed to be 0x0a clears it.
    let needSep = true; // safe default: assume a separator is needed
    try {
      const st = fs.statSync(p);
      if (st.size === 0) {
        needSep = false; // positively empty -> appendFileSync starts a fresh file
      } else {
        const fd = fs.openSync(p, 'r');
        try {
          const last = Buffer.alloc(1);
          const n = fs.readSync(fd, last, 0, 1, st.size - 1);
          // Only a CONFIRMED trailing newline (exactly one byte read, value 0x0a)
          // clears the separator; a short/failed read stays fail-closed.
          if (n === 1 && last[0] === 0x0a) needSep = false; // 0x0a === '\n'
        } finally { fs.closeSync(fd); }
      }
    } catch (e) {
      // ENOENT = file absent = positively empty -> no separator needed. ANY other
      // error (unreadable, IO) is UNCERTAIN -> stay fail-closed (keep the prepend).
      if (e && e.code === 'ENOENT') needSep = false;
    }
    const payload = needSep ? '\n' + record : record;
    // SIZE CAP (atomicity guard) — measured on the FULL assembled line ACTUALLY
    // WRITTEN, including the trailing '\n' AND any prepended leading '\n'. POSIX
    // guarantees an O_APPEND write is atomic — never interleaved with a concurrent
    // append — ONLY when the payload is <= PIPE_BUF (512 bytes by POSIX minimum).
    // A write past that could tear across a concurrent writer, corrupting BOTH
    // lines. The cap is set COMFORTABLY BELOW that 512-byte bound (480) so the
    // exact bytes we hand to appendFileSync — leading sep + record + trailing '\n'
    // — are always within the atomicity guarantee, not merely the record body.
    // A legitimate meshId+ts is tiny; anything assembling past 480 is pathological,
    // so we DO NOT write a torn/oversized append at all — skip it (fail-open: the
    // gate treats the question as still-unanswered and nags one extra time, the
    // safe direction), never risk corrupting the file.
    const RECORD_BYTE_CAP = 480;
    if (Buffer.byteLength(payload, 'utf8') > RECORD_BYTE_CAP) return;
    fs.appendFileSync(p, payload); // flag 'a' (O_APPEND|O_CREAT|O_WRONLY) — atomic append
  } catch (_) { /* best-effort; never throw */ }
}

// unansweredQuestions(pendingQuestions, replyState) -> subset of pendingQuestions
// whose ts is strictly after that sender's lastReplyTs (no entry -> unanswered).
// Pure, fail-open TOWARD unanswered on any malformed shape — never drop a real
// question because of a shape surprise. Never throws. UNCHANGED by the
// append-only redesign (it consumes the folded {meshId:{lastReplyTs}} shape
// readReplyState still returns).
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

// --- forward migration (persisted-shape discipline) -------------------------
// migrateReplyState(home, { dryRun }) — normalizes every existing reply-state
// file under ~/.anti-hall/devswarm/parent-gate/*-replies.json from the LEGACY
// single-merged-object shape (`{ [meshId]: { lastReplyTs } }`, the only shape
// ever released — v0.69.0 through v0.70.1) to the new append-only JSONL shape,
// LOSSLESSLY (each surviving sender keeps its max lastReplyTs).
//
// Enumerated prior forms (all covered by the ONE fold, since foldReplyLog reads
// every historical shape):
//   (1) legacy merged-object, repoKey-keyed filename — the only RELEASED form.
//   (2) legacy merged-object at a session_id-keyed filename — a pre-release dev
//       form that never shipped; if any such file exists it is folded in place
//       exactly the same way (the internal shape is identical; only the
//       filename differed, and the migration operates on every *-replies.json
//       regardless of how its basename was keyed).
//   (3) an already-append-only file (a partially- or previously-migrated
//       file) — detected and SKIPPED (idempotent).
//   (4) a mixed legacy-line + appended-records file — folded and normalized.
//
// Contract: IDEMPOTENT (a pure append-only file is detected via
// needsMigration() and skipped — re-running converts nothing), FAIL-OPEN
// (never throws; a per-file error is counted and skipped, the migration keeps
// going), NO-DELETE (folding preserves every sender's max lastReplyTs; nothing
// is dropped — an unparseable line is the only thing not carried forward, and
// such a line was never valid state the reader could have used anyway). The
// rewrite is atomic (unique tmp + rename). A concurrent live append racing the
// one-time rewrite is a benign, documented, fail-open loss (one nag) — and the
// reader is backward-compatible either way, so this migration is normalization,
// not a correctness prerequisite.
//
// Returns { scanned, migrated, alreadyAppendOnly, pending, errors }. In dryRun,
// nothing is written and `pending` counts files that WOULD be converted.
function needsMigration(raw) {
  // A file needs conversion iff it has at least one non-empty line that is NOT
  // already an append record (i.e., a legacy merged-map line, or a stray
  // object). A file whose every non-empty line is an append record — including
  // a fully-empty file (zero lines) — is already normalized.
  const lines = String(raw).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch (_) { return true; } // an unparseable line -> rewrite to drop it cleanly
    if (!isAppendRecord(o)) return true;
  }
  return false;
}

function migrateReplyState(home, opts) {
  const o = opts || {};
  const dryRun = !!o.dryRun;
  const report = { scanned: 0, migrated: 0, alreadyAppendOnly: 0, pending: 0, errors: 0 };
  let dir;
  try {
    dir = path.join(home || '', '.anti-hall', 'devswarm', 'parent-gate');
  } catch (_) { return report; }
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return report; } // no dir -> nothing to migrate
  for (const name of names) {
    if (!/-replies\.json$/.test(name)) continue;
    const p = path.join(dir, name);
    report.scanned++;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) { report.scanned--; continue; }
      const raw = fs.readFileSync(p, 'utf8');
      if (!needsMigration(raw)) { report.alreadyAppendOnly++; continue; }
      report.pending++;
      if (dryRun) continue;
      // Deterministic serialization (sorted meshId) so a re-run of the SAME
      // state produces byte-identical output — no needless churn, easy to diff.
      const serialize = (folded) => Object.keys(folded)
        .sort()
        .map((m) => JSON.stringify({ m, t: folded[m].lastReplyTs }) + '\n')
        .join('');
      // RE-READ-BEFORE-RENAME CONVERGENCE (no-loss migration): the rename below
      // REPLACES the source file, so any live `recordReply` append that landed
      // between our snapshot read (`raw`, above) and the rename would be dropped
      // by the replace — a NO-DELETE violation. Before each rename we RE-READ the
      // source: if it grew (late records arrived since we last folded), we fold
      // those late records in too and rewrite the tmp, then try again. Bounded to
      // a few passes; if it still won't stabilize we ABORT this file (leave it
      // exactly as-is — the backward-compatible reader still folds it correctly)
      // rather than risk losing a late append. Idempotent and fail-open either
      // way. A record arriving in the tiny window after the final re-read but
      // before the rename is the documented benign residual (one extra nag),
      // same fail-open direction the whole module keeps.
      const MAX_PASSES = 3;
      let current = raw;
      let done = false;
      for (let pass = 0; pass < MAX_PASSES && !done; pass++) {
        const body = serialize(foldReplyLog(current)); // lossless: max ts per sender
        const tmp = p + '.migrate.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
        try {
          fs.writeFileSync(tmp, body);
          // Re-read the source to catch a late append that raced this rewrite.
          // FAIL-CLOSED (C2): a re-read that THROWS means we CANNOT confirm the
          // source is unchanged — so we must NOT rename over it (the rename
          // REPLACES the source; renaming on an unverified source could discard
          // late appends = a NO-DELETE violation / lost reply). An uncertain
          // re-read ABORTS this file: leave the source exactly as-is (the
          // backward-compatible foldReplyLog reader still folds it correctly),
          // count it as an error, and never rename. Only an unchanged source that
          // we POSITIVELY re-read authorizes the atomic replace.
          let latest;
          let reReadFailed = false;
          try { latest = fs.readFileSync(p, 'utf8'); } catch (_) { reReadFailed = true; }
          if (reReadFailed) {
            report.errors++;
            done = true; // abort on uncertain re-read; source left untouched
          } else if (latest === current) {
            // ACCEPTED SAFE RESIDUAL (final-window race — do NOT try to close it):
            // a live recordReply append that lands in the tiny window AFTER this
            // re-read but BEFORE the renameSync below is dropped by the atomic
            // replace. This cannot be closed lock-free — reconfirm and rename are
            // two separate syscalls with no atomicity between them, and this
            // module deliberately takes NO lock (the whole append-only redesign
            // exists to be lock-free; reintroducing an O_EXCL/CAS lockfile here
            // would defeat it). The ONLY consequence is one lost reply record ->
            // the gate treats that one question as still-unanswered -> ONE EXTRA
            // NAG next Stop. That is the same fail-open/fail-SAFE direction the
            // whole module keeps: it can never let a genuinely-unanswered question
            // slip THROUGH the Stop-gate, only ever cause one redundant nag. Left
            // as a documented, bounded, benign residual — consistent with the
            // originally-disclosed fail-open.
            fs.renameSync(tmp, p); // atomic replace — source unchanged since fold
            report.migrated++;
            done = true;
          } else {
            // Late append landed: re-fold including it and retry (tmp is reclaimed
            // by the unconditional finally below).
            current = latest;
          }
        } catch (e) {
          report.errors++;
          done = true; // give up on this file; leave the source untouched
        } finally {
          // UNCONDITIONAL tmp cleanup (E2), every exit path: success, abort,
          // retry, or a thrown write. On the success path renameSync already moved
          // tmp to p, so this unlink is a harmless ENOENT; on every other path it
          // reclaims the `.migrate` sidecar that a uniquely-named tmp would
          // otherwise leak forever (nothing else ever overwrites a unique name).
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      }
      if (!done) {
        // Could not converge within the bound: ABORT rather than risk loss.
        // The source file is left exactly as-is (reader stays backward-compatible)
        // and is counted as an error so the caller sees it did not complete.
        report.errors++;
      }
    } catch (_) {
      report.errors++;
    }
  }
  return report;
}

module.exports = {
  replyStatePathFor,
  readReplyState,
  recordReply,
  unansweredQuestions,
  migrateReplyState,
  // exported for direct unit coverage of the fold/dedup + append-record
  // discriminator logic (not part of the consumer-facing contract).
  foldReplyLog,
  isAppendRecord,
};
