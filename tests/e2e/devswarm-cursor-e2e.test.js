'use strict';
// 8b211241bbe9 — END-TO-END acceptance for per-instance cursors.
//
// Two REAL `devswarm.js` child processes (separate OS processes, so separate
// instance identities derived by the shipped code path, not injected) reading
// one workspace. The acceptance criteria from the design:
//   - delivered-union == sent-union (no message is lost across the fleet)
//   - `inbox count` agrees with `read-primary` at every step, PER INSTANCE
//   - a `read-primary` count of 0 is trustworthy for that instance, which is
//     what retires the interim fleet rule ("count 0 is not proof of empty").

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const CLI = path.join(ROOT, 'scripts', 'devswarm.js');
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-e2e-cursor-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-e2e-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function backend() { return (storeLib.sqliteAvailable && storeLib.sqliteAvailable()) ? 'sqlite' : 'journal'; }

// ONE persistent OS process per logical instance, driving several CLI calls in
// sequence — the realistic shape (a harness session invoking the CLI repeatedly).
// The instance nonce is derived by the SHIPPED code from the caller's ancestor
// chain, so two such processes get genuinely distinct identities with no test
// seam, and each keeps ONE identity across all of its own calls.
function runInstance(home, repo, commands) {
  const driver = `
    const TMP_HOME = ${JSON.stringify(home)};
    const cp = require('child_process');
    const CLI = ${JSON.stringify(CLI)};
    const cmds = ${JSON.stringify(commands)};
    const out = [];
    for (const args of cmds) {
      const r = cp.spawnSync(process.execPath, [CLI].concat(args), {
        cwd: ${JSON.stringify(repo)}, encoding: 'utf8', timeout: 60000,
        // HOME/USERPROFILE are re-asserted in this literal (not merely inherited)
        // so the isolation is visible at the spawn site: a real subprocess must
        // never be able to write into the developer's own ~/.anti-hall.
        env: Object.assign({}, process.env, { HOME: TMP_HOME, USERPROFILE: TMP_HOME }),
      });
      let j = null;
      try { j = JSON.parse(r.stdout); } catch (_) { j = { __parseError: true, stdout: (r.stdout || '').slice(0, 400), stderr: (r.stderr || '').slice(0, 400) }; }
      out.push(j);
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const res = cp.spawnSync(process.execPath, ['-e', driver], {
    cwd: repo, encoding: 'utf8', timeout: 180000,
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch (_) { parsed = null; }
  assert.ok(parsed, 'instance driver must emit JSON; stderr=' + (res.stderr || '').slice(0, 400));
  return parsed;
}

function seed(home, repo, id, n) {
  const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: backend() });
  const sent = [];
  try {
    for (let i = 0; i < n; i++) {
      const f = { from: 'peer', to: id, type: 'direct', message: 'e2e-' + i, timestamp: 1700000000000 + i, urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
      sent.push('e2e-' + i);
    }
  } finally { s.close(); }
  return sent;
}

test('e2e: two REAL processes on one workspace lose no mail and each sees a truthful count', () => {
  const home = tmpHome();
  const repo = makeGitRepo('e2e');
  try {
    const id = 'primary-e2e';
    // Each process registers (declaring itself) exactly as `inbox pull` does,
    // then reads. Instance A runs register + read + re-read in ONE process.
    const regB = runInstance(home, repo, [['register', id, '--worktree', repo, '--session', 'sess-e2e']]);
    assert.notStrictEqual(regB[0] && regB[0].ok, false, 'process B registration must succeed: ' + JSON.stringify(regB[0]).slice(0, 300));

    const sent = seed(home, repo, id, 4);

    const a = runInstance(home, repo, [
      ['register', id, '--worktree', repo, '--session', 'sess-e2e'],
      ['inbox', 'read-primary', id, '--ack-as-owner'],
      ['inbox', 'read-primary', id, '--ack-as-owner'],
    ]);
    const aBodies = ((a[1] && a[1].messages) || []).map((m) => m.body).filter(Boolean);
    assert.strictEqual(((a[2] && a[2].messages) || []).length, 0,
      'A must not be re-served its own consumed rows — a count of 0 is trustworthy FOR THAT INSTANCE');

    const b = runInstance(home, repo, [['inbox', 'read-primary', id, '--ack-as-owner']]);
    const bBodies = ((b[0] && b[0].messages) || []).map((m) => m.body).filter(Boolean);

    const delivered = new Set([...aBodies, ...bBodies]);
    for (const body of sent) {
      assert.ok(delivered.has(body),
        'message ' + JSON.stringify(body) + ' reached NO instance — union delivery must be lossless. A=' + aBodies.length + ' B=' + bBodies.length);
    }
  } finally { rm(home); rm(repo); }
});

test('e2e: `inbox count` agrees with `read-primary` for the SAME process at every step', () => {
  const home = tmpHome();
  const repo = makeGitRepo('e2e-count');
  try {
    const id = 'primary-e2ec';
    const inbox = path.join(repo, 'inbox.ndjson');
    fs.writeFileSync(inbox, '');
    runInstance(home, repo, [['register', id, '--worktree', repo, '--session', 'sess-c', '--inbox', inbox]]);
    seed(home, repo, id, 3);

    const r = runInstance(home, repo, [
      ['inbox', 'count', id],
      ['inbox', 'read-primary', id, '--ack-as-owner'],
      ['inbox', 'count', id],
    ]);
    const before = r[0].unreadTotal !== undefined ? r[0].unreadTotal : r[0].unread;
    const got = ((r[1] && r[1].messages) || []).length;
    const after = r[2].unreadTotal !== undefined ? r[2].unreadTotal : r[2].unread;
    assert.strictEqual(got, before,
      'count and read-primary must agree for one process — the v0.90.1 invariant, now per instance. count=' + before + ' read=' + got);
    assert.strictEqual(after, 0, 'and count must fall to 0 once that process has consumed them');
  } finally { rm(home); rm(repo); }
});
