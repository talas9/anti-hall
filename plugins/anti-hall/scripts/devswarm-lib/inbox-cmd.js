'use strict';
// anti-hall :: devswarm CLI — INBOX-CMD module (scripts/devswarm-lib/inbox-cmd.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  CRON_FOUND_MAIL_CAP, cronFoundMailPath, devswarmRoot, fs, hasFlag, hasFreshHeartbeat,
  heartbeatPathFor, heartbeatsDir, inboxCursor, isSafeId, one, path, pidIsAlive,
  projectContextMismatch, pull, readDescriptorFile, readerCursors, readRetiredRedirect,
  recordRearmCue, repoKeyForCwd, runningAntiHallVersion, store, wakeTickDir, wakeTickPathFor,
  warnIdMismatch,
} = require('./core.js');
const {
  callerIdentityDetailed, callerReaderKey, childLabelRefusal, maybePromoteUnclaimed,
  ownershipRefusalCause, ownsAsDeclaredSelf, resolveCallerWorktree, SYNTHETIC_SESSION_PREFIX,
} = require('./identity.js');
const {
  applyReadAckOps, commitInstanceAck, commitNdAck, logCursorWrite, READ_RECEIPT_TTL_MS,
  readReadReceipt, readReceiptDir, readSiblingSeenCursor, siblingAckGate, siblingBaseCursor,
} = require('./cursors.js');
const {
  CONSUMED_HASH_SEED_CAP, consumedDedupSeed, foldSiblingGapRows, forwardedOrigHashOf,
} = require('./fold.js');
const {
  cmdRegister, refreshAnchorSession, withSelfHeal,
} = require('./register.js');
const {
  canonicalReceiptId, resolveMeshPartitionIds, resolveMeshTarget,
} = require('./send.js');
const {
  cmdInboxMessages, DEFAULT_INBOX_READ_LIMIT, inboxWindowRejection, readSideKnown, readSideMeta,
  resolveReadArgToId, resolveWorkspaceStoreForRead, storeUnavailableOut,
} = require('./inbox-read.js');

// cmdInboxAckPrimary(id, flags, ctx) — `inbox ack-primary <id> --receipt <rid>`.
// The ONLY cursor mutation of the split read path. Fails closed WITHOUT any
// write on: missing/unknown receipt, a receipt for another id or another
// reader, an expired receipt, a store that cannot be opened, or a caller that
// does not own `id` (same ownership gate as the read; --ack-as-owner overrides).
function cmdInboxAckPrimary(id, flags, ctx) {
  const home = ctx.home;
  const rid = one(flags, 'receipt');
  const base = { action: 'ack-primary', id };
  const refuse = (reason, error) => Object.assign({ ok: false, reason, error }, base);
  if (!rid || typeof rid !== 'string') return refuse('missing-receipt', '--receipt <readReceiptId> (from `inbox read-primary`) is required');
  // Store is opened EARLY (moved up from below `readReadReceipt`) so the
  // identity/alias-family resolution below (canonicalReceiptId) has a store
  // handle to enumerate the registry with — the SAME resolution
  // resolveMeshPartitionIds/meshPartitionIds already applies to reads, so a
  // receipt written for one alias (e.g. a DevSwarm-native builder-id UUID
  // row) can be found and acked through another alias registered on the
  // SAME worktree (e.g. anti-hall's own primary-<hash> row).
  const opened = resolveWorkspaceStoreForRead(id, ctx, home, { skipExistenceGuard: true });
  if (!opened.ok) return Object.assign({}, base, { ok: false, reason: opened.reason || 'store-unavailable', error: opened.error || 'store could not be opened' });
  const s = opened.store;
  let dirId = String(id);
  try {
    const desc = readDescriptorFile(home, id);
    const wtPath = desc && desc.worktreePath;
    if (wtPath) dirId = canonicalReceiptId(s, id, wtPath);
  } catch (_) { dirId = String(id); }
  const found = readReadReceipt(home, id, rid, { dirId });
  if (!found) { try { s.close(); } catch (_) {} return refuse('unknown-receipt', 'no read receipt ' + JSON.stringify(rid) + ' for ' + JSON.stringify(id) + ' — re-run `inbox read-primary ' + id + '`, then run the ackCommand it returns'); }
  const rec = found.rec;
  if (String(rec.id) !== String(id)) {
    // Not the exact literal id the receipt was issued to — still ackable
    // when both ids are the SAME identity family (crossLinkedIdentity via
    // resolveMeshPartitionIds, same worktree). Anything outside that family
    // stays refused exactly as before.
    let sameFamily = false;
    try {
      const recDesc = readDescriptorFile(home, rec.id);
      const recWtPath = recDesc && recDesc.worktreePath;
      if (recWtPath) {
        const recResolved = resolveMeshPartitionIds(s, rec.id, recWtPath);
        sameFamily = recResolved.meshUnionActive && recResolved.meshPartitionIds.indexOf(String(id)) !== -1;
      }
    } catch (_) { sameFamily = false; }
    if (!sameFamily) { try { s.close(); } catch (_) {} return refuse('receipt-owner-mismatch', 'receipt belongs to ' + JSON.stringify(rec.id)); }
  }
  const reader = callerReaderKey(ctx);
  if ((rec.reader || null) !== (reader || null)) {
    try { s.close(); } catch (_) {}
    return refuse('receipt-owner-mismatch', 'receipt was issued to a different reader — a receipt acks only for the reader that read it; re-run `inbox read-primary ' + id + '` and then its `ackCommand`');
  }
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  if (!Number.isFinite(rec.createdAt) || now - rec.createdAt > READ_RECEIPT_TTL_MS) {
    try { s.close(); } catch (_) {}
    return refuse('receipt-expired', 'receipt is older than ' + Math.round(READ_RECEIPT_TTL_MS / 3600000) + 'h — re-run `inbox read-primary ' + id + '` and then its `ackCommand` (nothing was acked; the mail is still unread)');
  }
  let applied;
  let marker = null;
  try {
    if (!flags['ack-as-owner']) {
      const callerInfo = callerIdentityDetailed(ctx.env, ctx.cwd);
      const ownEntry = resolveMeshTarget(s, callerInfo.identity, home);
      if (!(callerInfo.identity === id || (ownEntry && ownEntry.id === id) || ownsAsDeclaredSelf(s, ctx, id))) {
        return refuse(ownershipRefusalCause(callerInfo.kind, ownEntry), 'ack-primary refused: this caller does not own ' + JSON.stringify(id) + ' (use --ack-as-owner to override)');
      }
    }
    // The ack IS the drain now: mark it for the parent gate (fail-soft).
    try {
      marker = require('../../companion/lib/devswarm-drain-marker.js');
      const sid = (ctx && ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID) || null;
      marker.markDrainStart(home, id, { sessionId: sid, count: 0, now: ctx.now });
    } catch (_) { marker = null; }
    let repoKeyForLog = null;
    try { repoKeyForLog = repoKeyForCwd(ctx); } catch (_) { repoKeyForLog = null; }
    applied = applyReadAckOps(s, home, id, reader, rec.ops, { ctx, repoKey: repoKeyForLog, verb: 'ack-primary', revalidate: true });
  } finally {
    try { s.close(); } catch (_) {}
    if (marker) { try { marker.clearDrainMarker(home, id); } catch (_) {} }
  }
  const alreadyAcked = rec.ackedAt != null;
  if (!applied.failures.length && !alreadyAcked) {
    try {
      // Written back to the SAME dir the receipt was actually found in
      // (found.dirId) — canonical-family dir, or the literal-id fallback.
      const file = path.join(readReceiptDir(home, found.dirId), rid + '.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify(Object.assign({}, rec, { ackedAt: now })));
      fs.renameSync(file + '.tmp', file);
    } catch (_) { /* the cursors moved; the ackedAt stamp is informational */ }
  }
  const out = Object.assign({ ok: true }, base, {
    readReceiptId: rid, acked: applied.acked, alreadyAcked, messages: Array.isArray(rec.hashes) ? rec.hashes.length : null,
  });
  if (applied.failures.length) { out.cursorWriteFailures = applied.failures; out.cursorPersisted = false; }
  return out;
}

// cmdInboxPull(id, flags, ctx) — child-side reception drain. AUTO-ENSURES the
// descriptor (idempotent — reuses cmdRegister's write + cursor-init path with
// requireNew so an existing descriptor is left intact) so a child can pull without
// a prior explicit register, then runs ONE bounded, guard-safe pullOnce (native
// message-count gate -> at-most-one bounded read-messages -> atomic durable NDJSON
// append + store parity). Defaults: worktreePath = ctx.cwd || cwd; sessionId from
// --session / DEVSWARM_BUILDER_ID env / the id; inbox + cursor under the devswarm
// root; cursor initialized to 0.
function cmdInboxPull(id, flags, ctx) {
  const home = ctx.home;
  const root = devswarmRoot(home);
  // 0.108.4: auto-ensure was the one registration path childLabelRefusal never
  // gated, so a pull of a child's `primary-<hash>` label (reconcile sweeps every
  // registry row) re-created its tombstoned descriptor. Pull under the child's
  // canonical id instead; with no canonical id to name, write nothing.
  const labelRefusal = childLabelRefusal(id, flags, ctx);
  let aliasOf = null;
  if (labelRefusal) {
    if (!labelRefusal.resolvedTo || !isSafeId(labelRefusal.resolvedTo)) return Object.assign({ action: 'pull' }, labelRefusal);
    aliasOf = String(id);
    id = String(labelRefusal.resolvedTo);
  }
  // A6 fix: when NEITHER an explicit --session NOR DEVSWARM_BUILDER_ID names a
  // real session, do NOT mint the sessionId from `id` itself (that made a
  // bare, un-claimed auto-ensured/reconcile-spawned registry seed read as
  // permanently "live" everywhere liveness is checked, since `sessionId`
  // is the ONLY liveness signal — e.g. resolveMeshTarget could then route a
  // `send` to a partition nothing actually drains). Fall back to the
  // SYNTHETIC_SESSION_PREFIX marker instead: still non-empty/truthy (so
  // cmdRegister's own "register requires --session" validation is satisfied
  // and the descriptor stays writable/visible to the supervisor), but
  // isLiveSessionId() explicitly excludes this exact prefix, so every
  // liveness-driven mesh primitive in this file correctly treats this row as
  // NOT live until a real session (a genuine --session or
  // DEVSWARM_BUILDER_ID) claims it.
  const session = one(flags, 'session')
    || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID)
    || (SYNTHETIC_SESSION_PREFIX + id);
  // Register the RESOLVED git worktree, NOT the raw cwd — the SAME canonical
  // primitive callerIdentity uses (resolveCallerWorktree). A child that runs
  // `inbox pull` from a git SUBDIRECTORY must register the toplevel, so the
  // stored worktreePath hashes to the SAME meshId a later `send --to <its-meshId>`
  // resolves against (resolveMeshTarget hashes d.worktreePath). Registering the
  // raw subdir instead hashed to a DIFFERENT meshId, so the child failed closed
  // as `unregistered-recipient` and was unaddressable by mesh. Fall back to the
  // raw cwd ONLY for the non-git case (no toplevel resolves) — preserves the
  // existing raw-cwd behavior a non-git daemon/unit relies on.
  const rawCwd = ctx.cwd || process.cwd();
  const worktree = resolveCallerWorktree(rawCwd) || rawCwd;
  const ensureFlags = {
    worktree: [worktree],
    session: [session],
    inbox: [pull.inboxDefaultPath(home, id)],
    cursor: [pull.cursorDefaultPath(home, id)],
  };
  // requireNew: idempotent — leaves an existing descriptor (and its inboxPath)
  // untouched; only CREATES one when absent. Ownership failure must stop the
  // pull before it reads or mutates the inbox.
  const ensured = cmdRegister(id, ensureFlags, ctx, { requireNew: true });
  if (!ensured.ok) return Object.assign({}, ensured, { action: 'pull', id });
  // carry-out (e): `requireNew` leaves an EXISTING descriptor untouched, so a
  // row stamped `unclaimed:` by an earlier session-less pull would stay that way
  // forever even once a real session started pulling it. Promote AFTER the
  // ensure (so a freshly-created descriptor is already correct and this no-ops).
  const promotedPull = maybePromoteUnclaimed(home, id, flags, ctx);
  // ctx.io is undefined in production (real hivecontrol spawn); tests inject
  // { run } so the CLI path is exercised without touching a real binary — same
  // injection posture as ctx.backend / ctx.now / ctx.env already use. `cwd`
  // (v0.57 mesh D1/D8) lets pullOnce's parity feed derive this project's
  // repoKey and land the child's drained messages in the SHARED store.
  const res = pull.pullOnce({ home, id, env: ctx.env, backend: ctx.backend, now: ctx.now, cwd: worktree, io: ctx.io });
  const out = {
    ok: !!res.ok, action: 'pull', id,
    imported: res.imported || 0, duplicate: res.duplicate || 0,
    nativeCount: res.nativeCount || 0, locked: !!res.locked,
    // P1 fix: pullOnce's loss check (devswarm-pull.js) sets `lost` when the
    // native message-count exceeds what actually landed durably — this MUST
    // survive the subprocess boundary (cmdReconcile spawns this exact verb
    // and parses its stdout JSON) or a real shortfall silently vanishes
    // before the reconciler ever sees it.
    lost: res.lost || 0,
  };
  // ADDITIVE, present only when it actually happened (so an unchanged pull's
  // output stays byte-identical for existing parsers).
  if (promotedPull && promotedPull.promoted) out.sessionPromoted = promotedPull.to;
  if (aliasOf) out.redirectedFrom = aliasOf;
  // R23 P2: promoteUnclaimedSession's registryWriteError was previously
  // dropped here — a failed registry write (descriptor promoted, registry
  // still stuck on the `unclaimed:` marker) was invisible to every caller of
  // `inbox pull`. Additive `promotion` object, present only when a promotion
  // happened or a registry write actually failed this call.
  if (promotedPull && (promotedPull.promoted || promotedPull.registryWriteError)) {
    out.promotion = { promoted: !!promotedPull.promoted };
    if (promotedPull.registryWriteError) out.promotion.registryWriteError = promotedPull.registryWriteError;
  }
  if (res.nativeTimeout) out.nativeTimeout = true;
  if (res.error) out.error = res.error;
  return out;
}

function cmdInboxTick(id, flags, ctx) {
  const home = ctx.home;
  // defect 735b179362e8 (B): same fail-open id-mismatch warning as
  // cmdHeartbeat — see warnIdMismatch's own header comment.
  const idMismatch = warnIdMismatch(id, ctx);
  const anchorRefresh = refreshAnchorSession(ctx);
  const isChildFlag = hasFlag(flags, 'child');
  let pulled = null;
  if (isChildFlag) {
    // Same wrapping the 'pull' dispatch case already gives a bare `inbox pull`
    // (self-heal runs BEFORE the native drain, D-O-D7) — never skip it just
    // because this call is folded into `tick`. Best-effort: a pull failure
    // must not prevent the count/marker/heartbeat steps below from running.
    try { pulled = withSelfHeal(() => cmdInbox('pull', id, flags, ctx), ctx); } catch (_) { /* fail-open */ }
  }
  let counted = cmdInbox('count', id, flags, ctx);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  // Phase 5 delivery WAL: a pull refused because its WAL is unwritable (fail
  // closed) means native mail may be waiting that this count cannot see —
  // report it as UNKNOWN, never as a clean zero. Pending/spilled WAL batches
  // past the age/size threshold surface here too (never dropped).
  if (pulled && pulled.walBlocked) {
    counted = Object.assign({}, counted, { known: false, walBlocked: true, walError: pulled.error || null });
  }
  try {
    const alerts = require('../../companion/lib/devswarm-read-wal.js').health(fs, home, now).filter((h) => h.alert);
    if (alerts.length) counted = Object.assign({}, counted, { walAlerts: alerts });
  } catch (_) { /* health is report-only */ }

  // devswarm.tickRosterEvery (default 0 = off): every Nth `--quiet` Primary tick
  // appends the compact roster after the unchanged first line. The tick count is
  // kept as `seq` in the wake-tick marker. A tick that does not advance it (a
  // non-quiet tick) rewrites the marker with the previous `seq` carried over, so
  // the counter is never reset.
  let rosterEvery = 0;
  try { rosterEvery = Number(require('../../hooks/lib/settings.js').getWithEnv('devswarm', 'tickRosterEvery', 0, ctx.env)); } catch (_) { rosterEvery = 0; }
  const wantRoster = Number.isInteger(rosterEvery) && rosterEvery > 0 && hasFlag(flags, 'quiet') && !isChildFlag && isSafeId(id);
  let prevSeq = 0;
  if (isSafeId(id)) {
    try { prevSeq = Number(JSON.parse(fs.readFileSync(wakeTickPathFor(id, home), 'utf8')).seq) || 0; } catch (_) { prevSeq = 0; }
  }
  const tickSeq = wantRoster ? prevSeq + 1 : prevSeq;

  // Effect 1: wake-tick marker.
  try {
    if (isSafeId(id)) {
      const dir = wakeTickDir(home);
      fs.mkdirSync(dir, { recursive: true });
      const marker = {
        ts: now,
        unreadTotal: Number.isFinite(counted && counted.unreadTotal) ? counted.unreadTotal : null,
        meshGapWithheld: !!(counted && counted.meshGapWithheld),
        // Wave F1 (P0): record `known` alongside unreadTotal so
        // devswarm-child-gate.js's tickMarkerFreshZero() can refuse to treat
        // a store-unavailable tick (known:false, e.g. storeUnavailable) as a
        // genuine no-op even when unreadTotal reads 0 (the NDJSON-only
        // component). `counted.known` is already `union.known &&
        // !storeUnavailable` (see cmdInbox 'count'/'read'), so this is a
        // straight passthrough, not new logic.
        known: !!(counted && counted.known),
      };
      if (tickSeq) marker.seq = tickSeq;
      const p = wakeTickPathFor(id, home);
      const tmp = p + '.' + process.pid + '.' + process.hrtime.bigint().toString(36) + '.tick.tmp';
      fs.writeFileSync(tmp, JSON.stringify(marker));
      fs.renameSync(tmp, p);
    }
  } catch (_) { /* fail-open: marker is instrumentation only */ }

  // Effect 2: heartbeat ts refresh — bump ts/state_ts on the EXISTING file
  // only (never fabricate the other fields; matches cmdHeartbeat's authorship
  // rule). No existing heartbeat -> write a minimal, honestly-empty one, same
  // shape cmdHeartbeat would for a --session-less caller (progress/phase null,
  // wip/blockers empty, sessionId null) so a downstream reader never sees a
  // malformed record.
  try {
    if (isSafeId(id)) {
      const hbPath = heartbeatPathFor(id, home);
      let beat = null;
      try { beat = JSON.parse(fs.readFileSync(hbPath, 'utf8')); } catch (_) { beat = null; }
      if (beat && typeof beat === 'object') {
        beat.ts = now;
        beat.state_ts = now;
        // item 4a: re-stamp on EVERY tick, not only creation — the whole
        // point is to reflect the CALLING process's CURRENT running build,
        // which can change between ticks if this session restarts on a
        // newer install without ever re-registering a fresh heartbeat file.
        beat.version = runningAntiHallVersion();
      } else {
        beat = {
          id, ts: now, state_ts: now, source: 'inbox-tick',
          progress_pct: null, phase: null, wip: [], blockers: [], sessionId: null,
          version: runningAntiHallVersion(),
        };
      }
      fs.mkdirSync(heartbeatsDir(home), { recursive: true });
      const hbTmp = hbPath + '.' + process.pid + '.' + process.hrtime.bigint().toString(36) + '.tick.tmp';
      fs.writeFileSync(hbTmp, JSON.stringify(beat));
      fs.renameSync(hbTmp, hbPath);
    }
  } catch (_) { /* fail-open: heartbeat refresh is best-effort */ }

  // Effect 3: cron-found-mail measurement — only when this tick genuinely
  // found unread AND a Monitor watcher lock for this id already exists (the
  // lock's mere presence is enough; it is NOT staleness-checked here — this
  // is a coarse measurement counter, not a liveness gate, and a stale lock
  // still means "a watcher was armed for this id at some point").
  try {
    const unreadTotal = counted && counted.unreadTotal;
    if (isSafeId(id) && Number.isFinite(unreadTotal) && unreadTotal > 0) {
      let lockPathFor = null;
      try { ({ lockPathFor } = require('../../companion/lib/devswarm-wake-watch.js')); } catch (_) { lockPathFor = null; }
      const lockPath = lockPathFor ? lockPathFor(home, id) : null;
      if (lockPath && fs.existsSync(lockPath)) {
        const p = cronFoundMailPath(home);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        let lines = [];
        try { lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch (_) { lines = []; }
        lines.push(JSON.stringify({ ts: now, id, unreadTotal }));
        if (lines.length > CRON_FOUND_MAIL_CAP) lines = lines.slice(lines.length - CRON_FOUND_MAIL_CAP);
        fs.writeFileSync(p, lines.join('\n') + '\n');
      }
    }
  } catch (_) { /* fail-open: measurement only, never breaks the tick */ }

  // watcherArmed (peer D): does a LIVE Monitor wake-watch currently cover
  // this id, right now, not "was one armed at some point" (Effect 3's
  // cron-found-mail check above deliberately ignores staleness — this one
  // must not). Reuses the SAME lock file + freshness window + pid-alive
  // guard the watcher's own steal-check already uses (devswarm-wake-watch.js
  // WATCH_LOCK_STALE_MS / lockPathFor, liveness.js pidIsAlive) — never a
  // second staleness rule invented here. A missing/unreadable/malformed lock
  // reads as false (fail CLOSED on this one signal specifically: the whole
  // point is telling the cron-prompt directive "go re-arm it", and an
  // over-optimistic true would suppress that nudge).
  let watcherArmed = false;
  try {
    if (isSafeId(id)) {
      // The id's own lock, or (a Primary) the lock of another row on the SAME checkout: a Monitor armed under the
      // DevSwarm app's own row id for the Primary's checkout is still the live watcher covering it.
      const wakeWatch = require('../../companion/lib/devswarm-wake-watch.js');
      watcherArmed = isChildFlag ? wakeWatch.watcherLockLive(home, id, now, { pidIsAlive }) : wakeWatch.watcherLiveForWorkspace(home, id, now, { pidIsAlive });
    }
  } catch (_) { watcherArmed = false; }

  // ARCHIVED-SKIP: a `--child` caller whose own workspace is ARCHIVED (the
  // row-eligibility.js projection — the one archived predicate) must never be
  // told to re-arm its Monitor: its wake-watch deliberately stays silent for an
  // archived child (devswarm-wake-watch.js isOwnChildArchived), so a bare
  // `false` here would only send it into a re-arm loop. `watcherArmed` becomes
  // the STRING `'archived-skip'` (never `false`, so the cron prompt's
  // "re-arm only if `false`" stays inert). unread/meshGap are untouched, so
  // real mail is still reported. Gated by the existing
  // devswarm.archivedChildStop switch (off = pre-fix). Fail-open.
  let archivedSkipped = false;
  if (!watcherArmed && isChildFlag && isSafeId(id)) {
    try {
      // ONE shared decision with the watcher (switch, active-descriptor/twin
      // and unregistered-child guards live in isOwnChildArchived).
      if (require('../../companion/lib/devswarm-wake-watch.js').isOwnChildArchived(
        { role: 'child', id, home, cwd: ctx.cwd || process.cwd() }, ctx.env,
      )) {
        watcherArmed = 'archived-skip';
        archivedSkipped = true;
      }
    } catch (_) { /* fail-open: keep watcherArmed exactly as the lock check computed it */ }
  }

  // IDLE-SKIP (#39, devswarm.wakeWatchIdleSkip, default true): a Primary
  // (never a `--child` caller — a child's watcher covers ITS OWN mail, not a
  // roster) with 0 LIVE (non-archived) child workspaces gains nothing from an
  // armed wake-watch Monitor — nothing will ever message it. Only evaluated
  // when the lock-based check above already read `false` (a truly-armed
  // watcher is reported as such, unconditionally). `watcherArmed` becomes the
  // STRING `'idle-skip'` (truthy, so `!watcherArmed` below and every existing
  // `!== false` / falsy consumer treats it as "armed enough, don't nag"),
  // never the boolean `false` — this is what stops drainCmd's rearmClause
  // (hooks/lib/devswarm-wake.js) from firing its "re-arm it" instruction.
  // Fail-open: any error here leaves `watcherArmed` exactly as computed above.
  // `idle-skip` only means "no child to hear from"; it does NOT assert a cron
  // exists (this tick running proves one did a moment ago, nothing more). A
  // Primary that later spawns children is told about a missing watcher/cron by
  // companion/lib/devswarm-wake-coverage.js (per-prompt hook, spawn, Stop gate).
  let idleSkipped = false;
  if (!watcherArmed && !isChildFlag && isSafeId(id)) {
    try {
      let idleSkipOn = true;
      try { idleSkipOn = require('../../hooks/lib/settings.js').getWithEnv('devswarm', 'wakeWatchIdleSkip', true, ctx.env) !== false; }
      catch (_) { idleSkipOn = true; }
      if (idleSkipOn) {
        // A1-3 (0.118.0 follow-up): scope hasLiveChild from the TICK ID's own
        // registered worktreePath, not the CALLING process's cwd. A tick can
        // run from a different clone/checkout of the same project than the
        // one `id` is registered under (a second worktree, a script invoked
        // from elsewhere) - process.cwd() then resolves to a DIFFERENT
        // repoKey (repoKeyForWorktree keys off --git-common-dir, which is
        // per-checkout), so hasLiveChild's project scoping silently missed
        // every real sibling child and idle-skip fired even with live
        // children. If the id's own descriptor/registry can't be resolved,
        // fail open: skip the idle-skip check entirely (never idle-skip on
        // an unresolvable scope) rather than falling back to process.cwd().
        let scopeWorktree = null;
        try {
          const selfDesc = readDescriptorFile(home, id);
          if (selfDesc && typeof selfDesc.worktreePath === 'string' && selfDesc.worktreePath) {
            scopeWorktree = selfDesc.worktreePath;
          }
        } catch (_) { scopeWorktree = null; }
        if (scopeWorktree) {
          const liveChildren = require('../../companion/lib/devswarm-live-children.js');
          if (!liveChildren.hasLiveChild(home, scopeWorktree, { env: ctx.env, excludeHeldIgnored: true })) {
            watcherArmed = 'idle-skip';
            idleSkipped = true;
          }
        }
      }
    } catch (_) { /* fail-open: keep watcherArmed exactly as the lock check computed it */ }
  }

  // LIMIT-SKIP (field report, mirrors #39's idle-skip): while LIMIT
  // CONSERVATION is active (usage at/above its threshold — hooks/
  // limit-conserve.js isConserving()), re-arming the Monitor wake-watch is
  // exactly the kind of non-urgent background action limit-conserve-inject.js
  // already tells the agent to defer; nagging "re-arm it" here directly
  // contradicts that instruction. Only evaluated when watcherArmed still
  // reads `false` (a truly-armed watcher, or an idle-skip already decided
  // above, is always reported as such — never overridden). `watcherArmed`
  // becomes the STRING `'limit-skip'` (truthy, same as idle-skip, so every
  // `!watcherArmed` / `!== false` consumer treats it as "don't nag").
  // Fail-open: any error leaves `watcherArmed` exactly as computed above.
  let limitSkipped = false;
  if (!watcherArmed && isSafeId(id)) {
    try {
      if (require('../../hooks/limit-conserve.js').isConserving({ home }).active) {
        watcherArmed = 'limit-skip';
        limitSkipped = true;
      }
    } catch (_) { /* fail-open: keep watcherArmed exactly as computed above */ }
  }

  // this tick is the re-arm CUE point (see rearmMetricsPath's header above):
  // watcherArmed:false is exactly the condition drainCmd's rearmClause fires
  // the "re-arm it" instruction on. An idle-skip/limit-skip is a DELIBERATE
  // no-arm decision, not a lapse — each gets its own trigger bucket so
  // doctor's idle-skip/limit-skip counts and the legacy re-arm-cue count
  // never conflate them.
  if (archivedSkipped) recordRearmCue(home, id, 'archived-skip');
  else if (idleSkipped) recordRearmCue(home, id, 'idle-skip');
  else if (limitSkipped) recordRearmCue(home, id, 'limit-skip');
  else if (!watcherArmed && isSafeId(id)) recordRearmCue(home, id, 'tick');

  const tickOut = Object.assign({}, counted, { action: 'tick', idMismatch, watcherArmed });
  if (anchorRefresh && anchorRefresh.refreshed) tickOut.anchorRefresh = anchorRefresh;
  // Interval roster: only on the Nth tick, with unread 0 and known, and only on POSITIVE
  // proof of a live child (a live non-self roster row AND hasLiveChild, which fails open to
  // "has a child" on doubt). Non-enumerable, so the JSON form of tick is never changed;
  // inboxTickQuietLine prints it after the unchanged first line.
  if (wantRoster && tickSeq % rosterEvery === 0 && counted && counted.known && counted.unreadTotal === 0) {
    try {
      const selfDesc = readDescriptorFile(home, id);
      const scopeWorktree = selfDesc && typeof selfDesc.worktreePath === 'string' ? selfDesc.worktreePath : null;
      if (scopeWorktree && require('../../companion/lib/devswarm-live-children.js').hasLiveChild(home, scopeWorktree)) {
        const roster = require('./roster-diag.js');
        const r = roster.cmdRoster({}, ctx);
        const liveOthers = r && r.ok && r.known && Array.isArray(r.workspaces)
          ? r.workspaces.filter((w) => w && String(w.id) !== String(id) && !roster.rosterIsArchivedRow(w)) : [];
        if (liveOthers.length > 0) {
          Object.defineProperty(tickOut, 'rosterText', { value: roster.rosterHumanText(r, { home, now }), enumerable: false });
        }
      }
    } catch (_) { /* fail-open: the tick line alone */ }
  }
  return tickOut;
}

function cmdInbox(sub, id, flags, ctx) {
  // CALLER INSTANCE IDENTITY (defect 8b211241bbe9). `deriveInstanceNonce` never
  // returns null and is memoized per process, so this is one cheap, stable value
  // per invocation: the same harness session (main thread, a cron turn, a
  // Monitor turn — all children of the same claude process) resolves the SAME
  // nonce, while a genuinely separate process gets its own. Short form only —
  // the raw nonce is process-identifying and never lands in a filename.
  let callerReader = null;
  // `ctx.instanceNonce` is an IN-PROCESS override only — nothing in `run()`'s
  // argv/env parsing ever sets it, so it is not a spoofing surface; it exists
  // because `deriveInstanceNonce` memoizes per process (deliberately), which
  // would otherwise collapse two simulated instances in one test run into one.
  callerReader = callerReaderKey(ctx); // Phase 3: full reader key ('h:<pid>:<startMs>') or null (headless)
  let callerRepoKeyForLog = null;
  try { callerRepoKeyForLog = repoKeyForCwd(ctx); } catch (_) { callerRepoKeyForLog = null; }

  const home = ctx.home;
  // --since/--tail belong to the NON-ACKING `inbox messages` verb only. Every
  // other sub-verb here either acks a contiguous unread prefix (`read`, `ack`,
  // `read-primary`) or reports counts over one (`count`), and a window cannot
  // be expressed as a prefix — see INBOX_WINDOW_FLAGS' header. Reject loudly;
  // the pre-fix behaviour (silently ignoring the flag and returning the
  // EARLIEST rows while the caller believed they asked for the newest) is the
  // defect. `messages` is excluded here and handles the flags itself.
  if (sub !== 'messages') {
    const rej = inboxWindowRejection(flags, 'inbox ' + String(sub));
    if (rej) return rej;
  }
  if (sub === 'tick') return cmdInboxTick(id, flags, ctx);
  if (sub === 'pull') return cmdInboxPull(id, flags, ctx);
  if (sub === 'ack-primary') return cmdInboxAckPrimary(id, flags, ctx);
  // B2 (defects 902d3c5e7531/1932b53a3ace, id resolution parity): every read
  // verb below must accept a meshId exactly as `send --to` does
  // (resolveSendTarget/resolveMeshTarget). FALLBACK-ONLY by design (not a
  // resolution attempted unconditionally up front): the ordinary case — `id`
  // is already an exact registry-row id — must stay BYTE-IDENTICAL to
  // pre-fix, including opening the store EXACTLY ONCE (a drain-marker
  // instrumentation test asserts this: `inbox read-primary` on a plain,
  // already-resolvable id calls `store.openStore` exactly once, and an
  // eager resolveReadArgToId pre-check consumed that single call itself,
  // silently breaking the marker-visibility assertion it exists to prove).
  // Resolution is attempted ONLY after the ordinary path has already refused
  // this literal `id` as unregistered — the exact case `send --to` could
  // route but no read verb could reach.
  let readArgResolvedFrom = null;
  if (sub === 'messages' || sub === 'read-primary' || sub === 'peek-primary' || sub === 'drain-primary-legacy') {
    // Phase 5 ack split: `read-primary` (and `messages --ack`) are READ-ONLY —
    // they return a read receipt; `ack-primary --receipt` is the ack.
    // `drain-primary-legacy` / `--legacy-ack-now` keep the old same-call
    // read-and-ack for ONE deprecation release (no env var restores it).
    const legacyNow = sub === 'drain-primary-legacy' || !!flags['legacy-ack-now'];
    if (sub === 'messages' && flags.ack && !legacyNow) {
      try {
        process.stderr.write('[devswarm] inbox messages --ack no longer acks: it returns a read receipt — '
          + 'run the returned ackCommand (inbox ack-primary ' + String(id) + ' --receipt <id>) after consuming the mail.\n');
      } catch (_) {}
    }
    const opts = sub === 'read-primary' ? (legacyNow ? { ack: true } : { ack: true, deferAck: true })
      : sub === 'drain-primary-legacy' ? { ack: true, action: 'drain-primary-legacy' }
      : sub === 'peek-primary' ? { ack: false, unread: true, action: 'peek-primary' }
      : (flags.ack && !legacyNow) ? { deferAck: true }
      : undefined;
    // B2/1932b53a3ace (read-primary/peek-primary meshId parity, follow-up
    // fix): `read-primary`'s doAck path opens its store with
    // `skipExistenceGuard: true` (by design — its OWN ownership check is the
    // more specific fail-closed gate) — so a literal meshId with NO
    // descriptor/registry row of its own does not refuse as
    // 'unregistered-workspace' the way `peek-primary`/`messages` do; it opens
    // a brand-new, EMPTY fail-open partition keyed on that literal string and
    // returns ok:true with zero messages, NEVER reaching the retry check
    // below (r.ok is already true) even though the very same meshId, given
    // to `peek-primary` moments earlier, correctly resolved to the real
    // owning row. That silently diverges the two verbs the D11-C comment
    // above documents as reading "the SAME rows" — `read-primary` reported an
    // empty inbox while `peek-primary` on the identical id showed real mail.
    //
    // Fix: resolve BEFORE calling cmdInboxMessages whenever the literal `id`
    // is not itself an exact registry row (readDescriptorFile is null) — the
    // same precondition the count/read/ack branch below already uses. This
    // preserves the "opens store exactly once" contract for the ORDINARY
    // case (an id that already has its own descriptor skips resolution
    // entirely, identical to before this fix); only a literal id with
    // nothing of its own registered attempts resolution, and only once.
    //
    // DEFERS to the fold-time retired-redirect tombstone (73303d4c098b) when
    // one exists for this exact `id`: cmdInboxMessagesInner has its OWN
    // one-hop readRetiredRedirect resolution (a DIFFERENT mechanism —
    // per-id tombstones written by foldGroupIntoSurvivor, not a meshId
    // group) that sets `redirected`/`redirectedFrom` on its own output. A
    // retired id's worktree usually STILL shares a meshId with the surviving
    // row (the fold folds a same-worktree twin), so resolveReadArgToId would
    // ALSO resolve it via the meshId pass — reaching the survivor through a
    // DIFFERENT path and reporting `resolvedFrom` instead, silently dropping
    // the `redirected`/`redirectedFrom` contract callers of a folded id rely
    // on. Skipping this pre-check when a tombstone exists leaves that id on
    // its original path (cmdInboxMessages -> its own internal redirect),
    // unchanged from before this fix.
    let resolvedFromArg = null;
    let effectiveId = id;
    if (!readDescriptorFile(home, id) && !readRetiredRedirect(home, id)) {
      const resolvedArg = resolveReadArgToId(ctx, home, id);
      if (resolvedArg.ambiguous) {
        return {
          ok: false, id, reason: 'ambiguous-target',
          error: 'inbox ' + sub + ' ' + JSON.stringify(id) + ' is ambiguous between candidate rows '
            + JSON.stringify(resolvedArg.candidates) + ' — address one by its exact registry id',
          candidates: resolvedArg.candidates,
        };
      }
      if (resolvedArg.resolvedFrom) { effectiveId = resolvedArg.id; resolvedFromArg = resolvedArg.resolvedFrom; }
    }
    let r = cmdInboxMessages(effectiveId, flags, ctx, opts);
    // Legacy fallback, unchanged: an id that DID have its own descriptor (so
    // the pre-check above skipped resolution and never touched
    // resolvedFromArg) can still refuse as 'unregistered-workspace'/
    // 'store-unavailable' inside cmdInboxMessages itself (e.g. a stale
    // descriptor pointing at a store that no longer resolves) — retry via
    // resolution exactly as before this fix.
    if (!resolvedFromArg && (!r || (r.ok === false && (r.reason === 'unregistered-workspace' || r.reason === 'store-unavailable')))) {
      const resolvedArg = resolveReadArgToId(ctx, home, id);
      if (resolvedArg.ambiguous) {
        return {
          ok: false, id, reason: 'ambiguous-target',
          error: 'inbox ' + sub + ' ' + JSON.stringify(id) + ' is ambiguous between candidate rows '
            + JSON.stringify(resolvedArg.candidates) + ' — address one by its exact registry id',
          candidates: resolvedArg.candidates,
        };
      }
      if (resolvedArg.resolvedFrom) {
        r = cmdInboxMessages(resolvedArg.id, flags, ctx, opts);
        resolvedFromArg = resolvedArg.resolvedFrom;
      }
    }
    if (r && r.ok && resolvedFromArg) r.resolvedFrom = resolvedFromArg;
    // --ack-after-print (peer request C): opt-in immediate ack right after a
    // `read-primary` — otherwise the default stays the two-step
    // read-then-`ack-primary --receipt` flow (nothing here changes when the
    // flag is absent). Runs the SAME `ackCommand` this read just returned,
    // against the id the receipt was actually filed under (r.id, which may
    // differ from the caller's literal `id` after a resolve/redirect above),
    // so the ack applies to exactly what was printed — never a bare boolean
    // no-op the way `--ack-as-owner` on `messages` warns about elsewhere.
    if (sub === 'read-primary' && r && r.ok && r.readReceiptId && hasFlag(flags, 'ack-after-print')) {
      const ackFlags = { receipt: [r.readReceiptId] };
      if (hasFlag(flags, 'ack-as-owner')) ackFlags['ack-as-owner'] = [true];
      try {
        r.autoAck = cmdInboxAckPrimary(r.id, ackFlags, ctx);
      } catch (e) {
        r.autoAck = { ok: false, error: 'ack-after-print threw: ' + String((e && e.message) || e) };
      }
    }
    return r;
  }
  const desc = readDescriptorFile(home, id);
  // fl-wave3/73303d4c098b (count/read/ack retired-redirect parity): mirror the
  // `messages`/`read-primary`/`peek-primary` branch's `&& !readRetiredRedirect(home, id)`
  // guard (~line 7739 above). A fold-retired id has NO descriptor of its own
  // (foldOne only tombstones a candidate when readDescriptorFile is already
  // null) but MAY still share a meshId with the survivor it was folded into —
  // left unguarded, the generic resolveReadArgToId fallback below resolves it
  // through the ordinary meshId pass, silently reporting `resolvedFrom` and,
  // worse, handing count/read/ack the SURVIVOR's own descriptor keyed on
  // nothing but a dead id string — an arbitrary/unregistered caller could then
  // advance the survivor's real NDJSON cursor via `ack <retiredId>`. Resolve
  // the tombstone directly instead (the same one-hop cmdInboxMessagesInner
  // already applies at ~line 6418), requiring `id` to have no LIVE registry
  // row of its own (a re-registered id must see its OWN row, never a stale
  // redirect) — reporting `redirected`/`redirectedFrom`, never `resolvedFrom`,
  // for this path.
  let retiredRedirectFromId = null;
  let effectiveDesc = desc;
  if ((!desc || !desc.inboxPath) && readRetiredRedirect(home, id)) {
    const redirectedTo = readRetiredRedirect(home, id);
    let hasRegistryRow = false;
    try {
      const probeRepoKey = repoKeyForCwd(ctx);
      const probeStore = store.openStore({ home, workspaceId: id, hash: probeRepoKey || undefined, backend: ctx.backend, env: ctx.env });
      try { hasRegistryRow = (probeStore.listRegistry() || []).some((r) => r && String(r.id) === String(id)); }
      finally { probeStore.close(); }
    } catch (_) { hasRegistryRow = false; }
    if (redirectedTo && String(redirectedTo) !== String(id) && !hasRegistryRow) {
      const redirectedDesc = readDescriptorFile(home, redirectedTo);
      if (redirectedDesc && redirectedDesc.inboxPath) {
        // REDIRECT-TO-LIVE GUARD (defect 8b211241bbe9 §2e, reinstated in R1).
        //
        // An earlier pass removed this on the reasoning that the `ownsSurvivor`
        // check below already refuses the ack. THAT REASONING WAS WRONG: that
        // check is gated `retiredRedirectFromId && !flags['ack-as-owner']`, so
        // the override BYPASSES it — and the hazard is precisely an
        // `--ack-as-owner` instruction. After a fold the retired id is absent
        // from registry AND descriptors, the parent hook renders it as a retired
        // sender with that very instruction, and the redirect below reassigns
        // the target to the survivor, which can be a LIVE twin.
        //
        // The override's sanctioned purpose is a retired target with NO live
        // owner. A redirect landing on a live owner is outside it: refuse the
        // ACK (reads still redirect) and journal why.
        // POSITIVE EVIDENCE ONLY — a FRESH HEARTBEAT, not `isSiblingPartitionLive`.
        //
        // That predicate deliberately fails TOWARD live (an undetermined verdict
        // reads as live), which is right where the cost of guessing wrong is
        // re-delivery. Here the cost is inverted: guessing "live" REFUSES the
        // override, and the override's whole sanctioned purpose is a retired
        // target with NO live owner. Using the fail-toward-live predicate
        // refused a survivor with no heartbeat at all (caught by test), which
        // would have broken the one path this override exists to serve.
        // `hasFreshHeartbeat` is positive evidence: the survivor's own
        // heartbeat file, written recently, keyed on its own id.
        let survivorLive = false;
        try {
          survivorLive = hasFreshHeartbeat(String(redirectedTo), home);
        } catch (_) { survivorLive = false; } // no evidence -> not live -> allow the override
        // Scoped to the OVERRIDE path only. Without `--ack-as-owner` the
        // pre-existing `ownsSurvivor` refusal below already blocks this and
        // owns the established `retired-redirect-unresolvable-caller` reason;
        // preempting it there would change a documented contract for no safety
        // gain. The override is the one path that check does not cover.
        if (survivorLive && sub === 'ack' && flags['ack-as-owner']) {
          try {
            logCursorWrite(home, {
              id: String(redirectedTo), partition: String(redirectedTo), callerId: String(id),
              ns: 'store', from: null, to: null, delivered: null, gate: 'redirect-to-live',
              verb: 'inbox-ack', cwd: (ctx && ctx.cwd) || null, ok: false,
              err: 'refused: retired id ' + String(id) + ' redirects to LIVE owner ' + String(redirectedTo),
              repoKey: callerRepoKeyForLog,
            });
          } catch (_) { /* instrumentation only */ }
          return {
            ok: false, action: sub, id: String(id), reason: 'redirect-to-live-owner',
            redirectedTo: String(redirectedTo),
            error: 'refusing to ack retired id ' + JSON.stringify(String(id)) + ' — it redirects to '
              + JSON.stringify(String(redirectedTo)) + ', whose owner is LIVE. Acking here would consume '
              + 'that live agent\'s mail. Ack the survivor from its own session, or read without --ack.',
          };
        }
        retiredRedirectFromId = String(id);
        id = String(redirectedTo);
        effectiveDesc = redirectedDesc;
      }
    }
  }
  if (!effectiveDesc || !effectiveDesc.inboxPath) {
    // B2 fallback: the literal `id` has no descriptor at all (the shape
    // `count`/`read`/`ack` require) — try meshId/exact-id/redirect
    // resolution (the same one `messages`/`read-primary`/`peek-primary` use
    // above) before failing closed; a resolved id with its OWN descriptor
    // then proceeds through the normal count/read/ack path below.
    const resolvedArg = resolveReadArgToId(ctx, home, id);
    if (resolvedArg.ambiguous) {
      return {
        ok: false, id, reason: 'ambiguous-target',
        error: 'inbox ' + sub + ' ' + JSON.stringify(id) + ' is ambiguous between candidate rows '
          + JSON.stringify(resolvedArg.candidates) + ' — address one by its exact registry id',
        candidates: resolvedArg.candidates,
      };
    }
    const resolvedDesc = resolvedArg.resolvedFrom ? readDescriptorFile(home, resolvedArg.id) : null;
    if (!resolvedDesc || !resolvedDesc.inboxPath) {
      // fl-wave3 fix (item 9): this used to return a bare `{ok:false, error}`
      // — no `reason`, no B1 meta, no `known` — for the EXACT SAME "no live
      // descriptor for this id" condition `peek-primary`/`messages` already
      // report via FIX 5's existence guard (resolveWorkspaceStoreForRead,
      // ~line 6220) with a real reason and full meta. Determine the SAME way
      // FIX 5 does (registry row / message history) so `count`/`read`/`ack`
      // agree with every other read verb on the SAME literal id: a genuinely
      // unregistered id (no descriptor, no registry row, no store history)
      // reports 'unregistered-workspace'; a registry-only row with no
      // descriptor of its own (e.g. a `spawn` placeholder never given an
      // --inbox path) is a real, distinct condition and gets its own honest
      // reason rather than being mislabeled as either shape.
      let failReason = 'unregistered-workspace';
      let storeHandleForMeta = null;
      let probeStoreUnavailableReason = null;
      try {
        const probeRepoKey = repoKeyForCwd(ctx);
        storeHandleForMeta = store.openStore({ home, workspaceId: id, hash: probeRepoKey || undefined, backend: ctx.backend, env: ctx.env });
        const hasRegistryRow = (storeHandleForMeta.listRegistry() || []).some((r) => r && String(r.id) === String(id));
        const hasMessages = storeHandleForMeta.messageCount(id) > 0;
        // fl-wave6 fix (P2, item 6): the JOURNAL backend's open is LAZY
        // (openJournal creates nothing until an append) — a chmod-000
        // journal dir does NOT throw here the way sqlite's EAGER open does;
        // `listRegistry()`/`messageCount()` both fail-open through readAll()
        // (see that function's own header comment) and silently returned
        // `false`/`0`, so this probe kept the DEFAULT 'unregistered-
        // workspace' reason — telling the operator to "register it first"
        // on a store the probe genuinely could not read, the exact
        // misleading outcome the catch block below already fixes for the
        // sqlite (throw-on-open) case. `getReadError()` is the deferred
        // escalation point readAll() populates on a genuine (non-ENOENT) fs
        // error — probe it right after the reads above, same as
        // resolveWorkspaceStoreForRead's own post-pipeline probe.
        const readErr = storeHandleForMeta.getReadError && storeHandleForMeta.getReadError();
        if (readErr) {
          failReason = 'store-unavailable';
          probeStoreUnavailableReason = readErr.code || 'EUNKNOWN';
        } else if (hasRegistryRow || hasMessages) failReason = 'no-inbox-path';
      } catch (e) {
        // fl-wave5 fix (item 2): the probe open itself THROWING (EACCES/
        // ENOTDIR/ESTOREUNAVAILABLE — a chmod-000 dir or a corrupt db header,
        // the same class store.openStore's OTHER caller in this file,
        // resolveWorkspaceStoreForRead, already maps to 'store-unavailable')
        // is a genuinely different condition than "no descriptor, no
        // registry row, no messages" — this catch used to swallow it
        // silently and keep the default 'unregistered-workspace' reason,
        // telling the operator to "register it first" when the real blocker
        // is a store the probe could not even open. Neither branch's
        // evidence (hasRegistryRow/hasMessages) was actually gathered, so
        // report it honestly instead.
        failReason = 'store-unavailable';
        probeStoreUnavailableReason = (e && e.storeUnavailableReason) || (e && e.code) || 'EUNKNOWN';
      }
      const failMeta = readSideMeta(ctx, home, storeHandleForMeta, id);
      if (storeHandleForMeta) { try { storeHandleForMeta.close(); } catch (_) {} }
      return {
        ok: false, id, reason: failReason,
        error: failReason === 'unregistered-workspace'
          ? ('workspace ' + JSON.stringify(id) + ' is not registered and has no messages '
            + '(no descriptor, no registry row, no store history) — register it first (or check the id for a typo)')
          : failReason === 'store-unavailable'
          ? ('store for workspace ' + JSON.stringify(id) + ' could not be opened: ' + probeStoreUnavailableReason)
          : ('no inboxPath for workspace ' + JSON.stringify(id) + ' (registered, but never given an --inbox path — register it first)'),
        repoKey: failMeta.repoKey, storePath: failMeta.storePath, cwd: failMeta.cwd,
        meshPartitionIds: [String(id)], known: false,
        storeUnavailable: failReason === 'store-unavailable',
        storeUnavailableReason: failReason === 'store-unavailable' ? probeStoreUnavailableReason : null,
        meshGroupUnresolved: false, meshGroupError: null, totalsPartial: true,
      };
    }
    readArgResolvedFrom = resolvedArg.resolvedFrom;
    id = resolvedArg.id;
  }
  const finalDesc = readArgResolvedFrom ? readDescriptorFile(home, id) : effectiveDesc;
  const inboxPath = finalDesc.inboxPath;
  // PER-INSTANCE NDJSON CURSOR (defect 8b211241bbe9, R1 item 11): read and ack
  // against THIS instance's own cursor file, not the single descriptor cursor
  // every instance of this workspace shared. The descriptor's cursor is kept as
  // a min-projection below so every existing consumer of it stays loss-free.
  const descCursorPath = finalDesc.cursorPath;
  // Phase 3: `cursorPath` is the descriptor file (for `known`); the NDJSON read
  // position itself is this reader's reader_cursors row (ns 'nd').
  const cursorPath = descCursorPath;
  if (sub === 'count' || sub === 'read' || sub === 'ack') {
    // P0 fix (parent->child direct messages silently undeliverable): `send --to`
    // (cmdSend/appendMeshMessage) is a STORE-ONLY write — it never touches this
    // descriptor's durable NDJSON, which is populated ONLY by `inbox pull` draining
    // the NATIVE hivecontrol queue (devswarm-pull.js pullOnce). When native
    // hivecontrol messaging is unavailable, nothing ever writes the NDJSON, so a
    // mesh-direct message sent to `id` was invisible to `inbox count/read/ack`
    // even though `inbox messages <id>` (the store-direct read) saw it immediately.
    // LOSS-FREE UNION (not winner-take-all): merge in the STORE's messages for
    // `id`, deduped by content hash against the NDJSON side — a native-drained
    // message carries the SAME `native:`-prefixed hash in both channels (see
    // devswarm-ingest.js messageHash / devswarm-pull.js's `_h` field and its
    // best-effort store-parity feed), so it is correctly excluded from the
    // store-only tally; a mesh-direct `send --to` message exists ONLY in the
    // store (`mesh:`-prefixed hash) and is therefore always additive here.
    // Best-effort: any store-open failure (e.g. a genuine cross-project id
    // mismatch) falls back to the PRE-fix NDJSON-only reporting — count/read
    // never newly hard-fail because of this merge.
    //
    // The actual union MATH now lives in companion/lib/devswarm-unread.js
    // (unionUnread) — shared with hooks + liveness.js so all three readers
    // agree on one implementation instead of drifting copies. This call site
    // keeps its OWN store-open/ownership/rehome logic (resolveWorkspaceStoreForRead)
    // unchanged — that part is CLI-specific — and only delegates the merge
    // computation, so output stays byte-identical to before this refactor.
    let storeHandle = null;
    // storeUnavailable (defect e586afdaa968): the store side being unopenable
    // is NOT the same fact as "the store side holds 0 unread", but that is
    // exactly how it read — the refusal was swallowed here and the response
    // still carried unreadStore:0 / cursorStore:0 / known:true, indistinguish-
    // able from an empty mailbox. The commonest cause is the id being
    // registered in ANOTHER project, i.e. precisely the workspace whose mail
    // this caller structurally cannot see. Delivery stays fail-open (the
    // NDJSON side is still reported, count/read never newly hard-fail), but
    // the store side is now reported as UNKNOWN, with the reason attached.
    let storeUnavailable = null;
    try {
      const opened = resolveWorkspaceStoreForRead(id, ctx, home);
      if (opened.ok) storeHandle = opened.store;
      else {
        storeUnavailable = {
          reason: opened.reason || 'store-unavailable',
          error: opened.error || null,
          registeredRepoKey: opened.registeredRepoKey || null,
          callerRepoKey: opened.callerRepoKey || null,
          // fl-wave4 fix (item 2): the underlying fs error code (e.g. 'EACCES')
          // when the reason is the generic 'store-unavailable' bucket — null
          // for every other, more-specific refusal reason.
          storeUnavailableReason: opened.storeUnavailableReason || null,
        };
      }
    } catch (e) {
      storeUnavailable = {
        reason: 'store-open-failed',
        error: String((e && e.message) || e),
        registeredRepoKey: null,
        callerRepoKey: null,
        storeUnavailableReason: null,
      };
    }
    // Per-instance store base (defect 8b211241bbe9, R1 P0) — `inbox count/read/
    // ack` must size the store side from THIS instance's position, not the
    // shared projection, or `count` disagrees with `read-primary` per instance.
    // Phase 3: ONE countFor for count/read/ack. A read error is UNKNOWN — the
    // store side is then reported unavailable (never a silent 0).
    let union = readerCursors.countFor(storeHandle, { reader: callerReader, partition: id, inboxPath, cursorPath, home, now: ctx && ctx.now });
    if (union.unknown) {
      if (!storeUnavailable) {
        storeUnavailable = {
          reason: 'store-read-error', error: union.error || union.reason || null,
          registeredRepoKey: null, callerRepoKey: null, storeUnavailableReason: union.reason || null,
        };
      }
      union = readerCursors.countFor(null, { reader: callerReader, partition: id, inboxPath, cursorPath, home, now: ctx && ctx.now });
      try { if (storeHandle) storeHandle.close(); } catch (_) {}
      storeHandle = null;
    }
    const storeCursorVal = union.storeCursor;
    let storeOnlyUnreadRows = union.storeOnlyUnreadRows;

    // ---- MESH PARTITION WIDENING (defect 27cd80902435, remaining gap) ----
    // `count`/`read`/`ack` read `id`'s own store partition ONLY (via
    // unionUnread above) even when `id` belongs to a multi-row mesh group —
    // two registry rows sharing one meshId, the exact field case this defect
    // reports (372 real messages sat unread in a sibling partition this path
    // never opened, while `count` reported the dead partition's total as if
    // it were complete). Reuses resolveMeshPartitionIds — the SAME
    // canonicalMeshId/meshCandidateRows grouping cmdInboxMessages's
    // read-primary/peek-primary fix (v0.82.0/14c73f9) and `send --to-primary`
    // already use — no parallel implementation. STORE-side only (mirrors
    // cmdInboxMessages's own sibling widening — the NDJSON descriptor channel
    // is per-`id`, not per-mesh-group). Each sibling's own STORE cursor
    // (storeHandle.cursorValue(pid) — the SAME per-partition cursor namespace
    // `union.storeCursor` above uses for `id`) gates its own unread slice, so
    // a sibling's cursor can never be conflated with `id`'s. Fail-open: any
    // resolution/read error narrows to `id`'s own partition, identical to the
    // pre-fix single-partition read.
    let meshPartitionIds = [String(id)];
    let meshUnionActive = false;
    let meshGroupUnresolved = false;
    let meshGroupError = null;
    const meshSiblingPartitions = [];
    let meshAddedTotal = 0;
    let meshAddedUnreadCount = 0;
    if (storeHandle) {
      let wtPath = null;
      try {
        const selfRow = (storeHandle.listRegistry() || []).find((r) => r && String(r.id) === String(id));
        wtPath = (selfRow && selfRow.worktreePath) || (desc && desc.worktreePath) || null;
      } catch (_) { wtPath = (desc && desc.worktreePath) || null; }
      const resolved = resolveMeshPartitionIds(storeHandle, id, wtPath);
      meshPartitionIds = resolved.meshPartitionIds;
      meshUnionActive = resolved.meshUnionActive;
      meshGroupUnresolved = resolved.meshGroupUnresolved;
      meshGroupError = resolved.meshGroupError;
      if (meshUnionActive) {
        for (const pid of meshPartitionIds) {
          if (pid === String(id)) continue; // `id`'s own slice is already in `union`/`storeOnlyUnreadRows` above
          try {
            // P0 (v0.90.1): this used the STORE cursor alone while
            // `read-primary` used `cursors/<pid>.json` alone — the two
            // namespaces diverge (foldOne / reap-orphans advance only the
            // store side), so `count` reported 0 unread while `read-primary`
            // re-delivered the whole backlog. Both now size from MAX of the
            // two, plus this caller's live-sibling watermark when the sibling
            // is not ackable — the SAME inputs read-primary uses, so the two
            // surfaces can no longer report different amounts of outstanding
            // mail. Read-only: `count` never writes any of them.
            const pBase = siblingBaseCursor(storeHandle, home, pid, callerReader);
            let pCursor = pBase;
            try {
              if (siblingAckGate(storeHandle, id, pid, home, ctx.now, { cwd: ctx && ctx.cwd, env: ctx && ctx.env })) {
                pCursor = Math.max(pBase, readSiblingSeenCursor(home, id, pid));
              }
            } catch (_) { pCursor = pBase; }
            const pTotal = storeHandle.messageCount(pid);
            const pMessages = storeHandle.listMessages(pid, { sinceCursor: pCursor })
              .map((r) => Object.assign({ partitionId: pid }, r));
            meshSiblingPartitions.push({ id: pid, cursor: pCursor, total: pTotal, messages: pMessages });
            meshAddedTotal += pTotal;
          } catch (e) {
            // P1-B fix (Codex review of HEAD): pre-fix this swallowed a
            // sibling-partition READ failure (cursorValue/messageCount/
            // listMessages throwing — e.g. a corrupt journal file for THAT
            // one sibling) with no signal at all, unlike the resolution-step
            // failure a few lines above (resolved.meshGroupUnresolved) which
            // DOES surface. An unreadable sibling then read as
            // indistinguishable from "this sibling genuinely has no unread
            // mail" — `count`/`read` returned ok:true with an honest-looking
            // but silently undercounted total. Surface it the SAME way the
            // resolution-step failure already does (same field shape, one
            // convention for callers to check) — fail-open stays (this
            // sibling is skipped, delivery for every OTHER readable source
            // still succeeds), but the result must say so.
            meshGroupUnresolved = true;
            meshGroupError = 'sibling partition ' + JSON.stringify(pid) + ' unreadable: ' + String((e && e.message) || e);
          }
        }
      }
    }
    // Defensive dedup against everything already in `storeOnlyUnreadRows` by
    // `hash` — schema-guaranteed unique per partition (meshMessageHash hashes
    // the RECIPIENT too, so two DIFFERENT partitions can never share a hash by
    // construction; see cmdInboxMessages's own header comment on this point)
    // so this can never actually fire in practice. Belt-and-suspenders only,
    // mirroring that same convention — never suppresses a genuinely distinct
    // message (at-least-once beats at-most-once).
    //
    // P1-A fix (composed duplicate-delivery: fold's gapped-cursor fix x
    // send-forwarding — Codex review of HEAD): the ABOVE hash check alone
    // cannot catch a real duplicate here. foldOne (~1611-1646) forwards every
    // FORWARDABLE row for a candidate's whole unread range even PAST a
    // non-forwardable gap, but only advances that candidate's OWN cursor
    // through the CONTIGUOUS forwarded prefix before the first gap
    // (advanceTo/sawGap). A `[forwardable, non-forwardable, forwardable]`
    // sequence on a candidate the fold leaves LIVE (a real mesh sibling,
    // sharing `id`'s worktreePath/meshId — meshCandidateRows) therefore has
    // its THIRD row already forwarded into `id`'s own partition (a real copy
    // exists there) while the candidate's own cursor is stuck at 1, so that
    // SAME row also still reads as "unread" on the candidate's own
    // partition. meshMessageHash hashes the recipient, so the original
    // (to: candidate) and the forward (to: id) hash differently — the
    // existing hash-equality check structurally cannot see they are the same
    // logical message, and the union would deliver it twice.
    //
    // FIX CHOSEN AND WHY (both options in the assignment were tried; this is
    // the one that survived): a first attempt recomputed the hash a sibling
    // row WOULD carry if forwarded into `id`'s own partition (same envelope
    // foldOne's forward step uses) and suppressed a match — i.e. dedup on
    // "original message identity" via a CONTENT-derived hash. That is
    // UNSOUND: it is content-addressed with no real provenance link, so it
    // ALSO matches the exact P0 case this repo already fixed and tests
    // (devswarm-mesh-union-review-fixes.test.js) — two INDEPENDENT real
    // sends to DIFFERENT recipients that happen to share sender+ts+body+
    // urgency. Verified live: that content-hash approach collapsed the P0
    // guard test from 2 delivered messages to 1 — a genuine message-loss
    // regression, not a fix. A sound identity link would need real
    // PROVENANCE (e.g. the archived-orphan forward path's body-prefix
    // marker, forwardArchivedOrphanUnread/archivedForwardProvenancePrefix —
    // the ONE place in this codebase that already does content-hash
    // matching safely, because ITS forwarded body is prefixed and therefore
    // never coincidentally matches unrelated real content) — but foldOne's
    // own forward is contractually BODY-VERBATIM (devswarm-fold-mesh.test.js
    // asserts `forwarded.body === 'which approach?'`, an established,
    // tested contract), and adding a schema column to carry real provenance
    // is out of proportion for this fix.
    //
    // Fix instead (option (b), STRUCTURAL, no content guessing): within a
    // sibling's currently-unread window (already fetched above, in its own
    // natural order), walk it in order and track the first NON-forwardable
    // row seen. STALE as of Fix Wave 2 (F1): this used to say "a
    // non-forwardable row is NEVER excluded" — true only of the FIRST
    // non-forwardable row in the window (the gap TRIGGER, still always
    // delivered — foldOne never forwards one, so it can never have a
    // duplicate anywhere, always safe, always genuinely unread). Once that
    // trigger sets the gap, EVERY subsequent row — forwardable or not — is
    // withheld as part of the ambiguous suffix (foldSiblingGapRows, ~line
    // 1437); a SECOND non-forwardable row later in the same window is no
    // longer exempt. EVERY forwardable row AT OR AFTER that first
    // non-forwardable row is withheld from this widened view —
    // exactly the ambiguous suffix a fold's own advanceTo/sawGap logic also
    // refuses to advance the CANDIDATE's cursor past, for the identical
    // reason: a forwardable row past a gap MIGHT already be a forwarded
    // duplicate (if a fold has already run), or MIGHT be genuinely new
    // unforwarded mail (if none has run since) — this call cannot tell
    // which, structurally, without either guessing (unsound, see above) or
    // side-effecting a live re-forward from a read path (a much larger,
    // riskier change than this fix's scope). Withholding is never silent —
    // see meshGapWithheld/meshGapWithheldCount below — and NOTHING is ever
    // lost: no cursor is touched here, so a withheld row stays reachable by
    // reading that sibling id directly, and is delivered here automatically
    // once a fold actually processes it (removing the gap) or the next
    // fold's forward genuinely lands a hash-identical copy in `id`'s own
    // partition (still caught by the pre-existing exact-hash check above).
    // Sound against the P0 case: a partition with NO non-forwardable row in
    // its unread window has no "gap" at all, so nothing is withheld — the P0
    // test's two single-row sends each sit in a gap-free window and both
    // pass through unaffected (re-asserted as a guard test).
    // Fix Wave 2 F1 (P0 message-loss): delegated to foldSiblingGapRows (see
    // its own header comment, ~line 1408) — the fold now produces a genuine
    // index-based PREFIX per partition, so `part.deliveredCount` is always
    // safe to add to `part.cursor` for the ack target below. deliveredRows
    // (P2-D cap support) stays its OWN array per part, not flattened into
    // one global list, so the cap step below can slice each source's
    // contribution independently and preserve the "never withhold row N-1
    // while keeping row N of the same source" invariant — see that step's
    // own comment.
    let meshGapWithheldCount = 0;
    if (meshSiblingPartitions.length) {
      // defect 64861a623503 — same consumed-history seeding as cmdInboxMessages'
      // sibling fold (see consumedDedupSeed); the two surfaces must not diverge.
      const seed = consumedDedupSeed(storeHandle, id, storeCursorVal, CONSUMED_HASH_SEED_CAP);
      const seenHashes = seed.hashes;
      // R13 item 11: the ORIGINAL's identity too — same reason and same
      // primitive as cmdInboxMessages' own seeding loop (see its comment). The
      // two surfaces must not diverge.
      for (const r of storeOnlyUnreadRows) {
        if (!r) continue;
        if (r.hash) seenHashes.add(r.hash);
        const oh = forwardedOrigHashOf(r);
        if (oh) seenHashes.add(oh);
      }
      const seenLogical = seed.logical;
      for (const part of meshSiblingPartitions) {
        const folded = foldSiblingGapRows(part.messages, seenHashes, seenLogical);
        part.deliveredRows = folded.deliveredRows;
        part.deliveredCount = folded.deliveredCount;
        // G1/G2 fix: see foldSiblingGapRows's own header comment (~line
        // 1437) and the cmdInboxMessages call site's analogous field
        // (~line 4126) — the ack step below (post-cap) derives the PHYSICAL
        // ack target from this, never from `deliveredCount` alone.
        part.consumedThrough = folded.consumedThrough;
        part.consumedCount = folded.consumedCount;
        meshGapWithheldCount += folded.gapWithheldCount;
      }
    }
    // P2-D fix (Codex review of HEAD): read-primary/peek-primary/--ack
    // already cap via DEFAULT_INBOX_READ_LIMIT/--limit (cmdInboxMessages,
    // ~line 3737) — `count`/`read`/`ack` never did, and the mesh-partition
    // widening above makes an unbounded sibling backlog newly reachable
    // here too. Apply the SAME cap mechanism (same constant, same --limit
    // override rule: a non-finite/non-positive override is ignored, never
    // silently disables the cap) rather than inventing a second one.
    // Unlike cmdInboxMessages, this array is never ts-sort-merged across
    // sources — it is a plain concatenation (id's own rows, in their own
    // natural listMessages order, then each sibling's already-deduped rows,
    // each still in ITS OWN natural order) — so a straight per-source
    // length slice already IS a genuine structural prefix; no source-index
    // withholding/recovery machinery is needed to keep cmdInboxMessages's
    // own cap invariant. `part.deliveredCount` is overwritten here to the
    // POST-cap kept length so the ack step below (which reads it to derive
    // each sibling's cursor-ack target) never advances a sibling's cursor
    // past a row this call withheld.
    let inboxCapLimit = DEFAULT_INBOX_READ_LIMIT;
    {
      const limitRaw = one(flags, 'limit');
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (Number.isFinite(n) && n > 0) inboxCapLimit = Math.max(1, Math.floor(n)); // F4: same fix, same reasoning as inboxReadLimit above
      }
    }
    const ownRows = storeOnlyUnreadRows; // id's own rows, pre-sibling-merge
    const ownRowsTotal = ownRows.length;
    const preCapTotal = ownRowsTotal + meshSiblingPartitions.reduce((n, p) => n + (p.deliveredRows ? p.deliveredRows.length : 0), 0);
    let inboxTruncatedCount = 0;
    let ownKeptCount;
    if (preCapTotal > inboxCapLimit) {
      inboxTruncatedCount = preCapTotal - inboxCapLimit;
      let remaining = inboxCapLimit;
      ownKeptCount = Math.min(ownRowsTotal, remaining);
      remaining -= ownKeptCount;
      storeOnlyUnreadRows = ownRows.slice(0, ownKeptCount);
      for (const part of meshSiblingPartitions) {
        const rows = part.deliveredRows || [];
        const keep = Math.min(rows.length, remaining);
        remaining -= keep;
        part.deliveredCount = keep; // overwrite: post-cap kept count, what the ack step below may advance past
        // G1/G2 fix: the PHYSICAL row count to advance past for these `keep`
        // delivered rows — see foldSiblingGapRows's header comment
        // (~line 1437) and the cmdInboxMessages call site (~line 4282). When
        // `keep` covers the partition's ENTIRE deliveredRows (nothing
        // actually capped here), use the fold's own full `consumedCount` —
        // it also covers a TRAILING consumed-but-undelivered row (e.g. a
        // dedup after the last delivered row) that `consumedThrough` cannot
        // see. Otherwise use `consumedThrough[keep - 1]`.
        // NOTE: the "nothing capped for this partition" check MUST run
        // BEFORE the `keep <= 0` short-circuit — G1's exact wedge case has
        // `keep === 0 === rows.length` (nothing delivered AND nothing
        // capped, e.g. a `[hole]`-only window), and that case still needs
        // `part.consumedCount` (1, the hole itself), not a hard 0.
        const consumedThrough = Array.isArray(part.consumedThrough) ? part.consumedThrough : null;
        part.physicalConsumed = (keep >= rows.length && Number.isFinite(part.consumedCount))
          ? part.consumedCount
          : (keep <= 0
            ? 0
            : (consumedThrough && Number.isFinite(consumedThrough[keep - 1]) ? consumedThrough[keep - 1] : keep));
        if (keep) storeOnlyUnreadRows = storeOnlyUnreadRows.concat(rows.slice(0, keep));
      }
    } else {
      ownKeptCount = ownRowsTotal;
      for (const part of meshSiblingPartitions) {
        if (part.deliveredRows && part.deliveredRows.length) storeOnlyUnreadRows = storeOnlyUnreadRows.concat(part.deliveredRows);
        // G1/G2 fix: nothing capped for this partition — the physical
        // ack target is the fold's own full consumed count (may exceed
        // `deliveredCount` when a corrupted/deduped row was resolved
        // without being delivered).
        part.physicalConsumed = Number.isFinite(part.consumedCount) ? part.consumedCount : (part.deliveredCount || 0);
      }
    }
    // Fix Wave 2 F2 (undercount + missing honesty flag): `meshAddedUnreadCount`
    // must be the REAL, UNTRUNCATED sibling count — not the post-cap kept
    // count (`storeOnlyUnreadRows.length - ownKeptCount`, which is <= the
    // real total whenever `inboxTruncatedCount > 0`). Matches
    // cmdInboxMessages, which sets its own `meshAddedUnreadCount` from
    // `dedupedSiblingRows.length` BEFORE its cap step ever runs (~line 4007).
    // `part.deliveredRows` (the gap-fold output) is untouched by the cap step
    // above — only `part.deliveredCount`/`storeOnlyUnreadRows` are
    // overwritten/sliced — so summing `.deliveredRows.length` here is exactly
    // the pre-cap, real total (equal to `preCapTotal - ownRowsTotal`).
    meshAddedUnreadCount = meshSiblingPartitions.reduce((n, p) => n + (p.deliveredRows ? p.deliveredRows.length : 0), 0);

    // FIX 6 (TRACED): the two parallel, independently-cursored channels — the
    // NDJSON descriptor inbox and the store partition — were surfaced as a bare
    // `unread` (actually the SUM of both) sitting beside `storeUnread` (one of
    // the two components), with NO field naming the NDJSON component at all.
    // That mislabeling made a real NDJSON backlog invisible to an operator
    // reading only the store side. Emit all three explicitly: unreadTotal (the
    // sum, same value `unread` always was), unreadNdjson, unreadStore (same
    // value `storeUnread` always was), plus cursorNdjson/cursorStore. `unread`/
    // `storeCursor`/`storeUnread` are kept as EXACT ALIASES for compatibility —
    // never the primary name going forward.
    // fl-wave5 addendum fix (item 8, P1, R4 Reviewer): `resolveMeshPartitionIds`'s
    // own `meshCandidateRows` -> `listRegistry()` call goes through the
    // journal backend's `readAll()`, which FAIL-OPENS a genuine fs error
    // (e.g. EACCES on `registry.ndjson`, chmod'd separately from a perfectly
    // readable `messages.ndjson`) to an EMPTY array rather than throwing —
    // so a registry-only read failure silently narrowed to "no siblings
    // found" (`meshUnionActive` stays false, `meshGroupUnresolved` never
    // set) instead of surfacing at all. `messages.ndjson` can be entirely
    // readable here (this call's own `union`/`storeOnlyUnreadRows` above may
    // be fully correct), so `storeHandle`'s deferred `getReadError()` is the
    // only way to catch a registry-only failure — probed HERE, after every
    // read this call has performed against `storeHandle` (the initial
    // messages read AND the mesh-widening registry/sibling reads above), not
    // just the initial open. Never overrides an ALREADY-set `storeUnavailable`
    // (e.g. a project-context-mismatch refusal from the initial open) — this
    // is additive, catching only the gap that refusal cannot see.
    if (storeHandle && !storeUnavailable) {
      let postPipelineReadError = null;
      try { postPipelineReadError = (storeHandle.getReadError && storeHandle.getReadError()) || null; } catch (_) { postPipelineReadError = null; }
      if (postPipelineReadError) {
        storeUnavailable = {
          reason: 'store-unavailable',
          error: 'store for workspace ' + JSON.stringify(id) + ' could not be fully read ('
            + (postPipelineReadError.code || 'EUNKNOWN') + ' on ' + JSON.stringify(postPipelineReadError.path) + ')',
          registeredRepoKey: null, callerRepoKey: null,
          storeUnavailableReason: postPipelineReadError.code || 'EUNKNOWN',
        };
        meshGroupUnresolved = true;
        meshGroupError = 'post-pipeline read error: ' + (postPipelineReadError.code || 'EUNKNOWN') + ' on ' + String(postPipelineReadError.path);
      }
    }
    const unreadNdjsonCount = union.ndjsonUnreadLines.length;
    // unreadStoreCount/outTotal fold in meshAddedUnreadCount/meshAddedTotal
    // (the mesh-partition widening above) — 0/no-op whenever meshUnionActive
    // is false, so a single-row workspace's output is byte-identical to
    // pre-fix. `union.unread`/`union.total` are captured BEFORE the widening
    // ran, so the additive terms are added back explicitly here rather than
    // re-reading (now-stale) fields off `union`.
    const unreadStoreCount = storeOnlyUnreadRows.length;
    const outUnreadTotal = union.unread + meshAddedUnreadCount;
    const outTotal = union.total + meshAddedTotal;
    if (sub === 'count') {
      const countMeta = readSideMeta(ctx, home, storeHandle, id);
      if (storeHandle) storeHandle.close();
      return {
        ok: true, action: 'count', id,
        ...(readArgResolvedFrom ? { resolvedFrom: readArgResolvedFrom } : {}),
        ...(retiredRedirectFromId ? { redirected: true, redirectedFrom: retiredRedirectFromId } : {}),
        repoKey: countMeta.repoKey, storePath: countMeta.storePath, cwd: countMeta.cwd,
        meshPartitionIds,
        unreadTotal: outUnreadTotal, unreadNdjson: unreadNdjsonCount, unreadStore: unreadStoreCount,
        cursorNdjson: union.cursor, cursorStore: storeCursorVal,
        total: outTotal,
        known: readSideKnown(union.known, { storeUnavailable, meshGroupUnresolved, meshGroupError }),
        ...storeUnavailableOut(storeUnavailable, { detail: true }),
        meshGroupUnresolved: !!meshGroupUnresolved,
        meshGroupError: meshGroupError || null, totalsPartial: !!meshGroupUnresolved,
        ...(storeUnavailable ? { unreadStoreUnknown: true } : {}),
        ...(meshGroupUnresolved ? { meshGroupUnresolved: true, meshGroupError, totalsPartial: true } : {}),
        // Fix Wave 2 F2: `count` used to omit `meshGapWithheld`/
        // `meshGapWithheldCount` entirely (they went only to `read`/`ack`
        // below), so a caller relying on `count` alone had no honesty signal
        // that some sibling mail was withheld pending a gap resolving. Same
        // fields, same meaning, as `read`/`ack` emit.
        ...(meshGapWithheldCount > 0 ? { meshGapWithheld: true, meshGapWithheldCount } : {}),
        // P2-D cap report — same shape/fields as cmdInboxMessages's own
        // (defect 8d0a66cfc563): `total`/`unreadTotal` above NOW genuinely
        // reflect the REAL, untruncated totals (Fix Wave 2 F2 — previously
        // `meshAddedUnreadCount` was computed POST-cap here, so this claim
        // was false whenever `inboxTruncatedCount > 0`); `unreadStore`
        // reflects only what this call actually returned. `truncated:true`
        // is the explicit signal this call did not return everything.
        ...(inboxTruncatedCount > 0 ? {
          truncated: true, truncatedCount: inboxTruncatedCount, limit: inboxCapLimit,
          truncatedHint: 'not all unread messages were returned (' + inboxTruncatedCount + ' withheld) — '
            + 'the read cursor was NOT advanced past withheld messages, so re-reading (optionally with a '
            + 'higher --limit than ' + inboxCapLimit + ') returns them',
        } : {}),
        // compat aliases (see comment above) — do not treat as primary:
        unread: outUnreadTotal, cursor: union.cursor, storeCursor: storeCursorVal, storeUnread: unreadStoreCount,
      };
    }
    if (sub === 'read') {
      const readMeta = readSideMeta(ctx, home, storeHandle, id);
      if (storeHandle) storeHandle.close();
      return {
        ok: true, action: 'read', id,
        ...(readArgResolvedFrom ? { resolvedFrom: readArgResolvedFrom } : {}),
        ...(retiredRedirectFromId ? { redirected: true, redirectedFrom: retiredRedirectFromId } : {}),
        repoKey: readMeta.repoKey, storePath: readMeta.storePath, cwd: readMeta.cwd,
        meshPartitionIds,
        lines: union.ndjsonUnreadLines, meshMessages: storeOnlyUnreadRows,
        unreadTotal: outUnreadTotal, unreadNdjson: unreadNdjsonCount, unreadStore: unreadStoreCount,
        cursorNdjson: union.cursor, cursorStore: storeCursorVal,
        total: outTotal,
        known: readSideKnown(union.known, { storeUnavailable, meshGroupUnresolved, meshGroupError }),
        ...storeUnavailableOut(storeUnavailable, { detail: true }),
        meshGroupUnresolved: !!meshGroupUnresolved,
        meshGroupError: meshGroupError || null, totalsPartial: !!meshGroupUnresolved,
        ...(storeUnavailable ? { unreadStoreUnknown: true } : {}),
        ...(meshGroupUnresolved ? { meshGroupUnresolved: true, meshGroupError, totalsPartial: true } : {}),
        // P1-A honesty report: a forwardable row sitting AFTER a
        // non-forwardable gap in a sibling's unread window was withheld
        // from this call (see the fix's own comment above) — never lost
        // (no cursor touched), but not shown here either. `meshGapWithheld`
        // is the explicit signal; read that sibling id directly, or wait
        // for its next fold pass, to see it.
        ...(meshGapWithheldCount > 0 ? { meshGapWithheld: true, meshGapWithheldCount } : {}),
        ...(inboxTruncatedCount > 0 ? {
          truncated: true, truncatedCount: inboxTruncatedCount, limit: inboxCapLimit,
          truncatedHint: 'not all unread messages were returned (' + inboxTruncatedCount + ' withheld) — '
            + 'the read cursor was NOT advanced past withheld messages, so re-reading (optionally with a '
            + 'higher --limit than ' + inboxCapLimit + ') returns them',
        } : {}),
        // NON-ADVANCE HONESTY (defect 56ba248504d0, item 7). `read` is the
        // READ-ONLY half of this verb family — it deliberately advances NO
        // cursor (that is `ack`'s job, and it is what lets `read` stay safe to
        // run from ANY project; see the ack path's own project-mismatch refusal
        // below, which tells callers exactly that). But the output never SAID
        // so, and that silence is what the field report is actually made of: an
        // operator ran `inbox read <twinId>` ten times, watched `unreadNdjson`
        // sit at 401 every time, and reasonably concluded the rows were
        // unreachable. They were not — `inbox ack <twinId>` drains them (proven
        // by test) — but nothing on this surface pointed at that command.
        //
        // So state it, on the one surface the operator is already looking at,
        // and name the EXACT command. Present only when there is genuinely
        // something outstanding, so a fully-drained read's shape is unchanged.
        ...(outUnreadTotal > 0 ? {
          cursorAdvanced: false,
          ackHint: '`inbox read` is READ-ONLY and advanced no cursor — these '
            + outUnreadTotal + ' unread row(s) (' + unreadNdjsonCount + ' durable-NDJSON, '
            + unreadStoreCount + ' store) stay unread until `devswarm.js inbox ack ' + id
            + '` consumes them. NOTE: a Primary\'s own `inbox read-primary` (acked via its `ackCommand`) folds ONLY its OWN '
            + 'descriptor\'s NDJSON channel, so another row\'s (e.g. a same-worktree twin\'s) '
            + 'durable inbox is only ever drained by acking THAT id explicitly.',
        } : {}),
        // compat aliases (see comment above) — do not treat as primary:
        count: outUnreadTotal, cursor: union.cursor, storeCursor: storeCursorVal,
      };
    }
    // sub === 'ack'
    // ---- RETIRED-REDIRECT OWNERSHIP GATE (fl-wave3/73303d4c098b) ----
    // The ID-DERIVED AUTHORITY GATE just below deliberately stays fail-open
    // for an ordinary unresolvable/unregistered caller acking its OWN literal
    // id (this file's established posture — see the ackOwns comment further
    // down). That posture does NOT extend to a retired-redirect: `id` here is
    // no longer the literal id the caller addressed — `retiredRedirectFromId`
    // holds the ORIGINAL (now-dead) id, and this branch is about to advance
    // the SURVIVOR's real NDJSON cursor on behalf of a caller who merely
    // typed the old id string. Verify the caller's OWN identity actually
    // resolves to this survivor (or an --ack-as-owner override) BEFORE
    // touching either cursor — an unrelated/unresolvable caller must never
    // move the survivor's cursor just by naming a retired twin.
    if (retiredRedirectFromId && !flags['ack-as-owner']) {
      let ownsSurvivor = false;
      try {
        const probeRepoKey = repoKeyForCwd(ctx);
        const probeStore = store.openStore({ home, workspaceId: id, hash: probeRepoKey || undefined, backend: ctx.backend, env: ctx.env });
        try {
          const callerInfo = callerIdentityDetailed(ctx.env, ctx.cwd);
          const caller = callerInfo.identity;
          const ownEntry = resolveMeshTarget(probeStore, caller, home);
          ownsSurvivor = caller === id || !!(ownEntry && ownEntry.id === id) || ownsAsDeclaredSelf(probeStore, ctx, id);
        } finally { probeStore.close(); }
      } catch (_) { ownsSurvivor = false; }
      if (!ownsSurvivor) {
        if (storeHandle) storeHandle.close();
        return {
          ok: false, action: 'ack', id,
          reason: 'retired-redirect-unresolvable-caller',
          error: 'inbox ack ' + JSON.stringify(retiredRedirectFromId) + ' was redirected to survivor '
            + JSON.stringify(id) + ' after a fold, but the caller could not be verified as that survivor '
            + '— refusing so an unrelated/unresolvable caller cannot advance the survivor\'s NDJSON cursor '
            + '(pass --ack-as-owner to override)',
          redirected: true, redirectedFrom: retiredRedirectFromId,
        };
      }
    }
    // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
    // `count`/`read` above are non-mutating and stay FAIL-OPEN on a refused
    // store side (the NDJSON channel is id-derived and partition-independent,
    // so its mail is genuinely readable from anywhere — that readability is
    // what devswarm-parent-gate.js's remediation now depends on). `ack` is
    // NOT: it advances this descriptor's NDJSON cursor, permanently marking
    // another project's workspace's mail consumed so its real owner never
    // sees it. The advance below used to run unconditionally, so a caller the
    // store resolver had ALREADY refused still got ok:true and a moved cursor.
    // Refuse before touching either cursor.
    // Narrow on purpose: ONLY a positive cross-project mismatch refuses. Any
    // other store-open failure keeps the pre-existing fail-open ack (the store
    // side was never required for the NDJSON ack to be correct).
    if (storeUnavailable && storeUnavailable.reason === 'project-context-mismatch') {
      if (storeHandle) storeHandle.close();
      return Object.assign(
        { action: 'ack', acked: 0, cursor: null },
        projectContextMismatch(id, storeUnavailable.registeredRepoKey, storeUnavailable.callerRepoKey,
          'run this from within that project\'s worktree to ack it (`inbox read ' + id + '` is read-only and works from anywhere)'));
    }
    if (!cursorPath) { if (storeHandle) storeHandle.close(); return { ok: false, error: 'no cursorPath for workspace ' + JSON.stringify(id) }; }
    // ---- OWNERSHIP GATE, HOISTED (defect 66c7c4e9973e, P0) ----
    // Previously this check ran only around the STORE-side cursor write inside
    // the ack-all branch below, AFTER the NDJSON `ackTo` call had already
    // durably advanced the descriptor's own cursor unconditionally — a
    // non-owned `inbox ack <id>` therefore half-acked: the NDJSON channel was
    // silently drained (the caller's real owner never sees those rows again)
    // while the store-side counters were quietly left untouched, and the top-
    // level result still read `ok:true` with no signal anything was refused —
    // the two channels then permanently disagree ("counts never converge").
    // Resolve ownership ONCE, before EITHER channel is touched (the `--to N`
    // path included — it wrote the NDJSON cursor just as unconditionally),
    // and refuse the WHOLE verb — same shape as read-primary's own ownership
    // refusal (ok:false/reason/error/callerIdentity/identity:{id,kind}) — so a
    // caller sees exactly why nothing moved. `--ack-as-owner` still overrides,
    // identically to every other ack-family ownership gate in this file.
    // Narrow to `storeHandle` truthy (same precondition read-primary's own
    // gate requires to resolve ownership via resolveMeshTarget): a store the
    // resolver could not open for a reason OTHER than a positive cross-project
    // mismatch (already refused above) keeps the pre-existing fail-open ack —
    // this file's established posture for a genuinely unavailable store.
    //
    // SCOPED to a POSITIVE, resolvable mismatch — `ownEntry` truthy, i.e. the
    // caller's OWN cwd/env resolves to a REAL, different registered row
    // (ownershipRefusalCause's `ownership-mismatch`, the exact ack-asymmetry
    // shape defect 66c7c4e9973e reproduced: a registered sibling acking
    // another sibling's row). Deliberately NOT extended to
    // `unresolvable-caller-identity`/`caller-not-registered` (`ownEntry`
    // null — the caller's identity resolves to nothing registered at all):
    // that is the ordinary "operator ran `inbox ack <id>` from a bare shell/
    // script with no matching worktree or DEVSWARM_BUILDER_ID" shape, not a
    // cross-workspace hazard, and refusing it there would newly block a
    // caller this file has always let ack (read-primary's OWN pre-existing
    // gate is stricter — it refuses on all three causes — but read-primary
    // is a distinct, already-established contract this fix does not touch).
    const ackAsOwner = !!flags['ack-as-owner'];
    // `ackOwns` carries the resolution down to the store-side write below
    // (unchanged posture: that write stays gated on genuine ownership, exactly
    // as before this fix — only the REFUSAL above is scoped to a positive
    // mismatch; an unresolvable/unregistered caller still gets a
    // best-effort-skipped store write, never a hard failure) — computed ONCE
    // here rather than a second resolveMeshTarget call.
    let ackOwns = true;
    if (storeHandle && !ackAsOwner) {
      const callerInfo = callerIdentityDetailed(ctx.env, ctx.cwd);
      const caller = callerInfo.identity;
      const ownEntry = resolveMeshTarget(storeHandle, caller, home);
      const owns = caller === id || (ownEntry && ownEntry.id === id) || ownsAsDeclaredSelf(storeHandle, ctx, id);
      ackOwns = owns;
      if (!owns && ownEntry) {
        const cause = ownershipRefusalCause(callerInfo.kind, ownEntry);
        storeHandle.close();
        return {
          ok: false,
          action: 'ack',
          reason: cause,
          error: 'inbox ack refused (' + cause + '): caller ' + JSON.stringify(caller)
            + ' does not own workspace ' + JSON.stringify(id)
            + ' (pass --ack-as-owner to override, or use `inbox read ' + id + '` to view without acking)',
          id,
          callerIdentity: caller,
          identity: { id: caller, kind: callerInfo.kind },
        };
      }
    }
    const toRaw = one(flags, 'to');
    let cursor;
    // P1a fix (defect c35a7ca3056b): populated only if the store-side cursor
    // sync below throws — see the catch site for the full rationale.
    const ackCursorWriteFailures = [];
    // Fix Wave 7 Item 1 (P0): this verb's OWN sibling cursor-write loop
    // (below) used to have NO liveness gate at all — a plain `inbox ack`
    // (or `--ack-as-owner`) from a shared canonical worktree drove a live
    // sibling's cursor forward and consumed its unread backlog undelivered,
    // reproduced with BOTH heartbeats fresh. Tracked the same shape as
    // cmdInboxMessages's `liveSiblingsSkipped` (~line 3932) for parity.
    const liveSiblingsSkipped = [];
    if (toRaw !== undefined) {
      const n = Number(toRaw);
      if (!Number.isFinite(n)) { if (storeHandle) storeHandle.close(); return { ok: false, error: '--to must be a number' }; }
      // `--to N` stays NDJSON-SCOPED, byte-for-byte unchanged from the pre-fix
      // contract: an absolute NDJSON line-count has no cross-channel meaning for
      // the store's own cursor, so ack-all (below) is the only path that also
      // clears the store side.
      cursor = commitNdAck(storeHandle, home, id, callerReader, n, descCursorPath, inboxPath, {
        callerId: id, verb: 'inbox-ack-to', cwd: (ctx && ctx.cwd) || null, repoKey: callerRepoKeyForLog,
        now: ctx && ctx.now, procTable: ctx && ctx.procTable,
      });
    } else {
      // Fix Wave 5 Item 2 (P0 message-loss): `advanceCursor()` used to RECOUNT
      // the LIVE inbox file tail at ack time (`countMessages(inboxPath)`
      // inside advanceCursor) rather than acking over the tail snapshot this
      // call actually read/delivered (`union`, captured above via
      // unionUnread — the SAME initial-read snapshot `read-primary` already
      // honors via its own `physicalConsumed`/`ownDeliveredMaxIndex` math).
      // Race: cursor=5, rows 1-6 exist, this call reads/delivers row 6, a
      // concurrent sender appends row 7 between the read and this ack —
      // `advanceCursor` recounts 7 live and writes cursor=7, permanently
      // consuming row 7 though it was never returned to this caller. Fix:
      // ack only `union.cursor + union.ndjsonUnreadLines.length` — the exact
      // contiguous prefix snapshotted at the read above — never the live
      // file's current tail. `ackTo`'s own upper clamp (via `inboxPath`)
      // still protects against a corrupt/negative target; its monotonic
      // guard still protects against under-acking a previously-further-along
      // cursor.
      cursor = commitNdAck(storeHandle, home, id, callerReader, union.cursor + union.ndjsonUnreadLines.length, descCursorPath, inboxPath, {
        callerId: id, verb: 'inbox-ack-all', cwd: (ctx && ctx.cwd) || null, repoKey: callerRepoKeyForLog,
        now: ctx && ctx.now, procTable: ctx && ctx.procTable,
      }); // ack-all (ndjson side) — over THIS call's read snapshot only
      // Store-side ack-all (P0 fix): advance the STORE's OWN cursor for `id` too,
      // so deriveSummary's persisted projection (what the parent-gate banner
      // reads) agrees with what this read path just reported as consumed —
      // otherwise the banner would keep declaring these messages unread forever
      // even after the recipient legitimately read+acked them. Gated by the SAME
      // ownership guard `inbox messages --ack`/`read-primary` already enforce
      // (cross-workspace ack hazard, bug #2) since this is a NEW mutation this
      // verb never performed before; `--ack-as-owner` overrides identically for a
      // legitimate cross-workspace ack (e.g. a supervisor clearing a dead
      // workspace's backlog on its behalf). A refusal here is silent/best-effort
      // — the NDJSON ack above already durably succeeded regardless.
      if (storeHandle) {
        try {
          // Ownership already resolved ONCE by the HOISTED gate above (defect
          // 66c7c4e9973e, `ackOwns`) — reuse it rather than a second
          // resolveMeshTarget call. A refusal there already returned the
          // whole verb early for a POSITIVE mismatch; `ackOwns` can still be
          // false here for the narrower unresolvable/unregistered-caller
          // case, which (unchanged from before this fix) just skips this
          // store-side write silently rather than hard-failing.
          if (ackOwns) {
            // Fix Wave 7 Item 3 (P0 message-loss): `storeHandle.messageCount(id)`
            // used to RECOUNT the LIVE store table at ack time — the same
            // message-loss shape Fix Wave 5 Item 2 already fixed on the NDJSON
            // side (`inboxCursor.ackTo(cursorPath, union.cursor +
            // union.ndjsonUnreadLines.length, ...)` above, over the READ
            // snapshot, never a live recount), left unfixed here on the store
            // side. Race: a concurrent sender appends a NEW row to `id`'s own
            // store partition between the `union`/`storeOnlyUnreadRows`
            // snapshot (captured above, ~line 4576) and this ack — the live
            // recount includes that row (never returned to this caller) and
            // sets the cursor past it, permanently losing it.
            // Fix: derive the ack target from the ACTUAL delivered rows' own
            // `.index` (a real, database-backed absolute 1-based position —
            // devswarm-store.js listMessages), the SAME primitive
            // cmdInboxMessages's own-store ack already uses
            // (`ownDeliveredMaxIndex`, ~line 4210) — never arithmetic over a
            // possibly-gapped row count (storeOnlyUnreadRows can have gaps
            // relative to the raw sequence: it is filtered by hash against the
            // NDJSON channel, same root cause as that fix's own header note).
            // `ownRows`/`ownKeptCount` (captured above, ~line 4772/4782) are
            // the pre-sibling-merge id-only rows and the post-cap count of
            // them actually delivered THIS call — re-sliced here rather than
            // re-derived, so this can never drift from what was truly
            // returned. Never regresses below the pre-read snapshot
            // (`storeCursorVal`), matching every other ack-target invariant
            // in this file.
            const ownDeliveredRows = ownRows.slice(0, ownKeptCount);
            let ownMaxIndex = null;
            for (const row of ownDeliveredRows) {
              if (row && Number.isFinite(row.index) && (ownMaxIndex === null || row.index > ownMaxIndex)) ownMaxIndex = row.index;
            }
            const totalNow = ownMaxIndex !== null ? Math.max(storeCursorVal, ownMaxIndex) : storeCursorVal;
            // PER-INSTANCE ACK (defect 8b211241bbe9) — see commitInstanceAck.
            // Replaces the bare shared write: the shared pair now follows the
            // MIN across instances, never one reader's own position.
            const ownCommit = commitInstanceAck(storeHandle, home, id, callerReader, totalNow, {
              callerId: id, delivered: Number.isFinite(ownKeptCount) ? ownKeptCount : null, nonce: callerReader,
              gate: 'owner', verb: 'inbox-ack', cwd: (ctx && ctx.cwd) || null, repoKey: callerRepoKeyForLog,
            });
            // Report, never swallow (R1 Reviewer item 7) — see the read-primary twin.
            if (ownCommit.error) {
              ackCursorWriteFailures.push({ partitionId: id, channel: 'store-cursor', error: ownCommit.error });
            }
            // Keep the SEPARATE `inbox messages --ack`/`read-primary` ACK-cursor
            // FILE (primaryCursorPath, a DIFFERENT namespace than this
            // descriptor's own cursorPath) in lockstep too, so a workspace that
            // mixes `inbox ack` with `read-primary` never sees those two
            // read-verbs disagree about what is already consumed.
            // (defect 8b211241bbe9: the shared-pair write now lives inside
            // commitInstanceAck above and is driven by the MIN across
            // instances, never this one reader's `totalNow`.)
            // Mesh sibling ack (defect 27cd80902435): advance EACH sibling
            // partition's OWN store cursor too — "per-partition cursors stay
            // per-partition" (same invariant cmdInboxMessages's read-primary
            // ack already enforces). Target is `part.cursor + deliveredCount`
            // (never `part.total` directly) — deliveredCount is the actual
            // number of that partition's rows folded into `storeOnlyUnreadRows`
            // above, so this structurally cannot advance past a row the
            // defensive dedup guard withheld. Gated by the SAME `owns` check
            // as `id`'s own ack (a caller that doesn't own `id` doesn't own
            // its siblings either).
            for (const part of meshSiblingPartitions) {
              // LIVE-SIBLING GATE (Fix Wave 7 Item 1): the SAME gate
              // cmdInboxMessages's read-primary/peek-primary ack loop applies
              // (~line 4308), via the SAME shared `siblingAckGate` — this loop
              // used to have none at all, which is exactly what let a live
              // sibling sharing this worktree get its cursor driven forward
              // and its backlog consumed undelivered by a plain `inbox ack`.
              if (siblingAckGate(storeHandle, id, part.id, home, ctx.now, { cwd: ctx && ctx.cwd, env: ctx && ctx.env })) { liveSiblingsSkipped.push(part.id); continue; }
              // Fix Wave 3 G1/G2 (P0/P1): `part.physicalConsumed` (set
              // above alongside `part.deliveredCount` — see the cap-step
              // comment ~line 4682) is the PHYSICAL row count to advance
              // past, which can exceed `deliveredCount` when a corrupted/
              // null row or exact-hash duplicate was consumed without being
              // delivered. Falls back to `deliveredCount` when unset
              // (fail-open — never worse than the pre-fix behavior).
              const deliveredCount = Number.isFinite(part.deliveredCount) ? part.deliveredCount : part.messages.length;
              const physicalConsumed = Number.isFinite(part.physicalConsumed) ? part.physicalConsumed : deliveredCount;
              const ackTarget = part.cursor + physicalConsumed;
              try {
                // PER-INSTANCE SIBLING ACK (defect 8b211241bbe9) — see the
                // read-primary loop's twin of this call.
                const partCommit = commitInstanceAck(storeHandle, home, part.id, callerReader, ackTarget, {
                  callerId: id, delivered: deliveredCount, nonce: callerReader,
                  gate: 'sibling', verb: 'inbox-ack', cwd: (ctx && ctx.cwd) || null,
                  repoKey: callerRepoKeyForLog,
                });
                if (partCommit.error) throw new Error(partCommit.error);
              } catch (e2) {
                ackCursorWriteFailures.push({ partitionId: part.id, channel: 'sibling-store-cursor', error: String((e2 && e2.message) || e2) });
              }
            }
            store.deriveSummary(storeHandle, { home, env: ctx.env, now: ctx.now });
          }
        } catch (e) {
          // defect c35a7ca3056b: this catch used to swallow the failure
          // silently and return a bare `ok:true` — the store-side cursor (and
          // its primaryCursorPath twin) could then fail to persist while the
          // NDJSON ack above already durably succeeded, so the caller had no
          // signal and those messages resurfaced as unread next read. Fail
          // OPEN on delivery (unchanged — the ndjson ack above already
          // succeeded regardless; re-serving them is the safe direction) but
          // report the persistence failure using the SAME field shape
          // cmdInboxMessages already reports (cursorWriteFailures[]/
          // cursorPersisted:false, ~line 3810 above) so consumers see one
          // convention, not two.
          try { ackCursorWriteFailures.push({ partitionId: id, channel: 'store-cursor', error: String((e && e.message) || e) }); }
          catch (_) { ackCursorWriteFailures.push({ partitionId: id, channel: 'store-cursor', error: 'unknown error' }); }
        }
      }
    }
    if (storeHandle) storeHandle.close();
    // fl-wave5 fix (item 1): `ack` shares the SAME `storeUnavailable` local
    // (computed once, above, for the whole count/read/ack block) but used to
    // report none of it — a caller acking against an unavailable store saw
    // `ok:true` with no signal the store side went unreported. Same boolean
    // + top-level storeUnavailableReason + storeUnavailableDetail shape
    // count/read now report for the identical underlying condition.
    // fl-wave5 addendum fix (item 10, P2, R4 Reviewer): `ack` used to omit
    // `known` entirely — the CHANGELOG already (correctly) documented
    // `known:false` as part of this shape for `ack`, but the field was
    // never actually emitted, so a caller/CLI checking `result.known` (and
    // `emitKnownWarning`, which gates its whole WARNING line on
    // `result.known === false`) never fired for a store-unavailable ack.
    // Same formula count/read use.
    const ackOut = {
      ok: true, action: 'ack', id, cursor, total: inboxCursor.countMessages(inboxPath),
      known: readSideKnown(union.known, { storeUnavailable, meshGroupUnresolved, meshGroupError }),
      ...storeUnavailableOut(storeUnavailable, { detail: true }),
    };
    if (storeUnavailable) ackOut.unreadStoreUnknown = true;
    if (readArgResolvedFrom) ackOut.resolvedFrom = readArgResolvedFrom;
    if (retiredRedirectFromId) { ackOut.redirected = true; ackOut.redirectedFrom = retiredRedirectFromId; }
    if (ackCursorWriteFailures.length) {
      ackOut.cursorWriteFailures = ackCursorWriteFailures;
      ackOut.cursorPersisted = false;
    }
    if (liveSiblingsSkipped.length) ackOut.liveSiblingsSkipped = liveSiblingsSkipped;
    if (meshGroupUnresolved) { ackOut.meshGroupUnresolved = true; ackOut.meshGroupError = meshGroupError; ackOut.totalsPartial = true; }
    if (meshGapWithheldCount > 0) { ackOut.meshGapWithheld = true; ackOut.meshGapWithheldCount = meshGapWithheldCount; }
    if (inboxTruncatedCount > 0) {
      ackOut.truncated = true;
      ackOut.truncatedCount = inboxTruncatedCount;
      ackOut.limit = inboxCapLimit;
      ackOut.truncatedHint = 'not all unread messages were acked this call (' + inboxTruncatedCount + ' withheld) — '
        + 'sibling cursors were NOT advanced past withheld messages, so acking again (optionally with a '
        + 'higher --limit than ' + inboxCapLimit + ') consumes them';
    }
    return ackOut;
  }
  return { ok: false, error: 'unknown inbox subcommand: ' + JSON.stringify(sub) + ' (read|ack|count|pull|messages|read-primary|ack-primary|peek-primary|drain-primary-legacy)' };
}

// inboxReadPrimaryTextLines(result) -> the `inbox read-primary --format text`
// rendering (peer request C): one `from/seq/body` block per message, plain
// text — a failed/empty read still renders something legible rather than a
// blank line. Rendering is read-only: the ack step stays
// `inbox ack-primary --receipt <r>` unless --ack-after-print was passed.
function inboxReadPrimaryTextLines(result) {
  if (!result || !result.ok) {
    return 'ok:false ' + String((result && result.error) || (result && result.reason) || 'inbox read-primary failed');
  }
  const messages = Array.isArray(result.messages) ? result.messages : [];
  if (!messages.length) return '(no messages)';
  return messages.map((m) => 'from: ' + (m && m.sender != null ? m.sender : '') + '\nseq: ' + (m && m.storeSeq)
    + '\n' + (m && m.body != null ? String(m.body) : '') + '\n').join('\n');
}

// inboxTickQuietLine(result) -> the one-line `inbox tick --quiet` rendering
// (peer ask, 0.112 lane): `inbox tick`'s JSON carries duplicate legacy+new
// field names (unread/unreadTotal, cursor/cursorNdjson, storeCursor/
// cursorStore — see cmdInbox's own 'count' shape, which cmdInboxTick's
// result extends) — a cron-prompt directive that has to eyeball raw JSON for
// "is there anything to do" gets tripped up picking the right field. This
// collapses the ONLY four fields that decision needs into one line, same
// opt-in/--json-override precedence as read-primary --format text / send
// --quiet above. `ok:false` still renders LOUD (never silently swallowed)
// with a reason, and main()'s exit code stays `r.ok ? 0 : 2` exactly as the
// JSON path already does, so a script checking `$?` alone still catches the
// failure under --quiet. The JSON default (no --quiet) is UNCHANGED —
// this is a strictly additive rendering, not a field removal.
function inboxTickQuietLine(result) {
  if (result && result.ok) {
    const id = result.id != null ? String(result.id) : '';
    const unread = Number.isFinite(result.unreadTotal) ? result.unreadTotal : (result.unreadTotal == null ? 'null' : String(result.unreadTotal));
    // watcherArmed renders 'idle-skip'/'limit-skip' verbatim (#39 + field
    // report: each is a deliberate no-arm decision, distinct from both true
    // and false) — every other value (boolean or anything else) keeps the
    // pre-#39 true/false rendering.
    const watcherArmedStr = (result.watcherArmed === 'idle-skip' || result.watcherArmed === 'limit-skip' || result.watcherArmed === 'archived-skip')
      ? result.watcherArmed
      : (result.watcherArmed ? 'true' : 'false');
    return 'tick ' + id + ': unread ' + unread
      + ', known ' + (result.known ? 'true' : 'false')
      + ', meshGap ' + (result.meshGapWithheld ? 'true' : 'false')
      + ', watcherArmed ' + watcherArmedStr
      + (typeof result.rosterText === 'string' && result.rosterText ? '\n' + result.rosterText : '');
  }
  return 'ok:false ' + String((result && result.error) || (result && result.reason) || 'inbox tick failed');
}

module.exports = {
  cmdInboxAckPrimary, cmdInboxPull, cmdInboxTick, cmdInbox, inboxReadPrimaryTextLines,
  inboxTickQuietLine,
};
