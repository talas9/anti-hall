'use strict';
// anti-hall :: devswarm CLI — REGISTER module (scripts/devswarm-lib/register.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  alog, archivedCounterpartInfo, buildDescriptorFromFlags, CALLER_CWD, descriptorFreshRepoKey,
  descriptorRegisteredRepoKey, descriptorStructuralRepoKey, devswarmRoot, fs,
  hasArchivedCounterpart, identityContext, ingestHealth, inst, isChildWorkspaceCorroborated,
  isDevswarmActive, isSafeId, isSessionAliveRow, one, os, path, PLUGIN_ROOT, primaryCursorPath,
  projectContextMismatch, pull, readDescriptorFile, readerCursors, repokey, repoKeyForCwd,
  spawnSync, store, upsertStoreRegistry, withIdLock, withIdLockHeld, writeDescriptorAtomic,
} = require('./core.js');
const {
  appSessionOnWorktree, callerReaderKey, isPrimaryCheckout, resolveCallerWorktree, seatSessionId,
} = require('./identity.js');
const {
  reservedIdToken,
} = require('./cursors.js');
const {
  rehomeCore, retireWorktreeDuplicates,
} = require('./fold.js');

// ============================================================================
// Phase 7 (PLAN-v0.57-mesh.md) — send-time self-heal. Invoked BEFORE every
// send-like verb (mesh `send`, `inbox pull`'s native drain, `archive-request`'s
// `message-child`): checks THIS project's per-project daemon health
// (ingestHealth.daemonHealth, D25 — running+healthy, not freshness-only) and,
// when it looks stale/missing, best-effort spawns the (idempotent) repoKey
// installer to self-heal it — NEVER blocking the caller's own action, which
// always proceeds regardless of readiness (the native queue buffers; a
// send-direct mesh write is daemon-independent by design, D8).
// ============================================================================
const SELF_HEAL_COOLDOWN_MS = 60 * 1000; // O-D7

function selfHealCooldownPath(home, repoKey) {
  return path.join(devswarmRoot(home), 'self-heal', 'ingest-' + repoKey + '.json');
}
function selfHealCooldownElapsed(home, repoKey, now, F) {
  try {
    const st = JSON.parse((F || fs).readFileSync(selfHealCooldownPath(home, repoKey), 'utf8'));
    const last = st && Number.isFinite(st.lastAttemptAt) ? st.lastAttemptAt : null;
    if (last === null) return true;
    return (now - last) >= SELF_HEAL_COOLDOWN_MS;
  } catch (_) {
    return true; // no/unreadable state -> treat as elapsed (heal now)
  }
}
// markSelfHealAttempt — record this attempt's timestamp (atomic tmp+rename),
// same idiom as hooks/devswarm-parent-inbox.js's markArchiveNudged. Best-effort:
// a failed write only means a future call may re-attempt sooner than the
// cooldown intends — never blocks the caller.
function markSelfHealAttempt(home, repoKey, now, F) {
  try {
    const G = F || fs;
    const p = selfHealCooldownPath(home, repoKey);
    G.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    G.writeFileSync(tmp, JSON.stringify({ lastAttemptAt: now }));
    G.renameSync(tmp, p);
  } catch (_) {}
}

// defaultSpawnInstaller(worktree, home, env) — run the plugin's OWN idempotent
// installer as a subprocess, cwd'd INSIDE the target worktree (so its own
// resolveMainWorktree/repoKey derivation lands on the SAME project) with HOME
// threaded — the same spawn shape as hooks/lib/doctor-repair.js's
// spawnInstaller / skills/update/scripts/update.js's healIngestDaemon.
//
// Belt-and-braces guard (defect ec33954162ef): a test that builds a ctx
// without `ctx.io.spawnInstaller` falls through to THIS function, which
// would otherwise register a REAL LaunchAgent/systemd unit under a
// short-lived temp HOME — that registration outlives the deleted HOME and
// retries forever (exit 78, "program gone"). ANTIHALL_INGEST_DRY_RUN=1 is
// install-devswarm-ingest.js's OWN documented dry-run seam (see its top-of-
// file comment); when a caller's env already carries it (every test that
// isolates HOME via tests/scripts/devswarm-lifecycle.test.js's / tests/
// companion/devswarm-supervisor-reconcile-sweep.test.js's convention should),
// forward it through unchanged so the spawned installer no-ops its writes
// instead of registering a real unit.
function defaultSpawnInstaller(worktree, home, env) {
  const installerPath = path.join(PLUGIN_ROOT, 'companion', 'install-devswarm-ingest.js');
  try {
    return spawnSync(process.execPath, [installerPath], {
      // installerChildEnv: merged onto this process's env with the test
      // markers carried — a caller's partial ctx.env must never strip
      // NODE_TEST_CONTEXT/PATH from the installer child (0.108.0 launchd leak).
      cwd: worktree, env: require('../../companion/lib/test-home-guard.js').installerChildEnv(env, { HOME: home, USERPROFILE: home }), encoding: 'utf8', timeout: 30000,
    });
  } catch (_) {
    return null;
  }
}

// selfHeal(ctx) -> { daemonHealthy?:true, daemonWarning?:string, daemonHealAttempted?:true }
// NEVER throws (fail-open — a self-heal failure must never block the caller's
// own action) and never blocks: the caller always proceeds with its own verb
// regardless of what this returns.
//   'unsupported-platform' — win32 (D28): no daemon possible there, no spawn.
//   'no-worktree'          — cwd is not inside a resolvable git worktree; the
//                             self-heal GATE (isDevswarmActive && a resolved
//                             worktree) can never open, so no spawn either.
//   'stale'                — daemon looks stale/missing. Spawns the installer
//                             ONLY when gated (isDevswarmActive(env) AND the
//                             worktree resolved, already true by this point)
//                             AND the cooldown has elapsed; `daemonHealAttempted`
//                             is set true iff a spawn actually happened.
function selfHeal(ctx) {
  try {
    const platform = (ctx.io && ctx.io.platform) || process.platform;
    if (platform === 'win32') return { daemonWarning: 'unsupported-platform' };

    const env = ctx.env || process.env;
    const cwd = ctx.cwd || process.cwd();
    const home = ctx.home || os.homedir();
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

    const resolveWt = (ctx.io && ctx.io.resolveWorktree)
      || (() => identityContext(cwd, CALLER_CWD).toplevel);
    const worktree = resolveWt(cwd);
    if (!worktree) return { daemonWarning: 'no-worktree' };

    const resolveKey = (ctx.io && ctx.io.repoKeyForWorktree) || repokey.repoKeyForWorktree;
    let repoKey = null;
    try { repoKey = resolveKey(worktree); } catch (_) { repoKey = null; }

    const health = ingestHealth.daemonHealth(home, repoKey, { now, platform, io: ctx.io && ctx.io.health });
    if (health.status === 'unsupported') return { daemonWarning: 'unsupported-platform' };
    if (health.status === 'healthy') return { daemonHealthy: true };

    // stale/missing. The SPAWN (never the health read above) is gated.
    if (!isDevswarmActive(env) || !repoKey) return { daemonWarning: 'stale' };

    // DISABLED IN LAUNCHD (owner-intentional `launchctl disable`): the installer's
    // `launchctl load` cannot start a disabled job, so every heal would spawn the
    // installer for nothing. Read-only probe, fail-open; NEVER re-enables it.
    const disabledLabel = ingestHealth.launchdDisabledLabel(repoKey, { platform, io: ctx.io && ctx.io.launchd });
    if (disabledLabel) return { daemonWarning: 'stale', daemonDisabled: true, daemonDisabledLabel: disabledLabel };

    const F = (ctx.io && ctx.io.fs) || fs;
    if (!selfHealCooldownElapsed(home, repoKey, now, F)) {
      // retryAfterMs (defect 2e8653787945, P2): the remaining cooldown, so a
      // caller told the daemon is stale/healing has a concrete "try again
      // after" instead of guessing when to retry. Best-effort: an unreadable/
      // missing cooldown file (already `true`'s error branch in
      // `selfHealCooldownElapsed`) means this read can't happen either — fall
      // back to `SELF_HEAL_COOLDOWN_MS` (the whole window) rather than
      // omitting the field on a co-occurring read failure that isn't supposed
      // to reach here anyway (an unreadable file makes `selfHealCooldownElapsed`
      // return `true`, i.e. elapsed, so this branch is only reached with a
      // readable file in practice).
      let retryAfterMs = SELF_HEAL_COOLDOWN_MS;
      try {
        const st = JSON.parse(F.readFileSync(selfHealCooldownPath(home, repoKey), 'utf8'));
        const last = st && Number.isFinite(st.lastAttemptAt) ? st.lastAttemptAt : null;
        if (last !== null) retryAfterMs = Math.max(0, SELF_HEAL_COOLDOWN_MS - (now - last));
      } catch (_) { /* keep the whole-window fallback above */ }
      return { daemonWarning: 'stale', daemonHealCooldown: true, retryAfterMs };
    }
    markSelfHealAttempt(home, repoKey, now, F);
    const spawn = (ctx.io && ctx.io.spawnInstaller) || defaultSpawnInstaller;
    const spawnResult = spawn(worktree, home, env);
    // A5(a): the installer spawn's own outcome used to be discarded entirely —
    // an installer failing on EVERY attempt was silently retried forever with
    // nothing surfaced. Capture + report it. `defaultSpawnInstaller` returns
    // either `null` (the spawn itself threw — caught there) or a real
    // spawnSync result (`.error` set on a genuine spawn failure, `.status`
    // non-zero on the installer's own non-zero exit). A test/injected
    // `spawnInstaller` double that returns `undefined` (no signal either way —
    // the common "just count the call" convention used throughout this
    // codebase's own test suite) is NOT treated as a failure: only a
    // POSITIVE signal (an explicit null, an `.error`, or a non-zero
    // `.status`) counts, per the fail-open-on-ambiguity posture.
    const spawnFailed = spawnResult === null
      || !!(spawnResult && (spawnResult.error
        || (Number.isFinite(spawnResult.status) && spawnResult.status !== 0)));
    if (spawnFailed) {
      try {
        const detail = (spawnResult && spawnResult.error)
          ? String((spawnResult.error && spawnResult.error.message) || spawnResult.error)
          : (spawnResult === null ? 'installer spawn threw' : ('installer exited with status ' + spawnResult.status));
        alog.logError('devswarm-cli', 'self-heal-installer', detail, { repoKey });
      } catch (_) { /* logging must never break self-heal */ }
      return { daemonWarning: 'stale', daemonHealAttempted: true, daemonHealFailed: true };
    }
    return { daemonWarning: 'stale', daemonHealAttempted: true };
  } catch (_) {
    return {}; // fail-open: self-heal must never throw or block the caller
  }
}

// withSelfHeal(fn, ctx) — runs selfHeal(ctx) BEFORE `fn()` (the send-like
// action), then merges the heal outcome's fields onto `fn()`'s result object
// (never overwriting the action's own `ok`/`error`/etc. keys). `fn()`'s own
// result always wins the response; self-heal only ADDS informational fields.
function withSelfHeal(fn, ctx) {
  const heal = selfHeal(ctx);
  const r = fn();
  if (heal && r && typeof r === 'object') {
    if (heal.daemonWarning) r.daemonWarning = heal.daemonWarning;
    if (heal.daemonHealthy) r.daemonHealthy = true;
    if (heal.daemonHealAttempted) r.daemonHealAttempted = true;
    if (heal.daemonHealCooldown) r.daemonHealCooldown = true;
    if (heal.daemonDisabled) { r.daemonDisabled = true; r.daemonDisabledLabel = heal.daemonDisabledLabel; }
    if (Number.isFinite(heal.retryAfterMs)) r.retryAfterMs = heal.retryAfterMs;
    // ADDRESS-FAILURE ATTRIBUTION (defect 2e8653787945, P2): `send --to`/
    // `--to-primary` resolve the recipient against THIS process's in-memory
    // registry read, which can lag a real, just-completed registration until
    // the (here-confirmed-stale) ingest daemon drains it — so
    // `primary-unregistered`/`unregistered-recipient` can mean "genuinely no
    // such recipient" OR "the registry this resolved against is stale",
    // indistinguishable from the reason string alone (field-reported: retried
    // unchanged, succeeded once the daemon healed). ADDITIVE ONLY — `reason`/
    // `error` are left exactly as the address resolution produced them, never
    // silently reattributed (a genuinely bad address alongside a coincidentally
    // stale daemon must not be reported as merely a timing issue) — this only
    // gives the caller a signal to retry after `retryAfterMs` instead of
    // treating the refusal as final.
    if (r.ok === false && heal.daemonWarning === 'stale'
      && (r.reason === 'primary-unregistered' || r.reason === 'unregistered-recipient')) {
      r.possiblyStaleRegistry = true;
    }
  }
  return r;
}

// precreateCursorAndInbox(desc) — idempotent, non-destructive precreate of a
// descriptor's CURRENT cursorPath/inboxPath. Shared by cmdRegister's create
// path AND its ensure/exists path (a descriptor whose inbox/cursor was
// repointed to a new path — e.g. a worktree-local `.devswarm-temp/inbox.ndjson`
// override — must get this precreate too: without it the cursor never gets
// created, `inbox count/read` returns known:false forever, and
// devswarm-parent-gate.js's Stop-hook gate reads that as "inbox unreadable"
// for what is actually a live, active workspace. Path-agnostic: works for the
// central-store default path (devswarmRoot/inbox|cursors/<id>) exactly the
// same as any custom repointed path — never special-cased.
//
// Initialize the durable cursor to 0 (nothing consumed yet) IF it does not
// already exist — so `inbox count/read` immediately reports all messages as
// unread. Without a cursor file, unreadBacklog returns known:false (a
// fail-safe for the liveness path) which would read as "nothing pending".
// NON-DESTRUCTIVE: never clobbers an existing cursor.
//
// Initialize an EMPTY durable inbox file IF it does not already exist — so a
// freshly-registered child reads as known:true/0-unread (confirmed-empty)
// rather than known:false (unreadable/absent, devswarm-parent-gate.js's
// Stop-hook gate's genuine-anomaly signal). Without this, "just registered,
// never messaged" and "genuinely neglected, inbox never written" are the
// SAME fs state (cursor present, inbox absent) and the gate cannot tell them
// apart. TRUNCATION-PROOF CREATE (P0 data-loss fix, hardened): a plain
// `existsSync` + `writeFileSync` (default flag 'w', which TRUNCATES) is a
// TOCTOU race — a concurrent devswarm-pull.js drain (companion/lib/devswarm-
// pull.js) can create + durably append to this SAME inboxPath, under its OWN
// per-id lock that register never takes, in the window between the
// existsSync check and the write, and the truncating write then ERASES that
// real content. An earlier fix used `wx` (exclusive create, fails closed on
// EEXIST), but O_EXCL exclusivity is documented as unreliable over some
// network filesystems (NFS). `a` (append) sidesteps this entirely: it opens
// for append and CREATES the file if absent, and appending '' never
// truncates existing content on ANY filesystem — no reliance on O_EXCL
// exclusivity at all. So this can NEVER clobber a pull-written inbox, race
// or no race, on any filesystem. Cross-platform (supported on win32/macOS/
// linux). Fail-open: any error (permissions etc.) is swallowed — best-effort
// init only; append mode does not throw on an already-existing file.
function precreateCursorAndInbox(desc) {
  if (desc.cursorPath) {
    try {
      fs.mkdirSync(path.dirname(desc.cursorPath), { recursive: true });
      fs.writeFileSync(desc.cursorPath, '0', { flag: 'wx' });
    } catch (_) { /* fail-open: best-effort init only, non-fatal (matches inbox block below) */ }
  }
  if (desc.inboxPath) {
    try {
      fs.mkdirSync(path.dirname(desc.inboxPath), { recursive: true });
      fs.writeFileSync(desc.inboxPath, '', { flag: 'a' });
    } catch (_) { /* fail-open: best-effort init only, non-fatal to registration */ }
  }
}

// ----- subcommands -----
// cmdRegister — the WHOLE descriptor+registry mutation runs under the per-id
// lock (P1-4): register / ensure serialize against a concurrent archive/reap for
// the same id, so archive can never delete a descriptor register replaced after
// archive's inode check, and ensure never interleaves with a re-home.
function cmdRegister(id, flags, ctx, { requireNew } = {}) {
  const home = ctx.home;
  // withIdLockHeld: register-primary / seat adoption hold this id's lock
  // around their check-then-write and call in here (the lock file is not
  // re-entrant; HELD_ID_LOCKS verifies this process holds it).
  return withIdLockHeld(id, home, () => {
  let existing = readDescriptorFile(home, id);
  // APP-DB ARCHIVE GUARD (0.109.1, field defect: two DevSwarm-app-archived
  // workspaces' still-open terminal tabs relaunched `claude` ~10s after the
  // process was killed; the fresh session's routine `ensure`/`register` call
  // revived both rows to active). The DevSwarm app's own database is GROUND
  // TRUTH for archived state (companion/lib/devswarm-app-db.js) — trust it
  // over anti-hall's OWN archived/<id>.json marker, which this file's
  // pre-existing `hasArchivedCounterpart` resurrection guard below checks but
  // which is ONLY written by anti-hall's own `archive` CLI verb. A workspace
  // archived from the DevSwarm APP UI (isActive=0, isHidden=1 in the app DB)
  // never gets that marker, so the pre-existing guard is silent for it, and
  // BOTH the `requireNew` (ensure) branch and the explicit `register` branch
  // below would otherwise happily (re)write the descriptor + registry row.
  // Checked ONCE, here, before either branch runs — so NEITHER path can
  // revive an app-archived id, "regardless of new heartbeats or
  // registrations" (owner rule: trust the app DB over anti-hall's own
  // markers; restore, never delete). Fail-open: an unreadable/absent app DB
  // (appArchivedVerdict returns null) keeps today's behavior exactly — see
  // devswarm-app-db.js's own CONTRACT.
  {
    const wtForAppGuard = one(flags, 'worktree') || (existing && existing.worktreePath) || null;
    let appArchivedGuard = null;
    try {
      appArchivedGuard = require('../../companion/lib/devswarm-app-db.js').appArchivedVerdict({
        home, env: ctx.env, id, worktreePath: wtForAppGuard, now: ctx.now, xcache: true,
      });
    } catch (_) { appArchivedGuard = null; }
    if (appArchivedGuard === true) {
      return {
        ok: false, action: 'app-archived-skip', id, archived: true, appArchived: true,
        reason: 'workspace ' + id + ' is archived in the DevSwarm app (isActive=0, isHidden=1); '
          + 'registration is refused regardless of any local marker or heartbeat — the app DB is '
          + 'ground truth over anti-hall\'s own markers (owner rule). A live session is still running '
          + 'in this archived workspace: close its DevSwarm tab, or run `hivecontrol workspace archive '
          + '<full id>`, to stop it retrying.',
      };
    }
  }
  // RESERVED-TOKEN IDS (R2 Auditor item 13). Refuse a FRESH registration whose
  // id carries a token this file's cursor namespaces use. `#` separators already
  // make the new namespaces collision-proof, but `.seen-` genuinely collides
  // with the shipped watermark namespace, and an id like `w.base` or
  // `w.inst-abcdef` reads as another workspace's internal file to any human or
  // future parser. Scoped to the CREATE path: an install that already has such a
  // row keeps working, because breaking a live workspace is worse than the
  // ambiguity the name carries.
  if (!existing) {
    const bad = reservedIdToken(id);
    if (bad) {
      return {
        ok: false, id, reason: 'reserved-id-token',
        error: 'refusing to register workspace id ' + JSON.stringify(String(id))
          + ' — it contains the reserved token ' + JSON.stringify(bad)
          + ', which anti-hall uses for its own cursor namespaces under cursors/. '
          + 'Choose an id without it.',
      };
    }
  }
  // ARCHIVE RESURRECTION FIX (field defect a48db2e0ea08): archiving unlinks the
  // active descriptor (see cmdArchive), so a routine `ensure` — the path
  // cmdInboxPull's auto-ensure runs on EVERY turn from a still-running child —
  // saw `existing` as absent and fell through to the CREATE branch below,
  // silently rewriting a fresh descriptor AND upserting a live registry row:
  // the archived workspace reappeared active, undone by traffic nobody asked
  // to undo. Archiving is an operator/lifecycle decision; a background
  // auto-ensure must not silently reverse it. Gate ONLY the requireNew
  // (ensure/auto-ensure) path — the explicit `register` verb (requireNew
  // false, below) is the deliberate re-registration escape hatch and is left
  // exactly as it was: an operator (or a child) that explicitly re-registers
  // an archived id still revives it. Read-only, fail-closed check
  // (hasArchivedCounterpart never throws); never deletes anything.
  //
  // REUSED-ID FIX (P1-b field defect): ids are branch/worktree-derived and
  // branch names are commonly reused, so an exact-id archived match alone is
  // NOT proof this is the SAME workspace being resurrected — it can just as
  // easily be a genuinely NEW workspace that happens to reuse an old id.
  // archivedCounterpartInfo distinguishes the two using the one identity field
  // every descriptor carries (worktreePath), compared against THIS call's
  // resolved --worktree. Refusing forever on a false match was the bug; the
  // resurrection guard itself (below) is still correct and stays.
  let archivedNote = null;
  // deliberate: under-detect only (refuse a routine auto-ensure), never a removal decision — bare marker check is fine here.
  if (requireNew && !existing && hasArchivedCounterpart(home, id)) {
    const currentWorktree = one(flags, 'worktree');
    const info = archivedCounterpartInfo(home, id, currentWorktree);
    if (info.sameWorkspace === true) {
      return {
        ok: false, action: 'archived-skip', id, archived: true,
        reason: 'workspace ' + id + ' is archived; routine auto-ensure does not revive it'
          + ' (run `devswarm register ' + id + ' ...` to explicitly re-register)',
      };
    }
    if (info.sameWorkspace === false) {
      // Different worktree than the archived record -> a NEW workspace that
      // reuses this id. Allow the create below, but surface the archived
      // record loudly (never let this pass silently).
      archivedNote = {
        archivedRecordExists: true, sameWorkspace: false,
        archivedWorktreePath: info.archivedWorktreePath, currentWorktreePath: currentWorktree,
        note: 'an archived record for id ' + id + ' exists from a different worktree ('
          + info.archivedWorktreePath + '); treating this as a new workspace, not a resurrection',
      };
    } else {
      // Ambiguous (missing/unresolvable worktree info on either side): fail
      // OPEN per the guiding principle (a wrongful refusal is worse than an
      // occasional miss), but report it loudly rather than passing silently.
      archivedNote = {
        archivedRecordExists: true, sameWorkspace: null,
        archivedWorktreePath: info.archivedWorktreePath, currentWorktreePath: currentWorktree,
        note: 'an archived record for id ' + id + ' exists but same-workspace-vs-new could not be '
          + 'determined (missing worktree info); allowing (fail-open) — verify manually',
      };
    }
  }
  if (requireNew && existing) {
    // ensure: idempotent — preserve the descriptor fields, backfilling only a
    // structurally-proven legacy ownerKey, then re-upsert the store registry. Also reconcile
    // any legacy/phantom duplicate row for this SAME worktree every time (the
    // steady-state child path: `inbox pull` auto-ensures each turn), so a
    // duplicate created AFTER the child's first register is still retired.
    //
    // FIX (split-brain gate nag): this branch used to skip the cursor/inbox
    // precreate entirely (only the CREATE path below ran it). A descriptor
    // repointed to a path whose cursor was never created then stayed
    // known:false forever, even though `inbox pull` re-enters THIS branch
    // every turn — the ensure path must precreate too, using the descriptor's
    // CURRENT (possibly repointed) paths, not whatever this call's flags say.
    const currentRepoKey = repoKeyForCwd(ctx);
    // P1-1/P1-2 RE-HOME: if the descriptor is stranded in the legacy hash bucket
    // (persisted ownerKey === hashFromWorkspaceId(id)) and this project's repoKey
    // now resolves, MIGRATE its registry row + messages into store/<repoKey>/ and
    // rewrite ownerKey=repoKey BEFORE the ownership check below — so ensure no
    // longer rejects the workspace from its own inbox. Lock already held.
    // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
    // The ownership check further down compares the descriptor's PERSISTED
    // ownerKey against this cwd — but the re-home immediately below REWRITES
    // that ownerKey to this cwd's key first, so the check was validating a
    // fact the previous statement had just manufactured. `ensure` on a
    // hash-stranded workspace whose worktree genuinely lives in ANOTHER
    // project therefore returned ok:true, moved that project's messages into
    // this one, and took ownership of the descriptor. Refuse FIRST, on the
    // id's own registered key (fresh worktree key, else the persisted
    // repoKey/ownerKey), before anything is written.
    // Fail-open unchanged: a descriptor that names no project at all
    // (registeredRepoKey === null — including the legacy hash bucket it is
    // stranded in) falls straight through to the re-home heal as before.
    {
      const registeredRepoKeyForEnsure = descriptorRegisteredRepoKey(existing, id);
      if (registeredRepoKeyForEnsure && registeredRepoKeyForEnsure !== currentRepoKey) {
        return projectContextMismatch(id, registeredRepoKeyForEnsure, currentRepoKey,
          'run this from within that project\'s worktree to ensure it');
      }
    }
    let rehomed = null;
    {
      const storedOwnerKeyPre = typeof existing.ownerKey === 'string' && existing.ownerKey ? existing.ownerKey : null;
      const hashKey = store.hashFromWorkspaceId(id);
      if (currentRepoKey && storedOwnerKeyPre === hashKey && hashKey !== currentRepoKey) {
        rehomed = rehomeCore(home, id, currentRepoKey, ctx);
        if (rehomed && rehomed.rehomed) existing = readDescriptorFile(home, id) || existing;
      }
    }
    const currentOwnerKey = currentRepoKey || store.hashFromWorkspaceId(id);
    const storedOwnerKey = typeof existing.ownerKey === 'string' && existing.ownerKey ? existing.ownerKey : null;
    const provenOwnerKey = storedOwnerKey || descriptorStructuralRepoKey(existing);
    const activeLegacyPerId = !storedOwnerKey && !provenOwnerKey && currentRepoKey === null;
    if ((!provenOwnerKey && !activeLegacyPerId) || (provenOwnerKey && provenOwnerKey !== currentOwnerKey)) {
      return { ok: false, error: 'existing descriptor does not belong to the current project' };
    }
    const ensured = Object.assign({}, existing);
    if (!storedOwnerKey) ensured.ownerKey = currentOwnerKey;
    if (currentRepoKey && descriptorFreshRepoKey(ensured) === currentRepoKey) ensured.repoKey = currentRepoKey;
    // BACKFILL (self-heal parity with the child turn hook's `defaultInboxPath`
    // backfill at devswarm-child-turn.js:447): a `primary-*` descriptor has no
    // per-turn hook to backfill a null/absent inboxPath, so it fails reconcile
    // ("descriptor has no inboxPath") forever unless THIS ensure path — which
    // runs on every `inbox pull` — repairs it. cmdInboxPull already computes a
    // correct default via pull.inboxDefaultPath/cursorDefaultPath and passes it
    // in ensureFlags every call; this branch used to silently discard it.
    // CONSERVATIVE: only fills a null/undefined/empty-string field, from the
    // caller's supplied flag first, falling back to the deterministic default —
    // NEVER overwrites an existing non-empty value.
    if (ensured.inboxPath === null || ensured.inboxPath === undefined || ensured.inboxPath === '') {
      ensured.inboxPath = one(flags, 'inbox') || pull.inboxDefaultPath(home, id);
    }
    if (ensured.cursorPath === null || ensured.cursorPath === undefined || ensured.cursorPath === '') {
      ensured.cursorPath = one(flags, 'cursor') || pull.cursorDefaultPath(home, id);
    }
    // #11 ROOT CAUSE FIX: this `ensure` branch runs on EVERY `inbox pull` —
    // every turn from a live child, AND every reconcile-sweep-spawned pull for
    // EVERY registered row, including one the DevSwarm app already archived
    // (reconcile enumerates all registry rows; it has no reason to skip one
    // yet, since app-archived status is itself derived from this same file's
    // age — see below). writeDescriptorAtomic used to run UNCONDITIONALLY
    // here even when `ensured` is byte-identical to `existing` (the steady-
    // state case), which rewrites the descriptor file via atomic tmp+rename —
    // bumping its mtime. companion/lib/devswarm-archived-cache.js's
    // isAppArchived conjunct 4 (rowFirstSeenMs) reads THIS SAME file's mtime
    // as "when did anti-hall first learn about this row", specifically so a
    // freshly-spawned workspace gets a grace period before being read as
    // app-archived by absence. Because the reconcile sweep touches every
    // row's descriptor on its own cooldown (independent of any real change),
    // and also writes the app active-list cache's `fetchedAt` in that SAME
    // tick, `cache.fetchedAt - firstSeen` was always ~0 — permanently
    // failing the grace conjunct, so an app-archived row could NEVER be
    // detected: the per-turn roster table (hooks/devswarm-parent-inbox.js)
    // and `roster` kept showing it "active" with a fresh "last" forever.
    // Fix: only perform the write (and therefore only bump mtime) when the
    // ensure pass actually changed something. A genuinely no-op ensure now
    // leaves the descriptor's mtime — and therefore rowFirstSeenMs — alone,
    // so it accurately reflects "since when has nothing here changed",
    // letting the archive grace elapse normally once the app-side probe
    // confirms absence.
    if (JSON.stringify(ensured) !== JSON.stringify(existing)) {
      writeDescriptorAtomic(home, id, ensured);
    }
    existing = ensured;
    precreateCursorAndInbox(existing);
    upsertStoreRegistry(home, existing, ctx);
    const retire = retireWorktreeDuplicates(home, existing, ctx);
    const out = { ok: true, action: 'exists', id, descriptor: existing };
    if (rehomed && rehomed.rehomed) out.rehomed = { movedMessages: rehomed.movedMessages, movedRegistry: rehomed.movedRegistry };
    if (retire) { out.retiredDuplicates = retire.retired; out.forwardedMessages = retire.forwarded; if (retire.left) out.leftDuplicates = retire.left; if (retire.forwardFailed) out.forwardFailed = retire.forwardFailed; if (retire.pending) out.pendingDuplicates = retire.pending; }
    return out;
  }
  const desc = buildDescriptorFromFlags(id, flags, existing, ctx.env);
  // Validate the REQUIRED workspace fields before writing. A descriptor missing
  // worktreePath/sessionId is invisible to the supervisor (readDescriptors filters
  // on both), so writing one with null fields and returning ok:true is a silent
  // phantom-registration. `register` (and `ensure` when it CREATES a new
  // descriptor) therefore require them; the flag values may come from `existing`
  // on a re-register/update, so we validate the MERGED result, not the raw flags.
  const missing = [];
  if (!desc.worktreePath) missing.push('--worktree');
  if (!desc.sessionId) missing.push('--session');
  if (missing.length) {
    return {
      ok: false,
      error: 'register requires ' + missing.join(' and ')
        + ' (required workspace fields; a descriptor without them is ignored by the supervisor)',
    };
  }
  const currentRepoKey = repoKeyForCwd(ctx);
  const worktreeRepoKey = descriptorFreshRepoKey(desc);
  // P1-6 CROSS-PROJECT GUARD: reject a register whose --worktree lives in a
  // DIFFERENT git project than the invoking cwd. Both keys must resolve AND
  // differ to reject (a null on either side is the legitimate transient-null or
  // non-git case handled elsewhere) — otherwise repoA could register repoB's
  // descriptor with ownerKey=A, letting A's reap/reconcile archive B's workspace.
  if (currentRepoKey && worktreeRepoKey && currentRepoKey !== worktreeRepoKey) {
    return {
      ok: false,
      error: 'register --worktree ' + JSON.stringify(desc.worktreePath)
        + ' belongs to a different project (' + worktreeRepoKey + ') than the current cwd (' + currentRepoKey
        + ') — cross-project registration is refused',
    };
  }
  if (currentRepoKey && worktreeRepoKey === currentRepoKey) desc.repoKey = currentRepoKey;
  desc.ownerKey = currentRepoKey || store.hashFromWorkspaceId(id);
  writeDescriptorAtomic(home, id, desc);
  precreateCursorAndInbox(desc);
  // F-B (v0.61.2): re-registering an EXISTING id at a NEW same-project worktree
  // is a legitimate supported flow (cross-project is already rejected above by
  // the P1-6 guard) — pass allowPathChange:true so the F2 id-collision guard
  // does not silently skip the registry write while the descriptor above has
  // already moved to the new path, which would leave them divergent. Check the
  // return: false means the store genuinely skipped the write (should not
  // happen with allowPathChange:true short of a store-internal bug) — never
  // report ok:true over an unconfirmed registry write.
  const registryWritten = upsertStoreRegistry(home, desc, ctx, { allowPathChange: true });
  if (registryWritten === false) {
    return {
      ok: false, id,
      error: 'registry upsert was skipped for ' + JSON.stringify(id)
        + ' — descriptor and registry are now out of sync (retry required)',
    };
  }
  // Retire any legacy/phantom duplicate row for this SAME worktree so exactly one
  // row (this builder-id — the partition the child reads) survives, forwarding the
  // duplicate's unread backlog first (no orphaned messages). No-op unless a
  // duplicate exists; gated to builder-id self-registers inside the helper.
  const retire = retireWorktreeDuplicates(home, desc, ctx);
  // DECLARE this instance as a reader of `id` (defect 8b211241bbe9, R1). `ensure`
  // routes through here on every turn, so each live process holds its own cursor
  // file from its first turn and keeps its own view of the mailbox.
  // Phase 3: one reader_cursors row per namespace (store + nd), seeded at
  // max(F, this harness's own mapped legacy position), INSERT-if-absent. A
  // headless caller (no harness ancestor) declares nothing and reads the floor.
  try {
    const regReader = callerReaderKey(ctx);
    if (regReader) {
      const rk = repoKeyForCwd(ctx);
      const seedStore = store.openStore({ home, workspaceId: id, hash: rk || undefined, backend: ctx && ctx.backend, env: ctx && ctx.env });
      try {
        readerCursors.declare(seedStore, {
          partition: id, reader: regReader, home, cursorPath: (desc && desc.cursorPath) || null,
          now: ctx && ctx.now, procTable: ctx && ctx.procTable,
        });
      } finally { seedStore.close(); }
    }
  } catch (_) { /* fail-soft: an undeclared instance simply reads from the floor */ }
  const out = { ok: true, action: existing ? 'updated' : 'registered', id, descriptor: desc };
  if (retire) { out.retiredDuplicates = retire.retired; out.forwardedMessages = retire.forwarded; if (retire.left) out.leftDuplicates = retire.left; if (retire.forwardFailed) out.forwardFailed = retire.forwardFailed; if (retire.pending) out.pendingDuplicates = retire.pending; }
  if (archivedNote) out.archivedNote = archivedNote;
  return out;
  });
}

// cmdInboxTick(id, flags, ctx) -> the D13 (v0.97.0) "one command" mailbox-wake
// verb. FIELD MEASUREMENT that motivated it: a child session's 5-minute cron
// (pull + count, then a forced Stop-hook heartbeat EVERY tick) produced 1,225
// polling lines / 2.29 MB — about half that session's real content — almost
// entirely "mailbox empty" no-ops. `inbox tick` folds the cron prompt's own
// pull(if `--child`)+count into ONE command AND leaves three cheap side
// effects behind so the rest of the wake path can be smarter about a no-op:
//   1. wake-tick marker (`<home>/.anti-hall/devswarm/wake-tick/<id>.json`,
//      { ts, unreadTotal, meshGapWithheld }) — devswarm-child-gate.js's Stop
//      hook reads this to skip its OWN forced-heartbeat block when the marker
//      is fresh and proves "nothing to do" (see that file's
//      tickMarkerFreshZero()) — the tick itself is a liveness signal, so a
//      SEPARATE forced report is redundant overhead in exactly that case.
//   2. heartbeat ts refresh (`heartbeats/<id>.json`) — cheap (bump ts/state_ts
//      on the EXISTING file only; never fabricates progress/phase/wip/
//      blockers, matching cmdHeartbeat's own authorship rule) so a supervisor
//      sweep still sees fresh activity from a session that only ever ticks.
//   3. cron-found-mail measurement (`cron-found-mail.jsonl`, capped at
//      CRON_FOUND_MAIL_CAP lines, oldest rotated out) — ONLY when this tick
//      found `unreadTotal > 0` AND a Monitor watcher lock file for this `id`
//      already exists (armed): that combination is a directly-measurable
//      "cron found something Monitor should have already delivered" event —
//      accumulating a count here is what lets a future release decide
//      whether cron is still pulling weight net of Monitor, instead of
//      guessing. `doctor --check` reports the line count as one INFO line.
// Fail-open throughout for effects 1-3 (marker/heartbeat/measurement writes
// are instrumentation, never allowed to fail the tick's real count result);
// the underlying `pull`/`count` calls keep their OWN existing error handling
// unchanged (this function adds no new failure mode to either).
// refreshAnchorSession(ctx) -> null | { refreshed, id, from, to } | { refreshed:false, reason }.
// v0.108.0: the Primary anchor (`primary-<hash>`) records a sessionId; after a
// /clear the running session is a NEW one but the anchor kept the old id, so a
// DevSwarm restart resumed the stale session. On the running session's own
// tick/heartbeat, re-register the anchor under the caller's session — only on
// the Primary checkout, only for an EXISTING anchor, only when the caller's
// session is positively running, and via cmdRegisterPrimary, whose
// live-primary-conflict guard refuses while the recorded session is still alive.
function refreshAnchorSession(ctx) {
  try {
    const env = (ctx && ctx.env) || {};
    const sid = env.CLAUDE_CODE_SESSION_ID ? String(env.CLAUDE_CODE_SESSION_ID) : '';
    if (!sid || !ctx.home) return null;
    const ic = identityContext(ctx.cwd || process.cwd(), CALLER_CWD);
    if (!ic.worktreeRoot || !isPrimaryCheckout(ic.worktreeRoot, ic.mainWorktree, ctx.home, env)) return null;
    const id = ic.meshId;
    const pre = readDescriptorFile(ctx.home, id);
    if (!pre || !pre.sessionId || String(pre.sessionId) === sid) return null;
    if (!isSessionAliveRow({ sessionId: sid }, ctx.home)) return null;
    // Re-read + write under the id lock (identity review: no check-then-write race).
    const out = withIdLock(id, ctx.home, () => {
      const desc = readDescriptorFile(ctx.home, id);
      if (!desc || !desc.sessionId || String(desc.sessionId) === sid) return null;
      const flags = { worktree: [ic.worktreeRoot] };
      if (desc.cursorPath) flags.cursor = [String(desc.cursorPath)];
      const r = cmdRegisterPrimary(flags, Object.assign({}, ctx, { cwd: ic.worktreeRoot }));
      return r && r.ok ? { refreshed: true, id, from: String(desc.sessionId), to: sid } : { refreshed: false, reason: (r && (r.reason || r.error)) || 'unknown' };
    });
    return out && out.lockBusy ? { refreshed: false, reason: 'lock-busy' } : out;
  } catch (_) { return null; }
}

// adoptPrimarySeat(ctx) -> { verdict, adopted, register? }. SessionStart: when
// the recorded holder is CLOSED, this session takes the SAME Primary id (same
// partitions and cursors; only the anchor's sessionId changes) through
// cmdRegisterPrimary, whose live-primary-conflict guard still refuses a live
// holder. Never mints a new identity. 'unknown'/'conflict' -> no write.
//
// 'none' handling (MAILBOX WAKE fix, field evidence 2026-09-26): a Primary
// checkout that has NEVER been registered (no `workspaces/<id>.json` at all —
// e.g. a fresh repo, or a repo whose DevSwarm activity never ran
// `register-primary`/`heartbeat`) reports seatVerdict state 'none', not
// 'adopt'. Pre-fix, this function only handled 'adopt' (a PRIOR holder now
// closed) — a never-registered seat fell through the `v0.state !== 'adopt'`
// guard with no write at all, so `id` (the deterministic `primary-<hash>`
// primaryCheckout() always computes, registered or not) stayed unregistered
// forever. Every SessionStart in that repo kept injecting a MAILBOX WAKE
// directive naming a real, correctly-resolved id that `inbox tick`/`inbox
// count` still refuse with `reason: 'unregistered-workspace'` — the exact
// field symptom this fix closes. 'none' is handled the SAME idempotent,
// fail-open way as 'adopt' (cmdRegisterPrimary is safe to call as a first-ever
// registration; its own child-worktree refusal still applies): this session
// simply becomes the seat's first holder instead of adopting one from a
// closed prior holder.
function adoptPrimarySeat(ctx, flags) {
  const seat = require('../../companion/lib/primary-seat.js');
  const sid = seatSessionId(ctx, flags);
  const verdict = () => seat.seatVerdict({ home: ctx.home, env: ctx.env, cwd: ctx.cwd || process.cwd(), sessionId: sid });
  // First-ever registration ('none') is a persistent write: it requires REAL
  // DevSwarm (DEVSWARM_REPO_ID), never supervisorMode=on alone (review P2).
  let realDevswarm = false;
  try { realDevswarm = require('../../hooks/lib/devswarm-detect.js').isRealDevswarm(ctx.env || process.env); } catch (_) { realDevswarm = false; }
  const eligible = (st) => st === 'adopt' || (st === 'none' && realDevswarm);
  const v0 = verdict();
  if (!eligible(v0.state)) return { verdict: v0, adopted: false };
  // Check-then-write under the Primary id's lock (identity review): two
  // sessions adopting at once serialize; the second re-reads the seat AFTER
  // the first's write and gets the conflict verdict (and its notice), never a
  // silent overwrite or a silent block.
  const res = withIdLock(v0.id, ctx.home, () => {
    const v = verdict();
    if (!eligible(v.state)) return { verdict: v, adopted: false };
    const desc = readDescriptorFile(ctx.home, v.id);
    const regFlags = { worktree: [v.worktree], session: [sid] };
    if (desc && desc.cursorPath) regFlags.cursor = [String(desc.cursorPath)];
    const r = cmdRegisterPrimary(regFlags, Object.assign({}, ctx, { cwd: v.worktree }));
    if (r && r.ok) return { verdict: v, adopted: true, register: r };
    return { verdict: verdict(), adopted: false, register: r };
  });
  if (res && res.lockBusy) return { verdict: Object.assign({}, v0, { state: 'unknown', lockBusy: true }), adopted: false };
  return res;
}
// cmdPrimary(sub, flags, ctx) — `primary status` (read-only seat verdict) and
// `primary takeover` (the explicit "continue here": re-register the anchor to
// this session with --force, demoting the other session, which from then on is
// refused by seatRefusal).
function cmdPrimary(sub, flags, ctx) {
  const seat = require('../../companion/lib/primary-seat.js');
  const sid = seatSessionId(ctx, flags);
  const v = seat.seatVerdict({ home: ctx.home, env: ctx.env, cwd: ctx.cwd || process.cwd(), sessionId: sid });
  if (sub === 'status' || sub === undefined) return Object.assign({ ok: true, action: 'primary-status', session: sid || null }, v);
  if (sub !== 'takeover') return { ok: false, error: 'primary: unknown subcommand ' + JSON.stringify(sub) + ' (status|takeover)' };
  if (v.state === 'n/a') return { ok: false, action: 'primary-takeover', reason: 'not-primary-checkout', error: 'primary takeover must run in the project\'s Primary checkout' };
  if (!sid) return { ok: false, action: 'primary-takeover', reason: 'no-session', error: 'primary takeover needs this session\'s id (CLAUDE_CODE_SESSION_ID or --session)' };
  if (v.state === 'own') return { ok: true, action: 'primary-takeover', id: v.id, already: true, session: sid };
  const r = withIdLock(v.id, ctx.home, () => {
    const desc = readDescriptorFile(ctx.home, v.id);
    const regFlags = { worktree: [v.worktree], session: [sid], force: [true] };
    if (desc && desc.cursorPath) regFlags.cursor = [String(desc.cursorPath)];
    return cmdRegisterPrimary(regFlags, Object.assign({}, ctx, { cwd: v.worktree }));
  });
  if (!r || !r.ok) return Object.assign({ action: 'primary-takeover' }, r || { ok: false });
  return { ok: true, action: 'primary-takeover', id: v.id, from: v.holder, to: sid, demoted: v.state === 'conflict' ? v.holder : null };
}

// cmdRegisterPrimary(flags, ctx) — register the CURRENT worktree's Primary/parent
// workspace descriptor under its per-worktree workspaceId (primary-<worktreeHash>),
// so `migrate` can fold a legacy NDJSON inbox into the store under that same id (what
// lets a Primary import its stranded messages). Reuses cmdRegister's descriptor-write
// path (validation + store upsert + cursor init). worktree defaults to the git
// toplevel of ctx.cwd; --inbox optionally points at a legacy NDJSON source for migrate.
function cmdRegisterPrimary(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  // resolveCallerWorktree (superproject-folding), NOT inst.resolveWorktree's raw
  // `--show-toplevel`: from a submodule cwd the latter minted a phantom
  // `primary-<submodule-hash>` row that no caller identity ever matches.
  const worktree = one(flags, 'worktree') || resolveCallerWorktree(cwd);
  if (!worktree) {
    return { ok: false, error: 'register-primary must run inside a git worktree (or pass --worktree <path>)' };
  }
  const id = inst.primaryWorkspaceId(worktree);
  if (!isSafeId(id)) return { ok: false, error: 'derived primary workspace id is unsafe: ' + JSON.stringify(id) };
  // v0.108.0: a DevSwarm CHILD worktree is not a Primary. Registering its
  // `primary-<hash>` label minted a phantom row whose replies nobody read.
  // Refused when the app records the worktree as a child builder, or the
  // session is a corroborated child (env + on-disk evidence); --force overrides.
  const forceRegister = !!(flags && flags.force && flags.force.length);
  if (!forceRegister) {
    let childBuilder = false;
    try {
      const wtReal = resolveCallerWorktree(worktree);
      const b = require('../../companion/lib/devswarm-app-db.js').builderForWorktree({ home, env: ctx.env, worktreePath: wtReal || worktree });
      childBuilder = !!(b && b.builderType && b.builderType !== 'primary');
    } catch (_) { childBuilder = false; }
    let corroborated = false;
    try { corroborated = !one(flags, 'worktree') && isChildWorkspaceCorroborated(ctx.env || {}, home, cwd); } catch (_) { corroborated = false; }
    if (childBuilder || corroborated) {
      return {
        ok: false, reason: 'not-primary-checkout', id, worktree,
        error: 'register-primary refused: ' + JSON.stringify(worktree) + ' is a DevSwarm CHILD workspace, not the '
          + 'project\'s Primary checkout. A child is addressed by its own workspace id; pass --force only if this '
          + 'worktree really hosts the Primary.',
      };
    }
  }
  // Task #10 (session_id realness): prefer the REAL Claude Code session id when the
  // caller didn't pass --session explicitly. CLAUDE_CODE_SESSION_ID is a genuine
  // env var Claude Code sets on every process it spawns (verified present on a live
  // session; see docs/KB-claude-codex.md's cmux discussion, which already treats it
  // as authoritative) — it is what liveness.js's transcriptMtime(projectDir,
  // sessionId) needs to find <projectDir>/<sessionId>.jsonl on disk. This call
  // ALWAYS registers the CALLER's OWN row (id is derived from the caller's own cwd
  // above, never an arbitrary target), so stamping the invoking process's own
  // session id here can never misattribute someone else's session. Previously this
  // fell back to DEVSWARM_BUILDER_ID (empty for a Primary — that env var is a
  // CHILD's identity) or the workspace `id` itself (never a real Claude session,
  // so the transcript term in readActivityTs/isDormantRow could never resolve for
  // any Primary row). DEVSWARM_BUILDER_ID is kept as the next fallback for back-
  // compat with any caller that still relies on it; `id` remains the final resort
  // so `register requires --session` never fires for a bare CLI invocation.
  const session = one(flags, 'session')
    || (ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID)
    || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID)
    || id;
  const inbox = one(flags, 'inbox'); // optional legacy NDJSON source for `migrate`
  const cursor = one(flags, 'cursor') || primaryCursorPath(home, id);
  // 7d0a948031cd fix — LIVE SIBLING PRIMARY GUARD. cmdRegister below is a plain
  // upsert keyed on `id` (deterministic per worktree): a SECOND `register-primary`
  // call for this SAME worktree from a DIFFERENT session silently overwrites the
  // existing row's `sessionId` with its own — no warning here, none in `roster`
  // either, even though `diagnose`'s split/mixedSplit counters (computeDiagnosis)
  // already have the machinery to SCORE exactly this shape (2+ registry rows or
  // ownership churn on one meshId), just never CONSULTED at the point the churn
  // is created. anti-hall's own hard rule is ONE Primary per project (see
  // docs/KB-devswarm-hivecontrol.md's `splits` entry, which documents 2+ LIVE
  // rows on one meshId as the general "benign" case for independently-registered
  // CHILD rows on the same worktree — a genuinely different question from THIS
  // row silently changing hands). Refuse-by-default (fail closed, the loss-free
  // direction — an overwritten sessionId is exactly the "Primary rows never
  // resolve a transcript" hazard Task #10 fixed for the correct-registration
  // case) unless the caller opts in with `--force`. isRoutingLiveRowStrict is
  // the SAME liveness predicate foldGroupIntoSurvivor's own routing decisions
  // already use (composes companion/lib/liveness.js's isSiblingPartitionLive) —
  // reused here rather than re-deriving a second "is this row live" test.
  // Fail-open: any error probing the existing row means "cannot prove a
  // conflict" -> proceeds exactly as before this fix (never a false refusal
  // from a store-open failure).
  const forceFlag = !!(flags && flags.force && flags.force.length); // bare boolean flag: `one()` returns undefined for `true` values, so it cannot be used here
  // v0.108.0 (identity review): the live-holder check and the write run under
  // the Primary id's lock, so two sessions adopting / refreshing / taking over
  // at once serialize — the second re-checks against the first's write and is
  // refused (live-primary-conflict) instead of silently overwriting it.
  return withIdLockHeld(id, home, () => registerPrimaryLocked(id, worktree, session, cursor, inbox, forceFlag, ctx, home));
}

function registerPrimaryLocked(id, worktree, session, cursor, inbox, forceFlag, ctx, home) {
  if (!forceFlag) {
    let conflict = null;
    try {
      const repoKeyForCheck = repokey.repoKeyForWorktree(worktree);
      const probeStore = store.openStore({ home, hash: repoKeyForCheck, backend: ctx.backend, env: ctx.env });
      try {
        const existing = (probeStore.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null;
        // C fix (7d0a948031cd): isRoutingLiveRowStrict's underlying
        // isSiblingPartitionLive treats a FRESH HEARTBEAT ALONE as live
        // (branch 1 of its own header comment) — right for routing/ack
        // decisions, wrong here: a refusal must require POSITIVE proof the
        // conflicting SESSION's harness process is actually running, never
        // just that its row heartbeated recently (a heartbeat can outlive
        // the process that wrote it, e.g. a crashed session whose last
        // heartbeat file is still fresh-enough by the clock). isSessionAliveRow
        // is exactly that stricter predicate (true ONLY on a positive
        // pid-alive check against the session's own harness file).
        if (existing && existing.sessionId != null && String(existing.sessionId) !== ''
            && String(existing.sessionId) !== String(session)
            && isSessionAliveRow(existing, home)) {
          conflict = existing;
          // v0.108.0: the DevSwarm app DB is authoritative when it names the
          // CALLER as this worktree's current AI terminal (the active terminal
          // of the builder on this worktree): the caller IS the Primary, so the
          // takeover is not a conflict. Anything else keeps the refusal.
          const app = appSessionOnWorktree(home, ctx.env, session, worktree);
          if (app && app.verdict === true && app.terminalActive === true) conflict = null;
        }
      } finally { probeStore.close(); }
    } catch (_) { conflict = null; }
    if (conflict) {
      return {
        ok: false,
        reason: 'live-primary-conflict',
        error: 'register-primary refused: worktree ' + JSON.stringify(worktree) + ' already has a LIVE Primary row '
          + JSON.stringify(id) + ' registered under a different, currently-live session ('
          + JSON.stringify(conflict.sessionId) + '). Registering now would silently overwrite that session\'s '
          + 'ownership of this row (anti-hall: ONE Primary per project). Pass --force to register anyway.',
        id, worktree, existingSessionId: conflict.sessionId,
      };
    }
  }
  const ensureFlags = { worktree: [worktree], session: [session], cursor: [cursor] };
  if (inbox !== undefined) ensureFlags.inbox = [inbox];
  const r = cmdRegister(id, ensureFlags, ctx);
  if (!r.ok) return r;
  return { ok: true, action: 'register-primary', id, workspaceId: id, worktree, descriptor: r.descriptor };
}

module.exports = {
  SELF_HEAL_COOLDOWN_MS, selfHealCooldownPath, selfHealCooldownElapsed, markSelfHealAttempt,
  defaultSpawnInstaller, selfHeal, withSelfHeal, precreateCursorAndInbox, cmdRegister,
  refreshAnchorSession, adoptPrimarySeat, cmdPrimary, cmdRegisterPrimary, registerPrimaryLocked,
};
