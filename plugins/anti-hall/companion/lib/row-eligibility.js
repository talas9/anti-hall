'use strict';
// anti-hall :: row-eligibility — THE ONE projection of a workspace row onto
// every "should this row count?" axis.
//
// WHY IT EXISTS: "archived" has several independent sources (anti-hall's own
// archived/<id>.json marker, the DevSwarm app database, absence from the
// supervisor's hivecontrol active-list cache), and next to them sit two owner
// opt-outs (the devswarm.heldPartitions setting and the per-row archive-ignore
// marker) plus the liveness/busy/waiting signals. Consumers used to combine
// these one axis at a time, each with its own subset; a consumer that forgot an
// axis let an archived/held row block, count or resurface again (the recurring
// "archived rows still blocking" and "parent gate wrongly blocks" chains).
// Every row-level consumer now asks this module once and applies ITS OWN
// policy to the answer (e.g. the parent gate: `archived || held || ignored`
// never blocks a child family).
//
// PROJECTION (rowEligibility / createContext().of):
//   archived       any archive source says so (marker OR app-side)
//   archivedBy     the sources that fired: 'marker' | 'app-db' | 'active-list'
//   markerArchived anti-hall's own marker (row-state.js `archived`)
//   appArchived    the DevSwarm app side (app DB, else active-list absence)
//   status/present row-state.js's status and presence (unchanged semantics)
//   held           id is listed in devswarm.heldPartitions
//   ignored        archive-ignore/<id>.json exists (owner's per-row ignore)
//   live           the row's session maps to a running harness process
//   busy           the child's own transcript shows recent real work
//   waitingOnUser  an unanswered prompt in a session that is still running
//   reason         the first applicable of: archived:<source> | held | ignored
//                  | waiting-on-user | busy | live | eligible
// live/busy/waitingOnUser are only computed when the context asks for them
// (`liveness: true`, they read transcripts / session files); otherwise null.
//
// All archive signals come from row-state.js (which wraps devswarm-archived.js,
// devswarm-app-db.js incl. the 0.109.2 cross-invocation cache, and
// devswarm-archived-cache.js), liveness from liveness.js / devswarm-idle.js.
// FAIL-OPEN everywhere: a throwing signal reads as false (never archived,
// never held, never live) exactly like the helpers it wraps. Pure reads except
// the app-db xcache file, which is written only when the caller opts in.

const fs = require('fs');
const path = require('path');
const rowStateLib = require('./row-state.js');
const { devswarmRoot } = require('./devswarm-archived.js');

function resolveHeldIds(ctx) {
  if (ctx.heldIds instanceof Set) return ctx.heldIds;
  try { return require('./devswarm-store.js').heldPartitionIdsFrom(ctx.env || process.env); } catch (_) { return new Set(); }
}

function archiveIgnored(home, id, F) {
  try { F.statSync(path.join(devswarmRoot(home), 'archive-ignore', String(id) + '.json')); return true; } catch (_) { return false; }
}

// computeLiveness(row, ctx) -> { live, busy, waitingOnUser }. Same rules the
// parent gate applied inline before this module existed (v0.109 safety review
// F1/F3/F4 + 0.109.4): live = the session pid is alive; busy = childBusyState;
// a wait only counts while the session is live, and a wait is never busy.
function computeLiveness(row, ctx) {
  const d = row.descriptor || row;
  const home = ctx.home;
  let live = false;
  if (d && d.sessionId) {
    try { live = require('./liveness.js').isSessionAliveRow({ sessionId: d.sessionId }, home); } catch (_) { live = false; }
  }
  let busy = false;
  let waitingOnUser = false;
  try {
    const opts = {};
    if (Number.isFinite(ctx.busyFreshMs)) opts.freshMs = ctx.busyFreshMs;
    const bs = require('./devswarm-idle.js').childBusyState(d, home, opts);
    busy = !!(bs && bs.busy);
    waitingOnUser = !!(bs && bs.waiting);
  } catch (_) { busy = false; waitingOnUser = false; }
  if (waitingOnUser && !live) waitingOnUser = false;
  if (waitingOnUser) busy = false;
  return { live, busy, waitingOnUser };
}

function project(row, ctx, heldIds) {
  const r = row || {};
  const id = r.id != null ? String(r.id) : '';
  let st = null;
  try {
    const cache = typeof ctx.cache === 'function' ? ctx.cache() : ctx.cache;
    st = rowStateLib.rowStateDetail({
      home: ctx.home, id, worktreePath: r.worktreePath, sessionId: r.sessionId || null,
      repoKey: r.repoKey || null, registryRow: r.registryRow, env: ctx.env, now: ctx.now,
      cache, fsi: ctx.fsi, xcache: ctx.xcache === true,
      log: typeof ctx.log === 'function' ? (event, details) => ctx.log(event, details, id) : undefined,
    });
  } catch (_) { st = null; }
  const markerArchived = !!(st && st.archived);
  const appArchived = !!(st && st.appArchived);
  const archivedBy = [];
  if (markerArchived) archivedBy.push('marker');
  if (appArchived) archivedBy.push(st.appArchivedVia || 'app-db');
  const held = heldIds().has(id);
  const ignored = archiveIgnored(ctx.home, id, ctx.fsi || fs);
  let live = null; let busy = null; let waitingOnUser = null;
  if (ctx.liveness === true) ({ live, busy, waitingOnUser } = computeLiveness(r, ctx));
  const reason = archivedBy.length ? 'archived:' + archivedBy[0]
    : held ? 'held' : ignored ? 'ignored'
      : waitingOnUser ? 'waiting-on-user' : busy ? 'busy' : live ? 'live' : 'eligible';
  return {
    id,
    archived: markerArchived || appArchived,
    archivedBy,
    markerArchived,
    appArchived,
    status: st ? st.status : 'unknown',
    present: st ? st.present : false,
    held,
    ignored,
    live,
    busy,
    waitingOnUser,
    reason,
  };
}

// createContext(ctx) -> { of(row), all(rows) }. One context per hook/CLI
// invocation: the held list and the app active-set cache are resolved once,
// and each distinct row is projected at most once (memoized).
// ctx: { home, env, now, cache (value | () => value), xcache, fsi, log,
//        heldIds (Set, optional), liveness (bool), busyFreshMs }
// row: { id, worktreePath, sessionId, repoKey, registryRow, descriptor }
function createContext(ctx) {
  const c = Object.assign({}, ctx || {});
  let held = null;
  const heldIds = () => { if (held === null) held = resolveHeldIds(c); return held; };
  const memo = new Map();
  function of(row) {
    const r = row || {};
    const key = JSON.stringify([
      r.id != null ? String(r.id) : '', r.worktreePath || null, r.sessionId || null, r.repoKey || null,
      r.registryRow === undefined ? 'u' : (r.registryRow ? 'r' : 'n'),
    ]);
    if (memo.has(key)) return memo.get(key);
    const p = project(r, c, heldIds);
    memo.set(key, p);
    return p;
  }
  function all(rows) {
    const out = new Map();
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (!r || r.id == null) continue;
      out.set(String(r.id), of(r));
    }
    return out;
  }
  return { of, all };
}

// rowEligibility(row, ctx) — single-row convenience (fresh context).
function rowEligibility(row, ctx) { return createContext(ctx).of(row); }

// rowEligibilities(rows, ctx) -> Map<id, projection> — batch convenience.
function rowEligibilities(rows, ctx) { return createContext(ctx).all(rows); }

module.exports = { createContext, rowEligibility, rowEligibilities };
