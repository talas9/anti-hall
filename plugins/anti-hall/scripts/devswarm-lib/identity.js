'use strict';
// anti-hall :: devswarm CLI — IDENTITY module (scripts/devswarm-lib/identity.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  alog, CALLER_CWD, CLI_PATH, cliRowLog, crypto, descriptorRegisteredRepoKey, dispatcherExports,
  fs, hasFreshHeartbeat, heartbeatPathFor, identity, identityContext, inst, isDormantRow, isSafeId,
  isSiblingPartitionLive, livenessSelect, one, os, path, pidIsAlive, processStartMs,
  readDescriptorFile, readDescriptors, readerCursors, readerIdentity, readRetiredRedirect, repokey,
  resolveStableCliPath, rowEligibilityLib, sessionsDirFor, store, storeOwnerKeyFor,
  upsertStoreRegistry, writeDescriptorAtomic,
} = require('./core.js');

// SYNTHETIC_SESSION_PREFIX / isLiveSessionId (A6, v0.66 review): a registry
// row's `sessionId` used to be the ONLY liveness signal every mesh-addressing/
// fold primitive in this file read for ROUTING/FOLD decisions (resolveMeshTarget,
// pickSurvivor, groupRegistryByMeshId's liveRows) — a bare "non-empty,
// non-synthetic sessionId" shape test, with no heartbeat/dormancy correlation.
// D11-A (f56dcc08f048) MOVED those three onto isRoutingLiveRow (below —
// composes companion/lib/liveness.js's isSiblingPartitionLive, the SAME
// heartbeat-freshness + harness-session-dormancy predicate siblingAckGate
// (:367) and the fold's own mesh-anchor check (~:2520) already use, plus a
// descriptor-existence fallback for a just-registered row with no heartbeat
// yet), so a real-but-long-dead sessionId (e.g. a crashed sibling whose
// registry row was never cleaned up) can no longer be routed/folded to as
// "live" the way computeDiagnosis's `rows[].live` display field already
// stopped trusting it. rehomeMiskeyedRow's identity confirmation is a
// DIFFERENT question (same-entity confirmation, not a drain/routing
// decision) and deliberately keeps the bare isLiveSessionId shape test — see
// that function's own comment for why. This predicate (isLiveSessionId)
// remains the raw shape test other non-routing call sites in this file still
// use directly (pickArchiveForwardSurvivor, archiveLeftReason, etc — out of
// scope for this migration). Historical note: a non-empty sessionId alone was
// never proof a session was still running — closing a workspace never
// deletes its registry row, so a once-real sessionId was trusted forever
// unless something aged it out. cmdInboxPull's auto-ensure/self-register path
// used to MINT a sessionId from `id` itself when neither `--session` nor
// DEVSWARM_BUILDER_ID was supplied, so a reconcile-spawned phantom (a bare
// registry seed with no live session behind it at all) became permanently
// "live" the instant it was auto-ensured — `resolveMeshTarget` could then
// route a `send` to a partition nothing will ever drain.
//
// Fix: mint a value carrying this PREFIX instead of the bare id (still
// non-empty/truthy, satisfying cmdRegister's own "register requires
// --session" validation — a descriptor with a null/empty sessionId is
// rejected outright at creation, so leaving it null is not viable without
// also relaxing that unrelated invariant), and make the shared liveness
// predicate EXCLUDE it explicitly. POLARITY WARNING (named in the review):
// the live filter is "sessionId non-empty" — a marker string would still
// read as live unless every liveness check is updated to exclude it
// deliberately, which is why every liveness check-site in THIS file below is
// migrated to call this one predicate instead of re-deriving the same
// "non-empty" test inline.
const SYNTHETIC_SESSION_PREFIX = 'unclaimed:';
function isLiveSessionId(sessionId) {
  if (sessionId == null) return false;
  const s = String(sessionId);
  if (s === '') return false;
  return !s.startsWith(SYNTHETIC_SESSION_PREFIX);
}

// computeRowLive(row, home, opts) -> bool. THE ONE display-liveness predicate
// shared by cmdDiagnose's `rows[].live` and rosterHints' phantom check (defect
// 298b79969409): field-verified divergence — rosterHints' dormancy hint comes
// from rowLivenessState (companion/lib/liveness.js), which NEVER checks
// isLiveSessionId and returns 'active' (no hint at all) as soon as
// isDormantByActivity is false, regardless of whether the row even has a real
// sessionId. cmdDiagnose's `live` field, by contrast, requires
// isLiveSessionId(sid) (unless there is a FRESH heartbeat) before it will ever
// read true. Because hasFreshHeartbeat's freshness window is materially
// TIGHTER than isDormantByActivity's dormant/idle window, a phantom row (no
// real sessionId, heartbeat stale-by-freshness-standard but still within the
// wider activity window) can read as roster-active (hints:[]) while
// cmdDiagnose reports live:false for the identical row — exactly the field
// report (twin row: roster hints [], diagnose live:false; a child trusted the
// roster hint and stranded mail on it). Both surfaces now derive from this one
// function. Fail-open: any throw -> not live (an unproven row never displays
// as more alive than the evidence supports).
function computeRowLive(row, home, opts) {
  const o = opts || {};
  try {
    if (hasFreshHeartbeat(row && row.id, home, { now: o.now })) return true;
  } catch (_) { /* fall through */ }
  try {
    if (isLiveSessionId(row && row.sessionId)) {
      return !isDormantRow({ id: row.id, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, { now: o.now });
    }
  } catch (_) { return false; }
  return false;
}

// isArchivedForRouting(row, home) -> bool. Shared ARCHIVE GATE for BOTH routing
// liveness predicates below (defect d386d8a610b7, field: 25 heartbeat daemons
// found still running 1-5 days after their workspace was archived IN THE APP —
// the app-side daemon launcher is external to anti-hall and this plugin cannot
// stop it, so the fix has to be on the READ side). Neither isRoutingLiveRow nor
// isRoutingLiveRowStrict previously checked archived state at all — both
// composed straight from isSiblingPartitionLive's heartbeat-freshness signal,
// so a stale ORPHANED daemon still beating for an archived row read as
// genuinely live for REAL routing decisions (pickSurvivor/resolveMeshTarget
// target selection, and groupRegistryByMeshId's split/kind classification that
// `diagnose`/`reap-orphans` act on) — not just cosmetic display. Uses THE
// row-state derivation (companion/lib/row-state.js — anti-hall's archived
// marker first, then the app-side archived-set cache via the row's own
// registered repoKey) that rosterHints/cmdDiagnose/the parent gate also use,
// so a row can never be "archived" on one surface and "live enough to route
// to" on another. Fail-open: any throw -> not archived (never wrongly
// suppress a row this check cannot prove is archived).
function isArchivedForRouting(row, home) {
  if (!row || row.id == null) return false;
  let repoKey = null;
  try { repoKey = descriptorRegisteredRepoKey(readDescriptorFile(home, row.id), row.id); } catch (_) { repoKey = null; }
  return rowEligibilityLib.rowEligibility(
    { id: row.id, worktreePath: row.worktreePath, sessionId: row.sessionId || null, repoKey },
    { home, log: cliRowLog }
  ).archived;
}

// isRoutingLiveRowStrict(row, home, opts) -> bool. D11-A (f56dcc08f048): the
// STRICT liveness gate for a TARGET-SELECTION decision — resolveMeshTarget/
// pickSurvivor's pickFreshestLive candidate filter — where the question is
// "will THIS row actually drain what gets routed to it". A bare
// isSiblingPartitionLive call (companion/lib/liveness.js — the SAME
// heartbeat-freshness + harness-session-dormancy predicate siblingAckGate
// (:367 in this file) and the fold's own mesh-anchor check (~:2520) already
// use), with NO descriptor-existence fallback: CONFIRMED regression (see
// tests/scripts/devswarm-fold-forwarded-derive.test.js) that adding one here
// lets a store-only, sessionId:null row with a merely-lingering descriptor
// file outrank a GENUINELY live sibling purely on `updatedAt` recency inside
// pickFreshestLive's ranking — the exact "descriptor proves only that a
// workspace once existed, never that anything will drain it" hazard
// pickArchiveForwardSurvivor's own header already documents (STRICT vs
// CONSERVATIVE, ~:2794): a descriptor-existence fallback is the right,
// conservative answer for "should this row be protected from tombstoning"
// (isRoutingLiveRow below, for groupRegistryByMeshId's REPORTING-only
// liveRows counter) and the wrong, unsafe answer for "which row should be
// treated as authoritative" (this function, for actual send/fold routing).
// Fail-open: any throw -> not live (undetermined never wins a selection).
function isRoutingLiveRowStrict(row, home, opts) {
  if (!row || row.id == null) return false;
  if (isArchivedForRouting(row, home)) return false; // defect d386d8a610b7
  try {
    return !!isSiblingPartitionLive({ id: row.id, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, opts);
  } catch (_) { return false; }
}

// isRoutingLiveRow(row, home, opts) -> bool. D11-A (f56dcc08f048): the shared
// liveness gate for groupRegistryByMeshId's `liveRows` — a REPORTING-only
// counter (computeDiagnosis's meshTargets kind/split/deadSplit; it does not
// itself pick a fold/send target — see isRoutingLiveRowStrict above for that,
// STRICTER, decision) — replacing the bare isLiveSessionId(sessionId) shape
// test that counter used to read directly (see the header above, now
// updated). Composes isSiblingPartitionLive with a descriptor-existence
// fallback, mirroring the fold's own `live || readDescriptorFile(...) ||
// readerEvidence` composition (~:2525): a row that has JUST been `register`ed
// (a synthetic `unclaimed:` sessionId, no heartbeat file written yet) reads
// NOT live from isSiblingPartitionLive alone (its register-only-phantom
// branch) even though it is not actually dead — its descriptor
// (workspaces/<id>.json, written by register before/alongside the registry
// upsert) already exists, which is the same "something observable exists"
// signal the fold falls back to. `readerEvidence` (the fold's cursor-based
// third term) is intentionally NOT reproduced here — it needs an open store
// handle + cursor read the fold already holds at its call site that this
// counter does not carry the same way; descriptor existence is the evidence
// it can uniformly check instead.
// Fail-open: any throw from either half leaves the row NOT live only when
// BOTH checks fail; never disqualifies on a partial failure.
function isRoutingLiveRow(row, home, opts) {
  if (!row || row.id == null) return false;
  if (isArchivedForRouting(row, home)) return false; // defect d386d8a610b7
  try {
    if (isSiblingPartitionLive({ id: row.id, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, opts)) return true;
  } catch (_) { /* fall through to descriptor fallback */ }
  try { return !!readDescriptorFile(home, row.id); } catch (_) { return false; }
}

// appSessionOnWorktree(home, env, sessionId, worktree) -> null | { verdict,
// builderId, builderType, terminalActive }. v0.108.0: the DevSwarm app DB maps a
// Claude session id to the worktree it runs in (builder_terminals.ai_session_config
// -> builders.worktreePath). AUTHORITATIVE ONLY WHEN CORROBORATED by Claude's own
// transcript (measured: only ~55% of mapped sessions still have a transcript;
// where one exists its cwd matched 11/11 and 129/130): verdict true = the
// session's transcript under `worktree` records that cwd; false = its transcript
// under the app's OTHER worktree records that one. Anything unproven -> null (no
// opinion) and callers keep their existing logic. Never throws.
function appSessionOnWorktree(home, env, sessionId, worktree) {
  try {
    if (!sessionId || !worktree) return null;
    const appDb = require('../../companion/lib/devswarm-app-db.js');
    const snap = appDb.snapshot({ home, env: env || process.env });
    const own = appDb.sessionOwner(snap, String(sessionId));
    if (!own || !own.worktreePath) return null;
    const a = canonicalWorktreeRealPath(String(own.worktreePath)) || String(own.worktreePath);
    const b = canonicalWorktreeRealPath(String(worktree)) || String(worktree);
    const same = a === b;
    // Claude files the transcript under the cwd AS LAUNCHED: try the app's own
    // spelling, then the caller's (same) / canonical one.
    const spellings = [own.worktreePathRaw, same ? String(worktree) : null, same ? b : a].filter(Boolean);
    if (!spellings.some((p) => appDb.transcriptCwdMatches(home, String(sessionId), p) === true)) return null;
    return { verdict: same, builderId: own.builderId, builderType: own.builderType, terminalActive: own.terminalActive };
  } catch (_) { return null; }
}

// callerIdentity(env, cwd) -> string. Who is invoking this CLI process, for the
// ack-ownership check (cross-workspace ack hazard, bug #2).
//
// CWD IS GROUND TRUTH (P0 fix): a caller's cwd tells us, mechanically, which
// worktree/workspace process is actually running. When cwd resolves to a REAL
// git worktree, identity MUST derive from cwd — a `DEVSWARM_BUILDER_ID` env var
// that names a DIFFERENT workspace is IGNORED (never trusted to override), so a
// workspace cannot set `DEVSWARM_BUILDER_ID=<other-id>` (deliberately, or via
// ordinary env inheritance from a parent process) to impersonate another
// workspace and advance ITS cursor. `DEVSWARM_BUILDER_ID` is honored as a
// DECLARED identity only in the two cases where it cannot contradict cwd:
//   1. cwd resolves to a worktree AND the env value already MATCHES the
//      cwd-derived id (redundant declaration, not an override).
//   2. cwd does NOT resolve to any git worktree at all (no ground truth exists
//      to contradict it) — e.g. a daemon/unit whose cwd defaults to $HOME.
// Worktree resolution: resolveCallerWorktree(cwd) (identity.js, pure fs — no git
// spawn for any common layout). Only when it does not resolve does cwd fail to
// resolve to a workspace at all (case 2 above; final fallback =
// primaryWorkspaceId(raw cwd) so callerIdentity always returns a deterministic
// non-empty string).
// resolveCallerWorktree(cwd) -> the RESOLVED git worktree/toplevel for `cwd`, or
// null when `cwd` is not inside any git worktree. This is the SINGLE primitive
// used to canonicalize a cwd into a workspace identity (mesh redesign Phase 2,
// B2): identity.resolveContext(cwd).worktreeRoot — the key-bearing root, pure fs,
// so a registry sweep no longer pays 2 git spawns per row (#11). A submodule of
// ANY kind (absorbed, non-absorbed, nested, in a linked worktree) resolves to its
// OUTERMOST superproject (owner decisions 1+2). This takes a CALLER's cwd: one that
// no longer exists resolves from its nearest existing ancestor (registry/row paths
// never do — see identityContext). Callers that must agree on a
// worktree's meshId — callerIdentity (identity derivation) AND cmdInboxPull (the
// registered worktreePath that `send --to` later hashes) — MUST route through
// this so a subdirectory cwd canonicalizes to the SAME toplevel both places
// (bug: a child that ran `inbox pull` from a git SUBDIR registered the raw
// subdir path, which hashed to a meshId no `send --to` could resolve — the child
// became unaddressable, failing closed as `unregistered-recipient`).
function resolveCallerWorktree(cwd) {
  return identityContext(cwd || process.cwd(), CALLER_CWD).worktreeRoot || null;
}
// projectCwdFor(ctx) -> the cwd whose worktree identifies THIS invocation's
// project/workspace. The caller's own cwd when it resolves to a git worktree
// (ground truth always wins). When it does NOT (e.g. a scratchpad dir), fall
// back to the worktree of the workspace DECLARED by env.DEVSWARM_BUILDER_ID, via
// its registered descriptor, else to CLAUDE_PROJECT_DIR (a Primary has no builder
// id) — the same "declared identity is trusted only when no
// worktree ground truth contradicts it" rule callerIdentity applies. Used by
// send / heartbeat --summary / mesh read so they no longer fail `no-project`
// from a non-worktree cwd. Fail-open: any miss returns the original cwd.
function projectCwdFor(ctx) {
  const cwd = (ctx && ctx.cwd) || process.cwd();
  try {
    if (resolveCallerWorktree(cwd)) return cwd;
    const bid = ctx && ctx.env && ctx.env.DEVSWARM_BUILDER_ID ? String(ctx.env.DEVSWARM_BUILDER_ID) : '';
    if (bid) {
      const d = readDescriptorFile(ctx.home, bid);
      const wt = d && typeof d.worktreePath === 'string' ? d.worktreePath : '';
      if (wt && path.isAbsolute(wt) && fs.existsSync(wt) && resolveCallerWorktree(wt)) return wt;
    }
    // A Primary usually has no builder id: fall back to the harness-set project
    // root (CLAUDE_PROJECT_DIR) under the same fail-closed rule (absolute, exists,
    // resolves to a git worktree through the canonical resolver).
    const pd = ctx && ctx.env && ctx.env.CLAUDE_PROJECT_DIR ? String(ctx.env.CLAUDE_PROJECT_DIR) : '';
    if (pd && path.isAbsolute(pd) && fs.existsSync(pd) && resolveCallerWorktree(pd)) return pd;
  } catch (_) { /* fall through to the raw cwd */ }
  return cwd;
}
// callerIdentityDetailed(env, cwd) -> { identity, kind }. Same resolution as
// callerIdentity below, but ALSO names WHICH of the three legs produced the
// identity (A7, v0.66 review) — 'resolved' (cwd matched a real git worktree —
// independently-verifiable ground truth), 'declared' (no worktree ground
// truth, but a DEVSWARM_BUILDER_ID env value was trusted — a legitimate,
// still-meaningful declaration), or 'unresolvable' (neither — the raw-cwd-
// hash fallback: this identity carries NO independently-verifiable ground
// truth at all, the ambiguous case a caller-ownership refusal reason must be
// able to name explicitly instead of collapsing into the same generic "does
// not own workspace" text as a genuine mismatch).
function callerIdentityDetailed(env, cwd) {
  const bid = env && env.DEVSWARM_BUILDER_ID ? String(env.DEVSWARM_BUILDER_ID) : null;
  const c = cwd || process.cwd();
  const wt = resolveCallerWorktree(c);
  if (wt) return { identity: inst.primaryWorkspaceId(wt), kind: 'resolved' };
  if (bid) return { identity: bid, kind: 'declared' };
  return { identity: inst.primaryWorkspaceId(c), kind: 'unresolvable' };
}
function callerIdentity(env, cwd) {
  const bid = env && env.DEVSWARM_BUILDER_ID ? String(env.DEVSWARM_BUILDER_ID) : null;
  const c = cwd || process.cwd();
  const wt = resolveCallerWorktree(c);
  if (wt) {
    // cwd resolves to a real workspace: identity derives from cwd. A mismatching
    // declared env id is NOT trusted to override it (the spoof this guard exists
    // to close); a matching one is a no-op (same value either way).
    return inst.primaryWorkspaceId(wt);
  }
  // No ground truth: cwd does not resolve to any workspace. A declared env
  // identity is trusted here (nothing to contradict it); otherwise fall back to
  // a deterministic id derived from the raw cwd (fail-open, never null).
  if (bid) return bid;
  return inst.primaryWorkspaceId(c);
}
// isPrimaryCheckout(worktreeRoot, mainWorktree, home, env) -> bool (v0.108.0).
// The project's real Primary checkout is the one the DevSwarm app records as
// `builderType = 'primary'`; with no app record (no app DB, no row, ambiguous)
// it is the repo's MAIN worktree. Every other worktree is a child.
function isPrimaryCheckout(worktreeRoot, mainWorktree, home, env) {
  if (!worktreeRoot) return false;
  let b = null;
  try { b = require('../../companion/lib/devswarm-app-db.js').builderForWorktree({ home, env, worktreePath: worktreeRoot }); } catch (_) { b = null; }
  if (b && b.builderType) return b.builderType === 'primary';
  let main = mainWorktree || null;
  try { if (main) main = fs.realpathSync(main); } catch (_) { /* keep as-is */ }
  return !!main && main === worktreeRoot;
}
// childSenderId(env, cwd, registry, home) -> the caller's registered child id,
// or null (v0.108.0 identity fix). Before this, EVERY caller's `from` was the
// worktree meshId `primary-<hash>` — children included — so a child's sends
// and broadcasts read as "another Primary" and a resumed Primary stood down.
// null for the Primary checkout. For a child, the id must be a REGISTRY row
// on the caller's own worktree (so a reply to it routes): the declared
// DEVSWARM_BUILDER_ID row (declaredSelfId), else the app's builder id for this
// worktree when registered, else the ONE non-`primary-` row on the worktree.
// Anything ambiguous -> null (the caller keeps the meshId; never invented).
function childSenderId(env, cwd, registry, home) {
  try {
    const c = cwd || process.cwd();
    const ctx = identityContext(c, CALLER_CWD);
    const wt = ctx.worktreeRoot;
    if (!wt || isPrimaryCheckout(wt, ctx.mainWorktree, home, env)) return null;
    const rows = registry || [];
    const declared = declaredSelfId(env, c, rows);
    if (declared) return declared;
    const onWt = rows.filter((r) => r && r.id != null && r.worktreePath
      && canonicalWorktreeRealPath(String(r.worktreePath)) === wt && !/^primary-/.test(String(r.id)));
    let app = null;
    try { app = require('../../companion/lib/devswarm-app-db.js').builderForWorktree({ home, env, worktreePath: wt }); } catch (_) { app = null; }
    if (app && rows.some((r) => r && String(r.id) === String(app.id))) return String(app.id);
    const ids = Array.from(new Set(onWt.map((r) => String(r.id))));
    return ids.length === 1 ? ids[0] : null;
  } catch (_) { return null; }
}
// senderIdentityDetailed(env, cwd, registry, home) -> { identity, kind, meshId? }.
// The SENDER LABEL (`from`) for send / archive-request / merge broadcasts. Same
// as callerIdentityDetailed, except a resolved CHILD worktree answers with its
// registered child id (kind 'child', meshId = the worktree label it replaces).
// Ack ownership / partition identity still use callerIdentity — unchanged.
function senderIdentityDetailed(env, cwd, registry, home) {
  const d = callerIdentityDetailed(env, cwd);
  if (d.kind !== 'resolved') return d;
  const child = childSenderId(env, cwd, registry, home);
  if (!child || child === d.identity) return d;
  try { require('../../companion/lib/devswarm-sender-alias.js').writeAlias(home, d.identity, child, resolveCallerWorktree(cwd)); } catch (_) { /* display alias is best-effort */ }
  return { identity: child, kind: 'child', meshId: d.identity };
}
// registrySnapshot(ctx, repoKey) -> registry rows for the sender label (fail-open []).
function registrySnapshot(ctx, repoKey) {
  let s = null;
  try {
    s = store.openStore({ home: ctx.home, hash: repoKey, backend: ctx.backend, env: ctx.env });
    return s.listRegistry() || [];
  } catch (_) { return []; } finally { try { if (s) s.close(); } catch (_) {} }
}
// childLabelRefusal(id, flags, ctx) -> null | refusal result (v0.108.0).
// `primary-<hash>` of a CHILD worktree is not an identity anyone owns: spawn
// seeds it as a placeholder, and a heartbeat/register under it (field repro: the
// Primary ran `heartbeat primary-<childhash>` from its own cwd) makes a twin row
// of the real child look live. Resolved from the registry row for `id` (or, for
// a caller's own label, its cwd; or --worktree). Refused when the child has a
// registered id (named in `resolvedTo`), or when the caller is the Primary
// checkout. Never mints or writes anything. Fail-open null.
function childLabelRefusal(id, flags, ctx) {
  try {
    if (!/^primary-[0-9a-f]{8}$/.test(String(id))) return null;
    const env = (ctx && ctx.env) || {};
    const home = ctx && ctx.home;
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const repoKey = repokey.repoKeyForWorktree(cwd);
    const registry = repoKey ? registrySnapshot(ctx, repoKey) : [];
    const row = registry.find((r) => r && String(r.id) === String(id));
    let wt = null;
    const wtFlag = flags ? one(flags, 'worktree') : undefined;
    if (row && row.worktreePath) wt = canonicalWorktreeRealPath(String(row.worktreePath));
    else if (wtFlag && canonicalMeshId(String(wtFlag)) === String(id)) wt = canonicalWorktreeRealPath(String(wtFlag));
    else if (callerIdentity(env, cwd) === String(id)) wt = resolveCallerWorktree(cwd);
    // 0.108.4: a label already folded away (retired/<id>.json names its
    // canonical id) is never re-minted, even with no row/worktree left to check.
    const redirect = home ? readRetiredRedirect(home, id) : null;
    const retiredTo = redirect && redirect !== String(id) ? redirect : null;
    if (!wt) {
      if (!retiredTo) return null;
      return {
        ok: false, reason: 'child-label-id', id: String(id), resolvedTo: retiredTo, worktree: null,
        error: JSON.stringify(String(id)) + ' is a retired worktree label (folded into ' + JSON.stringify(retiredTo)
          + '), not an identity. Nothing was written.',
      };
    }
    const ic = identityContext(wt);
    if (isPrimaryCheckout(ic.worktreeRoot, ic.mainWorktree, home, env)) return null;
    const kids = Array.from(new Set(registry.filter((r) => r && r.id != null && !/^primary-/.test(String(r.id))
      && r.worktreePath && canonicalWorktreeRealPath(String(r.worktreePath)) === wt).map((r) => String(r.id))));
    let app = null;
    try { app = require('../../companion/lib/devswarm-app-db.js').builderForWorktree({ home, env, worktreePath: wt }); } catch (_) { app = null; }
    const childId = (app && kids.includes(String(app.id)) ? String(app.id) : (kids.length === 1 ? kids[0] : null)) || retiredTo;
    if (!childId) {
      // No registered child id: the label is still the only identity that
      // worktree has (legacy/non-DevSwarm children) — allowed, EXCEPT from the
      // Primary checkout, which never heartbeats/registers a child's label.
      const callerIc = identityContext(cwd, CALLER_CWD);
      const fromPrimary = callerIc.worktreeRoot && callerIc.worktreeRoot !== wt
        && isPrimaryCheckout(callerIc.worktreeRoot, callerIc.mainWorktree, home, env);
      if (!fromPrimary) return null;
    }
    return {
      ok: false, reason: 'child-label-id', id: String(id), resolvedTo: childId, worktree: wt,
      error: JSON.stringify(String(id)) + ' is the worktree label of a CHILD workspace (' + wt + '), not an identity — '
        + (childId ? 'use its workspace id ' + JSON.stringify(childId) : 'the child has not registered its workspace id yet')
        + '. Nothing was written. A child heartbeats its own DEVSWARM_BUILDER_ID; the Primary never heartbeats a child.',
    };
  } catch (_) { return null; }
}
// declaredSelfId(env, cwd, registry) -> the caller's DECLARED id
// (DEVSWARM_BUILDER_ID) when it names a registry row on the caller's OWN
// worktree, else null (dual-partition defect, 0.106.0 field report).
//
// ROOT CAUSE this closes: a DevSwarm-launched Primary is ONE process with TWO
// names — its cwd-derived `primary-<hash>` (callerIdentity, what register-primary
// registers) and the hivecontrol workspace UUID in DEVSWARM_BUILDER_ID (what its
// children address it by and what its wake cron ticks). callerIdentity ignores a
// mismatching env id (the spoof guard), so to every ack path the UUID row was a
// FOREIGN LIVE sibling (its heartbeat is kept fresh by this same process's
// `inbox tick`): read-primary delivered its rows through the mesh union but
// siblingAckGate refused the ack, so they stayed unread there forever (parent
// table "CHILD NOT DRAINING" about the Primary itself, wake-watch totals that
// read-primary could not reproduce) and `read-primary <uuid>` was refused as
// ownership-mismatch whenever pickFreshestLive ranked the other row first.
//
// The env id is honoured ONLY with worktree ground truth: the named row must
// sit on the worktree the caller's cwd resolves to. A process can therefore
// only claim a row registered on its own worktree under the exact id it was
// launched with — two live children on one worktree carry two different
// DEVSWARM_BUILDER_IDs and still never ack each other (Wave 6), and no process
// outside the row's worktree gains anything. Fail-closed: any throw -> null.
function declaredSelfId(env, cwd, registry) {
  try {
    const bid = env && env.DEVSWARM_BUILDER_ID ? String(env.DEVSWARM_BUILDER_ID) : '';
    if (!bid) return null;
    const callerWt = canonicalWorktreeRealPath(resolveCallerWorktree(cwd || process.cwd()));
    if (!callerWt) return null;
    const row = (registry || []).find((r) => r && String(r.id) === bid);
    if (!row || !row.worktreePath) return null;
    return canonicalWorktreeRealPath(String(row.worktreePath)) === callerWt ? bid : null;
  } catch (_) { return null; }
}
// ownsAsDeclaredSelf(s, ctx, id) -> bool: `id` is the caller's declared self
// row (declaredSelfId). The ownership leg every read/ack gate adds beside
// `caller === id || ownEntry.id === id`.
function ownsAsDeclaredSelf(s, ctx, id) {
  let registry = [];
  try { registry = s.listRegistry() || []; } catch (_) { return false; }
  const self = declaredSelfId(ctx && ctx.env, ctx && ctx.cwd, registry);
  return self != null && self === String(id);
}
// ownershipRefusalCause(callerKind, ownEntry) -> a stable reason string naming
// WHICH leg of the ownership check failed (A7): the caller's own identity had
// no verifiable ground truth at all ('unresolvable-caller-identity'), the
// caller resolved fine but has no registry entry of its own in this store
// ('caller-not-registered'), or the caller IS registered but under a
// DIFFERENT id than the one it tried to act on ('ownership-mismatch').
function ownershipRefusalCause(callerKind, ownEntry) {
  if (callerKind === 'unresolvable') return 'unresolvable-caller-identity';
  if (!ownEntry) return 'caller-not-registered';
  return 'ownership-mismatch';
}

// ownerAppDbEnv(ctx) -> the env object to hand the (a0) first-claim leg's
// app-DB "ground truth" reader (companion/lib/devswarm-app-db.js's
// `builderForWorktree`), NEVER `ctx.env` as-is. 0.117.1 round 3 (P0
// R2-P0-env-forged-appdb-impersonation): in a REAL CLI invocation `ctx.env`
// defaults to `process.env` (run()'s `ctx0` carried no `env` key of its
// own) — the SAME process env the caller this leg is meant to distrust
// fully controls, including `ANTIHALL_DEVSWARM_APP_DB`. Honoring that
// override here would let the caller redirect "ground truth" at a sqlite
// file it wrote itself. `ctx.envExplicit` (set once, in `run()`, from
// whether `ctx0` itself carried an `env` key) distinguishes that real-CLI
// default from an IN-PROCESS caller (tests, or another in-process embedder)
// that deliberately supplied its own `env` — that env is not the untrusted
// external caller's process env, so it is trusted verbatim. Otherwise every
// OTHER env var is kept (e.g. `XDG_CONFIG_HOME`, still honored for the
// real per-OS app DB path) and only the two override keys
// devswarm-app-db.js's `appDbPath()`/cache-TTL reader honor are stripped,
// so the fixed per-OS app DB path is used instead of a caller-chosen one.
function ownerAppDbEnv(ctx) {
  const env = ctx && ctx.env;
  if (ctx && ctx.envExplicit) return env;
  if (!env || typeof env !== 'object') return env;
  const sanitized = Object.assign({}, env);
  delete sanitized.ANTIHALL_DEVSWARM_APP_DB;
  delete sanitized.ANTIHALL_DEVSWARM_APP_DB_CACHE_MS;
  return sanitized;
}

// broadcastFamilyOwns(s, caller, id, home, ownEntry, cwd, callerSessionId,
// hadPriorHeartbeat, callerKind) -> bool.
// The IDENTITY-FAMILY leg of cmdHeartbeat's meshBroadcast ownership check (defect
// ecd7ad60e4cc). True when `id` names a row that belongs to the SAME workspace
// identity the caller does — never on raw-id equality alone (that is the caller's
// own first two legs) and never on anything a caller can forge.
//
// R15 P2 FIX (field-reproduced): SAME WORKTREE ALONE used to be sufficient (leg
// (a) below), which let ANY caller sharing the target's worktree broadcast as it
// — two unrelated live sessions co-registered in one worktree (the ordinary
// multi-tab/multi-agent case, not a spoof) could impersonate each other
// (Critic repro: `heartbeat <victim-id> --summary` from an unrelated same-
// worktree caller returned ok:true). Same-worktree is still REQUIRED for leg
// (a) — a process outside the target's worktree gets no credit from it at all
// — but is no longer SUFFICIENT: an identity link is now also required, one of:
//   (a1) crossLinkedIdentity(ownEntry, targetRow) — the strongest unambiguous
//        link: one row's sessionId IS the other row's id (the builder-id-UUID
//        + slug-row pair, devswarm-identity-family.js's documented shape).
//        Checked FIRST and unconditionally (not gated on same-worktree) — a
//        legitimately cross-linked twin is owned regardless of worktree.
//   (a2) the target row's OWN sessionId equals the CALLER's real session id —
//        the session value THIS call itself was invoked under (cmdHeartbeat's
//        own `--session`, the same field a legitimate registration stamps).
//        Direct proof the target row was registered under the exact session
//        now presenting the broadcast, with no cross-link chain needed.
//   (a3) the target row is a PLACEHOLDER — no descriptor file AND no
//        heartbeat file of its own PRE-EXISTING before this very call
//        (`hadPriorHeartbeat`, captured by the caller BEFORE this call's own
//        base-heartbeat write — that write always happens, so checking
//        current existence here would always read true for the one id this
//        call is ever asked about). Nothing to spoof: a placeholder is not a
//        live, claimed workspace with any real state a forged broadcast
//        could compromise (the `unclaimed:` anchor-row shape).
//   (a0) 0.117.1 fix (field-reported "child heartbeat --summary silently
//        dropped"): `id` has NO registry row AT ALL (a child's very first
//        interaction is often a direct `heartbeat <id> --summary ...`, no
//        prior `register`) — a strictly WEAKER precondition than (a3), which
//        already requires a row to exist.
//   0.117.1 ROUND 2 FIX (P0 B-a0-impersonation, field-reproduced): the FIRST
//        cut of (a0) granted first-claim to ANY cwd-resolved caller for ANY
//        never-registered id — that let an unrelated caller impersonate a
//        sibling's FUTURE id (claim it before the real owner ever
//        heartbeats it) and lock the real owner out once claimed.
//        `callerKind === 'resolved'` alone proves WHERE the caller stands,
//        never that it owns `id`. GROUND TRUTH is now also required: `id`
//        must be a DevSwarm APP workspace (builder) whose worktreePath
//        equals the CALLER's own resolved worktree — verified via the app
//        DB reader (companion/lib/devswarm-app-db.js's `builderForWorktree`,
//        the same ground-truth source the register-path app-archive guard
//        already trusts). A bare DEVSWARM_BUILDER_ID declaration is NOT
//        sufficient proof by itself (spoofable).
//   0.117.1 ROUND 3 FIX (P0 R2-P0-env-forged-appdb-impersonation): the
//        round-2 comment above ("env is never consulted here at all") was
//        itself wrong — appDbPath() honors env.ANTIHALL_DEVSWARM_APP_DB
//        with no gating, and in a REAL CLI invocation ctx.env defaults to
//        process.env (run()'s ctx0 carried no env key of its own) — the
//        SAME process env the untrusted caller fully controls. A caller
//        could therefore point the "app DB" at a throwaway sqlite file it
//        wrote itself, containing a builders row for its own worktree
//        under any id it wants, and pass this leg with no ground truth at
//        all. ownerAppDbEnv() (below, at this call site) closes this: for
//        THIS decision only, the override is honored solely when an
//        IN-PROCESS caller supplied its OWN env key on ctx0 (tests, or
//        another in-process embedder — never the untrusted external
//        caller's own process env); a real CLI invocation always resolves
//        the fixed per-OS app DB path, ignoring ANTIHALL_DEVSWARM_APP_DB.
//        This leg now also matches an ACTIVE app-DB builder row ONLY — an
//        archived/hidden-only row no longer grants first-claim
//        (builderForWorktree({ activeOnly: true }) below; every other
//        caller of builderForWorktree keeps the existing
//        active-with-archived-fallback behavior). No match — app DB
//        unreadable/off, no ACTIVE builder row for the caller's worktree,
//        or that row's id differs from `id` — fails closed (return
//        false): the summary is DROPPED with a `note` explaining why,
//        exactly like any other refusal. Note: this leg still only
//        guards against MISATTRIBUTION (an accidental or unrelated
//        wrong-worktree/wrong-id claim), never a same-uid adversary that
//        also controls its own cwd — such a caller could equally cd into
//        the target worktree and pass this leg through the REAL app DB;
//        the mesh append is a consent-based channel, not a security
//        boundary against the local user (see skills/devswarm/SKILL.md).
//
// FAIL-CLOSED in full: any throw, an unresolvable worktree, or a target id with
// no registry row AND no (a0) match returns false, leaving the refusal exactly
// as it was before this leg.
function broadcastFamilyOwns(s, caller, id, home, ownEntry, cwd, callerSessionId, hadPriorHeartbeat, callerKind, env) {
  try {
    const target = String(id);
    const rows = s.listRegistry() || [];
    const targetRow = rows.find((r) => r && String(r.id) === target) || null;
    if (!targetRow || !targetRow.worktreePath) {
      // (a0) FIRST-EVER CLAIM, ground-truth rewrite (0.117.1 round 2, P0
      // B-a0-impersonation). No registry row for `id` exists ANYWHERE — a
      // child's very first interaction with its own id is often a direct
      // `heartbeat <id> --summary ...`, no prior `register` call at all —
      // but `callerKind === 'resolved'` alone only proves WHERE the caller
      // stands, never that it owns `id`: the original cut granted first-claim
      // to ANY cwd-resolved caller for ANY never-registered id, which let an
      // unrelated caller impersonate a sibling's FUTURE id. Owned now only
      // when ALL of: (1) `callerKind === 'resolved'` (independently verified
      // ground truth, never a forgeable `DEVSWARM_BUILDER_ID` declaration);
      // (2) no descriptor for `id` (evidence `id` was already claimed at
      // some point — e.g. a tombstoned/re-homed registry row whose
      // descriptor survived — still falls through to fail-closed); (3) the
      // DevSwarm APP's own database (ground truth, companion/lib/
      // devswarm-app-db.js's `builderForWorktree` — the same reader the
      // register-path app-archive guard trusts) names a builder for the
      // caller's own resolved worktree WHOSE id is exactly `id`. Any failure
      // to establish (3) — app DB off/unreadable, no builder row for this
      // worktree, or a builder id that differs from `id` — fails closed.
      // `hadPriorHeartbeat` is deliberately NOT part of this gate any more:
      // since `id` is a database PRIMARY KEY, at most ONE worktree can ever
      // satisfy (3) for a given `id` — a prior heartbeat under `id` (from
      // this same ground-truth-verified worktree, the only one that could
      // ever have passed (3)) is not evidence of a DIFFERENT claimant, so
      // gating on it only re-locks out the genuine owner on a retry.
      if (callerKind === 'resolved') {
        try {
          if (readDescriptorFile(home, target)) return false;
          const rawCwd0 = cwd || process.cwd();
          const wt0 = resolveCallerWorktree(rawCwd0);
          if (wt0) {
            const appDb = require('../../companion/lib/devswarm-app-db.js');
            const builder = appDb.builderForWorktree({ home, env, worktreePath: wt0, now: Date.now(), activeOnly: true });
            if (builder && String(builder.id) === target) return true;
          }
        } catch (_) {}
      }
      return false;
    }
    let tKey = null;
    try { tKey = canonicalMeshId(targetRow.worktreePath); } catch (_) { tKey = null; }
    if (!tKey) return false;
    // (a1) cross-linked identity between the caller's row and the target row —
    // unconditional, not gated on same-worktree.
    if (ownEntry) {
      try {
        const idFam = require('../../companion/lib/devswarm-identity-family.js');
        if (idFam.crossLinkedIdentity(ownEntry, targetRow)) return true;
      } catch (_) {}
    }
    // Same-worktree precondition for the remaining legs (a2)/(a3) — the
    // caller's own cwd-resolved worktree, or the caller's own registry row's
    // worktree.
    let sameWorktree = false;
    const rawCwd = cwd || process.cwd();
    const wt = resolveCallerWorktree(rawCwd);
    if (wt) {
      try { if (canonicalMeshId(wt) === tKey) sameWorktree = true; } catch (_) {}
    }
    if (!sameWorktree && ownEntry && ownEntry.worktreePath) {
      try { if (canonicalMeshId(ownEntry.worktreePath) === tKey) sameWorktree = true; } catch (_) {}
    }
    if (!sameWorktree) return false;
    // (a2) the target row's own sessionId matches the caller's real session id
    if (callerSessionId != null && targetRow.sessionId != null
      && String(targetRow.sessionId) === String(callerSessionId)) {
      return true;
    }
    // (a3) the target row is a placeholder: no descriptor, no PRE-EXISTING
    // heartbeat of its own (see hadPriorHeartbeat's header note above)
    try {
      const hasDescriptor = !!readDescriptorFile(home, target);
      if (!hasDescriptor && !hadPriorHeartbeat) return true;
    } catch (_) {}
    return false;
  } catch (_) { return false; }
}

// BENIGN_MESH_BROADCAST_REASONS — meshBroadcast failure `reason` values that
// must NEVER escalate cmdHeartbeat's top-level `ok` (see its use at the end
// of cmdHeartbeat). Both are DELIBERATE, tested exceptions:
//   - 'no-project': O-D5 "mesh dormant" — a non-git cwd is an ordinary
//     environment fact, not a caller mistake.
//   - ownershipRefusalCause()'s closed set: a working security control
//     refusing a (possibly forged) broadcast is not this call's own local-
//     write failure — devswarm-send.test.js's "forged" test explicitly
//     documents "the base (local) heartbeat write is not itself the
//     security boundary" and asserts ok:true through this exact path.
const BENIGN_MESH_BROADCAST_REASONS = new Set([
  'no-project',
  'unresolvable-caller-identity', 'caller-not-registered', 'ownership-mismatch',
]);

// canonicalWorktreeRealPath(worktreePath) — the collision-FREE real-path pre-image
// of canonicalMeshId's 8-hex hash: canonicalize to the key-bearing git root first
// (identity.resolveContext — IDENTICAL resolution to canonicalMeshId below; the root
// is already a real path). By construction
// canonicalMeshId(wt) === `primary-<first 8 hex of sha256(canonicalWorktreeRealPath(wt))>`,
// so two rows share a canonicalMeshId BUCKET iff this real path hashes to the same
// 8-hex — but they are the SAME physical worktree ONLY iff these real-path STRINGS
// are EQUAL. An 8-hex sha256 slice can (astronomically, but on a money path "can" is
// disqualifying) collide two DISTINCT toplevels onto ONE meshId, so grouping by the
// hash alone can bucket two UNRELATED worktrees together; comparing this real-path
// string-for-string is the collision-proof discriminator. This is the ONE helper
// BOTH retireWorktreeDuplicates (per-register) and foldMeshDuplicates (project-wide
// migration) match candidates with, so the fold can never again silently merge
// distinct worktrees the way a hash-only grouping did. Fail-open null (falsy path,
// or a path that no longer exists — decision 5: never walked up onto an enclosing
// repo) -> callers treat it as "cannot confirm same worktree" (never merge).
// An existing non-git dir keeps its own real path (unchanged).
function canonicalWorktreeRealPath(worktreePath) {
  if (!worktreePath) return null;
  const c = identityContext(String(worktreePath));
  if (c.kind === 'deleted') return null;
  return c.worktreeRoot || inst.worktreeRealPath(worktreePath) || null;
}

// canonicalMeshId(worktreePath) — the meshId a row groups under. Canonicalizes to
// the row's key-bearing git root first (identity.resolveContext, pure fs — the
// same root resolveCallerWorktree returns), so a legacy SUBDIR-SPLIT row
// (a child that registered from a git subdirectory — its raw real-path hashes to a
// DIFFERENT meshId than the toplevel's, invisible to plain-hash grouping) folds
// onto its toplevel. Falls back to the raw worktreePath when it does not resolve
// (an existing non-git dir), which reproduces the pre-existing plain-hash grouping
// exactly for every row that is already a toplevel. A submodule of any kind keys
// to its OUTERMOST superproject (owner decisions 1+2). A path that no longer
// exists returns null (decision 5: unknown — never folded onto an enclosing repo,
// never grouped); every caller skips a null key.
function canonicalMeshId(worktreePath) {
  if (!worktreePath) return null;
  const c = identityContext(String(worktreePath));
  if (c.kind === 'deleted') return null;
  // Same formula as c.meshId (identity-equivalence locks it), via the installer's
  // primaryWorkspaceId so every meshId in this file derives from one formatter.
  return inst.primaryWorkspaceId(c.worktreeRoot || worktreePath);
}

// rawPathMeshId(p) -> the meshId a row registered from `p` carries when `p` no
// longer exists (the legacy raw-path hash; no walk-up), or null. Used only as an
// exact-ADDRESS fallback (send lookup, the anchor protection) — never to group.
function rawPathMeshId(p) {
  if (!p) return null;
  try { return identity.meshIdForRealPath(path.resolve(String(p))); } catch (_) { return null; }
}

// groupRegistryByMeshId(registry, home) -> Map<meshId, {meshId, ids[], rows[], liveRows}>.
// The ONE grouping implementation shared by cmdDiagnose (split detection) AND
// foldMeshDuplicates (canonical fold) — grouping key is canonicalMeshId so both
// see subdir-splits folded onto their toplevel identically.
// D11-A: `liveRows` is now computed via isRoutingLiveRow (heartbeat-freshness +
// harness-session-dormancy, see that function's header) instead of the bare
// isLiveSessionId(sessionId) shape test — a real-but-long-dead sessionId (a
// crashed sibling whose registry row was never cleaned up) no longer counts
// toward `liveRows`, so meshTargets' kind/split/deadSplit classification
// (computeDiagnosis, below) reflects who is ACTUALLY draining a partition, not
// merely who once registered one. `home` is optional (omitting it only
// disables the heartbeat-credit half; the descriptor-existence fallback and
// shape checks still run) — every existing caller already has `home` in scope.
function groupRegistryByMeshId(registry, home) {
  const byMesh = new Map();
  for (const d of registry) {
    if (!d || !d.worktreePath) continue;
    const meshId = canonicalMeshId(d.worktreePath);
    if (!meshId) continue;
    let g = byMesh.get(meshId);
    if (!g) { g = { meshId, ids: [], rows: [], liveRows: 0 }; byMesh.set(meshId, g); }
    g.ids.push(d.id);
    g.rows.push(d);
    if (isRoutingLiveRow(d, home)) g.liveRows++;
  }
  return byMesh;
}

// pickSurvivor(s, group, home) — the SAME freshest-LIVE selection resolveMeshTarget
// uses (devswarm-liveness-select.js's pickFreshestLive: session-reference integrity,
// drain activity, session-authored heartbeat, THEN updatedAt/cursor recency),
// generalized to a canonical group's OWN rows (which include subdir-split rows
// resolveMeshTarget's plain-hash match would miss). The survivor is the partition a
// live session actually drains. `home` is optional (enables the heartbeat-credit
// signal only). D11-A: the LIVE-candidate gate pickFreshestLive applies is now
// isRoutingLiveRowStrict (via opts.isLive), not the bare isLiveSessionId shape
// test — see that function's header for why (a real-but-dormant sessionId no
// longer wins a `send`/fold target over a genuinely live sibling; the STRICT,
// no-descriptor-fallback variant, not isRoutingLiveRow, is used here — a
// dead store-only row's lingering descriptor must never win a survivor pick).
function pickSurvivor(s, group, home) {
  return livenessSelect.pickFreshestLive(group.rows, {
    storeHandle: s, home,
    isLive: (row) => isRoutingLiveRowStrict(row, home),
  });
}

// liveSessionElsewhere(row, home) -> true ONLY when every harness session
// record for row.sessionId that names a cwd places that session on a DIFFERENT
// worktree than the row's own (0.108.4). A child label stamped with a foreign
// session (field: the Primary's, via a reconcile drain) is live but not ON
// that worktree, so it must not protect the label from the fold. No record /
// no cwd / unresolvable -> false (the running session keeps protecting it).
function liveSessionElsewhere(row, home) {
  try {
    const sid = row && row.sessionId != null ? String(row.sessionId) : '';
    const own = row && row.worktreePath ? canonicalWorktreeRealPath(String(row.worktreePath)) : null;
    if (!sid || !own) return false;
    const dir = sessionsDirFor(home);
    let seen = 0;
    for (const n of fs.readdirSync(dir)) {
      if (!/\.json$/.test(n)) continue;
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
      if (!rec || String(rec.sessionId) !== sid) continue;
      if (typeof rec.cwd !== 'string' || !rec.cwd) return false;
      const wt = identityContext(rec.cwd, CALLER_CWD).worktreeRoot || null;
      if (!wt || wt === own) return false;
      seen++;
    }
    return seen > 0;
  } catch (_) { return false; }
}

// ===========================================================================
// `unclaimed:<id>` PROMOTION (carry-out (e), v0.90.0)
//
// ROOT CAUSE: cmdInboxPull's auto-ensure stamps `sessionId = 'unclaimed:' + id`
// when neither --session nor DEVSWARM_BUILDER_ID names a real session (its own
// A6 comment explains why minting the id itself was worse). That marker is
// correct AT STAMP TIME, but nothing ever took it back off: once a REAL session
// started reading/pulling/registering for that row, the row still read as
// `unclaimed:` — and isLiveSessionId REJECTS that prefix unconditionally, so
// every liveness-driven mesh primitive (resolveMeshTarget's routing, the reap /
// reconcile / retire safety gates, the supervisor's drainability check) kept
// treating a row a live session was actively draining as NOT live. A `send`
// could be routed away from it, and a sweep could class it as abandoned.
//
// defaultPpidOf(pid) -> parent pid, or null. Real implementation for
// deriveCallerSessionIdFromProcessTree below: `ps -o ppid= -p <pid>` via
// execFileSync (argv form — no shell interpolation), bounded by a short
// timeout so a hung/missing `ps` can never block the caller. Fail-soft:
// anything but a clean positive-integer parent pid yields null.
function defaultPpidOf(pid) {
  try {
    const cp = require('child_process');
    const out = cp.execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const n = parseInt(String(out).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

const MAX_PPID_HOPS = 6;

// deriveCallerSessionIdFromProcessTree(ctx, opts) -> string | null.
//
// FALLBACK for realSessionIdFrom (defect 54a6539e2d69): --session and
// CLAUDE_CODE_SESSION_ID are the only two sources realSessionIdFrom reads, but
// MEASURED on this machine: CLAUDE_CODE_SESSION_ID is set in a DevSwarm-
// launched session's own Bash shell, and ABSENT in a plain (non-DevSwarm)
// Claude Code session's Bash shell. So a caller running an ordinary session
// had NO path to a real session id at all — `unclaimed:` promotion could
// never fire for it, regardless of how long the session ran.
//
// The Claude Code harness itself writes `<home>/.claude/sessions/<pid>.json`
// ({pid, sessionId, cwd, status, ...} — liveness.js's sessionsDirFor/
// sessionPidAlive already read this exact directory for a different purpose)
// for each running session. This walks the CALLER's OWN parent-pid chain
// (this process's pid, then its parent, grandparent, ... up to
// MAX_PPID_HOPS) looking for the first hop whose pid has a session file, and
// additionally REQUIRES that file's own `cwd` to resolve (canonical realpath,
// via the SAME canonicalWorktreeRealPath every fold/routing primitive in this
// file uses) inside the caller's own resolved worktree before trusting it —
// otherwise an unrelated ancestor process (a login shell, a sibling terminal
// tab, an unrelated wrapper) could be misattributed as this call's identity.
// A session file present with a NON-matching cwd is skipped (not fatal) and
// the walk continues up the chain, in case a closer/farther ancestor is the
// right one; the walk fails CLOSED (returns null) once the chain is
// exhausted or capped — a missed derivation is a retryable no-op on the next
// call, a wrong one would stamp a stranger's session id onto this row.
//
// `opts.ppidOf` (default: defaultPpidOf) and `opts.fs`/`opts.pid` are
// injectable so tests can supply a synthetic process chain and a fake
// sessions dir without spawning real processes or touching the real
// `~/.claude/sessions`. `opts.kill`/`opts.ps` are likewise injectable for the
// pid-reuse/staleness guard (see the `pidIsAlive` call below).
function deriveCallerSessionIdFromProcessTree(ctx, opts) {
  const o = opts || {};
  const home = ctx && ctx.home;
  if (!home) return null;
  const F = o.fs || fs;
  const ppidOf = typeof o.ppidOf === 'function' ? o.ppidOf : defaultPpidOf;
  const rawCwd = (ctx && ctx.cwd) || process.cwd();
  const callerWt = canonicalWorktreeRealPath(rawCwd) || rawCwd;
  if (!callerWt) return null;
  let sessDir;
  try { sessDir = sessionsDirFor(home); } catch (_) { return null; }
  let pid = Number.isInteger(o.pid) && o.pid > 0 ? o.pid : process.pid;
  const seen = new Set();
  for (let hop = 0; hop <= MAX_PPID_HOPS; hop++) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) break;
    seen.add(pid);
    let rec = null;
    try { rec = JSON.parse(F.readFileSync(path.join(sessDir, String(pid) + '.json'), 'utf8')); } catch (_) { rec = null; }
    if (rec && typeof rec === 'object' && rec.sessionId != null && rec.cwd) {
      const sid = String(rec.sessionId).trim();
      if (sid && !sid.startsWith(SYNTHETIC_SESSION_PREFIX)) {
        const recWt = canonicalWorktreeRealPath(String(rec.cwd)) || String(rec.cwd);
        if (recWt && recWt === callerWt) {
          // PID-REUSE / STALENESS GUARD (R22 P2): a session FILE naming this
          // pid is not proof the pid is still THAT session's process — the OS
          // can hand the same pid to an unrelated later process once the
          // original exits, and the stale file lingers if its owner never
          // cleaned it up. Reuse liveness.js's OWN guard (pidIsAlive's
          // `sinceMs` check, the same one sessionPidAlive already applies) via
          // this recorded file's own mtime as the reference: a live pid whose
          // OWN start time resolves to strictly AFTER this file was written
          // cannot be the process that wrote it. Fail-soft on an unstattable
          // file (sinceMs omitted, matching pidIsAlive's pre-existing
          // behavior) and on a `null` (no-opinion) verdict — only a PROVEN
          // dead/reused pid (`false`) is rejected; anything else falls back
          // to trusting the recorded session id, exactly as before this
          // guard existed.
          const rf = path.join(sessDir, String(pid) + '.json');
          let sinceMs = null;
          try { const st = F.statSync(rf); sinceMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null; } catch (_) { sinceMs = null; }
          const recPid = Number.isInteger(rec.pid) && rec.pid > 0 ? rec.pid : pid;
          const pidOpts = Number.isFinite(sinceMs) ? { sinceMs, ps: o.ps } : undefined;
          const alive = pidIsAlive(recPid, o.kill, pidOpts);
          if (alive !== false) return sid;
          // dead/reused pid: this session file is stale — do not trust it,
          // but keep walking the chain in case an ancestor hop is legitimate.
        }
      }
    }
    let next = null;
    try { next = ppidOf(pid); } catch (_) { next = null; }
    if (!Number.isInteger(next) || next <= 1) break;
    pid = next;
  }
  return null;
}

// deriveInstanceNonce(ctx, opts) -> string. A PER-PROCESS instance
// discriminator stamped on OUTBOUND mesh rows (defect d3d571495bf6, P0): two
// running processes that resolve the SAME session id — a `claude --resume`
// racing its own still-alive prior process, or a fork — otherwise derive the
// SAME callerIdentity and write indistinguishable rows, so the Primary acts
// on fabricated provenance (rows authored by process B read as authored by
// process A). Field-confirmed by the reporter: a nonce keyed on
// CLAUDE_CODE_SESSION_ID / --session does NOT separate the two instances
// (both processes carry the identical session id) — the discriminator MUST
// be per-OS-process.
//
// Reuses deriveCallerSessionIdFromProcessTree's WALK verbatim (same ancestor
// pid chain via ppidOf, same cwd-match requirement, same pid-reuse/staleness
// guard via pidIsAlive) but returns the matched ancestor's OWN (pid,
// startedAt) instead of its sessionId: the harness writes ONE
// `<home>/.claude/sessions/<pid>.json` per running top-level process, so two
// live `claude --resume` processes sharing one sessionId still have TWO
// distinct session files (different pids, different startedAt) — a genuine,
// stable-for-the-process-lifetime discriminator neither process can forge
// onto the other (it is read from the harness's own pid-keyed file, not
// supplied by the caller). Deliberately a SEPARATE function rather than a
// refactor of deriveCallerSessionIdFromProcessTree's internals — that
// function is on the existing ack-ownership/session-promotion path with its
// own test coverage; duplicating the ~20-line walk keeps this purely
// additive with zero behavior risk to it.
//
// Falls back to THIS devswarm.js process's OWN (pid, start time) — via
// liveness.js's processStartMs, never re-spawning `ps` beyond what the walk
// already does — when no ancestor session file resolves (a headless/
// non-interactive invocation, CI, a test harness with no ~/.claude/sessions
// entry, `ps` unavailable). Still a genuine per-OS-process value; simply not
// tied to a specific interactive harness ancestor. NEVER null and never
// throws to the caller — a nonce is always produced so every send/heartbeat
// call site can unconditionally stamp one.
// _instanceNonceCache — module-level memoization (d3d571495bf6 B1): every
// PRODUCTION call site invokes `deriveInstanceNonce(ctx)` with NO second
// argument, once per outbound row, sometimes several times within one CLI
// invocation (send + a best-effort broadcast, etc) — each call was
// independently re-walking the ancestor pid chain and re-spawning `ps`. A
// single OS process's identity cannot change over its own lifetime, so this
// is computed once per process and reused. Deliberately NOT applied when the
// caller passes `opts` (every test in devswarm-fleet-d3d571495bf6.test.js
// injects `{pid, ppidOf, kill}` to simulate two DIFFERENT processes within
// one test run — caching across those would collapse two distinct simulated
// identities into one and defeat the test's whole premise).
let _instanceNonceCache = null;

function deriveInstanceNonce(ctx, opts) {
  const o = opts || {};
  const useCache = !opts;
  if (useCache && _instanceNonceCache !== null) return _instanceNonceCache;

  // psCalls caps the walk (B3): a `ps` shell-out is the expensive part of
  // this derivation (defaultPpidOf and processStartMs both spawn it). Wrap
  // whatever `ps` source is in play (test-injected `o.ps` or the real
  // spawnSync fallback processStartMs itself would otherwise use) so at MOST
  // ONE such call happens per deriveInstanceNonce invocation, regardless of
  // how many ancestor hops or fallback branches run. Once exhausted, callers
  // downstream (pidIsAlive) get `null` — their existing "no opinion, assume
  // alive" fail-soft posture, unchanged from before this cap existed.
  let psCalls = 0;
  const cappedPs = (pid) => {
    if (psCalls >= 1) return null;
    psCalls += 1;
    if (typeof o.ps === 'function') return o.ps(pid);
    try {
      const cpMod = require('child_process');
      const res = cpMod.spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
      return (res && !res.error && res.status === 0) ? res.stdout : null;
    } catch (_) { return null; }
  };

  let result = null;
  try {
    const home = ctx && ctx.home;
    if (home) {
      const F = o.fs || fs;
      const ppidOf = typeof o.ppidOf === 'function' ? o.ppidOf : defaultPpidOf;
      const rawCwd = (ctx && ctx.cwd) || process.cwd();
      const callerWt = canonicalWorktreeRealPath(rawCwd) || rawCwd;
      let sessDir = null;
      try { sessDir = sessionsDirFor(home); } catch (_) { sessDir = null; }
      if (sessDir && callerWt) {
        let pid = Number.isInteger(o.pid) && o.pid > 0 ? o.pid : process.pid;
        const seen = new Set();
        for (let hop = 0; hop <= MAX_PPID_HOPS && !result; hop++) {
          if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) break;
          seen.add(pid);
          let rec = null;
          try { rec = JSON.parse(F.readFileSync(path.join(sessDir, String(pid) + '.json'), 'utf8')); } catch (_) { rec = null; }
          if (rec && typeof rec === 'object' && rec.cwd && Number.isInteger(rec.pid) && rec.pid > 0) {
            const recWt = canonicalWorktreeRealPath(String(rec.cwd)) || String(rec.cwd);
            if (recWt && recWt === callerWt) {
              const rf = path.join(sessDir, String(pid) + '.json');
              let sinceMs = null;
              try { const st = F.statSync(rf); sinceMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null; } catch (_) { sinceMs = null; }
              const pidOpts = Number.isFinite(sinceMs) ? { sinceMs, ps: cappedPs } : undefined;
              const alive = pidIsAlive(rec.pid, o.kill, pidOpts);
              if (alive !== false) {
                const started = Number.isFinite(rec.startedAt) ? rec.startedAt : sinceMs;
                result = 'anc:' + rec.pid + ':' + (Number.isFinite(started) ? started : 0);
                break;
              }
              // dead/reused pid: keep walking, same posture as the sessionId walk.
            }
          }
          let next = null;
          try { next = ppidOf(pid); } catch (_) { next = null; }
          if (!Number.isInteger(next) || next <= 1) break;
          pid = next;
        }
      }
    }
  } catch (_) { /* fall through to the headless fallback below */ }

  if (!result) {
    // Headless fallback (B2): STABLE PER HARNESS PROCESS, not per one-shot
    // CLI invocation. `self:<process.pid>` (the pre-fix fallback) is the
    // WRONG shape here — `process.pid` is THIS devswarm.js CLI process's own
    // pid, freshly forked on every single invocation, so two unrelated `send`
    // calls a second apart from the same headless harness (no session file
    // resolves — CI, a test runner, `ps` unavailable) would mint two
    // DIFFERENT nonces for what is genuinely the SAME caller identity. The
    // caller's PARENT process (the harness/shell that spawned this one-shot
    // CLI) is the actual stable "instance": reuse the ancestor walk's own
    // `ppidOf` to find it and key off ITS (pid, start time) instead of this
    // process's own. Falls back to this process's own identity only when no
    // parent can be resolved at all. Shares the SAME `cappedPs` budget as the
    // ancestor walk above — never a second `ps` spawn on top of it.
    const ppidOf = typeof o.ppidOf === 'function' ? o.ppidOf : defaultPpidOf;
    const selfPid = Number.isInteger(o.pid) && o.pid > 0 ? o.pid : process.pid;
    let parentPid = null;
    try { parentPid = ppidOf(selfPid); } catch (_) { parentPid = null; }
    const targetPid = Number.isInteger(parentPid) && parentPid > 1 ? parentPid : selfPid;
    let startedAt = null;
    try { startedAt = processStartMs(targetPid, cappedPs); } catch (_) { startedAt = null; }
    result = 'self:' + targetPid + ':' + (Number.isFinite(startedAt) ? startedAt : 0);
  }

  if (useCache) _instanceNonceCache = result;
  return result;
}

// deriveReaderNonce(ctx) -> 'h:<pid>:<startMs>' | null (mesh redesign B5).
// THE caller identity for every nonce site (outbound-row stamping, attempt-record
// authentication, and reader_cursors keys): the NEAREST harness ancestor,
// unconditionally (companion/lib/reader-identity.js — never skips a harness
// because its cwd differs, which is what let two sessions sharing an ancestor
// collide). null = headless (Codex, CI, cron): no per-reader row, floor-only
// reads. Memoized per home — one process's ancestry cannot change.
// Replaces deriveInstanceNonce at every production site; that function is kept
// only for its legacy-format tests and is removed in Phase 3b.
const _readerNonceCache = new Map();
function deriveReaderNonce(ctx) {
  const home = (ctx && ctx.home) || os.homedir();
  const key = String(home);
  if (_readerNonceCache.has(key)) return _readerNonceCache.get(key);
  let v = null;
  try { v = readerIdentity.deriveReaderNonce({ home }); } catch (_) { v = null; }
  _readerNonceCache.set(key, v);
  return v;
}
// callerReaderKey(ctx) -> the reader_cursors key for this caller, or null
// (headless). `ctx.instanceNonce` is an IN-PROCESS override only (tests); a
// value outside the 'h:<pid>:<startMs>' grammar resolves to headless.
function callerReaderKey(ctx) {
  let n = null;
  try { n = (ctx && ctx.instanceNonce) || dispatcherExports().deriveReaderNonce(ctx); } catch (_) { n = null; }
  return readerCursors.readerKey(n);
}

// shortInstanceNonce(nonce) -> the first 6 hex chars of sha1(nonce), or null.
// Pure display helper for the instanceNonce CONSUMERS below (defect
// d3d571495bf6, roster/diagnose/inbox-read consumers): the raw nonce string
// (`anc:<pid>:<startedAt>` / `self:<pid>:<startedAt>`) is too long and too
// literally process-identifying to print as-is, so every consumer renders
// this short, stable digest instead. Deterministic (same nonce -> same
// short id, always) and fail-open (a hashing throw or a non-nonce input
// yields null, never a thrown error).
function shortInstanceNonce(nonce) {
  if (nonce == null || nonce === '') return null;
  try {
    return crypto.createHash('sha1').update(String(nonce)).digest('hex').slice(0, 6);
  } catch (_) { return null; }
}

// rowStillNeedsSessionDerivation(home, id, ctx) -> bool. GATE (R22 P2): the
// process-tree fallback (deriveCallerSessionIdFromProcessTree) spawns a real
// `ps` per hop of the caller's parent chain via defaultPpidOf. Before this
// gate, realSessionIdFrom ran that walk on EVERY inbox read/pull lacking
// --session/CLAUDE_CODE_SESSION_ID — including reads of a row ALREADY
// promoted to a real session id, where the walk's result can only ever be
// discarded (a fully-promoted descriptor's classic promotion path is already
// a no-op). This checks the row's CURRENT sessionId on both sides
// (descriptor AND registry, independently — the two can diverge, see
// promoteUnclaimedSession's divergence-repair header) and returns true (the
// walk should proceed) ONLY when at least one side still carries the exact
// `unclaimed:<id>` marker or has no sessionId at all; a row already real on
// BOTH sides returns false. Fail-OPEN on any read error (missing descriptor,
// unreadable registry): the pre-existing behavior always ran the walk, so an
// error here costs one unnecessary `ps` invocation rather than silently
// blocking a legitimate promotion.
function rowStillNeedsSessionDerivation(home, id, ctx) {
  if (!home) return true;
  try {
    const marker = SYNTHETIC_SESSION_PREFIX + String(id);
    let desc = null;
    try { desc = readDescriptorFile(home, id); } catch (_) { desc = null; }
    const descSid = desc && desc.sessionId != null ? String(desc.sessionId) : null;
    if (!descSid || descSid === marker) return true;
    const registrySid = currentRegistrySessionId(home, id, ctx);
    if (!registrySid || registrySid === marker) return true;
    return false;
  } catch (_) { return true; }
}

// realSessionIdFrom(flags, ctx, id) -> a REAL session id, or null.
// Three things are explicitly NOT real session ids and each returns null:
//   - the row's OWN id (the tautological ingest/descriptor fallback),
//   - anything still carrying SYNTHETIC_SESSION_PREFIX,
//   - an absent/blank value.
// `--session` wins over the env because an explicit flag is the caller stating
// its identity; CLAUDE_CODE_SESSION_ID is the ambient Claude Code session.
// FALLBACK (defect 54a6539e2d69): when NEITHER of those two names anything,
// derive the caller's real session id from the harness's own session files
// via deriveCallerSessionIdFromProcessTree — see that function's header for
// why (CLAUDE_CODE_SESSION_ID is absent in a plain, non-DevSwarm session) and
// its safety gate (cwd-verified parent-pid walk, fails closed). `ctx.env` is
// passed through so a test can supply `ctx.sessionDeriveOpts` to inject a
// synthetic process chain / sessions dir without touching real processes.
function realSessionIdFrom(flags, ctx, id) {
  const raw = (flags ? one(flags, 'session') : undefined)
    || (ctx && ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID)
    || null;
  if (raw != null) {
    const s = String(raw).trim();
    if (s && s !== String(id) && !s.startsWith(SYNTHETIC_SESSION_PREFIX)) return s;
    return null;
  }
  if (!rowStillNeedsSessionDerivation(ctx && ctx.home, id, ctx)) return null;
  try {
    const derived = deriveCallerSessionIdFromProcessTree(ctx, ctx && ctx.sessionDeriveOpts);
    if (derived && derived !== String(id)) return derived;
  } catch (_) { /* fail-closed: no promotion from a throwing derivation */ }
  return null;
}

// deriveAttemptRecordSessionId(ctx, id) -> string | null.
//
// Wave 3 addendum item 11 (P1 forgery fix): the summary-attempts row's
// `sessionId` field used to be `callerSessionId` (== `realSessionIdFrom`),
// which prefers the CALLER-SUPPLIED `--session` FLAG VALUE. Proven forgeable
// (scratchpad/dl-gate/r2-reviewer/spoof-session.js): `heartbeat <victim-id>
// --summary x --session <victim's own registered descriptor sessionId>`
// writes an attempt record whose `sessionId` the victim's OWN gate then
// accepts as authenticated (`ownSessionIds` membership), even though the
// writer is a completely different, unrelated process — the exact forgery
// the nonce field was supposed to close (a flag is just a string an attacker
// chooses; it proves nothing about the WRITING process's real identity,
// unlike deriveInstanceNonce/the process-tree walk below).
//
// This is a SEPARATE, narrower derivation than `realSessionIdFrom` — used
// ONLY for the attempt record's `sessionId` field, never for
// `callerSessionId`'s existing (already-audited) ownership-check call sites
// — that deliberately skips the `--session` flag entirely and trusts only:
//   1. `CLAUDE_CODE_SESSION_ID` (the harness's own ambient env for THIS
//      process — not a value the caller chose via a CLI flag), corroborated
//      by (2) below, or
//   2. the SAME fail-closed process-tree walk `realSessionIdFrom`'s own
//      fallback uses (deriveCallerSessionIdFromProcessTree — cwd-verified
//      against the caller's own worktree, so it cannot be pointed at an
//      unrelated ancestor).
// Returns null (sessionId omitted, nonce-only authentication) when NEITHER
// source resolves — never falls back to the flag.
//
// P1 FORGERY FIX (Wave R3 Auditor): `CLAUDE_CODE_SESSION_ID` is CALLER-SET
// ambient env — not a value the harness cryptographically attests, just an
// environment variable like any other, no different in trust level from the
// already-rejected `--session` FLAG this function was written to exclude.
// Proof: `CLAUDE_CODE_SESSION_ID=sess-VICTIM node scripts/devswarm.js
// heartbeat w-victim --summary forged` wrote `sessionId: 'sess-VICTIM'` into
// the attempt record UNCONDITIONALLY (the env branch returned immediately,
// before ever calling the process-tree walk below) — and
// `hooks/devswarm-child-gate.js`'s `sessionMatch` check (its own
// `ownSessionIds.has(row.sessionId)`) then accepted that forged row as
// self-authored for ANY workspace that happens to be registered under
// `sess-VICTIM`. Fix: the env value is now trusted ONLY when the
// cwd-verified process-tree walk (2) INDEPENDENTLY corroborates the SAME
// value — the walk is unconditionally attempted first, and env is compared
// against it rather than short-circuiting past it. When the walk resolves a
// DIFFERENT (non-matching) session id, that fail-closed, non-forgeable value
// is used instead of the uncorroborated env value (never the reverse). When
// the walk resolves nothing at all, sessionId is omitted entirely — the
// record still stands on `instanceNonce` alone, exactly as intended when
// this field was first introduced.
function deriveAttemptRecordSessionId(ctx, id) {
  try {
    let envCandidate = null;
    const envSid = ctx && ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID;
    if (envSid != null) {
      const s = String(envSid).trim();
      if (s && s !== String(id) && !s.startsWith(SYNTHETIC_SESSION_PREFIX)) envCandidate = s;
    }
    const derived = deriveCallerSessionIdFromProcessTree(ctx, ctx && ctx.sessionDeriveOpts);
    const derivedCandidate = (derived && derived !== String(id)) ? String(derived) : null;
    if (envCandidate && derivedCandidate && envCandidate === derivedCandidate) return envCandidate;
    if (derivedCandidate) return derivedCandidate;
  } catch (_) { /* fail-closed: no forgeable fallback, sessionId stays omitted */ }
  return null;
}

// currentRegistrySessionId(home, id, ctx) -> string | null. The CURRENT
// registry-side sessionId for `id`, read fresh (never the descriptor's own
// copy) — used by promoteUnclaimedSession's divergence repair below, which
// must compare descriptor vs registry independently rather than assuming
// they already agree. Fail-soft null on any throw/missing row.
function currentRegistrySessionId(home, id, ctx) {
  try {
    const ownerKey = storeOwnerKeyFor(id, ctx);
    const s = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
    try {
      const row = s.listRegistry().find((r) => r && String(r.id) === String(id));
      return row && row.sessionId != null ? String(row.sessionId) : null;
    } finally { s.close(); }
  } catch (_) { return null; }
}

// promoteUnclaimedSession(home, id, sessionId, ctx) -> { promoted, from, to }.
//
// WRITE-THROUGH (descriptor AND registry, so the two can never diverge),
// IDEMPOTENT (a row whose sessionId is anything OTHER than the exact
// `unclaimed:<id>` marker — already promoted, or never unclaimed — is left
// untouched and reports promoted:false), and NO-DELETE (it only ever replaces
// one field's value; nothing is removed). Never throws: a failed descriptor or
// registry write degrades to "not promoted this call", which the NEXT read/pull
// retries, rather than failing the operation the caller actually asked for.
//
// DIVERGENCE REPAIR (defect 54a6539e2d69, added alongside the classic
// promotion path above): the classic path's `String(desc.sessionId) !==
// marker -> no-op` guard means that once the DESCRIPTOR moves off the
// marker, nothing ever calls this again with the descriptor still `unclaimed:`
// — so a REGISTRY write that failed on that earlier call (write-through's own
// registry step is wrapped in a swallowing try/catch, "registry retries next
// call" — but nothing ever retries it once the descriptor no longer matches
// the guard) left the registry stuck on the marker FOREVER, even though the
// descriptor already held the real identity (this is exactly the shape
// computeDiagnosis's descriptor/registry resolution, defect 2c4ae6576fab, was
// built to paper over on the READ side — this closes it on the WRITE side so
// the two stop diverging in the first place). The reverse (registry ahead of
// the descriptor) is repaired symmetrically. Both repair branches are
// ADDITIVE and IDEMPOTENT: they only ever copy one side's EXISTING real value
// onto the other, never invent a third value, and report `promoted:false`
// (this call performed a resync, not a NEW promotion) — reached only via
// maybePromoteUnclaimed's pre-existing callerOwnsRow gate, or the admin
// forward-migration sweep (promoteUnclaimedRegistrySessions) that already
// scopes itself to the current home's own descriptors.
function promoteUnclaimedSession(home, id, sessionId, ctx) {
  const out = { promoted: false, from: null, to: null };
  if (!sessionId || !isSafeId(id)) return out;
  const marker = SYNTHETIC_SESSION_PREFIX + String(id);
  let desc = null;
  try { desc = readDescriptorFile(home, id); } catch (_) { desc = null; }
  if (!desc) return out;
  const descSid = desc.sessionId != null ? String(desc.sessionId) : null;
  const registrySid = currentRegistrySessionId(home, id, ctx);

  if (descSid !== marker) {
    // Descriptor already promoted (by this or an earlier call — possibly to
    // a DIFFERENT real value than this call's `sessionId`; an already-real
    // descriptor is authoritative and is never overwritten here). Repair the
    // registry to match it ONLY if the registry is still stuck on the
    // marker for this SAME id.
    if (descSid && registrySid === marker) {
      const resynced = Object.assign({}, desc, { sessionId: descSid });
      try { upsertStoreRegistry(home, resynced, ctx, { allowPathChange: true }); } catch (_) { /* retried next call */ }
    }
    return out; // classic promotion is a no-op: descriptor is not currently unclaimed
  }

  if (registrySid && registrySid !== marker) {
    // Reverse divergence: the registry already holds a real value while the
    // descriptor still carries the marker. Sync the descriptor to the
    // registry's EXISTING real value (never this call's `sessionId` — the
    // registry's value is the one every routing/fold primitive already
    // treats as this row's identity).
    const resynced = Object.assign({}, desc, { sessionId: registrySid });
    try { writeDescriptorAtomic(home, id, resynced); } catch (_) { /* retried next call */ }
    return out; // no NEW promotion happened; this only resynced the descriptor
  }

  // Classic path: descriptor AND registry both still carry the marker ->
  // genuinely promote both, write-through.
  const next = Object.assign({}, desc, { sessionId: String(sessionId) });
  try { writeDescriptorAtomic(home, id, next); } catch (_) { return out; }
  // allowPathChange: the worktreePath is IDENTICAL (copied verbatim from the
  // descriptor we just read) — the flag only stops the F2 id-collision guard
  // from treating an unchanged path as a mismatch on a re-registered row.
  try {
    upsertStoreRegistry(home, next, ctx, { allowPathChange: true });
  } catch (e) {
    // R22 P2: descriptor already promoted; registry retries next call (the
    // divergence-repair branches above cover that retry) — but a SWALLOWED
    // failure here was previously invisible: nothing told the caller or an
    // operator that the registry write failed AT ALL, only that the row
    // stayed on `unclaimed:` for a call or two. Surface it: additive field on
    // the return value (never fails the promotion itself — descriptor
    // promotion already succeeded, so `out.promoted` stays true) plus one
    // stderr line for anyone watching logs.
    const msg = (e && e.message) ? String(e.message) : String(e);
    out.registryWriteError = msg;
    try { process.stderr.write('[devswarm] registry write failed for ' + String(id) + ': ' + msg + '\n'); } catch (_) { /* stderr write never affects the promotion */ }
  }
  out.promoted = true;
  out.from = marker;
  out.to = String(sessionId);
  try {
    alog.logEvent('devswarm-cli', 'unclaimed-session-promoted', 'info',
      'workspace ' + String(id) + ' promoted from ' + marker + ' to a real session id',
      { id: String(id), to: String(sessionId) });
  } catch (_) { /* logging never affects the promotion */ }
  return out;
}

// callerOwnsRow(home, id, ctx) -> boolean. Is `id` the CALLER's OWN row?
//
// ROUND 13 P0 (field): `maybePromoteUnclaimed` is called on the id being READ
// (cmdInboxMessagesInner + cmdInboxPull), and `realSessionIdFrom` sources the
// session from the CALLER's own `--session`/`CLAUDE_CODE_SESSION_ID`. So a
// Primary running `inbox read <twinId>` stamped ITS OWN live session uuid onto
// the TWIN's descriptor. The twin then read as LIVE (liveness.js isLiveSid),
// `siblingAckGate` refused to ack it, and its rows were re-delivered to the
// Primary on every single read, forever — the recurring sibling re-delivery
// this hotfix closes. Promotion is only ever legitimate for a row the caller
// can actually SPEAK FOR; a read target is not that by construction.
//
// THREE accepted proofs of ownership, in order of strength:
//   1. `id` IS the caller's canonical identity (callerIdentity — cwd-derived
//      ground truth, spoof-proof; a Primary reading its own `primary-<hash>`
//      row).
//   2. `id` is in the caller's IDENTITY FAMILY (crossLinkedIdentity: one row's
//      sessionId IS the other row's id — the builder-id/slug pair that is the
//      SAME agent registered twice). Deliberately NOT true for the twin shape
//      this defect is about: two `unclaimed:` rows on one worktree carry no
//      cross-link at all.
//   3. `id` is the SOLE registered row for the caller's resolved worktree — a
//      child pulling its own builder-id row from its own worktree, whose id is
//      NOT the worktree meshId `callerIdentity` returns. Restricted to the
//      UNIQUE case on purpose: the moment a worktree carries two rows (exactly
//      the twin shape), this proof is unavailable and nothing is promoted.
// Anything else -> NOT the caller's row -> no promotion. Fail-CLOSED: any
// throw/unreadable descriptor set answers false (a missed promotion is a
// retryable no-op; a wrong one strands a partition's mail).
function callerOwnsRow(home, id, ctx) {
  try {
    const target = String(id);
    const caller = callerIdentity(ctx && ctx.env, ctx && ctx.cwd);
    if (caller && String(caller) === target) return true;
    let descs = [];
    try { descs = readDescriptors(home) || []; } catch (_) { return false; }
    const targetRow = descs.find((d) => d && String(d.id) === target) || null;
    if (!targetRow) return false;
    const callerRow = caller ? (descs.find((d) => d && String(d.id) === String(caller)) || null) : null;
    let idFam = null;
    try { idFam = require('../../companion/lib/devswarm-identity-family.js'); } catch (_) { idFam = null; }
    if (callerRow && idFam && idFam.crossLinkedIdentity(callerRow, targetRow)) return true;
    // (3) sole row for the caller's own worktree.
    const rawCwd = (ctx && ctx.cwd) || process.cwd();
    const wt = resolveCallerWorktree(rawCwd) || rawCwd;
    if (!wt || !targetRow.worktreePath) return false;
    const wtKey = canonicalMeshId(wt);
    if (!wtKey || wtKey !== canonicalMeshId(targetRow.worktreePath)) return false;
    let sameWorktreeRows = 0;
    for (const d of descs) {
      if (!d || !d.worktreePath) continue;
      if (canonicalMeshId(d.worktreePath) === wtKey) sameWorktreeRows++;
    }
    if (sameWorktreeRows !== 1) return false;
    // D11-A (P0 fix): clause 3 used to return true here unconditionally — "the
    // caller is the sole row on this worktree" — with NO check that the sole
    // row it just matched (`targetRow`, `target != caller`, already excluded
    // above by clauses 1/2) is actually the caller's OWN unclaimed placeholder.
    // A lone CLAIMED foreign row sharing the caller's worktree (a genuinely
    // different, already-registered session on the same checkout) satisfied
    // "sole row for this worktree" just as well as a real unclaimed
    // placeholder does, letting a caller stamp its own sessionId onto a
    // FOREIGN row it does not own — exactly the ownership violation this gate
    // exists to refuse (see OWNERSHIP-GATED at maybePromoteUnclaimed above).
    // Restrict clause 3 to the case it was actually meant for: the sole row is
    // unclaimed (empty or `unclaimed:`-prefixed sessionId), never a claimed one.
    const targetSid = targetRow.sessionId;
    const targetUnclaimed = targetSid == null || String(targetSid) === ''
      || String(targetSid).startsWith(SYNTHETIC_SESSION_PREFIX);
    return targetUnclaimed;
  } catch (_) { return false; }
}

// maybePromoteUnclaimed(home, id, flags, ctx) — the ONE call shape every
// read/pull/register path uses, so none of them re-derives "is this a real
// session id" for itself. Fail-soft in full.
//
// OWNERSHIP-GATED (Round 13 P0): see callerOwnsRow above — the caller's session
// id may only ever be stamped onto the caller's OWN row.
function maybePromoteUnclaimed(home, id, flags, ctx) {
  try {
    // A reconcile sweep drain (defaultSpawnReconcile) is not the row's session.
    if (ctx && ctx.env && String(ctx.env.ANTIHALL_RECONCILE_SWEEP || '') === '1') {
      return { promoted: false, from: null, to: null, reason: 'reconcile-sweep' };
    }
    const sid = realSessionIdFrom(flags, ctx, id);
    if (!sid) return { promoted: false, from: null, to: null };
    if (!callerOwnsRow(home, id, ctx)) return { promoted: false, from: null, to: null, reason: 'not-own-row' };
    return promoteUnclaimedSession(home, id, sid, ctx);
  } catch (_) { return { promoted: false, from: null, to: null }; }
}

// ---------------------------------------------------------------------------
// FORWARD MIGRATION (persisted-shape rule): rows ALREADY stamped `unclaimed:`
// by an older build never get a promoting call if nothing reads them again.
// promoteUnclaimedRegistrySessions sweeps every descriptor and promotes only
// those with an INDEPENDENT, POSITIVE source of the real session id — today
// that is a heartbeat file whose own `sessionId` is a real one (cmdHeartbeat
// records `--session` verbatim). A row with no such source is LEFT EXACTLY AS
// IS (never deleted, never guessed at). Idempotent, fail-open, safe to run
// repeatedly; called from BOTH the update path and doctor-repair.
function promoteUnclaimedRegistrySessions(home, opts) {
  const o = opts || {};
  const ctx = { home, cwd: o.cwd || process.cwd(), env: o.env || process.env, backend: o.backend };
  const out = { ok: true, scanned: 0, promoted: [], left: [], errors: 0 };
  let descs = [];
  try { descs = readDescriptors(home) || []; } catch (_) { out.ok = false; out.errors++; return out; }
  for (const d of descs) {
    if (!d || !isSafeId(d.id)) continue;
    const marker = SYNTHETIC_SESSION_PREFIX + String(d.id);
    if (String(d.sessionId) !== marker) continue; // not unclaimed (or already promoted)
    out.scanned++;
    let beatSession = null;
    try {
      const beatPath = heartbeatPathFor(d.id, home); // liveness.js signature is (id, home)
      const beat = JSON.parse(fs.readFileSync(beatPath, 'utf8'));
      const raw = beat && beat.sessionId != null ? String(beat.sessionId).trim() : '';
      if (raw && raw !== String(d.id) && !raw.startsWith(SYNTHETIC_SESSION_PREFIX)) beatSession = raw;
    } catch (_) { beatSession = null; }
    if (!beatSession) {
      out.left.push({ id: String(d.id), reason: 'no-known-session' });
      continue;
    }
    let r;
    try { r = promoteUnclaimedSession(home, d.id, beatSession, ctx); }
    catch (_) { out.errors++; out.ok = false; continue; }
    if (r && r.promoted) {
      const row = { id: String(d.id), to: r.to };
      // R23 P2: surface a swallowed registry-write failure per-row, same
      // additive shape as inbox pull/read's `promotion.registryWriteError` —
      // descriptor promotion still succeeded (hence `promoted` here at all)
      // but the registry side may still be stuck on the marker.
      if (r.registryWriteError) row.registryWriteError = r.registryWriteError;
      out.promoted.push(row);
    } else out.left.push({ id: String(d.id), reason: 'write-failed' });
  }
  return out;
}

// ---- Primary seat (v0.108.0) ------------------------------------------------
// seatSessionId(ctx) -> the caller's Claude session id ('' when unknown).
function seatSessionId(ctx, flags) {
  const f = flags ? one(flags, 'session') : undefined;
  if (f) return String(f);
  return ctx && ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID ? String(ctx.env.CLAUDE_CODE_SESSION_ID) : '';
}
// seatRefusal(ctx) -> null | refusal. Mesh send/ack/spawn/merge from a session
// that does NOT hold the Primary seat while the holder is LIVE are refused, so
// two sessions never act as one Primary. Only on the Primary checkout, only
// with a known caller session; unknown liveness does not block (it warns at
// SessionStart instead). `primary takeover` is the explicit way through.
function seatRefusal(ctx) {
  try {
    const sid = seatSessionId(ctx);
    if (!sid) return null;
    const v = require('../../companion/lib/primary-seat.js').seatVerdict({ home: ctx.home, env: ctx.env, cwd: ctx.cwd || process.cwd(), sessionId: sid, light: true });
    if (v.state !== 'conflict') return null;
    // A session with its OWN registered identity on this worktree (a declared
    // DEVSWARM_BUILDER_ID row recording this very session) acts as itself, not
    // as the Primary — never blocked by the seat.
    try {
      const rk = repokey.repoKeyForWorktree(ctx.cwd || process.cwd());
      const reg = rk ? registrySnapshot(ctx, rk) : [];
      const self = declaredSelfId(ctx.env, ctx.cwd || process.cwd(), reg);
      const row = self ? reg.find((r) => r && String(r.id) === self) : null;
      if (row && row.sessionId != null && String(row.sessionId) === sid) return null;
    } catch (_) { /* no exemption */ }
    return {
      ok: false, reason: 'primary-seat-conflict', holder: v.holder, id: v.id,
      error: require('../../companion/lib/primary-seat.js').conflictText(v, resolveStableCliPath(ctx.home, CLI_PATH)),
    };
  } catch (_) { return null; }
}

// rosterMeshId(worktreePath) -> the SAME raw worktree-derived meshId
// resolveMeshTarget's own matching loop computes (`inst.primaryWorkspaceId
// (d.worktreePath)`, no toplevel canonicalization) — NOT `canonicalMeshId`
// (the toplevel-folded value `diagnose`'s split-detection/grouping uses,
// which is a DIFFERENT value for a subdir-registered row). Surfacing THIS
// exact value is what closes the send addressing footgun (P0): a value
// copied from here into `send --to <meshId>` is guaranteed to hit
// resolveMeshTarget's existing meshId-hash match path. null when there is no
// worktreePath to derive one from (a phantom/native-only/archived row).
function rosterMeshId(worktreePath) {
  if (!worktreePath) return null;
  try { return inst.primaryWorkspaceId(worktreePath); } catch (_) { return null; }
}

// agentNameSafe(env) -> the SAME agent-name resolution wakeDirective() uses
// internally (lib/devswarm-wake.js's own `agentName`), surfaced here purely
// for cmdWakeDirective's reporting — never re-implemented, imported lazily
// so a missing/older lib degrades to null instead of throwing.
function agentNameSafe(env) {
  try { return require('../../hooks/lib/devswarm-wake.js').isClaudeAgent(env) ? 'claude' : null; } catch (_) { return null; }
}

module.exports = {
  SYNTHETIC_SESSION_PREFIX, isLiveSessionId, computeRowLive, isArchivedForRouting,
  isRoutingLiveRowStrict, isRoutingLiveRow, appSessionOnWorktree, resolveCallerWorktree,
  projectCwdFor, callerIdentityDetailed, callerIdentity, isPrimaryCheckout, childSenderId,
  senderIdentityDetailed, registrySnapshot, childLabelRefusal, declaredSelfId, ownsAsDeclaredSelf,
  ownershipRefusalCause, ownerAppDbEnv, broadcastFamilyOwns, BENIGN_MESH_BROADCAST_REASONS,
  canonicalWorktreeRealPath, canonicalMeshId, rawPathMeshId, groupRegistryByMeshId, pickSurvivor,
  liveSessionElsewhere, defaultPpidOf, MAX_PPID_HOPS, deriveCallerSessionIdFromProcessTree,
  deriveInstanceNonce, _readerNonceCache, deriveReaderNonce, callerReaderKey, shortInstanceNonce,
  rowStillNeedsSessionDerivation, realSessionIdFrom, deriveAttemptRecordSessionId,
  currentRegistrySessionId, promoteUnclaimedSession, callerOwnsRow, maybePromoteUnclaimed,
  promoteUnclaimedRegistrySessions, seatSessionId, seatRefusal, rosterMeshId, agentNameSafe,
};
