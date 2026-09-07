'use strict';
// d3d571495bf6 (P0) — two running processes of the SAME Claude session id (a
// `claude --resume` racing its own prior process, or a fork) derive the same
// caller identity in devswarm.js, so mesh rows/messages from one are
// attributed to the other (fabricated provenance).
//
// Fix under test: deriveInstanceNonce(ctx, opts) — a per-process instance
// nonce stamped ADDITIVELY on outbound rows, excluded from meshMessageHash
// (dedup/idempotency unchanged), with readers failing open on rows without it.
//
// Points at the module path in ANTIHALL_TEST_MODULE_DIR (defaults to the
// scratch-patched copies) so the SAME file can be run against HEAD (red) and
// against the patched copies (green) without duplication.
//
// HERMETIC: HOME/USERPROFILE isolated to a fresh tmpdir per test; never
// touches the real ~/.anti-hall or ~/.claude/sessions.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// ANTIHALL_TEST_PLUGIN_ROOT points at a `plugins/anti-hall`-SHAPED tree — i.e.
// ROOT itself must directly contain `scripts/devswarm.js` and
// `companion/lib/devswarm-store.js` (a full mirror, not just the two changed
// files — devswarm.js requires ~15 sibling companion/hooks modules by
// relative path, so a partial copy fails at require-time with a confusing
// MODULE_NOT_FOUND rather than a test assertion). Defaults to the real repo
// tree (HEAD, unpatched — RED); point it at a patched mirror to prove GREEN.
const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const cliPath = path.join(ROOT, 'scripts', 'devswarm.js');
const storePath = path.join(ROOT, 'companion', 'lib', 'devswarm-store.js');
if (!fs.existsSync(cliPath) || !fs.existsSync(storePath)) {
  throw new Error(
    'ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped '
    + 'tree — expected to find both:\n  ' + cliPath + '\n  ' + storePath
    + '\nROOT must directly contain scripts/ and companion/lib/, e.g. .../E/red or .../E/green '
    + '(NOT a wrapper directory one level above them).'
  );
}
const cli = require(cliPath);
const storeLib = require(storePath);
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d3d571495bf6-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d3d571495bf6-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function writeSessionFile(home, pid, rec) {
  const dir = liveness.sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid) + '.json'), JSON.stringify(rec));
}

// Isolate HOME/USERPROFILE for the whole file (never touch the real harness dirs).
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => {
  const iso = tmpHome();
  process.env.HOME = iso;
  process.env.USERPROFILE = iso;
});
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});

test('d3d571495bf6: two live processes sharing ONE session id get DISTINCT instance nonces', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    const SAME_SESSION_ID = 'a5beef36-1668-473e-b1a5-cd65b090700f'; // identical on both "processes"

    // Process A: harness ancestor pid 11105, alive, cwd == repo, session file
    // records SAME_SESSION_ID.
    writeSessionFile(home, 11105, {
      pid: 11105, sessionId: SAME_SESSION_ID, cwd: repo, startedAt: 1000000,
    });
    // Process B: a DIFFERENT harness ancestor pid (a resume/fork of the SAME
    // session id, per the field-confirmed shape in the defect) — same cwd,
    // same sessionId, but its OWN pid/startedAt.
    writeSessionFile(home, 22222, {
      pid: 22222, sessionId: SAME_SESSION_ID, cwd: repo, startedAt: 2000000,
    });

    const ctxA = { home, cwd: repo, env: {} };
    const ctxB = { home, cwd: repo, env: {} };
    // opts.pid stands in for "this process's own pid" at the bottom of each
    // simulated ancestor chain; opts.ppidOf(11105/22222) -> null terminates
    // the walk at the harness ancestor itself (a 1-hop chain), matching how a
    // devswarm.js CLI invocation's own immediate ancestor IS the harness
    // process in the common case. opts.kill always reports "alive".
    const nonceA = cli.deriveInstanceNonce(ctxA, { pid: 11105, ppidOf: () => null, kill: () => {} });
    const nonceB = cli.deriveInstanceNonce(ctxB, { pid: 22222, ppidOf: () => null, kill: () => {} });

    assert.ok(nonceA, 'nonce A must be non-empty');
    assert.ok(nonceB, 'nonce B must be non-empty');
    assert.notStrictEqual(nonceA, nonceB,
      'two processes sharing ONE session id must get DISTINCT instance nonces (root cause: identity has no per-process discriminator)');
    // Deterministic within one process's own repeated calls (not a fresh
    // random value each time) — same ancestor record -> same nonce.
    const nonceAagain = cli.deriveInstanceNonce(ctxA, { pid: 11105, ppidOf: () => null, kill: () => {} });
    assert.strictEqual(nonceA, nonceAagain, 'the nonce must be stable across repeated calls from the SAME process');
  } finally {
    rm(home); rm(repo);
  }
});

test('d3d571495bf6: instanceNonce is additive — meshMessageHash and dedup are UNCHANGED', () => {
  const home = tmpHome();
  try {
    const fields = {
      from: 'child-abc', to: 'primary-xyz', type: 'direct',
      message: 'hello', timestamp: 1700000000000, urgency: 'normal',
    };
    const hashWithoutNonce = storeLib.meshMessageHash(fields);
    // Hash must be computed the SAME way regardless of whether the caller is
    // about to stamp an instanceNonce — meshMessageHash never reads it.
    const hashWithNonceField = storeLib.meshMessageHash(Object.assign({}, fields, { instanceNonce: 'anc:11105:1000000' }));
    assert.strictEqual(hashWithNonceField, hashWithoutNonce, 'meshMessageHash must ignore instanceNonce entirely');

    // Two sends of the IDENTICAL logical message from two DIFFERENT simulated
    // processes (different instanceNonce) must still dedupe on `hash` — the
    // nonce must never create a second row for the same logical send.
    const backend = storeLib.sqliteAvailable ? (storeLib.sqliteAvailable() ? 'sqlite' : 'journal') : 'journal';
    const s = storeLib.openStore({ home, hash: 'proj1', backend });
    try {
      const r1 = storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: hashWithoutNonce, instanceNonce: 'anc:11105:1000000' }));
      const r2 = storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: hashWithoutNonce, instanceNonce: 'anc:22222:2000000' }));
      assert.strictEqual(r1.inserted, true, 'first send must insert');
      assert.strictEqual(r2.inserted, false, 'second send (same hash, different nonce) must dedupe, not insert a second row');

      const rows = s.listMessages('primary-xyz');
      assert.strictEqual(rows.length, 1, 'dedup must still yield exactly one stored row');
      assert.strictEqual(rows[0].instanceNonce, 'anc:11105:1000000', 'the FIRST insert\'s nonce must be the one persisted (OR-IGNORE keeps the first row)');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('d3d571495bf6: reader FAILS OPEN on a row with no instanceNonce (legacy/pre-fix row)', () => {
  const home = tmpHome();
  try {
    const fields = {
      from: 'child-legacy', to: 'primary-xyz', type: 'direct',
      message: 'legacy row, no nonce', timestamp: 1700000000001, urgency: 'normal',
    };
    const hash = storeLib.meshMessageHash(fields);
    const backend = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? 'sqlite' : 'journal';
    const s = storeLib.openStore({ home, hash: 'proj2', backend });
    try {
      // No instanceNonce passed at all — exactly what an older devswarm.js
      // build (or any caller that could not derive one) would send.
      const r = storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
      assert.strictEqual(r.inserted, true);
      const rows = s.listMessages('primary-xyz');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].instanceNonce, null, 'a row with no instanceNonce must read back null, never throw');
    } finally { s.close(); }
  } finally { rm(home); }
});

// --- instanceNonce CONSUMERS (items a/b/c): roster `instances`/`instance-split`,
// diagnose `instanceSplits[]`, and `inbox read-primary`'s per-message `@short`
// rendering + `instanceNonceShort`. All three read the SAME shared broadcast
// partition (heartbeats + broadcasts) scoped to the liveness freshness window.

test('d3d571495bf6 consumers: two distinct nonces -> roster instance-split, diagnose instanceSplits, read-primary @short suffixes', () => {
  const home = tmpHome();
  const repo = makeGitRepo('consumers-split');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const top = inst.resolveWorktree(repo);
    const backend = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? 'sqlite' : 'journal';
    const now = Date.now();

    const s = storeLib.openStore({ home, hash: repoKey, backend });
    try {
      s.upsertRegistry({ id: 'child-x', worktreePath: top, sessionId: 'session-abc' });
      // Two broadcast/heartbeat rows from the SAME row id, two DIFFERENT
      // instanceNonces — the "two live processes both heartbeating under one
      // sessionId" shape.
      const hb1 = {
        from: 'child-x', to: null, type: 'broadcast', message: 'working on A',
        timestamp: now - 1000, urgency: 'low',
      };
      storeLib.appendMeshMessage(s, Object.assign({}, hb1, {
        hash: storeLib.meshMessageHash(hb1), isHeartbeat: true, instanceNonce: 'anc:11105:1000000',
      }));
      const hb2 = {
        from: 'child-x', to: null, type: 'broadcast', message: 'working on B',
        timestamp: now - 500, urgency: 'low',
      };
      storeLib.appendMeshMessage(s, Object.assign({}, hb2, {
        hash: storeLib.meshMessageHash(hb2), isHeartbeat: true, instanceNonce: 'anc:22222:2000000',
      }));
      // Two DIRECT messages FROM child-x TO a primary row, same two nonces —
      // proves item (a): read-primary must render two DIFFERENT @short suffixes.
      const d1 = {
        from: 'child-x', to: 'primary-y', type: 'direct', message: 'first send',
        timestamp: now - 900, urgency: 'normal',
      };
      storeLib.appendMeshMessage(s, Object.assign({}, d1, {
        hash: storeLib.meshMessageHash(d1), instanceNonce: 'anc:11105:1000000',
      }));
      const d2 = {
        from: 'child-x', to: 'primary-y', type: 'direct', message: 'second send',
        timestamp: now - 400, urgency: 'normal',
      };
      storeLib.appendMeshMessage(s, Object.assign({}, d2, {
        hash: storeLib.meshMessageHash(d2), instanceNonce: 'anc:22222:2000000',
      }));
    } finally { s.close(); }

    // (a) read-primary: two different @short suffixes, plus instanceNonceShort.
    const ctx = { home, cwd: repo, env: {}, now };
    const read = cli.cmdInboxMessages('primary-y', { 'ack-as-owner': true }, ctx, { ack: true, action: 'inbox read-primary' });
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.messages.length, 2, 'both direct sends must be delivered');
    const shorts = read.messages.map((m) => m.instanceNonceShort);
    assert.ok(shorts.every((s2) => typeof s2 === 'string' && s2.length === 6), 'every message must carry a 6-char instanceNonceShort');
    assert.notStrictEqual(shorts[0], shorts[1], 'the two sends must render DIFFERENT @short suffixes');
    for (const m of read.messages) {
      assert.strictEqual(m.fromLine, m.sender + '@' + m.instanceNonceShort, 'fromLine must render as <sender>@<short>');
    }

    // (b) roster: instances=2, hint instance-split.
    const roster = cli.cmdRoster({}, ctx);
    assert.strictEqual(roster.ok, true);
    const rosterRow = roster.workspaces.find((w) => w.id === 'child-x');
    assert.ok(rosterRow, 'child-x must appear on the roster');
    assert.strictEqual(rosterRow.instances, 2, 'roster must report 2 distinct instances');
    assert.ok(rosterRow.hints.includes('instance-split'), 'roster hints must include instance-split');

    // (c) diagnose: instanceSplits[] length 1, for child-x, instances 2.
    const s2 = storeLib.openStore({ home, hash: repoKey, backend });
    let diag;
    try { diag = cli.computeDiagnosis(s2, { home, env: {}, now }); } finally { s2.close(); }
    assert.strictEqual(diag.instanceSplits.length, 1, 'exactly one row is instance-split');
    assert.strictEqual(diag.instanceSplits[0].id, 'child-x');
    assert.strictEqual(diag.instanceSplits[0].instances, 2);
    assert.strictEqual(diag.instanceSplits[0].nonces.length, 2);
  } finally { rm(home); rm(repo); }
});

test('d3d571495bf6 consumers: ONE nonce only -> no instance-split hint, instances:1', () => {
  const home = tmpHome();
  const repo = makeGitRepo('consumers-one');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const top = inst.resolveWorktree(repo);
    const backend = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? 'sqlite' : 'journal';
    const now = Date.now();

    const s = storeLib.openStore({ home, hash: repoKey, backend });
    try {
      s.upsertRegistry({ id: 'child-one', worktreePath: top, sessionId: 'session-one' });
      const hb1 = {
        from: 'child-one', to: null, type: 'broadcast', message: 'working on A',
        timestamp: now - 1000, urgency: 'low',
      };
      storeLib.appendMeshMessage(s, Object.assign({}, hb1, {
        hash: storeLib.meshMessageHash(hb1), isHeartbeat: true, instanceNonce: 'anc:11105:1000000',
      }));
      const hb2 = {
        from: 'child-one', to: null, type: 'broadcast', message: 'working on B (same process)',
        timestamp: now - 500, urgency: 'low',
      };
      storeLib.appendMeshMessage(s, Object.assign({}, hb2, {
        hash: storeLib.meshMessageHash(hb2), isHeartbeat: true, instanceNonce: 'anc:11105:1000000',
      }));
    } finally { s.close(); }

    const ctx = { home, cwd: repo, env: {}, now };
    const roster = cli.cmdRoster({}, ctx);
    const rosterRow = roster.workspaces.find((w) => w.id === 'child-one');
    assert.ok(rosterRow, 'child-one must appear on the roster');
    assert.strictEqual(rosterRow.instances, 1, 'exactly one distinct nonce was seen');
    assert.ok(!rosterRow.hints.includes('instance-split'), 'a single instance must never be flagged as split');

    const s2 = storeLib.openStore({ home, hash: repoKey, backend });
    let diag;
    try { diag = cli.computeDiagnosis(s2, { home, env: {}, now }); } finally { s2.close(); }
    assert.strictEqual(diag.instanceSplits.length, 0, 'a single instance must never appear in instanceSplits');
  } finally { rm(home); rm(repo); }
});

test('d3d571495bf6 consumers: NO nonce at all -> no hint, row output matches the pre-fix (no instanceNonce keys) shape', () => {
  const home = tmpHome();
  const repo = makeGitRepo('consumers-none');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const top = inst.resolveWorktree(repo);
    const backend = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? 'sqlite' : 'journal';
    const now = Date.now();

    const s = storeLib.openStore({ home, hash: repoKey, backend });
    try {
      s.upsertRegistry({ id: 'child-legacy2', worktreePath: top, sessionId: 'session-legacy' });
      const hb1 = {
        from: 'child-legacy2', to: null, type: 'broadcast', message: 'working on A, no nonce',
        timestamp: now - 1000, urgency: 'low',
      };
      // No instanceNonce at all — the pre-fix / legacy-caller shape.
      storeLib.appendMeshMessage(s, Object.assign({}, hb1, { hash: storeLib.meshMessageHash(hb1), isHeartbeat: true }));
      const d1 = {
        from: 'child-legacy2', to: 'primary-legacy', type: 'direct', message: 'legacy direct send',
        timestamp: now - 900, urgency: 'normal',
      };
      storeLib.appendMeshMessage(s, Object.assign({}, d1, { hash: storeLib.meshMessageHash(d1) }));
    } finally { s.close(); }

    const ctx = { home, cwd: repo, env: {}, now };

    // roster: no `instances` key at all, no instance-split hint — byte-shape
    // identical to a row this feature never touched.
    const roster = cli.cmdRoster({}, ctx);
    const rosterRow = roster.workspaces.find((w) => w.id === 'child-legacy2');
    assert.ok(rosterRow, 'child-legacy2 must appear on the roster');
    assert.ok(!('instances' in rosterRow), 'a row with no instanceNonce must carry no `instances` key at all');
    assert.ok(!rosterRow.hints.includes('instance-split'), 'no instance-split hint without any instanceNonce');

    // diagnose: no entry in instanceSplits.
    const s2 = storeLib.openStore({ home, hash: repoKey, backend });
    let diag;
    try { diag = cli.computeDiagnosis(s2, { home, env: {}, now }); } finally { s2.close(); }
    assert.strictEqual(diag.instanceSplits.length, 0);

    // read-primary: the message row carries neither instanceNonceShort nor
    // fromLine — output is byte-identical to the pre-fix shape.
    const read = cli.cmdInboxMessages('primary-legacy', { 'ack-as-owner': true }, ctx, { ack: true, action: 'inbox read-primary' });
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.messages.length, 1);
    assert.ok(!('instanceNonceShort' in read.messages[0]), 'no instanceNonceShort key without an instanceNonce');
    assert.ok(!('fromLine' in read.messages[0]), 'no fromLine key without an instanceNonce');
  } finally { rm(home); rm(repo); }
});

// fl-wave3 fix (item 5): MESH_ROW_COPY_FIELDS (the shared table meshRowCopy
// uses for BOTH a fold's verbatim re-home and its forward) was simply missing
// `instanceNonce` — every meshRowCopy call therefore dropped a row's
// provenance, even though the ORIGINAL row (pre-fold) genuinely carried one.
test('fl-wave3: meshRowCopy carries instanceNonce through on BOTH the row (verbatim move) and message (forward) shapes', () => {
  const src = {
    sender: 'child-a', recipient: 'legacy-b', body: 'hi', ts: 1700000000000,
    mtype: 'direct', urgency: 'normal', needsReply: false, origHash: null,
    hash: 'deadbeef', isHeartbeat: false, instanceNonce: 'anc:12345:1000000',
  };
  const rowCopy = cli.meshRowCopy(src, 'row', { workspaceId: 'survivor-id' });
  assert.strictEqual(rowCopy.instanceNonce, 'anc:12345:1000000',
    'a verbatim re-home (row shape) must preserve instanceNonce like every other stored field');
  const msgCopy = cli.meshRowCopy(src, 'message', { recipient: 'survivor-id' });
  assert.strictEqual(msgCopy.instanceNonce, 'anc:12345:1000000',
    'a forward (message shape) must carry the ORIGINAL row\'s instanceNonce through, not drop it');
});

test('fl-wave3: a fold-forwarded message keeps its instanceNonce end-to-end — the survivor\'s read-primary reports the SAME instanceNonceShort', () => {
  const home = tmpHome();
  const main = makeGitRepo('fold-nonce');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const top = inst.resolveWorktree(main);
    const backend = storeLib.sqliteAvailable && storeLib.sqliteAvailable() ? 'sqlite' : 'journal';
    const LEGACY_ID = 'child-legacy-nonce';
    const CHILD_ID = 'child-builder-nonce';
    const NONCE = 'anc:33445:2000000';

    const s = storeLib.openStore({ home, hash: repoKey, backend });
    try {
      s.upsertRegistry({ id: LEGACY_ID, worktreePath: top, sessionId: 'legacy-sess' });
      const fields = { from: LEGACY_ID, to: LEGACY_ID, type: 'direct', message: 'stamped-with-nonce', timestamp: Date.now(), urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields), instanceNonce: NONCE }));
    } finally { s.close(); }

    // Registering CHILD_ID under the SAME worktree folds+retires LEGACY_ID,
    // forwarding its unread mail into the new survivor row.
    const reg = cli.run(['register', CHILD_ID, '--worktree', top, '--session', 'child-sess'], { home, cwd: main, backend, env: {} });
    assert.strictEqual(reg.result.ok, true, 'register should succeed: ' + JSON.stringify(reg.result));
    assert.deepStrictEqual(reg.result.retiredDuplicates, [LEGACY_ID], 'the legacy row must be retired by the fold');
    assert.strictEqual(reg.result.forwardedMessages, 1, 'the legacy message must be forwarded into the survivor');

    const read = cli.cmdInboxMessages(CHILD_ID, { 'ack-as-owner': true }, { home, cwd: main, backend, env: {} }, { ack: true, action: 'inbox read-primary' });
    assert.strictEqual(read.ok, true, JSON.stringify(read));
    const forwarded = read.messages.find((m) => m.body === 'stamped-with-nonce');
    assert.ok(forwarded, 'the forwarded message must be readable from the survivor');
    assert.strictEqual(forwarded.instanceNonceShort, cli.shortInstanceNonce(NONCE),
      'a fold-forwarded copy must keep its provenance — instanceNonceShort must match the ORIGINAL row\'s nonce, not be dropped');
  } finally {
    rm(main); rm(home);
  }
});
