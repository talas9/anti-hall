'use strict';
// #71 — read-only `healthcheck` verb: a scriptable PASS/FAIL gate over the SAME
// data `diagnose` computes (computeDiagnosis — one source, two presentations).
//
//   - healthy store          -> ok:true,  status:'ok',       exit 0
//   - orphan / split present  -> ok:false, status:'degraded', exit non-zero + counts
//   - --json vs human line    -> run() returns the object; the human line is the
//                                default (non-`--json`) main() render.
//   - purity                  -> zero writes (no summary.json mtime change).
//   - no-project cwd          -> {ok:false, reason:'no-project'}, exit 2.
//
// Exercised in-process via cli.run(argv, ctx) with an injected tmp HOME + REAL git
// worktrees as ctx.cwd (repoKeyForWorktree spawns a real git). Both backends
// (journal always; sqlite when node:sqlite is present). Mirrors
// devswarm-diagnose.test.js.

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

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-hc-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function tick() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-hc-repo-' + tag + '-'));
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

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const bctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});
  const seedReg = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };
  const seedMsg = (home, repoKey, id, body, hash) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.appendMessage({ workspaceId: id, body, hash, ts: Date.now() }); } finally { s.close(); }
  };

  // healthy store -> ok:true, status 'ok', exit 0.
  test(`[${B.name}] healthcheck healthy store -> ok:true status:ok exit 0`, () => {
    const home = tmpHome();
    const main = makeGitRepo('hc-ok-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedReg(home, repoKey, { id: 'ws-a', worktreePath: topOf(main), sessionId: 's' });
      const r = cli.run(['healthcheck', '--json'], bctx(home, { cwd: main }));
      assert.strictEqual(r.result.ok, true, 'healthy -> ok:true');
      assert.strictEqual(r.result.status, 'ok');
      assert.strictEqual(r.code, 0, 'exit 0 when healthy');
      assert.deepStrictEqual(r.result.counts, { orphans: 0, stale: 0, splits: 0, phantoms: 0, unreadTotal: 0 });
    } finally { rm(main); rm(home); }
  });

  // orphan + 2-live-row split -> degraded, exit non-zero, counts surfaced.
  test(`[${B.name}] healthcheck degraded on orphan + split -> ok:false exit non-zero`, () => {
    const home = tmpHome();
    const main = makeGitRepo('hc-deg-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      // two LIVE rows for the SAME worktree -> a split
      seedReg(home, repoKey, { id: 'live-a', worktreePath: mainTop, sessionId: 'sa' });
      seedReg(home, repoKey, { id: 'live-b', worktreePath: mainTop, sessionId: 'sb' });
      // an orphan: unread with no registry row
      seedMsg(home, repoKey, 'orphan-ws', 'stuck', 'native:orphan1');

      const r = cli.run(['healthcheck', '--json'], bctx(home, { cwd: main }));
      assert.strictEqual(r.result.ok, false, 'degraded -> ok:false');
      assert.strictEqual(r.result.status, 'degraded');
      assert.notStrictEqual(r.code, 0, 'exit non-zero when degraded');
      assert.ok(r.result.counts.orphans >= 1, 'orphan counted');
      assert.ok(r.result.counts.splits >= 1, 'split counted');
      assert.ok(r.result.detail.splits.includes(mainMesh), 'detail names the split meshId');
      assert.ok(r.result.detail.orphans.some((o) => o.id === 'orphan-ws'), 'detail lists the orphan partition');
    } finally { rm(main); rm(home); }
  });

  // phantoms / unreadTotal are reported but NEVER gate (a spawn-time placeholder is
  // benign): a single phantom (store-only, sessionId null) row stays status:'ok'.
  test(`[${B.name}] healthcheck: a lone phantom is reported but NOT degraded`, () => {
    const home = tmpHome();
    const main = makeGitRepo('hc-ph-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      // a spawn phantom: worktree row with a null sessionId, no live sibling
      seedReg(home, repoKey, { id: meshOf(main), worktreePath: topOf(main), sessionId: null });
      const r = cli.run(['healthcheck', '--json'], bctx(home, { cwd: main }));
      assert.strictEqual(r.result.counts.phantoms, 1, 'phantom counted');
      assert.strictEqual(r.result.status, 'ok', 'a phantom alone is NOT degraded');
      assert.strictEqual(r.result.ok, true);
      assert.strictEqual(r.code, 0);
    } finally { rm(main); rm(home); }
  });

  // purity: healthcheck writes nothing (no summary.json mtime change).
  test(`[${B.name}] healthcheck is pure — no summary.json mtime change`, () => {
    const home = tmpHome();
    const main = makeGitRepo('hc-pure-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedReg(home, repoKey, { id: 'ws-a', worktreePath: topOf(main), sessionId: 's' });
      const s0 = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
      try { storeLib.deriveSummary(s0, { home, env: {}, now: Date.now() }); } finally { s0.close(); }
      const sp = storeLib.summaryPathForHash(home, repoKey);
      const before = fs.statSync(sp).mtimeMs;
      tick();
      cli.run(['healthcheck', '--json'], bctx(home, { cwd: main }));
      cli.run(['healthcheck'], bctx(home, { cwd: main }));
      assert.strictEqual(fs.statSync(sp).mtimeMs, before, 'healthcheck did not touch summary.json');
    } finally { rm(main); rm(home); }
  });

  // no-project cwd -> {ok:false, reason:'no-project'}, exit 2.
  test(`[${B.name}] healthcheck on a non-project cwd -> no-project, exit 2`, () => {
    const home = tmpHome();
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-hc-nonrepo-'));
    try {
      const r = cli.run(['healthcheck', '--json'], bctx(home, { cwd: nonRepo }));
      assert.strictEqual(r.result.ok, false);
      assert.strictEqual(r.result.reason, 'no-project');
      assert.strictEqual(r.code, 2);
    } finally { rm(nonRepo); rm(home); }
  });
}

// human-line render (backend-agnostic — pure formatter).
test('healthcheckHumanLine renders one compact line for ok / degraded / no-project', () => {
  assert.strictEqual(
    cli.healthcheckHumanLine({ ok: true, status: 'ok', counts: { orphans: 0, stale: 0, splits: 0, phantoms: 0, unreadTotal: 0 } }),
    'healthcheck: ok [orphans=0 stale=0 splits=0 phantoms=0 unread=0]'
  );
  assert.strictEqual(
    cli.healthcheckHumanLine({ ok: false, status: 'degraded', counts: { orphans: 2, stale: 1, splits: 3, phantoms: 4, unreadTotal: 5 } }),
    'healthcheck: degraded [orphans=2 stale=1 splits=3 phantoms=4 unread=5]'
  );
  assert.strictEqual(
    cli.healthcheckHumanLine({ ok: false, reason: 'no-project' }),
    'healthcheck: no-project (cwd is not inside a DevSwarm project)'
  );
});

// end-to-end via the real CLI process: default = one human line; --json = JSON;
// exit code tracks health. Proves main()'s render + exit wiring, not just run().
test('healthcheck CLI process: human line by default, JSON with --json, exit codes', () => {
  const home = tmpHome();
  const main = makeGitRepo('hc-e2e');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.upsertRegistry({ id: 'ws-a', worktreePath: topOf(main), sessionId: 's' }); } finally { s.close(); }
    const script = require.resolve('../../plugins/anti-hall/scripts/devswarm.js');
    const env = Object.assign({}, process.env, { HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' });

    const human = cp.spawnSync(process.execPath, [script, 'healthcheck'], { cwd: main, env, encoding: 'utf8' });
    assert.strictEqual(human.status, 0, 'healthy exit 0');
    assert.match(human.stdout.trim(), /^healthcheck: ok \[orphans=0 /, 'default render is the human line');

    const json = cp.spawnSync(process.execPath, [script, 'healthcheck', '--json'], { cwd: main, env, encoding: 'utf8' });
    assert.strictEqual(json.status, 0);
    const parsed = JSON.parse(json.stdout.trim());
    assert.strictEqual(parsed.action, 'healthcheck');
    assert.strictEqual(parsed.status, 'ok');
  } finally { rm(main); rm(home); }
});
