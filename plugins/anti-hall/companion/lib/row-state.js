'use strict';
// anti-hall :: row-state — THE ONE read-side answer to "what state is this
// workspace row in?" (mesh redesign Phase 4).
//
// WHY IT EXISTS: row state used to be derived at every surface separately —
// the roster, `diagnose`, routing (isRoutingLiveRow), the parent Stop gate, the
// per-turn parent-inbox table and the roster's archived-only demotion each
// combined the same signals (anti-hall's own archived/<id>.json marker, the
// app-side archived-set cache, the active descriptor) by hand, with small
// differences in which discriminators they passed. That is how a row could be
// "archived" on one surface and "live enough to route to" on another (28 of
// the mesh fixes circled this). Every such surface now calls rowState().
//
// SIGNALS (unchanged persisted shapes — this module adds no new file):
//   archived     anti-hall's own archive: archived/<id>.json whose worktreePath
//                matches the row and whose sessionId is not superseded by a
//                different live occupant (devswarm-archived.js).
//   appArchived  archived in the DevSwarm app: absent from the supervisor's
//                fresh active-set cache under all four absence conjuncts
//                (devswarm-archived-cache.js). Needs the row's repoKey.
//   present      the caller holds a registry row, or the active descriptor
//                workspaces/<id>.json exists.
//
// PRECEDENCE (highest wins):
//   1. archived     -> status 'archived'
//   2. appArchived  -> status 'app-archived'
//   3. present      -> status 'active'
//   4. otherwise    -> status 'unknown' (never guessed into 'active')
// Both booleans are always returned, so a surface that reports provenance
// (the parent gate lists `archived` and `app-archived` separately) keeps it.
//
// archiveComplete (isArchiveComplete / archiveCompleteIds): the STRICTER
// "the archive finished" test — marker present AND the active descriptor gone.
// cmdArchive links the descriptor into archived/ before it unlinks the active
// one, so mid-archive both exist; a surface that DEMOTES a projection (the
// roster, computeSummary's registry filter) needs the finished state, while an
// alert suppressor wants 'archived' as soon as the marker matches.
//
// FAIL-OPEN everywhere: an unreadable signal reads as "not archived", never as
// a fabricated state. Pure reads: never writes, never spawns.

const fs = require('fs');
const path = require('path');
const archivedLib = require('./devswarm-archived.js');
const { devswarmRoot, isSafeId } = archivedLib;
const archivedCache = require('./devswarm-archived-cache.js');

// rowState(opts) -> { status, archived, appArchived, present }
// opts: { home, id, worktreePath, sessionId, repoKey, registryRow, env, now,
//         cache, fsi, log }
//   registryRow: the caller's registry row, `null` when the caller KNOWS there
//     is none, or omitted when the caller is classifying a row it already holds.
//   repoKey: the row's own project key; without it appArchived is false.
//   cache: an already-read app active-set cache (hot-path callers read it once).
function rowState(opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const id = o.id != null ? String(o.id) : '';
  let archived = false;
  try {
    archived = archivedLib.isArchivedWorkspace(o.home, id, o.worktreePath || null, {
      fs: F,
      sessionId: o.sessionId || null,
      log: typeof o.log === 'function' ? o.log : undefined,
    });
  } catch (_) { archived = false; }
  let appArchived = false;
  if (o.repoKey) {
    try {
      appArchived = !!archivedCache.isAppArchived({
        home: o.home, repoKey: o.repoKey, id, worktreePath: o.worktreePath || null,
        env: o.env, now: o.now, cache: o.cache, fsi: o.fsi,
      });
    } catch (_) { appArchived = false; }
  }
  let present;
  if (o.registryRow === undefined) present = true;
  else if (o.registryRow) present = true;
  else present = activeDescriptorExists(o.home, id, F);
  const status = archived ? 'archived' : appArchived ? 'app-archived' : present ? 'active' : 'unknown';
  return { status, archived, appArchived, present };
}

// isRowArchived(opts) -> bool. Either archive kind — the question routing,
// the roster and diagnose ask.
function isRowArchived(opts) {
  const s = rowState(opts);
  return s.status === 'archived' || s.status === 'app-archived';
}

function activeDescriptorExists(home, id, F) {
  if (!isSafeId(id)) return false;
  try { return F.existsSync(path.join(devswarmRoot(home), 'workspaces', id + '.json')); } catch (_) { return false; }
}

// archivedDirState(home, F) -> { ok, path, exists }. archived/ must be a real
// directory (not a symlink) before anything inside it is believed.
function archivedDirState(home, F) {
  const dir = path.join(devswarmRoot(home), 'archived');
  // An injected fs without lstat (test doubles) cannot answer the symlink
  // question; let the caller's own readdir/exists probe decide instead.
  if (typeof F.lstatSync !== 'function') return { ok: true, path: dir, exists: true };
  let st;
  try { st = F.lstatSync(dir); } catch (_) { return { ok: true, path: dir, exists: false }; }
  if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, path: dir, exists: true };
  return { ok: true, path: dir, exists: true };
}

// isArchiveComplete(home, id, fsi) -> bool. archived/<id>.json exists AND
// workspaces/<id>.json does not. Fail-open: any error -> false.
function isArchiveComplete(home, id, fsi) {
  const F = fsi || fs;
  try {
    const sid = id != null ? String(id) : '';
    if (!isSafeId(sid)) return false;
    if (activeDescriptorExists(home, sid, F)) return false;
    const ad = archivedDirState(home, F);
    if (!ad.ok || !ad.exists) return false;
    return F.existsSync(path.join(ad.path, sid + '.json'));
  } catch (_) { return false; }
}

// archiveCompleteIds(home, fsi) -> Set<id>. The batch form of isArchiveComplete
// (one readdir of archived/ instead of a probe per registry row). An id whose
// active descriptor cannot be checked is treated as LIVE (never hidden).
function archiveCompleteIds(home, fsi) {
  const F = fsi || fs;
  const out = new Set();
  try {
    const ad = archivedDirState(home, F);
    if (!ad.ok || !ad.exists) return out;
    let names = [];
    try { names = F.readdirSync(ad.path); } catch (_) { return out; }
    const wsDir = path.join(devswarmRoot(home), 'workspaces');
    for (const n of names) {
      if (typeof n !== 'string' || !/\.json$/.test(n)) continue;
      const id = n.slice(0, -'.json'.length);
      if (!isSafeId(id)) continue;
      let live = true;
      try { live = F.existsSync(path.join(wsDir, id + '.json')); } catch (_) { live = true; }
      if (!live) out.add(id);
    }
  } catch (_) { return new Set(); }
  return out;
}

module.exports = { rowState, isRowArchived, isArchiveComplete, archiveCompleteIds };
