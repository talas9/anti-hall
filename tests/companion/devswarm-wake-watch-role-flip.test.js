'use strict';
// devswarm-wake-watch — re-arm false wake when ONE id is watched under BOTH
// roles. A Primary whose own descriptor (workspaces/primary-<hash>.json) sits
// at the main worktree resolves as `child` when armed from the worktree root
// (descriptor cwd match) and as `primary` when armed from a subdirectory (no
// match -> Primary default). Both roles share one seen file
// (wake/<id>.seen), but `lastTotal` meant a DIFFERENT counter per role:
//   child   -> lastTotal = NDJSON inbox line count, lastTotal2 = mesh summary total
//   primary -> lastTotal = mesh summary total
// Field report: a child-mode watcher left {lastTotal: 4691 (stale), lastTotal2:
// 4883}; the next primary-mode re-arm compared summary total 4883 against
// lastTotal 4691 and fired "direct total 4691 -> 4883 (+192)" while the tick
// said unread 0. The fix keys the persisted cursor by COUNTER (meshTotal /
// ndjsonTotal), not by role-dependent field position.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js'));
const { tick, normalizeState, loadSeenState, saveSeenState } = W;

const ID = 'primary-0a1b2c3d';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-roleflip-')); }
function rm(h) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) {} }
function seedLegacy(home, obj) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'wake', ID + '.seen');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}
// One re-arm exactly as main() does it: load with role, then first tick.
function rearm(home, role, snap) {
  const st = normalizeState(loadSeenState(home, ID, fs, role));
  const s = Object.assign({ role, id: ID, nowMs: 1 }, snap);
  return tick(st, s);
}
const wakes = (res) => res.lines.filter((l) => /new mesh mail/.test(l));

test('field repro: legacy seen file left by child-mode watchers -> primary re-arm does NOT wake', () => {
  const home = tmpHome();
  try {
    // Exact field shape: lastTotal stale at 4691, mesh summary cursor at 4883.
    seedLegacy(home, { lastTotal: 4691, lastTotal2: 4883, lastBroadcastUnread: 189 });
    const res = rearm(home, 'primary', { ok: true, total: 4883 });
    assert.deepStrictEqual(wakes(res), [], 'spurious wake: ' + res.lines.join(' | '));
  } finally { rm(home); }
});

test('Primary aliased as child then re-armed as primary (canonical save path) -> no wake', () => {
  const home = tmpHome();
  try {
    // child-mode session: NDJSON empty (0), summary grows 4691 -> 4883.
    let st = normalizeState(loadSeenState(home, ID, fs, 'child'));
    st = tick(st, { role: 'child', id: ID, ok: true, total: 0, total2: 4691 }).state;
    st = tick(st, { role: 'child', id: ID, ok: true, total: 0, total2: 4883 }).state;
    saveSeenState(home, ID, st, fs, 'child');
    const res = rearm(home, 'primary', { ok: true, total: 4883 });
    assert.deepStrictEqual(wakes(res), [], 'spurious wake: ' + res.lines.join(' | '));
  } finally { rm(home); }
});

test('primary re-arm after flip: a genuinely NEW direct message still wakes', () => {
  const home = tmpHome();
  try {
    seedLegacy(home, { lastTotal: 4691, lastTotal2: 4883, lastBroadcastUnread: 0 });
    let r = rearm(home, 'primary', { ok: true, total: 4883 });
    assert.deepStrictEqual(wakes(r), []);
    r = tick(r.state, { role: 'primary', id: ID, ok: true, total: 4884, nowMs: 2 });
    assert.strictEqual(wakes(r).length, 1);
    assert.match(wakes(r)[0], /direct total 4883 -> 4884 \(\+1\)/);
  } finally { rm(home); }
});

test('child-mode parity: primary-mode history then child re-arm -> no wake; new mail on either channel wakes', () => {
  const home = tmpHome();
  try {
    let st = normalizeState(loadSeenState(home, ID, fs, 'primary'));
    st = tick(st, { role: 'primary', id: ID, ok: true, total: 4883 }).state;
    saveSeenState(home, ID, st, fs, 'primary');

    let r = rearm(home, 'child', { ok: true, total: 0, total2: 4883 });
    assert.deepStrictEqual(wakes(r), [], 'spurious wake: ' + r.lines.join(' | '));
    r = tick(r.state, { role: 'child', id: ID, ok: true, total: 0, total2: 4884, nowMs: 2 });
    assert.strictEqual(wakes(r).length, 1);
    assert.match(wakes(r)[0], /mesh-direct/);
    r = tick(r.state, { role: 'child', id: ID, ok: true, total: 1, total2: 4884, nowMs: 3 });
    assert.strictEqual(wakes(r).length, 1);
    assert.match(wakes(r)[0], /ndjson/);
  } finally { rm(home); }
});

test('round trip each role keeps its own counters across a flip and back', () => {
  const home = tmpHome();
  try {
    // child: ndjson 7, mesh 50
    let st = normalizeState(loadSeenState(home, ID, fs, 'child'));
    st = tick(st, { role: 'child', id: ID, ok: true, total: 7, total2: 50 }).state;
    saveSeenState(home, ID, st, fs, 'child');
    // primary sees mesh 60 (10 genuinely new since the child last looked) -> wakes once
    let r = rearm(home, 'primary', { ok: true, total: 60 });
    assert.strictEqual(wakes(r).length, 1);
    assert.match(wakes(r)[0], /direct total 50 -> 60/);
    saveSeenState(home, ID, r.state, fs, 'primary');
    // back to child: ndjson cursor 7 preserved, mesh cursor 60 -> no wake
    r = rearm(home, 'child', { ok: true, total: 7, total2: 60 });
    assert.deepStrictEqual(wakes(r), [], 'spurious wake: ' + r.lines.join(' | '));
  } finally { rm(home); }
});

test('role-less load/save keeps the legacy shape (older callers unaffected)', () => {
  const home = tmpHome();
  try {
    seedLegacy(home, { lastTotal: 3, lastTotal2: 9, lastBroadcastUnread: 1 });
    assert.deepStrictEqual(loadSeenState(home, ID, fs), { lastTotal: 3, lastTotal2: 9, lastBroadcastUnread: 1 });
  } finally { rm(home); }
});
