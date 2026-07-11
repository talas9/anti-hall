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

// ----- paths -----
function workspacesDir(home) { return path.join(devswarmRoot(home), 'workspaces'); }
function archivedDir(home) { return path.join(devswarmRoot(home), 'archived'); }
function heartbeatsDir(home) { return path.join(devswarmRoot(home), 'heartbeats'); }
function archiveIgnoreDir(home) { return path.join(devswarmRoot(home), 'archive-ignore'); }
function descriptorPath(home, id) { return path.join(workspacesDir(home), id + '.json'); }

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

// buildDescriptorFromFlags(id, flags, existing) — merge flag values over an
// existing descriptor (so ensure/re-register only overrides what was passed).
function buildDescriptorFromFlags(id, flags, existing) {
  const base = existing && typeof existing === 'object' ? Object.assign({}, existing) : {};
  base.id = id;
  const worktree = one(flags, 'worktree');
  const session = one(flags, 'session');
  const inbox = one(flags, 'inbox');
  const cursor = one(flags, 'cursor');
  const nudge = many(flags, 'nudge');
  if (worktree !== undefined) base.worktreePath = worktree;
  if (session !== undefined) base.sessionId = session;
  if (inbox !== undefined) base.inboxPath = inbox;
  if (cursor !== undefined) base.cursorPath = cursor;
  if (nudge.length) base.nudgeCommand = nudge;
  // normalize the fields the store/consumers expect to exist as keys
  if (base.worktreePath === undefined) base.worktreePath = null;
  if (base.sessionId === undefined) base.sessionId = null;
  if (base.inboxPath === undefined) base.inboxPath = null;
  if (base.cursorPath === undefined) base.cursorPath = null;
  if (base.nudgeCommand === undefined) base.nudgeCommand = null;
  return base;
}

// upsertStoreRegistry — open the store, upsert one descriptor, re-derive summary,
// close. Kept in one place so every write path refreshes the projection.
function upsertStoreRegistry(home, desc, ctx) {
  const s = store.openStore({ home, backend: ctx && ctx.backend, env: ctx && ctx.env });
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
  const desc = buildDescriptorFromFlags(id, flags, existing);
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

function cmdInbox(sub, id, flags, ctx) {
  const home = ctx.home;
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
  return { ok: false, error: 'unknown inbox subcommand: ' + JSON.stringify(sub) + ' (read|ack|count)' };
}

function cmdWorkspacesList(ctx) {
  const home = ctx.home;
  const s = store.openStore({ home, backend: ctx.backend, env: ctx.env });
  let sum;
  try { sum = store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); }
  finally { s.close(); }
  const workspaces = Object.values(sum.workspaces || {});
  return { ok: true, action: 'workspaces', requiredGates: sum.requiredGates, count: workspaces.length, workspaces };
}

function cmdGate(id, flags, ctx) {
  const home = ctx.home;
  const setNames = csvList(flags, 'set');
  const clearNames = csvList(flags, 'clear');
  if (!setNames.length && !clearNames.length) {
    return { ok: false, error: 'gate needs --set <csv> and/or --clear <csv>' };
  }
  const setBy = one(flags, 'by') !== undefined ? one(flags, 'by') : 'devswarm-cli';
  const s = store.openStore({ home, backend: ctx.backend, env: ctx.env });
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
  const s = store.openStore({ home, backend: ctx.backend, env: ctx.env });
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
        return { code: 0, result: cmdWorkspacesList(ctx) };
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
      case 'migrate': {
        return { code: 0, result: cmdMigrate(ctx) };
      }
      default:
        return { code: 2, result: { ok: false, error: 'unknown command: ' + JSON.stringify(cmd || '') +
          ' (register|ensure|heartbeat|inbox|workspaces|gate|nudge|archive|archive-ignore|archive-unignore|migrate)' } };
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
  workspacesDir, archivedDir, heartbeatsDir, archiveIgnoreDir,
};
