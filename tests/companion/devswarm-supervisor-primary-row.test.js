'use strict';
// item F.2 (v0.107.1 field report): `register-primary` (a documented, one-time
// setup step — scripts/devswarm.js cmdRegisterPrimary) writes a REAL
// descriptor for the Primary's own `primary-<hash>` id. That id then sat in
// readDescriptors() forever alongside genuine CHILD descriptors, and was
// swept by the SAME nudge/escalate machinery. A Primary row structurally
// never has a `nudgeCommand` (there is no CLI verb to "nudge" your own
// top-level session), so pokeOrEscalate's exhaustion branch
// (lib/recovery.js) fired on the FIRST stale tick with nudgeAttempts=0 EVERY
// time — observed live as `workspace primary-<id>: escalated
// (nudgeAttempts=0)` for an actively-draining Primary. Fix: sweepOnce
// excludes a primary-id row from pokeOrEscalate entirely (it isn't a child to
// nudge/escalate at all), and doctor-devswarm.js's readout reports it via
// listener-presence only, never as FAIL, clearing a stale verdict under
// --repair.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js'));
const { primaryWorkspaceId } = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js'));
const dsd = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'doctor-devswarm.js'));
const { livenessPathFor } = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js'));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-primaryrow-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
function writeDescriptor(home, d) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  const p = path.join(dir, full.id + '.json');
  fs.writeFileSync(p, JSON.stringify(full));
  const old = (Date.now() - 60 * 60 * 1000) / 1000; // past post-spawn grace
  fs.utimesSync(p, old, old);
}
const staleVerdict = () => ({ status: 'stale', lastOutboundTs: 1, staleSince: Date.now() - 1e6, nudgeAttempts: 0 });

test('sweepOnce: a register-primary descriptor is EXCLUDED from pokeOrEscalate — never nudged, never escalated', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = '/wt/proj';
    const id = primaryWorkspaceId(worktreePath);
    writeDescriptor(home, { id, worktreePath });
    let pokeOrEscalateCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => false,
        rowLivenessState: () => 'active',
        isSessionAliveRow: () => false,
        pokeOrEscalate: () => { pokeOrEscalateCalls++; return { action: 'escalate' }; },
      },
    });
    assert.strictEqual(pokeOrEscalateCalls, 0, 'pokeOrEscalate must never be called for a primary-id row');
    assert.strictEqual(res[0].poke.reason, 'primary-row-not-nudgeable');
  } finally { cleanup(); }
});

test('sweepOnce: a genuine CHILD descriptor (not primary-shaped) is UNAFFECTED — still escalates as before', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'child-abc123', worktreePath: '/wt/child' });
    let pokeOrEscalateCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => false,
        rowLivenessState: () => 'active',
        isSessionAliveRow: () => false,
        pokeOrEscalate: () => { pokeOrEscalateCalls++; return { action: 'escalate' }; },
      },
    });
    assert.strictEqual(pokeOrEscalateCalls, 1, 'a genuine child descriptor must still reach pokeOrEscalate');
    assert.strictEqual(res[0].poke.action, 'escalate');
  } finally { cleanup(); }
});

test('doctor-devswarm runChecks: a stale ESCALATED verdict on a primary row is reported as PASS (informational), never FAIL', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const id = primaryWorkspaceId(worktreePath);
    writeDescriptor(home, { id, worktreePath });
    fs.mkdirSync(path.dirname(livenessPathFor(id, home)), { recursive: true });
    fs.writeFileSync(livenessPathFor(id, home), JSON.stringify({ status: 'escalated', nudgeAttempts: 0 }));

    const report = dsd.runChecks({ home, env: {} });
    assert.strictEqual(report.active, true);
    const primaryLine = report.results.find((r) => r.message.includes(id) && /Primary row/.test(r.message));
    assert.ok(primaryLine, 'expected an informational line for the primary row: ' + JSON.stringify(report.results));
    assert.strictEqual(primaryLine.status, dsd.PASS, 'a primary row escalated-verdict must never render as FAIL');
    assert.ok(!report.results.some((r) => r.status === dsd.FAIL && r.message.includes(id)),
      'no FAIL entry may reference the primary row id: ' + JSON.stringify(report.results));
  } finally { cleanup(); }
});

test('doctor-devswarm runChecks with repair:true clears a stale primary-row verdict file (idempotent)', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const id = primaryWorkspaceId(worktreePath);
    writeDescriptor(home, { id, worktreePath });
    const vPath = livenessPathFor(id, home);
    fs.mkdirSync(path.dirname(vPath), { recursive: true });
    fs.writeFileSync(vPath, JSON.stringify({ status: 'escalated', nudgeAttempts: 0 }));

    dsd.runChecks({ home, env: {}, repair: true });
    assert.strictEqual(fs.existsSync(vPath), false, 'the stale escalated verdict file must be cleared under repair:true');

    // Idempotent: a second repair pass with the file already gone must not throw.
    assert.doesNotThrow(() => dsd.runChecks({ home, env: {}, repair: true }));
  } finally { cleanup(); }
});

test('doctor-devswarm runChecks: a NON-escalated primary row (e.g. alive) produces no extra noise', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const id = primaryWorkspaceId(worktreePath);
    writeDescriptor(home, { id, worktreePath });
    const vPath = livenessPathFor(id, home);
    fs.mkdirSync(path.dirname(vPath), { recursive: true });
    fs.writeFileSync(vPath, JSON.stringify({ status: 'alive', nudgeAttempts: 0 }));

    const report = dsd.runChecks({ home, env: {} });
    assert.ok(!report.results.some((r) => r.message.includes(id) && /Primary row/.test(r.message)),
      'a benign alive verdict on a primary row needs no special-cased line');
  } finally { cleanup(); }
});
