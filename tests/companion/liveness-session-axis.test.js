'use strict';
// Wave D item 1 (defect 699a236129c5, P1) — SESSION-SOURCED LIVENESS AXIS.
//
// A live-but-idle interactive Primary reads `dormant` on every timestamp axis
// (heartbeat, transcript mtime, lastOutbound) because all of them are activity
// signals and an interactive session sitting at its prompt produces none. The
// discriminator is the harness's own <home>/.claude/sessions/<pid>.json record
// plus `process.kill(pid, 0)` on the pid it names — MEASURED, not inferred: a
// 95-minute-old session file on this machine named a pid that was still alive,
// so the FILE MTIME is explicitly not the signal and is never read here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVENESS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js');
const liveness = require(LIVENESS);

function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sessaxis-'));
  fs.mkdirSync(path.join(d, '.anti-hall', 'devswarm'), { recursive: true });
  return d;
}
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

// writeSessionFile — the EXACT shape measured on this machine.
function writeSessionFile(home, pid, sessionId, extra) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid) + '.json'), JSON.stringify(Object.assign({
    pid, sessionId, cwd: '/tmp/x', status: 'shell', kind: 'interactive',
  }, extra || {})));
  // The sibling `<pid>.<hash>.key` file the harness also writes — present so the
  // reader is proven to skip non-.json entries rather than choke on them.
  fs.writeFileSync(path.join(dir, String(pid) + '.deadbeef.key'), 'not json');
}

// A row that every timestamp axis will call dormant: no heartbeat file, no
// transcript, no lastOutbound, and no descriptor registration timestamp.
const DORMANT_ROW = { id: 'ws-idle', worktreePath: '/tmp/nonexistent-worktree', sessionId: 'sess-A' };
const OPTS_BASE = { now: Date.now(), lastOutboundTs: Date.now() - (48 * 60 * 60 * 1000) };

test('item 1: a row whose session file names a LIVE pid is idle-alive, never dormant', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 4242, 'sess-A');
    const opts = Object.assign({}, OPTS_BASE, { kill: (pid, sig) => { assert.strictEqual(sig, 0); assert.strictEqual(pid, 4242); /* alive */ } });
    assert.strictEqual(liveness.sessionPidAlive('sess-A', home, opts), true);
    assert.strictEqual(liveness.isSessionAliveRow(DORMANT_ROW, home, opts), true);
    // The timestamp rule ALONE still says dormant — proving the new axis is what
    // flips the verdict, not a change to the underlying activity computation.
    assert.strictEqual(liveness.isDormantByActivity(DORMANT_ROW, home, opts), true);
    assert.strictEqual(liveness.isDormantRow(DORMANT_ROW, home, opts), false);
    assert.strictEqual(liveness.rowLivenessState(DORMANT_ROW, home, opts), 'idle-alive');
  } finally { rm(home); }
});

test('item 1: a row whose session file names a DEAD pid stays dormant', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 4243, 'sess-A');
    const dead = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
    const opts = Object.assign({}, OPTS_BASE, { kill: dead });
    assert.strictEqual(liveness.sessionPidAlive('sess-A', home, opts), false);
    assert.strictEqual(liveness.isDormantRow(DORMANT_ROW, home, opts), true);
    assert.strictEqual(liveness.rowLivenessState(DORMANT_ROW, home, opts), 'dormant');
  } finally { rm(home); }
});

test("item 1: no session file at all keeps today's rule verbatim (fail-soft)", () => {
  const home = tmpHome();
  try {
    // No .claude/sessions directory whatsoever.
    const opts = Object.assign({}, OPTS_BASE, { kill: () => { throw new Error('kill must not be reached'); } });
    assert.strictEqual(liveness.sessionPidAlive('sess-A', home, opts), null);
    assert.strictEqual(liveness.isDormantRow(DORMANT_ROW, home, opts),
      liveness.isDormantByActivity(DORMANT_ROW, home, opts));
    assert.strictEqual(liveness.rowLivenessState(DORMANT_ROW, home, opts), 'dormant');
  } finally { rm(home); }
});

test('item 1: a session file for a DIFFERENT sessionId gives no opinion', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 4244, 'some-other-session');
    const opts = Object.assign({}, OPTS_BASE, { kill: () => {} });
    assert.strictEqual(liveness.sessionPidAlive('sess-A', home, opts), null);
    assert.strictEqual(liveness.isDormantRow(DORMANT_ROW, home, opts), true);
  } finally { rm(home); }
});

test('item 1: EPERM means the process EXISTS (owned by another user) — alive, not dead', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 4245, 'sess-A');
    const eperm = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
    assert.strictEqual(liveness.sessionPidAlive('sess-A', home, { kill: eperm }), true);
  } finally { rm(home); }
});

test('item 1: an unparseable session record and a non-numeric pid never throw', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), '{not json');
    fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: 'abc', sessionId: 'sess-A' }));
    assert.strictEqual(liveness.sessionPidAlive('sess-A', home, { kill: () => {} }), null);
  } finally { rm(home); }
});

test('item 1: an ACTIVE row is reported active, and the session axis is not even consulted', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 4246, 'sess-A');
    // A fresh heartbeat makes the timestamp rule say "not dormant" on its own.
    const now = Date.now();
    const opts = { now, heartbeatTs: now - 1000, kill: () => { throw new Error('must not probe a non-dormant row'); } };
    assert.strictEqual(liveness.isDormantByActivity(DORMANT_ROW, home, opts), false);
    assert.strictEqual(liveness.rowLivenessState(DORMANT_ROW, home, opts), 'active');
  } finally { rm(home); }
});

test('MUTATION: dropping the kill(pid,0) probe (treating a session file as proof) breaks the dead-pid case', () => {
  // The probe is the whole discriminator. A "fix" that trusted the mere EXISTENCE
  // of a session record would call a dead session idle-alive — the exact failure
  // mode that made file mtime unusable. Simulated by a kill that never signals
  // death: the dead-pid expectation below must then fail.
  const home = tmpHome();
  try {
    writeSessionFile(home, 4247, 'sess-A');
    const alwaysAlive = () => {}; // stands in for "no probe at all"
    assert.strictEqual(liveness.sessionPidAlive('sess-A', home, { kill: alwaysAlive }), true);
    assert.notStrictEqual(
      liveness.sessionPidAlive('sess-A', home, { kill: alwaysAlive }),
      liveness.sessionPidAlive('sess-A', home, { kill: () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; } }),
      'the probe MUST be what separates a live pid from a dead one'
    );
  } finally { rm(home); }
});

test('MUTATION: the axis is one-directional — it can never CREATE dormancy', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 4248, 'sess-A');
    const now = Date.now();
    const dead = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };
    // Row is active by timestamp; a dead pid must not drag it to dormant.
    const opts = { now, heartbeatTs: now - 1000, kill: dead };
    assert.strictEqual(liveness.isDormantRow(DORMANT_ROW, home, opts), false);
    assert.strictEqual(liveness.rowLivenessState(DORMANT_ROW, home, opts), 'active');
  } finally { rm(home); }
});
