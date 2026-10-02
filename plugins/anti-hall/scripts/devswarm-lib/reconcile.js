'use strict';
// anti-hall :: devswarm CLI — RECONCILE module (scripts/devswarm-lib/reconcile.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  CLI_PATH, csvList, DEFAULT_IDLE_MS, descriptorPhysicalOwnerKey, devswarmRoot, fs,
  hasArchivedCounterpart, hasFlag, hasFreshHeartbeat, hcRun, inst, isSafeId, livenessPathFor,
  names, one, path, readDescriptors, readerCursors, repokey, repoKeyForCwd, spawnSync, store,
  worktreeActivityMtime,
} = require('./core.js');
const {
  floorCursor, logCursorWrite,
} = require('./cursors.js');
const {
  healRegistry,
} = require('./fold.js');
const {
  refreshNamesFromApp, rehomeStrandedProjectDescriptors,
} = require('./repair.js');
const {
  cmdArchive,
} = require('./archive.js');
const {
  LIST_CHILDREN_TIMEOUT_MS, parseChildrenList,
} = require('./roster-diag.js');
const repoUnknown = require('../../companion/lib/devswarm-repo-unknown.js');
const alog = require('../../companion/lib/anti-hall-log.js');

// defaultSpawnReconcile(d, ctx) -> spawnSync result. Spawns THIS SAME script
// (`__filename`, via `process.execPath` — an ABSOLUTE resolved binary path,
// NOT a bare command name) as a subprocess with `cwd: d.worktreePath`, running
// `inbox pull <d.id>` there. Verified-before-build: hooks/devswarm-child-gate.js's
// `shell: process.platform === 'win32'` precedent applies ONLY to a bare
// command name (`hivecontrol`) that depends on Windows PATHEXT shim
// resolution (a `.cmd`/`.bat` global-CLI shim); `process.execPath` is already
// the resolved node binary, so no shell is needed here — same posture as this
// file's own `defaultSpawnInstaller` a few hundred lines up, which spawns
// itself the identical way.
// WINDOWS BUG (CI run investigated for v0.66.1): `HOME` alone does NOT
// redirect a Node child's `os.homedir()` on win32 — Node reads `USERPROFILE`
// there (POSIX-only reads `$HOME`; see Node's os.homedir() docs). This
// subprocess's own `cmdInboxPull`/`pullOnce` call resolves ITS `home` via
// exactly that same `ctx.home || os.homedir()` fallback, so on Windows the
// spawned `inbox pull` silently ignored `ctx.home` and fell back to the
// REAL OS home directory instead — breaking the one guarantee this spawn
// exists to provide (the child observes the SAME devswarm root, including
// the SAME per-id pull lock, as the caller) whenever `ctx.home` differs from
// the live process's actual home. Same fix hooks/doctor.js's own child-env
// builder (CHILD_ENV/PRIMARY_ENV) already applies for the identical reason.
// Defect-2 fix (root cause, VERIFIED via isolated repro): when `d.worktreePath`
// does not exist on disk, `spawnSync(..., { cwd: d.worktreePath })`'s internal
// chdir failure is misreported by Node/libuv as an ENOENT against the SPAWNED
// EXECUTABLE (`process.execPath`) — not against the missing cwd — which reads
// exactly like "node itself is missing" even though node is perfectly present.
// Check existsSync(d.worktreePath) FIRST and short-circuit with a distinct,
// self-describing `worktreeMissing:true` result instead of ever letting that
// misleading spawn failure occur. Detect-only: never deletes/unlinks/moves
// anything — the descriptor and any archived/ counterpart are left untouched.
const RECONCILE_TIMEOUT_RETRY_BACKOFF_MS = 1500;

// isNativeTimeoutRun(r, parsed) -> bool. True ONLY for a clean native-timeout
// shape with no loss and no import: pullOnce's `nativeTimeout` marker, or the
// reconcile subprocess itself killed on its spawn timeout (ETIMEDOUT) with no
// parseable output. Anything that lost or imported is never a timeout skip.
function isNativeTimeoutRun(r, parsed) {
  if (parsed) {
    return parsed.ok === false && parsed.nativeTimeout === true && !parsed.lost && !parsed.imported;
  }
  return !!(r && r.error && r.error.code === 'ETIMEDOUT');
}

function defaultSpawnReconcile(d, ctx) {
  let worktreeExists = true;
  try { worktreeExists = fs.existsSync(d.worktreePath); } catch (_) { worktreeExists = true; }
  if (!worktreeExists) {
    return { worktreeMissing: true, error: new Error('worktree not found on disk: ' + d.worktreePath) };
  }
  const env = Object.assign({}, ctx.env || process.env, { HOME: ctx.home, USERPROFILE: ctx.home });
  if (ctx.backend) env.ANTIHALL_DEVSWARM_STORE_BACKEND = ctx.backend;
  // 0.108.4 ghost-row ROOT CAUSE: this drain runs with cwd = the TARGET's
  // worktree, so inside it callerIdentity() IS the target's meshId and
  // callerOwnsRow() passes — but the env was the INVOKER's (update.js /
  // doctor-repair run inside a Primary session carry its
  // CLAUDE_CODE_SESSION_ID and DEVSWARM_BUILDER_ID). maybePromoteUnclaimed then
  // stamped the Primary's live session onto a child's `primary-<hash>` label
  // (field: `unclaimed-session-promoted` primary-af7e82fd -> the downstream project
  // Primary's session, from a reconcile subprocess run by `update`). A sweep
  // drain speaks for no session: strip both identity vars and mark the process
  // so cmdInboxPull never promotes.
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DEVSWARM_BUILDER_ID;
  env.ANTIHALL_RECONCILE_SWEEP = '1';
  try {
    return spawnSync(process.execPath, [CLI_PATH, 'inbox', 'pull', d.id], {
      cwd: d.worktreePath, env, encoding: 'utf8', timeout: 30000,
    });
  } catch (e) {
    return { error: e };
  }
}

// reconcileResumePath(home) -> path to the additive, fail-open, overwritten-
// each-run resume marker (Wave D9). Single home-scoped file (not per-repoKey):
// reconcile is a manual/update-driven sweep, never concurrent with itself for
// the same project, and the marker's own `repoKey` field guards a later run
// for a DIFFERENT project from ever reusing a foreign deferred-id list.
function reconcileResumePath(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'reconcile-resume.json');
}

// readReconcileResume(home, repoKey) -> string[] deferred ids from the last
// run that hit its budget for THIS SAME repoKey, or [] on any absence/parse
// failure/repoKey mismatch (fail-open: a corrupt/foreign marker never blocks
// or crashes reconcile — it just means nothing is prioritized this run).
function readReconcileResume(home, repoKey) {
  try {
    const raw = fs.readFileSync(reconcileResumePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.repoKey === repoKey && Array.isArray(parsed.ids)) {
      return parsed.ids.filter((x) => typeof x === 'string');
    }
  } catch (_) { /* fail-open: no resume marker */ }
  return [];
}

// writeReconcileResume(home, repoKey, ids) -> void. Overwrites the marker with
// the current run's still-deferred ids (or removes it once nothing is left
// deferred, so a fully-drained sweep doesn't leave a stale marker around).
// Fail-open: a write failure never affects reconcile's own result.
function writeReconcileResume(home, repoKey, ids) {
  try {
    const p = reconcileResumePath(home);
    if (!ids || ids.length === 0) {
      try { fs.unlinkSync(p); } catch (_) { /* already absent — fine */ }
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ repoKey, ids, ts: Date.now() }));
  } catch (_) { /* fail-open: resume marker is best-effort */ }
}

// DEFAULT_RECONCILE_BUDGET_MS — Wave D9 root cause (defect f3c1bc827d89):
// cmdReconcile previously spawned one serial 30s-timeout child PER registry
// row with no total budget/cap, so a project with dozens of stale rows made
// `update.js` (which awaits reconcile synchronously, ~update.js:2160) hang for
// minutes with zero progress output. A total wall-clock budget bounds a single
// sweep's worst case; anything left over is deferred to the NEXT sweep via the
// resume marker above rather than ever blocking the caller indefinitely.
// env `ANTIHALL_RECONCILE_BUDGET_MS` overrides; 0 = unlimited (opt-out).
const DEFAULT_RECONCILE_BUDGET_MS = 60000;

// resolveReconcileClock(ctx) -> () => ms. An injectable clock for cmdReconcile's
// OWN wall-clock budget accounting only — deliberately a SEPARATE ctx field
// from `ctx.now` (used elsewhere in this file, e.g. names.writeName's
// timestamp arg a few hundred lines down in this same function, as a single
// STATIC snapshot number via `Number.isFinite(ctx.now) ? ctx.now : Date.now()`).
// That static-snapshot convention doesn't fit here: the budget loop below
// samples "now" repeatedly across an unbounded number of spawnFn calls, and a
// test double needs to advance a FAKE clock between those samples (so "a
// budget that allows exactly 2 children" is exact by construction, not a race
// against real elapsed wall-clock time on a contended CI runner). Naming this
// `ctx.reconcileNow` (a function) rather than reusing `ctx.now` (a number)
// avoids colliding with that other convention in the same ctx object. Default
// (no injection) is plain `Date.now`, so real behavior is unchanged.
function resolveReconcileClock(ctx) {
  return (ctx && typeof ctx.reconcileNow === 'function') ? ctx.reconcileNow : Date.now;
}

function resolveReconcileBudgetMs(flags, ctx) {
  // update.js (or any caller) may pass its own budget straight through via
  // ctx.reconcileBudgetMs — the cleanest carrier for a value that is never a
  // user-typed CLI flag on THAT call site (update.js invokes `devswarm.run(['reconcile'], ctx)`
  // directly, not via a shell argv). The CLI's own `--budget-ms` flag is for a
  // human/script invoking `devswarm.js reconcile` directly.
  const candidates = [
    ctx && ctx.reconcileBudgetMs,
    one(flags, 'budget-ms'),
    ctx && ctx.env && ctx.env.ANTIHALL_RECONCILE_BUDGET_MS,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_RECONCILE_BUDGET_MS;
}

// reconcileRowArchived(home, d, ctx) -> bool. True iff this registry row is
// archived per THE canonical row projection (row-eligibility.js), which
// itself ORs the DevSwarm app DB verdict (builders.isActive=0/isHidden=1)
// with anti-hall's own worktree/session-discriminated archived/<id>.json
// marker (row-state.js -> isArchivedWorkspace). No bare hasArchivedCounterpart
// fallback here: a bare marker existsSync check ignores worktreePath and
// sessionId, so it would re-admit the documented id-reuse false positive
// (a live workspace that reuses an archived id's id) as "archived" and skip
// it. hasArchivedCounterpart stays available for report-only fields
// (archivedDuplicate) elsewhere — never for this skip decision.
// Never throws (fails closed to "not archived" on any error), so an
// unreadable app DB never spuriously reports a live row as archived.
function reconcileRowArchived(home, d, ctx) {
  // THE one row projection (row-eligibility.js): app DB verdict when it has
  // one, else anti-hall's own discriminated marker. No repoKey is passed, so
  // the looser active-list-absence rule never marks a live row archived here.
  let archived = false;
  try {
    archived = require('../../companion/lib/row-eligibility.js').rowEligibility(
      { id: d.id, worktreePath: d.worktreePath || null, sessionId: d.sessionId || null },
      { home, env: ctx.env, now: ctx.now },
    ).archived === true;
  } catch (_) { archived = false; }
  return archived;
}

// cmdReconcile(flags, ctx) — PLAN.md "reconcile": drain EVERY worktree
// registered in THIS project's shared store once. Each `inbox pull` MUST run
// with that worktree as its OWN process cwd (never in-process) — inbox pull's
// native spawns (devswarm-pull.js -> hivecontrol) resolve their target
// workspace from the CALLING process's cwd, so an in-process call from the
// reconciler's own cwd would silently drain the WRONG (the caller's own)
// queue for every descriptor instead of each worktree's own. A per-id O_EXCL
// pull lock (already shipped in devswarm-pull.js's acquireExclLock) serializes
// a reconcile sweep against a live child concurrently pulling its own inbox —
// surfaced here as `locked:true` on that descriptor's result, never silently
// dropped from the count.
//
// Wave D9 additions (budget + resume, root-caused via defect f3c1bc827d89):
// a total wall-clock budget bounds how long one sweep can spend spawning
// per-row children; whatever is left when the budget runs out is deferred to
// `reconcile-resume.json` and prioritized FIRST on the next run (rotation).
// A row whose worktreePath no longer exists on disk is skipped BEFORE it ever
// reaches spawnFn (not just inside defaultSpawnReconcile's own existsSync
// check) so it costs zero budget — but ONLY when spawnFn is the real
// defaultSpawnReconcile: an injected `ctx.io.spawnReconcile` test double is a
// real spawn stand-in and is deliberately never subject to this fs check
// (same posture defaultSpawnReconcile's own doc comment already documents).
function cmdReconcile(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };

  // GH1: re-home any hash-bucket-stranded child of THIS project into store/<repoKey>/
  // BEFORE the listRegistry sweep — otherwise a stranded child is invisible to
  // listRegistry, its `inbox pull` is never spawned, and its backlog never drains.
  try { rehomeStrandedProjectDescriptors(home, ctx); } catch (_) { /* fail-open: reconcile proceeds */ }

  // Claim 3 self-heal pre-pass: heal a row whose descriptor's own real
  // worktreePath disagrees with the store it is physically sitting in
  // (healRegistry/rehomeMiskeyedRow) BEFORE listing targets — a correctly-
  // owned row with stale persisted ownerKey/repoKey metadata is corrected in
  // place (still targeted, correctly, by THIS sweep); a genuinely mis-keyed
  // row is rehomed OUT into its real store and correctly excluded from this
  // project's targets (it will be reconciled by ITS OWN project instead).
  // Fail-open: a heal-pass hiccup must never abort reconcile itself.
  let healed = null;
  try { healed = healRegistry(home, repoKey, ctx); } catch (_) { healed = null; }

  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let descriptors;
  try { descriptors = s.listRegistry(); } finally { s.close(); }

  let targets = descriptors.filter((d) => d && d.worktreePath && isSafeId(d.id));

  // Resume rotation: prioritize ids deferred by a PRIOR budget-exhausted run
  // (for this same repoKey) so a persistently-large backlog eventually drains
  // in FIFO order across runs rather than the same early rows starving the
  // tail forever. Fail-open (readReconcileResume already tolerates absence).
  const resumeIds = readReconcileResume(home, repoKey);
  if (resumeIds.length > 0) {
    const byId = new Map(targets.map((d) => [d.id, d]));
    const prioritized = [];
    for (const id of resumeIds) {
      const d = byId.get(id);
      if (d) { prioritized.push(d); byId.delete(id); }
    }
    targets = prioritized.concat(Array.from(byId.values()));
  }

  const spawnFn = (ctx.io && ctx.io.spawnReconcile) || defaultSpawnReconcile;
  const usingDefaultSpawn = spawnFn === defaultSpawnReconcile;
  const budgetMs = resolveReconcileBudgetMs(flags, ctx);
  const clockNow = resolveReconcileClock(ctx);
  const startedAt = clockNow();
  let skippedMissingWorktree = 0;
  let skippedNotGitRoot = 0;
  let processed = 0;
  const deferredIds = [];
  const results = [];
  // "Repository not found" (hivecontrol no longer knows this worktree's repo) is
  // terminal for THAT ROW (per-row scope: a sibling worktree hivecontrol still
  // knows is never suppressed): see companion/lib/devswarm-repo-unknown.js.
  // While the row's marker is live its native pull is not spawned.
  const sweepNow = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const repoUnknownScope = (d) => 'pull:' + d.id;
  let repoUnknownSkipped = 0;
  const pushRepoUnknownSkip = (d) => {
    repoUnknownSkipped++;
    results.push({
      id: d.id, worktreePath: d.worktreePath, ok: true, imported: 0, duplicate: 0,
      nativeCount: 0, lost: 0, locked: false, hivecontrolMissing: false,
      worktreeMissing: false, repoUnknown: true,
      archivedDuplicate: false,
      skipped: true,
      skipReason: 'repository not known to hivecontrol (terminal; rechecked periodically)',
      error: null,
    });
  };
  for (const d of targets) {
    // Pre-spawn missing-worktree skip (defaultSpawnReconcile only — see doc
    // comment above): costs zero budget, unlike letting spawnFn discover it
    // via its own internal existsSync check after a budget slot is already
    // spent deciding to spawn.
    let spawnTarget = d;
    if (usingDefaultSpawn) {
      let exists = true;
      try { exists = fs.existsSync(d.worktreePath); } catch (_) { exists = true; }
      if (!exists) {
        skippedMissingWorktree++;
        // deliberate: under-detect only (a report field), never a removal decision — bare marker check is fine here.
        const archivedCounterpart = hasArchivedCounterpart(home, d.id);
        // A row missing on disk AND archived (app-DB ground truth, or the
        // local marker) is not a reconcile FAILURE — it is the expected end
        // state of an archived workspace whose worktree was later pruned.
        // Classify it as skipped with a reason instead of a bare failure so
        // a normal archive+prune cycle stops reading as reconcile noise
        // (report: a DevSwarm Primary saw 9 of these as "worktree not found on
        // disk" failures on an entirely healthy sweep). A LIVE row whose
        // worktree vanished stays a genuine failure below, unchanged.
        const archived = archivedCounterpart || reconcileRowArchived(home, d, ctx);
        // An archived+pruned row is a terminal, expected state: skipped, so NOT
        // ok:false and carrying no error (skipReason says why). A LIVE row whose
        // worktree vanished stays ok:false with the real error.
        results.push({
          id: d.id, worktreePath: d.worktreePath, ok: archived, imported: 0, duplicate: 0,
          nativeCount: 0, lost: 0, locked: false, hivecontrolMissing: false,
          worktreeMissing: true,
          archivedDuplicate: archivedCounterpart,
          skipped: archived,
          skipReason: archived ? 'archived workspace, worktree pruned from disk' : null,
          error: archived ? null : 'worktree not found on disk: ' + d.worktreePath,
        });
        continue;
      }
      // ARCHIVED-BUT-STILL-ON-DISK SKIP (a DevSwarm Primary report, 0.115.2):
      // a workspace archived in the DevSwarm app (or already carrying
      // anti-hall's own archived/<id>.json marker) whose worktree has not
      // yet been pruned still reached `inbox pull` here — which hits
      // cmdRegister's APP-DB ARCHIVE GUARD and refuses the ensure with
      // `{ok:false, reason:...}` (no `.error` field), surfacing as an
      // unexplained "unknown error" per-target failure. Skip it BEFORE the
      // git-root probe / spawn — an archived workspace's queue is not this
      // sweep's job to drain, and refusing it noiselessly costs zero budget.
      if (reconcileRowArchived(home, d, ctx)) {
        results.push({
          id: d.id, worktreePath: d.worktreePath, ok: true, imported: 0, duplicate: 0,
          nativeCount: 0, lost: 0, locked: false, hivecontrolMissing: false,
          worktreeMissing: false,
          archivedDuplicate: hasArchivedCounterpart(home, d.id),
          skipped: true,
          skipReason: 'archived workspace (DevSwarm app or local marker)',
          error: null,
        });
        continue;
      }
      // GIT-ROOT CHECK (D11-C, defect 6ef55fd42cc9): a worktree path can exist
      // on disk (the existsSync check above passes) yet not be a usable git
      // root — a submodule worktree whose gitdir link has gone stale, or any
      // other directory whose git metadata moved/broke since registration.
      // Spawning `inbox pull` with THAT cwd reaches hivecontrol, which fails
      // "Repository not found. Make sure to pass the git root path." — a
      // reconcile-sweep hang the caller (update.js) has no budget defense
      // against, since the failure happens INSIDE the spawned child, not in
      // this pre-spawn check. Require git itself to resolve a real toplevel
      // from this path BEFORE spawning, and spawn with THAT resolved root
      // (never the raw registry path) — reuses devswarm-repokey.js's own
      // bounded, injectable git spawn (`defaultRun`, the SAME
      // ANTIHALL_REPOKEY_GIT_TIMEOUT_MS-bounded primitive gitCommonDir already
      // uses) rather than a second implementation.
      //
      if (repoUnknown.isSuppressed(home, repoKey, repoUnknownScope(d), sweepNow)) { pushRepoUnknownSkip(d); continue; }
      // BUDGET-BEFORE-PROBE (D11-C2, root cause for reconcile escaping its own
      // budget): this probe is a real child-process spawn bounded only by
      // ANTIHALL_REPOKEY_GIT_TIMEOUT_MS (up to ~10s per broken worktree), NOT
      // by reconcileBudgetMs — the budget check below (right before spawnFn)
      // ran AFTER this probe unconditionally executed for every remaining
      // target, so N broken worktrees each burned up to their full probe
      // timeout with none of that wall time counted as "budget spent" until
      // the very end: a sweep with enough broken rows could blow well past
      // budgetMs before the FIRST deferral ever triggered. Check the budget
      // HERE, before paying for the probe, so a probe never runs once the
      // deadline has already passed; the existing check after the probe (a
      // few lines down) still catches the case where THIS row's own probe was
      // what pushed elapsed time over budgetMs.
      if (budgetMs > 0 && (clockNow() - startedAt) >= budgetMs) {
        deferredIds.push(d.id);
        continue;
      }
      let gitRoot = null;
      try {
        const gr = repokey.defaultRun({ args: ['-C', d.worktreePath, 'rev-parse', '--show-toplevel'], cwd: d.worktreePath });
        if (gr && gr.ok) {
          const raw = String(gr.raw || '').trim();
          if (raw) gitRoot = raw;
        }
      } catch (_) { gitRoot = null; }
      if (!gitRoot) {
        skippedNotGitRoot++;
        results.push({
          id: d.id, worktreePath: d.worktreePath, ok: false, imported: 0, duplicate: 0,
          nativeCount: 0, lost: 0, locked: false, hivecontrolMissing: false,
          worktreeMissing: false, notGitRoot: true,
          // deliberate: under-detect only (a report field), never a removal decision — bare marker check is fine here.
          archivedDuplicate: hasArchivedCounterpart(home, d.id),
          skipped: false, skipReason: null,
          error: 'worktree is not a resolvable git root (git rev-parse --show-toplevel failed): ' + d.worktreePath,
        });
        continue;
      }
      if (gitRoot !== d.worktreePath) spawnTarget = Object.assign({}, d, { worktreePath: gitRoot });
    }
    if (!usingDefaultSpawn && repoUnknown.isSuppressed(home, repoKey, repoUnknownScope(d), sweepNow)) { pushRepoUnknownSkip(d); continue; }
    // Budget check: only once we're about to actually spawn a child. A budget
    // of 0 means unlimited (never defers).
    if (budgetMs > 0 && (clockNow() - startedAt) >= budgetMs) {
      deferredIds.push(d.id);
      continue;
    }
    processed++;
    let r = spawnFn(spawnTarget, ctx);
    let parsed = null;
    const parseRun = () => {
      parsed = null;
      if (r && !r.error && typeof r.stdout === 'string') {
        try { parsed = JSON.parse(r.stdout); } catch (_) { parsed = null; }
      }
    };
    parseRun();
    // ONE retry with a short backoff when the native app timed out (update/
    // reconcile path only — the hook paths never go through here). Only while
    // the sweep budget still has room; a retry of a pure count-gate timeout is
    // safe (nothing was read yet).
    if (isNativeTimeoutRun(r, parsed) && !(budgetMs > 0 && (clockNow() - startedAt) >= budgetMs)) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number.isFinite(ctx.nativeTimeoutRetryBackoffMs) ? ctx.nativeTimeoutRetryBackoffMs : RECONCILE_TIMEOUT_RETRY_BACKOFF_MS); } catch (_) { /* best-effort backoff */ }
      r = spawnFn(spawnTarget, ctx);
      parseRun();
    }
    const nativeTimeout = isNativeTimeoutRun(r, parsed);
    if (parsed && parsed.ok) repoUnknown.clear(home, repoKey, repoUnknownScope(d));
    if (!(parsed && parsed.ok) && repoUnknown.isRepoUnknownText(parsed && parsed.error, parsed && parsed.reason, r && r.stderr)) {
      const rec = repoUnknown.record(home, repoKey, repoUnknownScope(d), (parsed && (parsed.error || parsed.reason)) || (r && r.stderr), sweepNow);
      if (rec.first) {
        alog.logEvent('devswarm-reconcile', 'repo-unknown', 'info',
          'hivecontrol does not know this worktree\'s repository (terminal for the row) — recorded once, its native pull suppressed until a periodic recheck',
          { repoKey, id: d.id, worktreePath: d.worktreePath });
      }
      pushRepoUnknownSkip(d);
      continue;
    }
    results.push({
      id: d.id,
      worktreePath: d.worktreePath,
      ok: !!(parsed && parsed.ok),
      imported: (parsed && parsed.imported) || 0,
      duplicate: (parsed && parsed.duplicate) || 0,
      nativeCount: (parsed && parsed.nativeCount) || 0,
      // P1 fix: pullOnce's loss check (devswarm-pull.js ~line 299) reports a
      // REAL shortfall (native message-count > what actually landed durably)
      // via `lost`. Previously dropped here entirely, so a lossy child pull
      // (e.g. `{ok:false, locked:true, nativeCount:2, lost:2}`) vanished
      // without a trace and the aggregate below still reported `ok:true`.
      // Distinct from `locked` (benign contention skip, never a loss).
      lost: (parsed && parsed.lost) || 0,
      // P1 fix: pullOnce's own contract (devswarm-pull.js) uses `locked===false`
      // to mean "another consumer holds the lock" (same polarity as migrate-
      // state.js's `ds.locked===false` convention) — a blind pass-through of
      // `parsed.locked` was TRUE for an ordinary successful/failed-after-acquire
      // pull and FALSE only on genuine contention: the opposite of what a reader
      // of a per-target reconcile result expects from a field named `locked`.
      // Recompute with the intuitive polarity: true ONLY on the exact
      // genuine-contention shape pullOnce/`inbox pull` emits.
      locked: !!(parsed && parsed.ok === false && parsed.locked === false
        && /holds the lock/i.test(String(parsed.error || ''))),
      // v0.66 P0-2 fix: `hivecontrol` (the native DevSwarm.app CLI) is an
      // OPTIONAL runtime dependency — CI runners (ubuntu/macos/windows) never
      // have it on PATH, so pullOnce's very first native call (message-count,
      // devswarm-pull.js ~line 224) fails with the exact, stable Node spawn
      // shape `spawnSync hivecontrol ENOENT` (or EACCES/ENOTDIR for a broken
      // install) surfaced verbatim as `parsed.error`. That is an ENVIRONMENT
      // fact, not a reconcile defect — same benign-skip posture as `locked`
      // (lock contention): known, recognized, and MUST NOT fail the sweep.
      // A different failure at any OTHER hivecontrol call site, or any error
      // string that doesn't match this exact spawn-failure shape, still fails
      // `ok` normally (deny-list polarity preserved).
      hivecontrolMissing: !!(parsed && parsed.ok === false
        && /^spawnSync\s+\S*hivecontrol\S*\s+(ENOENT|EACCES|ENOTDIR)\b/i.test(String(parsed.error || ''))),
      // Defect-2 fix (root cause): when `d.worktreePath` does not exist on
      // disk, spawnSync's `cwd` chdir failure is misreported by Node/libuv as
      // an ENOENT against the SPAWNED EXECUTABLE (process.execPath) — not
      // against the cwd — which reads exactly like "node is missing" even
      // though node is fine (reproduced in isolation). defaultSpawnReconcile
      // now checks existsSync(d.worktreePath) itself, BEFORE spawning, and
      // sets `worktreeMissing:true` on its return value when the worktree is
      // gone — that is what this reads. A fourth RECOGNIZED BENIGN SKIP, same
      // posture as `locked`/`hivecontrolMissing`. Detect-only: nothing is
      // deleted/unlinked/moved. Deliberately gated to `spawnFn === defaultSpawnReconcile`'s
      // own contract (injected `ctx.io.spawnReconcile` test doubles are real
      // spawn stand-ins and are never subject to this fs check).
      worktreeMissing: !!(r && r.worktreeMissing),
      // SEVENTH recognized benign skip: the native app timed out on the
      // non-destructive message-count gate (after one retry) and nothing was
      // imported or lost — reported as `skipped (native unavailable: timeout)`,
      // never `failed`. Set from pullOnce's own `nativeTimeout` marker or the
      // subprocess' own ETIMEDOUT kill, never from a loss shape.
      nativeTimeout,
      // deliberate: under-detect only (a report field), never a removal decision — bare marker check is fine here.
      archivedDuplicate: !!(r && r.worktreeMissing && hasArchivedCounterpart(home, d.id)),
      skipped: false,
      skipReason: null,
      // "unknown error" root cause (a DevSwarm Primary report, 0.115.2): a
      // subprocess that returns a recognized non-ok shape with no `.error`
      // field (e.g. cmdRegister's APP-DB ARCHIVE GUARD refusing an ensure
      // with `{ok:false, reason:'...'}`, no `.error`) fell all the way
      // through to the generic "could not parse" fallback even though
      // `parsed` was a real, parsed object — discarding the actual cause.
      // Also surface the hivecontrol exit code/signal/stderr when the
      // subprocess produced no parseable JSON at all, instead of a bare
      // "could not parse" with no diagnostic detail.
      error: (parsed && parsed.error)
        || (parsed && parsed.reason)
        || (r && r.error ? String((r.error && r.error.message) || r.error) : null)
        || (r && !parsed && (r.status != null || r.signal || (r.stderr && String(r.stderr).trim()))
          ? 'inbox-pull subprocess exited'
            + (r.status != null ? ' with code ' + r.status : '')
            + (r.signal ? ' (signal ' + r.signal + ')' : '')
            + (r.stderr && String(r.stderr).trim() ? ': ' + String(r.stderr).trim() : '')
          : null)
        || (parsed ? null : 'reconcile: could not parse inbox-pull subprocess output'),
    });
  }
  const imported = results.reduce((acc, r) => acc + (r.imported || 0), 0);
  const lost = results.reduce((acc, r) => acc + (r.lost || 0), 0);
  // rejected: surfaced for VISIBILITY only (a targeted regex over the
  // subprocess's own error string) — NOT the basis for `ok` below anymore
  // (A4, 3rd recurrence at this site): an allow-listed regex necessarily
  // misses every OTHER failure shape (a spawn crash, a timeout, an ENOENT
  // vanished-worktree cwd, unparseable stdout) — each of THOSE left `parsed`
  // null, `r.ok` false, yet neither `lost` nor this regex counted them, so
  // `lost===0 && rejected===0` could read an all-targets-failed sweep as a
  // healthy `imported:0`.
  const rejected = results.filter((r) => !r.ok && /does not belong to the current project/.test(String(r.error || ''))).length;
  // A4 FIX: aggregate `ok` is a DENY-list of benignity, not an allow-list of
  // known failure shapes — every row must be genuinely `ok:true`, OR match
  // ONE of the two recognized benign skips this file already computes with
  // intuitive polarity (`locked:true` — genuine pull-lock contention, never a
  // loss; `hivecontrolMissing:true` — v0.66 P0-2, the optional native binary
  // is absent from this environment, e.g. every CI runner). Any other
  // false-`ok` row (rejection, lossy pull, crash, timeout, a DIFFERENT ENOENT
  // not matching the exact hivecontrol-spawn shape, unparseable stdout —
  // anything at all) fails the aggregate. Never add a third allow-listed
  // failure regex here.
  // Defect-2 fix: `worktreeMissing:true` is a FOURTH recognized benign skip —
  // set only by the pre-spawn existsSync check above, never by parsing an
  // error string, so it cannot be spoofed by a subprocess's stdout the way an
  // allow-listed regex could be.
  // notGitRoot:true (D11-C) is a FIFTH recognized benign skip — same posture
  // as worktreeMissing: set only by the pre-spawn git-root check above, never
  // by parsing a subprocess error string, so it cannot be spoofed and never
  // fails the aggregate the way a genuine spawn/parse failure does.
  // skipped:true (0.115.2 fix) is a SIXTH recognized benign skip — an
  // archived-workspace row deliberately never spawned (app-DB or local
  // marker, set only by the pre-spawn archived checks above, never by
  // parsing a subprocess error string) is not a reconcile failure.
  const allRowsOkOrBenign = results.every((r) => r.ok === true || r.locked === true || r.hivecontrolMissing === true || r.worktreeMissing === true || r.notGitRoot === true || r.skipped === true || r.nativeTimeout === true);
  const skipped = results.filter((r) => r.skipped === true).length;
  const nativeTimeouts = results.filter((r) => r.nativeTimeout === true).length;

  // Task #6 name backfill (off the hot path — reconcile is a gated/manual
  // sweep, NEVER the every-turn hook, so a `hivecontrol` spawn here is fine).
  // ONE batch `workspace list all` call resolves every target's CURRENT label
  // in one spawn (not N per-id spawns) — this is the GENERAL backfill path:
  // it catches a pre-existing workspace with no name at all, AND a workspace
  // whose label ended up as hivecontrol's own branch-name default (cmdSpawn's
  // -t injection only covers the two cases where a title was known at spawn
  // time). Best-effort: hivecontrol missing/erroring/unparseable -> no
  // backfill this sweep, NEVER fails reconcile itself (same fail-open posture
  // as `healed` above).
  let namesBackfilled = 0;
  // v0.108.0: the DevSwarm app DB's builders.label IS the UI title — refresh the
  // cache whenever it DIFFERS (renames used to never propagate), with no spawn.
  // Only ids the app has no label for fall through to the hivecontrol backfill.
  let namesRefreshed = 0;
  try { namesRefreshed = refreshNamesFromApp(home, ctx.env, targets, ctx.now).refreshed; } catch (_) { namesRefreshed = 0; }
  try {
    const missingNames = targets.filter((d) => !names.readName(home, d.id));
    if (missingNames.length > 0) {
      const listRun = (ctx.io && ctx.io.run) || hcRun;
      const lr = listRun({ args: ['workspace', 'list', 'all'], env: ctx.env, cwd, timeout: LIST_CHILDREN_TIMEOUT_MS });
      if (lr && lr.ok) {
        const all = parseChildrenList(lr.raw); // reuses the SAME tolerant parse + label field
        const labelById = new Map(all.filter((e) => e.id).map((e) => [e.id, e.label]));
        for (const d of missingNames) {
          const label = labelById.get(d.id);
          if (label && names.writeName(home, d.id, label, ctx.now)) namesBackfilled++;
        }
      }
    }
  } catch (_) { /* fail-open: reconcile proceeds without name backfill */ }

  // Wave D9: persist whatever is still deferred so the NEXT sweep (for this
  // same repoKey) prioritizes it first (rotation) — writeReconcileResume
  // itself removes the marker entirely when deferredIds is empty, so a fully-
  // drained sweep never leaves a stale file behind.
  writeReconcileResume(home, repoKey, deferredIds);

  const out = {
    ok: allRowsOkOrBenign, action: 'reconcile', repoKey,
    count: results.length, imported, lost, rejected, results,
    budgetMs, processed, skippedMissingWorktree, skippedNotGitRoot, deferred: deferredIds.length,
    repoUnknown: repoUnknownSkipped,
    namesRefreshed,
    elapsedMs: clockNow() - startedAt,
  };
  if (nativeTimeouts) out.nativeTimeouts = nativeTimeouts;
  if (healed) out.healed = healed;
  if (namesBackfilled) out.namesBackfilled = namesBackfilled;
  return out;
}

// readPersistedVerdictStatus(id, home) -> status string | null. READ-ONLY reuse
// of the supervisor's already-written per-workspace verdict file (the SAME
// livenessPathFor/JSON shape computeLiveness reads). No git, no computeLiveness,
// no store DB open. null when absent/unreadable/unsafe id (fail-safe: no verdict
// = not a reap candidate on the liveness axis).
function readPersistedVerdictStatus(id, home) {
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    return v && typeof v.status === 'string' ? v.status : null;
  } catch (_) { return null; }
}

// hasRecentWorktreeActivity(worktreePath, now, idleMs) -> bool. A SAFETY guard for
// the reaper: true iff the worktree still exists on disk AND has a git commit
// within idleMs. worktreeActivityMtime returns the last git-commit ts (or null
// when there is no reliable git signal), so a live-but-recently-committed worktree
// is never reaped even if a stale verdict lingers from before that activity.
function hasRecentWorktreeActivity(worktreePath, now, idleMs) {
  if (!worktreePath) return false;
  let exists = false;
  try { exists = fs.existsSync(worktreePath); } catch (_) { exists = false; }
  if (!exists) return false;
  const wMtime = worktreeActivityMtime(worktreePath);
  return wMtime !== null && (now - wMtime) <= idleMs;
}

// projectScopedDescriptors(home, repoKey) -> [descriptor] belonging to THIS
// project (physical ownerKey === repoKey), path-safe id + worktreePath present.
// Shared by cmdReapStale and cmdReconcileActive so both scope IDENTICALLY to how
// cmdRoster/cmdArchive scope (descriptorPhysicalOwnerKey === repoKey).
function projectScopedDescriptors(home, repoKey) {
  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }
  return descriptors.filter((d) =>
    d && isSafeId(d.id) && d.worktreePath && descriptorPhysicalOwnerKey(d) === repoKey);
}

// cmdReapStale(flags, ctx) — parent-driven reaper. Archives THIS project's
// workspaces whose persisted liveness verdict is stale/escalated AND which have
// NO fresh heartbeat (definitive proof-of-life) AND no live-worktree+recent-git
// activity. CONFIRM-FIRST (destructive-ish state change): dry-run/preview by
// default (lists what WOULD be archived); requires an explicit --yes / --confirm
// to actually archive. Reuses the proven cmdArchive move+tombstone path per id
// (which re-validates ownership on apply). Project-scoped; requires a git cwd.
function cmdReapStale(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const idleMs = Number.isFinite(ctx.idleThresholdMs) ? ctx.idleThresholdMs : DEFAULT_IDLE_MS;
  const confirm = hasFlag(flags, 'yes') || hasFlag(flags, 'confirm');

  const candidates = [];
  const skipped = [];
  for (const d of projectScopedDescriptors(home, repoKey)) {
    const status = readPersistedVerdictStatus(d.id, home);
    const stale = status === 'stale' || status === 'escalated';
    if (!stale) continue;
    // SAFETY 1: a fresh heartbeat is definitive proof the env is ALIVE — NEVER reap.
    if (hasFreshHeartbeat(d.id, home, { now })) { skipped.push({ id: d.id, reason: 'fresh-heartbeat' }); continue; }
    // SAFETY 2: a live worktree with recent git activity is not abandoned — NEVER reap.
    if (hasRecentWorktreeActivity(d.worktreePath, now, idleMs)) { skipped.push({ id: d.id, reason: 'recent-activity' }); continue; }
    candidates.push({ id: d.id, status, worktreePath: d.worktreePath });
  }

  if (!confirm) {
    return {
      ok: true, action: 'reap-stale', repoKey, dryRun: true,
      count: candidates.length, candidates, skipped,
      note: 'dry-run: pass --yes (or --confirm) to archive these workspaces',
    };
  }
  const archived = [];
  for (const c of candidates) {
    // P1-5: cmdArchive re-validates the safety condition INSIDE its per-id lock,
    // immediately before the archive — so a workspace that heartbeats or commits
    // between candidate collection and here is SKIPPED, not wrong-archived.
    const r = cmdArchive(c.id, ctx, {
      revalidate: (desc) => {
        const nowR = Number.isFinite(ctx.now) ? ctx.now : Date.now();
        const statusR = readPersistedVerdictStatus(c.id, home);
        if (statusR !== 'stale' && statusR !== 'escalated') return 'became-live';
        if (hasFreshHeartbeat(c.id, home, { now: nowR })) return 'fresh-heartbeat';
        if (hasRecentWorktreeActivity(c.worktreePath, nowR, idleMs)) return 'recent-activity';
        // P1-6: re-check structural ownership so a re-keyed/cross-project
        // descriptor is never archived out from under its real project.
        if (desc && descriptorPhysicalOwnerKey(desc) !== repoKey) return 'ownership-changed';
        return null;
      },
    });
    if (r && r.skipped) { skipped.push({ id: c.id, reason: r.reason }); continue; }
    archived.push({ id: c.id, ok: !!r.ok, error: r.error || null });
  }
  return {
    ok: archived.every((a) => a.ok), action: 'reap-stale', repoKey, dryRun: false,
    count: archived.length, archived, skipped,
  };
}

// cmdReconcileActive(flags, ctx) — reconcile the live roster against an explicit
// ACTIVE set. Archives a CURRENT (non-archived) workspace of THIS project NOT in
// the supplied --active id set ONLY when the DevSwarm app's database proves it
// archived (v0.107.1; absence alone never archives). Ids match by FULL id OR a short prefix (how the
// roster displays them) — matching is generous on purpose (a match SPARES a
// workspace, the safe direction: an active workspace is NEVER archived). Refuses
// an EMPTY active set unless --allow-empty (an omitted set must not archive every
// workspace by accident). CONFIRM-FIRST: dry-run by default, --yes/--confirm to
// apply. Reuses cmdArchive per id. Project-scoped; requires a git cwd.
function cmdReconcileActive(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const confirm = hasFlag(flags, 'yes') || hasFlag(flags, 'confirm');

  const activeTokens = csvList(flags, 'active');
  // Optional stdin ids (opt-in only, never auto-read — a blocking fd 0 read on a
  // tty must never wedge the CLI): `--stdin` reads newline/space/comma-separated
  // ids from fd 0. ctx.io.stdin (a string) is the test-injection seam.
  if (hasFlag(flags, 'stdin') || (ctx.io && typeof ctx.io.stdin === 'string')) {
    let raw = '';
    if (ctx.io && typeof ctx.io.stdin === 'string') raw = ctx.io.stdin;
    else { try { raw = String(fs.readFileSync(0, 'utf8')); } catch (_) { raw = ''; } }
    for (const tok of raw.split(/[\s,]+/)) { const t = tok.trim(); if (t && !activeTokens.includes(t)) activeTokens.push(t); }
  }
  if (activeTokens.length === 0 && !hasFlag(flags, 'allow-empty')) {
    return {
      ok: false, action: 'reconcile-active', repoKey,
      error: 'reconcile-active requires a non-empty --active <id,...> set (pass --allow-empty to archive ALL current workspaces)',
    };
  }

  const activeMatches = (id) => {
    for (const t of activeTokens) {
      if (!t) continue;
      if (id === t) return true;
      if (t.length >= 4 && id.startsWith(t)) return true; // short prefix (roster/8-hex spelling)
      if (t.length >= 8 && id.includes(t)) return true;    // 8-hex embedded in primary-<hex>
    }
    return false;
  };

  // v0.107.1 SAFETY: absence from --active is NOT evidence of archive (a
  // scrolled or partial roster list would archive live workspaces). A candidate
  // is archived ONLY when the DevSwarm app's own database proves it archived
  // (builders.isActive = 0 AND isHidden = 1 — companion/lib/devswarm-app-db.js).
  // Absent-but-not-proven rows are KEPT and listed; an unreadable app DB
  // archives nothing and says why.
  const appDbLib = require('../../companion/lib/devswarm-app-db.js');
  const appDbReadable = !!appDbLib.builderStates({ home, env: ctx.env, now: ctx.now });
  const candidates = [];
  const kept = [];
  const keptNotArchivedInApp = [];
  for (const d of projectScopedDescriptors(home, repoKey)) {
    if (activeMatches(d.id)) { kept.push(d.id); continue; }
    const verdict = appDbReadable
      ? appDbLib.appArchivedVerdict({ home, env: ctx.env, now: ctx.now, id: d.id, worktreePath: d.worktreePath || null })
      : null;
    if (verdict === true) { candidates.push({ id: d.id, worktreePath: d.worktreePath }); continue; }
    kept.push(d.id);
    keptNotArchivedInApp.push({ id: d.id, reason: !appDbReadable ? 'app-db-unreadable' : (verdict === false ? 'app-active' : 'app-unknown') });
  }
  const appDbNote = appDbReadable ? null
    : 'DevSwarm app database unreadable (set ANTIHALL_DEVSWARM_APP_DB to its devswarm.db) — nothing is archived without app proof';

  if (!confirm) {
    return {
      ok: appDbReadable || keptNotArchivedInApp.length === 0, action: 'reconcile-active', repoKey, dryRun: true,
      active: activeTokens, kept, keptNotArchivedInApp, appDb: appDbReadable,
      count: candidates.length, candidates,
      note: appDbNote || 'dry-run: pass --yes (or --confirm) to archive these workspaces (only app-archived ones are candidates)',
    };
  }
  if (!appDbReadable && keptNotArchivedInApp.length) {
    return {
      ok: false, action: 'reconcile-active', repoKey, dryRun: false, reason: 'app-db-unreadable', error: appDbNote,
      active: activeTokens, kept, keptNotArchivedInApp, appDb: false, count: 0, archived: [],
    };
  }
  const archived = [];
  for (const c of candidates) {
    const r = cmdArchive(c.id, ctx);
    archived.push({ id: c.id, ok: !!r.ok, error: r.error || null });
  }
  return {
    ok: archived.every((a) => a.ok), action: 'reconcile-active', repoKey, dryRun: false,
    active: activeTokens, kept, keptNotArchivedInApp, appDb: appDbReadable, count: archived.length, archived,
  };
}

// ===== reap-orphans (defect b712da3bf077, P1) ==============================
// reapedDir(home) — where a reap's loss-free archive of a partition's unread
// rows lands, one NDJSON file per partition.
function reapedDir(home) { return path.join(devswarmRoot(home), 'reaped'); }

// collectOrphanCandidates(ctx) -> { ok, candidates[], repoKey } — the mesh
// partitions with unread mail and NO live reader.
//
// REUSES the EXISTING detector rather than re-deriving it: this is exactly the
// set devswarm-store.js's computeSummary A2 pass publishes as `summary.orphans`
// (`listWorkspaceIds() − registry ids − broadcast`, filtered to real unread,
// minus the archived-stranded and forwarded-drained classes), and it is the
// SAME array hooks/devswarm-parent-inbox.js renders as the per-turn "⚠ DEVSWARM
// ORPHANED MESH: N partition(s) with unread but no live workspace to read them"
// warning. Reaping something the warning does not report — or failing to reap
// something it does — is the drift this reuse exists to make impossible.
// computeSummary is the PURE half (zero writes), which is what a dry-run-first
// verb must call.
function collectOrphanCandidates(ctx) {
  const home = ctx.home;
  const repoKey = repoKeyForCwd(ctx);
  if (!repoKey) return { ok: false, reason: 'no-project', error: 'reap-orphans must run inside a git worktree (the mesh store is per-project)' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    const sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now });
    const orphans = Array.isArray(sum && sum.orphans) ? sum.orphans : [];
    // Owner-held partitions (devswarm.heldPartitions) are ALREADY excluded from
    // `sum.orphans` by computeSummary itself (they land in `sum.heldPartitions`
    // instead), so this filter is defense-in-depth against drift, not the
    // primary exclusion — a held id must never be reap-orphans-eligible.
    const heldIds = store.heldPartitionIdsFrom(ctx.env);
    const candidates = orphans.filter((o) => o && o.id != null && isSafeId(String(o.id)) && !heldIds.has(String(o.id))).map((o) => {
      // lastMessageTs: the newest row actually sitting in the partition, so a
      // human can see whether this is week-old sediment or something that
      // arrived an hour ago before authorising anything.
      let lastMessageTs = null;
      try {
        for (const m of (s.listMessages(String(o.id)) || [])) {
          const t = Number(m && m.ts);
          if (Number.isFinite(t) && (lastMessageTs === null || t > lastMessageTs)) lastMessageTs = t;
        }
      } catch (_) { lastMessageTs = null; }
      return {
        partitionId: String(o.id),
        unread: Number.isFinite(o.unread) ? o.unread : 0,
        messageCount: Number.isFinite(o.messageCount) ? o.messageCount : 0,
        lastMessageTs,
        reason: 'unread-with-no-live-reader',
      };
    });
    return { ok: true, candidates, repoKey };
  } finally { s.close(); }
}

// cmdReapOrphans(flags, ctx) — retire orphaned mesh partitions, SAFELY.
//
// WHAT "REAP" MEANS HERE, stated exactly (this is NOT a row deletion, and the
// difference is deliberate):
//   1. every UNREAD row of the partition is written to
//      <devswarmRoot>/reaped/<partitionId>.ndjson and READ BACK AND VERIFIED
//      line-for-line before anything else happens;
//   2. only then is the partition RETIRED by advancing its cursor to its own
//      message count, which is what removes it from computeSummary's
//      `orphans[]` (that set is gated on `unread > 0`) and therefore silences
//      the per-turn warning.
// The message rows themselves are LEFT INTACT in the store. Two reasons, both
// load-bearing rather than a limitation being dressed up: the store exposes no
// partition-delete primitive at all (there is `removeRegistry`, but an orphan
// by definition HAS no registry row), and this file's whole surrounding posture
// on this data is "surface only: NEVER auto-forwarded or deleted". Retiring
// rather than destroying achieves everything the defect asked for — 65 orphans
// stop nagging, in bulk, without a 20-of-88 partial failure — while keeping the
// mail recoverable from BOTH the store and the archive file. A caller who
// genuinely wants the bytes gone still has the archive plus an intact store to
// do it from, deliberately, by hand.
//
// SAFETY GATES (belt and braces — every one of these is a REFUSAL, not a
// warning, because the failure mode being guarded is "an automated loop
// quietly retires a live Primary's backlog"):
//   * DRY RUN IS THE DEFAULT. Bare `reap-orphans` only ever prints candidates.
//   * `--apply` REQUIRES `--max N`, N a positive integer. No unbounded apply
//     exists at all, so a runaway pass has a hard ceiling the caller chose.
//   * Never acts on more than N candidates, even if more qualify.
//   * REFUSES when ANTIHALL_DEVSWARM_AUTOMATION=1 — the marker a supervisor /
//     cron / hook context sets. Not overridable.
//   * REFUSES when stdin is not a TTY (the shape of a cron job, a pipeline, or
//     a subagent shell) unless `--i-am-a-human` is ALSO passed, which is a
//     claim a scheduled job has no reason to make.
//   * Per-partition, REFUSES to retire if the archive write or its verify
//     read-back fails — loss-free means the copy is PROVEN before the source
//     is touched, never assumed.
function cmdReapOrphans(flags, ctx) {
  const home = ctx.home;
  const apply = !!flags.apply;
  const collected = collectOrphanCandidates(ctx);
  if (!collected.ok) return Object.assign({ ok: false, action: 'reap-orphans' }, collected);
  const candidates = collected.candidates;
  if (!apply) {
    return {
      ok: true, action: 'reap-orphans', mode: 'dry-run', repoKey: collected.repoKey,
      candidateCount: candidates.length, candidates,
      note: candidates.length
        ? 'DRY RUN — nothing was changed. To act, re-run with `--apply --max N` (N = the most partitions '
          + 'this pass may retire). Each retired partition\'s unread rows are archived to '
          + reapedDir(home) + '/<partitionId>.ndjson and verified BEFORE its cursor is advanced; '
          + 'no message row is deleted.'
        : 'no orphaned partitions with unread mail in this project',
    };
  }
  // ---- apply-path refusals (checked BEFORE any work) ----
  const maxRaw = one(flags, 'max');
  if (maxRaw === undefined) {
    return { ok: false, action: 'reap-orphans', reason: 'max-required',
      error: '--apply requires --max N (the maximum number of partitions this pass may retire). '
        + 'There is deliberately no unbounded apply.' };
  }
  const maxN = Number(maxRaw);
  if (!Number.isFinite(maxN) || maxN < 1 || Math.floor(maxN) !== maxN) {
    return { ok: false, action: 'reap-orphans', reason: 'bad-max',
      error: '--max must be a positive integer (got ' + JSON.stringify(String(maxRaw)) + ')' };
  }
  if (ctx.env && String(ctx.env.ANTIHALL_DEVSWARM_AUTOMATION) === '1') {
    return { ok: false, action: 'reap-orphans', reason: 'automation-refused',
      error: 'refusing to --apply with ANTIHALL_DEVSWARM_AUTOMATION=1 set: retiring a partition is a '
        + 'human decision, never a scheduled sweep. Run it yourself from an interactive shell.' };
  }
  const humanClaimed = !!flags['i-am-a-human'];
  const isTty = !!(ctx.stdinIsTty !== undefined ? ctx.stdinIsTty : (process.stdin && process.stdin.isTTY));
  if (!isTty && !humanClaimed) {
    return { ok: false, action: 'reap-orphans', reason: 'non-interactive-refused',
      error: 'refusing to --apply from a non-interactive stdin (cron/pipeline/subagent shape). '
        + 'If a human really is driving this, pass --i-am-a-human as well.' };
  }
  const targets = candidates.slice(0, maxN);
  const repoKey = collected.repoKey;
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  const reaped = [];
  const failed = [];
  try {
    for (const c of targets) {
      const pid = c.partitionId;
      try {
        const cursor = floorCursor(s, pid, home);
        const total = s.messageCount(pid);
        const unreadRows = (s.listMessages(pid, { sinceCursor: cursor }) || []);
        if (!unreadRows.length) { failed.push({ partitionId: pid, reason: 'no-unread-rows' }); continue; }
        // ---- ARCHIVE, THEN VERIFY, THEN (and only then) RETIRE ----
        fs.mkdirSync(reapedDir(home), { recursive: true });
        const archivePath = path.join(reapedDir(home), pid + '.ndjson');
        const payload = unreadRows.map((m) => JSON.stringify({
          partitionId: pid, reapedAt: new Date().toISOString(), message: m,
        })).join('\n') + '\n';
        fs.writeFileSync(archivePath, payload);
        // VERIFY by reading the file back and counting the rows that actually
        // landed — not by trusting writeFileSync's return. A short write, a
        // full disk, or a truncating filesystem is exactly the case where
        // "assumed archived" would silently become "lost".
        const readBack = fs.readFileSync(archivePath, 'utf8');
        const landed = readBack.split('\n').filter((l) => l.trim() !== '');
        if (landed.length !== unreadRows.length) {
          failed.push({ partitionId: pid, reason: 'archive-verify-failed',
            expected: unreadRows.length, got: landed.length });
          continue; // REFUSE to retire — the source stays exactly as it was
        }
        let parsedOk = true;
        for (const line of landed) { try { JSON.parse(line); } catch (_) { parsedOk = false; break; } }
        if (!parsedOk) {
          failed.push({ partitionId: pid, reason: 'archive-verify-unparseable' });
          continue; // REFUSE to retire
        }
        // LOSS-FREE RAISE (Phase 3): the rows were archived to disk AND read
        // back verified above, so every reader row + the floor move past them
        // in one txn; the legacy shared pair is dual-written upward.
        readerCursors.raiseAllLossFree(s, { partition: pid, ns: 'store', value: total, home });
        try { logCursorWrite(home, { id: pid, partition: pid, ns: 'reader_cursors:store', from: cursor, to: total, delivered: null, gate: 'lockstep', verb: 'reap-orphans', cwd: (ctx && ctx.cwd) || null, repoKey: repoKeyForCwd(ctx) || store.hashFromWorkspaceId(pid) }); } catch (_) {}
        reaped.push({ partitionId: pid, unread: unreadRows.length, archivePath, cursorAdvancedTo: total });
      } catch (e) {
        failed.push({ partitionId: pid, reason: 'error', error: String((e && e.message) || e) });
      }
    }
    if (reaped.length) {
      try { store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); } catch (_) { /* projection refresh is best-effort */ }
    }
  } finally { s.close(); }
  return {
    ok: true, action: 'reap-orphans', mode: 'apply', repoKey,
    max: maxN, candidateCount: candidates.length, consideredCount: targets.length,
    reapedCount: reaped.length, reaped,
    failedCount: failed.length, failed,
    // Never let a capped pass look like a complete one.
    capped: candidates.length > targets.length,
    remaining: candidates.length - targets.length,
    note: 'unread rows were archived + verified under ' + reapedDir(home)
      + ' and each partition retired by advancing its cursor; NO message rows were deleted',
  };
}

// ===== reconcile-registry (defect d9a823ff1ca0, P1) ========================
// REPORT-ONLY, by construction: drift between the mesh registry and hivecontrol
// runs in BOTH directions (a row archived here but still open there; a row
// worktree-gone here but listed active there), and neither side is
// unconditionally authoritative — "fixing" one from the other automatically is
// how a live workspace gets retired from under its owner. This verb therefore
// only ever READS and PRINTS; there is no --apply, deliberately.
//
// SHAPE PINNING: `hivecontrol workspace list all`'s JSON is not pinned in the
// KB, and this file's other consumer (parseChildrenList) is deliberately
// TOLERANT — it normalises every missing field to null. Tolerance is right for
// a best-effort roster fold, but WRONG here: a drift report built from
// all-null records would confidently claim every workspace is missing/
// mismatched, which is worse than no report. So the RAW records are inspected
// for the fields this comparison actually depends on, and an unrecognised
// shape FAILS SOFT with the keys actually seen rather than guessing.
const HIVECONTROL_EXPECTED_FIELDS = ['id', 'path'];
// reconcileRealPath(p) — worktree-path identity, resolved the same way the
// store's own resolveWorktreeReal does (inst.worktreeRealPath, else
// path.resolve). Never throws: an unresolvable path degrades to its literal
// form, so a comparison still happens instead of the report dying.
function reconcileRealPath(p) {
  try {
    if (inst && typeof inst.worktreeRealPath === 'function') return inst.worktreeRealPath(p);
  } catch (_) { /* fall through to a plain resolve */ }
  try { return path.resolve(String(p == null ? '' : p)); } catch (_) { return String(p == null ? '' : p); }
}
function cmdReconcileRegistry(flags, ctx) {
  const home = ctx.home;
  const repoKey = repoKeyForCwd(ctx);
  if (!repoKey) {
    return { ok: false, action: 'reconcile-registry', reason: 'no-project',
      error: 'reconcile-registry must run inside a git worktree (the mesh registry is per-project)' };
  }
  const run = (ctx.io && ctx.io.run) || hcRun;
  let res;
  try {
    res = run({ args: ['workspace', 'list', 'all'], env: ctx.env, cwd: ctx.cwd || process.cwd(), timeout: LIST_CHILDREN_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-unavailable',
      error: 'hivecontrol workspace list all failed: ' + String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-unavailable',
      error: 'hivecontrol workspace list all failed: ' + String((res && res.error) || 'no output') };
  }
  let parsed;
  try { parsed = JSON.parse(res.raw); } catch (_) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-shape-unrecognized',
      error: 'hivecontrol workspace list all did not return parseable JSON', rawKeys: [] };
  }
  const rawList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : null);
  if (!rawList) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-shape-unrecognized',
      error: 'expected an array of workspace records (bare, or under `children`)',
      rawKeys: (parsed && typeof parsed === 'object') ? Object.keys(parsed) : [] };
  }
  const records = rawList.filter((e) => e && typeof e === 'object');
  // An EMPTY list is a legitimate answer (no workspaces), not an unrecognised
  // shape — only a NON-empty list whose records lack the fields this report
  // depends on is a shape failure.
  if (records.length) {
    const seenKeys = Array.from(new Set(records.flatMap((e) => Object.keys(e))));
    const missing = HIVECONTROL_EXPECTED_FIELDS.filter((f) => {
      if (f === 'path') return !seenKeys.includes('path') && !seenKeys.includes('worktreePath');
      return !seenKeys.includes(f);
    });
    if (missing.length) {
      return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-shape-unrecognized',
        error: 'hivecontrol workspace records are missing expected field(s): ' + missing.join(', ')
          + ' — refusing to guess at the mapping rather than emit a drift report built on assumptions',
        missingFields: missing, rawKeys: seenKeys };
    }
  }
  const hc = parseChildrenList(res.raw).filter((e) => e.id);
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let registry;
  try { registry = s.listRegistry() || []; } finally { s.close(); }
  const hcById = new Map(hc.map((e) => [String(e.id), e]));
  const regById = new Map(registry.filter((d) => d && d.id != null).map((d) => [String(d.id), d]));
  const registryWithoutWorkspace = [];
  const workspaceWithoutRegistry = [];
  const worktreePathMismatch = [];
  for (const [id, d] of regById) {
    const w = hcById.get(id);
    if (!w) { registryWithoutWorkspace.push({ id, worktreePath: d.worktreePath || null }); continue; }
    const a = d.worktreePath ? String(d.worktreePath) : null;
    const b = w.path ? String(w.path) : null;
    // Compare RESOLVED paths — a symlinked or trailing-slash difference is not
    // real drift and reporting it as such would bury the genuine cases. Uses
    // the SAME worktreeRealPath primitive devswarm-store.js's own
    // resolveWorktreeReal wraps, so the two cannot disagree about identity.
    if (a && b && reconcileRealPath(a) !== reconcileRealPath(b)) {
      worktreePathMismatch.push({ id, registryWorktreePath: a, hivecontrolPath: b });
    }
  }
  for (const [id, w] of hcById) {
    if (!regById.has(id)) workspaceWithoutRegistry.push({ id, path: w.path || null, label: w.label || null });
  }
  const driftCount = registryWithoutWorkspace.length + workspaceWithoutRegistry.length + worktreePathMismatch.length;
  return {
    ok: true, action: 'reconcile-registry', repoKey, reportOnly: true,
    registryCount: regById.size, hivecontrolCount: hcById.size,
    driftCount,
    registryWithoutWorkspace, workspaceWithoutRegistry, worktreePathMismatch,
    note: 'REPORT ONLY — nothing was changed. Drift runs in both directions and neither side is '
      + 'unconditionally authoritative, so reconciling is a human decision made per row.',
  };
}

module.exports = {
  RECONCILE_TIMEOUT_RETRY_BACKOFF_MS, isNativeTimeoutRun, defaultSpawnReconcile,
  reconcileResumePath, readReconcileResume, writeReconcileResume, DEFAULT_RECONCILE_BUDGET_MS,
  resolveReconcileClock, resolveReconcileBudgetMs, reconcileRowArchived, cmdReconcile,
  readPersistedVerdictStatus, hasRecentWorktreeActivity, projectScopedDescriptors, cmdReapStale,
  cmdReconcileActive, reapedDir, collectOrphanCandidates, cmdReapOrphans,
  HIVECONTROL_EXPECTED_FIELDS, reconcileRealPath, cmdReconcileRegistry,
};
