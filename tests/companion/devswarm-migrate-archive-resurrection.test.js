'use strict';
// devswarm-migrate / scripts/devswarm.js healOrphanPartitions — ARCHIVE
// RESURRECTION GATE (defect df54edf54804).
//
// Field report: SkyCrew archived 4 workspaces via `devswarm.js archive <id>`
// on 0.97.1. The 0.99.0 update's store migration ("N workspaces migrated")
// blindly upserted the registry row for every id it found an active
// workspaces/<id>.json descriptor for, without consulting archived/<id>.json
// or the registry tombstone `cmdArchive` had already appended — reviving
// rows that had been correctly put away, causing them to reappear in the
// parent-inbox table / parent gate as `archivedInApp: false`.
//
// The decision now lives in the SHARED module
// companion/lib/devswarm-archive-gate.js (resolveArchiveGate) — see its own
// header for the full mechanism (direct-marker match, the worktree-group
// sibling fallback, and why the reuse-proof uses isSiblingPartitionLive
// rather than a bare heartbeat check). devswarm-migrate.js's
// `migrationArchiveGate` is a back-compat alias onto the same function.
//
// TIMING NOTE (load-bearing for every "must skip" fixture below):
// isSiblingPartitionLive's underlying isDormantRow falls back to a
// descriptor's own file mtime as a "never launched" activity signal when no
// heartbeat/transcript exists (liveness.js's readActivityTs). A descriptor
// written LITERALLY MOMENTS AGO (as a naive test fixture would do) therefore
// reads as "not dormant" -> live, with zero heartbeat evidence — which is
// EXACTLY the mechanism that lets a genuinely live, never-heartbeated Primary
// read as live (the fix's whole point). In the real field scenario a
// worktree-group sibling's descriptor was written whenever it was ORIGINALLY
// registered, hours or days before a later migration/heal run — so every
// "must skip" fixture below explicitly backdates its descriptor mtime past
// the idle window to represent that realistically, instead of leaving it at
// the instant-of-test-authorship default.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrate = require('../../plugins/anti-hall/companion/devswarm-migrate.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const archiveGateLib = require('../../plugins/anti-hall/companion/lib/devswarm-archive-gate.js');
const { DEFAULT_ROSTER_IDLE_MS } = require('../../plugins/anti-hall/companion/lib/liveness.js');

// Past isDormantByActivity's "no transcript" (registration-ts-fallback) idle
// window (DEFAULT_ROSTER_IDLE_MS, 6h default) with margin — see the header
// note above for why this matters.
const STALE_MS = DEFAULT_ROSTER_IDLE_MS + 60 * 60 * 1000;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-migrate-archive-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'archived'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'heartbeats'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

function writeActiveDescriptor(home, id, desc, opts) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ id }, desc)));
  if (opts && Number.isFinite(opts.mtime)) {
    const d = new Date(opts.mtime);
    fs.utimesSync(p, d, d);
  }
  return p;
}
function writeArchivedMarker(home, id, desc, opts) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'archived', id + '.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ id }, desc)));
  if (opts && Number.isFinite(opts.mtime)) {
    const d = new Date(opts.mtime);
    fs.utimesSync(p, d, d);
  }
  return p;
}
function writeHeartbeat(home, id, beat) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', id + '.json');
  fs.writeFileSync(p, JSON.stringify(beat));
  return p;
}
const opts = (home, extra) => Object.assign({ home, backend: 'journal', env: {} }, extra || {});

for (const backend of ['journal', 'sqlite']) {
  test('[' + backend + '] archived id with SAME sessionId as the marker: migration never resurrects the registry row', () => {
    const home = tmpHome();
    try {
      const now = Date.now();
      const wt = '/wt/w1';
      writeArchivedMarker(home, 'w1', { worktreePath: wt, sessionId: 'sess-orig' }, { mtime: now - STALE_MS });
      // The active descriptor was recreated (e.g. a still-running child
      // re-registered), still carrying the SAME sessionId the marker has —
      // identity match alone is decisive here regardless of timing/liveness.
      writeActiveDescriptor(home, 'w1', { worktreePath: wt, sessionId: 'sess-orig' }, { mtime: now - STALE_MS });

      const rep = migrate.migrateToStore(opts(home, { backend, now }));
      assert.equal(rep.ok, true);
      const m = rep.migrated.find((x) => x.id === 'w1');
      assert.equal(m.archivedSkipped, true);
      assert.equal(rep.archivedSkipped, 1);

      const s = storeLib.openStore({ home, workspaceId: 'w1', backend });
      try {
        const reg = s.listRegistry().filter((r) => r.id === 'w1');
        assert.deepEqual(reg, [], 'row must stay absent — archived, never resurrected');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test('[' + backend + '] archived id, descriptor recreated with a DIFFERENT sessionId, stale (no heartbeat, no recent activity): skipped', () => {
    const home = tmpHome();
    try {
      const now = Date.now();
      const wt = '/wt/w2';
      writeArchivedMarker(home, 'w2', { worktreePath: wt, sessionId: 'sess-old' }, { mtime: now - STALE_MS });
      // Realistic timing: this leftover descriptor has sat here since before
      // the archive, well past the idle window — no heartbeat, no proof of a
      // genuinely live reuse.
      writeActiveDescriptor(home, 'w2', { worktreePath: wt, sessionId: 'sess-new-live' }, { mtime: now - STALE_MS });

      const rep = migrate.migrateToStore(opts(home, { backend, now }));
      const m = rep.migrated.find((x) => x.id === 'w2');
      assert.equal(m.archivedSkipped, true);
      assert.equal(m.archiveGateReason, 'archived-marker-superseded-unconfirmed');

      const s = storeLib.openStore({ home, workspaceId: 'w2', backend });
      try {
        assert.deepEqual(s.listRegistry().filter((r) => r.id === 'w2'), []);
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test('[' + backend + '] archived id, DIFFERENT sessionId + newer descriptor + fresh heartbeat: migrated as live, logged', () => {
    const home = tmpHome();
    try {
      const wt = '/wt/w3';
      const markerPath = writeArchivedMarker(home, 'w3', { worktreePath: wt, sessionId: 'sess-old' });
      // Backdate the marker's mtime so the freshly-written active descriptor
      // is unambiguously newer (archived/<id>.json is a hardlink of the
      // id's OWN pre-archive descriptor, so its mtime is frozen at whatever
      // that descriptor's last write was before archiving — simulate that
      // here).
      const past = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(markerPath, past, past);

      const inboxPath = path.join(home, 'inbox-w3.ndjson');
      fs.writeFileSync(inboxPath, '');
      const descPath = writeActiveDescriptor(home, 'w3', { worktreePath: wt, sessionId: 'sess-new-live', inboxPath });
      const now = Date.now();
      fs.utimesSync(descPath, new Date(now), new Date(now));
      writeHeartbeat(home, 'w3', { sessionId: 'sess-new-live', ts: now });

      const rep = migrate.migrateToStore(opts(home, { backend, now }));
      const m = rep.migrated.find((x) => x.id === 'w3');
      assert.equal(m.archivedSkipped, undefined);
      assert.equal(m.archiveGateReason, 'archived-marker-superseded-live-reuse');
      assert.equal(rep.archivedSkipped, 0);

      const s = storeLib.openStore({ home, workspaceId: 'w3', backend });
      try {
        const reg = s.listRegistry().filter((r) => r.id === 'w3');
        assert.equal(reg.length, 1);
        assert.equal(reg[0].sessionId, 'sess-new-live');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test('[' + backend + '] migrating twice is idempotent (archived id stays skipped both times)', () => {
    const home = tmpHome();
    try {
      const now = Date.now();
      const wt = '/wt/w4';
      writeArchivedMarker(home, 'w4', { worktreePath: wt, sessionId: 'sess-old' }, { mtime: now - STALE_MS });
      writeActiveDescriptor(home, 'w4', { worktreePath: wt, sessionId: 'sess-new-live' }, { mtime: now - STALE_MS });

      const rep1 = migrate.migrateToStore(opts(home, { backend, now }));
      const rep2 = migrate.migrateToStore(opts(home, { backend, now }));
      const m1 = rep1.migrated.find((x) => x.id === 'w4');
      const m2 = rep2.migrated.find((x) => x.id === 'w4');
      assert.equal(m1.archivedSkipped, true);
      assert.equal(m2.archivedSkipped, true);

      const s = storeLib.openStore({ home, workspaceId: 'w4', backend });
      try {
        assert.deepEqual(s.listRegistry().filter((r) => r.id === 'w4'), []);
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test('[' + backend + '] corrupt archived marker: skipped, never throws', () => {
    const home = tmpHome();
    try {
      const wt = '/wt/w5';
      fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'archived', 'w5.json'), '{not json');
      writeActiveDescriptor(home, 'w5', { worktreePath: wt, sessionId: 'sess-x' });

      let rep;
      assert.doesNotThrow(() => { rep = migrate.migrateToStore(opts(home, { backend })); });
      assert.equal(rep.ok, true);
      const m = rep.migrated.find((x) => x.id === 'w5');
      assert.equal(m.archivedSkipped, true);
      assert.equal(m.archiveGateReason, 'archived-marker-unreadable');

      const s = storeLib.openStore({ home, workspaceId: 'w5', backend });
      try {
        assert.deepEqual(s.listRegistry().filter((r) => r.id === 'w5'), []);
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test('[' + backend + '] a NEW workspace reusing an archived id at a DIFFERENT worktree migrates normally', () => {
    const home = tmpHome();
    try {
      writeArchivedMarker(home, 'w6', { worktreePath: '/wt/old-w6', sessionId: 'sess-old' });
      writeActiveDescriptor(home, 'w6', { worktreePath: '/wt/new-w6', sessionId: 'sess-fresh' });

      const rep = migrate.migrateToStore(opts(home, { backend }));
      const m = rep.migrated.find((x) => x.id === 'w6');
      assert.equal(m.archivedSkipped, undefined);

      const s = storeLib.openStore({ home, workspaceId: 'w6', backend });
      try {
        const reg = s.listRegistry().filter((r) => r.id === 'w6');
        assert.equal(reg.length, 1);
        assert.equal(reg[0].worktreePath, '/wt/new-w6');
      } finally { s.close(); }
    } finally { rm(home); }
  });
}

// (f) WORKTREE-GROUP FALLBACK (team-lead clarification, second trace):
// retireArchivedWorktreeGroup (devswarm.js's cmdArchive) tombstones the
// REGISTRY rows of every sibling id sharing the archived id's physical
// worktree — but never writes those siblings their own archived/<id>.json
// marker, and never touches their workspaces/<id>.json descriptor file. A
// sibling like this has NO marker of its own, so the direct per-id marker
// check alone cannot catch it; only a worktree-path match against a
// DIFFERENT id's marker can. Neither store backend leaves a queryable
// tombstone trace to fall back on instead (sqlite hard-DELETEs the row;
// JSONL's `remove` op just makes the id absent from listRegistry() — see
// devswarm-store.js:706-708 / :1322-1323).
for (const backend of ['journal', 'sqlite']) {
  test('[' + backend + '] (f) worktree-group sibling with NO marker of its own, stale descriptor: not re-registered by migration', () => {
    const home = tmpHome();
    try {
      const now = Date.now();
      const wt = '/wt/group-shared';
      // Archived id A carries the marker for the shared worktree.
      writeArchivedMarker(home, 'A', { worktreePath: wt, sessionId: 'sess-A' }, { mtime: now - STALE_MS });
      // Sibling id B was tombstoned in the STORE registry by
      // retireArchivedWorktreeGroup when A was archived, but its own
      // descriptor file was never touched and it has no marker of its own —
      // realistically it has sat there since before the archive (backdated),
      // with no heartbeat, so it is NOT distinguishable from a genuinely
      // dead leftover.
      writeActiveDescriptor(home, 'B', { worktreePath: wt, sessionId: 'sess-B' }, { mtime: now - STALE_MS });

      const rep = migrate.migrateToStore(opts(home, { backend, now }));
      const mA = rep.migrated.find((x) => x.id === 'A');
      const mB = rep.migrated.find((x) => x.id === 'B');
      // A itself has no active descriptor (properly archived) -> migration never sees it at all.
      assert.equal(mA, undefined);
      assert.ok(mB, 'B must still be visited by the migration loop');
      assert.equal(mB.archivedSkipped, true);
      assert.equal(mB.archiveGateReason, 'archived-worktree-group-sibling');

      const s = storeLib.openStore({ home, workspaceId: 'B', backend });
      try {
        assert.deepEqual(s.listRegistry().filter((r) => r.id === 'B'), [],
          'B must NOT be re-registered — it stays out of roster/diagnose exactly like a directly-archived id');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  test('[' + backend + '] (f2) worktree-group sibling WITH a fresh heartbeat for its own session: migrated as live, logged', () => {
    const home = tmpHome();
    try {
      const wt = '/wt/group-shared-2';
      writeArchivedMarker(home, 'A2', { worktreePath: wt, sessionId: 'sess-A2' });
      const inboxPath = path.join(home, 'inbox-C.ndjson');
      fs.writeFileSync(inboxPath, '');
      writeActiveDescriptor(home, 'C', { worktreePath: wt, sessionId: 'sess-C', inboxPath });
      const now = Date.now();
      writeHeartbeat(home, 'C', { sessionId: 'sess-C', ts: now });

      const rep = migrate.migrateToStore(opts(home, { backend, now }));
      const mC = rep.migrated.find((x) => x.id === 'C');
      assert.equal(mC.archivedSkipped, undefined);
      assert.equal(mC.archiveGateReason, 'archived-worktree-group-live-sibling');

      const s = storeLib.openStore({ home, workspaceId: 'C', backend });
      try {
        const reg = s.listRegistry().filter((r) => r.id === 'C');
        assert.equal(reg.length, 1);
      } finally { s.close(); }
    } finally { rm(home); }
  });
}

// unit coverage of migrationArchiveGate directly (no marker at all).
test('migrationArchiveGate: no archived marker -> not archived, migrate normally', () => {
  const home = tmpHome();
  try {
    const gate = migrate.migrationArchiveGate(home, 'nope', { worktreePath: '/wt/x', sessionId: 's' }, fs, {});
    assert.equal(gate.archived, false);
    assert.equal(gate.migrateAsLive, false);
  } finally { rm(home); }
});

// ---- LIVENESS PREDICATE (critic fix) — the four required rows ----
// A bare fresh-heartbeat check (the pre-fix reuse-proof) reproduces the exact
// root cause liveness.js's isSiblingPartitionLive header documents: a
// Primary never writes a heartbeat, `register` writes none, and a child
// mid-long-turn's heartbeat goes stale well before the session does — all
// three would have been WRONGLY skipped (lost) as "not proven live". These
// four cases pin resolveArchiveGate's direct-marker reuse branch against
// exactly that table, isolated from migrateToStore's I/O plumbing.
for (const backend of ['direct']) {
  test('resolveArchiveGate liveness table: a re-registered Primary with NO heartbeat at all reads as live', () => {
    const home = tmpHome();
    try {
      const wt = '/wt/primary';
      const markerPath = writeArchivedMarker(home, 'primary-abc', { worktreePath: wt, sessionId: 'sess-old' });
      const past = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(markerPath, past, past);
      // A Primary re-registered just now, after its own archive — no
      // heartbeat file exists yet (Primaries never write one at all).
      writeActiveDescriptor(home, 'primary-abc', { worktreePath: wt, sessionId: 'sess-primary-new' });

      const gate = archiveGateLib.resolveArchiveGate(
        home, 'primary-abc', { worktreePath: wt, sessionId: 'sess-primary-new' }, fs, { now: Date.now() }
      );
      assert.equal(gate.archived, true);
      assert.equal(gate.migrateAsLive, true, 'a never-heartbeated but just-registered Primary must read as live, not lost');
    } finally { rm(home); }
  });

  test('resolveArchiveGate liveness table: a child with a 20-minute-old (stale) heartbeat but a real sessionId reads as live', () => {
    const home = tmpHome();
    try {
      const wt = '/wt/child20';
      const markerPath = writeArchivedMarker(home, 'child20', { worktreePath: wt, sessionId: 'sess-old' });
      const past = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(markerPath, past, past);
      writeActiveDescriptor(home, 'child20', { worktreePath: wt, sessionId: 'sess-child-live' });
      const now = Date.now();
      // 20 minutes old — past the 15-minute DEFAULT_HEARTBEAT_FRESH_MS window,
      // exactly the "mid-long-turn" shape a bare freshness check loses.
      writeHeartbeat(home, 'child20', { sessionId: 'sess-child-live', ts: now - 20 * 60 * 1000 });

      const gate = archiveGateLib.resolveArchiveGate(
        home, 'child20', { worktreePath: wt, sessionId: 'sess-child-live' }, fs, { now }
      );
      assert.equal(gate.migrateAsLive, true, 'a stale heartbeat + a real, non-dormant sessionId must still read as live');
    } finally { rm(home); }
  });

  test('resolveArchiveGate liveness table: a child with a 60-second-old (fresh) heartbeat reads as live', () => {
    const home = tmpHome();
    try {
      const wt = '/wt/child60';
      const markerPath = writeArchivedMarker(home, 'child60', { worktreePath: wt, sessionId: 'sess-old' });
      const past = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(markerPath, past, past);
      writeActiveDescriptor(home, 'child60', { worktreePath: wt, sessionId: 'sess-child-fresh' });
      const now = Date.now();
      writeHeartbeat(home, 'child60', { sessionId: 'sess-child-fresh', ts: now - 60 * 1000 });

      const gate = archiveGateLib.resolveArchiveGate(
        home, 'child60', { worktreePath: wt, sessionId: 'sess-child-fresh' }, fs, { now }
      );
      assert.equal(gate.migrateAsLive, true);
    } finally { rm(home); }
  });

  test('resolveArchiveGate liveness table: genuinely dormant (stale, no heartbeat) or unclaimed sessionId reads as NOT live -> skipped', () => {
    const home = tmpHome();
    try {
      const now = Date.now();
      const wt = '/wt/dormant';
      writeArchivedMarker(home, 'dormant1', { worktreePath: wt, sessionId: 'sess-old' }, { mtime: now - STALE_MS });
      writeActiveDescriptor(home, 'dormant1', { worktreePath: wt, sessionId: 'sess-stale' }, { mtime: now - STALE_MS });
      const gateDormant = archiveGateLib.resolveArchiveGate(
        home, 'dormant1', { worktreePath: wt, sessionId: 'sess-stale' }, fs, { now }
      );
      assert.equal(gateDormant.migrateAsLive, false, 'no heartbeat + stale descriptor mtime must not prove liveness');

      const wt2 = '/wt/unclaimed';
      writeArchivedMarker(home, 'unclaimed1', { worktreePath: wt2, sessionId: 'sess-old2' });
      writeActiveDescriptor(home, 'unclaimed1', { worktreePath: wt2, sessionId: 'unclaimed:unclaimed1' });
      const gateUnclaimed = archiveGateLib.resolveArchiveGate(
        home, 'unclaimed1', { worktreePath: wt2, sessionId: 'unclaimed:unclaimed1' }, fs, { now }
      );
      // an unclaimed: sessionId never discriminates from the marker in the
      // first place (the direct-marker identity check treats "no real sid"
      // as a match, not a reuse candidate) -> archived-marker-match, skip.
      assert.equal(gateUnclaimed.migrateAsLive, false);
    } finally { rm(home); }
  });
}

// ---- DOCTOR PARITY (item 4) ----
// healOrphanPartitions (scripts/devswarm.js) is the SAME class of bulk
// re-registration path as the migration above; it now shares resolveArchiveGate
// instead of a bare hasArchivedCounterpart(home, id) marker-only check, so it
// cannot silently re-adopt a group sibling the migration correctly refuses.
test('doctor healOrphanPartitions does not re-adopt a worktree-group sibling the migration gate skips', () => {
  const home = tmpHome();
  try {
    const ds = require('../../plugins/anti-hall/scripts/devswarm.js');
    const now = Date.now();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-heal-wt-'));
    try {
      const ctx = { home, env: {}, now };
      // Register a live-looking anchor id A at wt, then archive it — this is
      // what leaves a worktree-group marker at archived/A*.json and tombstones
      // any sibling row sharing wt in the STORE registry (retireArchivedWorktreeGroup).
      let r = ds.run(['register', 'A', '--worktree', wt, '--session', 'sess-A'], ctx);
      assert.equal(r.code, 0, JSON.stringify(r.result));
      r = ds.run(['archive', 'A'], ctx);
      assert.equal(r.code, 0, JSON.stringify(r.result));

      // Sibling B: a stale, no-heartbeat descriptor at the SAME worktree,
      // present in workspaces/ but with no registry row (the shape a store
      // message-only orphan + a live descriptor produces for
      // healOrphanPartitions' adopt path) and no marker of its own.
      writeActiveDescriptor(home, 'B', { worktreePath: wt, sessionId: 'sess-B' }, { mtime: now - STALE_MS });
      // Give B a store message so it is enumerated as an orphan id at all
      // (healOrphanPartitions iterates listWorkspaceIds(), store message rows).
      const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
      const repoKeyLib = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
      const repoKey = repoKeyLib.repoKeyForWorktree(wt, {}) || 'unresolved';
      const s = store.openStore({ home, hash: repoKey, env: {} });
      try { s.appendMessage({ workspaceId: 'B', body: 'hi', hash: 'h1', ts: now }); } finally { s.close(); }

      const out = ds.healOrphanPartitions(home, { now, repoKey, dryRun: false });
      const bDetail = (out.detail || []).find((d) => d.id === 'B');
      assert.ok(bDetail, 'B must still be visited by the heal pass');
      assert.notEqual(bDetail.action, 'adopted', 'B must NOT be silently adopted back into the registry');

      const s2 = store.openStore({ home, hash: repoKey, env: {} });
      try {
        assert.deepEqual(s2.listRegistry().filter((row) => row.id === 'B'), []);
      } finally { s2.close(); }
    } finally { fs.rmSync(wt, { recursive: true, force: true }); }
  } finally { rm(home); }
});
