'use strict';
// devswarm-pull — the child-side reception drain (v0.54.2). Unit-tests the bounded,
// guard-safe one-shot pull WITHOUT spawning real hivecontrol: the count-gate, the
// at-most-one bounded read-messages (never monitor), the atomic idempotent NDJSON
// append, the per-id lock, and the crash-window ordering. Every hivecontrol spawn is
// injected via io.run; io.fs is injected to prove a thrown append surfaces ok:false.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pull = require('../../plugins/anti-hall/companion/lib/devswarm-pull.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const { readUnread } = require('../../plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js');
const { testHook } = require('../helpers/spawn-hook.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-pull-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function dsw(home) { return path.join(home, '.anti-hall', 'devswarm'); }

// seedDescriptor(home, id) — write the child's own descriptor (workspaces/<id>.json)
// pointing at an inbox+cursor under the devswarm root, cursor initialized to 0.
function seedDescriptor(home, id) {
  const root = dsw(home);
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursors', id + '.cursor');
  const wdir = path.join(root, 'workspaces');
  fs.mkdirSync(wdir, { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, '0');
  fs.writeFileSync(path.join(wdir, id + '.json'),
    JSON.stringify({ id, worktreePath: '/wt/' + id, sessionId: 's-' + id, inboxPath, cursorPath }));
  return { inboxPath, cursorPath };
}

// makeRun({ count, batch }) -> { run, calls }. An injectable hivecontrol runner that
// records every spec it was called with, so a test can assert read-messages was (or
// was NOT) invoked, that monitor is NEVER used, and that read-messages carries a
// finite timeout.
function makeRun(spec) {
  const calls = [];
  function run(s) {
    calls.push(s);
    const args = (s && s.args) || [];
    const sub = args[1];
    if (sub === 'message-count') return { ok: true, raw: String(spec.count), error: null };
    if (sub === 'read-messages') return { ok: true, raw: spec.batch, error: null };
    return { ok: false, raw: '', error: 'unexpected subcommand ' + sub };
  }
  return { run, calls };
}

const TWO = JSON.stringify([
  { fromBranch: 'parent', message: 'rebase now', createdAt: '2026-01-01T00:00:00Z', status: 'unread' },
  { fromBranch: 'parent', message: 'status?', createdAt: '2026-01-01T00:00:01Z', status: 'unread' },
]);

test('count-gate: message-count===0 -> read-messages is NEVER called, imported 0', () => {
  const home = tmpHome();
  try {
    seedDescriptor(home, 'child-1');
    const R = makeRun({ count: 0, batch: TWO });
    const res = pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run } });
    assert.deepEqual(res, { ok: true, locked: true, imported: 0, duplicate: 0, nativeCount: 0 });
    const subs = R.calls.map((c) => c.args[1]);
    assert.deepEqual(subs, ['message-count'], 'only message-count ran; read-messages must be gated off');
    assert.ok(!subs.includes('read-messages'), 'the destructive read must not fire on a zero count');
  } finally { rm(home); }
});

test('drain: count>0 -> N lines appended, inbox reports N, child-turn unread segment fires', () => {
  const home = tmpHome();
  try {
    const { inboxPath, cursorPath } = seedDescriptor(home, 'child-1');
    const R = makeRun({ count: 2, batch: TWO });
    const res = pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run } });
    assert.equal(res.ok, true);
    assert.equal(res.imported, 2);
    assert.equal(res.duplicate, 0);
    assert.equal(res.nativeCount, 2);
    // Durable NDJSON: exactly 2 non-empty lines, each carrying an embedded _h hash.
    const lines = fs.readFileSync(inboxPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 2);
    for (const l of lines) { const o = JSON.parse(l); assert.ok(o._h && typeof o._h === 'string', 'each line carries a dedupe hash'); }
    // The cursor primitive (what inbox read/ack and the child-turn hook consume) sees 2 unread.
    const u = readUnread(inboxPath, cursorPath);
    assert.equal(u.count, 2);
    // The child-turn hook's unread surfacing now fires (the pull is what populates it).
    const r = testHook('devswarm-child-turn.js',
      { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'go', cwd: '/tmp' },
      { home, expectJson: true, env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' } });
    const c = (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
    assert.ok(/2 unread parent message/.test(c), `unread segment must fire after a drain; ctx=${c}`);
  } finally { rm(home); }
});

test('never-monitor: the drain uses read-messages, never the destructive monitor long-poll', () => {
  const home = tmpHome();
  try {
    seedDescriptor(home, 'child-1');
    const R = makeRun({ count: 1, batch: JSON.stringify([{ message: 'hi', createdAt: '2026-01-01T00:00:00Z' }]) });
    pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run } });
    const subs = R.calls.map((c) => c.args[1]);
    assert.ok(subs.includes('read-messages'), 'read-messages IS the drain command');
    assert.ok(!subs.includes('monitor'), 'monitor (blocking long-poll) must NEVER be invoked');
  } finally { rm(home); }
});

test('hard-timeout: the read-messages spawn carries a finite timeout', () => {
  const home = tmpHome();
  try {
    seedDescriptor(home, 'child-1');
    const R = makeRun({ count: 1, batch: JSON.stringify([{ message: 'hi', createdAt: '2026-01-01T00:00:00Z' }]) });
    pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run } });
    const readCall = R.calls.find((c) => c.args[1] === 'read-messages');
    assert.ok(readCall, 'read-messages was invoked');
    assert.ok(Number.isFinite(readCall.timeout), 'read-messages must carry a finite timeout (never an unbounded blocking read)');
    assert.equal(readCall.timeout, pull.READ_TIMEOUT_MS);
  } finally { rm(home); }
});

test('idempotent re-append: the same batch twice -> no duplicate line or store row', () => {
  const home = tmpHome();
  try {
    const { inboxPath } = seedDescriptor(home, 'child-1');
    const R = makeRun({ count: 2, batch: TWO });
    const r1 = pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run } });
    assert.equal(r1.imported, 2);
    // Re-observe the identical batch (count still >0, so read-messages runs again).
    const r2 = pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run } });
    assert.equal(r2.imported, 0, 're-append imports nothing new');
    assert.equal(r2.duplicate, 2, 'both re-observed messages are recognized as duplicates');
    const lines = fs.readFileSync(inboxPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 2, 'the NDJSON must not grow on replay');
    const s = storeLib.openStore({ home, backend: 'journal' });
    try { assert.equal(s.messageCount('child-1'), 2, 'the store parity feed is deduped by the same hash'); }
    finally { s.close(); }
  } finally { rm(home); }
});

test('reconciliation: message-count=2 but read-messages returns an UNHANDLED shape -> lost:2, ok:false (no silent imported:0)', () => {
  const home = tmpHome();
  try {
    const { inboxPath } = seedDescriptor(home, 'child-1');
    // message-count says 2 unread, but read-messages returns a shape normalizeMonitorPayload
    // does not handle ({items:[...]}) -> normalize returns [] -> nothing recovered. The two
    // messages were marked-read natively but never persisted = SILENT LOSS. The drain MUST
    // surface it (lost:2, ok:false), never a quiet imported:0/ok:true.
    const R = makeRun({ count: 2, batch: JSON.stringify({ items: [{ message: 'a' }, { message: 'b' }] }) });
    const res = pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run } });
    assert.equal(res.ok, false, 'a shortfall vs the native count must NOT report success');
    assert.equal(res.locked, true);
    assert.equal(res.imported, 0);
    assert.equal(res.duplicate, 0);
    assert.equal(res.nativeCount, 2);
    assert.equal(res.lost, 2, 'the loud lost signal must equal the unrecovered count');
    // Nothing bogus was written to the durable inbox.
    assert.ok(!fs.existsSync(inboxPath) || fs.readFileSync(inboxPath, 'utf8').trim() === '',
      'an unhandled batch must not fabricate NDJSON lines');
  } finally { rm(home); }
});

test('lock: a held per-id lock refuses a second pull (locked:false); disjoint ids do not block', () => {
  const home = tmpHome();
  try {
    seedDescriptor(home, 'a');
    seedDescriptor(home, 'b');
    // Simulate a LIVE holder of a's pull lock (this process's pid, fresh ts).
    const lockPath = pull.pullLockPath(home, 'a');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'held' }));
    const R = makeRun({ count: 0, batch: '[]' });
    const blocked = pull.pullOnce({ home, id: 'a', backend: 'journal', io: { run: R.run } });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.locked, false);
    assert.match(blocked.error, /lock/);
    // a's lock must be left intact (a live holder is never stolen).
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'held');
    // A disjoint id is unaffected.
    const ok = pull.pullOnce({ home, id: 'b', backend: 'journal', io: { run: R.run } });
    assert.equal(ok.ok, true);
    assert.equal(ok.locked, true);
  } finally { rm(home); }
});

test('crash-window: a thrown durable append surfaces ok:false (no false success, no partial NDJSON, no store row)', () => {
  const home = tmpHome();
  try {
    const { inboxPath } = seedDescriptor(home, 'child-1');
    // io.fs delegates to real fs but makes the ONE durable appendFileSync throw — the
    // exact crash-window failure. The result MUST be ok:false, the inbox MUST stay
    // empty (append precedes ok:true), and the store parity feed MUST NOT have run.
    const throwingFs = Object.assign({}, fs, { appendFileSync() { throw new Error('disk full'); } });
    const R = makeRun({ count: 2, batch: TWO });
    const res = pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: R.run, fs: throwingFs } });
    assert.equal(res.ok, false, 'a failed durable append must never report success');
    assert.equal(res.locked, true);
    assert.ok(!fs.existsSync(inboxPath) || fs.readFileSync(inboxPath, 'utf8').trim() === '',
      'no partial NDJSON may be left behind');
    const s = storeLib.openStore({ home, backend: 'journal' });
    try { assert.equal(s.messageCount('child-1'), 0, 'store parity must not run when the durable append failed'); }
    finally { s.close(); }
  } finally { rm(home); }
});

test('durable append precedes ok:true: on success the NDJSON is already on disk when ok:true returns', () => {
  const home = tmpHome();
  try {
    const { inboxPath } = seedDescriptor(home, 'child-1');
    let sawFileAtOk = false;
    // Wrap appendFileSync so the moment it runs we can confirm the write happens
    // BEFORE the function returns ok:true — assert the file content is present at
    // return time (a proxy for the strict ordering: append then success).
    const res = pull.pullOnce({ home, id: 'child-1', backend: 'journal', io: { run: makeRun({ count: 1, batch: JSON.stringify([{ message: 'hi', createdAt: 't' }]) }).run } });
    if (res.ok) sawFileAtOk = fs.readFileSync(inboxPath, 'utf8').trim() !== '';
    assert.equal(res.ok, true);
    assert.ok(sawFileAtOk, 'the durable line must be on disk by the time ok:true is returned');
  } finally { rm(home); }
});

test('bad id / missing descriptor fail soft (never throw, lock reflects state)', () => {
  const home = tmpHome();
  try {
    const R = makeRun({ count: 0, batch: '[]' });
    const bad = pull.pullOnce({ home, id: '../evil', backend: 'journal', io: { run: R.run } });
    assert.equal(bad.ok, false);
    assert.equal(bad.locked, false, 'an unsafe id is rejected before any lock is taken');
    // Safe id but no descriptor -> lock acquired, then a clean ok:false.
    const noDesc = pull.pullOnce({ home, id: 'ghost', backend: 'journal', io: { run: R.run } });
    assert.equal(noDesc.ok, false);
    assert.equal(noDesc.locked, true);
    assert.match(noDesc.error, /descriptor/);
  } finally { rm(home); }
});

test('acquireExclLock does NOT steal a TORN/EMPTY lock whose MTIME is FRESH (live pull mid-write)', () => {
  const home = tmpHome();
  try {
    const p = pull.pullLockPath(home, 'a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A live holder is briefly a 0-byte file between openSync('wx') and writeSync.
    fs.writeFileSync(p, ''); // torn/empty -> unparseable (holderTs would be null)
    const mt = fs.statSync(p).mtimeMs;
    // Unparseable AND no live pid, but a FRESH mtime -> a live pull mid-write -> MUST NOT
    // be stolen (two drains of the same queue split the destructive native queue).
    const rel = pull.acquireExclLock(p, { isAlive: () => false, now: () => mt + 1000 }, pull.PULL_LOCK_STALE_MS);
    assert.equal(rel, null, 'a torn/empty lock with a FRESH mtime is not stolen');
    assert.equal(fs.readFileSync(p, 'utf8'), '', 'the live holder empty lock is left intact');
  } finally { rm(home); }
});

test('acquireExclLock RECLAIMS a TORN/EMPTY lock whose MTIME is OLD (dead holder)', () => {
  const home = tmpHome();
  try {
    const p = pull.pullLockPath(home, 'a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, ''); // torn/empty, written long ago (dead holder)
    const mt = fs.statSync(p).mtimeMs;
    // Unparseable AND its mtime is older than the 60-s pull stale window -> dead holder -> reclaimable.
    const rel = pull.acquireExclLock(p, { isAlive: () => false, now: () => mt + pull.PULL_LOCK_STALE_MS + 1000 }, pull.PULL_LOCK_STALE_MS);
    assert.ok(rel, 'a torn/empty lock with an OLD mtime (dead holder) is reclaimed');
    assert.notEqual(fs.readFileSync(p, 'utf8'), '', 'the reclaimed lock now carries our token');
    rel();
  } finally { rm(home); }
});
