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
const unreadLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-unread.js'));
const archivedLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-archived.js'));
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

// ---- I2: per-reader cursor floor is monotone non-decreasing -----------------
// Reads the DESCRIPTOR cursor (devswarm-inbox-cursor.js readCursor) for each
// reader; a tracker (createI2Tracker) remembers the last-seen value per reader
// across steps and fails the moment a read goes backward.
function createI2Tracker() {
  const last = Object.create(null);
  return {
    check(fixture, readerIds) {
      for (const id of readerIds) {
        const cp = path.join(fixture.home, '.anti-hall', 'devswarm', 'cursor', id + '.json');
        let v;
        try { v = cursorLib.readCursor(cp, fs); } catch (_) { continue; }
        if (!Number.isFinite(v)) continue;
        const prev = last[id];
        if (prev != null && v < prev) {
          return { ok: false, detail: { readerId: id, prev, now: v } };
        }
        last[id] = v;
      }
      return { ok: true };
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
      const ip = path.join(fixture.home, '.anti-hall', 'devswarm', 'inbox', readerId + '.ndjson');
      const cp = path.join(fixture.home, '.anti-hall', 'devswarm', 'cursor', readerId + '.json');
      const store = storeLib.openStore({ home: fixture.home, hash: fixture.repoKey, backend: 'journal', env });
      try {
        const u = unreadLib.unionUnread({
          inboxPath: ip, cursorPath: cp, fsi: fs, storeHandle: store, id: readerId, now,
        });
        const unreadCount = (u && Number.isFinite(u.count)) ? u.count
          : (u && Array.isArray(u.lines)) ? u.lines.length : 0;
        const del = delivered[readerId] || 0;
        if (del + unreadCount !== total) {
          return { ok: false, detail: { readerId, total, delivered: del, unread: unreadCount } };
        }
        return { ok: true };
      } finally {
        store.close();
      }
    },
  };
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
// createI5Tracker() — a STATEFUL tracker, not a one-shot snapshot. The earlier
// (Phase 1 first-pass) checker treated "absent from store.listRegistry()" as
// equivalent to "tombstoned by cmdArchive", which is a FALSE POSITIVE for any
// reader that was simply never registered yet — that state is indistinguishable
// from "never tombstoned" using JUST a snapshot. The REAL tombstone signal
// (verified: cmdArchive, devswarm.js ~11177, calls `s.removeRegistry(id)` —
// the ONLY registry-row-removal call this harness's op vocabulary ever
// exercises) is a TRANSITION: a row that was PRESENT at an earlier check and is
// ABSENT now. The tracker remembers, per readerId, whether a registry row has
// ever been observed; only a seen-then-vanished readerId is scored as
// "tombstoned" against the other archive sources — a readerId never seen in
// the registry at all is skipped (ok:true, not a finding either way).
function createI5Tracker() {
  const everSeenInRegistry = new Set();
  return {
    check(fixture, readerId, env) {
      const home = fixture.home;
      const descPath = path.join(home, '.anti-hall', 'devswarm', 'archived', readerId + '.json');
      const onDiskArchived = fs.existsSync(descPath);

      const store = storeLib.openStore({ home, hash: fixture.repoKey, backend: 'journal', env });
      let rowPresent;
      let worktreePath = null;
      try {
        const row = store.listRegistry().find((r) => r && String(r.id) === String(readerId));
        rowPresent = !!row;
        if (rowPresent) everSeenInRegistry.add(readerId);
        worktreePath = row ? row.worktreePath : (fixture.readers[readerId] || null);
      } finally {
        store.close();
      }

      if (!everSeenInRegistry.has(readerId)) return { ok: true }; // never registered — not a tombstone question yet
      const registryTombstoned = !rowPresent; // seen before, gone now == the real transition cmdArchive's removeRegistry produces

      const isArchivedWorkspace = archivedLib.isArchivedWorkspace(home, readerId, worktreePath, {});
      const isAppArchived = archivedCacheLib.isAppArchived({
        id: readerId, worktreePath, home, fsi: fs, env,
      });

      const sources = { onDiskArchived, registryTombstoned, isArchivedWorkspace, isAppArchived };
      const values = Object.values(sources);
      const allAgree = values.every((v) => v === values[0]);
      return allAgree ? { ok: true, detail: sources } : { ok: false, detail: sources };
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
  checkI1, createI2Tracker, createI3Tracker, checkI4, checkI4RegistryRowForDescriptor,
  createI5Tracker, checkI6,
  snapshotFsTree, diffFsTrees,
};
