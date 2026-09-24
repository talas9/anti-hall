'use strict';
// Review round 6 regressions:
//   P1a parked escalation intents are retried by EVERY supervisor sweep, even when
//       the child is sticky-`escalated` (pokeOrEscalate no longer runs for it).
//   P1b a parked escalation is VISIBLE: the Primary's per-turn injection, its Stop
//       gate, and doctor all name it (with the register-primary command).
//   P1c cross-store migrate re-reads the source tail after the copy and copies the
//       delta until a pass copies nothing; not stable within the bound -> verified:false.
//   LOW withIdLock refuses a Promise-returning callback (and still releases).
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
const supervisor = require(path.join(ROOT, 'companion', 'devswarm-supervisor.js'));
const doctorDevswarm = require(path.join(ROOT, 'companion', 'lib', 'doctor-devswarm.js'));
const migrate = require(path.join(ROOT, 'companion', 'devswarm-migrate.js'));
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const { testHook } = require('../helpers/spawn-hook.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-p3v7-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-p3v7-repo-' + tag + '-'));
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

// parkIntent(home, worktree, childId) — a real escalation to an UNREGISTERED parent.
function parkIntent(home, worktree, childId) {
  const now = Date.now();
  recovery.notifyParentEscalation({ id: childId, worktreePath: worktree, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { status: 'stale', staleSince: now - 600000 }, { home, now });
  const it = recovery.readEscalationIntent(home, childId);
  assert.ok(it, 'precondition: the intent is parked');
  return it;
}
function registerParent(home, it, worktree) {
  const s = storeLib.openStore({ home, workspaceId: it.parentId, hash: it.repoKey || undefined });
  try { s.upsertRegistry({ id: it.parentId, worktreePath: worktree, sessionId: 'sess-parent' }); } finally { s.close(); }
}
function parentNotices(home, it) {
  const s = storeLib.openStore({ home, workspaceId: it.parentId, hash: it.repoKey || undefined });
  try { return s.listMessages(it.parentId, {}).filter((m) => m.body.includes(it.childId)); } finally { s.close(); }
}

// ---------------------------------------------------------------------------
// P1a
// ---------------------------------------------------------------------------
test('P1a a parked escalation is delivered by the next supervisor sweep even though the child is sticky-escalated', () => {
  const home = tmpHome();
  const repo = makeGitRepo('drain');
  try {
    const it = parkIntent(home, repo, 'child-sticky');
    registerParent(home, it, repo);
    let pokes = 0;
    const res = supervisor.sweepOnce({
      home, env: {},
      deps: {
        readDescriptors: () => [{ id: 'child-sticky', worktreePath: repo, sessionId: 'x' }],
        computeLiveness: () => ({ status: 'escalated', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 3 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => { pokes++; return { action: 'escalate' }; },
        readMeshUrgency: () => null,
      },
    });
    assert.strictEqual(pokes, 0, 'precondition: a sticky-escalated child never reaches pokeOrEscalate');
    assert.strictEqual(parentNotices(home, it).length, 1, 'the sweep delivered the parked notice: ' + JSON.stringify(res.escalationsDrained));
    assert.strictEqual(recovery.readEscalationIntent(home, 'child-sticky'), null, 'the intent is now a delivered record');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// P1b
// ---------------------------------------------------------------------------
const REPO_CWD = process.cwd();
function primaryIdHere() { return inst.primaryWorkspaceId(inst.resolveWorktree(REPO_CWD)); }
function parkForHere(home, childId) {
  // Parked against THIS checkout's Primary id (the hooks resolve it from cwd).
  const dir = path.join(home, '.anti-hall', 'devswarm', 'escalation-pending');
  fs.mkdirSync(dir, { recursive: true });
  const intent = { childId, parentId: primaryIdHere(), repoKey: null, row: { workspaceId: primaryIdHere(), ts: Date.now() - 3600000, hash: 'escalate:' + childId + ':1', body: 'child ' + childId + ' idle — reassign or archive' }, lastStatus: 'gone' };
  fs.writeFileSync(recovery.escalationIntentPath(home, childId), JSON.stringify(intent));
}

test('P1b the Primary\'s per-turn injection names a parked escalation and the register-primary command', () => {
  const home = tmpHome();
  try {
    parkForHere(home, 'child-parked-inbox');
    const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-p1b', prompt: 'go', cwd: REPO_CWD }, {
      home, env: { DEVSWARM_REPO_ID: 'repo-1' },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const ctx = String(r.stdout);
    assert.match(ctx, /ESCALATIONS NOT DELIVERED/, 'stdout=' + ctx.slice(0, 400));
    assert.match(ctx, /child-parked-inbox/);
    assert.match(ctx, /register-primary/);
  } finally { rm(home); }
});

test('P1b the Primary\'s Stop gate blocks on a parked escalation and says how to deliver it', () => {
  const home = tmpHome();
  try {
    parkForHere(home, 'child-parked-gate');
    const r = testHook('devswarm-parent-gate.js', { hook_event_name: 'Stop', session_id: 'sess-p1b-gate', cwd: REPO_CWD }, {
      home, env: { DEVSWARM_REPO_ID: 'repo-1' },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    let out = null;
    try { out = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (_) { out = null; }
    assert.ok(out && out.decision === 'block', 'stdout=' + r.stdout);
    assert.match(out.reason, /child-parked-gate/);
    assert.match(out.reason, /register-primary/);
  } finally { rm(home); }
});

test('P1b doctor lists undelivered escalations (WARN) and counts delivered records; nothing is removed', () => {
  const home = tmpHome();
  const repo = makeGitRepo('doc');
  try {
    const it = parkIntent(home, repo, 'child-doc');
    const warn = doctorDevswarm.escalationIntentsCheck({ home, now: Date.now() });
    assert.strictEqual(warn.status, 'WARN');
    assert.match(warn.message, /1 undelivered/);
    assert.match(warn.message, /child-doc/);
    assert.match(warn.message, /register-primary/);
    registerParent(home, it, repo);
    recovery.drainEscalationIntents(home, { now: Date.now() });
    const ok = doctorDevswarm.escalationIntentsCheck({ home, now: Date.now() });
    assert.strictEqual(ok.status, 'PASS', ok.message);
    assert.match(ok.message, /0 undelivered; 1 delivered record/);
    assert.ok(fs.existsSync(recovery.escalationIntentPath(home, 'child-doc')), 'the delivered record is kept (no automated deletion)');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// P1c
// ---------------------------------------------------------------------------
function seedLegacy(home, hash, id, worktree, bodies) {
  const s = storeLib.openStore({ home, backend: 'journal', env: {}, hash });
  try {
    s.upsertRegistry({ id, worktreePath: worktree, sessionId: 's-' + id, inboxPath: null, cursorPath: null, nudgeCommand: null });
    for (const b of bodies) s.appendMessage({ workspaceId: id, body: b, hash: 'legacy-' + b });
  } finally { s.close(); }
}

test('P1c migrate copies a legacy append that lands between the copy and the verify (delta re-read)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('mig');
  const HASH = 'aaaaaaaa';
  const id = 'child-mig';
  try {
    seedLegacy(home, HASH, id, repo, ['m1', 'm2']);
    const repoKey = repokey.repoKeyForWorktree(repo);
    const origOpen = storeLib.openStore;
    let injected = false;
    storeLib.openStore = (o) => {
      const h = origOpen(o);
      if (o && o.hash === repoKey && !injected) {
        const realUpsert = h.upsertRegistry.bind(h);
        h.upsertRegistry = (d) => {
          if (!injected) { // a legacy writer (ingest) appends to the SOURCE right after the copy
            injected = true;
            const legacy = origOpen({ home, backend: 'journal', env: {}, hash: HASH });
            try { legacy.appendMessage({ workspaceId: id, body: 'late', hash: 'legacy-late' }); } finally { legacy.close(); }
          }
          return realUpsert(d);
        };
      }
      return h;
    };
    let rep;
    try { rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {} }); } finally { storeLib.openStore = origOpen; }
    assert.ok(injected, 'the injection ran');
    const w = rep.migrated.find((m) => m.id === id);
    const dst = storeLib.openStore({ home, backend: 'journal', env: {}, hash: repoKey });
    let bodies;
    try { bodies = dst.listMessages(id).map((m) => m.body).sort(); } finally { dst.close(); }
    assert.deepStrictEqual(bodies, ['late', 'm1', 'm2'], 'the late legacy row reached the repoKey store: ' + JSON.stringify(w));
    assert.strictEqual(w.verified, true);
  } finally { rm(home); rm(repo); }
});

test('P1c migrate whose source never stops growing within the bound is NOT verified (never reported done)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('mig2');
  const HASH = 'bbbbbbbb';
  const id = 'child-mig2';
  try {
    seedLegacy(home, HASH, id, repo, ['a']);
    const origOpen = storeLib.openStore;
    let n = 0;
    storeLib.openStore = (o) => {
      const h = origOpen(o);
      if (o && o.hash === HASH) {
        const realList = h.listMessages.bind(h);
        h.listMessages = (wid, opts) => {
          const legacy = origOpen({ home, backend: 'journal', env: {}, hash: HASH });
          try { legacy.appendMessage({ workspaceId: id, body: 'grow-' + (++n), hash: 'legacy-grow-' + n }); } finally { legacy.close(); }
          return realList(wid, opts);
        };
      }
      return h;
    };
    let rep;
    try { rep = migrate.migrateHashStoresToRepoName({ home, backend: 'journal', env: {} }); } finally { storeLib.openStore = origOpen; }
    const w = rep.migrated.find((m) => m.id === id);
    assert.strictEqual(w.verified, false, JSON.stringify(w));
    assert.strictEqual(rep.verifiedAll, false);
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// LOW
// ---------------------------------------------------------------------------
test('LOW withIdLock refuses a Promise-returning callback, and the lock is still released', () => {
  const home = tmpHome();
  try {
    assert.throws(() => cli.withIdLock('async-id', home, async () => 1), /returned a Promise/);
    assert.strictEqual(cli.isIdLockHeld('async-id', home), false, 'the held-lock record is cleared');
    assert.ok(!fs.existsSync(recovery.lockPathFor('async-id', home)), 'the lock file is released');
    assert.strictEqual(cli.withIdLock('async-id', home, () => 7), 7, 'a synchronous callback still works');
  } finally { rm(home); }
});
