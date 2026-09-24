'use strict';
// proves: plugins/anti-hall/scripts/devswarm.js#appendIntoPartition — every routed writer below writes only under the verified lock.
// PROOFS for tests/hygiene/partition-append-single-door.test.js. Every claim that a
// writer "runs under the destination's lock" or "only writes its own / the broadcast
// partition" is MEASURED here with tests/helpers/partition-lock-probe.js: for every
// row written into partition X, is X's per-id lock file held by the writing process
// at that instant? (That is exactly what makes the write safe against a rehome of X:
// rehome holds the same lock from snapshot to tombstone.) Each test names the claim
// it proves with a `proves: <file>#<function>` marker the hygiene test checks for.
//
// HERMETIC: every fixture HOME is a tmp dir; HOME/USERPROFILE are isolated; hook
// subprocesses get HOME=<tmp> from spawn-hook.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const recovery = require(path.join(ROOT, 'companion', 'lib', 'recovery.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const probeLib = require('../helpers/partition-lock-probe.js');
const { testHook } = require('../helpers/spawn-hook.js');

const PROBE = path.join(__dirname, '..', 'helpers', 'partition-lock-probe.js');
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lock-proof-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lock-proof-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => { const iso = tmpHome(); process.env.HOME = iso; process.env.USERPROFILE = iso; });
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});
function withProbe(fn) {
  const p = probeLib.install();
  try { fn(); } finally { p.uninstall(); }
  return p.records;
}
function assertAllHeld(recs, dest, label) {
  const into = recs.filter((r) => r.dest === dest);
  assert.ok(into.length > 0, label + ': expected at least one write into ' + dest + ' (vacuous otherwise): ' + JSON.stringify(recs));
  const unlocked = into.filter((r) => !r.held);
  assert.deepStrictEqual(unlocked, [], label + ': rows written into ' + dest + ' WITHOUT holding its lock');
}
function directFields(to, message, hash) {
  const f = { from: 'peer', to, type: 'direct', message, timestamp: Date.now(), urgency: 'normal' };
  return Object.assign(f, { hash: hash || storeLib.meshMessageHash(f) });
}

// ---------------------------------------------------------------------------
// child-turn (subprocess, probe preloaded)
// ---------------------------------------------------------------------------
test('proves: plugins/anti-hall/hooks/devswarm-child-turn.js#registerStoreDescriptor — the phantom-rescue fold writes into the child partition only under its lock', () => {
  const home = tmpHome();
  const out = path.join(home, 'probe.ndjson');
  const BUILDER = 'child-lockproof-rescue';
  try {
    const mesh = inst.primaryWorkspaceId(inst.resolveWorktree(REPO_CWD));
    const s = storeLib.openStore({ home, workspaceId: mesh, hash: REPO_KEY });
    try {
      s.upsertRegistry({ id: mesh, worktreePath: REPO_CWD, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
      storeLib.appendMeshMessage(s, directFields(mesh, 'rescue-me', 'lockproof-rescue'));
    } finally { s.close(); }
    const r = testHook('devswarm-child-turn.js', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-lp', prompt: 'go', cwd: REPO_CWD }, {
      home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: BUILDER, NODE_OPTIONS: '--require ' + PROBE, PARTITION_LOCK_PROBE_OUT: out },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const recs = probeLib.readRecords(out);
    assertAllHeld(recs, BUILDER, 'child-turn rescue');
    assert.ok(recs.some((x) => x.dest === BUILDER && x.body === 'rescue-me'), 'the rescued row was forwarded: ' + JSON.stringify(recs));
  } finally { rm(home); }
});

test('proves: plugins/anti-hall/hooks/devswarm-child-turn.js#retirePhantomWorktreeDuplicates — the phantom-descriptor retire forwards only under the survivor lock', () => {
  const home = tmpHome();
  const out = path.join(home, 'probe.ndjson');
  const PHANTOM = 'aaaaaaaa-bbbb-cccc-dddd-c45c1d4196'; // truncated uuid shape
  const CHILD = 'real-child-lockproof';
  try {
    const wdir = path.join(liveness.devswarmRoot(home), 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, PHANTOM + '.json'), JSON.stringify({
      id: PHANTOM, worktreePath: path.resolve(REPO_CWD), sessionId: 'phantom-dup-session',
      inboxPath: path.join(home, 'x', PHANTOM + '.ndjson'), cursorPath: path.join(home, 'x', PHANTOM + '.cursor'),
    }));
    const s = storeLib.openStore({ home, workspaceId: PHANTOM, hash: REPO_KEY, backend: 'journal' });
    try { storeLib.appendMeshMessage(s, directFields(PHANTOM, 'phantom-mail')); } finally { s.close(); }
    const r = testHook('devswarm-child-turn.js', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-lp2', prompt: 'go', cwd: REPO_CWD }, {
      home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: CHILD, ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal', NODE_OPTIONS: '--require ' + PROBE, PARTITION_LOCK_PROBE_OUT: out },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assertAllHeld(probeLib.readRecords(out), CHILD, 'child-turn phantom retire');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// devswarm.js writers (in-process probe)
// ---------------------------------------------------------------------------
test('proves: plugins/anti-hall/scripts/devswarm.js#retireWorktreeDuplicates — cmdRegister\'s duplicate fold forwards only under the survivor lock', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reg');
  const BUILDER = 'builder-lockproof-reg';
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const mesh = inst.primaryWorkspaceId(inst.resolveWorktree(repo));
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.upsertRegistry({ id: mesh, worktreePath: repo, sessionId: null });
      storeLib.appendMeshMessage(s, directFields(mesh, 'dup-mail'));
    } finally { s.close(); }
    const recs = withProbe(() => {
      const r = cli.cmdRegister(BUILDER, { worktree: [repo], session: ['sess-reg'] }, { home, cwd: repo, env: {}, backend: 'journal', now: Date.now() });
      assert.ok(r && r.ok, JSON.stringify(r));
    });
    assertAllHeld(recs, BUILDER, 'cmdRegister duplicate fold');
  } finally { rm(home); rm(repo); }
});

test('proves: plugins/anti-hall/scripts/devswarm.js#rehomeAcrossStores — a rehome writes the destination only under the id lock, even when its caller took none', () => {
  const home = tmpHome();
  const id = 'rehome-lockproof';
  try {
    const s = storeLib.openStore({ home, hash: 'from-lp', backend: 'journal' });
    try { s.upsertRegistry({ id, worktreePath: '/fake/lp', sessionId: 'sess' }); storeLib.appendMeshMessage(s, directFields(id, 'move-me')); } finally { s.close(); }
    const lockFile = recovery.lockPathFor(id, home);
    assert.ok(!fs.existsSync(lockFile), 'precondition: nobody (the caller included) holds the id lock');
    let out;
    const recs = withProbe(() => { out = cli.rehomeAcrossStores(home, id, 'from-lp', 'to-lp', { backend: 'journal', env: {} }); });
    assert.strictEqual(out.rehomed, true, JSON.stringify(out));
    assertAllHeld(recs, id, 'rehome copy');
  } finally { rm(home); }
});

test('proves: plugins/anti-hall/scripts/devswarm.js#cmdSend — a direct send writes the recipient partition only under its lock', () => {
  const home = tmpHome();
  const repo = makeGitRepo('send');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.upsertRegistry({ id: 'peer-lp', worktreePath: path.join(repo, 'nope'), sessionId: 's' }); } finally { s.close(); }
    const recs = withProbe(() => {
      const r = cli.run(['send', '--to', 'peer-lp', '--message', 'hello'], { home, cwd: repo, env: {}, backend: 'journal' });
      assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    });
    assertAllHeld(recs, 'peer-lp', 'send --to');
  } finally { rm(home); rm(repo); }
});

test('proves: plugins/anti-hall/scripts/devswarm.js#cmdArchiveRequest — archive-request writes the child partition only under its lock', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ar');
  try {
    const recs = withProbe(() => {
      const r = cli.run(['archive-request', 'child-lp', '--reason', 'done'], { home, cwd: repo, env: {}, backend: 'journal' });
      assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    });
    assertAllHeld(recs, 'child-lp', 'archive-request');
  } finally { rm(home); rm(repo); }
});

test('proves: plugins/anti-hall/scripts/devswarm.js#cmdHeartbeat — heartbeat writes ONLY the shared broadcast partition', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb');
  try {
    const reg = cli.run(['register-primary'], { home, cwd: repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-hb' }, backend: 'journal' });
    assert.strictEqual(reg.result.ok, true, JSON.stringify(reg.result));
    const recs = withProbe(() => {
      const r = cli.run(['heartbeat', reg.result.id, '--summary', 'working on it'], { home, cwd: repo, env: {}, backend: 'journal' });
      assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    });
    assert.ok(recs.length > 0, 'heartbeat wrote a row');
    assert.deepStrictEqual([...new Set(recs.map((r) => r.dest))], [storeLib.BROADCAST_PARTITION_ID]);
  } finally { rm(home); rm(repo); }
});

test('proves: plugins/anti-hall/scripts/devswarm.js#cmdMergeVerb — merge writes ONLY the shared broadcast partition', () => {
  const home = tmpHome();
  const repo = makeGitRepo('merge');
  try {
    const io = { run: () => ({ ok: true, raw: '{}' }) };
    const recs = withProbe(() => { cli.run(['merge'], { home, cwd: repo, env: {}, backend: 'journal', io }); });
    assert.ok(recs.length > 0, 'merge wrote its broadcast');
    assert.deepStrictEqual([...new Set(recs.map((r) => r.dest))], [storeLib.BROADCAST_PARTITION_ID]);
  } finally { rm(home); rm(repo); }
});

test('proves: plugins/anti-hall/companion/lib/devswarm-store.js#* — the store API writes exactly where it is told (direct -> `to`, broadcast -> the broadcast partition)', () => {
  const home = tmpHome();
  try {
    const recs = withProbe(() => {
      const s = storeLib.openStore({ home, hash: 'api-lp', backend: 'journal' });
      try {
        storeLib.appendMeshMessage(s, directFields('dest-a', 'x'));
        const b = { from: 'p', to: null, type: 'broadcast', message: 'y', timestamp: Date.now(), urgency: 'normal' };
        storeLib.appendMeshMessage(s, Object.assign(b, { hash: storeLib.meshMessageHash(b) }));
      } finally { s.close(); }
    });
    assert.deepStrictEqual(recs.map((r) => r.dest), ['dest-a', storeLib.BROADCAST_PARTITION_ID]);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// routed writers: escalation retry intent, archived-only destinations
// ---------------------------------------------------------------------------
test('recovery escalation into an UNREGISTERED parent: nothing written, a retry intent is persisted, and the next sweep delivers it under the parent lock', () => {
  const home = tmpHome();
  const repo = makeGitRepo('esc');
  try {
    const d = { id: 'child-esc', worktreePath: repo, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const parentId = inst.primaryWorkspaceId(inst.resolveMainWorktree(repo) || repo);
    const repoKey = repokey.repoKeyForWorktree(repo);
    const now = Date.now();
    const first = withProbe(() => {
      const r = recovery.pokeOrEscalate(d, { status: 'stale', staleSince: now - 600000, nudgeAttempts: 0, nudgedAt: null }, { home, now });
      assert.strictEqual(r.action, 'escalate');
    });
    assert.deepStrictEqual(first.filter((x) => x.dest === parentId), [], 'nothing written into an unregistered parent');
    const intent = recovery.readEscalationIntent(home, d.id);
    assert.ok(intent && intent.parentId === parentId, 'a retry intent was persisted: ' + JSON.stringify(intent));

    // The parent registers; the next sweep (verdict now `escalated`) retries.
    const ps = storeLib.openStore({ home, workspaceId: parentId, hash: repoKey });
    try { ps.upsertRegistry({ id: parentId, worktreePath: repo, sessionId: 'sess-parent' }); } finally { ps.close(); }
    const verdict = JSON.parse(fs.readFileSync(liveness.livenessPathFor(d.id, home), 'utf8'));
    const second = withProbe(() => { recovery.pokeOrEscalate(d, verdict, { home, now: now + 1000 }); });
    assertAllHeld(second, parentId, 'escalation retry');
    assert.strictEqual(recovery.readEscalationIntent(home, d.id), null, 'the intent is marked delivered');
    const s = storeLib.openStore({ home, workspaceId: parentId, hash: repoKey });
    try { assert.strictEqual(s.listMessages(parentId, {}).filter((m) => /child-esc/.test(m.body)).length, 1, 'delivered exactly once'); } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('LIVE-origin rows never land in an ARCHIVED-only partition (pending), unless the caller moves archived-origin rows (allowArchivedDest)', () => {
  const home = tmpHome();
  try {
    const root = liveness.devswarmRoot(home);
    fs.mkdirSync(path.join(root, 'archived'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archived', 'arch-dest.json'), JSON.stringify({ id: 'arch-dest', worktreePath: '/fake/arch' }));
    const s = storeLib.openStore({ home, hash: 'arch-lp', backend: 'journal' });
    try {
      s.upsertRegistry({ id: 'cand-live', worktreePath: '/fake/arch', sessionId: null });
      storeLib.appendMeshMessage(s, directFields('cand-live', 'live-mail'));
      const cand = () => s.listRegistry().find((x) => x.id === 'cand-live');
      const a = cli.foldGroupIntoSurvivor(s, home, 'arch-dest', [cand()]);
      assert.deepStrictEqual(a.skipped, [{ id: 'cand-live', reason: 'survivor-gone' }], JSON.stringify(a));
      assert.strictEqual(s.listMessages('arch-dest', {}).length, 0, 'nothing forwarded into the quiet archived partition');
      const b = cli.foldGroupIntoSurvivor(s, home, 'arch-dest', [cand()], { allowArchivedDest: true });
      assert.strictEqual(b.forwarded, 1, JSON.stringify(b));
    } finally { s.close(); }
  } finally { rm(home); }
});
