'use strict';
// Regression test: devswarm.js:16039 `if (require.main === module) { main(); }`
// used to run — and main() synchronously process.exit()s — BEFORE
// `module.exports = {...}` executed. companion/lib/devswarm-orphan-policy.js's
// loadDevswarm() lazily self-requires scripts/devswarm.js; when devswarm.js is
// the CLI ENTRYPOINT (spawned directly, e.g. `node scripts/devswarm.js diagnose
// --json`), that circular require returned the still-empty `{}` exports object
// (module.exports had not been assigned yet), so makeArchivedStrandedTest's
// `usable` check failed, it failed OPEN, and an archived/no-family/unhealable
// partition stayed in `orphans[]` forever instead of being excluded from it —
// the field-reported "N orphaned partitions with unread" warning that could
// never clear for a workspace that was deliberately archived with no live
// identity-family survivor.
//
// This MUST be exercised via an actual subprocess spawn of the CLI entrypoint
// (`node scripts/devswarm.js ...`) — devswarm-orphan-policy-equivalence.test.js
// only ever drives this through `require()`, where scripts/devswarm.js is
// already fully loaded (module.exports assigned) by the time the lazy
// self-require inside loadDevswarm() runs, so that test never reproduces the
// CLI-entrypoint ordering bug.
//
// Fail-before / pass-after: on the pre-fix devswarm.js (module.exports below
// the require.main guard), the archived-no-family fixture id remains present
// in `diagnose --json`'s `orphans[]`. After the fix (module.exports moved
// above the guard), the classifier is usable and the id is excluded from
// `orphans[]` (it is provably `unhealable/archived-no-family`, not a plain
// orphan — see devswarm-orphan-policy.js and healOrphanPartitions).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const cliPath = path.join(ROOT, 'scripts', 'devswarm.js');
const storePath = path.join(ROOT, 'companion', 'lib', 'devswarm-store.js');
const repokeyPath = path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js');
if (!fs.existsSync(cliPath) || !fs.existsSync(storePath)) {
  throw new Error(
    'ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped '
    + 'tree — expected to find both:\n  ' + cliPath + '\n  ' + storePath
  );
}
const storeLib = require(storePath);
const repokey = require(repokeyPath);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-cli-entrypoint-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-cli-entrypoint-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function writeDescriptor(home, sub, id, desc) {
  const dir = path.join(home, '.anti-hall', 'devswarm', sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, desc)), 'utf8');
}

test('CLI entrypoint `diagnose --json` excludes an archived-no-family stranded partition from orphans[]', () => {
  const home = tmpHome();
  const repo = makeGitRepo();
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    // Archived, worktree gone, no live registry family anywhere -> the
    // "unhealable / archived-no-family" shape healOrphanPartitions and
    // devswarm-orphan-policy both classify as archived-stranded.
    writeDescriptor(home, 'archived', 'cli-stranded-a', { worktreePath: path.join(home, 'gone-a') });
    s.appendMessage({ workspaceId: 'cli-stranded-a', body: 'x', hash: 'cli1' });
    s.close();

    // Spawn the REAL CLI entrypoint — HOME isolated to the fixture, cwd inside
    // the fixture git repo so repoKeyForWorktree resolves to the same repoKey
    // the fixture was seeded under. Isolated HOME/USERPROFILE per repo rule.
    // ANTIHALL_DEVSWARM_STORE_BACKEND pins BOTH the fixture writer (above,
    // openStore backend:'journal') and this spawned CLI to the same backend —
    // openStore's own default picks sqlite whenever node:sqlite is available
    // (selectBackend), and cmdDiagnose's ctx.backend is undefined for a bare
    // CLI invocation, so without this override the CLI would silently read a
    // different (empty) sqlite-backed store than the one seeded here.
    const env = Object.assign({}, process.env, {
      HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal',
    });
    const r = cp.spawnSync(process.execPath, [cliPath, 'diagnose', '--json'], {
      cwd: repo, env, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, 'diagnose --json exited 0 (stderr: ' + r.stderr + ')');
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(out.ok, true, 'diagnose result ok');

    const inOrphans = (out.orphans || []).some((o) => o.id === 'cli-stranded-a');
    assert.strictEqual(inOrphans, false,
      'archived-no-family partition must NOT remain in orphans[] when devswarm.js runs as the CLI '
      + 'entrypoint (pre-fix: module.exports below the require.main guard left the circular '
      + 'self-require in loadDevswarm() with an empty {} module, failing the classifier open)');
  } finally {
    rm(repo); rm(home);
  }
});
