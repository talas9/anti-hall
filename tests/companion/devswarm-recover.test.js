'use strict';
// devswarm-recover: the ON-DEMAND CLI — the ONLY kill path in DevSwarm. Given a
// single workspace id, resolves ONE target (allowInteractive:true, so an
// operator's own interactive session is a valid candidate too) via the SAME
// exactly-one-or-abstain confirm-gate real sweeps use, then recovers it.
// findTarget/recover are injected for the unit-level tests; the end-to-end tests
// use the REAL target-session + recovery modules with injected process runners
// so no real process is ever touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-recover.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-devswarm-recover-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function writeDescriptor(home, id, extra) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  const d = Object.assign({ id, worktreePath: '/wt/' + id, sessionId: UUID, inboxPath: '/i', cursorPath: '/c' }, extra || {});
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(d));
  return d;
}

test('run: unknown workspace id -> ok:false, never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = M.run(['does-not-exist'], { home });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  } finally { cleanup(); }
});

test('run: missing or unsafe workspace id argv -> ok:false (no path traversal)', () => {
  const { home, cleanup } = makeHome();
  try {
    assert.strictEqual(M.run([], { home }).ok, false);
    assert.strictEqual(M.run(['../../etc'], { home }).ok, false);
  } finally { cleanup(); }
});

test('run: malformed descriptor (missing worktreePath/sessionId) -> ok:false', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'bad' }));
    assert.strictEqual(M.run(['bad'], { home }).ok, false);
  } finally { cleanup(); }
});

test('run: findTarget is called with allowInteractive:true so a lone interactive session is a valid target', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, 'w1');
    let seenOpts;
    const r = M.run(['w1'], {
      home,
      findTarget: (o) => { seenOpts = o; return { pid: 42, uuid: UUID, worktreePath: o.worktreePath }; },
      recover: () => ({ action: 'resumed', recoveries: 1 }),
    });
    assert.strictEqual(seenOpts.allowInteractive, true);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.action, 'resumed');
  } finally { cleanup(); }
});

test('run: recover() is invoked with allowInteractive:true (matches the interactive findTarget call)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, 'w2');
    let seenAllowInteractive;
    M.run(['w2'], {
      home,
      findTarget: () => ({ pid: 1, uuid: UUID, worktreePath: '/wt/w2' }),
      recover: (o) => { seenAllowInteractive = o.allowInteractive; return { action: 'resumed' }; },
    });
    assert.strictEqual(seenAllowInteractive, true);
  } finally { cleanup(); }
});

test('run: an ambiguous target -> the REAL recover() abstains end to end (never a kill)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, 'w3');
    const { recover } = require(path.join(
      __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'recovery.js',
    ));
    const r = M.run(['w3'], {
      home,
      findTarget: () => ({ ambiguous: true, reason: 'multiple-candidates', candidates: [] }),
      recover, // the REAL recover(): must itself abstain on an ambiguous target
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.action, 'abstain');
  } finally { cleanup(); }
});

test('resolveCliThresholds: byte-for-byte defaults; env overrides maxRecoveries/graceMs, decoupled from the sweep', () => {
  assert.deepStrictEqual(M.resolveCliThresholds({}), { maxRecoveries: 3, graceMs: 5000 });
  assert.strictEqual(M.resolveCliThresholds({ ANTIHALL_DEVSWARM_MAX_RECOVERIES: '5' }).maxRecoveries, 5);
  assert.strictEqual(M.resolveCliThresholds({ ANTIHALL_DEVSWARM_GRACE_SEC: '10' }).graceMs, 10000);
});

test('end-to-end: a lone INTERACTIVE claude session is confirmed + killed (its group too) via the CLI', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const inboxPath = path.join(worktreePath, 'inbox.ndjson');
    const cursorPath = path.join(worktreePath, 'cursor');
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 'go' }) + '\n');
    fs.writeFileSync(cursorPath, '0');
    writeDescriptor(home, 'w4', { worktreePath, inboxPath, cursorPath });

    const { projectDirFor, verifyTarget } = require(path.join(
      __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'target-session.js',
    ));
    const projectDir = projectDirFor(worktreePath, home);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, UUID + '.jsonl'), '{}\n');

    const targetRunners = {
      ps: () => '500 1 claude --resume ' + UUID + '\n', // interactive: no -p
      cwdOf: (pid) => (pid === 500 ? worktreePath : null),
      transcriptExists: (dir, uuid) => dir === projectDir && uuid === UUID,
    };
    const killed = [];
    const io = {
      platform: 'darwin', selfPid: 999999, sleep: () => {},
      kill: (pid, sig) => { killed.push([pid, sig]); return sig === 0 ? false : true; },
      killGroup: (pid, sig) => { killed.push(['group', pid, sig]); return true; },
      spawnResume: () => ({ output: 'ok' }),
      // Real TOCTOU reconfirm, using the SAME injected runners + allowInteractive
      // the original findTarget call used — proves the threading end to end.
      reconfirm: (t) => verifyTarget({
        worktreePath, sessionId: UUID, pid: t.pid, uuid: t.uuid, selfPid: 999999,
        runners: targetRunners, allowInteractive: true, home,
      }),
    };

    const r = M.run(['w4'], { home, targetRunners, io, selfPid: 999999 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.action, 'resumed');
    assert.ok(killed.some((k) => k[0] === 500), 'the interactive pid was signaled');
    assert.ok(killed.some((k) => k[0] === 'group'), 'its process group was also signaled');
  } finally { cleanup(); }
});

test('end-to-end: an AMBIGUOUS target (2 candidates) -> abstain, never a kill, even with allowInteractive', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const inboxPath = path.join(worktreePath, 'inbox.ndjson');
    const cursorPath = path.join(worktreePath, 'cursor');
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 'go' }) + '\n');
    fs.writeFileSync(cursorPath, '0');
    writeDescriptor(home, 'w5', { worktreePath, inboxPath, cursorPath });

    const { projectDirFor } = require(path.join(
      __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'target-session.js',
    ));
    const projectDir = projectDirFor(worktreePath, home);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, UUID + '.jsonl'), '{}\n');

    const targetRunners = {
      ps: () => '500 1 claude --resume ' + UUID + '\n600 1 claude -p --resume ' + UUID + '\n',
      cwdOf: () => worktreePath,
      transcriptExists: () => true,
    };
    const killed = [];
    const io = { platform: 'darwin', selfPid: 999999, kill: (...a) => killed.push(a), killGroup: (...a) => killed.push(a) };

    const r = M.run(['w5'], { home, targetRunners, io, selfPid: 999999 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.action, 'abstain');
    assert.strictEqual(killed.length, 0);
  } finally { cleanup(); }
});
