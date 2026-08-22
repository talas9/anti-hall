'use strict';
// computeDiagnosis's `rows[].live` (diagnose/healthcheck DISPLAY field) — was a
// bare isLiveSessionId(sessionId) string test (non-null, non-empty, not
// `unclaimed:`-prefixed), with NO TTL/heartbeat correlation. Two field-reported
// symptoms, one cause:
//   (a) a row for a DEAD/closed workspace reads `live:true` forever — closing a
//       workspace never deletes its registry row, and a once-real sessionId was
//       trusted with no expiry.
//   (b) a row with a fresh heartbeat but no real sessionId used to read
//       `live:false` even while its process IS running.
// Fix: `live` is now wired to the EXISTING heartbeat/staleness machinery in
// companion/lib/liveness.js (hasFreshHeartbeat / isDormantRow) instead of the
// bare sessionId test. `unclaimed:`-prefixed sessionIds are not-live UNLESS a
// FRESH heartbeat proves the process is alive (a heartbeat is a stronger,
// orthogonal proof-of-life than the synthetic marker, which exists only to
// stop ROUTING into a partition nothing drains) — mirroring the null-sessionId
// rescue. With no/stale heartbeat, `unclaimed:` still reads not-live
// (the phantom-row case).
//
// SAFETY: this is a DISPLAY-ONLY derivation. Every fold/retire/tombstone
// primitive (resolveMeshTarget, pickSurvivor, groupRegistryByMeshId's
// liveRows, rehomeMiskeyedRow) reads isLiveSessionId(sessionId) DIRECTLY —
// untouched by this change — so nothing that used to require 2 live rows (or
// exclude a dead group from folding) becomes newly permissive. Tested below
// via meshTargets.liveRows/kind/split staying byte-identical to the pre-fix
// sessionId-only signal even when rows[].live disagrees.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-diag-live-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-diag-live-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

function writeHeartbeat(home, id, ts) {
  const p = liveness.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts, state_ts: ts, source: 'cli-heartbeat' }));
}

const STALE_MS = 8 * 60 * 60 * 1000; // 8h — past BOTH dormancy windows (30min tight, 6h wide fallback)

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const bctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };

  // (1) real sessionId + STALE heartbeat -> not live (symptom a: closed
  // workspace's registry row must stop reading live forever).
  test(`[${B.name}] diagnose: a real sessionId with a STALE heartbeat reads not-live`, () => {
    const home = tmpHome();
    const main = makeGitRepo('stale-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'closed-ws', worktreePath: topOf(main), sessionId: 'real-session-id' });
      writeHeartbeat(home, 'closed-ws', Date.now() - STALE_MS);
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'closed-ws');
      assert.ok(row, 'row present');
      assert.strictEqual(row.live, false, 'a real sessionId whose heartbeat has gone stale must not read live forever');
    } finally { rm(main); rm(home); }
  });

  // (2) `unclaimed:`-prefixed sessionId with a FRESH heartbeat -> rescued to
  // live (the heartbeat is a stronger, orthogonal proof-of-life than the
  // routing-only synthetic marker).
  test(`[${B.name}] diagnose: an unclaimed: sessionId with a fresh heartbeat reads live`, () => {
    const home = tmpHome();
    const main = makeGitRepo('unclaimed-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'phantom-ws', worktreePath: topOf(main), sessionId: 'unclaimed:phantom-ws' });
      writeHeartbeat(home, 'phantom-ws', Date.now()); // fresh heartbeat rescues the display field
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'phantom-ws');
      assert.ok(row, 'row present');
      assert.strictEqual(row.live, true, 'a fresh heartbeat rescues an unclaimed: row: genuinely running processes must not read live:false');
    } finally { rm(main); rm(home); }
  });

  // (2b) `unclaimed:`-prefixed sessionId with NO heartbeat at all -> still
  // not-live (the phantom-row case this marker exists to catch).
  test(`[${B.name}] diagnose: an unclaimed: sessionId with NO heartbeat reads not-live`, () => {
    const home = tmpHome();
    const main = makeGitRepo('unclaimednohb-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'phantom-ws2', worktreePath: topOf(main), sessionId: 'unclaimed:phantom-ws2' });
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'phantom-ws2');
      assert.ok(row, 'row present');
      assert.strictEqual(row.live, false, 'no heartbeat at all: unclaimed: phantom row must not read live');
    } finally { rm(main); rm(home); }
  });

  // (2c) `unclaimed:`-prefixed sessionId with a STALE heartbeat -> still
  // not-live (a stale heartbeat is not proof of current life).
  test(`[${B.name}] diagnose: an unclaimed: sessionId with a STALE heartbeat reads not-live`, () => {
    const home = tmpHome();
    const main = makeGitRepo('unclaimedstale-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'phantom-ws3', worktreePath: topOf(main), sessionId: 'unclaimed:phantom-ws3' });
      writeHeartbeat(home, 'phantom-ws3', Date.now() - STALE_MS);
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'phantom-ws3');
      assert.ok(row, 'row present');
      assert.strictEqual(row.live, false, 'stale heartbeat: unclaimed: phantom row must not read live');
    } finally { rm(main); rm(home); }
  });

  // (3) a fresh heartbeat -> live.
  test(`[${B.name}] diagnose: a fresh heartbeat reads live`, () => {
    const home = tmpHome();
    const main = makeGitRepo('fresh-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'active-ws', worktreePath: topOf(main), sessionId: 'real-session-id' });
      writeHeartbeat(home, 'active-ws', Date.now());
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'active-ws');
      assert.ok(row, 'row present');
      assert.strictEqual(row.live, true, 'a fresh heartbeat is definitive proof-of-life');
    } finally { rm(main); rm(home); }
  });

  // (4) REGRESSION: no fold/retire/tombstone-gating signal becomes newly
  // permissive. groupRegistryByMeshId's `liveRows` (which meshTargets.kind/
  // split/deadSplit and every fold primitive in scripts/devswarm.js key off)
  // reads isLiveSessionId(sessionId) DIRECTLY, untouched by this change — so a
  // 2-row group where ONE row's `rows[].live` newly flips to false (stale
  // heartbeat) must STILL be counted as `liveRows: 2` / `kind: 'live'` /
  // `split: true` for routing/fold purposes, exactly as before. This is the
  // safety gate: a display-only staleness read must never newly enable a fold
  // that used to be refused (or vice versa).
  test(`[${B.name}] SAFETY: a stale-heartbeat row still counts toward group liveRows/kind/split (fold signal unchanged)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('safety-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'live-fresh', worktreePath: mainTop, sessionId: 'sa' });
      seedB(home, repoKey, { id: 'live-stale', worktreePath: mainTop, sessionId: 'sb' });
      writeHeartbeat(home, 'live-fresh', Date.now());
      writeHeartbeat(home, 'live-stale', Date.now() - STALE_MS);

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);

      // Display-only derivation DOES distinguish them.
      const rowFresh = d.result.registry.find((r) => r.id === 'live-fresh');
      const rowStale = d.result.registry.find((r) => r.id === 'live-stale');
      assert.strictEqual(rowFresh.live, true, 'fresh-heartbeat row reads live');
      assert.strictEqual(rowStale.live, false, 'stale-heartbeat row reads not-live (display only)');

      // Fold/routing signal is UNCHANGED: both rows still count as live for
      // group classification (isLiveSessionId(sessionId) only — no heartbeat
      // read), so the group is still `liveRows: 2` / `kind: 'live'` /
      // `split: true`, exactly as the pre-fix sessionId-only rule reported.
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.ok(mt, 'meshTargets entry present');
      assert.strictEqual(mt.liveRows, 2, 'fold-facing liveRows is unaffected by the display-only staleness read');
      assert.strictEqual(mt.kind, 'live', 'fold-facing kind is unaffected — still the benign 2-live-tabs shape');
      assert.strictEqual(mt.split, true, 'fold-facing split flag is unaffected');
      assert.strictEqual(mt.deadSplit, false, 'this must NOT newly read as a dangerous deadSplit');
      assert.ok(!d.result.deadSplits.includes(mainMesh), 'deadSplits stays empty — no newly-permissive fold surface');
    } finally { rm(main); rm(home); }
  });

  // (5) FIELD SYMPTOM (b): a row with `sessionId: null` (auto-ensure/reconcile
  // path that never stamped a real session) but a FRESH heartbeat — i.e. the
  // workspace genuinely has running processes. Per the implementation
  // (devswarm.js computeDiagnosis ~5570-5584): `sid = d.sessionId || null`,
  // `synthetic = typeof sid === 'string' && sid.startsWith('unclaimed:')` ->
  // false for null (null is not a string), so the `!synthetic` branch runs
  // and `hasFreshHeartbeat` alone is definitive proof-of-life regardless of
  // sessionId. VERIFIED: this shape IS rescued -> live:true. This closes the
  // field-reported symptom for the null-sessionId case.
  test(`[${B.name}] diagnose: sessionId:null with a FRESH heartbeat reads live (field symptom b, null case)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('nullsid-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'null-sid-ws', worktreePath: topOf(main), sessionId: null });
      writeHeartbeat(home, 'null-sid-ws', Date.now());
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'null-sid-ws');
      assert.ok(row, 'row present');
      assert.strictEqual(row.live, true, 'a fresh heartbeat rescues a null-sessionId row: genuinely running processes must not read live:false');
    } finally { rm(main); rm(home); }
  });

  // (6) FIELD SYMPTOM (b), unclaimed: case. Per the fixed code path: the
  // hasFreshHeartbeat check now runs UNCONDITIONALLY (no longer gated behind
  // `if (!synthetic)`), so a `sid` that starts with SYNTHETIC_SESSION_PREFIX
  // ('unclaimed:') IS rescued by a fresh heartbeat, exactly like the null
  // case. VERIFIED: this shape reads live:true. Mirrors test (2) above.
  test(`[${B.name}] diagnose: unclaimed: sessionId with a FRESH heartbeat reads live (field symptom b, unclaimed case — FIXED)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('unclaimedfresh-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'unclaimed-fresh-ws', worktreePath: topOf(main), sessionId: 'unclaimed:unclaimed-fresh-ws' });
      writeHeartbeat(home, 'unclaimed-fresh-ws', Date.now());
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'unclaimed-fresh-ws');
      assert.ok(row, 'row present');
      assert.strictEqual(row.live, true, 'FIXED behaviour: unclaimed: IS rescued by a fresh heartbeat, so a genuinely-running auto-ensured workspace reads live:true');
    } finally { rm(main); rm(home); }
  });

  // (7) SAFETY, both new shapes: fold-facing liveRows/kind/split must stay
  // driven by isLiveSessionId(sessionId) ONLY (never by rows[].live or
  // heartbeat), mirroring test (4) above but for the null and unclaimed:
  // sessionId shapes exercised in (5)/(6).
  test(`[${B.name}] SAFETY: null-sessionId and unclaimed: rows with fresh heartbeats do not change fold-facing liveRows/kind/split`, () => {
    const home = tmpHome();
    const main = makeGitRepo('safety2-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'null-sid-2', worktreePath: mainTop, sessionId: null });
      seedB(home, repoKey, { id: 'unclaimed-2', worktreePath: mainTop, sessionId: 'unclaimed:unclaimed-2' });
      writeHeartbeat(home, 'null-sid-2', Date.now());
      writeHeartbeat(home, 'unclaimed-2', Date.now());

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);

      // Display-only field diverges as asserted in (5)/(6).
      const rowNull = d.result.registry.find((r) => r.id === 'null-sid-2');
      const rowUnclaimed = d.result.registry.find((r) => r.id === 'unclaimed-2');
      assert.strictEqual(rowNull.live, true, 'null sessionId rescued by fresh heartbeat (display-only)');
      assert.strictEqual(rowUnclaimed.live, true, 'unclaimed: also rescued by fresh heartbeat (display-only)');

      // Fold/routing signal is UNCHANGED: neither a null sessionId nor an
      // unclaimed: sessionId is ever isLiveSessionId()-true, so this group
      // still reads liveRows:0 / kind:'dead' — exactly as the pre-fix
      // sessionId-only rule would have reported, regardless of heartbeats.
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.ok(mt, 'meshTargets entry present');
      assert.strictEqual(mt.liveRows, 0, 'fold-facing liveRows ignores heartbeat entirely for these sessionId shapes');
      assert.strictEqual(mt.kind, 'dead', 'fold-facing kind is unaffected by the display-only heartbeat rescue');
      assert.strictEqual(mt.deadSplit, true, 'fold-facing deadSplit is unaffected');
      assert.ok(d.result.deadSplits.includes(mainMesh), 'deadSplits still flags this group — no newly-permissive fold surface from the display-only fix');
    } finally { rm(main); rm(home); }
  });
}
