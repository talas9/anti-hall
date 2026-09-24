'use strict';
// tests/harness/invariants.js — I1-I7 assertion functions (phase1-harness-spec.md
// §3). I1/I6/I7 are wired as REAL (non-todo) checks; I2/I3/I4/I5 are wired as
// test.todo in the main test file but the assertion CODE here is real and
// runnable behind ANTIHALL_HARNESS_STRICT=1 (so later phases flip them on
// without rewriting the check).

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.join(__dirname, '..', '..');
const storeLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js'));
const cursorLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-inbox-cursor.js'));
const readerCursors = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'reader-cursors.js'));
const rowStateLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'row-state.js'));
const cliLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'scripts', 'devswarm.js'));
const archivedCacheLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-archived-cache.js'));
const livenessSelect = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-liveness-select.js'));

function deepEqualDiff(a, b) {
  try { assert.deepStrictEqual(a, b); return null; }
  catch (e) { return e.message; }
}

// ---- I1: cached summary.json == freshly recomputed --------------------------
// deriveSummary writes the projection AND returns it; computeSummary called
// again immediately (same store, same opts) must agree byte-for-byte, and the
// on-disk file (readSummaryForHash) must agree with both.
function checkI1(fixture, env, now) {
  const store = storeLib.openStore({ home: fixture.home, hash: fixture.repoKey, backend: 'journal', env });
  try {
    const opts = { home: fixture.home, env, now };
    const written = storeLib.deriveSummary(store, opts);
    const recomputed = storeLib.computeSummary(store, opts);
    const onDisk = storeLib.readSummaryForHash(fixture.home, fixture.repoKey, fs);
    const d1 = deepEqualDiff(written, recomputed);
    const d2 = deepEqualDiff(written, onDisk);
    if (d1 || d2) return { ok: false, detail: { d1, d2 } };
    return { ok: true };
  } finally {
    store.close();
  }
}

// ---- I2: every reader_cursors row is monotone non-decreasing ---------------
// Phase 3 repoint: reads the ONE read-position table (every row of every reader
// partition, both namespaces, the '#floor' row included); a tracker remembers
// the last-seen value per (partition, ns, reader) across steps and fails the
// moment any row goes backward.
function createI2Tracker() {
  const last = Object.create(null);
  return {
    check(fixture, readerIds, env) {
      const store = storeLib.openStore({ home: fixture.home, hash: fixture.repoKey, backend: 'journal', env: env || { ANTIHALL_INGEST_DRY_RUN: '1' } });
      try {
        for (const id of readerIds) {
          let rows = [];
          try { rows = store.readerCursorRows(id); } catch (e) { return { ok: false, detail: { readerId: id, error: String(e && e.message) } }; }
          for (const r of rows) {
            const k = id + '|' + r.ns + '|' + r.reader;
            const prev = last[k];
            if (prev != null && r.value < prev) return { ok: false, detail: { readerId: id, ns: r.ns, reader: r.reader, prev, now: r.value } };
            last[k] = r.value;
          }
        }
        return { ok: true };
      } finally { store.close(); }
    },
  };
}

// ---- I3: delivered + unread == total sent to that partition -----------------
// `sentCounts`/`deliveredCounts` are harness-side counters the caller updates
// on every send/pull op; unread comes from unionUnread against the real store.
function createI3Tracker() {
  const sentTo = Object.create(null); // readerId -> count of sends addressed to it
  const delivered = Object.create(null); // readerId -> cumulative imported-by-pull count
  return {
    onSend(toId) { sentTo[toId] = (sentTo[toId] || 0) + 1; },
    onPull(readerId, imported) { delivered[readerId] = (delivered[readerId] || 0) + (imported || 0); },
    check(fixture, readerId, env, now) {
      const total = sentTo[readerId] || 0;
      if (total === 0) return { ok: true };
      const unreadCount = measureUnread(fixture, readerId, env, now);
      const del = delivered[readerId] || 0;
      if (del + unreadCount !== total) {
        return { ok: false, detail: { readerId, total, delivered: del, unread: unreadCount } };
      }
      return { ok: true };
    },
  };
}

// measureUnread(fixture, readerId, env, now) -> countFor(...).unread for one
// reader against the real store (Phase 3: the ONE count every gate/CLI uses).
// THROWS on an unknown/unexpected result: the pre-B1 checker read fields the
// primitive never returned and silently measured 0, which made I3 vacuous.
function measureUnread(fixture, readerId, env, now) {
  const ip = path.join(fixture.home, '.anti-hall', 'devswarm', 'inbox', readerId + '.ndjson');
  const cp = path.join(fixture.home, '.anti-hall', 'devswarm', 'cursor', readerId + '.json');
  const store = storeLib.openStore({ home: fixture.home, hash: fixture.repoKey, backend: 'journal', env });
  try {
    const u = readerCursors.countFor(store, {
      reader: null, partition: readerId, inboxPath: ip, cursorPath: cp, fsi: fs, home: fixture.home, now,
    });
    if (!u || u.unknown || typeof u.unread !== 'number' || !Number.isFinite(u.unread)) {
      throw new Error('I3 checker: countFor returned an unknown/unexpected shape: ' + JSON.stringify(u && { unknown: u.unknown, reason: u.reason, keys: Object.keys(u) }));
    }
    return u.unread;
  } finally {
    store.close();
  }
}

// ---- I4: descriptor fields == registry fields for shared keys ---------------
function checkI4(fixture, readerId, env) {
  const descPath = path.join(fixture.home, '.anti-hall', 'devswarm', 'workspaces', readerId + '.json');
  let desc = null;
  try { desc = JSON.parse(fs.readFileSync(descPath, 'utf8')); } catch (_) { return { ok: true }; } // not registered yet
  const store = storeLib.openStore({ home: fixture.home, hash: fixture.repoKey, backend: 'journal', env });
  try {
    const row = store.listRegistry().find((r) => r && String(r.id) === String(readerId));
    if (!row) return { ok: false, detail: { readerId, reason: 'no registry row for a live descriptor' } };
    const fields = ['worktreePath', 'sessionId'];
    const mismatches = {};
    for (const f of fields) {
      if (desc[f] !== row[f]) mismatches[f] = { descriptor: desc[f], registry: row[f] };
    }
    if (Object.keys(mismatches).length) return { ok: false, detail: { readerId, mismatches } };
    return { ok: true };
  } finally {
    store.close();
  }
}

// ---- I4b: descriptor exists => a registry row exists for it -----------------
// Separate from checkI4's field-comparison: this is the coordinator-requested
// split-out of the D24 concern ("does register even create the registry
// row?") so a genuinely-missing row is its OWN I4 finding, never folded into
// I5 as a false "tombstoned" reading (see checkI5's header below for why that
// conflation was wrong).
function checkI4RegistryRowForDescriptor(fixture, readerId, env) {
  const descPath = path.join(fixture.home, '.anti-hall', 'devswarm', 'workspaces', readerId + '.json');
  if (!fs.existsSync(descPath)) return { ok: true }; // nothing to require yet
  const store = storeLib.openStore({ home: fixture.home, hash: fixture.repoKey, backend: 'journal', env });
  try {
    const row = store.listRegistry().find((r) => r && String(r.id) === String(readerId));
    if (!row) {
      return { ok: false, detail: { readerId, reason: 'descriptor exists on disk but store.listRegistry() has no row for it' } };
    }
    return { ok: true };
  } finally {
    store.close();
  }
}

// ---- I5: all archive sources agree -------------------------------------------
// createI5Tracker() — a STATEFUL tracker, not a one-shot snapshot. "Absent from
// store.listRegistry()" alone is NOT "tombstoned" (a never-registered reader is
// absent too), so the tracker remembers, per readerId, whether a registry row
// has ever been observed; only a seen-then-vanished readerId is scored as
// tombstoned (cmdArchive's `s.removeRegistry(id)` is the only row removal this
// harness's op vocabulary exercises). A readerId never seen is skipped.
//
// Phase 4 (one row-state derivation): the anti-hall archive sources must ALL
// agree with each other AND with THE reducer, companion/lib/row-state.js:
//   registryTombstoned  seen-then-vanished registry row
//   onDiskArchived      archived/<id>.json exists
//   rowStateArchived    rowState(...).status === 'archived'
//   archiveComplete     rowState.isArchiveComplete (marker + active descriptor gone)
//   routingArchived     devswarm.js isArchivedForRouting (routing/roster/diagnose)
// App-side archive is a DIFFERENT status ('app-archived', the DevSwarm app put
// the workspace away without anti-hall's archive verb), so it is not in the
// agreement set; instead the reducer's app-archived answer must equal the raw
// cache predicate whenever anti-hall itself has not archived the row.
function createI5Tracker() {
  const everSeenInRegistry = new Set();
  return {
    check(fixture, readerId, env) {
      const home = fixture.home;
      const descPath = path.join(home, '.anti-hall', 'devswarm', 'archived', readerId + '.json');
      const onDiskArchived = fs.existsSync(descPath);

      const store = storeLib.openStore({ home, hash: fixture.repoKey, backend: 'journal', env });
      let row;
      let worktreePath = null;
      try {
        row = store.listRegistry().find((r) => r && String(r.id) === String(readerId)) || null;
        if (row) everSeenInRegistry.add(readerId);
        worktreePath = row ? row.worktreePath : (fixture.readers[readerId] || null);
      } finally {
        store.close();
      }

      if (!everSeenInRegistry.has(readerId)) return { ok: true }; // never registered — not a tombstone question yet
      const registryTombstoned = !row;

      const st = rowStateLib.rowState({ home, id: readerId, worktreePath, registryRow: row, env, repoKey: fixture.repoKey });
      const rowStateArchived = st.status === 'archived';
      const archiveComplete = rowStateLib.isArchiveComplete(home, readerId);
      const routingArchived = cliLib.isArchivedForRouting({ id: readerId, worktreePath, sessionId: row ? row.sessionId : null }, home);

      const sources = { registryTombstoned, onDiskArchived, rowStateArchived, archiveComplete, routingArchived };
      const values = Object.values(sources);
      const allAgree = values.every((v) => v === values[0]);
      const rawAppArchived = !!archivedCacheLib.isAppArchived({ id: readerId, worktreePath, home, fsi: fs, env, repoKey: fixture.repoKey });
      const appAgrees = rowStateArchived || (st.status === 'app-archived') === rawAppArchived;
      const detail = Object.assign({ status: st.status, rawAppArchived }, sources);
      return allAgree && appAgrees ? { ok: true, detail } : { ok: false, detail };
    },
  };
}

// ---- I6: heartbeat interleave order-independence -----------------------------
// pickFreshestLive(candidates, opts) must return the SAME winner regardless of
// the arrival order of CLI-heartbeat vs child-turn-heartbeat sourced rows.
function checkI6(rowsA, rowsB, opts) {
  const a = livenessSelect.pickFreshestLive(rowsA, opts);
  const b = livenessSelect.pickFreshestLive(rowsB, opts);
  const aId = a && a.id != null ? String(a.id) : null;
  const bId = b && b.id != null ? String(b.id) : null;
  if (aId !== bId) return { ok: false, detail: { forward: aId, reversed: bId } };
  return { ok: true };
}

// ---- I7: dry-run / doctor --check writes nothing -----------------------------
// snapshotFsTree(root) -> Map<relPath, mtimeMs> for every regular file under
// root (missing root -> empty map, never throws — the tree may not exist yet).
function snapshotFsTree(root) {
  const out = new Map();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { out.set(full, fs.statSync(full).mtimeMs); } catch (_) {}
      }
    }
  }
  walk(root);
  return out;
}

function diffFsTrees(before, after) {
  const changed = [];
  for (const [p, mtime] of after) {
    if (!before.has(p)) changed.push({ path: p, kind: 'new' });
    else if (before.get(p) !== mtime) changed.push({ path: p, kind: 'mtime-changed' });
  }
  for (const p of before.keys()) {
    if (!after.has(p)) changed.push({ path: p, kind: 'removed' });
  }
  return changed;
}

module.exports = {
  checkI1, createI2Tracker, createI3Tracker, measureUnread, checkI4, checkI4RegistryRowForDescriptor,
  createI5Tracker, checkI6,
  snapshotFsTree, diffFsTrees,
};
