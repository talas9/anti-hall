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

test('per-workspace readout: `nudged` verdict -> WARN (soft — no more stuck-timer escalation)', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt', 'n');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(projectDirFor(worktreePath, home), { recursive: true });
    writeDescriptor(home, { id: 'n', worktreePath, inboxPath: path.join(worktreePath, 'i'), cursorPath: path.join(worktreePath, 'c') });
    writeVerdict('n', { status: 'nudged', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 1, nudgedAt: Date.now() }, home);

    const r = D.runChecks({ home, env: {} });
    const line = r.results.find((x) => /workspace n:/.test(x.message));
    assert.ok(line, 'a per-workspace line is present');
    assert.strictEqual(line.status, D.WARN, 'nudged -> WARN');
    assert.ok(/nudgeAttempts=1/.test(line.message));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// wake-monitor (Monitor-based idle-wake) — shipped / proven / live report.
// wakeMonitorShipped/wakeMonitorSelfTest/wakeMonitorLiveCheck are exercised
// directly (unit-level, injectable pluginRoot) as well as through the full
// runChecks() wiring (proving doctor.js's existing §6b loop renders them
// automatically — no doctor.js change needed since it just iterates
// report.results with the same PASS/WARN/FAIL constants).
// ---------------------------------------------------------------------------
const REAL_PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const wakeWatch = require(path.join(REAL_PLUGIN_ROOT, 'companion', 'lib', 'devswarm-wake-watch.js'));

test('wakeMonitorShipped: the REAL plugin tree reports shipped:true (watcher present + devswarm-wake.js emits Monitor text)', () => {
  const r = D.wakeMonitorShipped(REAL_PLUGIN_ROOT);
  assert.strictEqual(r.shipped, true);
  assert.ok(r.watcherPath.endsWith(path.join('companion', 'lib', 'devswarm-wake-watch.js')));
  assert.ok(r.watcherMod && typeof r.watcherMod.tick === 'function');
});

test('wakeMonitorShipped: an empty plugin tree (no watcher script at all) -> shipped:false, never throws', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-empty-'));
  try {
    const r = D.wakeMonitorShipped(emptyRoot);
    assert.strictEqual(r.shipped, false);
    assert.match(r.reason, /missing/);
  } finally { try { fs.rmSync(emptyRoot, { recursive: true, force: true }); } catch (_) {} }
});

test('wakeMonitorShipped: watcher present (with its real sibling deps) but devswarm-wake.js missing -> shipped:false (the two halves are checked together)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-halfship-'));
  try {
    // Copy the REAL companion/ tree (so devswarm-wake-watch.js's own sibling
    // requires — devswarm-repokey.js, devswarm-store.js, liveness.js, etc. —
    // all resolve) AND hooks/lib/ (the watcher also reaches into
    // hooks/lib/devswarm-role.js) but deliberately DELETE hooks/lib/
    // devswarm-wake.js itself, so this fixture proves the "both halves
    // present" requirement, not just "watcher script parses".
    fs.cpSync(path.join(REAL_PLUGIN_ROOT, 'companion'), path.join(root, 'companion'), { recursive: true });
    fs.cpSync(path.join(REAL_PLUGIN_ROOT, 'hooks'), path.join(root, 'hooks'), { recursive: true });
    fs.rmSync(path.join(root, 'hooks', 'lib', 'devswarm-wake.js'));
    const r = D.wakeMonitorShipped(root);
    assert.strictEqual(r.shipped, false);
    assert.match(r.reason, /devswarm-wake\.js missing/);
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
});

test('wakeMonitorSelfTest: the PURE tick() core proves silent-then-emits (both PASS on the real watcher module)', () => {
  const shipped = D.wakeMonitorShipped(REAL_PLUGIN_ROOT);
  assert.strictEqual(shipped.shipped, true);
  const out = D.wakeMonitorSelfTest(shipped.watcherMod);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].status, D.PASS, 'no-change snapshot must stay silent: ' + out[0].message);
  assert.match(out[0].message, /stayed silent/);
  assert.strictEqual(out[1].status, D.PASS, 'new-total snapshot must emit: ' + out[1].message);
  assert.match(out[1].message, /emitted a wake line/);
});

test('wakeMonitorSelfTest: a broken tick() (throws) -> WARN, fail-open, never throws out of the self-test', () => {
  const brokenMod = {
    tick: () => { throw new Error('tick boom'); },
    normalizeState: (s) => (s && typeof s === 'object' ? s : {}),
  };
  const out = D.wakeMonitorSelfTest(brokenMod);
  assert.ok(out.length >= 1);
  assert.strictEqual(out[0].status, D.WARN);
  assert.match(out[0].message, /raised \(fail-open\)/);
});

test('wakeMonitorLiveCheck: no identity resolvable for cwd -> WARN, live-check skipped, manual arm command surfaced', () => {
  const shipped = D.wakeMonitorShipped(REAL_PLUGIN_ROOT);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-nolock-'));
  const notAGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-notgit-'));
  try {
    const r = D.wakeMonitorLiveCheck(shipped.watcherMod, shipped.watcherPath, home, {}, notAGitDir);
    assert.strictEqual(r.status, D.WARN);
    assert.match(r.message, /could not resolve a DevSwarm identity|live-check skipped/);
    assert.match(r.message, /Monitor.*tool/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(notAGitDir, { recursive: true, force: true });
  }
});

test('wakeMonitorLiveCheck: a lock held by a genuinely dead pid -> WARN not live, never mutates/deletes the stale lock', () => {
  const shipped = D.wakeMonitorShipped(REAL_PLUGIN_ROOT);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-deadlock-'));
  try {
    const identity = wakeWatch.resolveIdentity({}, process.cwd(), {});
    assert.ok(identity, 'sanity: identity must resolve for this real repo cwd');
    const lockPath = wakeWatch.lockPathFor(home, identity.id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now(), token: 'x' }));

    const r = D.wakeMonitorLiveCheck(shipped.watcherMod, shipped.watcherPath, home, {}, process.cwd());
    assert.strictEqual(r.status, D.WARN);
    assert.match(r.message, /NOT live/);
    assert.ok(fs.existsSync(lockPath), 'read-only: a dead-holder lock must never be deleted by this reporter');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('wakeMonitorLiveCheck: a lock held by THIS live process -> PASS live', () => {
  const shipped = D.wakeMonitorShipped(REAL_PLUGIN_ROOT);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-livelock-'));
  try {
    const identity = wakeWatch.resolveIdentity({}, process.cwd(), {});
    assert.ok(identity);
    const lockPath = wakeWatch.lockPathFor(home, identity.id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'x' }));

    const r = D.wakeMonitorLiveCheck(shipped.watcherMod, shipped.watcherPath, home, {}, process.cwd());
    assert.strictEqual(r.status, D.PASS);
    assert.match(r.message, /LIVE/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('runChecks: wake-monitor entries are present + rendered automatically when the DevSwarm gate is active', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = D.runChecks({ home, env: { DEVSWARM_REPO_ID: 'repo-x' }, cwd: process.cwd() });
    assert.strictEqual(r.active, true);
    const shippedLine = r.results.find((x) => /^wake-monitor: shipped/.test(x.message));
    assert.ok(shippedLine, 'a wake-monitor shipped line is present in runChecks() results');
    assert.strictEqual(shippedLine.status, D.PASS);
    const selfTestLines = r.results.filter((x) => /wake-monitor self-test:/.test(x.message));
    assert.strictEqual(selfTestLines.length, 2, 'both self-test assertions are present');
  } finally { cleanup(); }
});

test('runChecks: dormant (not active) -> wake-monitor produces zero results, same gate as the rest of the section', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = D.runChecks({ home, env: {} });
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.results.length, 0);
  } finally { cleanup(); }
});
