'use strict';
// doctor-devswarm: the DevSwarm section of `doctor.js` as a pure, testable check
// function (mirrors the flutter-debug preflight -> doctor pattern). Real temp HOME
// with fake timestamps; no real process touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'doctor-devswarm.js',
));
const { projectDirFor, writeVerdict } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function writeDescriptor(home, d) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, d.id + '.json'), JSON.stringify(Object.assign({ sessionId: UUID }, d)));
}

test('dormant: not active + no descriptors -> active:false, no results', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = D.runChecks({ home, env: {} });
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.results.length, 0);
  } finally { cleanup(); }
});

test('active via env -> runs the behavioral self-test (alive fixture = PASS)', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = D.runChecks({ home, env: { DEVSWARM_REPO_ID: 'repo-x' } });
    assert.strictEqual(r.active, true);
    assert.ok(r.results.some((x) => x.status === D.PASS), 'self-test emits a PASS');
  } finally { cleanup(); }
});

test('per-workspace readout: escalated verdict -> FAIL', () => {
  const { home, cleanup } = makeHome();
  try {
    // A real workspace descriptor + a persisted verdict.
    const worktreePath = path.join(home, 'wt', 'a');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(projectDirFor(worktreePath, home), { recursive: true });
    writeDescriptor(home, { id: 'a', worktreePath, inboxPath: path.join(worktreePath, 'i'), cursorPath: path.join(worktreePath, 'c') });
    writeVerdict('a', { status: 'escalated', lastOutboundTs: 1, staleSince: 1, recoveries: 3 }, home);

    const r = D.runChecks({ home, env: {} }); // active via descriptor presence
    assert.strictEqual(r.active, true);
    const workspaceLine = r.results.find((x) => /workspace a/.test(x.message));
    assert.ok(workspaceLine, 'a per-workspace line is present');
    assert.strictEqual(workspaceLine.status, D.FAIL, 'escalated -> FAIL');
  } finally { cleanup(); }
});

test('per-workspace readout: fresh `recovering` = WARN; STUCK `recovering` past stuckMs = FAIL', () => {
  const { home, cleanup } = makeHome();
  try {
    const now = Date.now();
    const mk = (id) => {
      const worktreePath = path.join(home, 'wt', id);
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(projectDirFor(worktreePath, home), { recursive: true });
      writeDescriptor(home, { id, worktreePath, inboxPath: path.join(worktreePath, 'i'), cursorPath: path.join(worktreePath, 'c') });
    };
    mk('fresh'); mk('stuck');
    writeVerdict('fresh', { status: 'recovering', lastOutboundTs: 1, staleSince: 1, recoveries: 1, recoveredAt: now - 60 * 1000 }, home);
    writeVerdict('stuck', { status: 'recovering', lastOutboundTs: 1, staleSince: 1, recoveries: 1, recoveredAt: now - 60 * 60 * 1000 }, home);

    const r = D.runChecks({ home, env: {}, now, stuckMs: 30 * 60 * 1000 });
    const fresh = r.results.find((x) => /workspace fresh/.test(x.message));
    const stuck = r.results.find((x) => /workspace stuck/.test(x.message));
    assert.strictEqual(fresh.status, D.WARN, 'a just-recovered workspace is a soft WARN');
    assert.strictEqual(stuck.status, D.FAIL, 'a workspace wedged in recovering past stuckMs FAILs (needs a human)');
  } finally { cleanup(); }
});
