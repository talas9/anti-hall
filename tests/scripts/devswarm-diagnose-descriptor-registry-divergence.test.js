'use strict';
// computeDiagnosis's `rows[].sessionId` (defect 2c4ae6576fab, D10) — the field
// report: diagnose prints `sessionId: unclaimed:<id>` / `live:false` for a row
// whose real identity is already known elsewhere in the store.
//
// ROOT CAUSE (confirmed by reading promoteUnclaimedSession, scripts/devswarm.js
// ~4529-4541): promotion writes the DESCRIPTOR file first, then the REGISTRY row,
// with the registry write wrapped in a swallowing try/catch ("descriptor already
// promoted; registry retries next call"). If that registry write fails, or
// nothing ever reads/promotes that id again, the registry stays pinned at the
// `unclaimed:<id>` marker forever even though workspaces/<id>.json already holds
// the real session id. `computeDiagnosis` used to build `rows[]` from ONLY
// `s.listRegistry()` (scripts/devswarm.js's `registry` local), never consulting
// the descriptor file at all, so this row displayed the stale marker and
// `live:false` — VERIFIED reproducible below (pre-fix: sessionId stayed
// 'unclaimed:<id>', live:false, in exactly this seed).
//
// The REVERSE shape (registry already ahead of the descriptor — e.g. a fresh
// self-register that hasn't yet needed a descriptor rewrite) already read
// correctly before this fix, since the registry was read directly; that case is
// pinned here as a no-regression guard.
//
// FIX: resolve `sessionId` through the descriptor whenever the registry's own
// value is absent or still synthetic AND the descriptor holds a genuine
// (non-empty, non-tautological, non-`unclaimed:`) session id — mirroring
// `realSessionIdFrom`'s own definition of "real" (~:4508). `live` is derived from
// the RESOLVED id, not the raw registry value. When the two sources disagree,
// `descriptorSessionId` carries the raw descriptor value alongside the resolved
// `sessionId`, so a caller can see the stale side rather than have it silently
// dropped.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-diag-divg-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-diag-divg-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }

function writeDescriptor(home, id, descriptor) {
  const wsDir = path.join(liveness.devswarmRoot(home), 'workspaces');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const bctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };

  // (1) DESCRIPTOR holds a real uuid, REGISTRY still carries the `unclaimed:`
  // marker for the SAME id (the promoteUnclaimedSession registry-write-failed
  // shape). Diagnose must resolve to the real uuid, live:true (subject to
  // liveness rules — no heartbeat here, so live is derived purely from
  // isLiveSessionId/isDormantRow on the resolved id), and surface the stale
  // registry value has NOT displaced the real one.
  test(`[${B.name}] diagnose: descriptor holds a real uuid, registry still 'unclaimed:' -> resolves to the uuid, never the marker`, () => {
    const home = tmpHome();
    const main = makeGitRepo('desc-ahead-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      writeDescriptor(home, 'row-desc-ahead', { id: 'row-desc-ahead', worktreePath: wt, sessionId: 'real-uuid-desc-ahead' });
      seedB(home, repoKey, { id: 'row-desc-ahead', worktreePath: wt, sessionId: 'unclaimed:row-desc-ahead' });
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'row-desc-ahead');
      assert.ok(row, 'row present');
      assert.strictEqual(row.sessionId, 'real-uuid-desc-ahead', 'diagnose must resolve through the descriptor, never print the stale unclaimed: marker');
      assert.notStrictEqual(row.sessionId.indexOf('unclaimed:'), 0, 'resolved sessionId must never be the synthetic marker when a real id is known');
      // The two sources disagree (registry still says 'unclaimed:row-desc-ahead'),
      // so descriptorSessionId is populated with the descriptor's own raw value —
      // here that value IS the resolved sessionId, since the descriptor was the
      // side holding the real id. This just confirms the field is populated on
      // disagreement, not silently omitted.
      assert.strictEqual(row.descriptorSessionId, 'real-uuid-desc-ahead');
    } finally { rm(main); rm(home); }
  });

  // (2) REVERSE (no-regression guard): REGISTRY already holds a real uuid,
  // descriptor (present) still carries the marker. This already worked before
  // the fix (registry read directly) and must keep working; the disagreement is
  // now also surfaced via descriptorSessionId.
  test(`[${B.name}] diagnose: registry holds a real uuid, descriptor still 'unclaimed:' -> resolves to the uuid (no regression), disagreement surfaced`, () => {
    const home = tmpHome();
    const main = makeGitRepo('reg-ahead-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      writeDescriptor(home, 'row-reg-ahead', { id: 'row-reg-ahead', worktreePath: wt, sessionId: 'unclaimed:row-reg-ahead' });
      seedB(home, repoKey, { id: 'row-reg-ahead', worktreePath: wt, sessionId: 'real-uuid-reg-ahead' });
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'row-reg-ahead');
      assert.ok(row, 'row present');
      assert.strictEqual(row.sessionId, 'real-uuid-reg-ahead', 'registry-held real id must keep resolving correctly (no regression)');
      assert.strictEqual(row.descriptorSessionId, 'unclaimed:row-reg-ahead', 'the stale descriptor value is surfaced, not silently dropped');
    } finally { rm(main); rm(home); }
  });

  // (3) Both sources agree on a real uuid -> no descriptorSessionId noise.
  test(`[${B.name}] diagnose: descriptor and registry agree -> no descriptorSessionId field added`, () => {
    const home = tmpHome();
    const main = makeGitRepo('agree-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      writeDescriptor(home, 'row-agree', { id: 'row-agree', worktreePath: wt, sessionId: 'real-uuid-agree' });
      seedB(home, repoKey, { id: 'row-agree', worktreePath: wt, sessionId: 'real-uuid-agree' });
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'row-agree');
      assert.ok(row, 'row present');
      assert.strictEqual(row.sessionId, 'real-uuid-agree');
      assert.strictEqual(row.descriptorSessionId, undefined, 'no divergence, no extra field');
    } finally { rm(main); rm(home); }
  });

  // (4) No descriptor file at all (e.g. removed) -> registry value used as-is,
  // no descriptorSessionId noise from a null/missing descriptor.
  test(`[${B.name}] diagnose: no descriptor file -> registry sessionId used as-is, no descriptorSessionId noise`, () => {
    const home = tmpHome();
    const main = makeGitRepo('nodesc-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      seedB(home, repoKey, { id: 'row-nodesc', worktreePath: wt, sessionId: 'unclaimed:row-nodesc' });
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      const row = d.result.registry.find((r) => r.id === 'row-nodesc');
      assert.ok(row, 'row present');
      assert.strictEqual(row.sessionId, 'unclaimed:row-nodesc', 'no descriptor to rescue from -> registry marker stands, as before this fix');
      assert.strictEqual(row.descriptorSessionId, undefined, 'no descriptor present at all -> no descriptorSessionId noise');
    } finally { rm(main); rm(home); }
  });
}
