'use strict';
// devswarm-wake-watch — mixed-fleet false wake after a 0.115.2 -> 0.116.0
// handoff (field report: "broadcast direct total 0 -> 189 (+189)" printed
// TWICE, minutes apart, one armed watcher, `inbox tick` unread 0).
//
// Root cause: readBroadcastSnapshot fell through to the legacy hash-bucket
// summary per FIELD. Old (0.115.2) hooks rewrite the repoKey summary without
// `broadcastUnreadFromOthers`; the reader then took the legacy bucket's stale
// 0, tickInner resynced its cursor to 0, and the next new-build rewrite (189)
// re-fired — once per old/new write pair. The bucket is now chosen by ROW
// (same rule as readPrimarySnapshot) and a missing field reads as null.
//
// Also covers the seen file shared by an old-format and a new-format writer:
// the old shape must never erase keys it does not own, and interleaved
// old/new writes must never produce a wake on (re)arm.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js'));
const { tick, normalizeState, loadSeenState, saveSeenState, seenPath, attachBroadcastChannel } = W;

const ID = 'primary-mixedwriters';
const HASHES = { repoKey: 'proj-abc123', fallbackHash: 'deadbeef' };

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-mixed-')); }
function rm(h) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) {} }
function putSummary(home, hash, row) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, hash + '.json'), JSON.stringify({ generatedAt: Date.now(), workspaces: { [ID]: row } }));
}
const wakes = (res) => res.lines.filter((l) => /new mesh mail/.test(l));

// Row shapes exactly as the two builds write them.
const NEW_ROW = (n) => ({ total: 4942, unread: 0, broadcastUnread: n + 4, broadcastUnreadFromOthers: n });
const OLD_ROW = (n) => ({ total: 4942, unread: 0, broadcastUnread: n + 4 }); // 0.115.2: no FromOthers
const LEGACY_BUCKET_ROW = { total: 400, unread: 0, broadcastUnread: 0, broadcastUnreadFromOthers: 0 };

function runTicks(home, st0, rows) {
  let st = st0;
  const out = [];
  for (const row of rows) {
    putSummary(home, HASHES.repoKey, row);
    const snap = attachBroadcastChannel({ ok: true, total: 4942 }, home, HASHES, ID, { fs });
    snap.role = 'primary'; snap.id = ID;
    const res = tick(st, snap);
    st = res.state;
    out.push({ total3: snap.total3, wakes: wakes(res) });
  }
  return { st, out };
}

test('summary rewritten alternately by old and new builds -> no broadcast wake (legacy bucket never consulted while the repoKey row exists)', () => {
  const home = tmpHome();
  try {
    putSummary(home, HASHES.fallbackHash, LEGACY_BUCKET_ROW);
    const st0 = normalizeState({ lastTotal: 4942, lastTotal2: 4942, lastBroadcastUnread: 193 });
    const { out } = runTicks(home, st0, [NEW_ROW(189), OLD_ROW(189), NEW_ROW(189), OLD_ROW(189), NEW_ROW(189)]);
    for (const o of out) assert.deepStrictEqual(o.wakes, [], 'PRE-FIX BUG: old/new summary rewrites re-fired "broadcast 0 -> 189"; got ' + JSON.stringify(out));
    assert.strictEqual(out[1].total3, null, 'a repoKey row without the field must read as no-data (null), not the legacy bucket\'s 0');
  } finally { rm(home); }
});

test('mixed writers: a GENUINE new broadcast from others still wakes, exactly once', () => {
  const home = tmpHome();
  try {
    putSummary(home, HASHES.fallbackHash, LEGACY_BUCKET_ROW);
    const st0 = normalizeState({ lastTotal: 4942, lastTotal2: 4942, lastBroadcastUnread: 189, armed: true });
    const { out } = runTicks(home, st0, [NEW_ROW(189), OLD_ROW(190), NEW_ROW(190), OLD_ROW(190), NEW_ROW(190)]);
    const all = out.flatMap((o) => o.wakes);
    assert.strictEqual(all.length, 1, 'exactly one wake for one real broadcast; got ' + JSON.stringify(all));
    assert.match(all[0], /broadcast direct total 189 -> 190 \(\+1\)/);
  } finally { rm(home); }
});

test('legacy bucket is still used when the repoKey row is absent', () => {
  const home = tmpHome();
  try {
    putSummary(home, HASHES.fallbackHash, { total: 10, broadcastUnreadFromOthers: 3 });
    const snap = attachBroadcastChannel({ ok: true, total: 10 }, home, HASHES, ID, { fs });
    assert.strictEqual(snap.total3, 3);
  } finally { rm(home); }
});

test('seen file: an old-format rewrite never erases keys it does not own (merge-preserve)', () => {
  const home = tmpHome();
  try {
    const p = seenPath(home, ID);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ lastTotal: 5, lastTotal2: 5, lastBroadcastUnread: 2, meshTotal: 5, futureCursor: 42 }));
    saveSeenState(home, ID, { lastTotal: 6, lastTotal2: 6, lastBroadcastUnread: 2 }, fs, 'primary');
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(obj.futureCursor, 42, 'unknown key must survive a rewrite');
    assert.strictEqual(obj.meshTotal, 6, 'owned keys are still re-derived');
  } finally { rm(home); }
});

test('seen file: old then new format writes interleaved -> no wake on re-arm; a real new broadcast still wakes', () => {
  const home = tmpHome();
  try {
    const p = seenPath(home, ID);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const live = { ok: true, total: 4942, total3: 189, role: 'primary', id: ID };
    // 0.115.2 shape (positional only), then 0.116+ shape, then 0.115.2 again.
    const writes = [
      () => fs.writeFileSync(p, JSON.stringify({ lastTotal: 4942, lastTotal2: 4942, lastBroadcastUnread: 189 })),
      () => saveSeenState(home, ID, { lastTotal: 4942, lastTotal2: 4942, lastBroadcastUnread: 189 }, fs, 'primary'),
      () => fs.writeFileSync(p, JSON.stringify({ lastTotal: 4942, lastTotal2: 4942, lastBroadcastUnread: 189 })),
      () => saveSeenState(home, ID, { lastTotal: 4942, lastTotal2: 4942, lastBroadcastUnread: 189 }, fs, 'primary'),
      // A pre-broadcast-channel old writer (no lastBroadcastUnread at all).
      () => fs.writeFileSync(p, JSON.stringify({ lastTotal: 4942, lastTotal2: 4942 })),
    ];
    for (const w of writes) {
      w();
      const st = normalizeState(loadSeenState(home, ID, fs, 'primary'));
      const r1 = tick(st, live);
      assert.deepStrictEqual(wakes(r1), [], 'no wake on re-arm after ' + fs.readFileSync(p, 'utf8'));
      const r2 = tick(r1.state, Object.assign({}, live, { total3: 190 }));
      assert.strictEqual(wakes(r2).length, 1, 'a genuine new broadcast must still wake');
    }
  } finally { rm(home); }
});
