'use strict';
// devswarm-wake-watch — missing broadcast-counter baseline false wake
// (0.116.0 field report). A watcher self-handed-off from 0.115.2 (which never
// wrote a `lastBroadcastUnread` field — the broadcast channel did not exist
// yet, see 2e34633) to 0.116.0 printed "armed" and IMMEDIATELY "new mesh mail
// ...: broadcast direct total 0 -> 189 (+189)" while `inbox tick` showed
// unread 0. Root cause: loadSeenState defaulted a MISSING lastBroadcastUnread
// key to 0 (a real observation) instead of treating "never recorded" as "no
// baseline yet" — the very first tick then diffed the live mesh broadcast
// total (189) against that fabricated 0 and fired a false wake for history
// the watcher never had a chance to see. The fix seeds the counter from its
// own first live read (a migration) instead of comparing against it, while a
// GENUINE new broadcast after that point must still wake normally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js'));
const { tick, normalizeState, loadSeenState, saveSeenState } = W;

const ID = 'primary-63f9261d';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-bcast-')); }
function rm(h) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) {} }
function seedOldFormat(home, obj) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'wake', ID + '.seen');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Deliberately OMITS lastBroadcastUnread (and meshTotal/ndjsonTotal) —
  // exactly the shape an older, pre-broadcast-channel build wrote.
  fs.writeFileSync(p, JSON.stringify(obj));
}
const wakes = (res) => res.lines.filter((l) => /new mesh mail/.test(l));

test('old-format seen-file (no lastBroadcastUnread) + existing broadcast total -> no wake on arm', () => {
  const home = tmpHome();
  try {
    // Pre-2e34633 shape: only the direct-mail counters were ever persisted.
    seedOldFormat(home, { lastTotal: 500, lastTotal2: 500 });
    const st = normalizeState(loadSeenState(home, ID, fs, 'primary'));
    // Mesh direct total unchanged (500); broadcast channel already sits at
    // 189 (pre-existing unread from before this watcher ever ran) — a fresh
    // migration, not new mail.
    const res = tick(st, { role: 'primary', id: ID, ok: true, total: 500, total3: 189, nowMs: 1 });
    assert.deepStrictEqual(wakes(res), [], 'spurious wake on migration: ' + res.lines.join(' | '));
  } finally { rm(home); }
});

test('a new broadcast after arm still wakes', () => {
  const home = tmpHome();
  try {
    seedOldFormat(home, { lastTotal: 500, lastTotal2: 500 });
    const st = normalizeState(loadSeenState(home, ID, fs, 'primary'));
    let res = tick(st, { role: 'primary', id: ID, ok: true, total: 500, total3: 189, nowMs: 1 });
    assert.deepStrictEqual(wakes(res), [], 'spurious wake on migration: ' + res.lines.join(' | '));
    saveSeenState(home, ID, res.state, fs, 'primary');

    // A genuinely new broadcast lands after arm.
    res = tick(res.state, { role: 'primary', id: ID, ok: true, total: 500, total3: 191, nowMs: 2 });
    assert.strictEqual(wakes(res).length, 1, 'expected exactly one wake: ' + res.lines.join(' | '));
    assert.match(wakes(res)[0], /broadcast direct total 189 -> 191 \(\+2\)/);
  } finally { rm(home); }
});
