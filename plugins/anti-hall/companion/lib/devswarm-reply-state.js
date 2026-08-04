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
  const out = {};
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
    // JSON.stringify a fixed-key object -> compact single-line record. Even a
    // very long meshId keeps this well under PIPE_BUF; a pathological meshId
    // beyond PIPE_BUF could in theory interleave, corrupting at most THIS one
    // line, which foldReplyLog skips — same fail-open direction, never
    // corrupting another sender's record.
    const record = JSON.stringify({ m: meshId, t }) + '\n';
    fs.appendFileSync(p, record); // flag 'a' (O_APPEND|O_CREAT|O_WRONLY) — atomic append
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
      const folded = foldReplyLog(raw); // lossless: max ts per surviving sender
      // Deterministic order (sorted meshId) so a re-run of the SAME state
      // produces byte-identical output — no needless churn, easy to diff.
      const body = Object.keys(folded)
        .sort()
        .map((m) => JSON.stringify({ m, t: folded[m].lastReplyTs }) + '\n')
        .join('');
      const tmp = p + '.migrate.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
      try {
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, p); // atomic replace
        report.migrated++;
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
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
