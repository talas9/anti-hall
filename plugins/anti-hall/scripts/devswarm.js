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
    // re-upsert the store registry so the projection reflects it.
    upsertStoreRegistry(home, existing, ctx);
    return { ok: true, action: 'exists', id, descriptor: existing };
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
  upsertStoreRegistry(home, desc, ctx);
  return { ok: true, action: existing ? 'updated' : 'registered', id, descriptor: desc };
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
  try { sum = store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); }
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
function resolveMeshTarget(storeHandle, meshId) {
  if (!meshId) return null;
  for (const d of storeHandle.listRegistry()) {
    if (!d || !d.worktreePath) continue;
    if (inst.primaryWorkspaceId(d.worktreePath) === String(meshId)) return d;
  }
  return null;
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
  try { sum = store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); }
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
          ' (register|register-primary|ensure|heartbeat|inbox|workspaces|gate|nudge|archive|archive-ignore|archive-unignore|archive-request|migrate|send|roster|mesh|reconcile|spawn|merge)' } };
    }
  } catch (e) {
    return { code: 2, result: { ok: false, error: String(e && e.message || e) } };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { code, result } = run(argv);
  // fs.writeSync(1, ...) per repo rule (macOS node 18/20 exit-vs-async-flush race).
  fs.writeSync(1, JSON.stringify(result) + '\n');
  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  run, parseArgs, one, many, csvList,
  buildDescriptorFromFlags, readDescriptorFile, descriptorPath,
  workspacesDir, archivedDir, heartbeatsDir, archiveIgnoreDir, primaryCursorPath,
  selfHeal, withSelfHeal, SELF_HEAL_COOLDOWN_MS, selfHealCooldownPath,
};
