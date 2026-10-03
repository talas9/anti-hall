'use strict';
// devswarm-supervisor.js — DEFECT 17685a91b783 (P1): the automatic sweep was
// observed forcing a parent-store escalation notice ("child <id> idle 0m —
// reassign or archive") for a workspace whose descriptor had just been
// (re)registered, and for a workspace the Primary had already ruled done. The
// escalation notice text itself (companion/lib/recovery.js's
// notifyParentEscalation, including its lack of a stamped `sender` field) is
// OUT OF SCOPE for this fix — see the task's final report for the STOP/design
// note on that sub-part; recovery.js is neither an owned nor an explicitly
// forbidden file for this task, but achieving a filterable `sender` would
// require switching its appendMessage call to the mesh-aware appendMeshRow
// primitive, a store-shape decision beyond this fix's scope.
//
// This file covers the two suppressions that ARE fully implementable inside
// companion/devswarm-supervisor.js (owned): a post-spawn grace period (via the
// descriptor file's own mtime) and a done/archive-ready exclusion (sharing
// Defect A's derivation — hooks/devswarm-parent-gate.js's isArchiveReadyFor —
// reimplemented independently here as isArchiveReadyForSupervisor since that
// hook is a side-effecting Stop-hook script, never requirable from a daemon
// module). Both suppress ONLY whether sweepOnce ACTS on a `stale` verdict
// (pokeOrEscalate + the mesh-urgency forced notify) — never the persisted
// verdict itself.
//
// MUTATION LIST (each proven RED against these tests, GREEN against the real
// fix — see the pasted transcript in this task's final report):
//   M1: delete the `if (graced || done) { ... } else { ... }` gate around the
//       pokeOrEscalate/notify call (revert to calling pokeOrEscalate
//       unconditionally on `stale`) -> kills "GRACE: a stale verdict for a
//       just-registered descriptor is NOT poked/escalated".
//   M2: make withinPostSpawnGrace always return false (ignore the descriptor
//       mtime entirely) -> kills the same GRACE test AND the "GRACE negative
//       control" test would then trivially "pass" for the wrong reason, so it
//       is cross-checked against the "DONE" test which does not depend on
//       withinPostSpawnGrace at all.
//   M3: make isArchiveReadyForSupervisor return `true` unconditionally ->
//       kills "NEGATIVE CONTROL: past grace, not done -> pokeOrEscalate still
//       invoked" is NOT killed by this (it doesn't reach the done check when
//       genuinely not done via the real summary), so the real kill target is
//       "DONE: archive_ready workspace is NOT poked/escalated even past
//       grace" — a passing baseline that isn't distinguishing on its own is
//       insufficient, which is why the negative control below asserts
//       pokeOrEscalate WAS called with archive_ready explicitly false.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-grace-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
function writeDescriptor(home, d) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  fs.writeFileSync(path.join(dir, d.id + '.json'), JSON.stringify(full));
}

test('GRACE: a stale verdict for a just-registered descriptor is NOT poked/escalated', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' }); // mtime = now
    let pokeCalls = 0;
    const res = M.sweepOnce({
      home,
      now: Date.now(),
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => { pokeCalls++; return { action: 'escalate' }; },
        readMeshUrgency: () => null,
      },
    });
    assert.strictEqual(pokeCalls, 0, 'a freshly-registered descriptor must not be poked/escalated');
    assert.strictEqual(res[0].poke.action, 'suppressed');
    assert.strictEqual(res[0].poke.reason, 'post-spawn-grace');
  } finally { cleanup(); }
});

test('GRACE NEGATIVE CONTROL: past the grace window, a genuinely stale descriptor IS still poked/escalated', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    // Backdate the descriptor's mtime well past any plausible grace window.
    const old = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(path.join(descriptorsDir(home), 'a.json'), old / 1000, old / 1000);
    let pokeCalls = 0;
    const res = M.sweepOnce({
      home,
      now: Date.now(),
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => { pokeCalls++; return { action: 'escalate' }; },
        readMeshUrgency: () => null,
        // Not archive_ready — resolveRepoKey returning null makes
        // isArchiveReadyForSupervisor fail closed to false without touching git.
        repoKeyForWorktree: () => null,
      },
    });
    assert.strictEqual(pokeCalls, 1, 'a genuinely-stale, non-fresh, non-done descriptor must still be poked/escalated');
    assert.strictEqual(res[0].poke.action, 'escalate');
  } finally { cleanup(); }
});

test('DONE: an archive_ready workspace is NOT poked/escalated even past the grace window', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const old = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(path.join(descriptorsDir(home), 'a.json'), old / 1000, old / 1000);
    let pokeCalls = 0;
    let archiveCheckArgs = null;
    const res = M.sweepOnce({
      home,
      now: Date.now(),
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => { pokeCalls++; return { action: 'escalate' }; },
        readMeshUrgency: () => null,
        // isArchiveReadyForSupervisor is exercised in isolation (with a real
        // repoKeyForWorktree/fs stub) by the dedicated unit test below; here it
        // is stubbed directly so this test isolates sweepOnce's WIRING
        // (does the suppression actually gate pokeOrEscalate?) from that
        // function's own internals, and so it never collides with sweepOnce's
        // own shared `deps.fs` (which readDescriptors/writeVerdict also use —
        // stubbing it here would starve readDescriptors's readdirSync).
        isArchiveReadyForSupervisor: (id, worktreePath, h) => {
          archiveCheckArgs = { id, worktreePath, h };
          return true;
        },
      },
    });
    assert.strictEqual(pokeCalls, 0, 'a done (archive_ready) workspace must not be poked/escalated');
    assert.strictEqual(res[0].poke.action, 'suppressed');
    assert.strictEqual(res[0].poke.reason, 'archive-ready');
    assert.strictEqual(archiveCheckArgs.id, 'a');
    assert.strictEqual(archiveCheckArgs.worktreePath, '/wt/a');
  } finally { cleanup(); }
});

test('DONE NEGATIVE CONTROL: past grace, archive_ready EXPLICITLY false -> pokeOrEscalate still invoked', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const old = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(path.join(descriptorsDir(home), 'a.json'), old / 1000, old / 1000);
    let pokeCalls = 0;
    const res = M.sweepOnce({
      home,
      now: Date.now(),
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => { pokeCalls++; return { action: 'escalate' }; },
        readMeshUrgency: () => null,
        isArchiveReadyForSupervisor: () => false,
      },
    });
    assert.strictEqual(pokeCalls, 1, 'archive_ready:false must never suppress a genuine neglect notice');
    assert.strictEqual(res[0].poke.action, 'escalate');
  } finally { cleanup(); }
});

test('withinPostSpawnGrace: unit — fail-closed on disabled/absent/future-mtime', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const p = path.join(descriptorsDir(home), 'a.json');
    const now = Date.now();
    assert.strictEqual(M.withinPostSpawnGrace('a', home, now, 0), false, 'graceMs<=0 disables it');
    assert.strictEqual(M.withinPostSpawnGrace('missing-id', home, now, 120000), false, 'absent descriptor -> false');
    assert.strictEqual(M.withinPostSpawnGrace('a', home, now, 120000), true, 'freshly-written descriptor is within grace');
    const future = now + 60 * 60 * 1000;
    fs.utimesSync(p, future / 1000, future / 1000);
    assert.strictEqual(M.withinPostSpawnGrace('a', home, now, 120000), false, 'a future mtime (clock skew) must fail CLOSED, not open');
  } finally { cleanup(); }
});

test('isArchiveReadyForSupervisor: unit — fail-closed on unresolvable repoKey / unreadable summary / absent id', () => {
  assert.strictEqual(
    M.isArchiveReadyForSupervisor('a', '/wt/a', '/home', { repoKeyForWorktree: () => null }),
    false,
  );
  assert.strictEqual(
    M.isArchiveReadyForSupervisor('a', '/wt/a', '/home', {
      repoKeyForWorktree: () => 'repo-x',
      fs: { readFileSync: () => { throw new Error('ENOENT'); } },
    }),
    false,
  );
  assert.strictEqual(
    M.isArchiveReadyForSupervisor('a', '/wt/a', '/home', {
      repoKeyForWorktree: () => 'repo-x',
      fs: { readFileSync: () => JSON.stringify({ workspaces: { someOtherId: { archive_ready: true } } }) },
    }),
    false,
  );
});
