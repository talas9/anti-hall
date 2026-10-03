'use strict';
// anti-hall :: devswarm CLI — CURSORS module (scripts/devswarm-lib/cursors.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  crypto, devswarmRoot, fs, inboxCursor, isSafeId, isSessionAliveRow, isSiblingPartitionLive, path,
  primaryCursorPath, readerCursors, store, withIdLock,
} = require('./core.js');
const {
  appSessionOnWorktree, callerIdentity, canonicalWorktreeRealPath, declaredSelfId, seatRefusal,
  shortInstanceNonce,
} = require('./identity.js');

// siblingAckGate(storeHandle, callerId, partId, home, now) -> bool (true ==
// LIVE or SELF, skip the ack). Fix Wave 7 Item 1 + Item 2: the ONE
// mesh-sibling cursor-write gate, used by BOTH `cmdInboxMessages`'s
// read-primary/peek-primary ack loop AND `inbox ack`'s own separate
// sibling-store-cursor loop — Wave 6 gated only the former
// (`hasFreshHeartbeat(part.id, home, {now})` inline), leaving `inbox ack`
// (and `--ack-as-owner`) free to drive a live sibling's cursor forward and
// consume its backlog undelivered (reproduced, P0). Factoring this into ONE
// function callable from both sites is what makes a future THIRD surface
// structurally unable to add itself ungated (call this, or diverge visibly in
// review — there is no longer an inline copy to half-port).
//
// Looks up `partId`'s OWN registry row (worktreePath/sessionId) — the
// liveness composition (`isSiblingPartitionLive`, companion/lib/liveness.js)
// needs both, not just the id, to tell a positively-stale real session apart
// from a register-only phantom. A registry-read failure or a row that has
// vanished from `listRegistry()` between the fold and this check is
// UNDETERMINED, not evidence of anything — fails toward LIVE (skip the ack)
// for the same reason `isSiblingPartitionLive` itself fails open: a spurious
// skip only risks a harmless re-delivery, a spurious ack risks permanently
// losing a live sibling's own unread backlog.
//
// IDENTITY-FAMILY EXTENSION (confirmed gap, root-cause trace): the checks
// above evaluate `partId`'s OWN row/heartbeat only — a UUID twin row of the
// SAME agent (crossLinkedIdentity: one row's sessionId IS the other row's
// id — devswarm-identity-family.js) never heartbeats under its own id (only
// its `primary-<hash>` twin does), so it read as NOT live and was drained +
// acked by the sibling loops during the CALLER's own read even when the
// caller and the twin are the SAME agent. Two additional checks, reusing
// devswarm-identity-family.js's crossLinkedIdentity/identityFamilyTwins
// (never a second family notion):
//   (1) SELF: if `partId`'s row is a cross-linked twin of the CALLER's own
//       row, this is not a "sibling" at all — it is the caller's own other
//       identity. WAVE 9 CORRECTION (P1): this branch used to `return true`
//       (skip the ack) on the theory that "the caller's own read/ack path
//       (cursorPath / s.setCursor for callerId) already governs it". That
//       theory is FALSE and caused PERPETUAL RE-DELIVERY. The own-store ack
//       writes exactly two cursors, BOTH keyed on the caller's own id
//       (`inboxCursor.ackTo(cursorPath, ownTarget)` and `s.setCursor(id,
//       acked)`); the twin partition's own cursor pair
//       (`primaryCursorPath(home, twinId)` / `s.setCursor(twinId, …)`) is
//       touched by nothing on this read. Meanwhile the twin's rows ARE folded
//       into `messages` and delivered on EVERY call (the sibling partitions
//       are built before this gate; the gate governs the cursor WRITE only) —
//       so the same rows came back forever and the twin's cursor never moved.
//       A SELF twin is therefore NOT protected here: it returns false so the
//       caller's sibling loop acks it with the SAME ack-target arithmetic
//       every other partition uses (`part.cursor + physicalConsumed`, derived
//       from rows ACTUALLY delivered — loss-free by that same construction,
//       so nothing withheld by a cap can ever be skipped over). This is safe
//       precisely BECAUSE it is SELF: crossLinkedIdentity proves the twin is
//       the caller's own identity, so there is no other reader whose frontier
//       could be swept. Foreign siblings (live, or twin-of-live below) keep
//       their full protection — the gate is not widened for anyone else.
//   (2) TWIN-OF-LIVE: if `partId` itself reads as not-live, but ANY other
//       registry row is a cross-linked twin of `partId` AND that twin reads
//       as live, then `partId` is live (its twin identity is the one
//       actually heartbeating) — return true (skip).
// Any resolution failure (require/registry-read throwing) falls through to
// the pre-existing bare liveness check, never a hard failure — this
// extension can only make the gate MORE conservative (skip more), never
// less (it never turns an existing "live" result into "not live").
function siblingAckGate(storeHandle, callerId, partId, home, now, opts) {
  let idFam = null;
  try { idFam = require('../../companion/lib/devswarm-identity-family.js'); } catch (_) { idFam = null; }
  let registry = [];
  try { registry = storeHandle.listRegistry() || []; } catch (_) { registry = []; }
  const row = registry.find((r) => r && String(r.id) === String(partId));
  if (!row) return true; // vanished from the registry read -> undetermined -> fail toward live
  // PROCESS SELF (dual-partition defect): callerId and partId are the invoking
  // process's two names — its declared DEVSWARM_BUILDER_ID row on its own
  // worktree (declaredSelfId) and its cwd-derived id. Not a sibling: ack it,
  // with the same delivered-prefix arithmetic as every other partition.
  // The cwd-derived name is shared by EVERY process on the worktree, so it is
  // this process's own only when the anchor row carries no session or this
  // process's session (CLAUDE_CODE_SESSION_ID). A child registered on the
  // Primary's worktree fails that test and falls through to the liveness gate —
  // it never acks the live Primary's anchor partition.
  // v0.107.1 (session resume): a resumed Claude Code session gets a NEW session
  // id, but the anchor row keeps the pre-resume one — so the Primary's own
  // anchor read as foreign and its builder partition was never acked (only a
  // caller-scoped `.seen-` watermark moved; tick and read-primary disagreed).
  // The anchor is also ours when its recorded session has NO positively-alive
  // harness process while the CALLER's own session positively is alive
  // (isSessionAliveRow both ways — the same takeover rule cmdRegisterPrimary
  // applies to this row, plus proof the caller is a real running session). A
  // child on the Primary's worktree still fails whenever the Primary's session
  // is actually running.
  if (opts && callerId != null) {
    const selfId = declaredSelfId(opts.env, opts.cwd, registry);
    if (selfId) {
      const anchorId = String(callerIdentity(opts.env, opts.cwd));
      const names = new Set([selfId, anchorId]);
      const anchorRow = registry.find((r) => r && String(r.id) === anchorId);
      const anchorSid = anchorRow && anchorRow.sessionId != null ? String(anchorRow.sessionId) : '';
      const callerSid = opts.env && opts.env.CLAUDE_CODE_SESSION_ID ? String(opts.env.CLAUDE_CODE_SESSION_ID) : '';
      let anchorIsOurs = anchorSid === '' || (callerSid !== '' && anchorSid === callerSid);
      // v0.108.0: the DevSwarm app's own session map is authoritative when it
      // knows the caller's session — it names the worktree that session runs
      // in (true: this anchor's worktree; false: another one). Unknown -> the
      // liveness fallback below.
      const appSays = (!anchorIsOurs && callerSid !== '' && anchorRow)
        ? appSessionOnWorktree(home, opts.env, callerSid, anchorRow.worktreePath || opts.cwd)
        : null;
      if (appSays && appSays.verdict !== null) anchorIsOurs = appSays.verdict;
      else if (!anchorIsOurs && callerSid !== '' && anchorRow) {
        try {
          anchorIsOurs = isSessionAliveRow({ sessionId: callerSid }, home) === true
            && isSessionAliveRow(anchorRow, home) !== true;
        } catch (_) { anchorIsOurs = false; } // undetermined -> never ack on a guess
      }
      if (anchorIsOurs && names.size === 2 && names.has(String(callerId)) && names.has(String(partId))) return false;
    }
  }
  if (idFam && callerId != null) {
    try {
      const callerRow = registry.find((r) => r && String(r.id) === String(callerId));
      if (callerRow && idFam.crossLinkedIdentity(callerRow, row)) {
        // WORKTREE-SCOPED SELF (defect 8b211241bbe9). `crossLinkedIdentity`
        // compares ONLY ids and sessionIds — a pure ROW-level link with no
        // process, instance, or LOCATION component. So a caller invoking with a
        // child's meshId while standing in the PARENT's worktree passed this
        // SELF test and acked the child's twin partition, consuming mail the
        // child was never shown (field repro: uuid cursor found already at 31
        // with no tick in the child's own turn).
        //
        // Genuine SELF also requires standing in the partition's OWN worktree.
        // FAIL OPEN to the pre-fix SELF verdict when `worktreePath` is missing
        // or unresolvable (a pre-migration or partial row behaves exactly as it
        // does today), so this can only ever REFUSE a cross-worktree ack, never
        // strand a legitimate self-ack. `--ack-as-owner` never reaches here: it
        // is the sanctioned cross-workspace override and is gated before this.
        const rowWt = row.worktreePath ? (canonicalWorktreeRealPath(String(row.worktreePath)) || String(row.worktreePath)) : null;
        const callerCwd = (opts && opts.cwd) ? String(opts.cwd) : null;
        const callerWt = callerCwd ? (canonicalWorktreeRealPath(callerCwd) || callerCwd) : null;
        if (!rowWt || !callerWt) return false; // fail open — today's SELF verdict
        if (rowWt === callerWt) return false;  // genuinely self: same worktree
        return true;                            // cross-worktree caller: NOT self, never ack
      }
    } catch (_) { /* fall through to the plain liveness check below */ }
  }
  let live;
  try {
    live = isSiblingPartitionLive({ id: partId, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, { now });
  } catch (_) {
    return true; // undetermined -> fail toward live, never ack
  }
  if (live) return true;
  if (idFam) {
    try {
      const twins = idFam.identityFamilyTwins(row, registry.filter((r) => r && String(r.id) !== String(partId)));
      for (const t of twins) {
        let twinLive = false;
        try { twinLive = isSiblingPartitionLive({ id: t.id, worktreePath: t.worktreePath, sessionId: t.sessionId }, home, { now }); } catch (_) { twinLive = false; }
        if (twinLive) return true; // partId's own twin identity is live -> partId is live too
      }
    } catch (_) { /* fall through — partId's own (not-live) verdict stands */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// P0 HOTFIX (v0.90.1) — CURSOR NAMESPACES FOR A MESH SIBLING PARTITION
//
// A partition carries TWO store-side read positions that both mean "how far
// this partition has been consumed", written by DIFFERENT code paths:
//   (A) `cursors/<id>.json`  — the read-path ack file (inboxCursor / this
//       file's primaryCursorPath), written by `read-primary`'s ack loop.
//   (B) the store's own cursor row (s.cursorValue/s.setCursor), written by
//       `inbox count`'s reader, by foldOne's post-forward advance, and by
//       `reap-orphans`' post-archive advance.
//
// FIELD DEFECT: `read-primary` sized a sibling's window from (A) alone while
// `inbox count` sized it from (B) alone. After a fold or a reap advanced (B)
// to 606 with (A) still 0, `count` reported 0 unread while `read-primary`
// re-delivered all 606 rows on EVERY read, forever (measured: count 1 vs read
// 201 on the same storeSeq). Two surfaces disagreeing about how far a
// partition has been read is the whole defect.
//
// FIX: BOTH surfaces size from `Math.max(A, B)`. MAX is LOSS-FREE here — it is
// not the generic "max is unsafe, min is safe" case reconcileOrphanCursor
// documents, because the only writers that can push (B) ahead of (A) are
// foldOne and cmdReapOrphans, and each advances it ONLY AFTER the rows behind
// it were forwarded into a survivor partition (foldOne) or archived to disk
// (cmdReapOrphans). Rows below max(A,B) are therefore provably reachable
// somewhere else; skipping them here loses nothing. Those two writers now also
// write (A) in lockstep (see their call sites), so new divergence cannot open.
function siblingBaseCursor(storeHandle, home, pid, reader) {
  // Phase 3 (reader_cursors): the caller's OWN row when it is a declared reader
  // with a row, else the stored floor — never max(floor, shared pair) (rejected
  // patch P0 #1). Read-only: never seeds anything.
  // An UNREADABLE table never becomes a skip: the base drops to 0 (re-delivery
  // of everything, never loss), and the ack that follows fails and is REPORTED.
  try { return readerCursors.baseFor(storeHandle, { partition: pid, reader, home }).store; }
  catch (_) { return 0; }
}

// ---------------------------------------------------------------------------
// PER-INSTANCE CURSORS + CURSOR WRITE JOURNAL (defect 8b211241bbe9)
//
// THE DEFECT. `cursors/<id>.json` (and the store's cursor row) are keyed by row
// id ALONE, so every process reading under that id shares ONE read position.
// Whichever instance acks first consumes the mail for all of them: a second
// instance's `read-primary` returns 0 while the cursor has already moved past
// rows it was never shown. Twin rows (a meshId row and its uuid twin) make this
// routine rather than exotic.
//
// THE MODEL. Each INSTANCE (one OS process identity, `deriveInstanceNonce`,
// stable across every CLI invocation from one harness session) keeps its own
// cursor file `cursors/<id>#inst-<short6>.json`. The read window for instance I
// is `max(floor, instanceCursor(I))`, and:
//
//   floor(id) = min(cursor over every instance file for `id`)   [when any exist]
//             = max(cursors/<id>.json, store cursor)            [bootstrap only]
//
// MIN, not max: the floor may never pass the LEAST-advanced instance, or that
// instance is skipped past mail it was never shown. It is monotone because a new
// instance file is created at the CURRENT base, so an arriving instance cannot
// drag the min backwards. No liveness oracle is consulted anywhere — none is
// available (`inbox tick` refreshes only the heartbeat FILE, so a quiet-but-live
// reader ages out of any outbound-row liveness test).
//
// WHY THE LEGACY PAIR IS NOT IN THE MAX ONCE INSTANCE FILES EXIST. The legacy
// pair is advanced both by provably loss-free writers (foldOne, reap-orphans:
// rows are forwarded or archived FIRST) and by a foreign instance's sibling ack
// (the defect). The two cannot be told apart from the value alone, and the
// asymmetry is decisive: honoring a foreign ack LOSES mail, ignoring a fold only
// RE-DELIVERS it. So the floor ignores the legacy pair — and foldOne/reap close
// the re-delivery gap from the other side by raising EVERY instance cursor in
// lockstep (`raiseAllInstanceCursors`), which is sound precisely because their
// advance is loss-free by construction.
// ---------------------------------------------------------------------------
// CURSOR WRITE JOURNAL (defect 8b211241bbe9, task #6)
//
// Every cursor mutation is attributable: WHICH id/partition moved, from where to
// where, how many rows were actually delivered to justify it, which process and
// instance did it, under which verb, from which cwd, and which gate permitted
// it. The field defect was diagnosed twice from symptoms alone because no writer
// left a trace; `callerId !== partition` and `delivered:0` are the two signatures
// that name a cursor eater the moment it recurs.
//
// Append-only NDJSON, one file per repoKey, capped with tail-preserving
// rotation (the `heartbeat-callers.log` precedent). ALWAYS fail-open: an
// instrumentation failure must never break a delivery or an ack.
//
// OUT OF SCOPE, deliberately, so a missing record is never misread as a gap:
// broadcast_cursors writes (a separate defect filing), the migrate-time cursor
// merge, and `.seen-` watermark writes (a per-caller read position, not a
// partition cursor).
const CURSOR_LOG_CAP = 2000;
// diagnose surfacing bounds (design §3): scan at most this many newest records,
// keep at most this many per id in the output.
const CURSOR_LOG_DIAGNOSE_SCAN = 500;
const CURSOR_WRITES_PER_ID = 20;
function cursorLogPath(home, repoKey) {
  const key = (typeof repoKey === 'string' && /^[A-Za-z0-9._-]+$/.test(repoKey)) ? repoKey : 'unknown';
  return path.join(devswarmRoot(home), 'cursor-log', key + '.ndjson');
}
function logCursorWrite(home, rec) {
  try {
    if (!home || !rec) return false;
    const p = cursorLogPath(home, rec.repoKey);
    const line = JSON.stringify({
      ts: Number.isFinite(rec.ts) ? rec.ts : Date.now(),
      id: rec.id != null ? String(rec.id) : null,
      partition: rec.partition != null ? String(rec.partition) : null,
      callerId: rec.callerId != null ? String(rec.callerId) : null,
      ns: rec.ns != null ? String(rec.ns) : null,
      from: Number.isFinite(rec.from) ? rec.from : null,
      to: Number.isFinite(rec.to) ? rec.to : null,
      delivered: Number.isFinite(rec.delivered) ? rec.delivered : null,
      pid: Number.isFinite(rec.pid) ? rec.pid : process.pid,
      nonce: rec.nonce != null ? String(rec.nonce) : null,
      gate: rec.gate != null ? String(rec.gate) : null,
      verb: rec.verb != null ? String(rec.verb) : null,
      cwd: rec.cwd != null ? String(rec.cwd) : null,
      ok: rec.ok === false ? false : true,
      err: rec.err != null ? String(rec.err) : undefined,
    });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, line + '\n');
    // Tail-preserving rotation: keep the NEWEST CURSOR_LOG_CAP records. Checked
    // cheaply (only once the file is plausibly over cap) so the common append
    // stays a single syscall.
    let lines = null;
    try { lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== ''); } catch (_) { lines = null; }
    if (lines && lines.length > CURSOR_LOG_CAP) {
      const keep = lines.slice(lines.length - CURSOR_LOG_CAP);
      try { fs.writeFileSync(p + '.1', lines.slice(0, lines.length - CURSOR_LOG_CAP).join('\n') + '\n'); } catch (_) {}
      fs.writeFileSync(p, keep.join('\n') + '\n');
    }
    return true;
  } catch (_) { return false; } // fail-open: instrumentation never breaks an ack
}
// readCursorLog(home, repoKey, limit) -> newest-last records. Consumed by
// doctor/diagnose to surface the last N advances per id.
function readCursorLog(home, repoKey, limit) {
  const out = [];
  try {
    const raw = fs.readFileSync(cursorLogPath(home, repoKey), 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* skip a torn line */ }
    }
  } catch (_) { return out; }
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : out.length;
  return out.slice(Math.max(0, out.length - n));
}

// commitInstanceAck(storeHandle, home, id, shortNonce, target, meta) -> {
//   instance, floor, sharedWritten }. THE ack primitive for the per-instance
// model (defect 8b211241bbe9).
//
// 1. Advance THIS instance's own cursor to `target` (monotonic via ackTo).
// 2. Recompute the floor as the MIN across every instance file for `id`.
// 3. Write the SHARED pair to that MIN — never to `target`. In the
//    single-instance case min === target, so this is byte-identical to the
//    pre-fix behavior. With a lagging peer it is strictly conservative, which is
//    what keeps every legacy consumer of the shared value (deriveSummary's
//    unread projection, `workspaces list`, the gate) loss-free WITHOUT having to
//    rewrite each of them onto a new base.
// 4. Journal both writes with the delivered count that justified them.
// The shared write is skipped when it would LOWER the pair (ackTo is monotonic
// anyway; setCursor is not, so the guard is explicit).
// gcInstanceCursors(storeHandle, home, opts) -> { scanned, deleted, evicted,
//   kept, errors }. The hygiene pass for `cursors/<id>#inst-<short6>.json` and
// `cursors/<id>#nd-<short6>.json`.
//
// TWO predicates, in order:
//
//  (1) FLOOR-PRESERVING DELETE. Remove a file only when removing it does not
//      RAISE the floor — another instance file (or the baseline) already holds
//      an equal-or-lower value. `value <= floor` is NOT the predicate: the floor
//      IS the min, so that test selects exactly the file pinning it and would
//      advance the floor past that instance, making GC a third cursor eater.
//
//  (2) BOUNDED STALENESS EVICTION. A file whose mtime is older than
//      DEFAULT_INSTANCE_CURSOR_STALE_MS may go even when it pins the floor.
//      Without it a dead instance pins the shared cursor forever and every
//      consumer reading that value goes stale — a regression of its own. Safe by
//      argument, not by proof: every other instance has already read past that
//      position, so the mail reached all live readers. The bounded cost is a
//      session resumed after the window missing what its peers consumed, and
//      every eviction is journaled (`verb:'gc-evict'`) so that cost is always
//      attributable after the fact.
//
// Idempotent, fail-open, NO-DELETE of anything unparseable (the `.seen-` sweep
// rule: never guess at a name this code could not have written). Budget-capped.
function gcInstanceCursors(storeHandle, home, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : DEFAULT_INSTANCE_CURSOR_STALE_MS;
  const budget = Number.isFinite(o.budget) ? o.budget : 5000;
  // REPORT-ONLY since Phase 3 (mesh redesign): legacy `#inst-`/`#nd-` files are
  // inert (reader_cursors is the one read position) but they are the one-time
  // import's mapping source and the rollback path for an older build. Deleting
  // or evicting them could only lose that information, so nothing is removed —
  // the counts report what the pre-Phase-3 pass WOULD have removed.
  const dryRun = true;
  const out = { scanned: 0, deleted: 0, evicted: 0, kept: 0, errors: [], reportOnly: true };
  const dir = path.join(devswarmRoot(home), 'cursors');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; } // fail-open: no cursors dir yet
  // Group parseable instance files by id; anything else is left strictly alone.
  // BOTH namespaces are swept (R2 Auditor item 2): `#inst-` (store rows) and
  // `#nd-` (descriptor NDJSON lines). Missing the second left a dead instance
  // pinning the descriptor cursor forever via projectNdDescriptorCursor — the
  // exact hazard the eviction rule exists to bound. They are grouped
  // SEPARATELY: the two count in different index spaces, so one namespace's
  // values must never enter the other's floor arithmetic.
  const byId = new Map();
  for (const n of names) {
    if (out.scanned >= budget) break;
    const inst = parseInstCursorName(n);
    const nd = inst ? null : parseNdCursorName(n);
    const parsed = inst || nd;
    if (!parsed) continue; // NOT ours -> never touched
    const ns = inst ? 'inst' : 'nd';
    out.scanned += 1;
    const key = ns + '\u0000' + parsed.id;
    if (!byId.has(key)) byId.set(key, []);
    const p = path.join(dir, n);
    let mtimeMs = 0, value = 0;
    try { const st = fs.statSync(p); mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0; } catch (_) { mtimeMs = 0; }
    try { value = inboxCursor.readCursor(p); } catch (_) { value = 0; }
    byId.get(key).push({ shortNonce: parsed.shortNonce, value, mtimeMs, path: p, ns, id: parsed.id });
  }
  for (const [key, files] of byId) {
    const ns = key.slice(0, key.indexOf('\u0000'));
    const id = key.slice(key.indexOf('\u0000') + 1);
    // dryRun MUST NOT WRITE (R1 Auditor item 15): readInstanceBaseline SEEDS
    // `.base.json` when absent, so a "report-only" doctor pass was creating
    // files. Read the baseline without the seeding side effect when dry.
    let baseline = 0;
    try {
      if (ns === 'nd') {
        // The NDJSON namespace has no baseline file of its own; its floor is
        // simply the min across its instances.
        baseline = 0;
      } else if (dryRun) {
        const bp = instanceBaselinePath(home, id);
        let hasBase = false;
        try { hasBase = !!bp && fs.existsSync(bp); } catch (_) { hasBase = false; }
        baseline = hasBase ? inboxCursor.readCursor(bp) : legacySharedCursor(storeHandle, home, id);
      } else {
        baseline = readInstanceBaseline(storeHandle, home, id);
      }
    } catch (_) { baseline = 0; }
    // Work on a mutable view so each decision sees the effect of the previous.
    let remaining = files.slice();
    for (const f of files) {
      // CANDIDACY IS STALENESS, ALWAYS. An instance file IS that instance's
      // read position: deleting a fresh one makes its owner re-read everything
      // from the baseline. So a file is only ever a GC candidate once its mtime
      // is past the window — and only THEN do the two predicates decide HOW it
      // goes. (A first cut applied the floor-preserving test to fresh files too;
      // a test proved that discards a live reader's position and, with two
      // equal-min files, deletes both.)
      const stale = (now - f.mtimeMs) > staleMs;
      if (!stale) { out.kept += 1; continue; }
      const others = remaining.filter((r) => r.path !== f.path);
      const minOthers = others.length ? Math.min.apply(null, others.map((r) => r.value)) : null;
      const floorNow = others.length ? Math.max(baseline, Math.min(f.value, minOthers)) : Math.max(baseline, f.value);
      // With no other file left, the floor falls back to the baseline — which
      // can only LOWER it (that instance would re-read, never skip), so that is
      // a plain delete, not an eviction.
      const floorAfter = others.length ? Math.max(baseline, minOthers) : baseline;
      // (1) floor-preserving delete: another file (or the baseline) already
      //     holds an equal-or-lower value, so removing this one cannot raise it.
      // (2) bounded eviction: it PINS the floor, but it is past the window —
      //     removing it advances the floor, which is the whole point, and the
      //     movement is journaled so the bounded cost stays attributable.
      const action = (floorAfter > floorNow) ? 'evict' : 'delete';
      if (!dryRun) {
        try { fs.unlinkSync(f.path); } catch (e) { out.errors.push({ id, shortNonce: f.shortNonce, error: String((e && e.message) || e) }); out.kept += 1; continue; }
      }
      remaining = others;
      if (action === 'delete') out.deleted += 1;
      else {
        out.evicted += 1;
        // Report-only (Phase 3): nothing moved, so nothing is journaled.
        if (!dryRun) logCursorWrite(home, {
          id, partition: id, ns, from: floorNow, to: floorAfter, delivered: null,
          nonce: f.shortNonce, gate: 'gc-evict', verb: 'gc-evict', repoKey: o.repoKey || null,
        });
      }
    }
  }
  return out;
}


// (Phase 3: seedInstanceCursor / ndInstanceCursorPath — the legacy `#inst-`/`#nd-`
// WRITERS — are deleted. Declaration is readerCursors.declare; the legacy files are
// only ever READ, by the one-time import in companion/lib/reader-cursors.js.)
function parseNdCursorName(filename) {
  const n = typeof filename === 'string' ? filename : '';
  if (!/\.json$/.test(n)) return null;
  const base = n.slice(0, -'.json'.length);
  const i = base.lastIndexOf(ND_CURSOR_SEP);
  if (i <= 0) return null;
  const id = base.slice(0, i);
  const shortNonce = base.slice(i + ND_CURSOR_SEP.length);
  if (!/^[0-9a-f]{6}$/.test(shortNonce)) return null;
  if (!instCursorSafeId(id)) return null;
  return { id, shortNonce };
}

// ---- Primary-seat guard at the cursor doors (v0.108.0 review P1) -----------
// EVERY reader-cursor advance goes through one of three doors:
// commitInstanceAck (store namespace), commitNdAck (NDJSON namespace) and the
// store's advanceBroadcastCursor (mesh read / roster --ack). run() arms the
// guard with the invocation's ctx; each door asks seatRefusal once per
// invocation and THROWS before writing, so a session that does not hold a
// live-held Primary seat can never advance the Primary's cursors — whichever
// verb or flag combination (drain-primary-legacy, --legacy-ack-now,
// messages --ack, inbox ack/pull, mesh read, ...) led there. run() turns the
// throw into the standard { reason: 'primary-seat-conflict' } refusal.
let seatGuardCtx = null;
let seatGuardVerdict;
// getSeatGuard()/setSeatGuard(ctx, verdict): the cursor-door seat-guard state's ONE
// home is this module; run() (the dispatcher) arms and restores it through these.
function getSeatGuard() { return { ctx: seatGuardCtx, verdict: seatGuardVerdict }; }
function setSeatGuard(ctx, verdict) { seatGuardCtx = ctx; seatGuardVerdict = verdict; }
function assertSeatAllowsCursorWrite() {
  if (!seatGuardCtx) return;
  if (seatGuardVerdict === undefined) seatGuardVerdict = seatRefusal(seatGuardCtx) || null;
  if (seatGuardVerdict) {
    const e = new Error(seatGuardVerdict.error || 'primary-seat-conflict');
    e.seatRefusal = seatGuardVerdict;
    throw e;
  }
}

function commitInstanceAck(storeHandle, home, id, reader, target, meta) {
  assertSeatAllowsCursorWrite();
  // Phase 3: ONE transaction — the caller's own row (declared readers only) and
  // the floor recompute (max(F, MIN(live declared)); a headless ack moves F to its
  // target only when no live declared reader exists). Legacy shared pair is
  // dual-written upward to F after commit; #inst/#base are never written.
  const m = meta || {};
  const r = readerCursors.ackFor(storeHandle, {
    partition: id, ns: 'store', reader, target, home,
    now: m.now, procTable: m.procTable, kill: m.kill,
  });
  const out = { instance: readerCursors.readerKey(reader) ? r.own : null, floor: r.floor, sharedWritten: !!r.ok };
  if (!r.ok) out.error = r.error || 'reader-cursors ack failed';
  logCursorWrite(home, Object.assign({}, m, {
    id, partition: id, ns: 'reader_cursors:store', from: r.from, to: r.ok ? r.own : target,
    nonce: reader ? shortInstanceNonce(reader) : null,
    gate: m.gate || 'min-floor', ok: !!r.ok, err: out.error,
  }));
  return out;
}

// commitNdAck(storeHandle, home, id, reader, target, descCursorPath, inboxPath, meta)
// -> the caller's own NDJSON position after the ack. The NDJSON namespace twin
// of commitInstanceAck (ns:'nd'). Target is clamped to the inbox line count.
// With NO store handle (store unavailable) there is no table to write: the
// descriptor cursor file is advanced directly (monotone), which is exactly the
// position countFor reads for a store-less partition. THROWS on a failed ack so
// the caller reports it (re-delivery, never a silent half-ack).
function commitNdAck(storeHandle, home, id, reader, target, descCursorPath, inboxPath, meta) {
  assertSeatAllowsCursorWrite();
  const m = meta || {};
  let t = Math.max(0, Math.floor(Number(target) || 0));
  if (inboxPath) t = Math.min(t, inboxCursor.countMessages(inboxPath));
  if (!storeHandle) return inboxCursor.ackTo(descCursorPath, t, undefined, inboxPath);
  const r = readerCursors.ackFor(storeHandle, {
    partition: id, ns: 'nd', reader, target: t, home, cursorPath: descCursorPath,
    now: m.now, procTable: m.procTable, kill: m.kill,
  });
  logCursorWrite(home, Object.assign({}, m, {
    id, partition: id, ns: 'reader_cursors:nd', from: r.from, to: r.ok ? r.own : t,
    nonce: reader ? shortInstanceNonce(reader) : null, gate: m.gate || 'min-floor', ok: !!r.ok, err: r.ok ? undefined : r.error,
  }));
  if (!r.ok) throw new Error(r.error || 'reader-cursors nd ack failed');
  return r.own;
}

// ============================================================================
// Phase 5 ACK SPLIT — read receipts + the ONE ack executor.
//
// `inbox read-primary` computes the exact ack its read implies (the SAME
// unread window, caps and ownership gate as the old same-call drain) as a
// list of ops, and persists them in a read receipt instead of writing any
// cursor. `inbox ack-primary <id> --receipt <rid>` applies them after the
// caller has consumed the mail. `inbox drain-primary-legacy` (one release)
// collects the same ops and applies them immediately. Every cursor write is
// MAX-only, so applying a receipt twice, late, or after a newer ack is a
// no-op — never a regression, never an ack of anything the read did not
// return.
//   { k:'own',     partition, target, delivered }
//   { k:'sibling', partition, ackTarget, seenTarget, notAckable, delivered }
//   { k:'nd',      partition, target, cursorPath, inboxPath }
// ============================================================================
const READ_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const READ_RECEIPT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function readReceiptDir(home, id) { return path.join(devswarmRoot(home), 'read-receipts', String(id)); }

// writeReadReceipt(home, id, { reader, ops, hashes, now, dirId }) -> { ok, receiptId } | { ok:false, error }.
// Atomic (tmp + rename). Also prunes this id's receipts older than
// READ_RECEIPT_KEEP_MS (tokens only — pruning a receipt never touches a
// message or a cursor; an unacked message simply stays unread).
// `dirId` (optional): the identity/alias-family CANONICAL id to file this
// receipt under (see canonicalReceiptId below) — a Primary registered under
// two aliases on the SAME worktree (a DevSwarm-native builder-id UUID row
// and anti-hall's own minted primary-<hash> row, the exact pair
// resolveMeshPartitionIds already widens reads across) files the receipt
// once, under the family's canonical id, so `ack-primary` can find it
// through EITHER alias. The `id` field recorded INSIDE the receipt stays the
// literal id the read was addressed to — only the on-disk directory changes.
// Falls back to `id` itself when `dirId` is absent/unsafe (byte-identical to
// pre-fix behavior for a non-aliased id).
function writeReadReceipt(home, id, o) {
  try {
    if (!isSafeId(String(id))) return { ok: false, error: 'unsafe id' };
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const receiptId = 'r' + now.toString(36) + crypto.randomBytes(6).toString('hex');
    const dirId = (o.dirId != null && isSafeId(String(o.dirId))) ? String(o.dirId) : String(id);
    const dir = readReceiptDir(home, dirId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, receiptId + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      v: 1, receiptId, id: String(id), reader: o.reader || null, createdAt: now,
      ops: o.ops || [], hashes: o.hashes || [], ackedAt: null,
    }));
    fs.renameSync(tmp, file);
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/^r[a-z0-9]+\.json$/.test(n) || n === receiptId + '.json') continue;
        const f = path.join(dir, n);
        try { if (now - fs.statSync(f).mtimeMs > READ_RECEIPT_KEEP_MS) fs.unlinkSync(f); } catch (_) {}
      }
    } catch (_) { /* pruning is housekeeping only */ }
    return { ok: true, receiptId };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// readReadReceipt(home, id, receiptId, { dirId }) -> { rec, dirId } | null.
// `dirId`, when supplied (the SAME identity/alias-family canonical id
// writeReadReceipt's caller resolved), is tried FIRST; the literal `id`
// directory is ALWAYS tried too (backward compatibility — a receipt written
// before this fix, or when family resolution failed at write time, only
// ever exists under the literal id). Returns the directory the receipt
// actually came from so a caller doing a follow-up write (stamping
// `ackedAt`) targets the SAME file rather than re-deriving it.
function readReadReceipt(home, id, receiptId, opts) {
  if (!isSafeId(String(id)) || !/^r[a-z0-9]+$/.test(String(receiptId))) return null;
  const literalId = String(id);
  const canonicalId = (opts && opts.dirId != null && isSafeId(String(opts.dirId))) ? String(opts.dirId) : null;
  const dirsToTry = (canonicalId && canonicalId !== literalId) ? [canonicalId, literalId] : [literalId];
  for (const d of dirsToTry) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(readReceiptDir(home, d), receiptId + '.json'), 'utf8'));
      if (r && typeof r === 'object' && Array.isArray(r.ops)) return { rec: r, dirId: d };
    } catch (_) { /* try the next candidate dir */ }
  }
  return null;
}

// applyReadAckOps(s, home, id, reader, ops, { ctx, repoKey, verb, revalidate })
// -> { acked, failures[] }. THE executor for both the legacy same-call drain
// and ack-primary. `revalidate` (ack-primary) re-evaluates each sibling's ack
// gate NOW: a sibling whose owner became live since the read gets only this
// caller's seen-watermark, never its own cursor (the read-time verdict is
// used as-is for the legacy same-call path).
function applyReadAckOps(s, home, id, reader, ops, o) {
  const ctx = o.ctx || {};
  const meta = { callerId: id, nonce: reader, verb: o.verb || 'read-primary', cwd: (ctx && ctx.cwd) || null, repoKey: o.repoKey || null };
  const failures = [];
  let acked;
  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    if (op.k === 'own') {
      // op.partition (not the outer `id`) is the partition this op was
      // actually computed against AT READ TIME (cmdInboxMessagesInner sets
      // it to `String(id)` there — see the 'own' ackOps push above). The
      // ack-primary CALLER's `id` can legitimately be a DIFFERENT alias in
      // the same identity family (see canonicalReceiptId / the read-receipt
      // dirId plumbing) — using the outer `id` here would commit the ack
      // against the WRONG partition's cursor whenever they differ. Falls
      // back to `id` only for a legacy op with no `partition` recorded.
      const ownPartitionId = op.partition != null ? op.partition : id;
      const committed = commitInstanceAck(s, home, ownPartitionId, reader, op.target, Object.assign({}, meta, { delivered: op.delivered, gate: 'owner' }));
      // A failed own-partition write is REPORTED (R1 Reviewer item 7): redelivery
      // holds (nothing moved), but ok:true must not hide the half-ack.
      if (committed.error) failures.push({ partitionId: ownPartitionId, channel: 'store-cursor', error: committed.error });
      acked = Number.isFinite(committed.instance) ? committed.instance : Math.max(committed.floor || 0, op.target);
    } else if (op.k === 'sibling') {
      const notAckable = o.revalidate
        ? siblingAckGate(s, id, op.partition, home, ctx.now, { cwd: ctx && ctx.cwd, env: ctx && ctx.env })
        : op.notAckable;
      if (notAckable) {
        // Live sibling: never touch its own cursors; record how far THIS caller
        // has been shown (caller-scoped watermark, D11-A lock).
        if (op.seenTarget > 0 && !withWatermarkLock(id, op.partition, home, () => writeSiblingSeenCursor(home, id, op.partition, op.seenTarget))) {
          failures.push({ partitionId: op.partition, channel: 'sibling-seen-watermark', error: 'could not write caller-scoped seen watermark' });
        }
        continue;
      }
      try {
        const partCommit = commitInstanceAck(s, home, op.partition, reader, op.ackTarget, Object.assign({}, meta, { delivered: op.delivered, gate: 'sibling' }));
        if (partCommit.error) throw new Error(partCommit.error);
        // R14 F1 third half: retire the watermark only once the sibling's OWN
        // cursor covers it (fresh on-disk read under the same lock, R15 P3).
        withWatermarkLock(id, op.partition, home, () => {
          const freshWatermark = readSiblingSeenCursor(home, id, op.partition);
          if (siblingWatermarkCovered(op.ackTarget, freshWatermark)) removeSiblingSeenCursor(home, id, op.partition);
        });
      } catch (e) {
        failures.push({ partitionId: op.partition, channel: 'sibling-store-cursor', error: String((e && e.message) || e) });
      }
    } else if (op.k === 'nd') {
      // Mirror of the 'own' fix above: op.partition (not the outer `id`) is
      // the partition this op was actually computed against AT READ TIME
      // (the NDJSON ackOps push above sets it to `String(id)` there). The
      // ack-primary CALLER's `id` can legitimately be a DIFFERENT alias in
      // the same identity family — using the outer `id` here would commit
      // the ack against the WRONG partition's nd cursor whenever they
      // differ. Falls back to `id` only for a legacy op with no `partition`
      // recorded. `meta.callerId` (set above from the real outer `id`) is
      // kept as the real caller for audit/logging only — commitNdAck's
      // `id` positional argument is the reader_cursors partition KEY
      // (readerCursors.ackFor's `partition:`), so it must be the
      // read-time partition, not the caller.
      const ndPartitionId = op.partition != null ? op.partition : id;
      try {
        commitNdAck(s, home, ndPartitionId, reader, op.target, op.cursorPath, op.inboxPath, {
          callerId: id, verb: meta.verb, cwd: meta.cwd, repoKey: meta.repoKey,
          now: ctx && ctx.now, procTable: ctx && ctx.procTable,
        });
      } catch (e) { failures.push({ partitionId: ndPartitionId, channel: 'ndjson-cursor', error: String((e && e.message) || e) }); }
    }
  }
  try { store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); } catch (_) { /* projection refresh is best-effort */ }
  return { acked, failures };
}

// floorCursor(s, id, home) -> the partition's stored floor (reader_cursors
// '#floor', ns 'store'), or — before this partition's one-time import ran — the
// legacy effective floor computed dry. THE value every "unread by anybody" /
// summary / fold / reap / rehome read uses (replaces store.cursorValue as a
// reader). Never throws: an UNREADABLE table reads as 0 — every caller copies,
// forwards, archives or counts from this base, so 0 over-delivers (loss-free).
// It never falls back to the legacy shared cursor: that holds an old build's OWN
// position, which can sit past a declared reader's unread (loss). rehome reads
// the floor strictly and aborts instead (rehomeAcrossStores).
function floorCursor(s, id, home) {
  try { return readerCursors.floorOf(s, id, 'store', { home }); }
  catch (_) { return 0; }
}

// SEPARATORS USE `#`, WHICH `isSafeId` FORBIDS (R2 Auditor item 13).
//
// A first cut used `.inst-` / `.nd-` / `.base` and defended the collision with a
// validator. That was the wrong shape and it was PROVEN broken: `isSafeId`
// permits dots, and `register`/`primaryCursorPath` gate on bare `isSafeId`, so a
// workspace could legitimately be named `w.base` — whose legacy cursor file is
// `cursors/w.base.json`, byte-identical to workspace `w`'s BASELINE path.
// Acking that workspace's cursor to 42 made `w`'s baseline read 42, silently
// skipping 42 rows of `w`'s mail.
//
// `isSafeId` is `/^[A-Za-z0-9._-]+$/`, so `#` cannot appear in ANY valid
// workspace id. Using it as the namespace separator makes the collision
// impossible BY CONSTRUCTION rather than by a validator that every future call
// site has to remember to apply. (The pre-existing `.seen-` watermark keeps its
// own documented id-refusal guard — that namespace ships already and is not
// re-cut here.) These three files are new in this unreleased version, so there
// is no on-disk form to migrate.
const INST_CURSOR_SEP = '#inst-';
const ND_CURSOR_SEP = '#nd-';
const BASELINE_SUFFIX = '#base.json';
// 7 days. The eviction cost case (below) is a session RESUMED after the window,
// and 24h sits inside an ordinary Friday-to-Monday gap (60-72h); 7 days puts it
// outside every routine resume pattern for a few retained bytes. Expressed
// against liveness.js's DEFAULT_IDLE_MS (15 min) for provenance: 672 x that.
const DEFAULT_INSTANCE_CURSOR_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// `isSafeId` already excludes `#`, so an id can never contain INST/ND_CURSOR_SEP
// or produce BASELINE_SUFFIX. The `.seen-` exclusion is kept because that
// namespace uses a dot separator and predates this fix.
function instCursorSafeId(id) {
  const v = String(id);
  return isSafeId(v) && !v.includes(SIBLING_SEEN_SEP) && !v.includes('#');
}
// RESERVED-TOKEN IDS (R2 Auditor item 13). Even with `#` separators making the
// cursor namespaces collision-proof, an id carrying one of these tokens is a
// trap: `.seen-` genuinely collides with the shipped watermark namespace, and
// the rest read as this file's internal namespaces to any human or future
// parser. Refused on a FRESH registration only — an install that already has
// such a row keeps working, because breaking a live workspace is worse than the
// ambiguity it names.
// The literal '.seen-' rather than SIBLING_SEEN_SEP: that const is declared
// further down this file, and a module-level array would evaluate it in its
// temporal dead zone (proven: ReferenceError at load).
const RESERVED_ID_TOKENS = ['#', '.seen-', '.inst-', '.nd-'];
// RESERVED-EXACT IDS (0.117.1 P2, D-system-sender-not-reserved): unlike
// RESERVED_ID_TOKENS above (a substring `includes()` scan — deliberately
// broad, since those tokens are namespace SEPARATORS this file's own cursor
// files use), 'system' is reserved as an EXACT id match only — a workspace
// legitimately named e.g. "ecosystem-service" must keep working. Mesh
// broadcast/heartbeat code reads a row's `sender`/`from` field to attribute a
// message to a real workspace; if a workspace could register itself AS
// 'system', its own outbound rows would be indistinguishable from a genuine
// system-authored message any consumer trusts more. Refused on a FRESH
// registration only, matching RESERVED_ID_TOKENS' own posture (an install
// that already has such a row keeps working).
const RESERVED_EXACT_IDS = ['system'];
function reservedIdToken(id) {
  const v = String(id == null ? '' : id);
  for (const t of RESERVED_ID_TOKENS) { if (v.includes(t)) return t; }
  if (v.endsWith('.base')) return '.base';
  if (RESERVED_EXACT_IDS.includes(v)) return v;
  return null;
}
function instanceCursorPath(home, id, shortNonce) {
  if (!instCursorSafeId(id) || !/^[0-9a-f]{6}$/.test(String(shortNonce || ''))) return null;
  return path.join(devswarmRoot(home), 'cursors', String(id) + INST_CURSOR_SEP + String(shortNonce) + '.json');
}
// parseInstCursorName(filename) -> { id, shortNonce } | null. The exact inverse
// of instanceCursorPath's naming and the ONE parser any sweep may use. The
// `/^[0-9a-f]{6}$/` test on the nonce half is load-bearing: `shortInstanceNonce`
// is a sha1 prefix, so a name failing it was NOT written by this code — without
// the test, a workspace id that legitimately contains `.inst-` would parse as an
// instance file and be swept. Splits on the LAST separator so an id containing
// `.inst-` cannot shadow the real one.
function parseInstCursorName(filename) {
  const n = typeof filename === 'string' ? filename : '';
  if (!/\.json$/.test(n)) return null;
  const base = n.slice(0, -'.json'.length);
  const i = base.lastIndexOf(INST_CURSOR_SEP);
  if (i <= 0) return null;
  const id = base.slice(0, i);
  const shortNonce = base.slice(i + INST_CURSOR_SEP.length);
  if (!/^[0-9a-f]{6}$/.test(shortNonce)) return null;
  if (!instCursorSafeId(id)) return null;
  return { id, shortNonce };
}
// listInstanceCursors(home, id) -> [{ shortNonce, value, mtimeMs, path, readable }].
// Every instance file for `id`. Fail-soft: an unreadable dir/file is simply
// absent from the directory scan. `readable` distinguishes a GENUINE value of
// 0 (a fresh cursor that has never advanced) from a file that exists but is
// unreadable/corrupt — `inboxCursor.readCursor` swallows a parse failure and
// also reports 0 for that case (correct for its own normal callers), so a
// bounded-min consumer that folds every returned `value` in blind would treat
// a corrupt file identically to a legitimately-fresh one and clamp forever at
// 0. The file itself is still returned, unmodified, so a doctor sweep can
// report and repair it — only the min computation needs to skip it.
function listInstanceCursors(home, id) {
  const out = [];
  if (!instCursorSafeId(id)) return out;
  const dir = path.join(devswarmRoot(home), 'cursors');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    const parsed = parseInstCursorName(n);
    if (!parsed || parsed.id !== String(id)) continue;
    const p = path.join(dir, n);
    let mtimeMs = 0;
    try { const st = fs.statSync(p); mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0; } catch (_) { mtimeMs = 0; }
    let value = 0;
    let readable = true;
    try {
      const raw = String(fs.readFileSync(p, 'utf8')).trim();
      let c;
      if (/^\d+$/.test(raw)) c = parseInt(raw, 10);
      else c = Number(JSON.parse(raw).line);
      if (Number.isFinite(c) && c >= 0) value = Math.floor(c);
      else readable = false;
    } catch (_) { readable = false; }
    out.push({ shortNonce: parsed.shortNonce, value, mtimeMs, path: p, readable });
  }
  return out;
}
// legacySharedCursor(storeHandle, home, id) -> max(cursors/<id>.json, store row).
// The pre-per-instance base, kept verbatim as the bootstrap value.
function legacySharedCursor(storeHandle, home, id) {
  let jsonCursor = 0, storeCursor = 0;
  try { jsonCursor = inboxCursor.readCursor(primaryCursorPath(home, id)); } catch (_) { jsonCursor = 0; }
  try { storeCursor = storeHandle && typeof storeHandle.cursorValue === 'function' ? storeHandle.cursorValue(id) : 0; } catch (_) { storeCursor = 0; }
  return Math.max(jsonCursor, storeCursor);
}
// THE BASELINE (`cursors/<id>#base.json`) — the LOSS-FREE watermark.
//
// A first draft of this fix used "the MIN across instance files" as the starting
// position for an instance that has none. A test proved that wrong: an instance
// that has NEVER read would then start at a PEER's position and be handed
// nothing, which is the original defect wearing a different hat. The min across
// readers and the loss-free watermark are two different facts and need two
// different files.
//
// Only writers whose advance is loss-free BY CONSTRUCTION move the baseline:
// foldOne (rows already forwarded into the survivor), reap-orphans (rows already
// archived and read-back-verified), and the one-time bootstrap seed below. A
// plain read/ack NEVER touches it — that is precisely the write that ate mail.
//
// Bootstrap: the first time any instance touches `id`, the baseline is seeded
// from the pre-fix shared value `max(cursors/<id>.json, store cursor)`. Every
// pre-0.99 installation therefore resumes exactly where it left off, and no
// already-consumed row is re-delivered on upgrade.
// `.base` is refused alongside `.inst-`, `.nd-` and `.seen-` — NOT via the
// `RESERVED_ID_TOKENS` set (an `includes()` scan), but via `reservedIdToken`'s
// own `endsWith('.base')` check (~:1563), since `.base` is only reserved as a
// SUFFIX, not anywhere in the id. Without it, workspace id `x.base` and the
// baseline of workspace id `x` would BOTH map to `cursors/x.base.json`
// (isSafeId permits dots), so one id's legacy cursor and another's baseline
// would silently be the same file (R1 Auditor item 13).
function instanceBaselinePath(home, id) {
  if (!instCursorSafeId(id)) return null;
  return path.join(devswarmRoot(home), 'cursors', String(id) + BASELINE_SUFFIX);
}
function readInstanceBaseline(storeHandle, home, id) {
  const p = instanceBaselinePath(home, id);
  if (!p) return legacySharedCursor(storeHandle, home, id);
  let exists = false;
  try { exists = fs.existsSync(p); } catch (_) { exists = false; }
  // ONE-TIME SEED ONLY — the legacy shared pair is NOT a live floor.
  //
  // A previous cut re-adopted `legacySharedCursor` as a floor on EVERY call, on
  // the reasoning that every writer of the shared pair is either min-projected
  // or loss-free. That reasoning holds only WITHIN this version. Across a MIXED
  // FLEET it is false and it LOSES MAIL: a 0.98.3 session's read-primary ack
  // writes `s.setCursor(id, acked)` — its OWN position, no min-projection — so
  // re-adopting that value raised every 0.99 instance's floor to whatever the
  // older build had consumed. Proven live against the real cached 0.98.3 build:
  // the old build received 3, and a DECLARED 0.99 instance then received 0.
  //
  // That is exactly the asymmetry documented at this module's head: honoring a
  // foreign ack LOSES mail, ignoring a legitimate advance only RE-DELIVERS it.
  // The writers whose advances ARE loss-free raise the baseline at their own
  // call sites instead — foldOne, cmdReapOrphans, and the migrate-time cursor
  // merge — so nothing that genuinely made rows unreachable is ignored.
  if (exists) {
    try { return inboxCursor.readCursor(p); } catch (_) { return 0; }
  }
  // First touch: seed ONCE from the pre-fix shared value (upgrade continuity).
  const legacy = legacySharedCursor(storeHandle, home, id);
  try { inboxCursor.ackTo(p, legacy); } catch (_) { /* fail-soft: re-seeded next call */ }
  return legacy;
}
// raiseInstanceBaseline(home, id, value) -> bool. ONLY for loss-free advances.
// raiseInstanceBaseline(home, id, value, opts) -> bool.
//
// UNBOUNDED by default, and that default is ONLY for foldOne and cmdReapOrphans:
// each has already made every row below `value` reachable elsewhere (forwarded
// into the survivor partition / archived to disk and read-back verified) before
// it calls this, so moving every instance past those rows loses nothing.
//
// `opts.bounded` is for every OTHER caller. A raise that has NOT made the rows
// reachable elsewhere must never pass the DECLARED FLOOR — the min across
// existing `#inst-` files — or it silently consumes a live instance's mail. The
// migrate-time cursor merge is exactly that case: its `mergedCursor` is
// `max(dst.cursorValue, src.cursorValue)`, i.e. shared-pair values that an older
// build's own-position ack can have written, and copying rows between backends
// makes nothing reachable for a 0.99 instance. Proven live: a declared instance
// sitting at 0 with an unbounded raise(3) received 0 rows instead of 3.
//
// With NO instance files the bound does not apply (nothing is declared, so
// nothing can be skipped) and the raise proceeds as before.
function raiseInstanceBaseline(home, id, value, opts) {
  const p = instanceBaselinePath(home, id);
  if (!p || !Number.isFinite(value) || value <= 0) return false;
  let target = value;
  if (opts && opts.bounded) {
    // SKIP unreadable/corrupt files: they are not a legitimate declared
    // floor, just a file that can't be trusted. Folding their `readCursor`
    // default of 0 into the min would clamp `target` at 0 forever for this
    // id (proven: a bounded raise never advances while a corrupt file sits
    // in the mix). Treat them as absent for this computation only — they
    // are still returned by listInstanceCursors, unmodified, for the doctor
    // report.
    const files = listInstanceCursors(home, id).filter((f) => f.readable !== false);
    if (files.length) {
      let min = null;
      for (const f of files) { if (min === null || f.value < min) min = f.value; }
      if (min !== null && min < target) target = min;
    }
  }
  if (!Number.isFinite(target) || target <= 0) return false;
  try { inboxCursor.ackTo(p, target); return true; } catch (_) { return false; }
}
// instanceFloor(storeHandle, home, id) -> the value the SHARED pair should show:
// the MIN across instance files, never below the loss-free baseline. With no
// instance file it is simply the baseline.
function instanceFloor(storeHandle, home, id) {
  const baseline = readInstanceBaseline(storeHandle, home, id);
  const files = listInstanceCursors(home, id);
  if (!files.length) return baseline;
  let min = null;
  for (const f of files) { if (min === null || f.value < min) min = f.value; }
  return Math.max(baseline, min === null ? baseline : min);
}

// ---------------------------------------------------------------------------
// LIVE-SIBLING WATERMARK (P0 hotfix, v0.90.1) — `cursors/<callerId>.seen-<siblingId>.json`
//
// A sibling partition owned by a LIVE twin is NOT ackable: `siblingAckGate`
// refuses (correctly — the twin's own reader owns that cursor, and advancing it
// from here would eat the twin's mail). But `read-primary` still DELIVERS that
// sibling's unread rows to the caller, and with no cursor written anywhere the
// window is identical on the next read: the SAME rows are re-delivered on every
// single read, forever. That is the recurring re-delivery this hotfix closes.
//
// This watermark is CALLER-SCOPED: it records how far THIS caller has been
// shown of THAT sibling. It NEVER touches the sibling's own cursor namespaces,
// so the twin's own reader still sees 100% of its mail. It is consulted ONLY
// for a non-ackable sibling (an ackable one advances its real cursor as before).
// Both ids are isSafeId-checked so the filename can never escape cursors/.
//
// R14 F3 (P3) — THE NAME MUST BE UNAMBIGUOUSLY PARSEABLE. isSafeId permits `.`
// and `-`, so an id literally containing the `.seen-` separator would make
// `<caller>.seen-<sibling>.json` ambiguous: `a.seen-b.seen-c.json` could be
// (a, b.seen-c) or (a.seen-b, c). Nothing WRITES such a name today, but a
// hygiene sweep that DELETES files has to parse them, and a mis-parse there
// deletes the wrong caller's watermark. Rather than re-encode every id (a
// persisted-shape change requiring a forward migration for every existing
// file), refuse the one token that creates the ambiguity: an id containing
// `.seen-` gets NO watermark. That is fail-soft in the safe direction — such a
// caller/sibling pair simply falls back to the pre-watermark behaviour — and it
// makes "split on the first `.seen-`" an exact inverse for every name this
// function can ever produce.
const SIBLING_SEEN_SEP = '.seen-';
function watermarkSafeId(id) {
  return isSafeId(id) && !String(id).includes(SIBLING_SEEN_SEP);
}
function siblingSeenCursorPath(home, callerId, siblingId) {
  if (!watermarkSafeId(callerId) || !watermarkSafeId(siblingId)) return null;
  return path.join(devswarmRoot(home), 'cursors', String(callerId) + SIBLING_SEEN_SEP + String(siblingId) + '.json');
}
// parseSiblingSeenCursorName(filename) -> { callerId, siblingId } | null.
// The exact inverse of siblingSeenCursorPath's naming, and the ONE parser any
// sweep may use. Returns null for a name this module could not have written —
// including a legacy/hand-made name whose remainder still contains the
// separator (genuinely ambiguous), which a sweep must therefore SKIP rather
// than guess at and delete.
function parseSiblingSeenCursorName(filename) {
  const n = typeof filename === 'string' ? filename : '';
  if (!/\.json$/.test(n)) return null;
  const base = n.slice(0, -'.json'.length);
  const i = base.indexOf(SIBLING_SEEN_SEP);
  if (i <= 0) return null;
  const callerId = base.slice(0, i);
  const siblingId = base.slice(i + SIBLING_SEEN_SEP.length);
  if (!watermarkSafeId(callerId) || !watermarkSafeId(siblingId)) return null;
  return { callerId, siblingId };
}
// removeSiblingSeenCursor(home, callerId, siblingId) -> bool. Deletes the
// watermark FILE once the sibling's own durable cursors cover its rows (see the
// read-primary ack path). Never a message delete — a watermark is a per-caller
// read position, and its absence degrades to "re-read from the real cursor",
// which is exactly the pre-watermark behaviour. Fail-soft: a missing file or an
// unlink error returns false and changes nothing.
function removeSiblingSeenCursor(home, callerId, siblingId) {
  const p = siblingSeenCursorPath(home, callerId, siblingId);
  if (!p) return false;
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
}
function readSiblingSeenCursor(home, callerId, siblingId) {
  const p = siblingSeenCursorPath(home, callerId, siblingId);
  if (!p) return 0;
  try { return inboxCursor.readCursor(p); } catch (_) { return 0; }
}
function writeSiblingSeenCursor(home, callerId, siblingId, value) {
  const p = siblingSeenCursorPath(home, callerId, siblingId);
  if (!p || !Number.isFinite(value) || value <= 0) return false;
  try { inboxCursor.ackTo(p, value); return true; } catch (_) { return false; }
}
// watermarkLockKey(callerId, siblingId) -> string | null. D11-A (TOCTOU fix):
// the per-id lock key for THIS (callerId, siblingId) watermark file — reuses
// the file's OWN basename convention (siblingSeenCursorPath minus `.json`),
// which is already watermarkSafeId-gated on both halves (isSafeId-safe, no
// `.seen-` substring ambiguity), so it needs no separate validation and can
// never collide with an unrelated single-id lock (every other withIdLock
// caller in this file locks a bare workspace id, which never contains
// `.seen-`). Returns null when either id is not watermarkSafeId (mirrors
// siblingSeenCursorPath's own null-on-unsafe-id contract) — callers fall back
// to running unlocked, same as the pre-fix behavior for that edge case.
function watermarkLockKey(callerId, siblingId) {
  if (!watermarkSafeId(callerId) || !watermarkSafeId(siblingId)) return null;
  return String(callerId) + SIBLING_SEEN_SEP + String(siblingId);
}
// withWatermarkLock(callerId, siblingId, home, fn) -> fn()'s return value.
// D11-A (TOCTOU fix, ~:6394): the sibling-watermark read (readSiblingSeenCursor)
// -> conditional unlink (removeSiblingSeenCursor) at the read-primary ack path
// used to run with NO file locking at all — a concurrent writeSiblingSeenCursor
// call for the SAME (callerId, siblingId) pair (e.g. two overlapping
// `inbox read-primary` invocations by the same caller reading the same
// non-ackable sibling) could land its write in the gap between the read and
// the unlink, and that extension would be silently discarded when the unlink
// fired (documented, pre-fix, at readSiblingSeenCursor's TOCTOU header
// comment). Serializing BOTH the write site (the notAckable branch) and the
// read+conditional-unlink site under the SAME per-(callerId,siblingId) lock
// closes the window: whichever caller wins the lock completes its full
// read-modify-write (or write) atomically w.r.t. the other. FAIL-OPEN,
// matching withIdLock's own posture: a lock-busy result (contended, budget
// exhausted) runs `fn` UNLOCKED rather than silently dropping the operation —
// a watermark is best-effort re-delivery bookkeeping (its own header: "its
// absence degrades to re-read from the real cursor, which is exactly the
// pre-watermark behaviour"), so losing this one race under contention is
// strictly safer than refusing the read/write outright. An unresolvable lock
// key (unsafe ids) also runs unlocked — same edge case
// siblingSeenCursorPath/writeSiblingSeenCursor already degrade to a no-op for.
function withWatermarkLock(callerId, siblingId, home, fn) {
  const key = watermarkLockKey(callerId, siblingId);
  if (!key) return fn();
  const r = withIdLock(key, home, fn);
  if (r && typeof r === 'object' && r.lockBusy) return fn(); // contended -> fail-open, run unlocked rather than drop
  return r;
}
// siblingWatermarkCovered(ackTarget, watermarkValue) -> bool. The REAL
// invariant the R14 F1 THIRD HALF watermark retirement needs (R15 P3 fix):
// true iff advancing the sibling's own durable cursor to `ackTarget` covers
// every row the watermark recorded. Extracted into its own pure predicate
// (rather than inlined against a cached in-memory value) so it is directly
// unit-testable, and so the read-primary call site can gate it on a FRESHLY
// read `watermarkValue` (see readSiblingSeenCursor at that call site) instead
// of an in-memory value captured earlier in the same read. The fresh re-read
// narrows the TOCTOU window to just read→unlink, it does not eliminate it:
// there is no file locking here, so a writer that extends the watermark in
// that gap loses that extension when the unlink fires, and the next acking
// read simply recreates the file from the writer's own state. A non-finite
// input on either side degrades to 0 — no watermark on record (missing/
// unreadable file) trivially satisfies "covered".
function siblingWatermarkCovered(ackTarget, watermarkValue) {
  const target = Number.isFinite(ackTarget) ? ackTarget : 0;
  const w = Number.isFinite(watermarkValue) ? watermarkValue : 0;
  return target >= w;
}

module.exports = {
  siblingAckGate, siblingBaseCursor, CURSOR_LOG_CAP, CURSOR_LOG_DIAGNOSE_SCAN,
  CURSOR_WRITES_PER_ID, cursorLogPath, logCursorWrite, readCursorLog, gcInstanceCursors,
  parseNdCursorName, assertSeatAllowsCursorWrite, commitInstanceAck, commitNdAck,
  READ_RECEIPT_TTL_MS, READ_RECEIPT_KEEP_MS, readReceiptDir, writeReadReceipt, readReadReceipt,
  applyReadAckOps, floorCursor, INST_CURSOR_SEP, ND_CURSOR_SEP, BASELINE_SUFFIX,
  DEFAULT_INSTANCE_CURSOR_STALE_MS, instCursorSafeId, RESERVED_ID_TOKENS, RESERVED_EXACT_IDS,
  reservedIdToken, instanceCursorPath, parseInstCursorName, listInstanceCursors,
  legacySharedCursor, instanceBaselinePath, readInstanceBaseline, raiseInstanceBaseline,
  instanceFloor, SIBLING_SEEN_SEP, watermarkSafeId, siblingSeenCursorPath,
  parseSiblingSeenCursorName, removeSiblingSeenCursor, readSiblingSeenCursor,
  writeSiblingSeenCursor, watermarkLockKey, withWatermarkLock, siblingWatermarkCovered,
  getSeatGuard, setSeatGuard,
};
