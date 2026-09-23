'use strict';
// reader-identity — mesh redesign Phase 2 / B0. deriveReaderNonce = nearest
// harness ancestor UNCONDITIONALLY (never skipped for a differing cwd), null when
// headless. Fully injected (fake home, ppidOf, kill, ps): no real process tree read.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ri = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'reader-identity.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reader-id-'));
const sess = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sess, { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const chain = { 100: 200, 200: 300, 300: 400, 400: 500, 500: 1 };
const ppidOf = (pid) => chain[pid];
const alive = () => true;
const noPs = () => null;
function rec(pid, extra) {
  fs.writeFileSync(path.join(sess, pid + '.json'), JSON.stringify(Object.assign({ pid, sessionId: 's' + pid, startedAt: pid * 10 }, extra)));
}
function base(extra) { return Object.assign({ home, pid: 100, ppidOf, kill: alive, ps: noPs }, extra); }

test('nearest harness wins even when its cwd differs from a farther harness', () => {
  rec(300, { cwd: '/elsewhere/B' });
  rec(500, { cwd: '/caller/A' });
  assert.strictEqual(ri.deriveReaderNonce(base()), 'h:300:3000');
  const h = ri.harnessAncestor(base());
  assert.deepStrictEqual(h, { pid: 300, startMs: 3000, harness: 'claude', sessionId: 's300', cwd: '/elsewhere/B' });
});

test('a process inside the nearer harness subtree never adopts the outer harness', () => {
  assert.strictEqual(ri.deriveReaderNonce(base({ pid: 300 })), 'h:300:3000');
  assert.strictEqual(ri.deriveReaderNonce(base({ pid: 400 })), 'h:500:5000');
});

test('record whose pid field mismatches, or whose pid is dead, is not a harness', () => {
  fs.writeFileSync(path.join(sess, '200.json'), JSON.stringify({ pid: 999, sessionId: 'x', startedAt: 1 }));
  assert.strictEqual(ri.deriveReaderNonce(base()), 'h:300:3000');
  const kill = (pid) => { if (pid === 300) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } };
  assert.strictEqual(ri.deriveReaderNonce(base({ kill })), 'h:500:5000');
});

test('headless (no harness within MAX_PPID_HOPS, or no home) -> null', () => {
  const far = { 10: 11, 11: 12, 12: 13, 13: 14, 14: 15, 15: 16, 16: 300 };
  assert.strictEqual(ri.deriveReaderNonce(base({ pid: 10, ppidOf: (p) => far[p] })), null, '7 hops away is beyond the cap');
  assert.strictEqual(ri.deriveReaderNonce(base({ pid: 11, ppidOf: (p) => far[p] })), 'h:300:3000', 'exactly 6 hops is in range');
  assert.strictEqual(ri.deriveReaderNonce(base({ pid: 600, ppidOf: () => 1 })), null);
  assert.strictEqual(ri.deriveReaderNonce(base({ home: null })), null);
});
