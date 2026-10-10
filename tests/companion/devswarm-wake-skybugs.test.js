'use strict';
// SkyCrew Primary report (wake-watch family):
//   - a Monitor armed from the Primary's main checkout resolved as a CHILD under the DevSwarm app's own row id for that
//     checkout, so `inbox tick <primary id>` read `watcherArmed false` while it ran, the cue sent the agent to re-arm and
//     the re-arm hit "REFUSED TO ARM: lock-held";
//   - a lapsed watcher under a live cron was nagged ("NO MAILBOX WATCHER") although the tick re-arms it;
//   - a live child idle on an unanswered owner prompt counted as a reason to nag;
//   - "idle-skip: no live child workspaces" right after a spawn while the roster (app DB) showed the child active.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wake = require('../../plugins/anti-hall/companion/lib/devswarm-wake-watch.js');
const liveChildren = require('../../plugins/anti-hall/companion/lib/devswarm-live-children.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wake-skybugs-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'locks'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function writeDesc(home, d) {
  fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', d.id + '.json'), JSON.stringify(d));
}
const readDescriptors = (h) => {
  const dir = path.join(h, '.anti-hall', 'devswarm', 'workspaces');
  return fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
};
function writeLock(home, id, over) {
  fs.writeFileSync(wake.lockPathFor(home, id), JSON.stringify(Object.assign({ pid: process.pid, ts: Date.now() }, over || {})));
}

test('resolveIdentity: the app row on the Primary\'s MAIN checkout resolves as the Primary, not as a child under the app id', () => {
  const home = tmpHome();
  try {
    const main = path.join(home, 'main');
    fs.mkdirSync(main, { recursive: true });
    writeDesc(home, { id: '76cf862f-4dbd-4a14-904b-b84c8e255743', worktreePath: main, sessionId: null });
    writeDesc(home, { id: 'primary-63f9261d', worktreePath: main, sessionId: 's' });
    const io = { home, fs, readDescriptors, resolveMainWorktree: () => main, primaryWorkspaceId: () => 'primary-63f9261d' };
    const id = wake.resolveIdentity({}, main, io);
    assert.deepStrictEqual({ role: id.role, id: id.id }, { role: 'primary', id: 'primary-63f9261d' });
  } finally { rm(home); }
});

test('resolveIdentity: a descriptor on a LINKED worktree is still a child', () => {
  const home = tmpHome();
  try {
    const main = path.join(home, 'main');
    const linked = path.join(home, 'wt-child');
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(linked, { recursive: true });
    writeDesc(home, { id: 'child-1', worktreePath: linked, sessionId: 's' });
    const io = { home, fs, readDescriptors, resolveMainWorktree: () => main, primaryWorkspaceId: () => 'primary-63f9261d' };
    const id = wake.resolveIdentity({}, linked, io);
    assert.deepStrictEqual({ role: id.role, id: id.id }, { role: 'child', id: 'child-1' });
  } finally { rm(home); }
});

test('watcherLiveForWorkspace: a live Monitor locked under the app row of the SAME checkout still covers the Primary', () => {
  const home = tmpHome();
  try {
    const main = path.join(home, 'main');
    fs.mkdirSync(main, { recursive: true });
    writeDesc(home, { id: 'appRow', worktreePath: main });
    writeDesc(home, { id: 'primary-x', worktreePath: main });
    assert.strictEqual(wake.watcherLiveForWorkspace(home, 'primary-x', Date.now(), { readDescriptors }), false, 'no lock anywhere');
    writeLock(home, 'appRow');
    assert.strictEqual(wake.watcherLockLive(home, 'primary-x', Date.now()), false, 'the id\'s own lock is absent');
    assert.strictEqual(wake.watcherLiveForWorkspace(home, 'primary-x', Date.now(), { readDescriptors }), true);
    // another checkout's lock never counts
    const other = path.join(home, 'other');
    fs.mkdirSync(other, { recursive: true });
    writeDesc(home, { id: 'otherRow', worktreePath: other });
    fs.rmSync(wake.lockPathFor(home, 'appRow'));
    writeLock(home, 'otherRow');
    assert.strictEqual(wake.watcherLiveForWorkspace(home, 'primary-x', Date.now(), { readDescriptors }), false);
    // a stale alias lock does not count
    writeLock(home, 'appRow', { ts: Date.now() - wake.WATCH_LOCK_STALE_MS - 1000 });
    assert.strictEqual(wake.watcherLiveForWorkspace(home, 'primary-x', Date.now(), { readDescriptors }), false);
  } finally { rm(home); }
});

const SELF = '/repo/self';
const descriptorOpts = (rows, elig) => ({
  readDescriptors: () => rows,
  repoKeyForWorktree: () => 'k',
  rowEligibility: elig,
  fsi: { realpathSync: (p) => p },
  appSnapshot: null,
});

test('liveChildState: a child idle on an unanswered owner prompt is not live when excludeWaitingOnUser is set', () => {
  const rows = [{ id: 'c1', worktreePath: '/repo/c1', sessionId: 's' }];
  const elig = (_row, ctx) => ({ archived: false, waitingOnUser: ctx.liveness === true });
  assert.strictEqual(liveChildren.liveChildState('/h', SELF, descriptorOpts(rows, elig)).live, true, 'default: still live');
  assert.strictEqual(liveChildren.liveChildState('/h', SELF, Object.assign(descriptorOpts(rows, elig), { excludeWaitingOnUser: true })).live, false);
});

test('liveChildState: an ACTIVE app workspace of this repo with no descriptor yet (just spawned) is live', () => {
  const snap = {
    ok: true,
    repositories: [{ id: 'r1', path: SELF }],
    workspaces: [
      { id: 'primaryBuilder', repositoryId: 'r1', worktreePath: SELF, builderType: 'primary', active: true, archived: false },
      { id: 'fresh', repositoryId: 'r1', worktreePath: '/repo/fresh', builderType: 'standard', active: true, archived: false },
    ],
  };
  const opts = Object.assign(descriptorOpts([], () => ({ archived: false })), { appSnapshot: snap });
  assert.strictEqual(liveChildren.liveChildState('/h', SELF, opts).live, true);
  // archived, the Primary's own builder row, or another repo's workspace never count
  const none = Object.assign(descriptorOpts([], () => ({ archived: false })), {
    appSnapshot: Object.assign({}, snap, { workspaces: [
      snap.workspaces[0],
      { id: 'gone', repositoryId: 'r1', worktreePath: '/repo/gone', builderType: 'standard', active: false, archived: true },
      { id: 'foreign', repositoryId: 'r2', worktreePath: '/other/x', builderType: 'standard', active: true, archived: false },
    ] }),
  });
  assert.strictEqual(liveChildren.liveChildState('/h', SELF, none).live, false);
  // no app DB at all: the descriptor answer stands
  assert.strictEqual(liveChildren.liveChildState('/h', SELF, descriptorOpts([], () => ({ archived: false }))).live, false);
});

// ---- bug 6: only INBOUND mail moves the direct total ------------------------------------------------------------------

test('readPrimarySnapshot: edge-triggers on directTotalFromOthers when the summary publishes it, else the raw total', () => {
  const mk = (row) => ({ readSummaryForHash: () => ({ workspaces: { p: row } }) });
  const hashes = { repoKey: 'k', fallbackHash: null };
  assert.strictEqual(wake.readPrimarySnapshot('/h', hashes, 'p', mk({ total: 10, directTotalFromOthers: 7 })).total, 7);
  assert.strictEqual(wake.readPrimarySnapshot('/h', hashes, 'p', mk({ total: 10 })).total, 10, 'older writer: raw total');
});

test('tick: the Primary\'s own send (raw total +1, inbound unchanged) does not wake; a real inbound message does; a lower metric resyncs silently', () => {
  const snap = (total) => ({ ok: true, role: 'primary', id: 'p', total, nowMs: 1 });
  const mail = (r) => r.lines.filter((l) => /new mesh mail/.test(l));
  let st = wake.tick(undefined, snap(7)).state; // seeded
  st = wake.tick(st, snap(7)).state;
  const own = wake.tick(st, snap(7)); // raw total moved by an own send, but the inbound metric did not
  assert.deepStrictEqual(mail(own), []);
  const inbound = wake.tick(own.state, snap(8));
  assert.strictEqual(mail(inbound).length, 1);
  assert.match(mail(inbound)[0], /direct total 7 -> 8 \(\+1\)/);
  // an older seen-file recorded the raw (larger) total: switching to the inbound metric resyncs down, no wake, no missed mail
  const old = wake.tick({ lastTotal: 12, lastTotalMissing: false }, snap(8));
  assert.deepStrictEqual(mail(old), []);
  assert.strictEqual(old.state.lastTotal, 8);
  const next = wake.tick(old.state, snap(9));
  assert.strictEqual(mail(next).length, 1, 'the next genuinely new inbound message still wakes');
});

test('computeSummary: directTotalFromOthers excludes rows the workspace\'s own identity family sent', () => {
  const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
  const home = tmpHome();
  try {
    const s = storeLib.openStore({ home, hash: 'k-own', backend: 'journal' });
    try {
      s.upsertRegistry({ id: 'p', worktreePath: '/w/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null });
      let ts = 1;
      for (const [from, body] of [['child', 'a'], ['p', 'own send'], ['child', 'b'], [null, 'native, no sender']]) {
        const f = { from, to: 'p', type: 'direct', urgency: 'normal', message: body, timestamp: ts++ };
        storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
      }
      const w = storeLib.computeSummary(s, { home, env: {} }).workspaces.p;
      assert.strictEqual(w.total, 4);
      assert.strictEqual(w.directTotalFromOthers, 3, 'the own send is not inbound mail');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('inbox tick: a Monitor locked under the app row of the SAME checkout reads watcherArmed true (no re-arm cue, no lock-held loop)', () => {
  const ops = require('../harness/ops.js');
  const fx = ops.makeMeshFixture(['r1', 'r2'], 'tick-alias');
  try {
    const now = Date.now();
    ops.opRegister(fx, 'r1', now);
    ops.opRegister(fx, 'r2', now + 1);
    const tick = () => ops.cli.run(['inbox', 'tick', 'r1', '--json'], ops.baseCtx(fx, 'r1', now + 5, { env: { ANTIHALL_INGEST_DRY_RUN: '1', ANTIHALL_DEVSWARM_WAKE_WATCH_IDLE_SKIP: 'off' } })).result;
    assert.strictEqual(tick().watcherArmed, false, 'no watcher anywhere');
    // the app row for r1's checkout, registered under another id, holds a live watcher lock
    const wdir = path.join(fx.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.writeFileSync(path.join(wdir, 'appRow.json'), JSON.stringify({ id: 'appRow', worktreePath: fx.readers.r1, sessionId: 'app-sess' }));
    fs.mkdirSync(path.join(fx.home, '.anti-hall', 'devswarm', 'locks'), { recursive: true });
    fs.writeFileSync(wake.lockPathFor(fx.home, 'appRow'), JSON.stringify({ pid: process.pid, ts: now + 4 }));
    assert.strictEqual(tick().watcherArmed, true);
    // a lock under an id on ANOTHER checkout does not arm r1
    fs.rmSync(wake.lockPathFor(fx.home, 'appRow'));
    fs.writeFileSync(wake.lockPathFor(fx.home, 'r2'), JSON.stringify({ pid: process.pid, ts: now + 4 }));
    assert.strictEqual(tick().watcherArmed, false);
  } finally { fx.cleanup(); }
});
