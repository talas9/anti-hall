'use strict';
// update-ingest-heal-gate — the ingest auto-heal must be reachable in the
// steady state it exists to repair.
//
// ROOT CAUSE (v0.86). runUpdate gated healIngestDaemon on `cache.synced` alone:
//
//   const ingestHeal = cache.synced ? healIngestDaemon({...}) : {attempted:false,...}
//
// `cache.synced` is true ONLY when THIS run copied new bytes into the
// version-pinned cache. But healIngestDaemon's own header describes its purpose
// as re-baking a daemon whose baked scriptPath points at a cache dir the plugin
// manager RELOCATED — which happens with NO version bump at all. In that steady
// state the installed version already equals latest, syncCache no-ops,
// `cache.synced` is false, and classifyIngestUnit (the only thing that would
// notice the dangling scriptPath) was never reached. The heal was unreachable
// precisely when it was needed, so a stale daemon could never self-heal.
//
// THE FIX: also fire when the installed unit fails to classify 'ok' —
// `cache.synced || ingestUnitNeedsHeal(args)`.
//
// ---------------------------------------------------------------------------
// MUTATION LIST (each applied to the shipped update.js and this file re-run;
// the named test FAILED for each, so no assertion here is vacuous). Recorded in
// the test file, not only in a transcript.
//
//  N1  restore the exact pre-fix gate (`cache.synced ? ... : ...`)
//        -> KILLED by 'runUpdate: no cache sync + STALE unit -> heal STILL fires'
//  N2  gate on `cache.synced || true` (always heal)
//        -> KILLED by 'runUpdate: no cache sync + healthy unit -> heal does NOT fire'
//  N3  ingestUnitNeedsHeal: `return info.cls !== 'ok'` (treat 'absent' as broken)
//        -> KILLED by 'ingestUnitNeedsHeal: absent unit is NOT a trigger'
//  N4  ingestUnitNeedsHeal: `if (info.gated || !info.cls) return true`
//        -> KILLED by 'ingestUnitNeedsHeal: a closed gate is never a trigger'
//  N5  inspectInstalledIngest: drop the isDevswarmActive gate
//        -> KILLED by 'ingestUnitNeedsHeal: a closed gate is never a trigger'
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');
const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const REAL_PLUGIN_SRC_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const SKIP = process.platform === 'win32';

// --- fixtures --------------------------------------------------------------

// A marketplace clone whose plugins/anti-hall carries a REAL companion/ + hooks/
// (symlinked, never copied and never written through) so update.js can require
// the same install-devswarm-ingest.js / doctor-repair.js / devswarm-detect.js
// the production path does. Nothing under the real repo is mutated.
function makeMarketplace(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-healgate-'));
  const marketplaceDir = path.join(root, 'marketplaces', 'anti-hall');
  const srcDir = path.join(marketplaceDir, 'plugins', 'anti-hall');
  fs.mkdirSync(path.join(srcDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'anti-hall', version }), 'utf8');
  for (const d of ['companion', 'hooks']) {
    fs.symlinkSync(path.join(REAL_PLUGIN_SRC_DIR, d), path.join(srcDir, d), 'dir');
  }
  fs.writeFileSync(path.join(marketplaceDir, 'CHANGELOG.md'), '# Changelog\n\n## ' + version + '\n- x\n', 'utf8');
  // installed == latest, and NO cache root => syncCache no-ops => cache.synced false.
  fs.writeFileSync(path.join(root, 'installed_plugins.json'),
    JSON.stringify({ 'anti-hall@anti-hall': version }), 'utf8');
  return { root, marketplaceDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} } };
}

// Write a real ingest unit into a scratch HOME (never the developer's own).
function writeUnit(home, worktree, script) {
  if (process.platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const label = installer.labelForWorktree(worktree);
    fs.writeFileSync(path.join(dir, label + '.plist'),
      installer.buildPlist({ label, exec: process.execPath, script, log: '/tmp/x.log', workdir: worktree }));
  } else {
    const dir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const unit = installer.unitForWorktree(worktree);
    fs.writeFileSync(path.join(dir, unit + '.service'),
      installer.buildService({ exec: process.execPath, script, workdir: worktree }));
  }
}

// update.js calls exec(args, cwd) with the git argv; only `status` (clean tree)
// and `pull` (ff-only, already up to date) are consulted on this path.
const execStub = () => (args) => (args[0] === 'pull' ? 'Already up to date.\n' : '');

function withFixture(fn, { script }) {
  const V = '9.9.9';
  const t = makeMarketplace(V);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'healgate-home-'));
  try {
    const wt = process.cwd(); // a real git worktree (this repo)
    if (script) writeUnit(home, wt, script);
    const spawned = [];
    const paths = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
    const out = U.runUpdate({
      paths,
      exec: execStub(),
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: wt,
      home,
      spawnIngestInstaller: (s) => { spawned.push(s); },
    });
    return fn({ out, spawned, home, wt, paths });
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- the regression ---------------------------------------------------------

test('runUpdate: no cache sync + STALE unit -> heal STILL fires (pre-fix it was unreachable)', { skip: SKIP }, () => {
  withFixture(({ out, spawned }) => {
    assert.strictEqual(out.status.cacheSynced, false,
      'precondition: this run copied nothing — exactly the steady state the pre-fix gate excluded');
    assert.strictEqual(spawned.length, 1,
      'FAILS pre-fix: `cache.synced ? heal : skip` never ran the classifier, so a daemon ' +
      'pointed at a relocated cache dir could never self-heal without a version bump');
    assert.ok(spawned[0].endsWith('install-devswarm-ingest.js'));
  }, { script: path.join(os.tmpdir(), 'this-ingest-script-does-not-exist.js') });
});

test('runUpdate: no cache sync + healthy unit -> heal does NOT fire (the fix is not "always heal")', { skip: SKIP }, () => {
  withFixture(({ out, spawned }) => {
    assert.strictEqual(out.status.cacheSynced, false);
    assert.strictEqual(spawned.length, 0,
      'a unit that classifies ok on a no-op update must not spawn an installer every run');
    assert.match(out.status.ingestHeal ? String(out.status.ingestHeal.detail) : '', /nothing to heal/);
  }, { script: installer.SCRIPT });
});

test('runUpdate: no cache sync + NO unit installed -> heal does NOT fire (never first-installs an opt-in daemon)', { skip: SKIP }, () => {
  withFixture(({ out, spawned }) => {
    assert.strictEqual(out.status.cacheSynced, false);
    assert.strictEqual(spawned.length, 0,
      'treating `absent` as "needs heal" would install the opt-in daemon unprompted for every user');
  }, { script: null });
});

// --- the predicate itself ---------------------------------------------------

function needsHeal(home, script) {
  const wt = process.cwd();
  if (script) writeUnit(home, wt, script);
  return U.ingestUnitNeedsHeal({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: { DEVSWARM_REPO_ID: 'r1' },
    cwd: wt,
    home,
  });
}

function inScratchHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'healgate-pred-'));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('ingestUnitNeedsHeal: a stale-script unit IS a trigger', { skip: SKIP }, () => {
  inScratchHome((home) => {
    assert.strictEqual(needsHeal(home, path.join(home, 'gone.js')), true);
  });
});

test('ingestUnitNeedsHeal: a healthy unit is NOT a trigger', { skip: SKIP }, () => {
  inScratchHome((home) => {
    assert.strictEqual(needsHeal(home, installer.SCRIPT), false);
  });
});

test('ingestUnitNeedsHeal: absent unit is NOT a trigger (first-install stays the SKILL\'s explicit step)', { skip: SKIP }, () => {
  inScratchHome((home) => {
    assert.strictEqual(needsHeal(home, null), false);
  });
});

test('ingestUnitNeedsHeal: a closed gate is never a trigger', { skip: SKIP }, () => {
  inScratchHome((home) => {
    writeUnit(home, process.cwd(), path.join(home, 'gone.js')); // genuinely broken...
    // ...but not a DevSwarm session, so nothing may be spawned.
    assert.strictEqual(U.ingestUnitNeedsHeal({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR }, env: {}, cwd: process.cwd(), home,
    }), false, 'the DevSwarm gate still governs');
    // ...and a plugin tree with none of the expected files is fail-open too.
    assert.strictEqual(U.ingestUnitNeedsHeal({
      paths: { pluginSrcDir: path.join(home, 'nope') }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home,
    }), false);
  });
});

test('ingestUnitNeedsHeal is read-only: a broken unit is detected without mutating anything under HOME', { skip: SKIP }, () => {
  inScratchHome((home) => {
    const snap = () => {
      const seen = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else seen.push(p + ':' + fs.statSync(p).size);
        }
      };
      walk(home);
      return seen.sort().join('|');
    };
    writeUnit(home, process.cwd(), path.join(home, 'gone.js'));
    const before = snap();
    assert.strictEqual(needsHeal(home, null), true, 'still detects the broken unit written above');
    assert.strictEqual(snap(), before, 'the trigger check writes nothing — it only enumerates + stats');
  });
});
