#!/usr/bin/env node
'use strict';
// anti-hall :: devswarm CLI — THE structured interface (CLI over MCP, owner
// preference: no MCP servers) to the DevSwarm coordination substrate. Stable
// JSON on stdout for agent parsing. Pure Node built-ins only, cross-platform.
//
// This is a THIN wrapper that REUSES the already-built primitives — it invents
// no parallel schema:
//   - companion/lib/devswarm-store.js       (openStore / deriveSummary / setGate)
//   - companion/lib/devswarm-inbox-cursor.js (inbox read/ack/count cursor advance)
//   - companion/lib/recovery.js             (pokeOrEscalate — the nudge path)
//   - companion/lib/liveness.js             (isSafeId / devswarmRoot / livenessPathFor)
//   - companion/devswarm-supervisor.js      (readDescriptors — the on-disk registry)
//
// SUBCOMMANDS
//   register <id>  --worktree P --session S --inbox P --cursor P [--nudge T ...]
//                  write ~/.anti-hall/devswarm/workspaces/<id>.json + upsert store
//                  registry. Populates sessionId (closes the null-gap, PLAN.md
//                  "Open ownership gaps").
//   ensure <id>    ...same flags... register-if-absent (idempotent; existing
//                  descriptor is left intact, only the store registry is re-upserted).
//   heartbeat <id> [--progress N --phase X --wip T ... --blockers T ... --session S]
//                  turn-authored heartbeat at heartbeats/<id>.json. Consumer/session
//                  invoked ONLY — never a background ticker (PLAN.md heartbeat
//                  authorship rule).
//   inbox count <id> | inbox read <id> | inbox ack <id> [--to N]
//                  the durable-inbox cursor primitive (advance = ack-all).
//   inbox pull <id> [--session S]
//                  child-side reception drain: auto-ensure the descriptor, then ONE
//                  bounded guard-safe pull — non-destructive `message-count` gate,
//                  at-most-one bounded `read-messages` (never `monitor`), atomic
//                  idempotent NDJSON append into the durable inbox + store parity.
//   workspaces list
//                  derive + emit summary.json projection (unread, gates, archive_ready).
//   gate <id> [--set CSV] [--clear CSV]
//                  mark/unmark named completion gates (append-only in the store).
//                  anti-hall is AGNOSTIC about gate meaning — the consumer sets them.
//   nudge <id>     poke-or-escalate the workspace (reuses recovery.pokeOrEscalate).
//   archive <id>   archive-by-absence on OUR registry ONLY: move the descriptor to
//                  archived/ + tombstone the store registry. hivecontrol has NO
//                  teardown command, so this SURFACES a manual "remove workspace in
//                  the DevSwarm app" step; it never runs a delete (none exists).
//   archive-ignore <id> | archive-unignore <id>
//                  write/remove archive-ignore/<id>.json — the per-workspace ignore
//                  mark the archive-ready surfacing consults (PLAN.md P1-E).
//   archive-request <childId> [--reason TEXT]
//                  v0.58 STORE WRITE (mesh-only messaging): posts a parent->child
//                  `[[ANTIHALL_ARCHIVE_REQUEST]]` message DIRECTLY into `<childId>`'s
//                  own store partition (mesh-direct, urgency 'high') — `childId` is
//                  ALREADY the target's real read partition (same semantics as
//                  `heartbeat <id>`/`inbox read <id>`), so, unlike `send --to
//                  <meshId>`, no registry/meshId resolution happens. ZERO hivecontrol
//                  calls (replaces the old native `list children` + `message-child`
//                  spawn — the one native-messaging leak the guard could never
//                  catch). AGNOSTIC — never verifies merged/tested/deployed itself;
//                  that is the receiving parent's own repo policy.
//   migrate        auto-migrate on-disk state (JSON registry + legacy NDJSON inbox)
//                  into the store. Idempotent, NON-DESTRUCTIVE (never deletes source),
//                  single-consumer-locked, count-verified before it reports success.
//   send --to <meshId>|--to-primary|--broadcast --message TEXT [--from <id>] [--urgency ...]
//                  v0.57 MESH (PLAN-v0.57-mesh.md Phase 4, D8): writes THIS project's
//                  shared store/<repoKey>/ DIRECTLY — daemon-independent, ZERO
//                  hivecontrol calls. `--from` is always re-derived from cwd
//                  (callerIdentity, spoof-proof, D18/D19); an explicit --from must
//                  MATCH or the send is rejected. `--to <meshId>` is fail-closed
//                  against the shared registry (D12a) — an unregistered meshId is
//                  rejected, never silently black-holed. `--to-primary` (v0.58)
//                  resolves the registry entry whose worktree-derived meshId
//                  (via resolveMeshTarget, same identity-hash join `--to` uses)
//                  matches this project's MAIN worktree (install-devswarm-
//                  ingest's resolveMainWorktree) — fail-closed
//                  (`reason:'primary-unregistered'`) when no such entry exists.
//                  A hash join (not literal worktreePath equality) so a
//                  register-primary'd path and a later-resolved main worktree
//                  that are different STRINGS but the same real directory (e.g.
//                  win32 short/long-name spelling) still resolve. A non-git cwd
//                  returns
//                  {ok:false,reason:'no-project'} BEFORE any identity is derived
//                  (D28 — never emits an env-derived `from`).
//   roster [--ack]
//                  ALLOW-listed projection read of this project's shared registry +
//                  `working_on` + `recent[]` broadcast digest. `--ack` (alias of
//                  `mesh read`, D23) advances the CALLER's own broadcast cursor to
//                  head — the ONLY surface that clears `broadcastUnread`. v0.58:
//                  plain `roster` (never `--ack`) additionally FOLDS a read-only
//                  `hivecontrol workspace list children` view into the projection —
//                  a child hivecontrol spawned but that has never yet registered
//                  itself with the store stays visible instead of invisible.
//   mesh read      same as `roster --ack` (D23) — listed separately for discovery.
//   reconcile      v0.58: for every registry descriptor of THIS project with a
//                  worktreePath, spawns `node scripts/devswarm.js inbox pull <id>`
//                  as a SUBPROCESS with cwd=<that worktree> (an in-process call
//                  would drain the WRONG queue — inbox pull's native spawns inherit
//                  the calling process's cwd). Per-id O_EXCL pull lock (already
//                  shipped in devswarm-pull.js) serializes a sweep against a live
//                  child concurrently pulling its own inbox.
//   spawn <branch> [hivecontrol create flags...]
//                  v0.58: THIN pass-through wrap of `hivecontrol workspace create
//                  <branch> ...` (never re-implemented/re-parsed), then
//                  best-effort auto-registers the new worktree in this project's
//                  shared store registry (store-only; the child's own first
//                  inbox-pull/heartbeat/register still fills in its real sessionId).
//   merge [hivecontrol merge-into-source flags...]
//                  v0.58: THIN wrap of `hivecontrol workspace check-merge` +
//                  `hivecontrol workspace merge-into-source ...` (pass-through),
//                  then `send --broadcast`s the outcome to the mesh.
//
// Every id is isSafeId-gated before it is ever path.join'd. Fail-soft: a bad
// subcommand / id reports { ok:false, error } + exit 2, never throws a stack.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const store = require('../companion/lib/devswarm-store.js');
const inboxCursor = require('../companion/lib/devswarm-inbox-cursor.js');
const {
  isSafeId, devswarmRoot, livenessPathFor,
} = require('../companion/lib/liveness.js');
const { readDescriptors } = require('../companion/devswarm-supervisor.js');
const { pokeOrEscalate } = require('../companion/lib/recovery.js');
const migrate = require('../companion/devswarm-migrate.js');
const pull = require('../companion/lib/devswarm-pull.js');
const inst = require('../companion/install-devswarm-ingest.js');
const repokey = require('../companion/lib/devswarm-repokey.js');
const ingestHealth = require('../companion/lib/ingest-health.js');
const { isDevswarmActive } = require('../hooks/lib/devswarm-detect.js');
const { isForwardableRow } = require('../companion/lib/devswarm-noise.js');

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs walk-up
// looking for a `.git` entry — the same root `git rev-parse --show-toplevel`
// would report, WITHOUT spawning git. Mirrors hooks/devswarm-parent-gate.js /
// devswarm-parent-inbox.js / devswarm-child-turn.js byte-for-byte (kept as a
// local copy rather than a shared require, matching their own stated precedent
// of not adding new cross-file coupling for a few lines of pure fs walk). Used
// as callerIdentity's git-unavailable fallback so it agrees with the parent-gate
// hook's own cwd-derivation even when git is not on PATH.
function findGitToplevel(startDir) {
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir;
      } catch (_) { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root, no .git found
      dir = parent;
    }
  } catch (_) {
    return null;
  }
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
// Worktree resolution: resolveWorktree(cwd) (git spawn) first, falling back to
// the PURE-FS findGitToplevel(cwd) above when git is unavailable/unspawnable —
// this fallback ORDER matters: it keeps callerIdentity agreeing with the
// parent-gate hook's OWN cwd-derivation (which is pure-fs only, no git spawn)
// even when git cannot be spawned, instead of silently falling further back to
// the RAW cwd (which would misidentify a subdirectory as its own worktree and
// spuriously refuse a legitimate Primary self-ack run from a non-toplevel cwd
// with git unavailable). Only when NEITHER resolves does cwd fail to resolve to
// a workspace at all (case 2 above; final fallback = primaryWorkspaceId(raw
// cwd) so callerIdentity always returns a deterministic non-empty string).
// resolveCallerWorktree(cwd) -> the RESOLVED git worktree/toplevel for `cwd`, or
// null when `cwd` is not inside any git worktree. This is the SINGLE primitive
// used to canonicalize a cwd into a workspace identity: git `resolveWorktree`
// first, then the pure-fs `findGitToplevel` fallback (same order + rationale as
// callerIdentity's original inline resolution). Callers that must agree on a
// worktree's meshId — callerIdentity (identity derivation) AND cmdInboxPull (the
// registered worktreePath that `send --to` later hashes) — MUST route through
// this so a subdirectory cwd canonicalizes to the SAME toplevel both places
// (bug: a child that ran `inbox pull` from a git SUBDIR registered the raw
// subdir path, which hashed to a meshId no `send --to` could resolve — the child
// became unaddressable, failing closed as `unregistered-recipient`).
function resolveCallerWorktree(cwd) {
  const c = cwd || process.cwd();
  return inst.resolveWorktree(c) || findGitToplevel(c) || null;
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

// ----- paths -----
function workspacesDir(home) { return path.join(devswarmRoot(home), 'workspaces'); }
function archivedDir(home) { return path.join(devswarmRoot(home), 'archived'); }
function heartbeatsDir(home) { return path.join(devswarmRoot(home), 'heartbeats'); }
function archiveIgnoreDir(home) { return path.join(devswarmRoot(home), 'archive-ignore'); }
function descriptorPath(home, id) { return path.join(workspacesDir(home), id + '.json'); }
// The durable ACK cursor for the Primary/store read-path. Lives under cursors/ — an
// ALLOW location for the read-guard, deliberately NOT under store/ or inbox/ (which
// hold the message trail itself). A bare integer = consumed message count.
function primaryCursorPath(home, id) { return path.join(devswarmRoot(home), 'cursors', id + '.json'); }

// ----- tiny flag parser -----
// parseArgs(argv) -> { positionals: string[], flags: { name: string[] } }.
// Supports `--name value`, `--name=value`, repeatable (`--set a --set b`), and
// bare boolean flags (`--json`). Values are collected as arrays so a caller can
// take last-wins (single) or the whole list (repeatable).
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok === 'string' && tok.startsWith('--')) {
      let name = tok.slice(2);
      let val = null;
      const eq = name.indexOf('=');
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      else if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) { val = argv[++i]; }
      else { val = true; } // bare boolean flag
      if (!flags[name]) flags[name] = [];
      flags[name].push(val);
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}
function one(flags, name) {
  const v = flags[name];
  if (!v || !v.length) return undefined;
  const last = v[v.length - 1];
  return last === true ? undefined : last;
}
function many(flags, name) {
  const v = flags[name];
  if (!v || !v.length) return [];
  return v.filter((x) => x !== true).map(String);
}
// csvList — flatten repeatable + comma-separated values into a trimmed, deduped list.
function csvList(flags, name) {
  const out = [];
  for (const raw of many(flags, name)) {
    for (const part of String(raw).split(',')) {
      const t = part.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// ----- descriptor io -----
function readDescriptorFile(home, id, F) {
  try {
    const d = JSON.parse((F || fs).readFileSync(descriptorPath(home, id), 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch (_) { return null; }
}
function writeDescriptorAtomic(home, id, desc, F) {
  const G = F || fs;
  const dir = workspacesDir(home);
  G.mkdirSync(dir, { recursive: true });
  const p = descriptorPath(home, id);
  const tmp = p + '.tmp';
  G.writeFileSync(tmp, JSON.stringify(desc));
  G.renameSync(tmp, p);
  return p;
}

// buildDescriptorFromFlags(id, flags, existing, env) — merge flag values over an
// existing descriptor (so ensure/re-register only overrides what was passed).
// `repoId` (#36 cross-project-bleed fix) is the one field sourced from BOTH an
// explicit --repo-id flag AND env.DEVSWARM_REPO_ID: an explicit flag wins (an
// operator overriding for a one-off registration), otherwise a truthy env value
// wins (the normal per-session case — hivecontrol sets this for every DevSwarm
// child + the Primary alike), otherwise the existing descriptor's value (if any)
// is preserved untouched, same merge-preserve posture as the other fields.
function buildDescriptorFromFlags(id, flags, existing, env) {
  const base = existing && typeof existing === 'object' ? Object.assign({}, existing) : {};
  base.id = id;
  const worktree = one(flags, 'worktree');
  const session = one(flags, 'session');
  const inbox = one(flags, 'inbox');
  const cursor = one(flags, 'cursor');
  const nudge = many(flags, 'nudge');
  const repoIdFlag = one(flags, 'repo-id');
  if (worktree !== undefined) base.worktreePath = worktree;
  if (session !== undefined) base.sessionId = session;
  if (inbox !== undefined) base.inboxPath = inbox;
  if (cursor !== undefined) base.cursorPath = cursor;
  if (nudge.length) base.nudgeCommand = nudge;
  if (repoIdFlag !== undefined) base.repoId = repoIdFlag;
  else if (env && env.DEVSWARM_REPO_ID) base.repoId = env.DEVSWARM_REPO_ID;
  // normalize the fields the store/consumers expect to exist as keys
  if (base.worktreePath === undefined) base.worktreePath = null;
  if (base.sessionId === undefined) base.sessionId = null;
  if (base.inboxPath === undefined) base.inboxPath = null;
  if (base.cursorPath === undefined) base.cursorPath = null;
  if (base.nudgeCommand === undefined) base.nudgeCommand = null;
  if (base.repoId === undefined) base.repoId = null;
  return base;
}

// repoKeyForCwd(ctx) -> repoKey | null. Fail-open (never throws) resolution of
// THIS invocation's project key from ctx.cwd (defaulting to process.cwd()) —
// shared by every D24-rekeyed store caller below (register/gate/archive/inbox
// messages) so each targets the SAME shared per-project store `send`/`roster`
// read, instead of the pre-mesh legacy per-id hash bucket. null (non-git cwd)
// is fail-open: every caller below falls back to its EXISTING pre-mesh hash
// selection.
function repoKeyForCwd(ctx) {
  try { return repokey.repoKeyForWorktree((ctx && ctx.cwd) || process.cwd()); } catch (_) { return null; }
}

// upsertStoreRegistry — open the store, upsert one descriptor, re-derive summary,
// close. Kept in one place so every write path refreshes the projection.
//
// v0.57 mesh (D24 store-caller re-key): the registry now lands in the SHARED
// per-project store/<repoKey>/ (when repoKey resolves) — the SAME store `mesh
// send`'s fail-closed roster (D12a) and `roster` read — instead of the legacy
// store/<hashFromWorkspaceId(desc.id)>/ bucket, which the mesh CLI never reads.
// Without this, `register`/`ensure` populate an address book NOTHING looks at
// and every mesh direct send is rejected as unregistered. `desc.id` (the
// registry entry's id / self-registration partition, D19) is UNCHANGED — only
// WHICH physical store is opened changes.
function upsertStoreRegistry(home, desc, ctx) {
  const repoKey = repoKeyForCwd(ctx);
  const s = store.openStore({
    home, workspaceId: desc.id, hash: repoKey || undefined,
    backend: ctx && ctx.backend, env: ctx && ctx.env,
  });
  try {
    s.upsertRegistry(desc);
    store.deriveSummary(s, { home, env: ctx && ctx.env });
  } finally { s.close(); }
}

// isForwardable(msg) — retire-forward NOISE FILTER (#67). retireWorktreeDuplicates
// re-appends a duplicate partition's unread backlog into the survivor as fresh
// directs; forward ONLY a REAL actionable direct. Native ingest
// (devswarm-ingest.js / devswarm-pull.js) writes body+hash ONLY, so a stale
// `[Primary poke]` mirror or a `{_h:"native:..."}` hash-mirror row reads back as
// mtype:null / sender:null — forwarding those resurrects dead pokes into the live
// partition (proven harmful on a real store). A forwardable row must be a real
// mesh direct: mtype==='direct' (one check that excludes broadcast, heartbeat, AND
// every null-mtype native/poke/hash-mirror row) with a non-empty sender AND
// recipient. A legitimately-forwarded direct (appendMeshMessage sets all three)
// still passes, so real traffic is never over-filtered. This structural rule
// now lives in companion/lib/devswarm-noise.js (isForwardableRow) purely so
// it can be extracted and re-tested in one place — it is otherwise VERBATIM
// unchanged from the original #67 check and is deliberately NOT body-text
// filtered (see that module's own comment). devswarm-parent-gate.js's
// realUnread count applies the SEPARATE POKE_PREFIX text check (isNoiseText)
// to a DIFFERENT row shape (descriptor durable-inbox NDJSON, no
// mtype/sender/recipient at all, so it has no structural signal to use
// instead) — the two checks share only the POKE_PREFIX constant, not this
// structural rule.
function isForwardable(msg) {
  return isForwardableRow(msg);
}

// retireWorktreeDuplicates(home, keepDesc, ctx) — DELIVERY-CONVERGENCE reconcile
// (v0.55.x P0 message-loss fix). A DevSwarm child registers under its builder-id
// (the per-project substrate scheme — a free-form id that is NOT the worktree's own
// meshId). An OLDER duplicate row for the SAME worktree can still be LIVE in the
// shared registry: a legacy hivecontrol-native `<label>-<repoId8>` registration, or
// a pre-register `primary-<hash>` spawn phantom. Both hash (via their worktreePath)
// to the SAME meshId as the child's own row, so `resolveMeshTarget` has TWO rows
// resolving to this worktree and can route a `send` into the duplicate's partition —
// which no live session ever drains (the child reads its OWN builder-id partition)
// -> silent message loss.
//
// On self-register this RETIREs every OTHER same-worktree row so exactly ONE row
// (the caller's own builder-id — the partition the child actually reads) survives,
// making send-target and child-drain CONVERGE on ONE partition. Retire = the
// sanctioned registry tombstone (store.removeRegistry — a `remove` op in the
// append-only journal, a registry-row delete in sqlite); the `messages` rows are a
// DIFFERENT table and are NEVER deleted. Before tombstoning, every UNREAD direct
// message already sitting in the retired partition is FORWARDED into the surviving
// partition (re-appended with the survivor as recipient, hash recomputed from the
// new fields so a re-run OR-IGNOREs) so the cutover — and the entire backlog a child
// silently lost while both rows were live — orphans NOTHING. If forwarding a row's
// backlog throws, that duplicate is LEFT in place (never tombstoned) so no unread is
// stranded; a later self-register retries it.
//
// GATED to builder-id self-registrations (keepDesc.id !== the worktree's meshId): a
// meshId-keyed register (the Primary's `register-primary`, or the spawn phantom) must
// NEVER retire the child's live builder-id row, so those paths are a deliberate
// no-op. Idempotent (a tombstoned row is gone from listRegistry, so a re-run finds
// nothing) and FAIL-OPEN (any error is swallowed — a reconcile failure must never
// crash the child's register / SessionStart or block its turn).
function retireWorktreeDuplicates(home, keepDesc, ctx) {
  try {
    if (!keepDesc || !keepDesc.worktreePath || !keepDesc.id) return null;
    const keepMesh = inst.primaryWorkspaceId(keepDesc.worktreePath);
    if (!keepMesh) return null;
    // A meshId-keyed row (Primary / spawn phantom) must not retire a child's live
    // builder-id row — only a builder-id self-register (id !== the worktree meshId)
    // is the NEW scheme this reconcile is for.
    if (String(keepDesc.id) === String(keepMesh)) return null;
    // P1 (mis-retire hardening): match same-worktree candidates by the CANONICAL
    // real-path (worktreeRealPath — the collision-free pre-image of the hash), NOT
    // the 8-hex worktreeHash/meshId. A sha256-slice hash can (astronomically, but on
    // a money path "can" is disqualifying) collide two DISTINCT worktrees onto one
    // meshId; matching the resolved real path instead makes a mis-identification
    // impossible. The SHARED canonicalWorktreeRealPath (also used by
    // foldMeshDuplicates) is the collision-free pre-image of canonicalMeshId's hash,
    // so the two paths cannot diverge. Fail-open null (unresolvable) -> no-op.
    const keepReal = canonicalWorktreeRealPath(keepDesc.worktreePath);
    if (!keepReal) return null;
    const repoKey = repoKeyForCwd(ctx);
    const s = store.openStore({
      home, workspaceId: keepDesc.id, hash: repoKey || undefined,
      backend: ctx && ctx.backend, env: ctx && ctx.env,
    });
    let result;
    try {
      // Candidate set = every OTHER registry row for the SAME physical worktree
      // (matched by the SHARED canonicalWorktreeRealPath — the collision-free
      // pre-image of the hash, NOT the 8-hex meshId, so a sha256-slice hash can
      // never mis-identify two DISTINCT worktrees onto one meshId; fail-open null
      // -> this row is skipped). The forward-then-tombstone body is the SHARED
      // foldGroupIntoSurvivor primitive (also used by foldMeshDuplicates).
      const candidates = [];
      for (const d of s.listRegistry()) {
        if (!d || d.id == null || String(d.id) === String(keepDesc.id)) continue;
        if (!d.worktreePath) continue;
        if (canonicalWorktreeRealPath(d.worktreePath) !== keepReal) continue; // SAME physical worktree only (no hash-collision class)
        candidates.push(d);
      }
      result = foldGroupIntoSurvivor(s, home, keepDesc.id, candidates);
      if (result.retired.length) store.deriveSummary(s, { home, env: ctx && ctx.env });
    } finally { s.close(); }
    const { retired, left, forwardFailed, forwarded } = result;
    if (!retired.length && !left.length && !forwarded && !forwardFailed.length) return null;
    const out = { retired, forwarded };
    if (left.length) out.left = left;
    if (forwardFailed.length) out.forwardFailed = forwardFailed;
    return out;
  } catch (_) { return null; } // fail-open: reconcile must never crash the caller
}

// foldGroupIntoSurvivor(s, home, survivorId, candidates, opts) — the SHARED
// forward-then-tombstone primitive used by BOTH retireWorktreeDuplicates (one
// caller's worktree) and foldMeshDuplicates (the whole registry). For each
// candidate row (already filtered to belong with `survivorId`):
//   1. FORWARD its UNREAD direct backlog into the survivor (re-appended with the
//      survivor as recipient, hash recomputed so a re-run OR-IGNOREs), so the
//      cutover orphans NOTHING. Best-effort per row: on ANY forward error, DO NOT
//      tombstone — the row is LEFT (recorded in forwardFailed + a stderr warning,
//      never silently swallowed) so no unread is stranded (a later pass retries).
//   2. TOMBSTONE only a row we can prove is NOT a distinct live child — a
//      store-only row (spawn phantom / ingested legacy hivecontrol-native
//      registration) with NO on-disk per-project descriptor. A candidate that HAS
//      a descriptor could be a distinct live child draining its OWN partition, so
//      it is LEFT (recorded in `left`), never tombstoned — losing a message by
//      mis-retiring is far worse than leaving a duplicate row (P1 hardening).
// `opts.dryRun` classifies (which rows WOULD retire/left) without forwarding or
// tombstoning — used by the doctor `fold-mesh-duplicates` detect() so it shares
// this ONE classification instead of a second reimplementation. NEVER throws on a
// row (each is try/wrapped by the caller's own fold body / fail-open).
function foldGroupIntoSurvivor(s, home, survivorId, candidates, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const retired = [];
  const left = [];
  const forwardFailed = [];
  let forwarded = 0;
  for (const d of candidates) {
    if (!d || d.id == null || String(d.id) === String(survivorId)) continue;
    if (dryRun) {
      // read-only classification: a store-only row WOULD be tombstoned; a
      // descriptor-backed one WOULD be left (never collapsed).
      if (readDescriptorFile(home, d.id)) { left.push(d.id); continue; }
      retired.push(d.id);
      continue;
    }
    let forwardOk = true;
    try {
      const since = s.cursorValue(d.id);
      for (const m of s.listMessages(d.id, { sinceCursor: since })) {
        if (!isForwardable(m)) continue; // #67: forward only a real actionable direct — skips broadcast/heartbeat AND stale native poke/hash-mirror rows (mtype/sender null)
        const fields = {
          from: m.sender, to: survivorId, type: 'direct',
          message: m.body, timestamp: m.ts, urgency: m.urgency || 'normal',
        };
        const hash = store.meshMessageHash(fields);
        const r = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
        if (r && r.inserted) forwarded++;
      }
    } catch (_) { forwardOk = false; }
    if (!forwardOk) {
      forwardFailed.push(String(d.id));
      try {
        process.stderr.write('[devswarm] foldGroupIntoSurvivor: forward FAILED for '
          + String(d.id) + ' — row LEFT in place (not tombstoned); fold incomplete\n');
      } catch (_) {}
      continue;
    }
    if (readDescriptorFile(home, d.id)) { left.push(d.id); continue; }
    // P1a/P2/P3 race close: ATOMIC conditional tombstone. removeRegistryIf deletes
    // ONLY if the row is STILL EXACTLY the one we classified — its session_id AND
    // updatedAt AND writeSeq all still equal our snapshot (NULL-safe, so a null
    // snapshot updatedAt/writeSeq that gained a real value, or a NEW session_id,
    // counts as a re-register). sqlite: one atomic DELETE ... WHERE; journal: an
    // under-lock re-read + a conditional (`ifUpdatedAt`/`ifSessionId`/`ifWriteSeq`)
    // remove op reduceRegistry ignores if a re-register raced it. A child that
    // re-registered in the window (child-turn writes its descriptor THEN its store
    // row) is now re-written -> NOT deleted -> LEFT (a later fold re-evaluates);
    // forward-before-tombstone already ran and is idempotent, so nothing is
    // orphaned. (Descriptor-backed rows were already LEFT above — this pins the
    // store-only phantom, which may itself carry a stale session_id.)
    // P3 (v0.61.0 money-path residual): writeSeq is a per-row monotonic counter
    // bumped on EVERY upsert regardless of wall-clock ms — closes the LAST gap
    // where a live child re-registers the SAME id/sessionId within the SAME
    // millisecond as the snapshot (updatedAt alone can't distinguish that from a
    // stable phantom; writeSeq still advances).
    const removed = s.removeRegistryIf(d.id, { sessionId: d.sessionId, updatedAt: d.updatedAt, writeSeq: d.writeSeq });
    if (!removed) { left.push(d.id); continue; }
    retired.push(d.id);
  }
  return { retired, left, forwardFailed, forwarded };
}

// canonicalWorktreeRealPath(worktreePath) — the collision-FREE real-path pre-image
// of canonicalMeshId's 8-hex hash: canonicalize to the GIT TOPLEVEL first
// (resolveCallerWorktree — IDENTICAL resolution to canonicalMeshId below), then take
// its resolved real path (inst.worktreeRealPath). By construction
// canonicalMeshId(wt) === `primary-<first 8 hex of sha256(canonicalWorktreeRealPath(wt))>`,
// so two rows share a canonicalMeshId BUCKET iff this real path hashes to the same
// 8-hex — but they are the SAME physical worktree ONLY iff these real-path STRINGS
// are EQUAL. An 8-hex sha256 slice can (astronomically, but on a money path "can" is
// disqualifying) collide two DISTINCT toplevels onto ONE meshId, so grouping by the
// hash alone can bucket two UNRELATED worktrees together; comparing this real-path
// string-for-string is the collision-proof discriminator. This is the ONE helper
// BOTH retireWorktreeDuplicates (per-register) and foldMeshDuplicates (project-wide
// migration) match candidates with, so the fold can never again silently merge
// distinct worktrees the way a hash-only grouping did. Fail-open null (falsy path)
// -> callers treat it as "cannot confirm same worktree" (never merge).
function canonicalWorktreeRealPath(worktreePath) {
  if (!worktreePath) return null;
  const top = resolveCallerWorktree(worktreePath) || worktreePath;
  return inst.worktreeRealPath(top) || null;
}

// canonicalMeshId(worktreePath) — the meshId a row groups under. Canonicalizes to
// the row's GIT TOPLEVEL first (resolveCallerWorktree — git rev-parse
// --show-toplevel, pure-fs findGitToplevel fallback), so a legacy SUBDIR-SPLIT row
// (a child that registered from a git subdirectory — its raw real-path hashes to a
// DIFFERENT meshId than the toplevel's, invisible to plain-hash grouping) folds
// onto its toplevel. Falls back to the raw worktreePath when it does not resolve
// (a vanished path — already surfaced by staleRegistryPartitions — or a non-git
// dir), which reproduces the pre-existing plain-hash grouping exactly for every
// row that is already a toplevel. Submodules resolve to their OWN toplevel -> a
// submodule is correctly NOT merged with its parent.
function canonicalMeshId(worktreePath) {
  const top = resolveCallerWorktree(worktreePath) || worktreePath;
  return inst.primaryWorkspaceId(top);
}

// groupRegistryByMeshId(registry) -> Map<meshId, {meshId, ids[], rows[], liveRows}>.
// The ONE grouping implementation shared by cmdDiagnose (split detection) AND
// foldMeshDuplicates (canonical fold) — grouping key is canonicalMeshId so both
// see subdir-splits folded onto their toplevel identically.
function groupRegistryByMeshId(registry) {
  const byMesh = new Map();
  for (const d of registry) {
    if (!d || !d.worktreePath) continue;
    const meshId = canonicalMeshId(d.worktreePath);
    if (!meshId) continue;
    let g = byMesh.get(meshId);
    if (!g) { g = { meshId, ids: [], rows: [], liveRows: 0 }; byMesh.set(meshId, g); }
    g.ids.push(d.id);
    g.rows.push(d);
    if (d.sessionId != null && String(d.sessionId) !== '') g.liveRows++;
  }
  return byMesh;
}

// pickSurvivor(s, group) — the SAME freshest-live selection resolveMeshTarget uses
// (greatest registry updatedAt among LIVE rows; cursor-value tiebreak; else the
// first row — the phantom, pre-self-register), generalized to a canonical group's
// OWN rows (which include subdir-split rows resolveMeshTarget's plain-hash match
// would miss). The survivor is the partition a live session actually drains.
function pickSurvivor(s, group) {
  let firstMatch = null;
  let bestLive = null;
  for (const d of group.rows) {
    if (!d) continue;
    if (firstMatch === null) firstMatch = d;
    if (d.sessionId == null || String(d.sessionId) === '') continue; // not live
    if (bestLive === null) { bestLive = d; continue; }
    const a = Number.isFinite(d.updatedAt) ? d.updatedAt : -1;
    const b = Number.isFinite(bestLive.updatedAt) ? bestLive.updatedAt : -1;
    if (a > b) { bestLive = d; continue; }
    if (a === b && meshCursorValue(s, d.id) > meshCursorValue(s, bestLive.id)) bestLive = d;
  }
  return bestLive || firstMatch;
}

// rekeySubdirRegistryRows(s, dryRun) — P1b: reconcile the two identity views so a
// subdir-registered row is addressable by its TOPLEVEL meshId. resolveMeshTarget
// (send) matches a row by inst.primaryWorkspaceId(d.worktreePath) — the RAW stored
// path — while the fold groups by canonicalMeshId (git TOPLEVEL). An OLD store's row
// registered from a git SUBDIR stored a raw-subdir path whose meshId != its toplevel
// meshId, so `send --to <toplevel meshId>` failed closed as unregistered-recipient,
// and a LONE such row is skipped by the >=2 fold. Re-key it IN PLACE: rewrite the
// stored worktreePath to its canonical git toplevel, so the raw-path meshId
// resolveMeshTarget hashes BECOMES the toplevel meshId. This is a registry UPDATE
// (same id) — the partition (d.id, where the row's messages live) is UNCHANGED, so NO
// message move is needed; and it makes send + fold agree on ONE identity. A submodule
// resolves to its OWN toplevel and keeps a DISTINCT meshId (never merged into the
// parent). Non-git / unresolvable paths are left as-is (raw path IS their own meshId).
// Returns the count of re-keyed ids. dryRun classifies without writing (doctor detect).
function rekeySubdirRegistryRows(s, dryRun) {
  let rekeyed = 0;
  for (const d of s.listRegistry()) {
    if (!d || !d.worktreePath || d.id == null) continue;
    const top = resolveCallerWorktree(d.worktreePath);
    if (!top) continue; // non-git / unresolvable -> raw path is already its own meshId
    const canonMesh = inst.primaryWorkspaceId(top);
    if (!canonMesh || inst.primaryWorkspaceId(d.worktreePath) === canonMesh) continue; // already canonical
    rekeyed++;
    if (dryRun) continue;
    s.upsertRegistry({
      id: d.id,
      worktreePath: top, // rewritten to the canonical git toplevel (send+fold now agree)
      sessionId: d.sessionId,
      inboxPath: d.inboxPath,
      cursorPath: d.cursorPath,
      nudgeCommand: d.nudgeCommand,
    });
  }
  return rekeyed;
}

// foldMeshDuplicates(home, ctx) — MIGRATION generalization of
// retireWorktreeDuplicates over the WHOLE registry (not one live caller's
// worktree). Groups every registry row by canonical (git-toplevel) mesh identity
// and, for each group with 2+ rows, forwards every non-survivor's real direct
// backlog into the survivor and tombstones the store-only duplicates (leaving
// descriptor-backed ones), via the SHARED foldGroupIntoSurvivor primitive. This
// folds the prior mesh forms an OLD store accumulated — phantom rows, dual/legacy
// pairs, SUBDIR-SPLIT pairs — that the drain-only `reconcile` never dedups.
//   - Idempotent (hash-dedup forward + tombstone-of-absent -> a re-run finds no
//     store-only duplicate left, so retired:[]), fail-open (never throws),
//     non-destructive (forward-before-tombstone; message rows are NEVER deleted).
//   - Orphan partitions / stale-registry rows are DELIBERATELY untouched — they are
//     surface-only by explicit design (computeSummary's no-delete posture); this
//     only collapses same-worktree DUPLICATE registrations.
//   - `ctx.dryRun` classifies without writing (doctor detect()).
// Returns { ok, retired[], forwarded, folded, [left[]], [forwardFailed[]] }.
function foldMeshDuplicates(home, ctx) {
  const c = ctx || {};
  const dryRun = !!c.dryRun;
  try {
    const repoKey = repoKeyForCwd(c);
    // NEVER open/create the shared store just to look for duplicates. A missing
    // repoKey (non-git cwd) or an absent per-project store dir means there is no
    // registry to fold — return a clean no-op WITHOUT calling openStore (which
    // would create the dir; doctor's repair/--check store-untouched invariant).
    if (!repoKey) return { ok: true, retired: [], forwarded: 0, folded: 0 };
    let storeExists = false;
    try { storeExists = fs.existsSync(store.storeDirForHash(home, repoKey)); } catch (_) { storeExists = false; }
    if (!storeExists) return { ok: true, retired: [], forwarded: 0, folded: 0 };
    const s = store.openStore({ home, hash: repoKey, backend: c.backend, env: c.env });
    const retired = [];
    const left = [];
    const forwardFailed = [];
    let forwarded = 0;
    let folded = 0; // canonical groups that had ≥1 duplicate acted on
    let meshIdCollisions = 0; // meshId buckets spanning ≥2 DISTINCT canonical worktrees
    let rekeyed = 0; // P1b: subdir rows re-keyed to their canonical toplevel worktreePath
    try {
      // P1b FIRST: re-key any subdir-registered row to its toplevel worktreePath so
      // resolveMeshTarget (send) and the fold agree on ONE identity — including a LONE
      // subdir row the >=2 fold below never touches. Re-key is an in-place registry
      // update (same id/partition), so the fresh listRegistry the fold reads next just
      // sees canonical paths (grouping is by canonicalMeshId either way — unaffected).
      rekeyed = rekeySubdirRegistryRows(s, dryRun);
      const byMesh = groupRegistryByMeshId(s.listRegistry());
      for (const g of byMesh.values()) {
        if (g.rows.length < 2) continue; // fast skip: a lone row cannot have a duplicate
        // COLLISION GUARD (P0): a canonicalMeshId bucket is keyed by an 8-hex sha256
        // slice, which can (astronomically) collide two DISTINCT worktrees onto ONE
        // meshId. Fold ONLY within a real-path-identical sub-group — NEVER
        // merge/forward/tombstone across two distinct worktrees that merely share the
        // 8-hex. Sub-partition by the collision-free canonicalWorktreeRealPath (the
        // SAME comparison retireWorktreeDuplicates uses); an unresolvable path gets its
        // OWN singleton key so it is never merged with anything.
        const bySamePath = new Map(); // canonicalRealPath -> rows[]
        for (const d of g.rows) {
          const real = canonicalWorktreeRealPath(d.worktreePath);
          const key = real || (' unresolved:' + String(d.id));
          let sub = bySamePath.get(key);
          if (!sub) { sub = []; bySamePath.set(key, sub); }
          sub.push(d);
        }
        if (bySamePath.size > 1) {
          meshIdCollisions++;
          try {
            process.stderr.write('[devswarm] foldMeshDuplicates: meshId ' + String(g.meshId)
              + ' bucket spans ' + bySamePath.size + ' DISTINCT canonical worktrees (8-hex hash collision)'
              + ' — folding each in isolation, NEVER across\n');
          } catch (_) {}
        }
        for (const rows of bySamePath.values()) {
          if (rows.length < 2) continue; // no duplicate within this real worktree
          const survivor = pickSurvivor(s, { rows });
          if (!survivor || survivor.id == null) continue; // nothing live/first to keep -> skip
          const candidates = rows.filter((d) => d && String(d.id) !== String(survivor.id));
          const r = foldGroupIntoSurvivor(s, home, survivor.id, candidates, { dryRun });
          forwarded += r.forwarded;
          for (const x of r.retired) retired.push(x);
          for (const x of r.left) left.push(x);
          for (const x of r.forwardFailed) forwardFailed.push(x);
          if (r.retired.length || r.left.length || r.forwardFailed.length) folded++;
        }
      }
      if (!dryRun && retired.length) store.deriveSummary(s, { home, env: c.env });
    } finally { s.close(); }
    const out = { ok: true, retired, forwarded, folded };
    if (left.length) out.left = left;
    if (forwardFailed.length) out.forwardFailed = forwardFailed;
    if (meshIdCollisions) out.meshIdCollisions = meshIdCollisions;
    if (rekeyed) out.rekeyed = rekeyed;
    return out;
  } catch (_) {
    return { ok: true, retired: [], forwarded: 0, folded: 0 }; // fail-open: migration must never crash update/doctor
  }
}

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
function defaultSpawnInstaller(worktree, home, env) {
  const installerPath = path.join(__dirname, '..', 'companion', 'install-devswarm-ingest.js');
  try {
    return spawnSync(process.execPath, [installerPath], {
      cwd: worktree, env: Object.assign({}, env, { HOME: home }), encoding: 'utf8', timeout: 30000,
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
      || (() => inst.resolveWorktree(cwd) || findGitToplevel(cwd));
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

    const F = (ctx.io && ctx.io.fs) || fs;
    if (!selfHealCooldownElapsed(home, repoKey, now, F)) {
      return { daemonWarning: 'stale', daemonHealCooldown: true };
    }
    markSelfHealAttempt(home, repoKey, now, F);
    const spawn = (ctx.io && ctx.io.spawnInstaller) || defaultSpawnInstaller;
    spawn(worktree, home, env);
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
  }
  return r;
}

// ----- subcommands -----
function cmdRegister(id, flags, ctx, { requireNew } = {}) {
  const home = ctx.home;
  const existing = readDescriptorFile(home, id);
  if (requireNew && existing) {
    // ensure: idempotent — leave the on-disk descriptor untouched, but still
    // re-upsert the store registry so the projection reflects it. Also reconcile
    // any legacy/phantom duplicate row for this SAME worktree every time (the
    // steady-state child path: `inbox pull` auto-ensures each turn), so a
    // duplicate created AFTER the child's first register is still retired.
    upsertStoreRegistry(home, existing, ctx);
    const retire = retireWorktreeDuplicates(home, existing, ctx);
    const out = { ok: true, action: 'exists', id, descriptor: existing };
    if (retire) { out.retiredDuplicates = retire.retired; out.forwardedMessages = retire.forwarded; if (retire.left) out.leftDuplicates = retire.left; if (retire.forwardFailed) out.forwardFailed = retire.forwardFailed; }
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
  writeDescriptorAtomic(home, id, desc);
  // Initialize the durable cursor to 0 (nothing consumed yet) IF it does not
  // already exist — so `inbox count/read` immediately reports all messages as
  // unread. Without a cursor file, unreadBacklog returns known:false (a
  // fail-safe for the liveness path) which would read as "nothing pending".
  // NON-DESTRUCTIVE: never clobbers an existing cursor.
  if (desc.cursorPath && !fs.existsSync(desc.cursorPath)) {
    try {
      fs.mkdirSync(path.dirname(desc.cursorPath), { recursive: true });
      fs.writeFileSync(desc.cursorPath, '0');
    } catch (_) { /* best-effort init; inbox ops still work once a cursor exists */ }
  }
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
  if (desc.inboxPath) {
    try {
      fs.mkdirSync(path.dirname(desc.inboxPath), { recursive: true });
      fs.writeFileSync(desc.inboxPath, '', { flag: 'a' });
    } catch (_) { /* fail-open: best-effort init only, non-fatal to registration */ }
  }
  upsertStoreRegistry(home, desc, ctx);
  // Retire any legacy/phantom duplicate row for this SAME worktree so exactly one
  // row (this builder-id — the partition the child reads) survives, forwarding the
  // duplicate's unread backlog first (no orphaned messages). No-op unless a
  // duplicate exists; gated to builder-id self-registers inside the helper.
  const retire = retireWorktreeDuplicates(home, desc, ctx);
  const out = { ok: true, action: existing ? 'updated' : 'registered', id, descriptor: desc };
  if (retire) { out.retiredDuplicates = retire.retired; out.forwardedMessages = retire.forwarded; if (retire.left) out.leftDuplicates = retire.left; if (retire.forwardFailed) out.forwardFailed = retire.forwardFailed; }
  return out;
}

function cmdHeartbeat(id, flags, ctx) {
  const home = ctx.home;
  const dir = heartbeatsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const progressRaw = one(flags, 'progress');
  let progress = null;
  if (progressRaw !== undefined) {
    const n = Number(progressRaw);
    if (Number.isFinite(n)) progress = Math.max(0, Math.min(100, n));
  }
  // Only assert what the caller actually supplied (heartbeat authorship rule:
  // never fabricate progress/phase/wip/blockers — absent = unknown = null/[]).
  const beat = {
    id,
    ts: now,
    state_ts: now,
    source: 'cli-heartbeat',
    progress_pct: progress,
    phase: one(flags, 'phase') !== undefined ? one(flags, 'phase') : null,
    wip: many(flags, 'wip'),
    blockers: many(flags, 'blockers'),
    sessionId: one(flags, 'session') !== undefined ? one(flags, 'session') : null,
  };
  const p = path.join(dir, id + '.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(beat));
  fs.renameSync(tmp, p);

  // v0.57 mesh (PLAN-v0.57-mesh.md D11/D22, Phase 4 step 4): `--summary TEXT`
  // ALSO broadcasts a mesh heartbeat row into THIS project's SHARED
  // store/<repoKey>/ — `mtype='broadcast'` + `is_heartbeat=1` (D22; never a
  // third mtype value), so it tiers as a broadcast and NEVER Stop-gates, and is
  // EXCLUDED from `broadcastUnread` (else every peer's per-turn heartbeat would
  // grow that counter forever). `sender` is set to `id` — the BUILDER-ID this
  // heartbeat is FOR (matching `deriveSummary`'s `working_on` match on
  // `sender===d.id`) — deliberately NOT `callerIdentity()`/meshId, a DIFFERENT
  // addressing handle (D19). The summary text is caller-supplied ONLY, never
  // defaulted/fabricated (D11 heartbeat authorship rule); omitting --summary is
  // a legacy no-op (back-compat, no mesh write at all). A non-git cwd (repoKey
  // null, O-D5 "mesh dormant") is NOT an error — the base heartbeat above still
  // succeeds; `meshBroadcast` reports why the mesh write was skipped.
  let meshBroadcast = null;
  const summaryText = one(flags, 'summary');
  if (summaryText !== undefined) {
    const cwd = ctx.cwd || process.cwd();
    const repoKey = repokey.repoKeyForWorktree(cwd);
    if (!repoKey) {
      meshBroadcast = { ok: false, reason: 'no-project' };
    } else {
      const urgencyRaw = one(flags, 'urgency');
      const urgency = urgencyRaw !== undefined ? urgencyRaw : 'low';
      if (!ALLOWED_URGENCY.includes(urgency)) {
        meshBroadcast = {
          ok: false,
          error: 'heartbeat --urgency must be one of ' + ALLOWED_URGENCY.join('|'),
          allowed: ALLOWED_URGENCY.slice(),
        };
      } else {
        const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
        try {
          // P0 fix: `sender: id` above feeds recent[]/alreadyReportedThisEpisode()
          // (hooks/devswarm-child-gate.js's Stop-gate satisfaction check) — an
          // unvalidated `id` let ANY workspace forge another's "already reported"
          // row (`node devswarm.js heartbeat <victim-id> --summary ...`), spoofing
          // the victim's Stop-gate closed without it ever reporting. Same
          // provable-ownership check cmdSend (D18) and cmdInboxMessages' ack path
          // (D26) already use: literal self, or the caller's OWN registry entry
          // (joined by worktree-derived meshId via resolveMeshTarget) carries `id`
          // as its registered id.
          const caller = callerIdentity(ctx.env, cwd);
          const ownEntry = resolveMeshTarget(s, caller);
          const owns = caller === id || (ownEntry && ownEntry.id === id);
          if (!owns) {
            meshBroadcast = {
              ok: false,
              error: 'heartbeat --summary refused: caller ' + JSON.stringify(caller)
                + ' does not own workspace ' + JSON.stringify(id),
              callerIdentity: caller,
            };
          } else {
            const fields = { from: id, to: null, type: 'broadcast', message: String(summaryText), timestamp: now, urgency };
            const hash = store.meshMessageHash(fields);
            const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash, isHeartbeat: true }));
            store.deriveSummary(s, { home, env: ctx.env, now });
            meshBroadcast = { ok: true, sent: !!res.inserted, seq: res.seq, repoKey };
          }
        } finally { s.close(); }
      }
    }
  }
  return { ok: true, action: 'heartbeat', id, heartbeat: beat, meshBroadcast };
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
  const session = one(flags, 'session')
    || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID)
    || id;
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
  // untouched; only CREATES one when absent. Ignore the register result and pull.
  cmdRegister(id, ensureFlags, ctx, { requireNew: true });
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
  if (res.error) out.error = res.error;
  return out;
}

// cmdInboxMessages(id, flags, ctx, {ack}) — the Primary/store READ path. Reads
// message BODIES directly from the store via store.listMessages (NON-destructively —
// it never drains the native queue or deletes a row), mirroring how child-side
// `inbox read` reads the durable NDJSON. `--unread` returns only messages past the
// durable ACK cursor (a bare-int file under cursors/); `ack` (the `read-primary`
// ergonomic, or `--ack`) advances that cursor to the current total. Needs NO
// descriptor — the store rows exist keyed by workspaceId regardless. `--json` is
// accepted for parity (the CLI always emits JSON) and otherwise ignored.
//
// #22 fix: on ack, ALSO advance the STORE's own cursor (store.setCursor) — not just
// the durable ACK cursor FILE under cursors/. deriveSummary()'s projected `unread`
// (what the parent table shows) is computed from the store cursor
// (store.cursorValue), NOT the ACK cursor file, so without this a Primary that read
// its inbox still showed those messages as unread forever. Both cursors are kept:
// the ACK cursor file stays the read-guard ALLOW-listed location; the store cursor
// is the summary projection's source of truth. Re-derive summary.json in the same
// call so the persisted projection reflects the drop immediately, not just on the
// next unrelated store write.
//
// Cross-workspace ack hazard (bug #2): this path needs no descriptor and, before
// this fix, accepted ANY id — so workspace A could `inbox messages B --ack` (or
// `read-primary B`) and silently advance B's cursor, marking B's own unread as
// read out from under it. Harmless under today's usage but a live footgun once
// "all can read all" is common (an observer that reflexively acks someone else's
// id destroys the owner's unread signal). READ WITHOUT --ack stays OPEN to any id
// on purpose (that is the cross-workspace visibility feature) — only the ack
// (mutating) path is gated. `--ack-as-owner` is the explicit operator override for
// a legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's
// backlog on its behalf).
function cmdInboxMessages(id, flags, ctx, opts) {
  const home = ctx.home;
  const doAck = !!((opts && opts.ack) || flags.ack);
  const unread = !!flags.unread || doAck; // read-primary is inherently unread-then-ack
  const ackAsOwner = !!flags['ack-as-owner'];
  const cursorPath = primaryCursorPath(home, id);
  const cursor = inboxCursor.readCursor(cursorPath);
  // v0.57 mesh (D24): the Primary read-CLI opens the SAME shared per-project
  // store the per-project ingest daemon natively drains INTO (D8/D21) — without
  // this re-key, `inbox messages`/`read-primary` would read the legacy per-id
  // bucket the daemon no longer writes to and silently see nothing.
  const s = store.openStore({ home, workspaceId: id, hash: repoKeyForCwd(ctx) || undefined, backend: ctx.backend, env: ctx.env });
  let total, messages, acked;
  try {
    if (doAck && !ackAsOwner) {
      const caller = callerIdentity(ctx.env, ctx.cwd);
      // v0.57 mesh (P0 fix): literal `caller !== id` only holds when the caller's
      // OWN registered store id equals its worktree-derived meshId — true for a
      // self-registered Primary, but NEVER true for a child (registered under its
      // hivecontrol DEVSWARM_BUILDER_ID, a UUID unrelated to meshId — see
      // docs/KB-devswarm-hivecontrol.md:215). Every real child was refused
      // reading/acking its OWN inbox by this literal check. Resolve PROVABLE
      // ownership instead: does the caller's OWN registry entry — found via the
      // SAME worktree-matching join `resolveMeshTarget` already performs for send
      // addressing (compare each entry's worktreePath-derived meshId to the
      // caller's meshId) — carry `id` as ITS registered id? If so the caller,
      // whatever free-form id it registered under, IS the owner of `id`'s
      // partition (it is running from that exact worktree). A genuinely different
      // workspace's cwd resolves to a DIFFERENT registry entry (or none), so this
      // stays fail-closed for real cross-workspace acks — preserving the v0.56
      // cross-workspace ack-hazard protection (bug #2) this guard exists for.
      const ownEntry = resolveMeshTarget(s, caller);
      const owns = caller === id || (ownEntry && ownEntry.id === id);
      if (!owns) {
        return {
          ok: false,
          error: 'ack refused: caller ' + JSON.stringify(caller) + ' does not own workspace '
            + JSON.stringify(id) + ' (pass --ack-as-owner to override)',
          id,
          callerIdentity: caller,
        };
      }
    }
    total = s.messageCount(id);
    messages = s.listMessages(id, { sinceCursor: unread ? cursor : 0 });
    if (doAck) {
      acked = inboxCursor.ackTo(cursorPath, total); // absolute set to the current total (no inbox clamp)
      s.setCursor(id, acked); // keep deriveSummary's unread projection in sync with the ACK
      store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); // refresh the persisted projection now
    }
  } finally { s.close(); }
  return {
    ok: true,
    action: doAck ? 'read-primary' : 'messages',
    id,
    unread,
    cursor: acked !== undefined ? acked : cursor,
    total,
    count: messages.length,
    messages,
  };
}

function cmdInbox(sub, id, flags, ctx) {
  const home = ctx.home;
  if (sub === 'pull') return cmdInboxPull(id, flags, ctx);
  if (sub === 'messages') return cmdInboxMessages(id, flags, ctx);
  if (sub === 'read-primary') return cmdInboxMessages(id, flags, ctx, { ack: true });
  const desc = readDescriptorFile(home, id);
  if (!desc || !desc.inboxPath) {
    return { ok: false, error: 'no inboxPath for workspace ' + JSON.stringify(id) + ' (register it first)' };
  }
  const inboxPath = desc.inboxPath;
  const cursorPath = desc.cursorPath;
  if (sub === 'count') {
    const u = inboxCursor.readUnread(inboxPath, cursorPath);
    return { ok: true, action: 'count', id, unread: u.count, cursor: u.cursor, total: u.total, known: u.known };
  }
  if (sub === 'read') {
    const u = inboxCursor.readUnread(inboxPath, cursorPath);
    return { ok: true, action: 'read', id, lines: u.lines, count: u.count, cursor: u.cursor, total: u.total, known: u.known };
  }
  if (sub === 'ack') {
    if (!cursorPath) return { ok: false, error: 'no cursorPath for workspace ' + JSON.stringify(id) };
    const toRaw = one(flags, 'to');
    let cursor;
    if (toRaw !== undefined) {
      const n = Number(toRaw);
      if (!Number.isFinite(n)) return { ok: false, error: '--to must be a number' };
      cursor = inboxCursor.ackTo(cursorPath, n, undefined, inboxPath);
    } else {
      cursor = inboxCursor.advanceCursor(inboxPath, cursorPath); // ack-all
    }
    return { ok: true, action: 'ack', id, cursor, total: inboxCursor.countMessages(inboxPath) };
  }
  return { ok: false, error: 'unknown inbox subcommand: ' + JSON.stringify(sub) + ' (read|ack|count|pull|messages|read-primary)' };
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
  const worktree = one(flags, 'worktree') || inst.resolveWorktree(cwd);
  if (!worktree) {
    return { ok: false, error: 'register-primary must run inside a git worktree (or pass --worktree <path>)' };
  }
  const id = inst.primaryWorkspaceId(worktree);
  if (!isSafeId(id)) return { ok: false, error: 'derived primary workspace id is unsafe: ' + JSON.stringify(id) };
  const session = one(flags, 'session') || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID) || id;
  const inbox = one(flags, 'inbox'); // optional legacy NDJSON source for `migrate`
  const cursor = one(flags, 'cursor') || primaryCursorPath(home, id);
  const ensureFlags = { worktree: [worktree], session: [session], cursor: [cursor] };
  if (inbox !== undefined) ensureFlags.inbox = [inbox];
  const r = cmdRegister(id, ensureFlags, ctx);
  if (!r.ok) return r;
  return { ok: true, action: 'register-primary', id, workspaceId: id, worktree, descriptor: r.descriptor };
}

function cmdWorkspacesList(flags, ctx) {
  const home = ctx.home;
  // PER-PROJECT: which project's store to derive. Explicit targeting wins so a
  // caller can inspect any project's summary: --workspace <id> (a store partition
  // key directly) or --worktree <path> (its primary-<hash>). Otherwise derive the
  // CURRENT worktree's own store (primary-<worktreeHash>) from cwd. Outside a
  // worktree with no flag, fall back to the default bucket (an empty/legacy view).
  let workspaceId = one(flags, 'workspace');
  const worktreeFlag = one(flags, 'worktree');
  const worktree = worktreeFlag || inst.resolveWorktree(ctx.cwd || process.cwd());
  if (workspaceId === undefined) {
    workspaceId = worktree ? inst.primaryWorkspaceId(worktree) : undefined;
  }
  // v0.57 mesh (D24 store-caller re-key — this call was missed by the original
  // sweep): target the SAME shared per-project store `register`/`roster`/`gate`/
  // `archive` all write into (repoKey, when resolvable) — else `workspaces list`
  // opens the legacy per-id hash bucket while every writer lands in store/<repoKey>/,
  // so a freshly-registered peer never shows up here (count:0 against a real
  // roster). Derived from the SAME `worktree` used to derive `workspaceId` above
  // (an explicit --worktree flag, when given, must win over ctx.cwd for BOTH —
  // repoKeyForCwd(ctx) alone would ignore the flag and resolve the wrong
  // project's repoKey whenever the caller's cwd differs from --worktree, e.g. a
  // subprocess invocation that targets another worktree by flag). Omitting
  // `workspaceId` from deriveSummary lets it fall back to the opened handle's
  // own `.hash` (the repoKey) instead of recomputing hashFromWorkspaceId(workspaceId)
  // and re-targeting the legacy bucket.
  const repoKey = worktree ? repokey.repoKeyForWorktree(worktree) : repoKeyForCwd(ctx);
  const s = store.openStore({ home, workspaceId, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
  let sum;
  // #62: a READ verb must not mutate — use the PURE computeSummary (zero summary.json
  // write) instead of deriveSummary (which surprised users by writing on a read).
  try { sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now }); }
  finally { s.close(); }
  const workspaces = Object.values(sum.workspaces || {});
  return { ok: true, action: 'workspaces', workspaceId: workspaceId || null, requiredGates: sum.requiredGates, count: workspaces.length, workspaces };
}

function cmdGate(id, flags, ctx) {
  const home = ctx.home;
  const setNames = csvList(flags, 'set');
  const clearNames = csvList(flags, 'clear');
  if (!setNames.length && !clearNames.length) {
    return { ok: false, error: 'gate needs --set <csv> and/or --clear <csv>' };
  }
  const setBy = one(flags, 'by') !== undefined ? one(flags, 'by') : 'devswarm-cli';
  // v0.57 mesh (D24): gates land in the SAME shared per-project store the
  // registry/roster/archive_ready read (repoKey, when resolvable).
  const s = store.openStore({ home, workspaceId: id, hash: repoKeyForCwd(ctx) || undefined, backend: ctx.backend, env: ctx.env });
  let summary;
  try {
    for (const name of setNames) s.setGate({ workspaceId: id, name, value: true, setBy });
    for (const name of clearNames) s.setGate({ workspaceId: id, name, value: false, setBy });
    summary = store.deriveSummary(s, { home, env: ctx.env, now: ctx.now });
  } finally { s.close(); }
  const ws = (summary.workspaces || {})[id];
  return {
    ok: true, action: 'gate', id, set: setNames, cleared: clearNames,
    gates: ws ? ws.gates : undefined,
    archive_ready: ws ? ws.archive_ready : undefined,
    tracked: !!ws,
  };
}

function cmdNudge(id, flags, ctx) {
  const home = ctx.home;
  const desc = readDescriptorFile(home, id);
  if (!desc) return { ok: false, error: 'no descriptor for workspace ' + JSON.stringify(id) };
  // Pass the persisted verdict (if any) so pokeOrEscalate honors attempt count +
  // cooldown across CLI invocations, exactly as the supervisor sweep does.
  let verdict = {};
  try { verdict = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8')) || {}; } catch (_) { verdict = {}; }
  const res = pokeOrEscalate(desc, verdict, { home, now: ctx.now });
  return { ok: true, action: 'nudge', id, result: res };
}

function cmdArchive(id, ctx) {
  const home = ctx.home;
  const desc = readDescriptorFile(home, id);
  // Non-destructive: MOVE the descriptor into archived/ (never unlink outright),
  // then tombstone the store registry (append-only remove). Archival-by-absence
  // is the designed teardown signal (Verified fact #3).
  let moved = false;
  if (desc) {
    try {
      const adir = archivedDir(home);
      fs.mkdirSync(adir, { recursive: true });
      fs.renameSync(descriptorPath(home, id), path.join(adir, id + '.json'));
      moved = true;
    } catch (_) { moved = false; }
  }
  // v0.57 mesh (D24): tombstone the registry entry in the SAME shared
  // per-project store `register`/`roster` populate (repoKey, when resolvable) —
  // else archive silently no-ops against the legacy per-id bucket, leaving the
  // workspace visible in the roster forever.
  const s = store.openStore({ home, workspaceId: id, hash: repoKeyForCwd(ctx) || undefined, backend: ctx.backend, env: ctx.env });
  try { s.removeRegistry(id); store.deriveSummary(s, { home, env: ctx.env }); }
  finally { s.close(); }
  return {
    ok: true, action: 'archive', id, descriptorArchived: moved,
    manualStep: 'hivecontrol has no teardown command — REMOVE workspace ' + id +
      ' in the DevSwarm app (archive keeps disk contents; never delete without confirmation).',
  };
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

  const reason = one(flags, 'reason');
  const message = buildArchiveRequestMessage(reason);
  const from = callerIdentity(ctx.env, cwd);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    const fields = { from, to: id, type: 'direct', message, timestamp: now, urgency: 'high' };
    const hash = store.meshMessageHash(fields);
    const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    store.deriveSummary(s, { home, env: ctx.env, now });
    return {
      ok: true, action: 'archive-request', id, childId: id, posted: true,
      sent: !!res.inserted, seq: res.seq, reason: reason || null,
      reminder: 'Ensure you have verified merged + tested + deployed per your repo policy before archiving.',
    };
  } finally { s.close(); }
}

function cmdMigrate(ctx) {
  return migrate.migrateToStore({ home: ctx.home, backend: ctx.backend, env: ctx.env, now: ctx.now });
}

// ============================================================================
// v0.57 mesh CLI surface (send / roster / mesh read) — PLAN-v0.57-mesh.md
// Phase 4. A mesh send writes THIS project's shared store/<repoKey>/ DIRECTLY
// (D8, daemon-independent — decouples send availability from ingest-daemon
// health; ZERO hivecontrol calls) via the store-layer mesh primitives already
// shipped in Phase 2 (meshMessageHash/appendMeshMessage/deriveSummary).
// ============================================================================
const ALLOWED_URGENCY = ['low', 'normal', 'high', 'urgent'];

// hasFlag(flags, name) -> true iff `--name` was passed at all (bare boolean OR
// with a value) — distinct from `one()`, which returns undefined for a bare
// boolean flag (`--broadcast` with no value).
function hasFlag(flags, name) {
  return !!(flags && Array.isArray(flags[name]) && flags[name].length > 0);
}

// resolveMeshTarget(storeHandle, meshId) -> the registry descriptor whose
// worktree-derived meshId matches `meshId`, or null (fail-closed, D12a).
//
// meshId is NEVER stored as a schema field (Blast-radius note, D19): it is
// recomputed on every lookup from each registry entry's `worktreePath` via the
// SAME hardened primitive `callerIdentity` uses for a resolved worktree
// (`inst.primaryWorkspaceId`) — so a sender and the address book derive a given
// worktree's meshId IDENTICALLY, and the address book can never be env-spoofed
// (it is derived from the REGISTERED worktree path, never from any caller's
// env). This is the D19 join: `--to <meshId>` resolves to the target's real
// read partition (`d.id`, the builder-id), NOT the meshId itself.
// meshCursorValue(storeHandle, id) -> the row's durable inbox cursor as a finite
// number, or -1 (unreadable/absent). A safe wrapper over the store's cursorValue
// primitive (both backends expose it) used ONLY as the updatedAt-tie drain signal
// in resolveMeshTarget — never throws (a cursor read must not break addressing).
function meshCursorValue(storeHandle, id) {
  try {
    const v = storeHandle.cursorValue(id);
    return Number.isFinite(v) ? v : -1;
  } catch (_) { return -1; }
}

function resolveMeshTarget(storeHandle, meshId) {
  if (!meshId) return null;
  // A single worktreePath can carry MORE THAN ONE registry row that ALL resolve to
  // the same meshId. Concretely observed: the `spawn` phantom (keyed BY the meshId,
  // `sessionId:null`, no live session draining it) AND the child's own self-
  // registration (keyed by its builder-id, a real `sessionId`); and — the P0 case
  // this fix closes — TWO *live* builder-id rows for one worktree (a child that re-
  // registered under a NEW builder-id while an older builder-id row is still live,
  // OR a same-worktree duplicate the retire reconcile deliberately LEFT rather than
  // risk mis-tombstoning a distinct child, P1). listRegistry orders by id-sort, so a
  // bare "first live by id-ASC" is an id-ordering ACCIDENT: it can hand the send to a
  // STRANDED row that no live session drains -> silent message loss (verified repro,
  // both backends).
  //
  // ROUTE TO THE PARTITION THE CHILD ACTUALLY DRAINS, independent of retire timing/
  // success. The deterministic, store-native, drain-correlated signal: among LIVE
  // rows (non-empty sessionId), the one with the GREATEST registry `updatedAt`. A
  // live child re-registers its OWN partition every turn (inbox pull auto-ensures),
  // so the drained row's updatedAt keeps advancing; a stale/stranded duplicate stops
  // advancing the moment its session dies. Freshest-live is therefore the row a live
  // session is currently maintaining = the one it drains. The phantom (sessionId
  // null) is excluded by the liveness filter outright. Ties (equal/absent updatedAt)
  // fall back to id-ASC order (first encountered), and when NO row is live yet we
  // fall back to the first match (only the phantom exists, pre-self-register) — so
  // this is a strict refinement of the prior "prefer live" behavior, never worse.
  let firstMatch = null;
  let bestLive = null;
  for (const d of storeHandle.listRegistry()) {
    if (!d || !d.worktreePath) continue;
    if (inst.primaryWorkspaceId(d.worktreePath) !== String(meshId)) continue;
    if (firstMatch === null) firstMatch = d; // first match (phantom) — fallback when nothing is live
    if (d.sessionId == null || String(d.sessionId) === '') continue; // not live -> never a drain target
    if (bestLive === null) { bestLive = d; continue; }
    const a = Number.isFinite(d.updatedAt) ? d.updatedAt : -1;
    const b = Number.isFinite(bestLive.updatedAt) ? bestLive.updatedAt : -1;
    if (a > b) { bestLive = d; continue; } // strictly fresher live row wins
    if (a === b) {
      // updatedAt TIE (same-ms register race, devswarm-store.js upsert): id-ASC order
      // is drain-AGNOSTIC and can hand the send to a stale row that merely sorts first
      // (e.g. `aaa-stale` over `zzz-draining`). Break the tie by a DRAIN-CORRELATED
      // signal instead — the row whose inbox cursor is higher has actually READ more
      // messages, so it is the one a live session is currently draining. Only fall back
      // to id-ASC-first (keep the current bestLive) if the cursors are also equal.
      if (meshCursorValue(storeHandle, d.id) > meshCursorValue(storeHandle, bestLive.id)) bestLive = d;
    }
  }
  return bestLive || firstMatch;
}

// cmdSend(flags, ctx) — send --from <id> --to <meshId>|--broadcast --message
// TEXT [--urgency low|normal|high|urgent]. Opens store/<repoKey>/ directly.
//
// ORDERING PIN (D28/Fable P2): repoKey is resolved from cwd FIRST — a null
// repoKey (non-git cwd) returns {ok:false,reason:'no-project'} BEFORE any
// identity derivation, so a spoofed DEVSWARM_BUILDER_ID on a non-git cwd can
// NEVER emit an env-derived `from` (callerIdentity is never even reached on
// that path — `no-project` is returned first, unconditionally).
function cmdSend(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };

  // `from` is ALWAYS the hardened, cwd-derived identity (D18/D19) — never raw
  // env. An explicit --from flag is accepted ONLY as a redundant declaration
  // that must MATCH the derived identity; a mismatching one is spoofing and is
  // rejected outright (D18 guard).
  const from = callerIdentity(ctx.env, cwd);
  const fromFlag = one(flags, 'from');
  if (fromFlag !== undefined && fromFlag !== from) {
    return {
      ok: false,
      error: 'send --from ' + JSON.stringify(fromFlag) + ' does not match the '
        + 'caller\'s derived identity ' + JSON.stringify(from) + ' — spoofing rejected',
    };
  }

  const toFlag = one(flags, 'to');
  const broadcastFlag = hasFlag(flags, 'broadcast') || one(flags, 'type') === 'broadcast';
  // --to-primary (v0.58, PLAN.md CLI VERB CONTRACT): a third mutually-exclusive
  // target mode alongside the existing --to <meshId> / --broadcast.
  const toPrimaryFlag = hasFlag(flags, 'to-primary');
  const targetModeCount = (toFlag !== undefined ? 1 : 0) + (broadcastFlag ? 1 : 0) + (toPrimaryFlag ? 1 : 0);
  if (targetModeCount > 1) {
    return { ok: false, error: 'send accepts --to <meshId> OR --to-primary OR --broadcast, not more than one' };
  }
  if (targetModeCount === 0) {
    return { ok: false, error: 'send requires --to <meshId>, --to-primary, or --broadcast' };
  }
  const type = broadcastFlag ? 'broadcast' : 'direct';

  const message = one(flags, 'message');
  if (!message) return { ok: false, error: 'send requires --message TEXT' };

  const urgencyRaw = one(flags, 'urgency');
  const urgency = urgencyRaw !== undefined ? urgencyRaw : 'normal';
  if (!ALLOWED_URGENCY.includes(urgency)) {
    return {
      ok: false,
      error: 'send --urgency must be one of ' + ALLOWED_URGENCY.join('|'),
      allowed: ALLOWED_URGENCY.slice(),
    };
  }

  // --to-primary resolution (cheap, no store open needed): the installer helper
  // resolveMainWorktree(cwd) resolves THIS project's main worktree; its meshId
  // is what the fail-closed registry lookup (below, inside the store) and the
  // self-address check (here, mirroring --to's own ordering) both key off.
  let mainWorktree = null;
  let primaryMeshId = null;
  if (toPrimaryFlag) {
    mainWorktree = inst.resolveMainWorktree(cwd);
    if (!mainWorktree) {
      return { ok: false, reason: 'no-primary-worktree', error: 'send --to-primary: cwd is not inside a resolvable git worktree' };
    }
    primaryMeshId = inst.primaryWorkspaceId(mainWorktree);
  }

  if (type === 'direct') {
    const selfTarget = toPrimaryFlag ? primaryMeshId : toFlag;
    if (selfTarget === from) {
      return { ok: false, error: 'send --to' + (toPrimaryFlag ? '-primary' : '') + ' cannot address the sender itself' };
    }
  }

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    let targetPartition = null;
    if (type === 'direct') {
      // Fail-closed addressing (D12a): a --to naming a meshId not present in the
      // shared registry is rejected outright — never a silent black-hole. Same
      // posture for --to-primary: an unregistered Primary is a fail-closed error,
      // never a silent black-hole either.
      const target = toPrimaryFlag ? resolveMeshTarget(s, primaryMeshId) : resolveMeshTarget(s, toFlag);
      if (!target) {
        return toPrimaryFlag
          ? {
            ok: false, reason: 'primary-unregistered',
            error: 'send --to-primary: no registered Primary workspace for this project (run `register-primary` first)',
          }
          : {
            ok: false, reason: 'unregistered-recipient',
            error: 'send --to ' + JSON.stringify(toFlag) + ' is not a registered mesh workspace',
          };
      }
      // The row's workspace_id is the target's REAL read partition — its
      // builder-id (target.id), NOT the meshId (D19 child-delivery join): this
      // is what lands a mesh direct in the exact partition the recipient (or a
      // child's builder-id read surface, D26) actually reads.
      targetPartition = target.id;
    }
    const fields = {
      from, to: type === 'direct' ? targetPartition : null,
      type, message: String(message), timestamp: now, urgency,
    };
    const hash = store.meshMessageHash(fields);
    const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    store.deriveSummary(s, { home, env: ctx.env, now });
    return {
      ok: true, action: 'send', from,
      to: type === 'direct' ? (toPrimaryFlag ? primaryMeshId : toFlag) : null, type, urgency,
      sent: !!res.inserted, seq: res.seq,
    };
  } finally { s.close(); }
}

// LIST_CHILDREN_TIMEOUT_MS — bounded timeout for roster's read-only native
// fold spawn (`hivecontrol workspace list children`). Mirrors the finite-
// timeout posture every other hivecontrol spawn in this codebase uses
// (devswarm-pull.js's message-count/read-messages, child-gate.js's
// probeNativeMessageCount) — a hung/slow native CLI must never wedge `roster`.
const LIST_CHILDREN_TIMEOUT_MS = 5000;

// parseChildrenList(raw) -> [{branch,id,path}]. TOLERANT parse of `hivecontrol
// workspace list children` output — the JSON shape is not pinned in the KB, so
// accept a bare array or a {children:[...]} wrapper (same tolerance the old,
// now-deleted resolveChildBranch used for the same command).
function parseChildrenList(raw) {
  let list = [];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : []);
  } catch (_) { list = []; }
  return list.filter((e) => e && typeof e === 'object').map((e) => ({
    branch: e.branch || e.id || null,
    id: e.id || null,
    path: e.path || e.worktreePath || null,
  }));
}

// fetchNativeChildren(ctx) -> [{branch,id,path}]. ONE bounded, NON-DESTRUCTIVE
// `hivecontrol workspace list children` spawn (never `monitor`/`read-messages`),
// using the SAME injectable io.run posture as every other native spawn in this
// file (pull.defaultRun). Fail-open []: hivecontrol not installed / spawn error
// / unparseable output all read as "nothing to fold" — roster's own store-only
// view is NEVER blocked or degraded by this best-effort addition.
function fetchNativeChildren(ctx) {
  try {
    const run = (ctx.io && ctx.io.run) || pull.defaultRun;
    const res = run({ args: ['workspace', 'list', 'children'], env: ctx.env, timeout: LIST_CHILDREN_TIMEOUT_MS });
    if (!res || !res.ok) return [];
    return parseChildrenList(res.raw);
  } catch (_) {
    return [];
  }
}

// cmdRoster(flags, ctx) — ALLOW-listed projection read of THIS project's
// shared registry + `working_on` (D3 roster surface). Derives a FRESH summary
// (never a stale cache) from store/<repoKey>/, keyed purely off cwd — no id
// argument, project-scoped like `send`/`mesh read`.
//
// v0.58 roster fold: additionally unions a READ-ONLY `hivecontrol workspace
// list children` view into the projection (never written back to the store —
// the store registry stays the single write-owned source of truth). A native
// child not yet matched by worktreePath against the store set (i.e. one that
// has never registered itself via inbox pull/heartbeat/register) is appended
// as a minimal entry so it is still VISIBLE on the roster instead of invisible.
function cmdRoster(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let sum;
  // #62: a READ verb must not mutate — PURE computeSummary (no summary.json write).
  try { sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now }); }
  finally { s.close(); }
  const workspaces = Object.values(sum.workspaces || {}).map((w) => ({
    id: w.id, working_on: w.working_on, directUnread: w.directUnread,
    broadcastUnread: w.broadcastUnread, urgencyMax: w.urgencyMax,
    worktreePath: w.worktreePath || null, source: 'store',
  }));
  // Dedup by CANONICAL identity (inst.primaryWorkspaceId, which realpath-
  // normalizes before hashing), not raw string equality — the same fix class
  // as resolvePrimaryTarget: a raw `--show-toplevel` spelling and a
  // canonicalized one for the SAME real directory must collapse to one row.
  const knownIds = new Set(workspaces.map((w) => w.worktreePath).filter(Boolean).map((p) => inst.primaryWorkspaceId(p)));
  const nativeChildren = fetchNativeChildren(ctx);
  for (const child of nativeChildren) {
    if (child.path && knownIds.has(inst.primaryWorkspaceId(child.path))) continue; // already represented via the store
    workspaces.push({
      id: child.branch || child.id || null, working_on: null,
      directUnread: null, broadcastUnread: null, urgencyMax: null,
      worktreePath: child.path || null, source: 'native',
    });
  }
  return { ok: true, action: 'roster', repoKey, count: workspaces.length, workspaces, recent: sum.recent || [] };
}

// cmdDiagnose(flags, ctx) — READ-ONLY mesh-health projection (#62). Uses the PURE
// store.computeSummary (ZERO summary.json write) plus the shared registry to show,
// per worktree: each registry row (id, worktreePath, sessionId, unread, live?),
// which partition a `send` to that worktree's meshId resolves to (resolveMeshTarget
// — the SAME freshest-live routing `send` uses), the orphan partitions +
// stale-registry rows computeSummary surfaces (Phase A), and any worktree carrying
// 2+ LIVE rows flagged as a "split" (the un-converged case a submodule / separate
// git root shows up as — surfaced here, NEVER auto-merged). Project-scoped like
// roster (no id arg, keyed off cwd's repoKey). Purity is the point: an orchestrator
// can SEE mesh state without the read itself mutating anything.
// computeDiagnosis(s, ctx) — the ONE mesh-health computation shared by cmdDiagnose,
// cmdHealthcheck (#71), and the doctor mesh-shape CHECK. Takes an OPEN store handle
// `s` (pure — computeSummary NEVER writes summary.json) and returns the fully
// derived pieces; callers add their own envelope + presentation. Groups via the
// shared groupRegistryByMeshId (canonical git-toplevel identity, so subdir-splits
// fold), so `send --to <meshId>` routing (resolveMeshTarget) and split detection
// agree with the fold. Adds two aggregate counts not surfaced by `diagnose`'s object
// today: `phantoms` (rows with no live sessionId) and `unreadTotal` (Σ directUnread).
function computeDiagnosis(s, ctx) {
  const c = ctx || {};
  const sum = store.computeSummary(s, { home: c.home, env: c.env, now: c.now });
  const registry = s.listRegistry();
  const byMesh = groupRegistryByMeshId(registry);
  const meshTargets = [];
  const splits = [];
  for (const g of byMesh.values()) {
    const target = resolveMeshTarget(s, g.meshId); // the partition `send --to <meshId>` lands in
    const split = g.liveRows >= 2;
    if (split) splits.push(g.meshId);
    meshTargets.push({ meshId: g.meshId, resolvesTo: target ? target.id : null, ids: g.ids, liveRows: g.liveRows, split });
  }
  const workspaces = sum.workspaces || {};
  const rows = registry.filter((d) => d && d.id != null).map((d) => {
    const w = workspaces[d.id] || {};
    return {
      id: d.id,
      worktreePath: d.worktreePath || null,
      sessionId: d.sessionId || null,
      live: d.sessionId != null && String(d.sessionId) !== '',
      unread: Number.isFinite(w.unread) ? w.unread : 0,
    };
  });
  const phantoms = rows.filter((r) => !r.live).length;
  let unreadTotal = 0;
  for (const id of Object.keys(workspaces)) {
    const w = workspaces[id];
    if (w && Number.isFinite(w.directUnread)) unreadTotal += w.directUnread;
  }
  return {
    sum, registry: rows, meshTargets, splits,
    orphans: sum.orphans || [],
    staleRegistryPartitions: sum.staleRegistryPartitions || [],
    phantoms, unreadTotal,
  };
}

function cmdDiagnose(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let d;
  try { d = computeDiagnosis(s, { home, env: ctx.env, now: ctx.now }); } finally { s.close(); }
  return {
    ok: true, action: 'diagnose', repoKey,
    count: d.registry.length, registry: d.registry,
    meshTargets: d.meshTargets, splits: d.splits,
    orphans: d.orphans,
    staleRegistryPartitions: d.staleRegistryPartitions,
  };
}

// cmdHealthcheck(flags, ctx) — #71: a scriptable PASS/FAIL gate over the SAME data
// `diagnose` computes (computeDiagnosis — one source, two presentations). Unlike
// `diagnose` (always ok:true — a report), this turns mesh-shape drift into an exit
// signal: ok/exit 0 when healthy, ok:false/exit non-zero when degraded.
//   counts = { orphans, stale, splits, phantoms, unreadTotal }.
//   degraded iff orphans>0 || stale>0 || splits>0 (STRUCTURAL drift only) —
//   phantoms (a spawn-time placeholder, benign/transient) and unreadTotal (normal
//   mailbox backlog) are reported for visibility but NEVER gate, so a freshly-
//   spawned worktree does not trip a false "degraded". Pure read (zero writes).
function cmdHealthcheck(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let d;
  try { d = computeDiagnosis(s, { home, env: ctx.env, now: ctx.now }); } finally { s.close(); }
  const counts = {
    orphans: d.orphans.length,
    stale: d.staleRegistryPartitions.length,
    splits: d.splits.length,
    phantoms: d.phantoms,
    unreadTotal: d.unreadTotal,
  };
  const degraded = counts.orphans > 0 || counts.stale > 0 || counts.splits > 0;
  return {
    ok: !degraded, action: 'healthcheck', repoKey,
    status: degraded ? 'degraded' : 'ok',
    counts,
    detail: {
      orphans: d.orphans,
      staleRegistryPartitions: d.staleRegistryPartitions,
      splits: d.splits,
    },
  };
}

// healthcheckHumanLine(result) — the DEFAULT (non-`--json`) render of `healthcheck`:
// one compact line. `--json` prints the raw JSON object (main() decides which).
function healthcheckHumanLine(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.reason === 'no-project') return 'healthcheck: no-project (cwd is not inside a DevSwarm project)';
  const c = r.counts || {};
  const parts = [
    'orphans=' + (c.orphans || 0),
    'stale=' + (c.stale || 0),
    'splits=' + (c.splits || 0),
    'phantoms=' + (c.phantoms || 0),
    'unread=' + (c.unreadTotal || 0),
  ];
  return 'healthcheck: ' + (r.status || (r.ok ? 'ok' : 'degraded')) + ' [' + parts.join(' ') + ']';
}

// cmdMeshRead(flags, ctx) — a.k.a. `roster --ack` (D23). Lists the CALLER's
// unseen NON-heartbeat broadcasts (its own broadcast_cursors join point up to
// the shared broadcast partition's current `seq` head), then advances the
// CALLER's OWN broadcast_cursors to head — the ONLY surface that clears
// `broadcastUnread`. `deriveSummary` re-scans only the bounded broadcast
// partition tail (recentCap), never an unbounded history.
function cmdMeshRead(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const from = callerIdentity(ctx.env, cwd);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    // v0.57 mesh (P1 fix, same root cause as the ack-ownership P0): the broadcast
    // cursor must be keyed by the caller's OWN REGISTERED partition id (d.id) —
    // the SAME id deriveSummary reads back via store.broadcastCursorValue(d.id)
    // (devswarm-store.js) — never the raw worktree-derived meshId `from`. These
    // coincide only for a self-registered Primary; for a child (registered under
    // its DEVSWARM_BUILDER_ID) they diverge, so acking broadcasts via this ONLY
    // documented clearing path (D23) advanced a cursor deriveSummary never reads,
    // leaving broadcastUnread stuck forever despite `ok:true, acked:true`. Resolve
    // the caller's own registry entry the same way the ack-ownership guard does
    // (resolveMeshTarget keyed by the caller's meshId); fall back to `from` itself
    // when unregistered (no store entry at all) — the pre-existing, still-correct
    // behavior for that case.
    const ownEntry = resolveMeshTarget(s, from);
    const cursorKey = ownEntry ? ownEntry.id : from;
    const cursor = typeof s.broadcastCursorValue === 'function' ? s.broadcastCursorValue(cursorKey) : 0;
    const all = typeof s.listMessages === 'function' ? s.listMessages(store.BROADCAST_PARTITION_ID) : [];
    // Filtered on the PHYSICAL mesh `seq` (storeSeq), matching broadcast_cursors'
    // own semantics (deriveSummary's broadcastUnread, D22/D23) — NOT the
    // per-workspace positional `sinceCursor` listMessages() otherwise supports.
    const broadcasts = all
      .filter((r) => !r.isHeartbeat && Number.isFinite(r.storeSeq) && r.storeSeq > cursor)
      .map((r) => ({ from: r.sender, message: r.body, timestamp: r.ts, urgency: r.urgency, seq: r.storeSeq }));
    const newCursor = typeof s.advanceBroadcastCursor === 'function' ? s.advanceBroadcastCursor(cursorKey) : cursor;
    store.deriveSummary(s, { home, env: ctx.env, now });
    return { ok: true, action: 'mesh-read', from, acked: true, newCursor, count: broadcasts.length, broadcasts };
  } finally { s.close(); }
}

// ============================================================================
// v0.58 lifecycle wrappers (reconcile / spawn / merge) — PLAN.md CLI VERB
// CONTRACT. spawn/merge are THIN pass-through wraps: hivecontrol's own flag
// grammar is NEVER re-parsed by this file's `parseArgs` (which only recognizes
// `--long` flags) — the dispatcher instead hands these two verbs the RAW
// argv tail (see `run()` below), so every hivecontrol flag (present or future,
// short OR long form, e.g. `-p`/`--prompt`) forwards byte-for-byte.
// ============================================================================

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
function defaultSpawnReconcile(d, ctx) {
  const env = Object.assign({}, ctx.env || process.env, { HOME: ctx.home });
  if (ctx.backend) env.ANTIHALL_DEVSWARM_STORE_BACKEND = ctx.backend;
  try {
    return spawnSync(process.execPath, [__filename, 'inbox', 'pull', d.id], {
      cwd: d.worktreePath, env, encoding: 'utf8', timeout: 30000,
    });
  } catch (e) {
    return { error: e };
  }
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
function cmdReconcile(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };

  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let descriptors;
  try { descriptors = s.listRegistry(); } finally { s.close(); }

  const targets = descriptors.filter((d) => d && d.worktreePath && isSafeId(d.id));
  const spawnFn = (ctx.io && ctx.io.spawnReconcile) || defaultSpawnReconcile;
  const results = [];
  for (const d of targets) {
    const r = spawnFn(d, ctx);
    let parsed = null;
    if (r && !r.error && typeof r.stdout === 'string') {
      try { parsed = JSON.parse(r.stdout); } catch (_) { parsed = null; }
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
      error: (parsed && parsed.error)
        || (r && r.error ? String((r.error && r.error.message) || r.error) : null)
        || (parsed ? null : 'reconcile: could not parse inbox-pull subprocess output'),
    });
  }
  const imported = results.reduce((acc, r) => acc + (r.imported || 0), 0);
  // P1 fix: aggregate `ok` must NOT be true when ANY target actually lost
  // messages — a lossy pull is a real shortfall, not a benign skip (that is
  // what `locked` is for). Silently returning ok:true here is what let
  // doctor/update report a lossy reconcile as "fixed"/success upstream.
  const lost = results.reduce((acc, r) => acc + (r.lost || 0), 0);
  return { ok: lost === 0, action: 'reconcile', repoKey, count: results.length, imported, lost, results };
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

// cmdSpawn(rest, ctx) — PLAN.md "spawn": THIN pass-through wrap of
// `hivecontrol workspace create <branch> ...` (rest[0] is the branch; every
// remaining token forwards untouched — never re-implemented), then a
// best-effort auto-registration of the new worktree in THIS project's shared
// store registry (store-only — no descriptor file, no sessionId yet; the
// child's own first inbox-pull/heartbeat/register fills that in itself, the
// same self-registration path every other child already relies on). A create
// failure is returned as-is; a registration failure AFTER a successful create
// never rolls back or fails the (already-succeeded) hivecontrol create.
function cmdSpawn(rest, ctx) {
  const branch = rest && rest[0];
  if (!branch) return { ok: false, error: 'spawn requires a branch name' };
  const cwd = ctx.cwd || process.cwd();
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;
  const args = ['workspace', 'create'].concat(rest);
  const res = run({ args, env: ctx.env, cwd });
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || 'hivecontrol workspace create failed', branch };
  }

  let registered = false;
  let worktreePath = null;
  let meshId = null;
  try {
    // hivecontrol's own `create` output shape is NOT pinned in the KB, so this
    // is a TOLERANT best-effort parse (same posture as this file's own
    // parseChildrenList) for a `path`/`worktreePath` field — NEVER a guessed
    // directory-naming convention. `ctx.io.newWorktreePath` is the explicit
    // test/override seam. Absent a resolvable path, registration is
    // best-effort-skipped (`registered:false` is a legitimate, reported
    // outcome — never a failure of the verb itself, which already succeeded
    // at the hivecontrol create call above).
    worktreePath = (ctx.io && ctx.io.newWorktreePath) || resolveCreatedWorktreePath(res);
    if (worktreePath) {
      meshId = inst.primaryWorkspaceId(worktreePath);
      const repoKey = repoKeyForCwd(ctx);
      const s = store.openStore({ home: ctx.home, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
      try {
        s.upsertRegistry({ id: meshId, worktreePath, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
        store.deriveSummary(s, { home: ctx.home, env: ctx.env, now: ctx.now });
        registered = true;
      } finally { s.close(); }
    }
  } catch (_) { registered = false; }

  return {
    ok: true, action: 'spawn', branch, created: true,
    worktreePath, meshId, registered, raw: res.raw,
  };
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
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;

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
      const from = callerIdentity(ctx.env, cwd);
      const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
      const summary = merged
        ? 'merge-into-source completed'
        : 'merge-into-source failed: ' + ((mergeRes && mergeRes.error) || 'unknown error');
      const s = store.openStore({ home: ctx.home, hash: repoKey, backend: ctx.backend, env: ctx.env });
      try {
        const fields = { from, to: null, type: 'broadcast', message: summary, timestamp: now, urgency: merged ? 'normal' : 'high' };
        const hash = store.meshMessageHash(fields);
        const bres = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
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

// ----- dispatch -----
// run(argv, ctx) -> { code, result }. ctx: { home, env, backend, now } (all
// injectable for tests). NEVER throws — any internal error becomes a
// { ok:false, error } result with exit code 2.
function run(argv, ctx0) {
  const ctx = Object.assign({ home: os.homedir(), env: process.env }, ctx0 || {});
  const { positionals, flags } = parseArgs(argv || []);
  const cmd = positionals[0];
  try {
    switch (cmd) {
      case 'register': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdRegister(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'ensure': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdRegister(id, flags, ctx, { requireNew: true });
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'heartbeat': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        return { code: 0, result: cmdHeartbeat(id, flags, ctx) };
      }
      case 'inbox': {
        const sub = positionals[1];
        const id = positionals[2];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        // 'pull' is the NATIVE-DRAIN verb (Phase 7 send-time self-heal, D-O-D7):
        // self-heal runs BEFORE it, never before the other (non-draining) inbox
        // subcommands (count/read/ack/messages).
        const r = sub === 'pull'
          ? withSelfHeal(() => cmdInbox(sub, id, flags, ctx), ctx)
          : cmdInbox(sub, id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'workspaces': {
        const sub = positionals[1] || 'list';
        if (sub !== 'list') return { code: 2, result: { ok: false, error: 'unknown workspaces subcommand: ' + sub } };
        return { code: 0, result: cmdWorkspacesList(flags, ctx) };
      }
      case 'gate': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdGate(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'nudge': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdNudge(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'archive': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        return { code: 0, result: cmdArchive(id, ctx) };
      }
      case 'archive-ignore': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        return { code: 0, result: cmdArchiveIgnore(id, ctx, { set: true }) };
      }
      case 'archive-unignore': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        return { code: 0, result: cmdArchiveIgnore(id, ctx, { set: false }) };
      }
      case 'archive-request': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        // Send-time self-heal (Phase 7): archive-request is a mesh-direct STORE
        // write (v0.58) — still a "send-like verb" per withSelfHeal's own
        // categorization, so the per-project ingest daemon health check still runs.
        const r = withSelfHeal(() => cmdArchiveRequest(id, flags, ctx), ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'register-primary': {
        const r = cmdRegisterPrimary(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'migrate': {
        return { code: 0, result: cmdMigrate(ctx) };
      }
      case 'send': {
        // Send-time self-heal (Phase 7): runs before every mesh send.
        const r = withSelfHeal(() => cmdSend(flags, ctx), ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'roster': {
        // `roster --ack` is an alias of `mesh read` (D23) — both clear the
        // caller's own broadcastUnread; plain `roster` is a read-only projection.
        const r = hasFlag(flags, 'ack') ? cmdMeshRead(flags, ctx) : cmdRoster(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'diagnose': {
        // READ-ONLY mesh-health projection (#62) — pure, never writes summary.json.
        const r = cmdDiagnose(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'healthcheck': {
        // #71: pass/fail gate over the SAME data diagnose computes — pure read,
        // exit 0 = healthy, non-zero = degraded (for monitors/CI/daemon).
        const r = cmdHealthcheck(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'mesh': {
        const sub = positionals[1];
        if (sub === 'read') {
          const r = cmdMeshRead(flags, ctx);
          return { code: r.ok ? 0 : 2, result: r };
        }
        return { code: 2, result: { ok: false, error: 'unknown mesh subcommand: ' + JSON.stringify(sub || '') + ' (read)' } };
      }
      case 'reconcile': {
        const r = cmdReconcile(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'spawn': {
        // THIN pass-through (PLAN.md): the RAW argv tail (never our own `--long`
        // flag parser, which would swallow a `--prompt`/`--title`/etc. token and
        // break faithful forwarding) — argv[0] is 'spawn' itself.
        const r = cmdSpawn((argv || []).slice(1), ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'merge': {
        // THIN pass-through (PLAN.md), same raw-tail posture as `spawn`.
        const r = cmdMergeVerb((argv || []).slice(1), ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      default:
        return { code: 2, result: { ok: false, error: 'unknown command: ' + JSON.stringify(cmd || '') +
          ' (register|register-primary|ensure|heartbeat|inbox|workspaces|gate|nudge|archive|archive-ignore|archive-unignore|archive-request|migrate|send|roster|diagnose|healthcheck|mesh|reconcile|spawn|merge)' } };
    }
  } catch (e) {
    return { code: 2, result: { ok: false, error: String(e && e.message || e) } };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { code, result } = run(argv);
  // `healthcheck` (no --json) prints ONE compact human line; every other verb —
  // and `healthcheck --json` — prints the raw JSON object. This is the only verb
  // with a human-line mode (there is no prior --json/--human precedent in this CLI).
  const wantHuman = argv[0] === 'healthcheck' && !argv.includes('--json');
  const out = wantHuman ? healthcheckHumanLine(result) : JSON.stringify(result);
  // fs.writeSync(1, ...) per repo rule (macOS node 18/20 exit-vs-async-flush race).
  fs.writeSync(1, out + '\n');
  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  run, parseArgs, one, many, csvList,
  buildDescriptorFromFlags, readDescriptorFile, descriptorPath,
  retireWorktreeDuplicates,
  foldGroupIntoSurvivor, canonicalMeshId, canonicalWorktreeRealPath, groupRegistryByMeshId, foldMeshDuplicates,
  computeDiagnosis, healthcheckHumanLine,
  workspacesDir, archivedDir, heartbeatsDir, archiveIgnoreDir, primaryCursorPath,
  selfHeal, withSelfHeal, SELF_HEAL_COOLDOWN_MS, selfHealCooldownPath,
};
