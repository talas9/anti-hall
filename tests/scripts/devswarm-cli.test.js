'use strict';
// devswarm CLI (scripts/devswarm.js) — exercised in-process via run(argv, ctx)
// with an injected tmp HOME + forced journal backend, so the suite is
// deterministic on every node version (18/20 have no node:sqlite).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const pullLib = require('../../plugins/anti-hall/companion/lib/devswarm-pull.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-cli-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
// v0.57 mesh (D24): default ctx.cwd to a NON-git directory (fakeCwd, defined
// below — hoisted, safe to reference here) so every test in this file that does
// NOT explicitly pass its own `cwd` resolves repoKey===null and every
// D24-rekeyed store caller (register/gate/archive/inbox-messages) falls back to
// its EXISTING pre-mesh per-id hash selection — this file is about GENERIC CLI
// mechanics, not the v0.57 mesh rekey itself (which has its own dedicated tests,
// tests/scripts/devswarm-send.test.js + tests/companion/devswarm-ingest-mesh.test.js).
// A test that explicitly overrides `cwd` to a REAL git worktree still exercises
// the repoKey path (Object.assign below lets `over.cwd` win).
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {}, cwd: fakeCwd(home) }, over || {});

test('register writes the descriptor + store registry + summary projection', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'inbox.ndjson');
    const cursor = path.join(home, 'cursor.json');
    const r = cli.run(['register', 'w1', '--worktree', '/wt/w1', '--session', 'sess-1',
      '--inbox', inbox, '--cursor', cursor, '--nudge', 'echo', '--nudge', 'poke'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'registered');
    // descriptor on disk, sessionId populated (closes the null-gap)
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'w1'), 'utf8'));
    assert.equal(desc.sessionId, 'sess-1');
    assert.equal(desc.ownerKey, storeLib.hashFromWorkspaceId('w1'));
    assert.deepEqual(desc.nudgeCommand, ['echo', 'poke']);
    // store registry + summary reflect it (this workspace's PER-PROJECT summary)
    const sum = storeLib.readSummary(home, 'w1');
    assert.ok(sum && sum.workspaces && sum.workspaces.w1);
  } finally { rm(home); }
});

// ---- P0 DATA-LOSS RACE: register's inbox precreate must be non-truncating --
// cmdRegister's inbox precreate used to be `if (!existsSync) writeFileSync(p,
// '')` — a classic TOCTOU: the existsSync check and the truncating write are
// two separate syscalls, so a concurrent devswarm-pull.js drain (which creates
// + durably appends to the SAME inboxPath, under its own per-id lock that
// register never takes) can create the file with real content in the window
// between them, and register's writeFileSync('') (default flag 'w', which
// truncates) then ERASES it. Reproduced deterministically here by injecting the
// "concurrent pull" write inside the SAME mkdirSync call cmdRegister makes
// right before its own write — this lands exactly in the TOCTOU window
// regardless of which write strategy cmdRegister uses, so this ALSO proves the
// atomic `wx`-flag fix (no separate existsSync check, no truncation possible):
// pre-fix this test fails (final content == '', data lost); post-fix it
// passes (the concurrently-written message survives, register's own write
// no-ops on EEXIST).
test('P0 DATA-LOSS RACE (fail-first / proof): a concurrent inbox create+append racing register must never be truncated', () => {
  const home = tmpHome();
  try {
    // inbox and cursor live under DIFFERENT directories so the cursor-init
    // block's own mkdirSync (which runs FIRST, before the inbox block) can
    // never accidentally match the intercept below and fire too early.
    const inbox = path.join(home, 'race-inbox', 'inbox.ndjson');
    const cursor = path.join(home, 'race-cursor', 'cursor.json');
    const realMkdirSync = fs.mkdirSync;
    let injected = false;
    fs.mkdirSync = function (dir, opts) {
      const r = realMkdirSync.call(fs, dir, opts);
      // Fire exactly once, only for the inbox's own directory (never the
      // cursor's, and never any OTHER caller's mkdirSync elsewhere in the
      // same register() call) — simulates a concurrent devswarm-pull.js
      // drain that creates the inbox and durably appends a real message
      // in the race window between register's existence check and its
      // (pre-fix, non-atomic) truncating write.
      if (!injected && dir === path.dirname(inbox)) {
        injected = true;
        fs.writeFileSync(inbox, JSON.stringify({ _h: 'native:race1', message: 'do not lose me' }) + '\n');
      }
      return r;
    };
    try {
      cli.run(['register', 'race-a', '--worktree', '/wt/race-a', '--session', 's',
        '--inbox', inbox, '--cursor', cursor], ctx(home));
    } finally {
      fs.mkdirSync = realMkdirSync;
    }
    assert.ok(injected, 'the race must actually have been injected (mkdirSync for the inbox dir must fire)');
    const finalContent = fs.readFileSync(inbox, 'utf8');
    assert.notStrictEqual(finalContent, '', 'the concurrently-durably-appended message must survive registration; got an EMPTY (truncated) inbox — DATA LOSS');
    assert.ok(finalContent.includes('do not lose me'), `durable message content must be preserved; got: ${finalContent}`);
  } finally { rm(home); }
});

// ---- #36 cross-project-bleed fix: repoId on the descriptor -----------------
// ---- P1 TRUNCATION-PROOF PRECREATE (hardened): register's inbox precreate --
// used to use `wx` (exclusive create, fails closed on EEXIST). O_EXCL
// exclusivity is documented as unreliable over some network filesystems, so
// the precreate now uses append mode (`a`) instead: it creates the file if
// absent, and appending '' can never truncate existing content on ANY
// filesystem, with no reliance on O_EXCL at all — proven here with a plain
// (non-race) re-register over a pre-existing populated inbox.
test('register re-run: a PRE-EXISTING durable inbox with real content survives a plain re-register (append-create never truncates)', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'reg-inbox', 'inbox.ndjson');
    const cursor = path.join(home, 'reg-cursor', 'cursor.json');
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    fs.writeFileSync(inbox, JSON.stringify({ _h: 'native:d1', message: 'already here' }) + '\n');
    cli.run(['register', 'reg-a', '--worktree', '/wt/reg-a', '--session', 's',
      '--inbox', inbox, '--cursor', cursor], ctx(home));
    const finalContent = fs.readFileSync(inbox, 'utf8');
    assert.ok(finalContent.includes('already here'),
      `pre-existing durable inbox content must survive register; got: ${finalContent}`);
  } finally { rm(home); }
});

test('register fresh: a genuinely-absent inbox is still created, empty', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'reg2-inbox', 'inbox.ndjson');
    const cursor = path.join(home, 'reg2-cursor', 'cursor.json');
    assert.ok(!fs.existsSync(inbox), 'precondition: inbox must not exist yet');
    cli.run(['register', 'reg-b', '--worktree', '/wt/reg-b', '--session', 's',
      '--inbox', inbox, '--cursor', cursor], ctx(home));
    assert.ok(fs.existsSync(inbox), 'a genuinely absent inbox must be created by register');
    assert.strictEqual(fs.readFileSync(inbox, 'utf8'), '', 'a freshly-created inbox must be empty');
  } finally { rm(home); }
});

// ---- P1 fail-OPEN cursor precreate (regression guard): the cursor half of
// precreateCursorAndInbox() must swallow ANY write error (EACCES/ENOSPC/
// EROFS/EPERM/etc), not just re-throw non-EEXIST errors. This helper now runs
// on EVERY `inbox pull` via cmdRegister's ensure branch, so a transient,
// non-EEXIST cursor-write error must never abort the pull/register — same
// fail-open posture as the inbox block right below it and as the original
// v0.61.1 precreate.
test('register: a non-EEXIST cursor-write error is swallowed (fail-open), never aborts registration', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'facc-inbox', 'inbox.ndjson');
    const cursor = path.join(home, 'facc-cursor', 'cursor.json');
    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function (file, data, opts) {
      if (file === cursor && opts && opts.flag === 'wx') {
        const err = new Error('simulated permission failure');
        err.code = 'EACCES';
        throw err;
      }
      return origWriteFileSync.call(fs, file, data, opts);
    };
    let r;
    try {
      r = cli.run(['register', 'facc', '--worktree', '/wt/facc', '--session', 's',
        '--inbox', inbox, '--cursor', cursor], ctx(home));
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }
    assert.equal(r.result.ok, true, 'a non-EEXIST cursor-write error must not abort registration');
    assert.equal(r.result.action, 'registered');
    // the cursor file itself was never created (the injected error prevented it) —
    // proves the error was genuinely swallowed, not silently side-stepped.
    assert.ok(!fs.existsSync(cursor), 'precondition check: the injected error really did block the cursor write');
  } finally { rm(home); }
});

test('inbox pull: a non-EEXIST cursor-write error in the ensure branch is swallowed, pull still proceeds', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'facc2-inbox', 'inbox.ndjson');
    const cursor = path.join(home, 'facc2-cursor', 'cursor.json');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    const origWriteFileSync = fs.writeFileSync;
    let attempted = false;
    fs.writeFileSync = function (file, data, opts) {
      if (String(file).endsWith(path.join('facc2-cursor', 'cursor.json')) && opts && opts.flag === 'wx') {
        attempted = true;
        const err = new Error('simulated read-only filesystem');
        err.code = 'EROFS';
        throw err;
      }
      return origWriteFileSync.call(fs, file, data, opts);
    };
    const io = { run: (s) => (s.args[1] === 'message-count' ? { ok: true, raw: '0' } : { ok: false, error: 'unexpected' }) };
    let r;
    try {
      r = cli.run(['register', 'facc2', '--worktree', '/wt/facc2', '--session', 's', '--inbox', inbox, '--cursor', cursor], ctx(home));
      assert.equal(r.result.ok, true, 'initial register must succeed despite the injected cursor error');
      r = cli.run(['inbox', 'pull', 'facc2'], ctx(home, { io }));
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }
    assert.ok(attempted, 'precondition: the ensure branch must have re-attempted the cursor precreate');
    assert.equal(r.result.ok, true, 'inbox pull must proceed past a swallowed non-EEXIST cursor error in the ensure branch');
  } finally { rm(home); }
});

test('register: an EXISTING cursor is never clobbered by precreate (idempotent wx create)', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'noclob-inbox', 'inbox.ndjson');
    const cursor = path.join(home, 'noclob-cursor', 'cursor.json');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, '7');
    cli.run(['register', 'noclob', '--worktree', '/wt/noclob', '--session', 's',
      '--inbox', inbox, '--cursor', cursor], ctx(home));
    assert.equal(fs.readFileSync(cursor, 'utf8'), '7', 'an existing cursor value must never be clobbered by precreate');
  } finally { rm(home); }
});

test('register populates repoId from env.DEVSWARM_REPO_ID', () => {
  const home = tmpHome();
  try {
    const r = cli.run(
      ['register', 'w-repo', '--worktree', '/wt/w-repo', '--session', 's'],
      ctx(home, { env: { DEVSWARM_REPO_ID: 'repo-a' } })
    );
    assert.equal(r.result.ok, true);
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'w-repo'), 'utf8'));
    assert.equal(desc.repoId, 'repo-a');
  } finally { rm(home); }
});

test('register with NO DEVSWARM_REPO_ID and no --repo-id flag leaves repoId null (fail-open back-compat)', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['register', 'w-norepo', '--worktree', '/wt/w-norepo', '--session', 's'], ctx(home));
    assert.equal(r.result.ok, true);
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'w-norepo'), 'utf8'));
    assert.equal(desc.repoId, null);
  } finally { rm(home); }
});

test('register --repo-id flag overrides env.DEVSWARM_REPO_ID', () => {
  const home = tmpHome();
  try {
    const r = cli.run(
      ['register', 'w-flag', '--worktree', '/wt/w-flag', '--session', 's', '--repo-id', 'repo-flag'],
      ctx(home, { env: { DEVSWARM_REPO_ID: 'repo-env' } })
    );
    assert.equal(r.result.ok, true);
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'w-flag'), 'utf8'));
    assert.equal(desc.repoId, 'repo-flag');
  } finally { rm(home); }
});

test('register rejects an unsafe id (never path-joins hostile input)', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['register', '../evil', '--worktree', '/wt'], ctx(home));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
  } finally { rm(home); }
});

test('register with a MISSING required field fails (ok:false, exit 2, no phantom descriptor)', () => {
  const home = tmpHome();
  try {
    // No --session -> a descriptor with a null sessionId would be invisible to the
    // supervisor (readDescriptors requires worktreePath + sessionId). Must reject,
    // never write a null-field phantom that reports ok:true.
    const r = cli.run(['register', 'w1', '--worktree', '/wt/w1'], ctx(home));
    assert.equal(r.code, 2, 'missing required field -> nonzero exit');
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /--session/);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w1')), false, 'no descriptor written on rejection');
    // and nothing leaked into the store projection
    const sum = storeLib.readSummary(home);
    assert.ok(!sum || !sum.workspaces || !sum.workspaces.w1, 'no phantom in the projection');
  } finally { rm(home); }
});

test('register with NO required fields lists both missing flags and writes nothing', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['register', 'w2'], ctx(home));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /--worktree/);
    assert.match(r.result.error, /--session/);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w2')), false);
  } finally { rm(home); }
});

test('ensure creating a NEW descriptor also requires the fields (no phantom)', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['ensure', 'w3', '--worktree', '/wt/w3'], ctx(home)); // no --session
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w3')), false);
  } finally { rm(home); }
});

test('ensure is idempotent: existing descriptor untouched, store re-upserted', () => {
  const home = tmpHome();
  try {
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's1'], ctx(home));
    const r = cli.run(['ensure', 'w', '--worktree', '/OTHER', '--session', 's2'], ctx(home));
    assert.equal(r.result.action, 'exists');
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'w'), 'utf8'));
    assert.equal(desc.worktreePath, '/wt/w'); // NOT overwritten
    assert.equal(desc.sessionId, 's1');
  } finally { rm(home); }
});

// ---- FIX 2: ensure/exists branch must precreate the cursor/inbox too -------
// cmdRegister's `requireNew && existing` early-return (~L881-891) used to skip
// the cursor/inbox precreate block entirely (~L916-948, only reached on the
// CREATE path). A descriptor whose inbox/cursor was repointed to a path where
// the cursor file never got created (e.g. a worktree-local override) then
// stays known:false forever, even though `inbox pull` re-runs this SAME ensure
// branch every single turn — this is the real cause of a LIVE workspace's gate
// nagging "inbox unreadable". Both fixtures below: (1) a worktree-local path
// (the reported esim-v2 shape), (2) the canonical central-store default path
// (`pull.inboxDefaultPath`/`cursorDefaultPath`, what `inbox pull` seeds a
// brand-new descriptor with) -- the fix must be path-agnostic, not special-
// cased to either.
function repointDescriptor(home, id, inboxPath, cursorPath) {
  const p = cli.descriptorPath(home, id);
  const desc = JSON.parse(fs.readFileSync(p, 'utf8'));
  desc.inboxPath = inboxPath;
  desc.cursorPath = cursorPath;
  fs.writeFileSync(p, JSON.stringify(desc));
}

test('ensure precreates cursor/inbox for an existing descriptor repointed to a WORKTREE-LOCAL path, without truncating existing inbox content', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'wt', '.devswarm-temp', 'inbox.ndjson');
    const cursor = path.join(home, 'wt', '.devswarm-temp', 'cursor.json');
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    // Repoint AFTER register (simulates a worktree-local override applied post-
    // registration) — bypasses cmdRegister's create-path precreate, which only
    // ever ran against the descriptor's ORIGINAL (unset) paths.
    repointDescriptor(home, 'w', inbox, cursor);
    // Pre-seed the inbox with REAL content (never created via register, since
    // it now points elsewhere) to prove the fix's precreate never truncates it.
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    fs.writeFileSync(inbox, JSON.stringify({ id: 'm1', ts: 1 }) + '\n');
    // Reproduction: cursor absent -> known:false (the live-workspace bug: the
    // gate reads "inbox unreadable" even though the workspace is active).
    const before = cli.run(['inbox', 'count', 'w'], ctx(home));
    assert.equal(before.result.known, false);
    // Exercise the EXACT branch `inbox pull`'s every-turn auto-ensure hits
    // (cmdRegister's requireNew && existing early-return).
    const r = cli.run(['ensure', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    assert.equal(r.result.action, 'exists');
    assert.equal(fs.existsSync(cursor), true, 'ensure must precreate the cursor for a repointed existing descriptor');
    const after = cli.run(['inbox', 'count', 'w'], ctx(home));
    assert.equal(after.result.known, true);
    assert.equal(after.result.total, 1, 'the pre-existing inbox content must be preserved, never truncated');
  } finally { rm(home); }
});

test('ensure precreates cursor/inbox for an existing descriptor on the CENTRAL-STORE default path too (path-agnostic)', () => {
  const home = tmpHome();
  try {
    const inbox = pullLib.inboxDefaultPath(home, 'w2');
    const cursor = pullLib.cursorDefaultPath(home, 'w2');
    cli.run(['register', 'w2', '--worktree', '/wt/w2', '--session', 's', '--inbox', inbox, '--cursor', cursor], ctx(home));
    // Simulate the cursor having been lost (or never precreated, e.g. an
    // earlier init attempt failed) while the descriptor itself survives.
    fs.rmSync(cursor);
    fs.writeFileSync(inbox, JSON.stringify({ id: 'm1', ts: 1 }) + '\n', { flag: 'a' });
    const before = cli.run(['inbox', 'count', 'w2'], ctx(home));
    assert.equal(before.result.known, false);
    const r = cli.run(['ensure', 'w2', '--worktree', '/wt/w2', '--session', 's'], ctx(home));
    assert.equal(r.result.action, 'exists');
    assert.equal(fs.existsSync(cursor), true, 'ensure must precreate the cursor on the central-store default path too');
    const after = cli.run(['inbox', 'count', 'w2'], ctx(home));
    assert.equal(after.result.known, true);
    assert.equal(after.result.total, 1, 'the pre-existing inbox content must be preserved, never truncated');
  } finally { rm(home); }
});

test('gate --set / --clear marks gates and derives archive_ready', () => {
  const home = tmpHome();
  try {
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    let r = cli.run(['gate', 'w', '--set', 'done,merged'], ctx(home));
    assert.equal(r.result.ok, true);
    assert.deepEqual(r.result.gates, { done: true, merged: true });
    assert.equal(r.result.archive_ready, false); // tests_passed missing
    r = cli.run(['gate', 'w', '--set', 'tests_passed'], ctx(home));
    assert.equal(r.result.archive_ready, true);
    r = cli.run(['gate', 'w', '--clear', 'merged'], ctx(home));
    assert.equal(r.result.archive_ready, false);
    assert.equal(r.result.gates.merged, false);
  } finally { rm(home); }
});

test('gate with neither --set nor --clear errors', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['gate', 'w'], ctx(home));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
  } finally { rm(home); }
});

test('inbox count/read/ack advance the durable cursor', () => {
  const home = tmpHome();
  try {
    const inbox = path.join(home, 'inbox.ndjson');
    const cursor = path.join(home, 'cursor.json');
    fs.writeFileSync(inbox, 'm1\nm2\nm3\n');
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's', '--inbox', inbox, '--cursor', cursor], ctx(home));

    let r = cli.run(['inbox', 'count', 'w'], ctx(home));
    assert.equal(r.result.unread, 3);
    assert.equal(r.result.total, 3);

    r = cli.run(['inbox', 'read', 'w'], ctx(home));
    assert.deepEqual(r.result.lines, ['m1', 'm2', 'm3']);

    r = cli.run(['inbox', 'ack', 'w', '--to', '2'], ctx(home));
    assert.equal(r.result.cursor, 2);
    r = cli.run(['inbox', 'count', 'w'], ctx(home));
    assert.equal(r.result.unread, 1);

    r = cli.run(['inbox', 'ack', 'w'], ctx(home)); // ack-all
    assert.equal(r.result.cursor, 3);
    r = cli.run(['inbox', 'count', 'w'], ctx(home));
    assert.equal(r.result.unread, 0);
  } finally { rm(home); }
});

test('inbox on an unregistered workspace fails soft', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['inbox', 'count', 'ghost'], ctx(home));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
  } finally { rm(home); }
});

test('inbox pull AUTO-ENSURES the descriptor (truthy inboxPath + cursor 0) then drains', () => {
  const home = tmpHome();
  try {
    // No prior descriptor. The pull spawn is injected via ctx.io.run so no real
    // hivecontrol binary is touched. A zero count exercises the count-gate: the
    // descriptor is still auto-ensured before the (no-op) drain.
    const io = { run: (s) => (s.args[1] === 'message-count' ? { ok: true, raw: '0' } : { ok: false, error: 'unexpected' }) };
    const r = cli.run(['inbox', 'pull', 'child-1'], ctx(home, { io }));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'pull');
    assert.equal(r.result.imported, 0);
    assert.equal(r.result.nativeCount, 0);
    // A valid descriptor now exists with a truthy inboxPath under the devswarm root...
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'child-1'), 'utf8'));
    assert.ok(desc.inboxPath && typeof desc.inboxPath === 'string', 'auto-ensured a truthy inboxPath');
    assert.ok(desc.cursorPath && typeof desc.cursorPath === 'string', 'auto-ensured a cursorPath');
    // ctx() defaults cwd to fakeCwd(home) (v0.57 mesh, D24 — see the ctx() comment above).
    assert.equal(desc.worktreePath, fakeCwd(home), 'worktreePath defaults to the cwd');
    // ...and the cursor was initialized to 0 (nothing consumed yet).
    assert.equal(fs.readFileSync(desc.cursorPath, 'utf8').trim(), '0', 'cursor initialized to 0');
  } finally { rm(home); }
});

test('inbox pull is idempotent about the descriptor (re-pull leaves an existing one intact)', () => {
  const home = tmpHome();
  try {
    // Pre-register with a CUSTOM inboxPath; the pull must NOT clobber it.
    const inbox = path.join(home, 'custom.ndjson');
    const cursor = path.join(home, 'custom.cursor');
    cli.run(['register', 'child-1', '--worktree', '/wt/c', '--session', 's', '--inbox', inbox, '--cursor', cursor], ctx(home));
    const io = { run: (s) => (s.args[1] === 'message-count' ? { ok: true, raw: '0' } : { ok: false, error: 'x' }) };
    const r = cli.run(['inbox', 'pull', 'child-1'], ctx(home, { io }));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'child-1'), 'utf8'));
    assert.equal(desc.inboxPath, inbox, 'the existing inboxPath is left intact (idempotent ensure)');
  } finally { rm(home); }
});

// P1 fix (v0.58.1): `inbox pull`'s own JSON output (cmdInboxPull) is the exact
// payload `reconcile` parses off the subprocess it spawns per worktree
// (defaultSpawnReconcile spawns `node devswarm.js inbox pull <id>` and JSON.parses
// its stdout) — so pullOnce's `lost` field MUST survive into this output, or a real
// (non-mocked) reconcile run has nothing to propagate no matter how cmdReconcile
// itself is fixed. Drives a genuine pullOnce shortfall (message-count says 2,
// read-messages returns an unhandled shape normalizeMonitorPayload can't recover)
// through the REAL `inbox pull` CLI verb, exactly as devswarm-pull.test.js does at
// the pullOnce layer directly.
test('inbox pull surfaces a REAL pullOnce shortfall as `lost` on the CLI\'s own JSON output (the exact payload reconcile\'s subprocess spawn parses)', () => {
  const home = tmpHome();
  try {
    const io = {
      run: (s) => {
        const sub = s.args[1];
        if (sub === 'message-count') return { ok: true, raw: '2', error: null };
        // An unhandled batch shape -> normalizeMonitorPayload recovers nothing,
        // so pullOnce's reconciliation check (recovered < nativeCount) fires.
        if (sub === 'read-messages') return { ok: true, raw: JSON.stringify({ items: [{ message: 'a' }, { message: 'b' }] }), error: null };
        return { ok: false, raw: '', error: 'unexpected subcommand ' + sub };
      },
    };
    const r = cli.run(['inbox', 'pull', 'child-lossy'], ctx(home, { io }));
    assert.equal(r.result.ok, false, 'a real shortfall must not report success');
    assert.equal(r.result.nativeCount, 2);
    assert.equal(r.result.lost, 2, 'the lost field must be present on the CLI JSON output, not just on pullOnce\'s in-process return value');
  } finally { rm(home); }
});

test('workspaces list emits the derived projection (PER-PROJECT, targeted by --workspace)', () => {
  const home = tmpHome();
  try {
    cli.run(['register', 'a', '--worktree', '/wt/a', '--session', 's'], ctx(home));
    cli.run(['register', 'b', '--worktree', '/wt/b', '--session', 's'], ctx(home));
    // PER-PROJECT: each id lives in its OWN physical store, so `workspaces list`
    // derives ONE project's summary. --workspace targets that project explicitly.
    const ra = cli.run(['workspaces', 'list', '--workspace', 'a'], ctx(home));
    assert.equal(ra.result.count, 1);
    assert.deepEqual(ra.result.workspaces.map((w) => w.id), ['a']);
    const rb = cli.run(['workspaces', 'list', '--workspace', 'b'], ctx(home));
    assert.equal(rb.result.count, 1);
    assert.deepEqual(rb.result.workspaces.map((w) => w.id), ['b']);
  } finally { rm(home); }
});

test('archive tombstones the registry, moves the descriptor, surfaces the manual GUI step', () => {
  const home = tmpHome();
  try {
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    const r = cli.run(['archive', 'w'], ctx(home));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.descriptorArchived, true);
    assert.match(r.result.manualStep, /DevSwarm app/);
    // descriptor moved (non-destructive), not deleted
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w')), false);
    assert.equal(fs.existsSync(path.join(cli.archivedDir(home), 'w.json')), true);
    // dropped from the projection (this workspace's own per-project store)
    const list = cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home));
    assert.equal(list.result.count, 0);
  } finally { rm(home); }
});

test('archive: a failed descriptor move must NOT tombstone the registry (no split-brain)', (t) => {
  const home = tmpHome();
  try {
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    // Force ONLY the exclusive descriptor link into archived/ to fail.
    const origLink = fs.linkSync.bind(fs);
    t.mock.method(fs, 'linkSync', (from, to) => {
      if (String(to).endsWith(path.join('archived', 'w.json'))) {
        throw new Error('boom: simulated link failure');
      }
      return origLink(from, to);
    });
    const r = cli.run(['archive', 'w'], ctx(home));
    t.mock.reset();
    // Fail-safe: the descriptor must still be present in workspaces/ (move
    // never happened) AND the registry must NOT have been tombstoned -- that
    // split-brain (descriptor present + registry gone) is exactly what leaves
    // the gate nagging forever while the roster row silently vanishes. A
    // failed archive is reported ok:false, never a silent partial success.
    assert.equal(r.result.ok, false);
    assert.equal(r.result.descriptorArchived, false);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w')), true, 'descriptor must remain in workspaces/ on a failed move');
    const list = cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home));
    assert.equal(list.result.count, 1, 'registry must NOT be tombstoned when the descriptor move failed');
  } finally { rm(home); }
});

test('archive then unarchive round-trips the descriptor back into workspaces/ and revives the registry row', () => {
  const home = tmpHome();
  try {
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    const archived = cli.run(['archive', 'w'], ctx(home));
    assert.equal(archived.result.ok, true);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w')), false);
    assert.equal(fs.existsSync(path.join(cli.archivedDir(home), 'w.json')), true);
    assert.equal(cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home)).result.count, 0);

    const unarchived = cli.run(['unarchive', 'w'], ctx(home));
    assert.equal(unarchived.result.ok, true);
    assert.equal(unarchived.result.descriptorRestored, true);
    // descriptor moved back (not left behind in archived/)
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w')), true, 'descriptor must be restored to workspaces/');
    assert.equal(fs.existsSync(path.join(cli.archivedDir(home), 'w.json')), false, 'archived copy must be moved out, not duplicated');
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'w'), 'utf8'));
    assert.equal(desc.worktreePath, '/wt/w');
    assert.equal(desc.sessionId, 's');
    assert.equal(desc.ownerKey, storeLib.hashFromWorkspaceId('w'));
    // registry row revived (latest-op-wins upsert after the earlier tombstone)
    const list = cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home));
    assert.equal(list.result.count, 1, 'unarchive must revive the tombstoned registry row');
    assert.deepEqual(list.result.workspaces.map((ws) => ws.id), ['w']);
  } finally { rm(home); }
});

test('unarchive on an id with no archived descriptor fails soft (no crash, no phantom restore)', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['unarchive', 'never-archived'], ctx(home));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /no archived descriptor/);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'never-archived')), false);
  } finally { rm(home); }
});

test('unarchive refuses a legacy archived descriptor with no ownerKey and no derivable repo key', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(cli.archivedDir(home), { recursive: true });
    fs.writeFileSync(path.join(cli.archivedDir(home), 'legacy.json'), JSON.stringify({
      id: 'legacy', worktreePath: '/definitely/not/a/git/worktree', sessionId: 's',
    }));
    const r = cli.run(['unarchive', 'legacy'], ctx(home));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /does not belong to the current project/);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'legacy')), false);
  } finally { rm(home); }
});

test('archive rejects an archived-directory symlink without writing through it', () => {
  const home = tmpHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archive-outside-'));
  try {
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    fs.symlinkSync(outside, cli.archivedDir(home));
    const r = cli.run(['archive', 'w'], ctx(home));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /unsafe archived directory/);
    assert.equal(fs.existsSync(path.join(outside, 'w.json')), false);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w')), true);
  } finally { rm(home); rm(outside); }
});

// cmdUnarchive moves the descriptor via linkSync+unlinkSync (an exclusive
// same-filesystem move — linkSync fails closed on EEXIST instead of
// renameSync's silent overwrite), NOT renameSync. A prior version of this
// test mocked fs.renameSync, which cmdUnarchive never calls on this path — the
// mock never fired, so the test never actually exercised a real failure path.
//
// These structural-repo cases use a real git repo; the generic lifecycle test
// above covers the per-id fallback through its persisted physical ownerKey.
test('unarchive: linkSync failure must NOT revive the registry (symmetric fail-safe with archive)', (t) => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('unarchive-link-fail');
  try {
    cli.run(['register', 'w', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    cli.run(['archive', 'w'], ctx(home, { cwd: repo }));
    const origLink = fs.linkSync.bind(fs);
    t.mock.method(fs, 'linkSync', (from, to) => {
      if (String(to).endsWith(path.join('workspaces', 'w.json'))) {
        throw new Error('boom: simulated link failure');
      }
      return origLink(from, to);
    });
    const r = cli.run(['unarchive', 'w'], ctx(home, { cwd: repo }));
    t.mock.reset();
    assert.equal(r.result.ok, false);
    // archived copy left in place (never lost), never phantom-restored to workspaces/
    assert.equal(fs.existsSync(path.join(cli.archivedDir(home), 'w.json')), true, 'archived descriptor must remain in place on a failed move');
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'w')), false, 'descriptor must not appear in workspaces/ on a failed move');
    const list = cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home, { cwd: repo }));
    assert.equal(list.result.count, 0, 'registry must stay tombstoned when the move-back failed');
  } finally { rm(home); rm(repo); }
});

test('unarchive: link succeeds but unlinkSync(archivedPath) fails rolls back W and leaves the registry tombstoned; retry succeeds', (t) => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('unarchive-unlink-fail');
  try {
    cli.run(['register', 'w', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    cli.run(['archive', 'w'], ctx(home, { cwd: repo }));
    const archivedPath = path.join(cli.archivedDir(home), 'w.json');
    const activePath = cli.descriptorPath(home, 'w');
    const origUnlink = fs.unlinkSync.bind(fs);
    t.mock.method(fs, 'unlinkSync', (p) => {
      if (String(p) === archivedPath) {
        throw new Error('boom: simulated unlink failure');
      }
      return origUnlink(p);
    });
    const r = cli.run(['unarchive', 'w'], ctx(home, { cwd: repo }));
    t.mock.reset();
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /failed to move descriptor out of archived/);
    assert.equal(fs.existsSync(archivedPath), true, 'archived descriptor must remain in place (unlink failed)');
    assert.equal(fs.existsSync(activePath), false, 'the workspaces hardlink must be rolled back');
    let list = cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home, { cwd: repo }));
    assert.equal(list.result.count, 0, 'registry must stay tombstoned until the move completes');
    const retry = cli.run(['unarchive', 'w'], ctx(home, { cwd: repo }));
    assert.equal(retry.result.ok, true, 'a retry after rollback must complete');
    assert.equal(fs.existsSync(archivedPath), false, 'retry must finish removing the archived copy');
    assert.equal(fs.existsSync(activePath), true);
    list = cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home, { cwd: repo }));
    assert.equal(list.result.count, 1);
  } finally { rm(home); rm(repo); }
});

// Fix C requirement: a retry must be idempotent even WITHOUT going through a
// mocked failure first — simulate the exact interrupted state directly (both
// hardlinks present, same inode, registry not yet revived) and confirm
// unarchive recognizes it as already-restored rather than erroring on
// linkSync EEXIST.
test('unarchive: recovers a pre-existing same-inode interrupted state (activePath already hardlinked to archivedPath)', () => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('unarchive-same-inode');
  try {
    cli.run(['register', 'w', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    cli.run(['archive', 'w'], ctx(home, { cwd: repo }));
    const archivedPath = path.join(cli.archivedDir(home), 'w.json');
    const activePath = cli.descriptorPath(home, 'w');
    // simulate an interrupted prior unarchive: the link into workspaces/
    // already happened, but nothing else (registry not revived, archived/
    // copy not removed yet).
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    fs.linkSync(archivedPath, activePath);
    const r = cli.run(['unarchive', 'w'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, 'must recognize the same-inode interrupted state as already-restored, not error on EEXIST');
    assert.equal(r.result.descriptorRestored, true);
    assert.equal(fs.existsSync(activePath), true);
    assert.equal(fs.existsSync(archivedPath), false, 'the archived copy must be cleaned up on recovery');
    const list = cli.run(['workspaces', 'list', '--workspace', 'w'], ctx(home, { cwd: repo }));
    assert.equal(list.result.count, 1, 'registry must be revived on recovery');
  } finally { rm(home); rm(repo); }
});

test('archive-ignore writes then archive-unignore removes the mark', () => {
  const home = tmpHome();
  try {
    let r = cli.run(['archive-ignore', 'w'], ctx(home));
    assert.equal(r.result.ignored, true);
    const p = path.join(cli.archiveIgnoreDir(home), 'w.json');
    assert.equal(fs.existsSync(p), true);
    r = cli.run(['archive-unignore', 'w'], ctx(home));
    assert.equal(r.result.removed, true);
    assert.equal(fs.existsSync(p), false);
  } finally { rm(home); }
});

test('heartbeat writes a turn-authored beat with only supplied fields', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['heartbeat', 'w', '--progress', '40', '--phase', 'build', '--wip', 'x', '--wip', 'y'],
      ctx(home, { now: 999 }));
    assert.equal(r.result.ok, true);
    const beat = JSON.parse(fs.readFileSync(path.join(cli.heartbeatsDir(home), 'w.json'), 'utf8'));
    assert.equal(beat.ts, 999);
    assert.equal(beat.progress_pct, 40);
    assert.equal(beat.phase, 'build');
    assert.deepEqual(beat.wip, ['x', 'y']);
    assert.equal(beat.blockers.length, 0); // not supplied -> empty, never fabricated
    assert.equal(beat.source, 'cli-heartbeat');
  } finally { rm(home); }
});

test('nudge with no nudgeCommand escalates (never spawns)', () => {
  const home = tmpHome();
  try {
    cli.run(['register', 'w', '--worktree', '/wt/w', '--session', 's'], ctx(home));
    const r = cli.run(['nudge', 'w'], ctx(home));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.result.action, 'escalate');
  } finally { rm(home); }
});

test('unknown command reports a closed-vocabulary error + exit 2', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['bogus'], ctx(home));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /unknown command/);
  } finally { rm(home); }
});

// ---- Primary/store READ path (inbox messages / read-primary) ---------------
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

// Seed store rows for a workspace as the ingest daemon would (bodies + hashes).
// opts.hash (v0.57 mesh) lets a test explicitly seed into the SHARED repoKey
// store instead of the legacy per-id hash bucket — needed when the test's own
// `ctx.cwd` is a REAL git worktree (so the D24-rekeyed CLI opens the repoKey
// store, not the legacy one this helper defaults to).
function seedStore(home, id, bodies, opts) {
  // PER-PROJECT: seed into the SAME per-project store the CLI opens for this id.
  const s = storeLib.openStore({ home, workspaceId: id, hash: opts && opts.hash, backend: 'journal' });
  try { bodies.forEach((b, i) => s.appendMessage({ workspaceId: id, body: b, hash: id + '-h' + i })); }
  finally { s.close(); }
}

test('inbox messages reads bodies from the store NON-destructively (no descriptor needed)', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-x', ['msg one', 'msg two', 'msg three']);
    const r = cli.run(['inbox', 'messages', 'primary-x', '--json'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'messages');
    assert.equal(r.result.total, 3);
    assert.equal(r.result.count, 3);
    assert.deepEqual(r.result.messages.map((m) => m.body), ['msg one', 'msg two', 'msg three']);
    assert.equal(r.result.cursor, 0, 'no ack yet -> cursor 0');
    // Non-destructive: a second read returns the SAME rows (store untouched).
    const r2 = cli.run(['inbox', 'messages', 'primary-x'], ctx(home));
    assert.equal(r2.result.count, 3, 'read is non-destructive — rows persist');
  } finally { rm(home); }
});

test('inbox read-primary advances the durable ACK cursor (under cursors/, not store/) and --unread then excludes read', () => {
  const home = tmpHome();
  // Self-ack: caller identity must equal the target id (bug #2 ownership check),
  // so inject a matching DEVSWARM_BUILDER_ID for every call against 'primary-x'.
  // cwd must resolve to NO real git worktree so the declared DEVSWARM_BUILDER_ID
  // is trusted (ground-truth cwd, not a spoof — see fakeCwd's own comment below).
  const selfCtx = ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: fakeCwd(home) });
  try {
    seedStore(home, 'primary-x', ['a', 'b']);
    const r = cli.run(['inbox', 'read-primary', 'primary-x'], selfCtx);
    assert.equal(r.result.action, 'read-primary');
    assert.equal(r.result.count, 2, 'first read-primary returns both unread');
    assert.equal(r.result.cursor, 2, 'cursor advanced to the total');
    // The ACK cursor is a file under cursors/, NOT under store/ or inbox/.
    const cursorFile = cli.primaryCursorPath(home, 'primary-x');
    assert.ok(cursorFile.includes(path.join('devswarm', 'cursors')), 'cursor lives under cursors/');
    assert.ok(!/[\\/]store[\\/]/.test(cursorFile) && !/[\\/]inbox[\\/]/.test(cursorFile), 'never under store/ or inbox/');
    assert.equal(fs.readFileSync(cursorFile, 'utf8').trim(), '2');

    // A follow-up --unread read now excludes the acked messages.
    const r2 = cli.run(['inbox', 'messages', 'primary-x', '--unread'], selfCtx);
    assert.equal(r2.result.count, 0, 'nothing unread after ack');

    // New store rows arrive -> they show as unread past the cursor.
    seedStore(home, 'primary-x', ['a', 'b', 'c']); // 'a','b' dedupe, 'c' is new
    const r3 = cli.run(['inbox', 'messages', 'primary-x', '--unread'], selfCtx);
    assert.equal(r3.result.count, 1, 'only the newly-appended message is unread');
    assert.equal(r3.result.messages[0].body, 'c');
  } finally { rm(home); }
});

test('inbox read-primary drops the PERSISTED projected unread (store cursor, not just the ACK cursor file) — #22', () => {
  const home = tmpHome();
  try {
    const wt = '/some/repo/worktree-22';
    const id = inst.primaryWorkspaceId(wt);
    const reg = cli.run(['register-primary', '--worktree', wt, '--session', 's22'], ctx(home));
    assert.equal(reg.result.ok, true);
    seedStore(home, id, ['hello', 'world']);

    // Baseline: before any read, workspaces list (deriveSummary) shows 2 unread.
    const before = cli.run(['workspaces', 'list', '--workspace', id], ctx(home));
    assert.equal(before.result.workspaces.find((w) => w.id === id).unread, 2, 'baseline: 2 unread before any read');

    // Self-ack: caller identity must equal id (bug #2 ownership check). cwd is
    // the fake, non-existent `wt` itself — it resolves to no real git worktree,
    // so the declared DEVSWARM_BUILDER_ID is a trusted declaration, not a spoof.
    const rp = cli.run(['inbox', 'read-primary', id], ctx(home, { env: { DEVSWARM_BUILDER_ID: id }, cwd: wt }));
    assert.equal(rp.result.ok, true);
    assert.equal(rp.result.cursor, 2);

    // read-primary itself must refresh the PERSISTED summary.json projection — no
    // separate `workspaces list` call needed to see the drop (Wave-1 residual #22:
    // previously only the ACK cursor FILE advanced, while deriveSummary's `unread`
    // is computed from the STORE cursor via store.cursorValue, so the parent table
    // kept showing these messages unread after the Primary had already read them).
    const summary = storeLib.readSummary(home, id);
    assert.equal(summary.workspaces[id].unread, 0, 'persisted per-project summary unread drops immediately after read-primary');

    // A subsequent workspaces list (fresh deriveSummary from the store) confirms the
    // STORE cursor itself moved, not just the on-disk ACK file.
    const after = cli.run(['workspaces', 'list', '--workspace', id], ctx(home));
    assert.equal(after.result.workspaces.find((w) => w.id === id).unread, 0);
  } finally { rm(home); }
});

// ---- register-primary ------------------------------------------------------
test('register-primary registers the per-worktree Primary descriptor (id = primary-<hash>)', () => {
  const home = tmpHome();
  try {
    const wt = '/some/repo/worktree';
    const expectedId = inst.primaryWorkspaceId(wt);
    const r = cli.run(['register-primary', '--worktree', wt, '--session', 'sess-primary'], ctx(home));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'register-primary');
    assert.equal(r.result.workspaceId, expectedId);
    assert.match(expectedId, /^primary-[0-9a-f]{8}$/);
    // descriptor on disk with the resolved worktree + session
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, expectedId), 'utf8'));
    assert.equal(desc.worktreePath, wt);
    assert.equal(desc.sessionId, 'sess-primary');
    // store registry + summary reflect it (this Primary's per-project summary)
    assert.ok(storeLib.readSummary(home, expectedId).workspaces[expectedId]);
  } finally { rm(home); }
});

test('register-primary populates repoId from env.DEVSWARM_REPO_ID (#36)', () => {
  const home = tmpHome();
  try {
    const wt = '/some/repo/worktree-repoid';
    const expectedId = inst.primaryWorkspaceId(wt);
    const r = cli.run(
      ['register-primary', '--worktree', wt, '--session', 'sess-primary'],
      ctx(home, { env: { DEVSWARM_REPO_ID: 'repo-primary' } })
    );
    assert.equal(r.result.ok, true);
    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, expectedId), 'utf8'));
    assert.equal(desc.repoId, 'repo-primary');
  } finally { rm(home); }
});

test('register-primary then migrate folds a legacy NDJSON into the Primary partition (idempotent)', () => {
  const home = tmpHome();
  try {
    const wt = '/some/repo/worktree';
    const id = inst.primaryWorkspaceId(wt);
    const legacy = path.join(home, 'legacy-inbox.ndjson');
    fs.writeFileSync(legacy, 'stranded one\nstranded two\n');
    // register-primary points the descriptor's inboxPath at the legacy NDJSON.
    const reg = cli.run(['register-primary', '--worktree', wt, '--session', 's', '--inbox', legacy], ctx(home));
    assert.equal(reg.result.ok, true);
    // `migrate` folds any registered descriptor's inbox into the store under its id.
    const mig = cli.run(['migrate'], ctx(home));
    assert.equal(mig.result.ok, true);
    const one = (mig.result.migrated || []).find((m) => m.id === id);
    assert.ok(one, 'the primary workspace was migrated');
    assert.equal(one.imported, 2);
    assert.ok(one.verified, 'count-verified');
    // The bodies are now readable via the Primary read path.
    const rd = cli.run(['inbox', 'messages', id], ctx(home));
    assert.deepEqual(rd.result.messages.map((m) => m.body), ['stranded one', 'stranded two']);
    // Idempotent: a second migrate imports 0 new.
    const mig2 = cli.run(['migrate'], ctx(home));
    const one2 = (mig2.result.migrated || []).find((m) => m.id === id);
    assert.equal(one2.imported, 0, 're-migrate is idempotent');
  } finally { rm(home); }
});

test('register-primary fails soft outside a git worktree when no --worktree is given', () => {
  const home = tmpHome();
  try {
    const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-nogit-'));
    try {
      const r = cli.run(['register-primary', '--session', 's'], ctx(home, { cwd: nogit }));
      assert.equal(r.code, 2);
      assert.equal(r.result.ok, false);
      assert.match(r.result.error, /git worktree/);
    } finally { rm(nogit); }
  } finally { rm(home); }
});

// ---- archive-request (v0.58: STORE WRITE, zero hivecontrol calls) ----------
// Uses a REAL git worktree as cwd — archive-request now resolves repoKey from
// cwd (a mesh-direct store write, same posture as `send`), unlike the OLD
// native `message-child` implementation which needed no repoKey at all.
const cpArchive = require('node:child_process');
function makeGitRepoArchive(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archive-repo-' + tag + '-'));
  cpArchive.spawnSync('git', ['init', '-q', dir]);
  cpArchive.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cpArchive.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cpArchive.spawnSync('git', ['-C', dir, 'add', '.']);
  cpArchive.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

test('archive-request makes ZERO hivecontrol calls — an injected runner that asserts on ANY invocation still succeeds', () => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('zero-native');
  try {
    const io = { run: () => { throw new Error('archive-request must NEVER spawn a native hivecontrol call'); } };
    const r = cli.run(['archive-request', 'child-1', '--reason', 'milestone shipped'], ctx(home, { cwd: repo, io }));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.id, 'child-1');
    assert.equal(r.result.childId, 'child-1');
    assert.equal(r.result.posted, true);
    assert.equal(r.result.reason, 'milestone shipped');
  } finally { rm(home); rm(repo); }
});

test('archive-request writes the exact marker string as a mesh-direct message into the childId partition', () => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('marker-body');
  try {
    const r = cli.run(['archive-request', 'child-2', '--reason', 'milestone shipped'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const msgs = s.listMessages('child-2');
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].mtype, 'direct');
      assert.equal(msgs[0].urgency, 'high');
      assert.equal(msgs[0].body,
        '[[ANTIHALL_ARCHIVE_REQUEST]] milestone shipped — your parent asks you to archive this workspace; '
        + 'confirm with your user, then run devswarm.js archive <id>.');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('archive-request omits the reason clause when --reason is not given', () => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('no-reason');
  try {
    const r = cli.run(['archive-request', 'child-3'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.reason, null);
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const msgs = s.listMessages('child-3');
      assert.equal(msgs[0].body,
        '[[ANTIHALL_ARCHIVE_REQUEST]] — your parent asks you to archive this workspace; '
        + 'confirm with your user, then run devswarm.js archive <id>.');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('archive-request is visible via deriveSummary\'s archive_requested projection for the targeted child', () => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('summary-fold');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s0 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s0.upsertRegistry({ id: 'child-4', worktreePath: '/wt/child-4', sessionId: 's' }); } finally { s0.close(); }
    const r = cli.run(['archive-request', 'child-4'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    // readSummary is workspaceId-keyed (legacy hash bucket); read this project's
    // repoKey-hashed summary directly instead, matching how the CLI itself derives it.
    const summaryForRepo = storeLib.readSummaryForHash(home, repoKey);
    assert.ok(summaryForRepo && summaryForRepo.workspaces && summaryForRepo.workspaces['child-4']);
    assert.equal(summaryForRepo.workspaces['child-4'].archive_requested, true);
  } finally { rm(home); rm(repo); }
});

test('archive-request on a non-git cwd returns {ok:false,reason:"no-project"} and makes zero hivecontrol calls', () => {
  const home = tmpHome();
  try {
    const io = { run: () => { throw new Error('must never spawn hivecontrol'); } };
    const r = cli.run(['archive-request', 'child-5'], ctx(home, { cwd: fakeCwd(home), io }));
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'no-project');
  } finally { rm(home); }
});

test('archive-request rejects an unsafe id (never path-joins hostile input)', () => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('unsafe-id');
  try {
    const r = cli.run(['archive-request', '../evil'], ctx(home, { cwd: repo }));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
  } finally { rm(home); rm(repo); }
});

// ---- ack-ownership check (bug #2: cross-workspace ack hazard) --------------
// `inbox messages <id> --ack` / `inbox read-primary <id>` needs no descriptor and,
// before the fix, accepted ANY id — letting one workspace silently advance
// another's cursor. Non-ack reads must stay open to any id (the visibility
// feature); only the mutating ack path is gated by callerIdentity(env, cwd).
const REPO_ROOT = path.join(__dirname, '..', '..');

// fakeCwd(home) -> a cwd that resolves to NO git worktree (neither `git
// rev-parse --show-toplevel` nor the pure-fs `.git` walk-up finds anything,
// since it — and every ancestor up to the OS tmp root — is a plain tmpdir path
// with no `.git` anywhere in the chain). Used so these tests can DECLARE an
// identity via DEVSWARM_BUILDER_ID without it being a spoof: per the P0 fix,
// env is trusted ONLY when cwd has no ground truth to contradict it. Contrast
// with the deliberately-uses-the-REAL-repo-cwd test below, which proves the
// opposite case (env ignored when it disagrees with a REAL resolved cwd).
function fakeCwd(home) { return path.join(home, 'no-git-here'); }

test('inbox messages --ack: caller acks its OWN id (via DEVSWARM_BUILDER_ID, cwd has no git ground truth) -> ok, cursor advances', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-x', ['a', 'b']);
    const r = cli.run(['inbox', 'messages', 'primary-x', '--ack'],
      ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: fakeCwd(home) }));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.cursor, 2);
    assert.equal(fs.readFileSync(cli.primaryCursorPath(home, 'primary-x'), 'utf8').trim(), '2');
  } finally { rm(home); }
});

test('inbox messages --ack: caller acks a DIFFERENT id -> refused (ok:false, exit 2, cursor NOT advanced)', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-y', ['a', 'b']);
    const r = cli.run(['inbox', 'messages', 'primary-y', '--ack'],
      ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: fakeCwd(home) }));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /ack refused/);
    assert.equal(r.result.callerIdentity, 'primary-x');
    // no cursor file was ever written for the target — the ack never happened
    assert.equal(fs.existsSync(cli.primaryCursorPath(home, 'primary-y')), false);
  } finally { rm(home); }
});

test('inbox read-primary <otherId>: same ack-ownership refusal as --ack', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-y', ['a', 'b']);
    const r = cli.run(['inbox', 'read-primary', 'primary-y'],
      ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: fakeCwd(home) }));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /ack refused/);
    assert.equal(fs.existsSync(cli.primaryCursorPath(home, 'primary-y')), false);
  } finally { rm(home); }
});

test('inbox messages --ack --ack-as-owner on a DIFFERENT id -> allowed (explicit operator override)', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-y', ['a', 'b', 'c']);
    const r = cli.run(['inbox', 'messages', 'primary-y', '--ack', '--ack-as-owner'],
      ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: fakeCwd(home) }));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.cursor, 3);
    assert.equal(fs.readFileSync(cli.primaryCursorPath(home, 'primary-y'), 'utf8').trim(), '3');
  } finally { rm(home); }
});

test('inbox messages <otherId> WITHOUT --ack stays OPEN to any id (non-destructive read preserved)', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-y', ['a', 'b']);
    const r = cli.run(['inbox', 'messages', 'primary-y'],
      ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: fakeCwd(home) }));
    assert.equal(r.code, 0);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.count, 2);
    // no ack, no cursor file ever written
    assert.equal(fs.existsSync(cli.primaryCursorPath(home, 'primary-y')), false);

    // --unread without --ack must ALSO stay open to any id
    const r2 = cli.run(['inbox', 'messages', 'primary-y', '--unread'],
      ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: fakeCwd(home) }));
    assert.equal(r2.result.ok, true);
    assert.equal(r2.result.count, 2);
  } finally { rm(home); }
});

test('inbox messages --ack: a REAL resolvable cwd wins over a mismatching DEVSWARM_BUILDER_ID (env-spoof closed)', () => {
  const home = tmpHome();
  try {
    // The caller's cwd is the REAL anti-hall repo (a real git worktree), so its
    // ground-truth identity is selfId — NOT the env-declared 'primary-x', which
    // names a workspace this process is not actually running in. Before the P0
    // fix this env value silently WON and advanced 'primary-x's cursor; now the
    // mismatching declaration is ignored and the ack is refused against the
    // REAL cwd-derived identity instead.
    const selfId = inst.primaryWorkspaceId(inst.resolveWorktree(REPO_ROOT));
    seedStore(home, 'primary-x', ['a', 'b']);
    const r = cli.run(['inbox', 'messages', 'primary-x', '--ack'],
      ctx(home, { env: { DEVSWARM_BUILDER_ID: 'primary-x' }, cwd: REPO_ROOT }));
    assert.equal(r.result.ok, false, 'env-spoof must NOT override a real, resolvable cwd');
    assert.equal(r.result.callerIdentity, selfId, 'caller identity is the REAL cwd-derived id, not the spoofed env value');
    assert.equal(fs.existsSync(cli.primaryCursorPath(home, 'primary-x')), false, 'cursor untouched — no impersonated ack landed');
  } finally { rm(home); }
});

test('callerIdentity falls back to primary-<worktreeHash(cwd)> (git toplevel) when DEVSWARM_BUILDER_ID is unset', () => {
  const home = tmpHome();
  try {
    const selfId = inst.primaryWorkspaceId(inst.resolveWorktree(REPO_ROOT));
    // v0.57 mesh (D24): cwd below is a REAL git worktree (REPO_ROOT/a subdir of
    // it), so `inbox messages --ack` (cmdInboxMessages, rekeyed) opens the
    // SHARED repoKey store — seed there, not the legacy per-id hash bucket.
    const repoKey = repokey.repoKeyForWorktree(REPO_ROOT);
    seedStore(home, selfId, ['a', 'b'], { hash: repoKey });
    // Own id, invoked from a SUBDIRECTORY of the worktree -> still resolves to the
    // same toplevel-derived id, so a self-ack from any subdir succeeds.
    const subdir = path.join(REPO_ROOT, 'plugins');
    const ok = cli.run(['inbox', 'messages', selfId, '--ack'], ctx(home, { env: {}, cwd: subdir }));
    assert.equal(ok.result.ok, true);
    assert.equal(ok.result.cursor, 2);

    // A different id, with no DEVSWARM_BUILDER_ID -> refused using the same cwd-derived identity.
    seedStore(home, 'primary-someone-else', ['x'], { hash: repoKey });
    const refused = cli.run(['inbox', 'messages', 'primary-someone-else', '--ack'], ctx(home, { env: {}, cwd: REPO_ROOT }));
    assert.equal(refused.result.ok, false);
    assert.equal(refused.result.callerIdentity, selfId);
  } finally { rm(home); }
});

test('parseArgs handles --k=v, repeatable, and bare flags', () => {
  const { flags, positionals } = cli.parseArgs(['x', '--a=1', '--b', '2', '--b', '3', '--json']);
  assert.deepEqual(positionals, ['x']);
  assert.equal(cli.one(flags, 'a'), '1');
  assert.deepEqual(cli.many(flags, 'b'), ['2', '3']);
  assert.equal(cli.one(flags, 'json'), undefined); // bare boolean -> no value
});

// F-B regression (v0.61.2): cmdRegister's descriptor write (writeDescriptorAtomic,
// unconditional) and its registry write (upsertRegistry, guarded by F2) used to
// diverge on a same-id path change — writeDescriptorAtomic always moved the
// descriptor to the new worktree, but the registry upsert (no opts) silently
// SKIPPED under the F2 id-collision guard (an existing row for this id already
// maps to a DIFFERENT non-null worktree_path), and cmdRegister returned
// {ok:true, action:'updated'} without checking. Re-registering an EXISTING id at
// a NEW same-project worktree is a legitimate flow (cross-project is already
// rejected by the P1-6 guard), so the fix passes allowPathChange:true for it.
test('F-B: re-registering an EXISTING id at a NEW same-project worktree keeps descriptor AND registry in sync; cross-project change is still rejected', () => {
  const home = tmpHome();
  const repo = makeGitRepoArchive('f-b-same-project');
  const linked = path.join(path.dirname(repo), path.basename(repo) + '-linked');
  cpArchive.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', linked, '-b', 'f-b-branch']);
  const otherRepo = makeGitRepoArchive('f-b-other-project');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const linkedKey = repokey.repoKeyForWorktree(linked);
    assert.equal(linkedKey, repoKey, 'precondition: a linked worktree of the same repo must share repoKey');

    // Initial registration at the MAIN worktree path.
    const r1 = cli.run(['register', 'ws-fb', '--worktree', repo, '--session', 's1'], ctx(home, { cwd: repo }));
    assert.equal(r1.result.ok, true);
    assert.equal(r1.result.descriptor.worktreePath, repo);

    // Re-register the SAME id at a NEW worktree path — the LINKED worktree of the
    // SAME project (same repoKey). This is the legitimate owner re-registration
    // flow F-B fixes.
    const r2 = cli.run(['register', 'ws-fb', '--worktree', linked, '--session', 's1'], ctx(home, { cwd: linked }));
    assert.equal(r2.result.ok, true, 'a same-project path change must succeed: ' + JSON.stringify(r2.result));
    assert.equal(r2.result.descriptor.worktreePath, linked, 'descriptor must reflect the NEW path');

    const desc = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'ws-fb'), 'utf8'));
    assert.equal(desc.worktreePath, linked);

    // Registry row must ALSO reflect the new path — no descriptor/registry divergence.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const row = s.listRegistry().find((x) => x.id === 'ws-fb');
      assert.ok(row, 'registry row must exist');
      assert.equal(row.worktreePath, linked, 'registry row must reflect the NEW path — must not diverge from the descriptor');
    } finally { s.close(); }

    // Cross-project change is still rejected — the P1-6 guard fires BEFORE
    // allowPathChange is ever reached.
    const r3 = cli.run(['register', 'ws-fb', '--worktree', otherRepo, '--session', 's1'], ctx(home, { cwd: linked }));
    assert.equal(r3.result.ok, false, 'a cross-project path change must still be rejected');
    assert.match(String(r3.result.error), /different project|cross-project/);
    const descAfterReject = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'ws-fb'), 'utf8'));
    assert.equal(descAfterReject.worktreePath, linked, 'a rejected cross-project register must not move the descriptor');
  } finally { rm(home); rm(repo); rm(otherRepo); }
});
