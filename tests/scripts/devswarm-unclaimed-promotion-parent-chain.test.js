'use strict';
// `unclaimed:<id>` promotion (defect 54a6539e2d69, D10) — two field-confirmed
// gaps in the carry-out (e) machinery:
//
// (B1) realSessionIdFrom ONLY read `--session` or CLAUDE_CODE_SESSION_ID.
// MEASURED: CLAUDE_CODE_SESSION_ID is set in a DevSwarm-launched session's own
// Bash shell, but ABSENT in a plain (non-DevSwarm) Claude Code session's Bash
// shell. So a caller running an ordinary session had NO path to a real
// session id at all — promotion could never fire for it, no matter how long
// the session ran. FIX: deriveCallerSessionIdFromProcessTree walks the
// caller's own parent-pid chain looking for a harness session file
// (`<home>/.claude/sessions/<pid>.json`, the same directory
// companion/lib/liveness.js's sessionPidAlive already reads) whose recorded
// `cwd` resolves inside the caller's own worktree, and uses ITS sessionId.
// Fails closed (no promotion) when the cwd check fails or nothing matches.
//
// (B2) promoteUnclaimedSession early-returned unconditionally unless the
// DESCRIPTOR still equaled the exact `unclaimed:<id>` marker — so a row whose
// descriptor was ALREADY promoted (by an earlier, possibly partially-failed
// call) but whose REGISTRY row still carried the marker (the registry-write
// step is wrapped in a swallowing try/catch) could never be repaired: nothing
// ever re-invoked promotion with the descriptor still matching the guard.
// FIX: promoteUnclaimedSession now separately reads the CURRENT registry
// sessionId and repairs whichever side still carries the marker to match the
// other side's EXISTING real value, in both directions, without ever
// inventing a third value.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-unclaimed-pc-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-unclaimed-pc-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

function writeSessionFile(home, pid, rec) {
  const dir = liveness.sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid) + '.json'), JSON.stringify(rec));
}
function writeDescriptor(home, id, descriptor) {
  const wsDir = path.join(liveness.devswarmRoot(home), 'workspaces');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));
}
function readDescriptor(home, id) {
  return JSON.parse(fs.readFileSync(path.join(liveness.devswarmRoot(home), 'workspaces', id + '.json'), 'utf8'));
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const bctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };
  const registrySid = (home, repoKey, id) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { const r = s.listRegistry().find((x) => x.id === id); return r ? r.sessionId : null; }
    finally { s.close(); }
  };

  // (B1a) RED/GREEN: no --session flag, no CLAUDE_CODE_SESSION_ID env var, a
  // synthetic parent-pid chain with a session file two hops up whose cwd
  // matches the caller's worktree -> promotion fires using that session's id.
  test(`[${B.name}] promotion fires with NO --session and NO env var, via the parent-pid-chain session-file fallback`, () => {
    const home = tmpHome();
    const main = makeGitRepo('parentchain-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      writeSessionFile(home, 9999, { pid: 9999, sessionId: 'real-session-from-parent-chain', cwd: wt, status: 'running' });

      const io = { run: (s) => (s.args[1] === 'message-count' ? { ok: true, raw: '0' } : { ok: false, error: 'unexpected' }) };
      const ctx = bctx(home, {
        cwd: main,
        io,
        sessionDeriveOpts: {
          pid: 9001,
          ppidOf: (p) => (p === 9001 ? 9999 : null),
          // R22 P2 pid-reuse/staleness guard: a no-throw `kill` simulates a
          // LIVE pid (the file's own mtime becomes `sinceMs`, and a real
          // process's start time cannot be checked here, so `ps` is left
          // unmocked — pidIsAlive treats a missing start time as "no
          // opinion" and trusts the recorded session id).
          kill: () => {},
        },
      });
      const result = cli.run(['inbox', 'pull', id], ctx);
      assert.strictEqual(result.result.ok, true, 'pull itself must still succeed');

      const desc = readDescriptor(home, id);
      assert.strictEqual(desc.sessionId, 'real-session-from-parent-chain', 'descriptor promoted via the derived session id, with no --session/env present');
      assert.strictEqual(registrySid(home, repoKey, id), 'real-session-from-parent-chain', 'registry promoted in lockstep (write-through)');
    } finally { rm(main); rm(home); }
  });

  // (B1d) SAFETY (R22 P2): the session file names a pid that is PROVABLY dead
  // (kill throws ESRCH) -> the pid-reuse/staleness guard rejects it and the
  // chain keeps walking; with nothing else in the chain, no promotion fires.
  test(`[${B.name}] SAFETY: a parent-chain session file naming a DEAD pid never promotes (pid-reuse/staleness guard)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('parentchain-deadpid-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      writeSessionFile(home, 9999, { pid: 9999, sessionId: 'dead-pid-session', cwd: wt, status: 'running' });

      const deadKill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
      const ctx = bctx(home, {
        cwd: main,
        sessionDeriveOpts: {
          pid: 9001,
          ppidOf: (p) => (p === 9001 ? 9999 : null),
          kill: deadKill,
        },
      });
      cli.run(['inbox', 'pull', id], ctx);

      const desc = readDescriptor(home, id);
      assert.strictEqual(desc.sessionId, 'unclaimed:' + id, 'a dead-pid session file must never be trusted; row stays unclaimed:');
      assert.strictEqual(registrySid(home, repoKey, id), 'unclaimed:' + id, 'registry likewise untouched');
    } finally { rm(main); rm(home); }
  });

  // (B1b) SAFETY: the session file exists but its cwd does NOT resolve inside
  // the caller's worktree (an unrelated ancestor session) -> promotion must
  // NOT fire; the row stays `unclaimed:`.
  test(`[${B.name}] SAFETY: a parent-chain session file with a MISMATCHED cwd never promotes (fails closed)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('parentchain-mismatch-' + B.name);
    const other = makeGitRepo('parentchain-other-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      // Session file names an UNRELATED worktree's cwd.
      writeSessionFile(home, 9999, { pid: 9999, sessionId: 'unrelated-session-id', cwd: topOf(other), status: 'running' });

      const ctx = bctx(home, {
        cwd: main,
        sessionDeriveOpts: { pid: 9001, ppidOf: (p) => (p === 9001 ? 9999 : null) },
      });
      cli.run(['inbox', 'pull', id], ctx);

      const desc = readDescriptor(home, id);
      assert.strictEqual(desc.sessionId, 'unclaimed:' + id, 'a cwd-mismatched session file must never be trusted; row stays unclaimed:');
      assert.strictEqual(registrySid(home, repoKey, id), 'unclaimed:' + id, 'registry likewise untouched');
    } finally { rm(main); rm(home); rm(other); }
  });

  // (B1c) SAFETY: no session file anywhere in the (bounded) chain -> no
  // promotion; the chain walk terminates instead of hanging or throwing.
  test(`[${B.name}] SAFETY: no session file found anywhere in a bounded parent chain -> no promotion, no throw`, () => {
    const home = tmpHome();
    const main = makeGitRepo('parentchain-none-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });

      const ctx = bctx(home, {
        cwd: main,
        sessionDeriveOpts: { pid: 9001, ppidOf: (p) => (p < 9007 ? p + 1 : null) },
      });
      assert.doesNotThrow(() => cli.run(['inbox', 'pull', id], ctx));
      const desc = readDescriptor(home, id);
      assert.strictEqual(desc.sessionId, 'unclaimed:' + id, 'no session file anywhere in the chain -> stays unclaimed:');
    } finally { rm(main); rm(home); }
  });

  // (B2a) RED/GREEN: DESCRIPTOR already promoted (real id), REGISTRY still
  // carries the marker for the SAME id — the "registry write failed on an
  // earlier promotion call" shape. A direct promoteUnclaimedSession call
  // (mirroring what maybePromoteUnclaimed does once ownership is verified)
  // must repair the registry to the descriptor's EXISTING real value.
  test(`[${B.name}] promoteUnclaimedSession repairs the REGISTRY when the descriptor is already promoted but the registry still says unclaimed:`, () => {
    const home = tmpHome();
    const main = makeGitRepo('divg-desc-ahead-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'already-real-uuid' });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });

      const ctx = { home, backend: B.backend, env: {}, cwd: main };
      const r = cli.promoteUnclaimedSession(home, id, 'some-other-incoming-session-id', ctx);
      assert.strictEqual(r.promoted, false, 'this is a resync, not a NEW promotion');

      assert.strictEqual(readDescriptor(home, id).sessionId, 'already-real-uuid', 'the descriptor is untouched: its existing real value is authoritative');
      assert.strictEqual(registrySid(home, repoKey, id), 'already-real-uuid', 'the registry is repaired to MATCH the descriptor, not to the call\'s own sessionId argument');
    } finally { rm(main); rm(home); }
  });

  // (B2b) reverse direction: REGISTRY already promoted, DESCRIPTOR still
  // carries the marker.
  test(`[${B.name}] promoteUnclaimedSession repairs the DESCRIPTOR when the registry is already promoted but the descriptor still says unclaimed:`, () => {
    const home = tmpHome();
    const main = makeGitRepo('divg-reg-ahead-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'already-real-uuid-registry' });

      const ctx = { home, backend: B.backend, env: {}, cwd: main };
      const r = cli.promoteUnclaimedSession(home, id, 'some-other-incoming-session-id', ctx);
      assert.strictEqual(r.promoted, false, 'this is a resync, not a NEW promotion');

      assert.strictEqual(readDescriptor(home, id).sessionId, 'already-real-uuid-registry', 'the descriptor is repaired to MATCH the registry\'s existing real value');
      assert.strictEqual(registrySid(home, repoKey, id), 'already-real-uuid-registry', 'the registry is untouched');
    } finally { rm(main); rm(home); }
  });

  // (B2c) REGRESSION: both sides still genuinely unclaimed -> classic
  // promotion still fires exactly as before (write-through, promoted:true).
  test(`[${B.name}] REGRESSION: classic promotion (both sides still unclaimed:) is unaffected by the divergence-repair branches`, () => {
    const home = tmpHome();
    const main = makeGitRepo('classic-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });

      const ctx = { home, backend: B.backend, env: {}, cwd: main };
      const r = cli.promoteUnclaimedSession(home, id, 'genuinely-new-session-id', ctx);
      assert.strictEqual(r.promoted, true);
      assert.strictEqual(r.to, 'genuinely-new-session-id');
      assert.strictEqual(readDescriptor(home, id).sessionId, 'genuinely-new-session-id');
      assert.strictEqual(registrySid(home, repoKey, id), 'genuinely-new-session-id');
    } finally { rm(main); rm(home); }
  });
}
