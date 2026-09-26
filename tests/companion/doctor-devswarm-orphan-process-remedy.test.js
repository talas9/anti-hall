'use strict';
// Peer field report: "live session in archived workspace" — the claude
// process in an archived tab stays alive, and killing it just relaunches it
// from the pty zsh (same relaunch doctor-devswarm.js's app-DB leak check
// already documents). orphanedWorkspaceProcessCheck's report text used to
// suggest `kill <pid>` for EVERY hit, including ones in an ARCHIVED (not
// gone) workspace — the wrong remedy. It must now say the safe remedy is
// re-archiving (`hivecontrol workspace archive <full id>`) and explicitly
// warn not to kill, for archived/app-archived hits, while a 'gone' hit
// (worktree removed from under a still-registered row) keeps the plain kill
// suggestion. This only ever REPORTS; it never kills or archives anything
// itself (scanProcessCwds/staleWorkspacePaths are pure reads).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const doc = require(path.join(ROOT, 'companion', 'lib', 'doctor-devswarm.js'));

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function baseHome() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-orphan-remedy-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home, { recursive: true });
  return { base, home };
}

test('a process in an ARCHIVED (anti-hall) workspace: no kill suggestion, exact re-archive remedy + do-not-kill warning', () => {
  const { base, home } = baseHome();
  try {
    const wt = path.join(base, 'wt-arch'); fs.mkdirSync(wt, { recursive: true });
    const archDir = path.join(home, '.anti-hall', 'devswarm', 'archived');
    fs.mkdirSync(archDir, { recursive: true });
    const id = 'b3f1c2d4-1111-4000-8000-abcdef012345';
    fs.writeFileSync(path.join(archDir, id + '.json'), JSON.stringify({ id, worktreePath: wt }));

    const rows = doc.orphanedWorkspaceProcessCheck({
      home,
      env: {},
      platform: 'darwin',
      run: () => ({ status: 0, stdout: 'p4242\ncclaude\nn' + wt + '\n' }),
    });
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    const m = rows[0].message;
    assert.strictEqual(rows[0].status, 'WARN');
    assert.ok(!/`kill 4242`/.test(m), 'must NOT suggest killing the archived-workspace pid: ' + m);
    assert.ok(/do not kill it/.test(m), 'must warn not to kill: ' + m);
    assert.ok(/pty shell relaunches it/.test(m), 'must explain why: ' + m);
    assert.ok(m.includes('`hivecontrol workspace archive ' + id + '`'), 'must give the exact remedy command: ' + m);
    assert.strictEqual(rows[0].orphanedWorkspaceProcesses[0].reason, 'archived');
  } finally { rm(base); }
});

test('a process in a GONE workspace (worktree removed, descriptor still active): plain kill remedy unchanged', () => {
  const { base, home } = baseHome();
  try {
    const wt = path.join(base, 'wt-gone'); // never created on disk -> "gone"
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    const id = 'c4e2d3f5-2222-4000-8000-abcdef012345';
    fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify({ id, worktreePath: wt }));

    const rows = doc.orphanedWorkspaceProcessCheck({
      home,
      env: {},
      platform: 'darwin',
      run: () => ({ status: 0, stdout: 'p9999\ncclaude\nn' + wt + '\n' }),
    });
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    const m = rows[0].message;
    assert.ok(/safe to `kill 9999`/.test(m), 'gone workspace keeps the plain kill remedy: ' + m);
    assert.ok(!/hivecontrol workspace archive/.test(m), 'no re-archive remedy for a gone (not archived) hit: ' + m);
    assert.strictEqual(rows[0].orphanedWorkspaceProcesses[0].reason, 'gone');
  } finally { rm(base); }
});

test('no stale workspaces -> silent (no result), never kills/archives anything', () => {
  const { base, home } = baseHome();
  try {
    const rows = doc.orphanedWorkspaceProcessCheck({ home, env: {}, platform: 'darwin', run: () => ({ status: 0, stdout: '' }) });
    assert.deepStrictEqual(rows, []);
  } finally { rm(base); }
});
