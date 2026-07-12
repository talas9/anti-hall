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

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-cli-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

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
    // store registry + summary reflect it
    const sum = storeLib.readSummary(home);
    assert.ok(sum && sum.workspaces && sum.workspaces.w1);
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
    assert.equal(desc.worktreePath, process.cwd(), 'worktreePath defaults to the cwd');
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

test('workspaces list emits the derived projection', () => {
  const home = tmpHome();
  try {
    cli.run(['register', 'a', '--worktree', '/wt/a', '--session', 's'], ctx(home));
    cli.run(['register', 'b', '--worktree', '/wt/b', '--session', 's'], ctx(home));
    const r = cli.run(['workspaces', 'list'], ctx(home));
    assert.equal(r.result.count, 2);
    assert.deepEqual(r.result.workspaces.map((w) => w.id).sort(), ['a', 'b']);
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
    // dropped from the projection
    const list = cli.run(['workspaces', 'list'], ctx(home));
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

test('parseArgs handles --k=v, repeatable, and bare flags', () => {
  const { flags, positionals } = cli.parseArgs(['x', '--a=1', '--b', '2', '--b', '3', '--json']);
  assert.deepEqual(positionals, ['x']);
  assert.equal(cli.one(flags, 'a'), '1');
  assert.deepEqual(cli.many(flags, 'b'), ['2', '3']);
  assert.equal(cli.one(flags, 'json'), undefined); // bare boolean -> no value
});
