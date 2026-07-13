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
//   archive-request <childId|childBranch> [--reason TEXT] [--child-branch B]
//                  SEND-ONLY: post a parent->child `[[ANTIHALL_ARCHIVE_REQUEST]]`
//                  message via `message-child <branch> <msg>`. AGNOSTIC — never
//                  verifies merged/tested/deployed itself; that is the receiving
//                  parent's own repo policy. Fail-open on spawn error.
//   migrate        auto-migrate on-disk state (JSON registry + legacy NDJSON inbox)
//                  into the store. Idempotent, NON-DESTRUCTIVE (never deletes source),
//                  single-consumer-locked, count-verified before it reports success.
//
// Every id is isSafeId-gated before it is ever path.join'd. Fail-soft: a bad
// subcommand / id reports { ok:false, error } + exit 2, never throws a stack.

const os = require('os');
const fs = require('fs');
const path = require('path');

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
function callerIdentity(env, cwd) {
  const bid = env && env.DEVSWARM_BUILDER_ID ? String(env.DEVSWARM_BUILDER_ID) : null;
  const c = cwd || process.cwd();
  const wt = inst.resolveWorktree(c) || findGitToplevel(c);
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

// upsertStoreRegistry — open the store, upsert one descriptor, re-derive summary,
// close. Kept in one place so every write path refreshes the projection.
function upsertStoreRegistry(home, desc, ctx) {
  // PER-PROJECT: this descriptor's own workspaceId selects its physical store.
  const s = store.openStore({ home, workspaceId: desc.id, backend: ctx && ctx.backend, env: ctx && ctx.env });
  try {
    s.upsertRegistry(desc);
    store.deriveSummary(s, { home, env: ctx && ctx.env });
  } finally { s.close(); }
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
  return { ok: true, action: 'heartbeat', id, heartbeat: beat };
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
  const worktree = ctx.cwd || process.cwd();
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
  // injection posture as ctx.backend / ctx.now / ctx.env already use.
  const res = pull.pullOnce({ home, id, env: ctx.env, backend: ctx.backend, now: ctx.now, io: ctx.io });
  const out = {
    ok: !!res.ok, action: 'pull', id,
    imported: res.imported || 0, duplicate: res.duplicate || 0,
    nativeCount: res.nativeCount || 0, locked: !!res.locked,
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
  if (doAck && !ackAsOwner) {
    const caller = callerIdentity(ctx.env, ctx.cwd);
    if (caller !== id) {
      return {
        ok: false,
        error: 'ack refused: caller ' + JSON.stringify(caller) + ' does not own workspace '
          + JSON.stringify(id) + ' (pass --ack-as-owner to override)',
        id,
        callerIdentity: caller,
      };
    }
  }
  const cursorPath = primaryCursorPath(home, id);
  const cursor = inboxCursor.readCursor(cursorPath);
  const s = store.openStore({ home, workspaceId: id, backend: ctx.backend, env: ctx.env });
  let total, messages, acked;
  try {
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
  if (workspaceId === undefined) {
    const worktreeFlag = one(flags, 'worktree');
    const worktree = worktreeFlag || inst.resolveWorktree(ctx.cwd || process.cwd());
    workspaceId = worktree ? inst.primaryWorkspaceId(worktree) : undefined;
  }
  const s = store.openStore({ home, workspaceId, backend: ctx.backend, env: ctx.env });
  let sum;
  try { sum = store.deriveSummary(s, { home, workspaceId, env: ctx.env, now: ctx.now }); }
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
  const s = store.openStore({ home, workspaceId: id, backend: ctx.backend, env: ctx.env });
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
  const s = store.openStore({ home, workspaceId: id, backend: ctx.backend, env: ctx.env });
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

// ARCHIVE_REQUEST_MARKER — the mechanical tag a receiving child looks for atop a
// parent->child message to recognize an archive request (vs. ordinary chatter).
const ARCHIVE_REQUEST_MARKER = '[[ANTIHALL_ARCHIVE_REQUEST]]';

// buildArchiveRequestMessage(reason) — the exact posted string. `reason` is
// optional; when omitted the marker + instruction still stand alone.
function buildArchiveRequestMessage(reason) {
  const tail = 'your parent asks you to archive this workspace; confirm with your user, then run devswarm.js archive <id>.';
  return reason
    ? ARCHIVE_REQUEST_MARKER + ' ' + reason + ' — ' + tail
    : ARCHIVE_REQUEST_MARKER + ' — ' + tail;
}

// resolveChildBranch(id, flags, ctx) -> { branch, source, error? }. `message-child`
// needs a BRANCH (per KB: <branch> IS the hivecontrol workspace identifier — no
// separate name field), but our OWN descriptor (workspaces/<id>.json) carries no
// `branch` field today (verified: buildDescriptorFromFlags only ever populates
// worktreePath/sessionId/inboxPath/cursorPath/nudgeCommand). Resolution order:
//   1. --child-branch (explicit, always wins)
//   2. desc.branch, if some future/other write path ever set one (harmless check)
//   3. `hivecontrol workspace list children` — the JSON shape is not pinned in the
//      KB (no example payload documented anywhere in this repo), so parse
//      TOLERANTLY: accept a bare array or a {children:[...]} wrapper, and match an
//      entry by branch/id equal to our childId OR by worktreePath equal to the
//      entry's path (the one join key we reliably hold ourselves).
//   4. the positional `id` itself, taken AS the branch — valid because a caller is
//      explicitly allowed to pass `<childId|childBranch>` directly, and by this
//      point `id` has already passed the isSafeId gate the dispatcher applies.
function resolveChildBranch(id, flags, ctx) {
  const explicit = one(flags, 'child-branch');
  if (explicit) return { branch: explicit, source: 'flag' };
  const home = ctx.home;
  const desc = readDescriptorFile(home, id);
  if (desc && desc.branch) return { branch: desc.branch, source: 'descriptor' };
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;
  const res = run({ args: ['workspace', 'list', 'children'], env: ctx.env });
  if (res && res.ok) {
    let list = [];
    try {
      const parsed = JSON.parse(res.raw);
      list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : []);
    } catch (_) { list = []; }
    const worktree = desc && desc.worktreePath;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const entryBranch = entry.branch || entry.id || null;
      if (entryBranch && entryBranch === id) return { branch: entryBranch, source: 'list-children' };
      if (worktree && entry.path && entry.path === worktree && entryBranch) {
        return { branch: entryBranch, source: 'list-children' };
      }
    }
  }
  return { branch: id, source: 'positional' };
}

// cmdArchiveRequest(id, flags, ctx) — SEND-ONLY. Posts a parent->child archive
// request via `message-child <branch> <marker + text>`, using the SAME injectable
// io.run spawn pattern as cmdInboxPull/devswarm-pull.js (pull.defaultRun), so this
// is testable without touching a real hivecontrol binary. AGNOSTIC: this verb never
// checks merged/tested/deployed itself — that is the RECEIVING parent's own repo
// policy to enforce before it ever runs `archive`; we only remind, never gate.
function cmdArchiveRequest(id, flags, ctx) {
  const reason = one(flags, 'reason');
  const resolved = resolveChildBranch(id, flags, ctx);
  if (!resolved.branch) {
    return { ok: false, error: 'could not resolve child branch for ' + JSON.stringify(id) + ' — pass --child-branch explicitly' };
  }
  const message = buildArchiveRequestMessage(reason);
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;
  const res = run({ args: ['workspace', 'message-child', resolved.branch, message], env: ctx.env });
  if (!res || !res.ok) {
    return {
      ok: false, error: (res && res.error) || 'message-child failed',
      id, childBranch: resolved.branch, posted: false, reason: reason || null,
    };
  }
  return {
    ok: true, id, childBranch: resolved.branch, posted: true, reason: reason || null,
    reminder: 'Ensure you have verified merged + tested + deployed per your repo policy before archiving.',
  };
}

function cmdMigrate(ctx) {
  return migrate.migrateToStore({ home: ctx.home, backend: ctx.backend, env: ctx.env, now: ctx.now });
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
        const r = cmdInbox(sub, id, flags, ctx);
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
        const r = cmdArchiveRequest(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'register-primary': {
        const r = cmdRegisterPrimary(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'migrate': {
        return { code: 0, result: cmdMigrate(ctx) };
      }
      default:
        return { code: 2, result: { ok: false, error: 'unknown command: ' + JSON.stringify(cmd || '') +
          ' (register|register-primary|ensure|heartbeat|inbox|workspaces|gate|nudge|archive|archive-ignore|archive-unignore|archive-request|migrate)' } };
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
};
