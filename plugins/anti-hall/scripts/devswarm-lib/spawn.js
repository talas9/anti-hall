'use strict';
// anti-hall :: devswarm CLI — SPAWN module (scripts/devswarm-lib/spawn.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  alog, cliRun: run, descriptorPath, dispatcherExports, fs, gitTruth, hasFlag, hasFreshHeartbeat,
  hcRun, heartbeatTs, identityContext, inst, names, os, path, planLib, readDescriptorFile, repokey,
  repoKeyForCwd, spawnSync, store, supervisionMetrics,
} = require('./core.js');
const core = require('./core.js'); // isChildWorkspace, wakeLib, stable launcher resolvers, CLI_PATH, PLUGIN_ROOT
const {
  registrySnapshot, seatSessionId, senderIdentityDetailed,
} = require('./identity.js');
const {
  planRefFor,
} = require('./send.js');
const {
  cmdArchive,
} = require('./archive.js');

// cmdRespawn(id, flags, ctx) — Meeseeks P3: the Primary replaces a straying
// child with a fresh workspace that keeps its progress. PRIMARY-RUN ONLY,
// never automatic (no sweep, hook or Jev answer calls it), and only after a
// warning: it refuses unless the caller holds the Primary seat, the plan has
// `warned_at` (a `correct` was sent) and devswarm.respawnGraceMin minutes
// have passed since it. Then, in order:
//   (a) send the child "commit and push WIP now" and wait up to
//       devswarm.respawnWipWaitSec for its worktree to be clean and pushed;
//   (b) still dirty or unpushed -> park it on a NEW branch
//       park/<branch>-<ts> (private temp index: the child's worktree, index
//       and branch are untouched) and push that. Never stash, never discard.
//       A failed park or push ABORTS the respawn (the local park branch stays);
//   (c) write plans/<id>.handover.md from the plan;
//   (d) spawn <branch>-r<N> with `-s <default branch>` — NOT `-s <old
//       branch>`, which would make the old branch the merge target (see
//       SPAWN SOURCE FRESHNESS above) — with the handover as the brief, step 1
//       "merge the old/park branch", then the remaining steps; the plan's
//       scope and extras carry over;
//   (e) archive the old id and tell the owner to close its app tab.
// `--dry-run` runs the refusal checks, prints the plan and changes nothing.
// The only kill path stays devswarm-recover.js; respawn never kills.
function cmdRespawn(id, flags, ctx) {
  const home = ctx.home;
  const env = ctx.env || process.env;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const cwd = ctx.cwd || process.cwd();
  const respawnLib = require('../../companion/lib/devswarm-respawn.js');
  const dryRun = hasFlag(flags, 'dry-run');
  const refuse = (reason, error, extra) => Object.assign({ ok: false, action: 'respawn', id, reason, error }, extra || {});
  const setting = (k, d) => {
    let v;
    try { v = Number(require('../../hooks/lib/settings.js').get('devswarm', k, d, { env, home })); } catch (_) { v = d; }
    return Number.isFinite(v) && v >= 0 ? v : d;
  };

  let seat;
  try {
    seat = require('../../companion/lib/primary-seat.js').seatVerdict({ home, env, cwd, sessionId: seatSessionId(ctx, flags) });
  } catch (_) { seat = { state: 'unknown' }; }
  if (!seat || seat.state !== 'own') {
    return refuse('not-primary', 'respawn runs only from the session that holds the Primary seat (seat: ' + ((seat && seat.state) || 'unknown') + ')', { seat: seat && seat.state });
  }
  const ref = planRefFor(home, id, ctx);
  const found = planLib.findPlan(home, ref);
  if (!found || !found.plan.steps.length) return refuse('no-plan', 'no step plan for ' + id + ' — respawn carries a plan over, so it needs one');
  const warnedAt = found.plan.warned_at;
  if (!Number.isFinite(warnedAt)) {
    return refuse('not-warned', 'respawn needs a prior warning: send `devswarm.js correct ' + id + '` first, then wait devswarm.respawnGraceMin minutes');
  }
  const graceMin = setting('respawnGraceMin', 20);
  const sinceMs = now - warnedAt;
  if (sinceMs < graceMin * 60000) {
    return refuse('grace', 'the child was warned ' + planLib.dur(sinceMs) + ' ago; respawn waits devswarm.respawnGraceMin (' + graceMin + 'm) after the warning',
      { warned_at: warnedAt, graceMin, remainingMin: Math.ceil((graceMin * 60000 - sinceMs) / 60000) });
  }
  const wt = ref.worktreePath || found.plan.worktreePath;
  const st = respawnLib.worktreeState(wt);
  if (st.error) return refuse('no-worktree', st.error);
  if (!st.branch) return refuse('detached', 'the child worktree has a detached HEAD — nothing names the work to carry over');
  const defRef = gitTruth.defaultBranchRef(cwd);
  if (!defRef) return refuse('default-branch-unknown', 'origin/HEAD is not set, so the default branch is unknown (fix: `git remote set-head origin --auto`)');
  const def = defRef.slice('origin/'.length);
  const next = respawnLib.nextBranch(st.branch, (n) => respawnLib.localBranchExists(cwd, n));
  const summaries = Array.isArray(found.plan.summaries) ? found.plan.summaries : [];
  const lastWorkingOn = summaries.length ? summaries[summaries.length - 1].text : null;
  const handoverPath = path.join(planLib.plansDir(home), id + '.handover.md');
  const wipWaitSec = setting('respawnWipWaitSec', 120);
  const info = (parkBranch) => ({ id, branch: st.branch, plan: found.plan, parkBranch, mergeRef: parkBranch || st.branch,
    newBranch: next.branch, defaultBranch: def, lastWorkingOn, now });

  if (dryRun) {
    const wouldPark = respawnLib.needsPark(st);
    const parkName = wouldPark ? respawnLib.parkBranchName(st.branch, now) : null;
    const handover = respawnLib.handoverText(info(parkName));
    return {
      ok: true, action: 'respawn', id, dryRun: true, branch: st.branch, newBranch: next.branch, defaultBranch: def,
      worktree: { dirty: st.dirty, unpushed: st.unpushed }, wipWaitSec, wouldPark, parkBranch: parkName, handoverPath,
      spawnArgs: [next.branch, '-s', def, '-p', respawnLib.briefText(info(parkName), handover)],
      plan: [
        '(a) send ' + id + ' "commit and push WIP now"; wait up to ' + wipWaitSec + 's for a clean, pushed worktree',
        '(b) if still dirty/unpushed: commit it to a new branch ' + (parkName || 'park/' + st.branch + '-<ts>') + ' and push it (abort on failure)',
        '(c) write ' + handoverPath,
        '(d) spawn ' + next.branch + ' from ' + def + ' (step 1 merges the old work, then the remaining steps)',
        '(e) archive ' + id + ' and ask the owner to close its app tab',
      ],
    };
  }

  // (a) ask the child to commit and push, then wait for it.
  const message = 'RESPAWN: the Primary is replacing this workspace with ' + next.branch + '. Commit and push ALL your work now '
    + '(`git add -A && git commit -m "wip" && git push -u origin HEAD`), then stop. Anything left uncommitted is parked on a new branch.';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-respawn-'));
  const msgFile = path.join(tmpDir, 'message.txt');
  let sent;
  try {
    fs.writeFileSync(msgFile, message);
    const argv = ['send', '--to', id, '--message-file', msgFile];
    sent = (ctx.io && typeof ctx.io.send === 'function') ? ctx.io.send(argv) : run(argv, ctx);
  } catch (e) { sent = { code: 2, result: { ok: false, error: String((e && e.message) || e) } }; }
  finally {
    try { fs.unlinkSync(msgFile); } catch (_) {}
    try { fs.rmdirSync(tmpDir); } catch (_) {}
  }
  const sendOk = !!(sent && sent.code === 0);
  const sleep = (ctx.io && typeof ctx.io.sleep === 'function') ? ctx.io.sleep
    : (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };
  const waitStart = Date.now();
  let cur = respawnLib.worktreeState(wt);
  while (sendOk && !cur.error && respawnLib.needsPark(cur) && Date.now() - waitStart < wipWaitSec * 1000) {
    sleep(Math.min(5000, wipWaitSec * 1000 - (Date.now() - waitStart)));
    cur = respawnLib.worktreeState(wt);
  }
  if (cur.error) {
    supervisionMetrics.record(home, 'respawn-aborted', { now, id, key: found.key, stage: 'worktree' });
    return refuse('worktree-error', cur.error, { sent: sendOk });
  }

  // (b) park whatever is still dirty or unpushed.
  let park = null;
  if (respawnLib.needsPark(cur)) {
    park = respawnLib.parkWip(wt, { id, branch: st.branch, parkBranch: respawnLib.parkBranchName(st.branch, now), dirty: cur.dirty });
    if (!park.ok) {
      supervisionMetrics.record(home, 'respawn-aborted', { now, id, key: found.key, stage: park.stage });
      return refuse('park-failed', 'respawn aborted — the work could not be parked safely: ' + park.error, { sent: sendOk, park });
    }
  }
  const parkBranch = park ? park.parkBranch : null;

  // (c) the handover.
  const handover = respawnLib.handoverText(info(parkBranch));
  try {
    fs.mkdirSync(path.dirname(handoverPath), { recursive: true });
    const tmp = handoverPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, handover);
    fs.renameSync(tmp, handoverPath);
  } catch (e) {
    supervisionMetrics.record(home, 'respawn-aborted', { now, id, key: found.key, stage: 'handover' });
    return refuse('handover-failed', 'cannot write ' + handoverPath + ': ' + String((e && e.message) || e), { sent: sendOk, park });
  }

  // (d) spawn from the default branch.
  const spawnArgs = [next.branch, '-s', def, '-p', respawnLib.briefText(info(parkBranch), handover)];
  const sp = cmdSpawn(spawnArgs, ctx);
  if (!sp || !sp.ok) {
    supervisionMetrics.record(home, 'respawn-aborted', { now, id, key: found.key, stage: 'spawn' });
    return refuse('spawn-failed', 'respawn stopped at spawn (the work is safe' + (parkBranch ? ' on ' + parkBranch : ' on ' + st.branch) + '): '
      + ((sp && sp.error) || 'spawn failed'), { sent: sendOk, park, handoverPath, spawn: sp });
  }
  const newKey = sp.plan && sp.plan.written ? sp.plan.key : null;
  if (newKey) {
    planLib.updatePlan(home, newKey, (p) => {
      if (!p) return null;
      for (const e of (found.plan.extras || [])) planLib.addExtra(p, e.glob, e.note, now);
      p.respawn = { from: id, from_branch: st.branch, park: parkBranch, at: now };
      return p;
    });
  }
  planLib.updatePlan(home, found.key, (p) => {
    if (!p) return null;
    p.respawned_to = sp.meshId || next.branch;
    p.respawned_at = now;
    return p;
  });

  // (e) archive the old workspace; the owner closes its app tab.
  let archived;
  try { archived = cmdArchive(id, ctx, { flags: {} }); } catch (e) { archived = { ok: false, error: String((e && e.message) || e) }; }
  const nag = 'Close the DevSwarm app tab for ' + id + ' (' + st.branch + '): it is replaced by ' + next.branch + '.';
  supervisionMetrics.record(home, 'respawn', { now, id, key: found.key, newId: sp.meshId || null, newKey,
    parked: !!parkBranch, pushedByChild: !parkBranch && respawnLib.needsPark(st),
    stepsDone: planLib.stepsDone(found.plan), stepsPlanned: found.plan.steps.length });
  return {
    ok: true, action: 'respawn', id, branch: st.branch, newBranch: next.branch, newId: sp.meshId || null, defaultBranch: def,
    sent: sendOk, parked: !!parkBranch, parkBranch, handoverPath, spawn: { ok: sp.ok, worktreePath: sp.worktreePath, plan: sp.plan },
    // A1-8: which untracked files actually rode along on the park branch, and
    // which were skipped as likely secrets (.env/*.pem/*.key/id_rsa*/etc) —
    // surfaced here (not just silently dropped) so the Primary can see both.
    untrackedIncluded: park ? park.untrackedIncluded || [] : [],
    untrackedExcluded: park ? park.untrackedExcluded || [] : [],
    archived: { ok: !!(archived && archived.ok), error: archived && !archived.ok ? archived.error : undefined },
    nag,
  };
}

// resolveCreatedWorktreePath(res) -> string | null. TOLERANT best-effort parse
// of `hivecontrol workspace create`'s stdout for a `path`/`worktreePath` field
// (accepting a top-level field or one nested under a `workspace` key) — the
// exact JSON shape is not pinned in the KB, so this NEVER guesses a directory-
// naming convention; an unparseable/fieldless payload returns null, and the
// caller treats that as a legitimate best-effort-skip, not an error.
function resolveCreatedWorktreePath(res) {
  if (!res || typeof res.raw !== 'string') return null;
  try {
    const parsed = JSON.parse(res.raw);
    if (parsed && typeof parsed === 'object') {
      const nested = parsed.workspace && typeof parsed.workspace === 'object' ? parsed.workspace : null;
      const p = parsed.path || parsed.worktreePath || (nested && (nested.path || nested.worktreePath));
      if (typeof p === 'string' && p) return p;
    }
  } catch (_) { /* unparseable -> null, never a guess */ }
  return null;
}

// ---- Task #6 (workspace naming) helpers ------------------------------------
//
// hasSpawnFlag(rest, shortFlag, longFlag) -> bool. TOLERANT scan for either
// commander-style spacing form (`--title value` / `--title=value` /
// `-t value`) — `rest` is forwarded VERBATIM to hivecontrol (never re-parsed
// elsewhere in this file, per cmdSpawn's own long-standing contract), so this
// scan must recognize the same forms hivecontrol's own parser accepts, or a
// caller-supplied -t could be missed and DOUBLE-injected below.
// NAMED DISTINCTLY from the pre-existing hasFlag(flags, name) (line ~2911,
// used everywhere in this file for `--yes`/`--confirm`-style CLI flags): two
// top-level `function hasFlag` declarations in the same scope would silently
// let the SECOND one win at every call site (JS function redeclaration, not
// an overload) — caught live via `reconcile-active --yes` losing its confirm
// detection during this change's own verification pass.
function hasSpawnFlag(rest, shortFlag, longFlag) {
  if (!Array.isArray(rest)) return false;
  return rest.some((a) => typeof a === 'string' &&
    (a === shortFlag || a === longFlag || a.indexOf(longFlag + '=') === 0));
}

// extractFlagValue(rest, shortFlag, longFlag) -> string | null. Same tolerant
// forms as hasSpawnFlag; returns the FIRST match's value (the next argv
// element for the space form, or the substring after `=` for the equals
// form). No pre-existing extractFlagValue in this file (verified) — no
// collision risk here.
function extractFlagValue(rest, shortFlag, longFlag) {
  if (!Array.isArray(rest)) return null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string') continue;
    if (a === shortFlag || a === longFlag) {
      return (typeof rest[i + 1] === 'string') ? rest[i + 1] : null;
    }
    if (a.indexOf(longFlag + '=') === 0) return a.slice(longFlag.length + 1);
  }
  return null;
}

// sourceWorkspaceNote(rest, ctx) -> string | null. OUTPUT ONLY (no behaviour change).
// When `--source <branch>` names a branch other than the repository's default branch
// AND the DevSwarm app already holds a workspace (builder row, active or archived) on
// that branch in the same repository, the new workspace may be shown nested under it in
// the app's tree view. The "may" is deliberate: the nesting was reported from the app's
// tree view and is not verified from the app's data. Any lookup failure -> null (say
// nothing). `ctx.io.appSnapshot()` is the test seam for the app-DB snapshot.
function sourceWorkspaceNote(rest, ctx) {
  try {
    const source = extractFlagValue(rest, '-s', '--source');
    if (!source) return null;
    const cwd = ctx.cwd || process.cwd();
    const remoteRef = gitTruth.defaultBranchRef(cwd); // 'origin/<default>' | null
    if (!remoteRef) return null; // default unknown -> cannot tell, say nothing
    if (source === remoteRef.slice('origin/'.length)) return null;
    const appDb = require('../../companion/lib/devswarm-app-db.js');
    const snap = (ctx.io && typeof ctx.io.appSnapshot === 'function')
      ? ctx.io.appSnapshot()
      : appDb.snapshot({ home: ctx.home, env: ctx.env || process.env });
    if (!snap || !Array.isArray(snap.workspaces)) return null;
    const repo = appDb.repositoryForWorktree(snap, cwd);
    if (!repo || repo.id == null) return null; // cannot scope to this repository -> say nothing
    const held = snap.workspaces.some((w) => w && w.branchName === source && String(w.repositoryId) === String(repo.id));
    return held
      ? 'note: --source ' + source + ' already has a workspace; the DevSwarm app may show the new workspace nested under it.'
      : null;
  } catch (_) {
    return null;
  }
}

// deriveTitleFromBrief(brief) -> string | null. Owner-approved derivation
// rule: take the first non-empty line of the brief, strip ONE leading
// markdown marker (heading/bullet/quote) so a line like "# own the API layer"
// titles as "own the API layer" rather than carrying the marker, and collapse
// internal whitespace. The FULL line is kept (owner decision 2026-09-24, v0.108.0:
// no length cap — the DevSwarm sidebar truncates by width on its own, and a
// stored "…" title can never be matched or restored). Returns null for a
// non-string/empty/blank brief.
function deriveTitleFromBrief(brief) {
  if (typeof brief !== 'string') return null;
  let line = null;
  for (const l of brief.split(/\r?\n/)) {
    const t = l.trim();
    if (t) { line = t; break; }
  }
  if (!line) return null;
  line = line.replace(/^(#{1,6}|[-*>])\s+/, '').trim().replace(/\s+/g, ' ');
  return line || null;
}

// cmdSpawn(rest, ctx) — PLAN.md "spawn": THIN pass-through wrap of
// `hivecontrol workspace create <branch> ...` (rest[0] is the branch; every
// remaining token forwards untouched — never re-implemented, never gated;
// hivecontrol may add create flags without anti-hall ever changing), then a
// best-effort auto-registration of the new worktree in THIS project's shared
// store registry (store-only — no descriptor file, no sessionId yet; the
// child's own first inbox-pull/heartbeat/register fills that in itself, the
// same self-registration path every other child already relies on). A create
// failure is returned as-is; a registration failure AFTER a successful create
// never rolls back or fails the (already-succeeded) hivecontrol create.
//
// Task #6 naming (CORRECTED design, owner 2026-07-27): a title is set via a
// SEPARATE follow-up `hivecontrol workspace update-title -b <branch> <title>`
// call — NEVER by touching the argv forwarded to `create` above. An earlier
// draft injected `-t` into that forwarded array and broke the "THIN
// pass-through... untouched, including short flags" invariant this file's
// own tests enforce (and the very next test: "spawn never re-parses or gates
// hivecontrol's own flags"). update-title also targets ANY existing branch
// via -b, which -t-at-create never could — so cmdReconcile's read-only name
// backfill (below) can mirror an already-set title into the local cache for
// a PRE-EXISTING workspace too, off the hot path; it deliberately does NOT
// fabricate/apply a title to hivecontrol for a workspace with no brief on
// record (no ungrounded write into a user-facing GUI label).
//
// Fires whenever a title is KNOWN: either the caller passed -t/--title
// explicitly (its literal value is used verbatim — see the fix comment at
// this function's `derivedTitle` assignment for why this branch exists at
// all), or the caller passed -p/--prompt with no -t (derivation:
// deriveTitleFromBrief). Gated on the SAME
// worktreePath-resolved condition as registration below (a create response
// we cannot resolve a path from is not confirmed enough to act further on —
// same conservative posture registration already uses). FAIL-OPEN: an
// update-title failure/exception NEVER fails the spawn verb (mirrors
// registration's own best-effort-skip posture — `registered:false`/
// `titled:false` are legitimate reported outcomes, never verb failures).
// SPAWN LAUNCH VERIFICATION (defect f85dedeaf61f, anti-hall half).
//
// FIELD SHAPE: `hivecontrol workspace create` returned success, this verb
// blind-seeded a registry row (sessionId null, inboxPath null) and returned
// `ok:true, created:true, registered:true` — and NO session ever started. The
// row read ACTIVE in the roster for 25 minutes, working_on null, the worktree's
// own inbox and heartbeat log both 0 bytes, a Primary's message to it unread the
// whole time. WHY the launch failed is UNKNOWN and external (the reporter tested
// and REFUTED the obvious self-collision hypothesis); this fix does not touch it.
//
// WHAT WAS WRONG ON OUR SIDE: the return conflated CREATE with LAUNCH. The
// create success schema carries NO session field (verified: resolveCreatedWorktreePath
// parses a path only), so `created:true` was never evidence a child was running,
// yet the response offered nothing else to read. `launched` now reports that
// separately, from POSITIVE EVIDENCE ONLY.
//
// EVIDENCE (any one is proof-of-launch — all three are written by the CHILD's own
// session, never by this verb): a fresh heartbeat for the mesh id; a registry row
// whose sessionId/inboxPath the child filled in over our null seed; or the child's
// own descriptor file.
//
// `launched` IS TRI-STATE AND NEVER `false`: absence of a heartbeat inside a short
// window is NOT proof the child failed to launch — a real session can take far
// longer than any window this verb may block for. Reporting `false` there would be
// the same class of unearned claim as the `created:true`-implies-launched this
// fixes. So: `true` (evidence seen) or `'unknown'` (none yet, verdict open), with
// `launchHint` naming the verb that settles it later. On the default window
// `'unknown'` is the EXPECTED outcome for a healthy spawn — it means "not yet
// confirmed", not "broken".
//
// NEVER BLOCKS LONG and NEVER FAILS THE VERB: default 750ms, overridable via
// ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS (0 = one immediate check, no sleep), and
// the poll returns the instant evidence appears. Any throw inside it yields
// 'unknown', exactly like a clean timeout.
const SPAWN_LAUNCH_WAIT_MS_DEFAULT = 750;
// SPAWN_LAUNCH_WAIT_MAX_MS — hard ceiling on how long `spawn` may block for
// launch evidence. `checkSpawnLaunch`'s poll is SYNCHRONOUS (Atomics.wait), so
// the configured window is wall-clock time the whole CLI is frozen with no
// output and no way to interrupt it: `ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS=
// 999999999` wedged `spawn` for eleven and a half days. The verdict this poll
// produces is explicitly best-effort ('unknown' is never a failure, and the
// hint already tells the caller to re-check with `roster`/`heartbeat` in a
// minute), so no legitimate use is served by waiting longer than a few
// seconds. 10s is generous against a normal launch and still bounded.
const SPAWN_LAUNCH_WAIT_MAX_MS = 10000;

// spawnLaunchWaitRequestedMs(env) -> the UNCLAMPED configured window (the
// pre-clamp behaviour), kept separate so checkSpawnLaunch can report WHETHER a
// clamp was applied rather than silently honouring a different number than the
// operator asked for.
function spawnLaunchWaitRequestedMs(env) {
  const raw = env ? env.ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return SPAWN_LAUNCH_WAIT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SPAWN_LAUNCH_WAIT_MS_DEFAULT; // a bad value falls back to the default, never disables the check silently
  return Math.floor(n);
}
function spawnLaunchWaitMs(env) {
  return Math.min(spawnLaunchWaitRequestedMs(env), SPAWN_LAUNCH_WAIT_MAX_MS);
}
// checkSpawnLaunch(meshId, ctx, storeOpen) -> {launched, evidence, waitedMs, windowMs}
// storeOpen() -> a fresh store handle | null (injected so the poll re-reads the
// registry rather than trusting the handle the seed write already closed).
// `opts.since` (ms) — the RECENCY FLOOR. Evidence only counts as proof that
// THIS spawn launched something if it was produced AT OR AFTER the given
// instant (inclusive: a beat written in the same millisecond the spawn started
// is genuinely new, and ms resolution is far too coarse to spend a boundary on
// when the hazard being excluded is measured in MINUTES);
// cmdSpawn passes the wall-clock it captured BEFORE the hivecontrol `create`
// call, so anything predating the spawn is ignored.
//
// ROOT CAUSE this closes: `hasFreshHeartbeat` accepts any beat inside its
// 15-minute freshness window, and a meshId is derived from the WORKTREE PATH —
// so re-spawning a branch onto a path a prior occupant used (branch reuse)
// found that occupant's minutes-old heartbeat sitting there and reported
// `launched:true, launchEvidence:'heartbeat', launchCheckedMs:0` having
// observed nothing new whatsoever. The same applies to a stale registry row
// and a leftover descriptor file. `since` makes every signal answer "did this
// appear because of THIS spawn", which is the question the field actually asks.
//
// BACK-COMPAT: `since` absent/non-finite = no floor, i.e. exactly the previous
// predicate. Direct callers that assert on the predicate itself (rather than
// through cmdSpawn) are unaffected; production always passes it.
function checkSpawnLaunch(meshId, ctx, storeOpen, opts) {
  const requestedMs = spawnLaunchWaitRequestedMs(ctx && ctx.env);
  const windowMs = spawnLaunchWaitMs(ctx && ctx.env);
  const windowClamped = requestedMs > windowMs;
  const since = opts && Number.isFinite(opts.since) ? opts.since : null;
  const started = Date.now();
  const stepMs = 150;
  // A8 — ONE store handle for the WHOLE poll, not one per 150ms iteration.
  // `storeOpen()` runs mkdir + PRAGMAs + `CREATE TABLE IF NOT EXISTS` on every
  // call, so a 10s window paid ~66 full store initialisations to answer one
  // question. Hoisting is safe for freshness (the property the injected
  // `storeOpen` exists to guarantee): BOTH backends re-read their source on
  // every `listRegistry()` call — sqlite issues a fresh `SELECT * FROM
  // registry`, the journal backend re-reduces its append-only log off disk —
  // so a held handle observes the child's registration exactly as a reopened
  // one would. Fail-soft is preserved in both directions: a throwing
  // `storeOpen` leaves `handle` null and the registry signal simply yields no
  // evidence, and the handle is closed in the `finally` below even if the poll
  // returns early or throws.
  let handle = null;
  let handleTried = false;
  const registryHandle = () => {
    if (!handleTried) {
      handleTried = true;
      try { handle = storeOpen(); } catch (_) { handle = null; }
    }
    return handle;
  };
  // fileNewerThan(p) -> true when p's mtime postdates `since` (always true when
  // there is no floor). Used for the descriptor signal, whose only timestamp is
  // its file mtime.
  const fileNewerThan = (p) => {
    if (since === null) return true;
    try { return fs.statSync(p).mtimeMs >= since; } catch (_) { return false; }
  };
  const evidenceNow = () => {
    try {
      if (since === null) {
        if (hasFreshHeartbeat(meshId, ctx.home, {})) return 'heartbeat';
      } else {
        // Compare the beat's OWN timestamp against the floor rather than
        // asking hasFreshHeartbeat, whose 15-minute window is exactly what
        // let a prior occupant's beat through.
        const ts = heartbeatTs(meshId, ctx.home);
        if (Number.isFinite(ts) && ts >= since) return 'heartbeat';
      }
    } catch (_) { /* no evidence from this signal */ }
    try {
      const s = registryHandle();
      if (s) {
        const row = (s.listRegistry() || []).find((r) => r && String(r.id) === String(meshId));
        // The seed wrote sessionId/inboxPath as null; ONLY the child's own
        // register can make either non-null, so either is positive evidence.
        // With a floor, ALSO require the row's own last-upsert time to
        // postdate it — otherwise a prior occupant's row (non-null sessionId,
        // written long before this spawn) reads as a launch. `updatedAt` null
        // (a pre-migration row never re-upserted) cannot clear the floor and
        // is treated as no evidence, the conservative direction: 'unknown' is
        // never a hard failure, a false 'launched:true' is.
        const rowFresh = (r) => since === null || (r && Number.isFinite(r.updatedAt) && r.updatedAt >= since);
        if (row && rowFresh(row)) {
          if (row.sessionId != null && String(row.sessionId) !== '') return 'registry-session';
          if (row.inboxPath != null && String(row.inboxPath) !== '') return 'registry-inbox';
        }
      }
    } catch (_) { /* no evidence from this signal */ }
    try {
      if (readDescriptorFile(ctx.home, meshId) && fileNewerThan(descriptorPath(ctx.home, meshId))) return 'descriptor';
    } catch (_) { /* no evidence from this signal */ }
    return null;
  };
  const verdict = (launched, evidence) => {
    const out = { launched, evidence, waitedMs: Date.now() - started, windowMs };
    // Never silently honour a different number than the operator configured.
    if (windowClamped) { out.launchWindowClamped = true; out.launchWindowRequestedMs = requestedMs; }
    return out;
  };
  try {
    for (;;) {
      const ev = evidenceNow();
      if (ev) return verdict(true, ev);
      if (Date.now() - started >= windowMs) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs); } catch (_) { break; }
    }
    return verdict('unknown', null);
  } finally {
    if (handle) { try { handle.close(); } catch (_) { /* best-effort */ } }
  }
}

// SPAWN SOURCE FRESHNESS (0.108.5, field defect). `hivecontrol workspace create`
// branches the child from a LOCAL branch NAME: the CLI sends `sourceBranch` =
// `-s/--source`, else (inside DevSwarm) the caller's current branch, else
// DEVSWARM_DEFAULT_BRANCH || DEVSWARM_SOURCE_BRANCH || 'main' [verified: bundled
// devswarm CLI, `workspace create` action]. That name is also the child's
// recorded PARENT (merge-into-source target), so `origin/main` or a sha can
// never be passed in its place. A Primary whose local default branch had fallen
// 25 commits behind origin handed a child stale tooling (a deploy script missing
// a newer CI gate). So before `create`, when the source IS the default branch
// (origin/HEAD): fetch it, and if local is strictly behind, fast-forward it
// (update-ref with the old value as a guard when not checked out; `merge
// --ff-only` in its worktree when checked out and clean). Never rebase, reset or
// force; no other branch is touched. Fetch failure = warn and continue. Behind or
// diverged and not updatable = refuse unless `--from-local`. Setting
// devswarm.spawnFromOrigin=false skips the whole check.
const SPAWN_FETCH_TIMEOUT_MS = 30000;
const SPAWN_FETCH_TTL_SEC_DEFAULT = 300;

// gitCommonDirFor(cwd) -> the repo's common git dir (shared across worktrees),
// via companion/lib/devswarm-repokey.js's own gitCommonDir() (the single
// canonical `rev-parse --git-common-dir` resolver — see
// tests/hygiene/identity-single-resolver.test.js) — never a guessed `.git`
// join, since a linked worktree's own `.git` is a FILE pointing elsewhere.
// null on any failure (never throws).
function gitCommonDirFor(cwd) {
  return repokey.gitCommonDir(cwd);
}

// remoteRefAgeSec(cwd, remoteRef, now) -> seconds since the remote-tracking
// ref ITSELF (e.g. `refs/remotes/origin/<def>`) was last updated, or null
// when unknown (never fetched, or unreadable — e.g. packed-refs with no
// loose ref and no reflog, which is treated as stale so the caller fetches).
//
// FETCH_HEAD is deliberately NOT consulted (fixed defect): it is updated by
// ANY fetch against this repo — a different branch, a different remote, even
// a fetch this same devswarm run made for an unrelated ref — so using it as
// the freshness signal for `origin/<def>` could report "just checked" when
// <def> itself had not been touched in days. The reflog
// (`logs/refs/remotes/origin/<def>`, appended on every fetch that moves the
// ref) and, when the ref has no reflog yet, the loose ref file's own mtime
// (`refs/remotes/origin/<def>`) are the ONLY signals used — both are scoped
// to THIS ref. Resolved against the COMMON dir so a linked worktree shares
// the same freshness signal as the main checkout (there is only one origin).
function remoteRefAgeSec(cwd, remoteRef, now) {
  const common = gitCommonDirFor(cwd);
  if (!common) return null;
  const parts = remoteRef.split('/');
  const stamps = [];
  try { stamps.push(fs.statSync(path.join(common, 'logs', 'refs', 'remotes', ...parts)).mtimeMs); } catch (_) {}
  try { stamps.push(fs.statSync(path.join(common, 'refs', 'remotes', ...parts)).mtimeMs); } catch (_) {}
  if (!stamps.length) return null;
  const newest = Math.max(...stamps);
  return Math.max(0, Math.floor((now - newest) / 1000));
}

function spawnSourceFreshness(rest, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const env = ctx.env || process.env;
  const fromLocal = rest.includes('--from-local');
  const git = (args, timeout) => spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', timeout: timeout || gitTruth.GIT_TIMEOUT_MS });
  const out = (r) => (r && !r.error && r.status === 0) ? String(r.stdout || '').trim() : null;
  let on = true;
  try { on = require('../../hooks/lib/settings.js').get('devswarm', 'spawnFromOrigin', true, { env, home: ctx.home }) !== false; } catch (_) { on = true; }
  if (!on) return { status: 'skipped', reason: 'setting devswarm.spawnFromOrigin=false' };

  const remoteRef = gitTruth.defaultBranchRef(cwd); // 'origin/<default>' | null
  if (!remoteRef) return { status: 'skipped', warning: 'default branch unknown (origin/HEAD is not set); spawning without checking the source against origin' };
  const def = remoteRef.slice('origin/'.length);
  let source = extractFlagValue(rest, '-s', '--source');
  if (!source) {
    source = env.DEVSWARM_REPO_ID ? out(git(['symbolic-ref', '--short', '-q', 'HEAD']))
      : (env.DEVSWARM_DEFAULT_BRANCH || env.DEVSWARM_SOURCE_BRANCH || 'main');
  }
  if (source !== def) return { status: 'skipped', reason: 'source ' + JSON.stringify(source) + ' is not the default branch ' + def };

  // FETCH TTL (0.109.0, spawn speed): skip the network `git fetch` — the most
  // expensive step of this check — when the remote-tracking ref was already
  // updated within `devswarm.spawnFetchTtlSec` (default 300s). ttl 0 always
  // fetches (opt-out). `fetch` on the returned object names the decision so a
  // caller can see it without re-deriving it.
  let ttlSec = SPAWN_FETCH_TTL_SEC_DEFAULT;
  try { ttlSec = require('../../hooks/lib/settings.js').get('devswarm', 'spawnFetchTtlSec', SPAWN_FETCH_TTL_SEC_DEFAULT, { env, home: ctx.home }); } catch (_) { ttlSec = SPAWN_FETCH_TTL_SEC_DEFAULT; }
  if (!(Number.isFinite(ttlSec) && ttlSec >= 0)) ttlSec = SPAWN_FETCH_TTL_SEC_DEFAULT;
  let fetchNote = 'ran';
  if (ttlSec > 0) {
    const ageSec = remoteRefAgeSec(cwd, remoteRef, Date.now());
    if (ageSec !== null && ageSec < ttlSec) {
      fetchNote = 'skipped (fresh, ' + ageSec + 's ago)';
    }
  }
  let submoduleFetch;
  if (fetchNote === 'ran') {
    // `--recurse-submodules=on-demand` (0.109.0): without it, `git fetch` never
    // touches submodule objects, so a repo-setup script run against the fresh
    // <def> can find pinned submodule commits missing from the parent's
    // `.git/modules` — exactly what a subsequent local submodule clone needs.
    // on-demand (not `--recurse-submodules=yes`) fetches ONLY the submodules
    // whose pinned commit actually changed in this fetch, never every submodule
    // unconditionally.
    const f = git(['fetch', '--quiet', '--recurse-submodules=on-demand', 'origin', def], SPAWN_FETCH_TIMEOUT_MS);
    if (!f || f.error || f.signal || f.status !== 0) {
      // RETRY WITHOUT SUBMODULES: a broken/unreachable submodule remote (dead
      // link, auth change, deleted repo) must not fail the whole parent
      // fetch — the parent branch itself may be perfectly reachable. Retry
      // once with `--no-recurse-submodules` before declaring the fetch
      // failed; if THAT also fails, it really is offline/unreachable.
      const f2 = git(['fetch', '--quiet', '--no-recurse-submodules', 'origin', def], SPAWN_FETCH_TIMEOUT_MS);
      if (!f2 || f2.error || f2.signal || f2.status !== 0) {
        return { status: 'fetch-failed', source, fetch: fetchNote, warning: 'could not fetch ' + remoteRef + ' (offline?); spawning from local ' + def + ' as it is' };
      }
      submoduleFetch = 'failed';
    }
  }
  const local = out(git(['rev-parse', '-q', '--verify', 'refs/heads/' + def + '^{commit}']));
  const remote = out(git(['rev-parse', '-q', '--verify', 'refs/remotes/' + remoteRef + '^{commit}']));
  if (!local || !remote) return { status: 'skipped', source, fetch: fetchNote, submoduleFetch, warning: 'could not resolve ' + def + ' or ' + remoteRef + '; spawning without the check' };
  if (local === remote) return { status: 'up-to-date', source, fetch: fetchNote, submoduleFetch, sha: local };
  const counts = out(git(['rev-list', '--left-right', '--count', local + '...' + remote]));
  const [ahead, behind] = String(counts || '').split(/\s+/).map((n) => parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { status: 'skipped', source, fetch: fetchNote, submoduleFetch, warning: 'could not compare ' + def + ' with ' + remoteRef + '; spawning without the check' };
  if (behind === 0) return { status: 'ahead', source, fetch: fetchNote, submoduleFetch, sha: local, ahead };

  const refuse = (why) => fromLocal
    ? { status: 'from-local', source, fetch: fetchNote, submoduleFetch, sha: local, ahead, behind, warning: why + ' (--from-local given: spawning from it anyway)' }
    : { status: 'refused', source, fetch: fetchNote, submoduleFetch, ahead, behind, refuse: true, error: why + '. Update local ' + def + ', or pass --from-local to spawn from it anyway.' };
  // A SUBMODULE's stale <def> must say so: `git worktree list` reports its
  // checkout as <meta>/.git/modules/<name>, and "local main is behind" alone
  // reads as the meta-repo. The submodule is named by its path in the
  // superproject (else by its .git/modules/<name> dir); meta-repo wording is
  // unchanged. Location comes from the one canonical resolver (identity.js).
  let submodule = null;
  let idc = null;
  try { idc = identityContext(cwd); } catch (_) { idc = null; }
  if (idc && idc.superproject && idc.toplevel) submodule = path.relative(idc.superproject, idc.toplevel).split(path.sep).join('/') || null;
  const staleLine = (submodule ? 'submodule ' + submodule + ': ' : '')
    + 'local ' + def + ' is ' + behind + ' commit' + (behind === 1 ? '' : 's') + ' behind ' + remoteRef
    + '; spawning from it would give the child outdated tools';
  if (ahead > 0) return refuse(staleLine + ' (it also has ' + ahead + ' local commit' + (ahead === 1 ? '' : 's') + ' not on ' + remoteRef + ', so it cannot be fast-forwarded)');

  // Pure fast-forward. Where is <def> checked out (if anywhere)?
  let checkedOutAt = null;
  const wl = out(git(['worktree', 'list', '--porcelain']));
  if (wl === null) return refuse(staleLine + ' (could not list worktrees to update it safely)');
  let wt = null;
  for (const line of wl.split('\n')) {
    if (line.startsWith('worktree ')) wt = line.slice('worktree '.length);
    else if (line === 'branch refs/heads/' + def) { checkedOutAt = wt; break; }
  }
  let r;
  if (checkedOutAt) {
    const st = spawnSync('git', ['-C', checkedOutAt, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', timeout: gitTruth.GIT_TIMEOUT_MS });
    const dirty = out(st);
    if (dirty === null || dirty !== '') {
      const modDir = /[\\/]\.git[\\/]modules[\\/](.+)$/.exec(checkedOutAt);
      if (submodule || modDir) {
        const line = submodule ? staleLine : 'submodule ' + modDir[1].split(/[\\/]modules[\\/]/).join('/').replace(/\\/g, '/') + ': ' + staleLine;
        return refuse(line + ' (has local changes, so it was not auto-updated)');
      }
      return refuse(staleLine + ' (' + def + ' is checked out at ' + checkedOutAt + ' with local changes, so it was not updated)');
    }
    r = spawnSync('git', ['-C', checkedOutAt, 'merge', '--ff-only', '--quiet', 'refs/remotes/' + remoteRef], { encoding: 'utf8', timeout: SPAWN_FETCH_TIMEOUT_MS });
  } else {
    r = git(['update-ref', '-m', 'anti-hall spawn: fast-forward to ' + remoteRef, 'refs/heads/' + def, remote, local]);
  }
  if (!r || r.error || r.signal || r.status !== 0) return refuse(staleLine + ' (fast-forward failed: ' + String((r && (r.stderr || (r.error && r.error.message))) || 'unknown').trim().split('\n')[0] + ')');
  return { status: 'fast-forwarded', source, fetch: fetchNote, submoduleFetch, from: local, sha: remote, behind };
}

const SPAWN_CREATE_TIMEOUT_MS_DEFAULT = 180000;

// submodulePathsFor(cwd) -> string[] | null. Best-effort read of `.gitmodules`
// at cwd's root (a linked worktree's own `.gitmodules` is a normal tracked
// file, not the git-dir indirection gitCommonDirFor guards against) for the
// `path = ...` of each declared submodule. null when unreadable/absent —
// callers fall back to the text-shape heuristic, never fabricate a list.
function submodulePathsFor(cwd) {
  if (!cwd) return null;
  try {
    const text = fs.readFileSync(path.join(cwd, '.gitmodules'), 'utf8');
    const paths = [];
    const re = /^\s*path\s*=\s*(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(text))) paths.push(m[1]);
    return paths.length ? paths : null;
  } catch (_) { return null; }
}


// submoduleGitDir(common, wt, S) -> the submodule's own git dir under the superproject's common dir.
// `.git/modules/<name>` is keyed by the submodule NAME (usually == path); read the name from the
// worktree's .gitmodules, fall back to the path.
function submoduleGitDir(common, wt, S) {
  try {
    const text = fs.readFileSync(path.join(wt, '.gitmodules'), 'utf8');
    const re = /\[submodule\s+"([^"]+)"\]([^\[]*)/g;
    let m;
    while ((m = re.exec(text))) {
      const pm = /^\s*path\s*=\s*(.+?)\s*$/m.exec(m[2]);
      if (pm && pm[1] === S) {
        const cand = path.join(common, 'modules', m[1]);
        if (fs.existsSync(cand)) return cand;
      }
    }
  } catch (_) { /* fall through */ }
  return path.join(common, 'modules', S);
}

// fetchMissingSubmoduleCommit(modGit, sha) -> { ok, fetched, error? }. If `sha` is already a commit in
// the submodule's object store: nothing to do. Else `git fetch origin` (then, if still absent, `fetch origin
// <sha>`), each bounded. Fetch only ADDS objects/refs; nothing is moved or deleted. Never throws.
function fetchMissingSubmoduleCommit(modGit, sha) {
  const g = (args) => spawnSync('git', ['-C', modGit].concat(args), { encoding: 'utf8', timeout: SPAWN_FETCH_TIMEOUT_MS });
  const have = () => { const r = g(['cat-file', '-e', sha + '^{commit}']); return r.status === 0; };
  try {
    if (have()) return { ok: true, fetched: false };
    const errs = [];
    const f1 = g(['fetch', '--quiet', 'origin']);
    if (f1.status !== 0) errs.push(String(f1.stderr || f1.error || 'fetch failed').trim().split('\n').pop());
    if (have()) return { ok: true, fetched: true };
    const f2 = g(['fetch', '--quiet', 'origin', sha]);
    if (f2.status !== 0) errs.push(String(f2.stderr || f2.error || 'fetch of commit failed').trim().split('\n').pop());
    if (have()) return { ok: true, fetched: true };
    return { ok: false, fetched: false, error: errs.filter(Boolean).join('; ') || 'commit not found on origin' };
  } catch (e) { return { ok: false, fetched: false, error: String(e && e.message || e) }; }
}

// preflightSubmoduleCommits(cwd, rest) -> { fetched: [{path, sha}], failed: [{path, sha, error}] }.
// `hivecontrol workspace create` runs `git worktree add -b <branch> <wt>/<sub> <pinned-sha>` per submodule from
// the LOCAL module clone; a pinned sha pushed to the submodule's remote after that clone last fetched makes it
// die with `fatal: invalid reference` (field defect). Before create: for each declared submodule, resolve the sha
// the source ref pins and, if the local module lacks it, fetch it. Bounded, fail-open (a failure is reported in
// `failed`, never throws, never blocks the create).
function preflightSubmoduleCommits(cwd, rest) {
  const res = { fetched: [], failed: [] };
  try {
    const paths = submodulePathsFor(cwd);
    if (!paths) return res;
    const common = gitCommonDirFor(cwd);
    if (!common) return res;
    const src = extractFlagValue(rest, '-s', '--source');
    const refs = src ? [src, 'origin/' + src] : ['HEAD'];
    const g = (args) => spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', timeout: SPAWN_FETCH_TIMEOUT_MS });
    for (const S of paths) {
      let sha = null;
      for (const ref of refs) {
        const r = g(['rev-parse', '--verify', '--quiet', ref + ':' + S]);
        if (r.status === 0 && /^[0-9a-f]{40}$/.test(String(r.stdout).trim())) { sha = String(r.stdout).trim(); break; }
      }
      if (!sha) continue;
      const modGit = submoduleGitDir(common, cwd, S);
      if (!fs.existsSync(modGit)) continue; // submodule never initialised locally: nothing to fetch into
      const fe = fetchMissingSubmoduleCommit(modGit, sha);
      if (!fe.ok) res.failed.push({ path: S, sha, error: fe.error });
      else if (fe.fetched) res.fetched.push({ path: S, sha });
    }
  } catch (_) { /* fail-open */ }
  return res;
}

// parseSubmoduleWorktreeFailures(res, cwd) -> [{ path, error }]. TOLERANT,
// TEXT-based extraction (hivecontrol's `workspace create` does NOT document a
// per-submodule failure JSON shape — the KB has no pinned field for it, and
// inventing one here would be exactly the kind of guessed structure this
// file's own comments warn against). Field evidence (a downstream project,
// fix/devswarm-spawn-local-submodules): `create` can report overall
// `ok:true` even when ONE of several `git worktree add` calls it runs for a
// multi-repo/submodule workspace fails ("fatal: '<path>' already exists"),
// because that failure is only visible in the subprocess's own stderr/stdout
// text, never in a structured field.
//
// NARROWED (fixed defect): the original generic `fatal:\s*(.+)` fallback
// matched ANY fatal: line from the whole create invocation — including one
// with nothing to do with a submodule worktree at all (`fatal: no upstream
// configured` from an unrelated git call the same subprocess happened to run)
// — and reported it as a submodule failure. Every match is now gated to
// something ACTUALLY tied to submodule worktree creation: the `fatal:
// '<path>' already exists` shape only counts when `<path>` is a submodule
// dir listed in `.gitmodules` (when readable via `cwd`) or the combined text
// otherwise shows an actual `git worktree add` invocation; a bare `fatal:`
// line only counts when it itself mentions `worktree` or names a known
// submodule path. `cwd` is optional — omitted (or `.gitmodules` unreadable),
// the `worktree`-mention heuristic is the only gate; never throws; an
// unparseable/absent res -> [].
function parseSubmoduleWorktreeFailures(res, cwd) {
  const out = [];
  if (!res) return out;
  const text = [res.raw, res.stderr].filter((s) => typeof s === 'string' && s).join('\n');
  if (!text) return out;
  const submodulePaths = submodulePathsFor(cwd);
  const isKnownSubmodulePath = (p) => Array.isArray(submodulePaths)
    && submodulePaths.some((sp) => p === sp || p.endsWith('/' + sp));
  const mentionsWorktree = /\bworktree\b/i.test(text);
  const seen = new Set();
  const exists = /fatal:\s*'([^']+)'\s*already exists/g;
  let m;
  while ((m = exists.exec(text))) {
    const p = m[1];
    if (!(isKnownSubmodulePath(p) || mentionsWorktree)) continue; // not tied to a submodule worktree add
    const key = 'exists:' + p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p, error: 'already exists' });
  }
  const existsLine = /fatal:\s*'[^']+'\s*already exists/;
  const generic = /fatal:\s*(.+)/g;
  while ((m = generic.exec(text))) {
    if (existsLine.test(m[0])) continue; // already captured above with its path
    const line = m[1].trim();
    const mentionsSubmodulePath = Array.isArray(submodulePaths) && submodulePaths.some((sp) => line.includes(sp));
    // CONTEXT ATTRIBUTION (field defect: `fatal: invalid reference: <sha>` was silently dropped): git's own
    // fatal line carries neither "worktree" nor the path; the create output echoes the failing command on
    // the line before it (`git worktree add -b <branch> <path> <sha>`). A fatal that directly follows such an
    // echo (no other `fatal:` in between) belongs to that submodule worktree add, and gives us its path.
    const before = text.slice(Math.max(0, m.index - 600), m.index);
    const echoes = before.match(/git worktree add\b[^\n]*?(?=\\n|\n|$)/g);
    const echo = echoes && echoes.length ? echoes[echoes.length - 1] : null;
    const afterEcho = echo ? before.slice(before.lastIndexOf(echo) + echo.length) : '';
    const tiedByEcho = !!echo && !/fatal:/.test(afterEcho);
    if (!(/\bworktree\b/i.test(line) || mentionsSubmodulePath || tiedByEcho)) continue; // not tied to a submodule worktree add
    let failPath = null;
    if (tiedByEcho) {
      const pm = /git worktree add\s+(?:-b\s+\S+\s+)?(\S+)/.exec(echo);
      if (pm) failPath = pm[1].replace(/^['"]|['"]$/g, '');
    }
    const key = 'generic:' + line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: failPath, error: line });
  }
  return out;
}

// repairSubmoduleWorktrees(failures, text, branch, cwd) -> { repaired, remaining }
// (0.120.8, a downstream project field defect, 3rd occurrence). ROOT CAUSE (proven from the
// DevSwarm app's own source + its log): `workspace create` starts the
// `worktreeInclude` copy (`.devswarm/config.json`, e.g. `appflutter/.env`) in
// the BACKGROUND (`copyUntrackedFiles`, not awaited) and then runs
// `git worktree add -b <branch> <wt>/<sub> <sha>` per submodule. The copy does
// `mkdir -p <wt>/<sub>` + `cp -Rp`, so the submodule dir is NON-EMPTY when
// `worktree add` runs -> git refuses ("'<path>' already exists"). Only a
// submodule that has an include file present is hit (appflutter/.env exists;
// mailerapp/.env.local and appwebsite/.env did not). A later workspace setup
// step may remove the dir, which is why it can look "missing" afterwards while
// the branch (created by the failed attempt chain) remains. The fix belongs to
// DevSwarm (await the copy / skip gitlink paths); this is the loss-free
// client-side repair, run only for the exact `already exists` shape:
//   - path is an EMPTY dir          -> rmdir it (never recursive)
//   - path is a NON-EMPTY dir       -> rename it aside, add the worktree, move
//                                      the pre-copied files back when they do
//                                      not collide, rmdir the aside if empty
//                                      (anything left stays on disk, reported)
//   - branch already exists         -> `worktree add <path> <branch>` (no -b)
//   - stale registration for path   -> `git worktree prune` (git only drops
//                                      entries whose dir is gone)
//   - path already a live checkout (has .git) -> left alone, still reported
// Never deletes content, never touches another worktree, fail-open: any
// problem leaves the failure in `remaining`.
function repairSubmoduleWorktrees(failures, text, branch, cwd) {
  const repaired = [];
  const remaining = [];
  const subPaths = submodulePathsFor(cwd);
  const g = (dir, args) => spawnSync('git', ['-C', dir].concat(args), { encoding: 'utf8', timeout: 60000 });
  for (const f of (failures || [])) {
    const P = f && f.path;
    const S = Array.isArray(subPaths) && typeof P === 'string' && path.isAbsolute(P)
      ? subPaths.find((sp) => P.endsWith('/' + sp)) : null;
    const missingObject = !!(f && /invalid reference|not a valid object name|unable to read tree|bad object/i.test(String(f.error || '')));
    if (!S || (f.error !== 'already exists' && !missingObject)) { remaining.push(f); continue; }
    let aside = null;
    try {
      const wt = P.slice(0, -(S.length + 1));
      const common = gitCommonDirFor(wt);
      if (!common) { remaining.push(f); continue; }
      const modGit = submoduleGitDir(common, wt, S);
      // Presence of the submodule worktree's own link file (not identity resolution).
      const linkFile = path.join(P, '.git');
      if (!fs.existsSync(modGit) || fs.existsSync(linkFile)) { remaining.push(f); continue; }
      let b = branch;
      let sha = null;
      const esc = P.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // The create text can be JSON-escaped (a literal backslash-n follows the sha), so `\S+` would
      // swallow "<sha>\nCommand ..." into the sha: capture exactly 40 hex and nothing else.
      const cm = new RegExp('git worktree add -b (\\S+) ' + esc + ' ([0-9a-f]{40})(?![0-9a-f])').exec(text || '');
      if (cm) { b = cm[1]; sha = cm[2]; }
      if (!b) { remaining.push(f); continue; }
      if (!sha) { const r = g(wt, ['rev-parse', 'HEAD:' + S]); if (r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim())) sha = r.stdout.trim(); }
      // The pinned commit may exist only on the submodule's remote (pushed after the local module clone
      // last fetched): fetch it (bounded, fail-open) before retrying the add.
      if (missingObject && sha) {
        const fe = fetchMissingSubmoduleCommit(modGit, sha);
        if (!fe.ok) throw new Error('pinned commit ' + sha + ' is missing from the local submodule clone and could not be fetched: ' + fe.error);
      }
      const movedBack = [];
      let st = null;
      try { st = fs.lstatSync(P); } catch (_) { st = null; }
      if (st && !st.isDirectory()) { remaining.push(f); continue; }
      if (st) {
        if (fs.readdirSync(P).length === 0) fs.rmdirSync(P);
        else {
          // Unique, inside the workspace's own dir (never /tmp): same filesystem, rename is atomic.
          let n = 0;
          do { aside = P + '.pre-wt-' + process.pid + '-' + Date.now().toString(36) + (n ? '-' + n : ''); n++; } while (fs.existsSync(aside));
          fs.renameSync(P, aside);
        }
      }
      const wl = g(modGit, ['worktree', 'list', '--porcelain']);
      const listing = wl.status === 0 ? wl.stdout : '';
      // git lists realpaths (macOS /var -> /private/var); compare like with like.
      const real = (x) => { try { return fs.realpathSync(path.dirname(x)) + '/' + path.basename(x); } catch (_) { return x; } };
      const realP = real(P);
      const blocks = listing.split('\n\n').map((blk) => ({ dir: blk.split('\n')[0].slice('worktree '.length), blk }));
      if (blocks.some((x) => x.dir === P || x.dir === realP)) g(modGit, ['worktree', 'prune']);
      const other = blocks.find((x) => x.blk.indexOf('branch refs/heads/' + b + '\n') !== -1 || x.blk.endsWith('branch refs/heads/' + b));
      if (other && other.dir !== P && other.dir !== realP && fs.existsSync(other.dir)) throw new Error('branch ' + b + ' is checked out in another worktree');
      const exists = g(modGit, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b]).status === 0;
      const addArgs = exists ? ['worktree', 'add', P, b]
        : (sha ? ['worktree', 'add', '-b', b, P, sha] : ['worktree', 'add', '-b', b, P]);
      const add = g(modGit, addArgs);
      if (add.status !== 0 || !fs.existsSync(linkFile)) throw new Error(String(add.stderr || 'worktree add failed').trim().split('\n').pop());
      let leftover = null;
      const conflicts = [];
      const identical = [];
      const warnings = [];
      if (aside) {
        // Move back ONLY into free slots: never overwrite or merge into anything the checkout made.
        for (const e of fs.readdirSync(aside)) {
          const src = path.join(aside, e);
          const dest = path.join(P, e);
          let taken = true;
          try { fs.lstatSync(dest); } catch (_) { taken = false; }
          if (!taken) { fs.renameSync(src, dest); movedBack.push(e); continue; }
          // Byte-identical regular files are not a conflict. The aside copy is one THIS tool moved
          // aside, so dropping the duplicate loses nothing; anything that differs is kept.
          let same = false;
          try {
            const a = fs.lstatSync(src);
            const d = fs.lstatSync(dest);
            same = a.isFile() && d.isFile() && fs.readFileSync(src).equals(fs.readFileSync(dest));
          } catch (_) { same = false; }
          if (same) { fs.unlinkSync(src); identical.push(e); continue; }
          conflicts.push({
            file: e,
            inPlace: dest,
            kept: src,
            note: 'the checked-out copy at ' + dest + ' is in place; the differing copy was kept at ' + src,
          });
        }
        try { fs.rmdirSync(aside); } catch (_) { leftover = aside; } // non-recursive: only when empty
        if (leftover) {
          let names = [];
          try { names = fs.readdirSync(leftover); } catch (_) { names = []; }
          const secretLike = names.filter((n) => /^\.env/.test(n) || /\.pem$/i.test(n) || /^credentials/i.test(n));
          if (secretLike.length) {
            warnings.push('A leftover directory ' + leftover + ' holds secret-like file(s) (' + secretLike.join(', ')
              + ') in the workspace root; review it and remove it yourself, spawn never deletes it.');
          }
        }
        aside = null;
      }
      repaired.push({
        path: P, branch: b, sha, reusedBranch: exists, movedBack,
        identical: identical.length ? identical : undefined,
        conflicts: conflicts.length ? conflicts : undefined,
        leftoverAside: leftover || undefined,
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (e) {
      // Put a moved-aside dir back so nothing is lost, then report the failure.
      if (aside) { try { if (!fs.existsSync(P)) fs.renameSync(aside, P); } catch (_) { /* left aside on disk */ } }
      remaining.push(Object.assign({}, f, { repairError: String(e && e.message || e) }));
    }
  }
  return { repaired, remaining };
}

// spawnFlagValueError(rest) -> string | null (0.112). `hivecontrol workspace
// create`'s value-taking options are -s/--source, -a/--agent, -p/--prompt and
// -t/--title. A value that is really the NEXT option (`spawn b -s main -t -p
// "brief"` made "-p" the title and dropped the brief) is refused up front,
// before anything is fetched or created. -s/-a/-t refuse any value starting
// with "-"; -p refuses only an option-shaped value (a single "-x"/"--xx" token),
// because a real brief can start with a markdown bullet ("- fix the thing").
// A value-taking flag with no value at all is refused too. Setting
// devswarm.spawnStrictFlagValues (default true) turns the check off.
const SPAWN_VALUE_FLAGS = [
  { short: '-s', long: '--source', anyDash: true },
  { short: '-a', long: '--agent', anyDash: true },
  { short: '-t', long: '--title', anyDash: true },
  { short: '-p', long: '--prompt', anyDash: false },
];
function spawnFlagValueError(rest) {
  if (!Array.isArray(rest)) return null;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string') continue;
    for (const f of SPAWN_VALUE_FLAGS) {
      let value;
      let name;
      if (a === f.short || a === f.long) { name = a; value = rest[i + 1]; }
      else if (a.indexOf(f.long + '=') === 0) { name = f.long; value = a.slice(f.long.length + 1); }
      else continue;
      const label = f.short + '/' + f.long;
      if (typeof value !== 'string' || value === '') {
        return 'spawn: ' + label + ' needs a value, but none was given after ' + name + '.';
      }
      const bad = f.anyDash ? value.startsWith('-') : /^--?[A-Za-z][\w-]*(?:=\S*)?$/.test(value);
      if (bad) {
        return 'spawn: ' + label + ' got ' + JSON.stringify(value) + ' as its value, which looks like another option. '
          + 'Give ' + name + ' a real value (quote it), e.g. `spawn <branch> ' + f.short + ' "<value>"`.';
      }
      if (name === a) i++; // skip the consumed value
    }
  }
  return null;
}

function cmdSpawn(rest, ctx) {
  const branch = rest && rest[0];
  if (!branch) return { ok: false, error: 'spawn requires a branch name' };
  let strictFlagValues = true;
  try { strictFlagValues = require('../../hooks/lib/settings.js').get('devswarm', 'spawnStrictFlagValues', true, { env: ctx.env || process.env, home: ctx.home }) !== false; } catch (_) { strictFlagValues = true; }
  if (strictFlagValues) {
    const flagError = spawnFlagValueError(rest);
    if (flagError) return { ok: false, action: 'spawn', branch, created: false, error: flagError };
  }
  const cwd = ctx.cwd || process.cwd();
  const run = (ctx.io && ctx.io.run) || hcRun;
  const env = ctx.env || process.env;
  const timings = {};
  const spawnWallStart = Date.now();
  // `--from-local` is anti-hall's own flag (hivecontrol would reject it) — the
  // one token stripped before the otherwise untouched pass-through.
  let sourceCheck;
  const fetchStart = Date.now();
  try { sourceCheck = spawnSourceFreshness(rest, ctx); } catch (e) { sourceCheck = { status: 'skipped', warning: 'source check failed: ' + String(e && e.message || e) }; }
  timings.sourceCheckMs = Date.now() - fetchStart;
  if (sourceCheck.refuse) return { ok: false, action: 'spawn', branch, created: false, error: sourceCheck.error, sourceCheck, timings: Object.assign(timings, { totalMs: Date.now() - spawnWallStart }) };
  const args = ['workspace', 'create'].concat(rest.filter((a) => a !== '--from-local'));
  // RECENCY FLOOR for the launch check below — captured BEFORE `create` so any
  // evidence produced during the create call still counts, while anything that
  // predates this spawn entirely (a prior occupant of a reused branch/worktree,
  // whose meshId is identical because meshIds derive from the worktree PATH)
  // does not. See checkSpawnLaunch's header.
  const spawnStartedAt = Date.now();
  // CREATE TIMEOUT (0.109.0, spawn speed): `hivecontrol workspace create` had
  // NO timeout at all (companion/lib/devswarm-pull.js defaultRun only applies
  // one when the caller passes it) — a wedged hivecontrol process could block
  // this verb forever. `spawnSync`'s own `timeout` only ever kills ITS OWN
  // child (never anything else), same guarantee every other timed call in
  // this file already relies on.
  let createTimeoutMs = SPAWN_CREATE_TIMEOUT_MS_DEFAULT;
  try { createTimeoutMs = require('../../hooks/lib/settings.js').get('devswarm', 'spawnCreateTimeoutMs', SPAWN_CREATE_TIMEOUT_MS_DEFAULT, { env, home: ctx.home }); } catch (_) { createTimeoutMs = SPAWN_CREATE_TIMEOUT_MS_DEFAULT; }
  if (!(Number.isFinite(createTimeoutMs) && createTimeoutMs > 0)) createTimeoutMs = SPAWN_CREATE_TIMEOUT_MS_DEFAULT;
  // Fetch any submodule commit the source pins but the local module clone lacks, BEFORE create runs its
  // per-submodule `git worktree add` (see preflightSubmoduleCommits). Not counted in createMs.
  const preStart = Date.now();
  const submodulePreflight = preflightSubmoduleCommits(cwd, rest);
  timings.submodulePreflightMs = Date.now() - preStart;
  const createStart = Date.now();
  const res = run({ args, env: ctx.env, cwd, timeout: createTimeoutMs });
  timings.createMs = Date.now() - createStart;
  if (!res || !res.ok) {
    // TIMEOUT DETECTION: `res.timedOut` is defaultRun's own explicit flag
    // (companion/lib/devswarm-pull.js, off `r.error.code === 'ETIMEDOUT'`);
    // the `res.signal && res.status == null` check is kept ONLY as a fallback
    // for an injected `io.run` (tests, alternate runners) that reports the
    // signal shape without the `timedOut` flag.
    const timedOut = !!(res && (res.timedOut || (res.signal && res.status == null)));
    const error = (res && res.error) || 'hivecontrol workspace create failed';
    // PARTIAL WORKSPACE ON TIMEOUT: the create subprocess was killed mid-flight
    // — hivecontrol may have already created the worktree/branch before the
    // kill landed. Report that plainly, name the exact branch, and say how to
    // check — NEVER auto-clean or delete anything here.
    const timeoutError = 'workspace create timed out after ' + createTimeoutMs + 'ms'
      + ' (only the create subprocess was killed, nothing else). A partial workspace for'
      + ' branch "' + branch + '" may already exist — check with `git worktree list` in this'
      + ' repo or `devswarm list`; nothing was deleted automatically.';
    return {
      ok: false,
      error: timedOut ? timeoutError : error,
      branch, sourceCheck, timings: Object.assign(timings, { totalMs: Date.now() - spawnWallStart }),
    };
  }
  // SUBMODULE WORKTREE FAILURES (0.109.0, field defect): `create` can return
  // ok:true overall while one of several submodule worktree adds it ran
  // failed — see parseSubmoduleWorktreeFailures's own header. NEVER flips
  // `ok` (the workspace itself was created and may still be perfectly usable
  // for the primary repo) and NEVER auto-repaired — report only.
  const parsedSubmoduleFailures = parseSubmoduleWorktreeFailures(res, cwd);
  const submoduleText = [res.raw, res.stderr].filter((x) => typeof x === 'string' && x).join('\n');
  let submoduleRepair = { repaired: [], remaining: parsedSubmoduleFailures };
  try { submoduleRepair = repairSubmoduleWorktrees(parsedSubmoduleFailures, submoduleText, branch, cwd); } catch (_) { /* fail-open: report the original failures */ }
  const submoduleFailures = submoduleRepair.remaining;
  const submoduleRepaired = submoduleRepair.repaired;

  // Title derivation is pure/no I/O — computed up front, but the actual
  // update-title CALL only fires inside the worktreePath-resolved branch
  // below (see doc comment above for why).
  let derivedTitle = null;
  if (hasSpawnFlag(rest, '-t', '--title')) {
    // Defect (field report v0.106.0): `spawn <branch> -t "<title>"` returned
    // `titled:false` and the roster showed the raw meshId for every lane —
    // TRACED to this branch: an explicit `-t`/`--title` is forwarded VERBATIM
    // to `hivecontrol workspace create` (the THIN pass-through contract this
    // file's own tests pin), but `create` does NOT itself apply a title —
    // that is exactly why the SEPARATE `update-title` follow-up below exists
    // at all (see the "CORRECTED design" comment above, and its own history:
    // an earlier draft injected `-t` into `create`'s argv and that was
    // reverted). Treating "the caller already passed -t" as "titling is
    // someone else's problem" meant NEITHER side ever actually set it:
    // hivecontrol's create silently dropped it, and this function skipped
    // its own update-title call too. Extract the value the caller passed and
    // run the SAME update-title follow-up with it — the native side and the
    // local name cache (below) both end up titled either way.
    derivedTitle = extractFlagValue(rest, '-t', '--title');
  } else {
    derivedTitle = deriveTitleFromBrief(extractFlagValue(rest, '-p', '--prompt'));
  }

  let registered = false;
  let titled = false;
  let worktreePath = null;
  let meshId = null;
  try {
    // hivecontrol's own `create` output shape is NOT pinned in the KB, so this
    // is a TOLERANT best-effort parse (same posture as this file's own
    // parseChildrenList) for a `path`/`worktreePath` field — NEVER a guessed
    // directory-naming convention. `ctx.io.newWorktreePath` is the explicit
    // test/override seam. Absent a resolvable path, registration (and the
    // title follow-up) is best-effort-skipped (`registered:false`/
    // `titled:false` are legitimate reported outcomes — never a failure of
    // the verb itself, which already succeeded at the create call above).
    worktreePath = (ctx.io && ctx.io.newWorktreePath) || resolveCreatedWorktreePath(res);
    if (worktreePath) {
      meshId = inst.primaryWorkspaceId(worktreePath);
      const repoKey = repoKeyForCwd(ctx);
      const s = store.openStore({ home: ctx.home, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
      try {
        // No per-id lock here (verified race-free, NOT an oversight): `meshId` is
        // derived from a worktreePath `hivecontrol workspace create` JUST minted
        // above — a brand-new id no other process has seen yet. This is a blind
        // SEED insert (all descriptor fields null), not a read-modify-write, so
        // there is no snapshot to lose. No concurrent writer can touch this id at
        // this instant: a second `spawn` of the same branch fails at the `create`
        // call above (worktree already exists) and never reaches here, and the
        // workspace's own child cannot `register` until it is launched in the
        // freshly-created worktree — strictly AFTER this call returns. That later
        // child register runs under withIdLock and upserts its real inbox over this
        // placeholder; the two are ordered, never interleaved. A lock would guard
        // nothing (see rekeySubdirRegistryRows for a case that genuinely needs one).
        s.upsertRegistry({ id: meshId, worktreePath, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
        store.deriveSummary(s, { home: ctx.home, env: ctx.env, now: ctx.now });
        registered = true;
      } finally { s.close(); }

      // Title follow-up (task #6, corrected design): a SEPARATE hivecontrol
      // call, entirely independent of the `create` argv above. Best-effort —
      // never re-throws into the caller, never fails the spawn verb.
      if (derivedTitle) {
        try {
          const tres = run({ args: ['workspace', 'update-title', '-b', branch, derivedTitle], env: ctx.env, cwd });
          titled = !!(tres && tres.ok);
        } catch (_) { titled = false; }
        // Cache ONLY when hivecontrol actually confirmed the title — never
        // cache a name we don't know was really applied (the local cache
        // must stay a mirror of real state, not a hopeful guess).
        if (titled) { try { names.writeName(ctx.home, meshId, derivedTitle, ctx.now); } catch (_) { /* best-effort */ } }
      }
    }
  } catch (_) { registered = false; }

  // PLAN TRACKING (Meeseeks P1): a numbered step list in `-p` becomes the
  // workspace's plan file, keyed by the new worktree. Encouraged, never
  // required: spawn is never refused for a brief without one (the result
  // carries a hint instead). `base` is the new worktree's starting commit —
  // the exact fork point the supervisor's off-scope diff measures from.
  let planInfo;
  try {
    const brief = extractFlagValue(rest, '-p', '--prompt');
    if (brief !== null && planLib.planTrackingEnabled({ env, home: ctx.home })) {
      const steps = planLib.parseSteps(brief);
      const key = planLib.planKeyForWorktree(worktreePath);
      if (steps.length && key) {
        let base = null;
        try {
          const r = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
          if (r && r.status === 0) base = String(r.stdout || '').trim() || null;
        } catch (_) { base = null; }
        const plan = planLib.newPlan({
          key, id: meshId, worktreePath, steps, scope: planLib.parseScope(brief), base, source: 'spawn',
          now: Number.isFinite(ctx.now) ? ctx.now : Date.now(),
        });
        const pw = planLib.updatePlan(ctx.home, key, () => plan);
        if (!pw || !pw.ok) throw new Error('the plan file is locked by another writer');
        supervisionMetrics.record(ctx.home, 'plan', { now: plan.created_at, id: meshId, key, source: 'spawn', steps: steps.length });
        planInfo = { written: true, key, steps: steps.length, scope: plan.scope_globs };
      } else {
        planInfo = {
          written: false, reason: steps.length ? 'no-worktree' : 'no-numbered-steps',
          hint: 'a numbered step list ("1. …" "2. …") in -p lets the roster show step progress and the supervisor spot a stalled or off-scope child; the child can still add one with `devswarm.js plan set <id> --steps …`',
        };
        if (planLib.planRequired({ env, home: ctx.home })) planInfo.required = true;
      }
    }
  } catch (e) { planInfo = { written: false, reason: 'error', error: String((e && e.message) || e) }; }

  // LAUNCH VERIFICATION — see checkSpawnLaunch's header. Only meaningful once a
  // meshId resolved (no path -> nothing to poll for); best-effort in every
  // direction, and it can never fail the verb or change `created`/`registered`.
  let launch = { launched: 'unknown', evidence: null, waitedMs: 0, windowMs: spawnLaunchWaitMs(ctx.env) };
  if (meshId) {
    try {
      const repoKey = repoKeyForCwd(ctx);
      launch = checkSpawnLaunch(meshId, ctx, () => store.openStore({
        home: ctx.home, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env,
      }), { since: spawnStartedAt });
    } catch (_) { launch = { launched: 'unknown', evidence: null, waitedMs: 0, windowMs: spawnLaunchWaitMs(ctx.env) }; }
  }

  // INVESTIGATION NOTE (field report, submodule create failure): `launched`
  // staying 'unknown' here is NOT a parsing bug on our side — checkSpawnLaunch
  // only ever reports evidence the CHILD's own session produced (a heartbeat,
  // a self-register, a descriptor file), and by design never reports `false`
  // (see checkSpawnLaunch's header: absence within a short window is not
  // proof of failure). When a submodule worktree failed, it is plausible
  // hivecontrol never opened an AI terminal for the workspace at all — in
  // which case 'unknown' is the CORRECT, honest answer (nothing launched, so
  // there is genuinely no evidence to find), not a bug to "fix" by fabricating
  // `false`. The submodule failure is reported instead, below, so the caller
  // has the likely explanation without this verb ever guessing at hivecontrol's
  // own internal behavior.
  const launchHintSubmoduleNote = (submoduleFailures.length && launch.launched !== true)
    ? ' A submodule worktree failed to create (' + (submoduleFailures[0].path || submoduleFailures[0].error)
      + ') — this may be why no session ever started; this was NOT auto-repaired.'
    : '';

  const sourceNote = sourceWorkspaceNote(rest, ctx);
  timings.totalMs = Date.now() - spawnWallStart;
  try {
    alog.logEvent('devswarm-cli', 'spawn', 'info', 'spawn timings', {
      branch, sourceCheckStatus: sourceCheck && sourceCheck.status, fetch: sourceCheck && sourceCheck.fetch,
      timings, submoduleFailureCount: submoduleFailures.length,
    });
  } catch (_) { /* fail-open: logging must never break the verb */ }

  // WAKE COVERAGE after the spawn: a Primary whose cron died with its harness
  // (and whose watcher idle-skipped) gets no wake cue anywhere else, so say it
  // here, once, in `warnings`. Fail-open: any error -> no warning.
  let wakeWarning = null;
  try {
    if (!core.isChildWorkspace(env)) {
      const pid = require('../../companion/lib/identity.js').resolveContext(cwd, { home: ctx.home, missingPath: 'ancestor' }).meshId || null;
      if (pid) {
        const cov = require('../../companion/lib/devswarm-wake-coverage.js').wakeCoverage({ home: ctx.home, cwd, id: pid, env });
        cov.liveChildren = !cov.unknown; // a workspace was just created
        wakeWarning = core.wakeLib.noWakePathLine(cov, env,
          core.resolveStableCliPath(ctx.home, core.CLI_PATH),
          core.resolveStableLauncherPath('wakeWatch', ctx.home, path.join(core.PLUGIN_ROOT, 'companion', 'lib', 'devswarm-wake-watch.js')),
          pid) || null;
      }
    }
  } catch (_) { wakeWarning = null; }

  const result = {
    ok: true, action: 'spawn', branch, created: true,
    worktreePath, meshId, registered, titled,
    // How the child's source branch was vetted against origin (0.108.5).
    sourceCheck,
    // Present ONLY when at least one submodule worktree failed — absent, not
    // `[]`, so "checked and clean" and "never checked" stay distinguishable.
    // NEVER flips `ok` — the workspace itself was created and may still be
    // usable for the primary repo; see parseSubmoduleWorktreeFailures header.
    submoduleFailures: submoduleFailures.length ? submoduleFailures : undefined,
    // Present ONLY when spawn repaired a submodule worktree that `create` failed
    // to make (see repairSubmoduleWorktrees) — the loss-free repair, never a delete.
    submoduleRepaired: submoduleRepaired.length ? submoduleRepaired : undefined,
    submoduleHint: (submoduleFailures.length || submoduleRepaired.length)
      ? 'Submodule worktrees are created at the superproject\'s pinned commit'
        + (submoduleRepaired.length && submoduleRepaired[0].sha ? ' (' + submoduleRepaired[0].sha + ')' : '')
        + ', not the submodule\'s default branch.'
      : undefined,
    // Present ONLY when the pre-create submodule fetch did something or failed.
    submodulePreflight: (submodulePreflight.fetched.length || submodulePreflight.failed.length) ? submodulePreflight : undefined,
    warnings: (submoduleFailures.length || submoduleRepaired.length || submodulePreflight.failed.length || sourceNote) ? [].concat(
      sourceNote ? [sourceNote] : [],
      submodulePreflight.failed.length ? [
        submodulePreflight.failed.length + ' submodule commit(s) pinned by the source are missing from the local submodule clone and '
        + 'could not be fetched before create (' + submodulePreflight.failed.map((x) => x.path + '@' + String(x.sha).slice(0, 12) + ': ' + x.error).join('; ')
        + '). Fetch them in the submodule, then re-create that submodule worktree.',
      ] : [],
      submoduleRepaired.length ? [
        submoduleRepaired.length + ' submodule worktree(s) failed at create (a pre-copied worktreeInclude file made the path '
        + 'non-empty) and were repaired by spawn — see submoduleRepaired.',
      ] : [],
      ...submoduleRepaired.reduce((acc, x) => acc.concat(x.warnings || []), []),
      submoduleFailures.length ? [
        submoduleFailures.length + ' of the workspace\'s submodule worktree(s) failed to create — see '
        + 'submoduleFailures (' + submoduleFailures.map((x) => (x.path || '?') + ': ' + (x.repairError || x.error)).join('; ')
        + '). ok stays true because the parent worktree was created and is usable; the affected '
        + 'submodule worktree(s) are missing/broken and were NOT auto-repaired.',
      ] : []) : undefined,
    // DISTINCT from `created`: the workspace exists, but a session running in it
    // is a separate fact with separate evidence. Never `false` — absence of a
    // signal inside a short window is not proof of failure (see header).
    launched: launch.launched,
    launchEvidence: launch.evidence,
    launchCheckedMs: launch.waitedMs,
    launchWindowMs: launch.windowMs,
    // Present ONLY when the configured window exceeded SPAWN_LAUNCH_WAIT_MAX_MS
    // and was capped — never let the caller believe a longer wait happened.
    launchWindowClamped: launch.launchWindowClamped,
    launchWindowRequestedMs: launch.launchWindowRequestedMs,
    launchHint: launch.launched === true ? undefined
      : 'created, but NO session has registered/heartbeated for ' + String(meshId || branch)
        + ' yet (checked ' + launch.waitedMs + 'ms). This is normal right after a spawn — a launch takes '
        + 'longer than this verb may block for. Confirm with `devswarm roster` in a minute — the child '
        + 'registers under its OWN workspace id; never heartbeat ' + String(meshId || '<meshId>')
        + ' yourself (a worktree label, not an identity). A row still showing sessionId null with a 0-byte '
        + 'heartbeat log after several minutes never launched.' + launchHintSubmoduleNote,
    // Per-phase durations (0.109.0, spawn speed): sourceCheckMs (the freshness
    // check, including any fetch), createMs (the hivecontrol create call),
    // totalMs (the whole verb). Also appended to the shared devswarm-cli log
    // (`devswarm.js logs --component devswarm-cli`), best-effort.
    timings,
    // Present only when `-p` was passed (see PLAN TRACKING above).
    plan: planInfo,
    raw: res.raw,
  };
  if (wakeWarning) result.warnings = (result.warnings || []).concat(wakeWarning);
  return result;
}

// cmdMergeVerb(rest, ctx) — PLAN.md "merge": THIN wrap of `hivecontrol
// workspace check-merge` (informational, always run first) + `hivecontrol
// workspace merge-into-source ...` (the documented "ship upstream" completion
// step — the standard child-finish flow this verb is named for; the OTHER
// direction, `merge-from-source`, stays a raw hivecontrol call, never
// blocked). `rest` forwards to merge-into-source untouched (pass-through —
// this verb never re-parses or gates on check-merge's own verdict; hivecontrol's
// own merge call reports its own success/failure faithfully). The outcome is
// then `send --broadcast` to the mesh so every peer sees a merge landed
// without needing to poll — best-effort: a broadcast failure (e.g. non-git
// cwd) never masks the merge's own result.
function cmdMergeVerb(rest, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const run = (ctx.io && ctx.io.run) || hcRun;

  const checkRes = run({ args: ['workspace', 'check-merge'], env: ctx.env, cwd });
  let checkMerge = null;
  if (checkRes && checkRes.ok) {
    try { checkMerge = JSON.parse(checkRes.raw); } catch (_) { checkMerge = null; }
  }

  const mergeArgs = ['workspace', 'merge-into-source'].concat(rest || []);
  const mergeRes = run({ args: mergeArgs, env: ctx.env, cwd });
  const merged = !!(mergeRes && mergeRes.ok);

  let broadcast = null;
  try {
    const repoKey = repokey.repoKeyForWorktree(cwd);
    if (!repoKey) {
      broadcast = { ok: false, reason: 'no-project' };
    } else {
      const from = senderIdentityDetailed(ctx.env, cwd, registrySnapshot(ctx, repoKey), ctx.home).identity;
      const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
      const summary = merged
        ? 'merge-into-source completed'
        : 'merge-into-source failed: ' + ((mergeRes && mergeRes.error) || 'unknown error');
      const s = store.openStore({ home: ctx.home, hash: repoKey, backend: ctx.backend, env: ctx.env });
      try {
        const fields = { from, to: null, type: 'broadcast', message: summary, timestamp: now, urgency: merged ? 'normal' : 'high' };
        const hash = store.meshMessageHash(fields);
        const bres = store.appendMeshMessage(s, Object.assign({}, fields, { hash, instanceNonce: dispatcherExports().deriveReaderNonce(ctx) }));
        store.deriveSummary(s, { home: ctx.home, env: ctx.env, now });
        broadcast = { ok: true, sent: !!bres.inserted, seq: bres.seq };
      } finally { s.close(); }
    }
  } catch (e) {
    broadcast = { ok: false, error: String(e && e.message || e) };
  }

  return {
    ok: merged, action: 'merge', checkMerge, merged,
    error: merged ? undefined : ((mergeRes && mergeRes.error) || 'merge-into-source failed'),
    raw: mergeRes && mergeRes.raw, broadcast,
  };
}

module.exports = {
  cmdRespawn, resolveCreatedWorktreePath, hasSpawnFlag, extractFlagValue, deriveTitleFromBrief,
  SPAWN_LAUNCH_WAIT_MS_DEFAULT, SPAWN_LAUNCH_WAIT_MAX_MS, spawnLaunchWaitRequestedMs,
  spawnLaunchWaitMs, checkSpawnLaunch, SPAWN_FETCH_TIMEOUT_MS, SPAWN_FETCH_TTL_SEC_DEFAULT,
  gitCommonDirFor, remoteRefAgeSec, spawnSourceFreshness, SPAWN_CREATE_TIMEOUT_MS_DEFAULT,
  submodulePathsFor, parseSubmoduleWorktreeFailures, repairSubmoduleWorktrees, SPAWN_VALUE_FLAGS,
  spawnFlagValueError, cmdSpawn, cmdMergeVerb, sourceWorkspaceNote,
};
