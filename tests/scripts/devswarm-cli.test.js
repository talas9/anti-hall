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
