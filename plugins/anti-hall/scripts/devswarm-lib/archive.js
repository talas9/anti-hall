'use strict';
// anti-hall :: devswarm CLI — ARCHIVE module (scripts/devswarm-lib/archive.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  archivedDir, archiveIgnoreDir, checkedArchivedDir, clearRecoveryIntent, descriptorFingerprint,
  descriptorFreshRepoKey, descriptorPath, descriptorPhysicalOwnerKey, descriptorRegisteredRepoKey,
  descriptorStructuralRepoKey, devswarmCaps, dispatcherExports, FORCE_CROSS_PROJECT_ORPHAN_WARNING,
  forceCrossProjectHint, forceCrossProjectOverride, fs, hasFreshHeartbeat, hcRun, identityContext,
  inst, isSafeId, logAuthorityOverride, one, path, projectContextMismatch, readDescriptorFile,
  readDescriptorPathState, registryRowPresent, repokey, repoKeyForCwd, store, storeOwnerKeyFor,
  withIdLock, workspacesDir, writeDescriptorAtomic, writeRecoveryIntent,
} = require('./core.js');
const {
  canonicalWorktreeRealPath, computeRowLive, registrySnapshot, resolveCallerWorktree, rosterMeshId,
  senderIdentityDetailed,
} = require('./identity.js');
const {
  rehomeCore, restoreArchivedDescriptor, retireArchivedWorktreeGroup,
  retireIdentityFamilyDescriptors,
} = require('./fold.js');
const {
  meshCandidateRows,
} = require('./send.js');
const {
  APP_SOURCED_MARKERS, readJsonDescriptors,
} = require('./repair.js');

// archivedTombstoneIsOrphaned(home, archivedStat) -> bool
//   true  == archived/<id>.json is a leftover from a PRIOR archive generation and
//            is safe to unlink+relink (NO live descriptor shares its inode).
//   false == its inode is shared with a LIVE descriptor under workspaces/ -> NEVER
//            unlink it (that would destroy a genuine active descriptor).
//
// WHY AN INODE TEST AND NOT "the registry has no live row for this id": that
// predicate is self-defeating here. cmdArchive only reaches the conflicting-link
// branch when the id's ACTIVE descriptor exists, i.e. the id IS live at that
// moment — a "no live row for this id" test can therefore never fire, and the
// stale tombstone would stay wedged forever. The question that actually matters is
// not "is this id live" but "is this FILE still somebody's active descriptor", and
// only (dev, ino) answers that: archived/<id>.json is created exclusively as a
// hardlink of a workspaces/<id>.json, so if no live descriptor shares its inode it
// can only be a dangling remnant of an archive generation that has already ended.
// Do not re-propose the registry-row predicate.
//
// FAIL CLOSED — the single most important property here. An unreadable/absent
// workspaces dir, or ANY lstat that leaves the scan incomplete, returns FALSE
// ("not orphaned"), so the caller keeps failing and nothing is unlinked. "I could
// not see any live descriptor" must NEVER be read as "nothing is live, safe to
// delete". A vanished entry (ENOENT between readdir and lstat) counts as an
// incomplete scan too: it may be a descriptor a concurrent archive just unlinked,
// in which case this archived path could be the last remaining link to it.
function archivedTombstoneIsOrphaned(home, archivedStat) {
  if (!archivedStat) return false;
  const dir = workspacesDir(home);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (_) { return false; } // FAIL CLOSED
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let st;
    try { st = fs.lstatSync(path.join(dir, n)); }
    catch (_) { return false; } // FAIL CLOSED — incomplete scan
    if (st.dev === archivedStat.dev && st.ino === archivedStat.ino) return false;
  }
  return true;
}

// APP_ARCHIVE_RETRYABLE_RE — DevSwarm 2.5.3's own transient failure text, seen
// on a real substrate test (2026-09-25): the FIRST `hivecontrol workspace
// archive <id>` call can fail with "Could not confirm terminal process
// boundary" even though the app archives correctly on a bare retry (no state
// changed between attempts — verified live). Retrying once on exactly this
// text is a targeted workaround for a known-flaky app-side check, not a
// general retry-on-any-failure policy.
// Widened 2026-09-26: a later DevSwarm build rewords this to "Could not
// confirm terminal <id> stopped" — same flaky check, different phrasing.
// Live evidence (peer report): the built-in single retry never fired against
// this wording (regex required "process boundary" verbatim), so EVERY first
// archive call failed and only the CLI's outer caller-level retry saved it.
// Matching just the stable "could not confirm terminal" prefix (word
// boundary after "terminal") covers both wordings while still requiring the
// specific phrase, so unrelated hivecontrol errors are never retried.
const APP_ARCHIVE_RETRYABLE_RE = /could not confirm terminal\b/i;
// Same bound devswarm-lifecycle.js's own auto-archive hivecontrol call uses
// (its HC_TIMEOUT_MS) — kept as its own constant here since this file may not
// import that module's private const.
const APP_ARCHIVE_TIMEOUT_MS = 60000;

// attemptAppArchive(id, desc, ctx) -> { attempted, ok, reason?, error?, retried? }.
// Archives the workspace in the DevSwarm APP (not just anti-hall's own
// descriptor/registry state) via the capability-gated hivecontrol runner —
// EXPLICIT id always passed (never relies on hivecontrol's "current workspace"
// default). Gated on companion/lib/devswarm-capabilities.js's
// can('workspace.archive'): dormant (hivecontrol absent, or present but below
// the verb's minVersion) -> attempted:false, never spawns. A live substrate
// test on 2026-09-25 proved `hivecontrol workspace archive <id>` DOES exist
// and works on DevSwarm 2.5.3 (sets isActive=0/isHidden=1) — the OLD
// `manualStep` text below claiming "hivecontrol has no teardown command" was
// false and is fixed by this function actually calling it. Tests stub
// pull.defaultRun (hcRun reads it lazily) — never spawns a real hivecontrol.
//
// TARGET GATE (appBuilderGate, runs BEFORE the capability probe so a refused
// target never spawns anything): hivecontrol is only ever called when the app
// DB (read-only, fresh read) holds a builder with this EXACT full id that is
// not already archived (open OR closed) and whose builderType is known and not 'primary'. Unknown
// builderType, an unreadable app DB, a truncated id, a `primary-<hash>` label
// id, or any id the app DB does not hold verbatim -> not attempted. DevSwarm
// 2.5.3's archive/delete verbs default to the CURRENT workspace when no id is
// given, so a wrong or partial id must never reach hivecontrol at all.
function appBuilderGate(id, ctx) {
  const sid = String(id);
  if (/^primary-/i.test(sid)) return { ok: false, reason: 'primary-<hash> label id is never passed to hivecontrol' };
  let states = null;
  try {
    states = require('../../companion/lib/devswarm-app-db.js').builderStates({ home: ctx.home, env: ctx.env, now: ctx.now, fresh: true });
  } catch (_) { states = null; }
  if (!states) return { ok: false, reason: 'app DB unreadable — cannot confirm the builder' };
  const b = states.get(sid);
  if (!b) return { ok: false, reason: 'no app builder with this exact id' };
  const bt = String(b.builderType || '').trim().toLowerCase();
  if (!bt) return { ok: false, reason: 'app builderType unknown' };
  if (bt === 'primary') return { ok: false, reason: 'primary builder' };
  // Only an ALREADY-archived builder (isActive=0 AND isHidden=1) is skipped. A CLOSED builder
  // (isActive=0, not hidden — closing is NOT archiving, app-db.js) is still listed in the app, so
  // it is archived like an open one: same exact-id + non-primary identity gate above.
  if (b.archived === true) return { ok: false, reason: 'app builder is already archived' };
  return { ok: true, branch: b.branchName || null };
}

// hcArchiveCall(ident, spec) -> { ok, error, raw, retried? }. ONE `workspace archive
// <ident>` spawn, retried ONCE on the known-flaky boundary-confirmation error.
// ok = the process exited 0 AND its JSON body (when it parses) does not say
// `archived:false`. EXIT 0 IS NOT PROOF the app archived anything — callers
// verify through verifyAppArchived before reporting success.
function hcArchiveCall(ident, base) {
  // hivecontrol defaults an absent ref to the CURRENT workspace: never spawn it without an explicit ref.
  if (typeof ident !== 'string' || !ident.trim()) return { ok: false, raw: '', error: 'refusing to call hivecontrol with an empty ref' };
  const spec = Object.assign({}, base, { args: ['workspace', 'archive', String(ident)] });
  const once = () => {
    let r;
    try { r = hcRun(spec); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (r && r.ok) {
      let body = null;
      try { body = JSON.parse(String(r.raw || '')); } catch (_) { body = null; }
      if (body && typeof body === 'object' && body.archived === false) {
        return { ok: false, raw: String(r.raw || ''), error: 'hivecontrol reported archived:false: ' + String(r.raw || '').trim().slice(0, 200) };
      }
      return { ok: true, raw: String((r && r.raw) || ''), archivedTrue: !!(body && typeof body === 'object' && body.archived === true) };
    }
    return { ok: false, raw: String((r && r.raw) || ''), error: String((r && r.error) || '') || 'unknown hivecontrol failure' };
  };
  const r1 = once();
  if (r1.ok || !APP_ARCHIVE_RETRYABLE_RE.test(r1.error)) return r1;
  const r2 = once();
  return Object.assign({}, r2, { retried: true });
}

// verifyAppArchived(id, ctx, resp) -> { verified: true } | { verified: false, why } .
// The app DB (fresh read, builders.isActive/isHidden) is the authority when it is
// readable and holds the builder. Otherwise the hivecontrol archive JSON response
// (`archived:true`, alreadyArchived either way) is the evidence. `workspace list all`
// membership is NOT a signal: it keeps archived rows (live-measured 2026-10-01).
function verifyAppArchived(id, ctx, resp) {
  let states = null;
  try { states = require('../../companion/lib/devswarm-app-db.js').builderStates({ home: ctx.home, env: ctx.env, now: ctx.now, fresh: true }); }
  catch (_) { states = null; }
  const b = states && states.get(String(id));
  if (b) return b.archived ? { verified: true } : { verified: false, why: 'the app DB still lists the workspace open (isActive=1)' };
  if (resp && resp.archivedTrue) return { verified: true };
  return { verified: false, why: 'the app DB could not confirm the workspace and hivecontrol did not report archived:true' };
}

// appSideSnapshot(id, ctx) -> { target, rows:Map(id -> {st:'open'|'closed'|'archived', branch}) } | null. Fresh read of
// the app DB: the target row plus every builder sharing its branchName or worktreePath.
function appSideSnapshot(id, ctx) {
  let snap = null;
  try { snap = require('../../companion/lib/devswarm-app-db.js').snapshot({ home: ctx.home, env: ctx.env, now: ctx.now, fresh: true }); } catch (_) { snap = null; }
  if (!snap || !Array.isArray(snap.workspaces)) return null;
  const t = snap.workspaces.find((w) => w.id === String(id));
  if (!t) return null;
  const st = (w) => (w.archived === true ? 'archived' : w.active ? 'open' : 'closed');
  const rows = new Map();
  for (const w of snap.workspaces) {
    if (w.id === t.id || (t.branchName && w.branchName === t.branchName) || (t.worktreePath && w.worktreePath === t.worktreePath)) rows.set(w.id, { st: st(w), branch: w.branchName || null });
  }
  return { target: t, rows };
}

function attemptAppArchive(id, desc, ctx) {
  const home = ctx.home;
  const target = appBuilderGate(id, ctx);
  if (!target.ok) return { attempted: false, reason: target.reason };
  let cap;
  try { cap = devswarmCaps.can('workspace.archive', { home, env: ctx.env }); }
  catch (e) { return { attempted: false, reason: 'capability check failed: ' + String((e && e.message) || e) }; }
  if (!cap || !cap.ok) return { attempted: false, reason: (cap && cap.reason) || 'dormant' };
  const cwd = (desc && desc.worktreePath) || ctx.cwd || process.cwd();
  const base = { env: ctx.env, cwd, timeout: APP_ARCHIVE_TIMEOUT_MS };
  const before = appSideSnapshot(id, ctx);
  const branch = target.branch || (desc && desc.branch) || null;
  // BRANCH FALLBACK GATE: a branch ref may name a different (re-spawned, open) builder, so it is used
  // only when exactly ONE non-archived app builder holds this branchName and it is the target itself.
  let branchOk = false; let branchWhy = null;
  if (!branch || typeof branch !== 'string') branchWhy = 'no branch name';
  else if (!before) branchWhy = 'app DB unreadable';
  else {
    const holders = [...before.rows.entries()].filter(([, r]) => r.branch === branch && r.st !== 'archived').map(([rid]) => rid);
    if (holders.length === 1 && holders[0] === before.target.id) branchOk = true;
    else branchWhy = 'branch name is shared by ' + holders.length + ' builders';
  }
  const done = (res) => {
    const after = before ? appSideSnapshot(id, ctx) : null;
    if (after) {
      const changed = [];
      for (const [rid, stt] of before.rows) { const a = after.rows.get(rid); if (rid !== before.target.id && (!a || a.st !== stt.st)) changed.push({ id: rid, before: stt.st, after: a ? a.st : 'gone' }); }
      if (changed.length) res.sideEffect = { message: 'hivecontrol changed OTHER app builders while archiving ' + id + ' — NOT undone, check the app', changed };
    }
    return res;
  };
  const first = hcArchiveCall(String(id), base);
  let v = first.ok ? verifyAppArchived(id, ctx, first) : null;
  const retried = !!first.retried;
  if (first.ok && v.verified) return done(Object.assign({ attempted: true, ok: true, verified: true, via: 'id' }, retried ? { retried: true } : {}));
  // Exit 0 but the app is unchanged (field report): the id was accepted as a no-op.
  // The CLI also accepts the BRANCH name — try that once, then re-verify (only when branchOk).
  let second = null;
  if (first.ok && branchOk) {
    second = hcArchiveCall(branch, base);
    if (second.ok) {
      v = verifyAppArchived(id, ctx, second);
      if (v.verified) return done({ attempted: true, ok: true, verified: true, via: 'branch', retried: retried || !!second.retried });
    }
  }
  const error = !first.ok ? first.error
    : (second && !second.ok ? second.error : 'hivecontrol exited 0 but ' + ((v && v.why) || 'the archive could not be verified'))
      + (first.ok && !branchOk && branchWhy ? ' (branch fallback skipped: ' + branchWhy + ')' : '');
  return done({
    attempted: true, ok: false, verified: false, retried: retried || !!(second && second.retried) || undefined, error,
    manualCommand: 'hivecontrol workspace archive ' + (branchOk ? branch : id),
  });
}

// localArchivedAppLive(home, ctx) -> { appDb, rows:[{ id, appId, branch, label, worktreePath, repoKey, cmd }] }.
// READ-ONLY. A workspace anti-hall's OWN `archive` verb tombstoned (archived/<id>.json
// with no app-sourced archivedBy) whose DevSwarm app builder is NOT archived in the app
// (open isActive=1, or merely closed isActive=0/isHidden=0; non-primary): the app side was never archived. App-sourced
// markers are excluded (retireStaleArchivedMarkers owns them: the app is right there).
// A twin guard skips any row whose id or worktree has a live ACTIVE descriptor.
// ctx.repoKey scopes to one project (owner key of the archived descriptor).
function localArchivedAppLive(home, ctx) {
  const c = ctx || {};
  const out = { appDb: false, rows: [] };
  let snap = c.snap || null;
  try { if (!snap) snap = require('../../companion/lib/devswarm-app-db.js').snapshot({ home, env: c.env, now: c.now, fresh: true }); } catch (_) { snap = null; }
  if (!snap || !Array.isArray(snap.workspaces)) return out;
  out.appDb = true;
  const appDb = require('../../companion/lib/devswarm-app-db.js');
  let archivedDescs = []; let activeDescs = [];
  try { archivedDescs = readJsonDescriptors(archivedDir(home)); } catch (_) { archivedDescs = []; }
  try { activeDescs = readJsonDescriptors(workspacesDir(home)); } catch (_) { activeDescs = []; }
  const wtKey = (p) => (p ? (canonicalWorktreeRealPath(String(p)) || String(p)) : null);
  const activeIds = new Set(activeDescs.map((d) => String(d.id)));
  const activeWts = new Set(activeDescs.map((d) => wtKey(d.worktreePath)).filter(Boolean));
  const seen = new Set();
  for (const d of archivedDescs) {
    if (!d || d.id == null || !isSafeId(String(d.id))) continue;
    const id = String(d.id);
    if (APP_SOURCED_MARKERS.has(d.archivedBy) || activeIds.has(id)) continue;
    const wt = wtKey(d.worktreePath);
    if (wt && activeWts.has(wt)) continue;
    if (c.repoKey && descriptorPhysicalOwnerKey(d) !== c.repoKey) continue;
    // EXACT id only: workspaceFor's worktree fallback could name a re-spawned LIVE builder.
    const w = snap.workspaces.find((x) => x.id === id) || null;
    if (!w || w.archived === true || String(w.builderType || '').toLowerCase() === 'primary' || !w.builderType || seen.has(w.id)) continue;
    seen.add(w.id);
    out.rows.push({
      id, appId: w.id, branch: w.branchName || d.branch || null, label: w.label || null,
      worktreePath: wt, repoKey: descriptorPhysicalOwnerKey(d) || null,
      cmd: 'hivecontrol workspace archive ' + (w.branchName || d.branch || w.id),
    });
  }
  return out;
}

// appLiveArchivedRows(home, { repair, cwd, env, now }) -> { rows, archived, errors, appDb, results }.
// The `doctor` detection (read-only) and `doctor --repair` (repair:true) for the
// anti-hall-archived / app-still-live mismatch. EXPLICIT only — never called from a
// hook, supervisor or update path. The repair is the VERIFIED app archive
// (attemptAppArchive); app archive is reversible in the app and nothing is deleted.
function appLiveArchivedRows(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  let repoKey = null;
  try { repoKey = repokey.repoKeyForWorktree(c.cwd || process.cwd()) || null; } catch (_) { repoKey = null; }
  const found = localArchivedAppLive(home, { env, now, repoKey });
  const out = { appDb: found.appDb, rows: found.rows, archived: 0, errors: 0, results: [] };
  if (!c.repair) return out;
  for (const r of found.rows) {
    let res;
    try { res = attemptAppArchive(r.appId, { id: r.id, worktreePath: r.worktreePath, branch: r.branch }, { home, cwd: c.cwd, env, now }); }
    catch (e) { res = { attempted: true, ok: false, verified: false, error: String((e && e.message) || e) }; }
    out.results.push({ id: r.id, appArchive: res });
    if (res.ok) out.archived++; else out.errors++;
  }
  return out;
}

// appOnlyArchive(raw, ctx) -> result | null. `archive <branch|meshId|id-prefix|uuid>` for a
// workspace anti-hall ALREADY archived whose app builder is still open: archives the
// APP side only (verified, idempotent) and says so. null = not this case (the normal
// cmdArchive path runs). Exactly one match or it archives nothing.
function appOnlyArchive(raw, ctx) {
  if (typeof raw !== 'string' || !raw) return null;
  const home = ctx.home;
  const env = ctx.env || process.env;
  if (isSafeId(raw) && readDescriptorPathState(descriptorPath(home, raw)).exists) return null; // still active in anti-hall
  let repoKey = null;
  try { repoKey = repokey.repoKeyForWorktree(ctx.cwd || process.cwd()) || null; } catch (_) { repoKey = null; }
  const found = localArchivedAppLive(home, { env, now: ctx.now, repoKey });
  if (!found.appDb) return null;
  const hit = found.rows.filter((r) => r.id === raw || r.appId === raw || r.branch === raw
    || (isSafeId(raw) && raw.length >= 6 && (r.id.startsWith(raw) || r.appId.startsWith(raw)))
    || rosterMeshId(r.worktreePath) === raw);
  if (hit.length === 0) {
    // Already archived on BOTH sides (idempotent): an archived descriptor + an app-archived builder.
    let appDb = null; let snap = null;
    try { appDb = require('../../companion/lib/devswarm-app-db.js'); snap = appDb.snapshot({ home, env, now: ctx.now, fresh: true }); } catch (_) { snap = null; }
    if (!snap) return null;
    const archIds = new Set(readJsonDescriptors(archivedDir(home)).map((d) => String(d.id)));
    const w = snap.workspaces.find((x) => x.archived === true && archIds.has(x.id)
      && (x.id === raw || x.branchName === raw || (isSafeId(raw) && raw.length >= 6 && x.id.startsWith(raw))));
    if (w) {
      return { ok: true, action: 'archive', id: w.id, descriptorArchived: false, alreadyArchived: true, appArchive: { attempted: false, ok: true, verified: true, reason: 'already archived in the DevSwarm app' } };
    }
    return null;
  }
  if (hit.length > 1) {
    return { ok: false, action: 'archive', id: raw, descriptorArchived: false, error: 'ambiguous: ' + JSON.stringify(raw) + ' matches ' + hit.length + ' app-live workspaces — archived nothing; use one full id: ' + hit.map((r) => r.appId).join(', '), candidates: hit.map((r) => r.appId) };
  }
  const r = hit[0];
  const appArchive = attemptAppArchive(r.appId, { id: r.id, worktreePath: r.worktreePath, branch: r.branch }, { home, cwd: ctx.cwd, env, now: ctx.now });
  const res = { ok: true, action: 'archive', id: r.id, descriptorArchived: false, alreadyArchived: true, appOnly: true, appArchive };
  if (appArchive.sideEffect) res.warnings = ['APP SIDE EFFECT: ' + appArchive.sideEffect.message + ' ' + JSON.stringify(appArchive.sideEffect.changed)];
  if (!appArchive.ok) {
    res.partial = true;
    res.manualStep = 'run `' + (appArchive.manualCommand || r.cmd) + '` — the app archive was NOT verified' + (appArchive.error ? ' [' + appArchive.error + ']' : '');
  }
  return res;
}

function cmdArchive(id, ctx, opts) {
  const home = ctx.home;
  const revalidate = opts && typeof opts.revalidate === 'function' ? opts.revalidate : null;
  return withIdLock(id, home, () => {
  const activePath = descriptorPath(home, id);
  const archiveDirState = checkedArchivedDir(home, { create: true });
  if (!archiveDirState.ok) {
    return { ok: false, action: 'archive', id, descriptorArchived: false, error: 'unsafe archived directory: ' + archiveDirState.error };
  }
  const archivedPath = path.join(archiveDirState.path, id + '.json');
  const activeState = readDescriptorPathState(activePath);
  if (activeState.error) {
    return {
      ok: false, action: 'archive', id, descriptorArchived: false,
      error: 'failed to read existing descriptor: ' + activeState.error,
    };
  }
  let desc = activeState.descriptor;
  if (!activeState.exists) {
    const archivedState = readDescriptorPathState(archivedPath);
    if (archivedState.error) {
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to read archived descriptor: ' + archivedState.error,
      };
    }
    desc = archivedState.descriptor;
  }
  const currentRepoKey = repoKeyForCwd(ctx);
  const currentOwnerKey = currentRepoKey || store.hashFromWorkspaceId(id);
  let ownerKey = currentOwnerKey;
  // Set once, by the id-derived authority gate below, when an explicit
  // `--force-cross-project <id>` was accepted. Threaded to the PHYSICAL
  // ownership check further down because the two gates ask the SAME authority
  // question from two angles (registered project key vs persisted ownerKey) —
  // clearing only the first would leave the override cosmetic, the archive
  // still refused, and the defect unfixed.
  let crossProjectOverride = false;
  if (desc) {
    if (!isSafeId(desc.id) || String(desc.id) !== String(id) || !desc.worktreePath) {
      return { ok: false, action: 'archive', id, descriptorArchived: false, error: 'descriptor identity does not match workspace ' + JSON.stringify(id) };
    }
    // G3 RE-HOME (archive path, P1-1/P1-2): a descriptor stranded in the legacy
    // hash bucket (persisted ownerKey === hashFromWorkspaceId(id)) whose project
    // now resolves must be HEALED before archiving — otherwise the ownership
    // check below rejects the workspace from its OWN project, and even if it
    // passed the tombstone would land in the hash bucket while the live row
    // (already re-homed by a prior read/send) sits in store/<repoKey>/, silently
    // leaving it un-archived. Mirrors the ensure branch's re-home. Only the hash-
    // bucket marker heals; a REAL differing repoKey (genuine cross-project) is
    // NOT === hashKey, so it falls through to the reject below (P1-6 extended to
    // archive). Lock already held (cmdArchive runs inside withIdLock).
    // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
    // Same rehome-then-validate inversion as the `ensure` branch, but this one
    // also REMOVES the live descriptor on success: archiving a hash-stranded
    // workspace whose worktree lives in ANOTHER project copied that project's
    // rows into this one and then retired its live descriptor. Refuse FIRST,
    // on the id's own registered key, so nothing is copied and — critically —
    // nothing is removed. Fail-open unchanged for a descriptor that names no
    // project at all.
    {
      const registeredRepoKeyForArchive = descriptorRegisteredRepoKey(desc, id);
      if (registeredRepoKeyForArchive && registeredRepoKeyForArchive !== currentRepoKey) {
        // c2a7813aa7d3: the ONE escape hatch. See forceCrossProjectOverride's
        // header for why it is opt-in, id-exact, audited, and archive-only.
        // `opts.flags` is supplied ONLY by the interactive `archive` CLI verb.
        // The BULK sweeps that also call cmdArchive (reap-stale, the archive
        // sweep) pass no flags and therefore can NEVER take this hatch — an
        // automated pass must not silently archive across projects.
        const override = forceCrossProjectOverride((opts && opts.flags) || {}, id);
        if (override.accepted) {
          crossProjectOverride = true;
          logAuthorityOverride({
            ts: new Date().toISOString(),
            verb: 'archive',
            id: String(id),
            cwdProject: currentRepoKey || null,
            targetProject: registeredRepoKeyForArchive,
          }, home);
        } else {
          const refusal = Object.assign(
            { action: 'archive', descriptorArchived: false },
            projectContextMismatch(id, registeredRepoKeyForArchive, currentRepoKey,
              'run this from within that project\'s worktree to archive it'));
          refusal.error += forceCrossProjectHint(id, override.provided, override.value);
          if (override.provided) refusal.forceCrossProjectRejected = override.value;
          return refusal;
        }
      }
    }
    if (activeState.exists) {
      const storedOwnerKeyPre = typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
      const hashKey = store.hashFromWorkspaceId(id);
      if (currentRepoKey && storedOwnerKeyPre === hashKey && hashKey !== currentRepoKey) {
        const rh = rehomeCore(home, id, currentRepoKey, ctx);
        if (rh && rh.rehomed) {
          const reread = readDescriptorFile(home, id);
          if (reread && String(reread.id) === String(id)) desc = reread;
        }
      }
    }
    const storedOwnerKey = typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
    const structuralRepoKey = descriptorStructuralRepoKey(desc);
    const freshRepoKey = descriptorFreshRepoKey(desc);
    const activeLegacyPerId = activeState.exists && !storedOwnerKey && !structuralRepoKey && currentRepoKey === null;
    ownerKey = storedOwnerKey || structuralRepoKey || (activeLegacyPerId ? currentOwnerKey : null);
    if ((!ownerKey || ownerKey !== currentOwnerKey) && !crossProjectOverride) {
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'descriptor does not belong to the current project',
      };
    }
    // An override can only fire when the id HAS a resolvable registered key, so
    // fall back to it rather than leaving `ownerKey` null and letting the
    // tombstone store open against an unspecified bucket.
    if (crossProjectOverride && !ownerKey) ownerKey = descriptorRegisteredRepoKey(desc, id) || currentOwnerKey;
    // CRITICAL under an override: `ownerKey` stays the workspace's OWN key and
    // is deliberately NOT re-stamped to the caller's. The registry tombstone
    // below opens its store with `hash: ownerKey`, so leaving it alone puts the
    // tombstone in the OWNING project's store, where it belongs. Re-homing the
    // descriptor to the caller's project instead would be precisely the
    // cross-project theft the authority gate exists to prevent — the override
    // authorises archiving a foreign workspace, never adopting one.
    if (activeState.exists && !storedOwnerKey && !crossProjectOverride) {
      desc.ownerKey = currentOwnerKey;
      ownerKey = currentOwnerKey;
      if (currentRepoKey && freshRepoKey === currentRepoKey) desc.repoKey = currentRepoKey;
      try { writeDescriptorAtomic(home, id, desc); }
      catch (e) {
        return {
          ok: false, action: 'archive', id, descriptorArchived: false,
          error: 'failed to persist descriptor project identity: ' + String(e && e.message || e),
        };
      }
    }
  }
  // P1-5 TOCTOU re-validation: re-check the safety condition INSIDE the critical
  // section, immediately before any mutation. A heartbeat/activity that arrived
  // after the caller collected this as a candidate makes the workspace live again
  // -> SKIP (never archive a now-live workspace). No-op when no predicate given.
  if (revalidate) {
    let skipReason = null;
    try { skipReason = revalidate(desc); } catch (_) { skipReason = null; }
    if (skipReason) {
      return { ok: true, action: 'archive', id, descriptorArchived: false, skipped: true, reason: String(skipReason) };
    }
  }
  // P1-3 ALL-OR-NOTHING: link the descriptor into archived/ (keeping the ACTIVE
  // descriptor in place), tombstone the registry, and ONLY THEN unlink the active
  // descriptor. A failure at any step ROLLS BACK so archive is never half-applied
  // (the ENOSPC hazard: unlink-then-tombstone left descriptor archived + registry
  // live = split-brain).
  let linked = false; // archived hardlink created, active still present
  let moved = false;  // active descriptor unlinked -> fully archived
  if (activeState.exists) {
    try {
      try { fs.linkSync(activePath, archivedPath); }
      catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
      }
      let activeStat = fs.lstatSync(activePath);
      let archivedStat = fs.lstatSync(archivedPath);
      if (activeStat.dev !== archivedStat.dev || activeStat.ino !== archivedStat.ino) {
        // SELF-HEAL a genuinely ORPHANED tombstone. The EEXIST swallowed above can
        // be a leftover archived/<id>.json from a PRIOR archive generation of this
        // same id (re-registered, then archived again) — with the old link still in
        // place the inode check fails and re-archiving the id is wedged FOREVER.
        // Unlink+relink is allowed ONLY when no live descriptor shares that inode
        // (see archivedTombstoneIsOrphaned, which fails CLOSED); otherwise the file
        // is a hardlink of somebody's genuine ACTIVE descriptor and we keep failing
        // — the never-clobber contract. activePath is never touched on any path.
        if (!archivedTombstoneIsOrphaned(home, archivedStat)) {
          throw new Error('archived descriptor already exists and is not the active descriptor');
        }
        // Replace the orphaned tombstone via link-to-temp + atomic rename, NOT
        // unlink-then-link. unlink-then-link is two independent syscalls with no
        // rollback between them: if linkSync throws (ENOSPC, EPERM) or the process
        // dies in the gap, archivedPath is left MISSING and the tombstone's bytes
        // are gone with nothing to replace them. A same-directory fs.renameSync is
        // atomic on POSIX and REPLACES an existing destination in one step, so
        // archivedPath is never observably missing at any instant. Do not
        // "simplify" this back to unlink+link.
        const healTmp = archivedPath + '.tmp-heal';
        try { fs.unlinkSync(healTmp); } catch (_) {} // clear a leftover from a prior crashed heal
        fs.linkSync(activePath, healTmp);
        try {
          fs.renameSync(healTmp, archivedPath); // atomic same-dir replace: archivedPath is never missing
        } catch (e) {
          try { fs.unlinkSync(healTmp); } catch (_) {} // never leave the temp link behind
          throw e;
        }
        // RE-VERIFY from disk (never trust the retry blind): only a fresh stat of
        // BOTH paths agreeing on (dev, ino) may set `linked`.
        activeStat = fs.lstatSync(activePath);
        archivedStat = fs.lstatSync(archivedPath);
        if (activeStat.dev !== archivedStat.dev || activeStat.ino !== archivedStat.ino) {
          throw new Error('archived descriptor already exists and is not the active descriptor');
        }
      }
      linked = true;
    } catch (e) {
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to link descriptor into archived/: ' + String(e && e.message || e),
      };
    }
  }
  // G2 crash-safe: persist a recovery-intent marker BEFORE tombstoning. If the
  // in-process rollback below ALSO fails (ENOSPC defeats the revive upsert) OR the
  // process is killed mid-sequence, this durable marker lets doctor/next-run
  // revive the registry row — closing the split-brain window (active descriptor +
  // tombstoned registry) that swallowing a revive failure would otherwise leave.
  // Only meaningful when we have a descriptor to revive from.
  if (desc) {
    try { writeRecoveryIntent(home, id, { id, ownerKey, op: 'archive', descriptor: desc, fingerprint: descriptorFingerprint(desc), ts: Date.now() }); }
    catch (e) {
      // Cannot even record the intent — do NOT tombstone (we would have no
      // crash-safe record). Roll back the link and abort; nothing was archived.
      if (linked && activeState.exists) { try { fs.unlinkSync(archivedPath); } catch (_) {} }
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to persist archive recovery-intent (nothing archived): ' + String(e && e.message || e),
      };
    }
  }
  // v0.57 mesh (D24): tombstone the registry entry in the SAME shared per-project
  // store `register`/`roster` populate (repoKey, when resolvable). Done BEFORE the
  // active unlink so an ENOSPC/IO failure here leaves BOTH the descriptor and the
  // registry row intact.
  //
  // WHOLE-GROUP RETIRE (archived-still-active fix): tombstoning THIS id alone
  // left every OTHER registry row for the SAME physical worktree live, and a
  // live row IS what computeSummary projects as an active workspace — so the
  // workspace the user just archived kept showing up as active under a
  // duplicate row (see retireArchivedWorktreeGroup for the full mechanism).
  // Runs BEFORE this id's own tombstone, and forward-before-tombstone, so the
  // duplicates' unread backlog lands in THIS id's partition rather than being
  // scattered across partitions nothing will ever drain. It is fail-open (never
  // throws), so the only thing that can throw inside this try — and therefore
  // the only thing that can trigger the rollback below — is still the tombstone
  // itself, exactly as before: the all-or-nothing discipline for the archived
  // descriptor+row pair is unchanged. If the rollback does fire, the forwarded
  // rows are already durable in this id's partition and its registry row is
  // revived, so nothing is stranded and a retry is idempotent.
  let groupRetire = null;
  try {
    const s = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
    try {
      groupRetire = retireArchivedWorktreeGroup(s, home, id, desc && desc.worktreePath);
      s.removeRegistry(id);
      store.deriveSummary(s, { home, env: ctx.env });
    }
    finally { s.close(); }
  } catch (e) {
    // ROLLBACK. The failure may have hit AFTER removeRegistry appended its
    // tombstone (e.g. the subsequent deriveSummary write failed on ENOSPC), so
    // REVIVE the registry row (upsert wins as the newest op — a no-op if the
    // tombstone never landed) and drop the archived hardlink. Net result: the
    // active descriptor + a live registry row remain, exactly as before the call.
    let revived = false;
    if (desc) {
      try {
        const s2 = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
        try { s2.upsertRegistry(desc); }
        finally { s2.close(); }
        // VERIFY the row is live again (pure fold read; deriveSummary intentionally
        // skipped — it is what failed). A verified restore is the ONLY thing that
        // clears the recovery-intent.
        revived = registryRowPresent(home, id, ownerKey, ctx);
      } catch (_) { revived = false; }
    }
    if (linked && activeState.exists) { try { fs.unlinkSync(archivedPath); } catch (_) {} }
    if (desc && !revived) {
      // Revive ALSO failed — do NOT swallow. Leave the recovery-intent in place so
      // doctor/next-run restores the row; report a HARD error (split-brain averted
      // only by the durable marker, not by an in-process rollback).
      return {
        ok: false, action: 'archive', id, descriptorArchived: false, recoveryIntent: true,
        error: 'failed to tombstone registry AND failed to revive it — recovery-intent persisted for repair: ' + String(e && e.message || e),
      };
    }
    clearRecoveryIntent(home, id);
    return {
      ok: false, action: 'archive', id, descriptorArchived: false,
      error: 'failed to tombstone registry (rolled back — nothing archived): ' + String(e && e.message || e),
    };
  }
  // Registry tombstone is durable — unlink the active descriptor LAST.
  if (activeState.exists) {
    try { fs.unlinkSync(activePath); moved = true; }
    catch (e) {
      // The active unlink failed AFTER a durable tombstone. REVIVE the registry row
      // (upsert wins as the newest op) and drop the archived link so we restore the
      // pre-archive all-or-nothing state instead of stranding a registry-less live
      // descriptor. Report failure; the caller can retry.
      let revived = false;
      if (desc) {
        try {
          const s2 = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
          try { s2.upsertRegistry(desc); store.deriveSummary(s2, { home, env: ctx.env }); }
          finally { s2.close(); }
          revived = registryRowPresent(home, id, ownerKey, ctx);
        } catch (_) { revived = false; }
      }
      if (linked) { try { fs.unlinkSync(archivedPath); } catch (_) {} }
      if (desc && !revived) {
        // Revive ALSO failed — leave the recovery-intent for doctor/next-run.
        return {
          ok: false, action: 'archive', id, descriptorArchived: false, recoveryIntent: true,
          error: 'failed to remove active descriptor after tombstone AND failed to revive registry — recovery-intent persisted for repair: ' + String(e && e.message || e),
        };
      }
      clearRecoveryIntent(home, id);
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to remove active descriptor after tombstone (registry revived — nothing archived): ' + String(e && e.message || e),
      };
    }
  }
  // Archive fully completed — the recovery-intent is discharged.
  clearRecoveryIntent(home, id);
  // WHOLE-FAMILY DESCRIPTOR RETIRE — runs only after this id's own archive is
  // fully durable, so a failure here can never leave the primary half-applied.
  // Fail-open by construction (see retireIdentityFamilyDescriptors).
  const familyRetire = retireIdentityFamilyDescriptors(home, id, desc);
  const archived = { ok: true, action: 'archive', id, descriptorArchived: moved };
  // APP ARCHIVE (fixes false "hivecontrol has no teardown command" claim —
  // see attemptAppArchive's own header): when the capability gate allows it,
  // actually archive this workspace in the DevSwarm app too, EXPLICIT id
  // always, retrying once on the known-flaky boundary-confirmation error.
  // Dormant/failed -> fall back to an ACCURATE manual-step instruction
  // (never the old false "no teardown command" text).
  // opts.appArchive === false (hook callers, e.g. devswarm-child-turn.js's
  // phantom-descriptor retire): LOCAL-ONLY — no hivecontrol spawn at all, not
  // even the capability probe, so a hook never spends its timeout budget on it.
  const appArchive = (opts && opts.appArchive === false)
    ? { attempted: false, reason: 'local-only caller (appArchive:false)' }
    : attemptAppArchive(id, desc, ctx);
  archived.appArchive = appArchive;
  if (appArchive.sideEffect) archived.warnings = (archived.warnings || []).concat('APP SIDE EFFECT: ' + appArchive.sideEffect.message + ' ' + JSON.stringify(appArchive.sideEffect.changed));
  if (appArchive.ok) {
    archived.manualStep = 'archived in the DevSwarm app too (isActive=0/isHidden=1, verified)'
      + (appArchive.retried ? ' — succeeded on retry' : '') + '.';
  } else {
    // The app side did NOT verifiably archive: the descriptor IS archived, so the
    // result is a PARTIAL success (ok stays true for callers that gate on the local
    // archive; `partial` + appArchive.verified:false is the honest signal).
    if (appArchive.attempted) archived.partial = true;
    archived.manualStep = 'run `' + (appArchive.manualCommand || ('hivecontrol workspace archive ' + id)) + '` (or archive it manually in the '
      + 'DevSwarm app) to also archive workspace ' + id + ' there — anti-hall\'s own archive only tombstoned '
      + 'its local descriptor/registry (archive keeps disk contents; never delete without confirmation).'
      + (appArchive.attempted ? ' [app archive attempted, NOT verified: ' + String(appArchive.error || 'unknown') + ']'
        : (appArchive.reason ? ' [app archive not attempted: ' + String(appArchive.reason) + ']' : ''));
  }
  // LIVE-CHILD WARNING (defect df54edf54804 hardening): archiving unlinks the
  // active descriptor + tombstones the registry, but it does NOT — and by
  // design (7e1ae67) never should — stop a STILL-RUNNING child session from
  // later re-creating workspaces/<id>.json via an explicit `register`/
  // `register-primary` call (scripts/devswarm.js's cmdRegister resurrection
  // guard, field defect a48db2e0ea08, only covers the `ensure` verb). A fresh
  // heartbeat recorded for this id right now means exactly that: a live child
  // is still attached and may re-register it. Warn loudly rather than
  // silently letting the operator believe archiving is the end of the story;
  // never refuse or alter the archive itself on this signal.
  //
  // APP-DB CROSS-CHECK (fixes false positive): a heartbeat alone can be
  // STALE — e.g. this exact workspace was already DELETED in the DevSwarm
  // app, whose builder-row removal this anti-hall-side heartbeat file has no
  // way to observe on its own. Cross-check the app DB's own builder rows
  // (companion/lib/devswarm-app-db.js builderStates): NO row for this id at
  // all means the app itself has no record of it running — the warning is
  // suppressed. Fail-open toward warning (today's behavior) whenever the app
  // DB is unavailable/unreadable or this id DOES have a row there.
  try {
    if (hasFreshHeartbeat(id, home, { now: ctx.now })) {
      let appSaysGone = false;
      try {
        const states = require('../../companion/lib/devswarm-app-db.js').builderStates({ home, env: ctx.env, now: ctx.now });
        appSaysGone = !!(states && !states.has(String(id)));
      } catch (_) { appSaysGone = false; } // fail-open: unreadable app DB -> keep warning
      if (!appSaysGone) {
        archived.warning = 'child session still live for ' + id + ' (fresh heartbeat) — it may '
          + 're-register and reappear; close its terminal or it will keep coming back';
      }
    }
  } catch (_) { /* fail-open: never let the warning check block a completed archive */ }
  // Surface the whole-group retire ONLY when it did something — a plain archive
  // of a single-row worktree keeps its existing return shape byte-for-byte.
  // `leftDuplicates` is the honest half: a same-worktree row the safety gate
  // refused to tombstone is REPORTED with its reason, never silently dropped.
  if (groupRetire) {
    if (groupRetire.retired.length) archived.retiredDuplicates = groupRetire.retired;
    if (groupRetire.forwarded) archived.forwardedFromDuplicates = groupRetire.forwarded;
    if (groupRetire.left.length) archived.leftDuplicates = groupRetire.left;
  }
  // Same shape discipline as groupRetire: surfaced ONLY when it did something,
  // so a plain single-descriptor archive keeps its return byte-for-byte.
  if (familyRetire) {
    if (familyRetire.retired.length) archived.retiredFamilyDescriptors = familyRetire.retired;
    if (familyRetire.left.length) archived.leftFamilyDescriptors = familyRetire.left;
  }
  // R12 hygiene (c): a cross-project archive taken via the explicit hatch must
  // STATE its consequence, not just record it in a log nobody reads. Present
  // only on the override path, so an ordinary archive's shape is unchanged.
  if (crossProjectOverride) {
    archived.forceCrossProject = true;
    archived.warning = FORCE_CROSS_PROJECT_ORPHAN_WARNING;
  }
  return archived;
  });
}

// resolveArchiveId(raw, ctx) — id-PREFIX resolution for the `archive` verb
// ONLY. WHY: the per-turn table (devswarm-parent-inbox.js) and the roster
// both render `name (shortId)` (names.displayName/shortId — first 8 chars of
// the UUID) as the ONLY copyable-looking token; the real archivable id is the
// full UUID, shown nowhere. An agent/user copies the 8-char shortId and
// `archive <that>` fails 'invalid or missing workspace id'. This lets that
// same shortId (or any unambiguous longer prefix) resolve directly, WITHOUT
// adding a single new injection token to the rendered table — no full UUIDs
// are surfaced anywhere by this change.
//
// Contract (P0: archiving the WRONG workspace is the real risk, so ambiguity
// fails CLOSED — nothing is ever archived on an ambiguous prefix):
//   1. An EXACT existing descriptor id (active OR archived-only) short-circuits
//      immediately — unchanged full-id behaviour, zero prefix search performed.
//   2. Else the candidate pool is the CURRENT PROJECT's own active (non-
//      archived) workspace ids — same `sum.workspaces` projection
//      cmdWorkspacesList/the roster/the table already read (computeSummary
//      excludes archived ids by construction), scoped by the SAME repoKey
//      derivation cmdWorkspacesList uses. This deliberately mirrors cmdArchive's
//      own ownership gate ('descriptor does not belong to the current
//      project') — a prefix can only ever resolve to a workspace this project
//      could legitimately archive anyway.
//   3. Exactly one candidate id starts with `raw` -> resolved, use it.
//   4. Zero, or `raw` itself is not isSafeId (e.g. contains '/' or '..') ->
//      the existing 'invalid or missing workspace id' error, unchanged.
//   5. Two or more -> ARCHIVE NOTHING; return an error listing every
//      candidate's full id so the caller can pick the exact one.
// Never throws; every path returns { ok, id? , error?, candidates? }.
function resolveArchiveId(raw, ctx) {
  if (!isSafeId(raw)) return { ok: false, error: 'invalid or missing workspace id' };
  const home = ctx.home;
  // Step 1: exact id short-circuit (active OR archived-only descriptor) — no
  // prefix search, no ambiguity possible, byte-identical to pre-existing
  // full-id archive behaviour.
  if (readDescriptorPathState(descriptorPath(home, raw)).exists) return { ok: true, id: raw };
  const archiveDirState = checkedArchivedDir(home, { create: false });
  if (archiveDirState.ok) {
    const archivedPath = path.join(archiveDirState.path, raw + '.json');
    if (readDescriptorPathState(archivedPath).exists) return { ok: true, id: raw };
  }
  // Step 2: candidate pool = current project's active workspaces, same
  // derivation cmdWorkspacesList uses (cwd-derived worktree -> repoKey).
  let candidates = [];
  try {
    const worktree = resolveCallerWorktree(ctx.cwd || process.cwd());
    const workspaceId = worktree ? inst.primaryWorkspaceId(worktree) : undefined;
    const repoKey = worktree ? repokey.repoKeyForWorktree(worktree) : repoKeyForCwd(ctx);
    const s = store.openStore({ home, workspaceId, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
    let sum;
    try { sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now }); }
    finally { s.close(); }
    candidates = Object.keys(sum.workspaces || {}).filter((wid) => isSafeId(wid) && wid.startsWith(raw));
  } catch (_) {
    candidates = []; // fail-closed: an unresolvable project context yields no candidates, not a crash
  }
  if (candidates.length === 1) return { ok: true, id: candidates[0] };
  if (candidates.length === 0) {
    // Step 3: `raw` may be a MESH id (`primary-<hash>`, the label `send --to`
    // and the roster show) — resolve it through the same registry join `send
    // --to` uses (meshCandidateRows: every row whose worktree derives to that
    // meshId, live or not, since a done child being archived is rarely live).
    // A phantom row keyed BY the meshId is not an archivable workspace.
    const mesh = resolveMeshIdToWorkspaceIds(raw, ctx);
    if (mesh.length === 1) return { ok: true, id: mesh[0] };
    if (mesh.length > 1) {
      return {
        ok: false,
        error: 'ambiguous mesh id ' + JSON.stringify(raw) + ' matches ' + mesh.length
          + ' workspaces — archived nothing; use one full id: ' + mesh.join(', '),
        candidates: mesh,
      };
    }
    return { ok: false, error: 'invalid or missing workspace id' };
  }
  return {
    ok: false,
    error: 'ambiguous workspace id prefix ' + JSON.stringify(raw) + ' matches ' + candidates.length
      + ' workspaces — archived nothing; use the full id: ' + candidates.join(', '),
    candidates,
  };
}

// resolveMeshIdToWorkspaceIds(meshId, ctx) -> string[] of registry ids (full
// UUIDs) whose worktree derives to `meshId`, via meshCandidateRows (the join
// resolveMeshTarget/`send --to` use). Every such row (a phantom keyed by the
// meshId itself excluded) — unlike send, never picks the freshest live one:
// archiving the wrong twin is destructive, so >1 rows is reported as ambiguous.
// [] when none or on any resolution error (fail-closed: archive nothing).
function resolveMeshIdToWorkspaceIds(meshId, ctx) {
  try {
    const home = ctx.home;
    const worktree = resolveCallerWorktree(ctx.cwd || process.cwd());
    const repoKey = worktree ? repokey.repoKeyForWorktree(worktree) : repoKeyForCwd(ctx);
    const s = store.openStore({ home, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
    try {
      const rows = meshCandidateRows(s, meshId).filter((d) => d && d.id != null && String(d.id) !== String(meshId) && isSafeId(String(d.id)));
      return rows.map((d) => String(d.id)).sort(); // several rows: never guess which to archive
    } finally { s.close(); }
  } catch (_) { return []; }
}

// cmdUnarchive(id, ctx) — reverse of cmdArchive via restoreArchivedDescriptor:
// move the descriptor back into workspaces/ and revive the tombstoned registry
// row. Non-destructive, id-safe (the dispatcher gates `id` through isSafeId
// before this is ever called, same as `archive`). For undoing a wrong `archive`.
function cmdUnarchive(id, ctx) {
  const home = ctx.home;
  // P1-4: unarchive mutates the same descriptor+registry pair as register/archive
  // — run it under the SAME per-id lock so the three can never interleave.
  return withIdLock(id, home, () => {
    const r = restoreArchivedDescriptor(home, id, ctx, { requireOwnerKey: storeOwnerKeyFor(id, ctx) });
    if (!r.ok) return { ok: false, action: 'unarchive', id, error: r.error };
    return { ok: true, action: 'unarchive', id, descriptorRestored: true };
  });
}

function cmdArchiveIgnore(id, ctx, { set }) {
  const home = ctx.home;
  const dir = archiveIgnoreDir(home);
  const p = path.join(dir, id + '.json');
  if (set) {
    fs.mkdirSync(dir, { recursive: true });
    const mark = { id, ignoredAt: Number.isFinite(ctx.now) ? ctx.now : Date.now() };
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mark));
    fs.renameSync(tmp, p);
    return { ok: true, action: 'archive-ignore', id, ignored: true };
  }
  let removed = false;
  try { fs.unlinkSync(p); removed = true; } catch (_) { removed = false; }
  return { ok: true, action: 'archive-unignore', id, removed };
}

// skipFilePath(home) — computed identically to hooks/skip-guard.js's own
// SKIP_FILE constant (path.join(os.homedir(), '.anti-hall', 'skip.json')),
// just home-injectable like every other path helper above (workspacesDir,
// archiveIgnoreDir, ...) so tests can point it at a tmp HOME instead of the
// real machine. With ctx.home defaulting to os.homedir() (see run()), the
// production path is byte-identical to skip-guard.js's.
function skipFilePath(home) { return path.join(home, '.anti-hall', 'skip.json'); }

// buildArchiveRequestMessage(reason) — the exact posted string. `reason` is
// optional; when omitted the marker + instruction still stand alone.
function buildArchiveRequestMessage(reason) {
  const tail = 'your parent asks you to archive this workspace; confirm with your user, then run devswarm.js archive <id>.';
  return reason
    ? store.ARCHIVE_REQUEST_MARKER + ' ' + reason + ' — ' + tail
    : store.ARCHIVE_REQUEST_MARKER + ' — ' + tail;
}

// cmdArchiveRequest(id, flags, ctx) — v0.58 (PLAN.md CLI VERB CONTRACT): STORE
// WRITE, never a native hivecontrol call. Posts a parent->child `[[ANTIHALL_
// ARCHIVE_REQUEST]]` mesh-direct message straight into `id`'s OWN store
// partition — `id` is ALREADY the target's real read partition (its registered
// builder-id/workspaceId, the SAME semantics `heartbeat <id>` and `inbox read
// <id>` already use), so, unlike `send --to <meshId>`, no registry/meshId
// resolution is needed or performed. `urgency:'high'` (a mechanical, fixed
// choice — never 'urgent', which stays reserved for a sender's own judgment
// call elsewhere). AGNOSTIC: this verb never itself verifies merged/tested/
// deployed — that stays the RECEIVING parent's own repo policy; the message
// only reminds, never gates. DELETES the OLD native `list children` lookup +
// `message-child` spawn (pre-v0.58: resolveChildBranch + ctx.io.run) — the
// marker now travels over the SAME daemon-independent mesh path every other
// send uses, closing the one native-messaging leak the command-guard could
// never catch (a spawned `message-child` call is invisible to a guard that
// only inspects the FIRST hivecontrol subcommand token by design).
function cmdArchiveRequest(id, flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };

  // #16: a message posted to a target with NO live session can never be
  // read — nothing is left running to pull its inbox — so it just feeds the
  // parent-inbox nag forever ("archive-request sent" but never acted on).
  // When the target ALSO already has its own descriptor (id-only/never-
  // registered targets fall straight through to the existing message path,
  // unchanged — archive-request has never required a registry row, see the
  // header comment above), a dead+archive-ready target is archived directly
  // via the existing `archive` path instead of posting an unreadable
  // message. Fail-open toward the original message-based behavior on any
  // read/resolution error.
  const descForRequest = readDescriptorFile(home, id);
  if (descForRequest) {
    let liveTarget = true;
    try {
      liveTarget = computeRowLive(
        { id, worktreePath: descForRequest.worktreePath, sessionId: descForRequest.sessionId },
        home, { now: ctx.now }
      );
    } catch (_) { liveTarget = true; }
    if (!liveTarget) {
      let archiveReady = false;
      try {
        const summaryForRequest = store.readSummaryForHash(home, repoKey);
        const entryForRequest = summaryForRequest && summaryForRequest.workspaces
          && summaryForRequest.workspaces[id];
        archiveReady = !!(entryForRequest && entryForRequest.archive_ready === true);
      } catch (_) { archiveReady = false; }
      if (archiveReady) {
        // Re-check liveness INSIDE cmdArchive's per-id lock, immediately
        // before the archive (same P1-5 pattern reap-stale/reconcile-active
        // already use above) — the outside-the-lock computeRowLive check at
        // the top of this function is a candidate filter only; a target that
        // heartbeats or commits between that check and here must be skipped,
        // not wrong-archived.
        const archiveResult = cmdArchive(id, ctx, {
          revalidate: (desc) => {
            let liveNow = true;
            try {
              liveNow = computeRowLive(
                { id, worktreePath: (desc && desc.worktreePath) || descForRequest.worktreePath, sessionId: (desc && desc.sessionId) || descForRequest.sessionId },
                home, { now: ctx.now }
              );
            } catch (_) { liveNow = true; }
            return liveNow ? 'became-live' : null;
          },
        });
        return Object.assign({}, archiveResult, {
          action: 'archive-request', id, childId: id, posted: false,
          autoArchived: !!archiveResult.ok,
          reason: one(flags, 'reason') || null,
          note: 'target has no live session and is archive-ready; archived directly '
            + 'instead of posting a message it could never read',
        });
      }
    }
  }

  const reason = one(flags, 'reason');
  const message = buildArchiveRequestMessage(reason);
  const from = senderIdentityDetailed(ctx.env, cwd, registrySnapshot(ctx, repoKey), home).identity;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  // A3 (partial fix, v0.66 review): serialize against a concurrent rehome/
  // retire of THIS SAME id — the SAME per-id lock cmdSend's orphan-race fix
  // uses — so a rehomeAcrossStores that migrates id's registry row + backlog
  // to ANOTHER project's store cannot interleave between this call's store
  // resolution and its append (the "rehoming" leg of the reported defect;
  // once inside the lock, no concurrent mutator of this id can run, since
  // every mutator — register/archive/rehome — takes the identical lock).
  //
  // Deliberately UNCHANGED for a childId that carries NO registry row in this
  // store at all: unlike `send --to <meshId>`, archive-request has never
  // required registry membership — `id` IS its own read partition by design
  // (the SAME semantics `heartbeat <id>`/`inbox read <id>` already use; see
  // this function's own header comment) — and this is an explicitly TESTED
  // contract ("archive-request makes ZERO hivecontrol calls" /
  // devswarm-cli.test.js posts to an id that was never registered and expects
  // ok:true). A genuinely typo'd or already-retired childId is therefore
  // STILL NOT detectable here: both states are represented identically as
  // "no registry row", and retiring a row (foldGroupIntoSurvivor) tombstones
  // it outright with no redirect record to consult — see openConcerns.
  return withIdLock(String(id), home, () => {
    const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
    try {
      const fields = { from, to: id, type: 'direct', message, timestamp: now, urgency: 'high' };
      const hash = store.meshMessageHash(fields);
      const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash, instanceNonce: dispatcherExports().deriveReaderNonce(ctx) }));
      store.deriveSummary(s, { home, env: ctx.env, now });
      return {
        ok: true, action: 'archive-request', id, childId: id, posted: true,
        sent: !!res.inserted, seq: res.seq, reason: reason || null,
        reminder: 'Ensure you have verified merged + tested + deployed per your repo policy before archiving.',
      };
    } finally { s.close(); }
  });
}

// phantomPrimaryRows(home, ctx0) -> { ok, action, dryRun, phantoms: [{ id, worktreePath,
// canonicalId, canonicalWorktree, archived? , error? }], archived, errors }.
// Repairs persisted state earlier versions broke: register-primary / `workspaces
// list` run from a SUBMODULE cwd minted `primary-<submodule-toplevel-hash>` (the raw
// `git --show-toplevel`). A phantom is a `primary-<8hex>` descriptor whose worktree
// resolves (identity.resolveContext) into a submodule of ANOTHER registered Primary's
// worktree, whose own id is that root's meshId. Detect is read-only; with
// ctx0.repair === true each phantom is ARCHIVED via cmdArchive (tombstone, reversible
// through `unarchive`) — never deleted, never run implicitly. Idempotent (an archived
// descriptor leaves workspaces/, so a second run finds nothing), fail-open per row.
function phantomPrimaryRows(home, ctx0) {
  const repair = !!(ctx0 && ctx0.repair);
  const out = { ok: true, action: 'phantom-primary-rows', dryRun: !repair, phantoms: [], archived: 0, errors: 0 };
  let names = [];
  try { names = fs.readdirSync(workspacesDir(home)); } catch (_) { return out; }
  const rows = [];
  for (const n of names) {
    const m = /^(primary-[0-9a-f]{8})\.json$/.exec(n);
    if (!m) continue;
    const d = readDescriptorFile(home, m[1]);
    if (d && d.worktreePath) rows.push({ id: m[1], worktreePath: String(d.worktreePath) });
  }
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    try {
      const c = identityContext(r.worktreePath);
      if (!c.worktreeRoot || !(c.submoduleDepth > 0) || c.meshId === r.id || !ids.has(c.meshId)) continue;
      const root = rows.find((x) => x.id === c.meshId);
      let rootReal = null;
      try { rootReal = fs.realpathSync(root.worktreePath); } catch (_) { rootReal = null; }
      if (rootReal !== c.worktreeRoot) continue; // the named Primary must really sit at the folded root
      const ph = { id: r.id, worktreePath: r.worktreePath, canonicalId: c.meshId, canonicalWorktree: c.worktreeRoot };
      if (repair) {
        try {
          const a = cmdArchive(r.id, Object.assign({ home, env: process.env }, ctx0, { cwd: r.worktreePath, repair: undefined }), { flags: {} });
          if (a && a.ok) { ph.archived = true; out.archived += 1; } else { ph.error = (a && a.error) || 'archive failed'; out.errors += 1; }
        } catch (e) { ph.error = String((e && e.message) || e); out.errors += 1; }
      }
      out.phantoms.push(ph);
    } catch (_) { /* fail-open per row */ }
  }
  if (out.errors) out.ok = false;
  return out;
}

module.exports = {
  archivedTombstoneIsOrphaned, APP_ARCHIVE_RETRYABLE_RE, APP_ARCHIVE_TIMEOUT_MS, appBuilderGate,
  hcArchiveCall, verifyAppArchived, appSideSnapshot, attemptAppArchive, localArchivedAppLive,
  appLiveArchivedRows, appOnlyArchive, cmdArchive, resolveArchiveId, resolveMeshIdToWorkspaceIds,
  cmdUnarchive, cmdArchiveIgnore, skipFilePath, buildArchiveRequestMessage, cmdArchiveRequest,
  phantomPrimaryRows,
};
