'use strict';
// Wave C2 — items 1, 2 and 3.
//
//   1. UNREAD UNIFICATION (defect 8f2aec40e2ff, P1). `computeSummary`'s
//      `unread` was `messageCount - cursorValue` (STORE ONLY) while the parent
//      Stop gate, liveness.js and `inbox count` all read the LOSS-FREE UNION
//      (companion/lib/devswarm-unread.js). Same row, minutes apart, roster said
//      15 and the gate said 8. computeSummary now calls the SAME primitive.
//
//   2. `unclaimed:<id>` PROMOTION (carry-out (e)). cmdInboxPull stamps the
//      synthetic marker when no real session claimed the row; nothing ever took
//      it off, so a row a live session was actively draining kept reading as
//      NOT live everywhere isLiveSessionId is consulted. Plus the forward
//      migration for rows already stamped by an older build.
//
//   3. DRAIN-MARKER SESSION ID (R12 Critic P1). The marker's descriptor
//      fallback inherited the registry's TAUTOLOGICAL `sessionId === id` (and
//      the synthetic `unclaimed:` marker) — neither is a session id, and a
//      marker claiming an identity it does not have is worse than one claiming
//      none. It now records `null`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const unreadLib = require('../../plugins/anti-hall/companion/lib/devswarm-unread.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const livenessLib = require('../../plugins/anti-hall/companion/lib/liveness.js');
const drainMarker = require('../../plugins/anti-hall/companion/lib/devswarm-drain-marker.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wavec2-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wavec2-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// ALWAYS an explicit scratch `ctx.home` — run(argv, ctx) has no env home override.
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

function seedStoreRows(home, repoDir, toId, bodies) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    let ts = 1000;
    for (const body of bodies) {
      const fields = { from: 'peer', to: toId, type: 'direct', urgency: 'normal', message: body, timestamp: ts };
      ts += 10;
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
    }
  } finally { s.close(); }
  return repoKey;
}

// ---------------------------------------------------------------------------
// ITEM 1 — unread unification
// ---------------------------------------------------------------------------

test('item 1: summary unread equals the loss-free UNION (N ndjson-only + M store-only), not the store-only count', () => {
  const home = tmpHome();
  const repo = makeGitRepo('union');
  try {
    const paths = register(home, repo, 'w-union');
    // N = 3 NDJSON-only unread lines (native-pull shape: each carries its own
    // `_h`, so nothing on the store side can ever dedupe against them).
    fs.mkdirSync(path.dirname(paths.inboxPath), { recursive: true });
    fs.writeFileSync(paths.inboxPath, [
      JSON.stringify({ _h: 'native:n1', message: 'n1' }),
      JSON.stringify({ _h: 'native:n2', message: 'n2' }),
      JSON.stringify({ _h: 'native:n3', message: 'n3' }),
    ].join('\n') + '\n');
    fs.mkdirSync(path.dirname(paths.cursorPath), { recursive: true });
    fs.writeFileSync(paths.cursorPath, '0');
    // M = 2 store-only unread rows (mesh directs; no NDJSON twin).
    const repoKey = seedStoreRows(home, repo, 'w-union', ['m1', 'm2']);

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let summaryUnread;
    let unionCount;
    let storeOnlyCount;
    try {
      storeOnlyCount = s.messageCount('w-union') - s.cursorValue('w-union');
      const sum = storeLib.computeSummary(s, { home, env: {} });
      summaryUnread = sum.workspaces['w-union'].unread;
      unionCount = unreadLib.unionUnread({
        inboxPath: paths.inboxPath, cursorPath: paths.cursorPath, id: 'w-union', storeHandle: s,
      }).unread;
    } finally { s.close(); }

    assert.equal(storeOnlyCount, 2, 'precondition: the STORE-only count is 2 (the pre-fix summary value)');
    assert.equal(unionCount, 5, 'precondition: the union is 3 ndjson + 2 store-only');
    assert.equal(summaryUnread, unionCount,
      'THE FIX: summary.unread must equal the union primitive\'s count, not the store-only count');
    assert.notEqual(summaryUnread, storeOnlyCount, 'RED half: the pre-fix value (2) must no longer be reported');
  } finally { rm(home); rm(repo); }
});

test('item 1: with no NDJSON inbox at all the summary stays byte-identical to the pre-fix store-only count', () => {
  const home = tmpHome();
  const repo = makeGitRepo('union-nondjson');
  try {
    register(home, repo, 'w-plain');
    const repoKey = seedStoreRows(home, repo, 'w-plain', ['a', 'b', 'c']);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const sum = storeLib.computeSummary(s, { home, env: {} });
      assert.equal(sum.workspaces['w-plain'].unread, 3,
        'a row with no durable NDJSON must report exactly its store-only unread — no inflation');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('item 1: a MIGRATED legacy line is counted ONCE, not once per side (the union double-count this fix also closed)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('union-legacy');
  try {
    const paths = register(home, repo, 'w-legacy');
    // Three bare legacy lines (no `_h`) and their migrated store twins, hashed
    // exactly as devswarm-migrate.js hashes them.
    const lines = ['L1', 'L2', 'L3'];
    fs.mkdirSync(path.dirname(paths.inboxPath), { recursive: true });
    fs.writeFileSync(paths.inboxPath, lines.join('\n') + '\n');
    fs.mkdirSync(path.dirname(paths.cursorPath), { recursive: true });
    fs.writeFileSync(paths.cursorPath, '1'); // one consumed -> 2 unread on the NDJSON side

    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      for (let i = 0; i < lines.length; i++) {
        s.appendMeshRow({
          workspaceId: 'w-legacy', ts: 1000 + i,
          hash: unreadLib.legacyLineHash('w-legacy', i, lines[i]),
          body: lines[i], sender: null, recipient: null, mtype: null,
          urgency: null, isHeartbeat: false, needsReply: false,
        });
      }
      s.setCursor('w-legacy', 1);
      const u = unreadLib.unionUnread({
        inboxPath: paths.inboxPath, cursorPath: paths.cursorPath, id: 'w-legacy', storeHandle: s,
      });
      assert.equal(u.unread, 2,
        'each physical legacy line must be counted ONCE across both sides (pre-fix this was 4)');
      const sum = storeLib.computeSummary(s, { home, env: {} });
      assert.equal(sum.workspaces['w-legacy'].unread, 2, 'the summary agrees with the union');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('item 1 MUTATION: restoring the store-only expression makes the summary disagree with the union again', () => {
  // The mutation is applied to an in-memory double, not to the live file: the
  // point is that `total - cursor` and the union genuinely differ for this
  // fixture, so a summary computed the old way could not have matched.
  const home = tmpHome();
  const repo = makeGitRepo('union-mutant');
  try {
    const paths = register(home, repo, 'w-mut');
    fs.mkdirSync(path.dirname(paths.inboxPath), { recursive: true });
    fs.writeFileSync(paths.inboxPath, JSON.stringify({ _h: 'native:x', message: 'x' }) + '\n');
    fs.mkdirSync(path.dirname(paths.cursorPath), { recursive: true });
    fs.writeFileSync(paths.cursorPath, '0');
    const repoKey = seedStoreRows(home, repo, 'w-mut', ['s1']);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const preFix = Math.max(0, s.messageCount('w-mut') - s.cursorValue('w-mut'));
      const union = unreadLib.unionUnread({
        inboxPath: paths.inboxPath, cursorPath: paths.cursorPath, id: 'w-mut', storeHandle: s,
      }).unread;
      assert.equal(preFix, 1, 'the mutant (store-only) expression yields 1');
      assert.equal(union, 2, 'the union yields 2 — the two are genuinely different, so the assertion above is not vacuous');
      assert.equal(storeLib.computeSummary(s, { home, env: {} }).workspaces['w-mut'].unread, union);
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// ITEM 2 — `unclaimed:<id>` promotion + forward migration
// ---------------------------------------------------------------------------

function stampUnclaimed(home, repoDir, id) {
  register(home, repoDir, id, 'unclaimed:' + id);
  const d = cli.readDescriptorFile(home, id);
  assert.equal(d.sessionId, 'unclaimed:' + id, 'fixture precondition: the row carries the synthetic marker');
}

test('item 2: a read by a caller with a REAL session id promotes the unclaimed: marker in place', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote');
  try {
    stampUnclaimed(home, repo, 'w-unclaimed');
    const r = cli.run(['inbox', 'messages', 'w-unclaimed'],
      ctx(home, { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: 'real-session-abc' } }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(cli.readDescriptorFile(home, 'w-unclaimed').sessionId, 'real-session-abc',
      'THE FIX: a real session reading the row takes the synthetic marker off');
    assert.equal(cli.isLiveSessionId('real-session-abc'), true, 'and the row now reads as live');
  } finally { rm(home); rm(repo); }
});

test('item 2: the registry is written through, not just the descriptor', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-registry');
  try {
    stampUnclaimed(home, repo, 'w-wt');
    cli.run(['inbox', 'messages', 'w-wt'], ctx(home, { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-real' } }));
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const row = (s.listRegistry() || []).find((x) => String(x.id) === 'w-wt');
      assert.ok(row, 'the registry row must still exist');
      assert.equal(row.sessionId, 'sess-real', 'the STORE registry row is promoted too — the two never diverge');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('item 2: promotion is IDEMPOTENT — a second real-session read changes nothing', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-idem');
  try {
    stampUnclaimed(home, repo, 'w-idem');
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-1' };
    cli.run(['inbox', 'messages', 'w-idem'], ctx(home, { cwd: repo, env }));
    const first = cli.readDescriptorFile(home, 'w-idem');
    // A DIFFERENT real session reading later must NOT re-claim the row: the
    // marker is gone, so there is nothing left to promote.
    cli.run(['inbox', 'messages', 'w-idem'], ctx(home, { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-2' } }));
    assert.equal(cli.readDescriptorFile(home, 'w-idem').sessionId, first.sessionId,
      'once promoted, the sessionId is never rewritten by a later reader');
    assert.equal(first.sessionId, 'sess-1');
  } finally { rm(home); rm(repo); }
});

test('item 2: NO promotion without a real session id (absent, the row\'s own id, or another unclaimed: value)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-noop');
  try {
    stampUnclaimed(home, repo, 'w-noop');
    const marker = 'unclaimed:w-noop';

    cli.run(['inbox', 'messages', 'w-noop'], ctx(home, { cwd: repo, env: {} }));
    assert.equal(cli.readDescriptorFile(home, 'w-noop').sessionId, marker, 'no session id -> no promotion');

    assert.equal(cli.realSessionIdFrom({ session: ['w-noop'] }, ctx(home), 'w-noop'), null,
      'the row\'s OWN id is the tautological fallback, never a session id');
    assert.equal(cli.realSessionIdFrom({ session: ['unclaimed:w-noop'] }, ctx(home), 'w-noop'), null,
      'a still-synthetic value is never a session id');
    assert.equal(cli.realSessionIdFrom({ session: ['   '] }, ctx(home), 'w-noop'), null, 'blank is never a session id');
    assert.equal(cli.realSessionIdFrom({ session: ['sess-ok'] }, ctx(home), 'w-noop'), 'sess-ok');
  } finally { rm(home); rm(repo); }
});

test('item 2 MIGRATION: promotes only rows with an independently-known session, and never deletes the rest', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-migrate');
  try {
    // (a) prior form `unclaimed:<id>` WITH a heartbeat naming a real session.
    stampUnclaimed(home, repo, 'w-known');
    const beat = livenessLib.heartbeatPathFor('w-known', home);
    fs.mkdirSync(path.dirname(beat), { recursive: true });
    fs.writeFileSync(beat, JSON.stringify({ id: 'w-known', ts: Date.now(), sessionId: 'sess-from-beat' }));

    // (b) prior form `unclaimed:<id>` with NO session source anywhere.
    stampUnclaimed(home, repo, 'w-unknown');

    // (c) prior form: the TAUTOLOGICAL id-as-session ingest fallback. NOT the
    // `unclaimed:` marker, so the sweep must leave it entirely alone.
    register(home, repo, 'w-taut', 'w-taut');

    // (d) an ordinary already-real row — must be untouched.
    register(home, repo, 'w-real', 'sess-already-real');

    const r = cli.promoteUnclaimedRegistrySessions(home, { cwd: repo, env: {} });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.promoted.map((p) => p.id).sort(), ['w-known']);
    assert.deepEqual(r.left.map((p) => p.id).sort(), ['w-unknown']);

    assert.equal(cli.readDescriptorFile(home, 'w-known').sessionId, 'sess-from-beat');
    assert.equal(cli.readDescriptorFile(home, 'w-unknown').sessionId, 'unclaimed:w-unknown',
      'NO-DELETE / no guessing: a row with no known session is left exactly as it was');
    assert.equal(cli.readDescriptorFile(home, 'w-taut').sessionId, 'w-taut', 'the tautological form is untouched');
    assert.equal(cli.readDescriptorFile(home, 'w-real').sessionId, 'sess-already-real');

    // Idempotent: a re-run finds nothing left to promote and still deletes nothing.
    const again = cli.promoteUnclaimedRegistrySessions(home, { cwd: repo, env: {} });
    assert.deepEqual(again.promoted, []);
    assert.deepEqual(again.left.map((p) => p.id), ['w-unknown']);
    for (const id of ['w-known', 'w-unknown', 'w-taut', 'w-real']) {
      assert.ok(cli.readDescriptorFile(home, id), 'descriptor ' + id + ' still exists after the sweep');
    }
  } finally { rm(home); rm(repo); }
});

test('item 2 MIGRATION: a heartbeat whose sessionId is itself synthetic/tautological never promotes', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-badbeat');
  try {
    stampUnclaimed(home, repo, 'w-bad');
    const beat = livenessLib.heartbeatPathFor('w-bad', home);
    fs.mkdirSync(path.dirname(beat), { recursive: true });
    fs.writeFileSync(beat, JSON.stringify({ id: 'w-bad', ts: Date.now(), sessionId: 'unclaimed:w-bad' }));
    const r = cli.promoteUnclaimedRegistrySessions(home, { cwd: repo, env: {} });
    assert.deepEqual(r.promoted, [], 'a synthetic heartbeat session is not an independent source');
    assert.equal(cli.readDescriptorFile(home, 'w-bad').sessionId, 'unclaimed:w-bad');

    fs.writeFileSync(beat, JSON.stringify({ id: 'w-bad', ts: Date.now(), sessionId: 'w-bad' }));
    const r2 = cli.promoteUnclaimedRegistrySessions(home, { cwd: repo, env: {} });
    assert.deepEqual(r2.promoted, [], 'a tautological heartbeat session is not an independent source either');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// ITEM 3 — drain-marker session id
// ---------------------------------------------------------------------------

test('item 3: the drain marker records sessionId null rather than inheriting the tautological id fallback', () => {
  const home = tmpHome();
  const repo = makeGitRepo('drain-taut');
  try {
    register(home, repo, 'w-drain', 'w-drain'); // descriptor sessionId === the row id
    let observed = 'NEVER-CALLED';
    const realMark = drainMarker.markDrainStart;
    drainMarker.markDrainStart = function (h, id, o) {
      observed = (o || {}).sessionId;
      return realMark.call(this, h, id, o);
    };
    try {
      cli.run(['inbox', 'read-primary', 'w-drain'], ctx(home, { cwd: repo, env: {} }));
    } finally { drainMarker.markDrainStart = realMark; }
    assert.strictEqual(observed, null,
      'THE FIX: a value equal to the row id is not a session id — the marker must claim none');
  } finally { rm(home); rm(repo); }
});

test('item 3: the drain marker records sessionId null for the synthetic unclaimed: value too', () => {
  const home = tmpHome();
  const repo = makeGitRepo('drain-unclaimed');
  try {
    register(home, repo, 'w-du', 'unclaimed:w-du');
    let observed = 'NEVER-CALLED';
    const realMark = drainMarker.markDrainStart;
    drainMarker.markDrainStart = function (h, id, o) {
      observed = (o || {}).sessionId;
      return realMark.call(this, h, id, o);
    };
    try {
      cli.run(['inbox', 'read-primary', 'w-du'], ctx(home, { cwd: repo, env: {} }));
    } finally { drainMarker.markDrainStart = realMark; }
    assert.strictEqual(observed, null, 'the unclaimed: marker is not a session id either');
  } finally { rm(home); rm(repo); }
});

test('item 3: a GENUINE session id is still recorded verbatim (the fix narrows nothing real)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('drain-real');
  try {
    register(home, repo, 'w-real-drain', 'sess-real-xyz');
    let observed = 'NEVER-CALLED';
    const realMark = drainMarker.markDrainStart;
    drainMarker.markDrainStart = function (h, id, o) {
      observed = (o || {}).sessionId;
      return realMark.call(this, h, id, o);
    };
    try {
      cli.run(['inbox', 'read-primary', 'w-real-drain'], ctx(home, { cwd: repo, env: {} }));
    } finally { drainMarker.markDrainStart = realMark; }
    assert.equal(observed, 'sess-real-xyz', 'a real descriptor session id must still reach the marker');
  } finally { rm(home); rm(repo); }
});
