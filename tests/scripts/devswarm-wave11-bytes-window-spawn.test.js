'use strict';
// WAVE 11 — three devswarm.js defects, each verified against real code before
// the fix and mutation-checked after.
//
// 1. defect 0960924d28be (P2): `send`'s response `bytes` field was
//    `String(message).length` — UTF-16 CODE UNITS, not bytes. The field report
//    reconciled the gap exactly against em dashes (U+2014: 3 UTF-8 bytes, 1
//    UTF-16 unit) on two independent sends, and read the shortfall as evidence
//    the body had been TRUNCATED in transit. It had not been. A cosmetic
//    measurement bug produced a false data-loss alarm.
//
// 2. defect 3f6027ee462a (P2): `inbox messages` had only `--limit`
//    (earliest-first), so the only route to RECENT mail was the destructive
//    read-primary or a full dump. Worse, a `--tail 3` typed against it was
//    SILENTLY IGNORED — the caller got the OLDEST rows believing they asked for
//    the newest. `--since`/`--tail` are now honored on the non-acking verb and
//    REJECTED on every ack-bearing one (a window is not a contiguous prefix,
//    and this file's ack arithmetic can only express a prefix).
//
// 3. defect f85dedeaf61f (P1, anti-hall half): `spawn` returned ok/created
//    after `hivecontrol workspace create` succeeded and blind-seeded a registry
//    row (sessionId null) with ZERO post-create launch verification — while in
//    the field no session ever started and the row read ACTIVE for 25 minutes.
//    The create success schema has no session field, so `created:true` was
//    never evidence of a launch. `launched` now reports that separately, from
//    positive evidence only, and is never `false` (absence inside a short
//    window is not proof of failure).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wave11-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wave11-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id) {
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', 's-' + id,
      '--inbox', path.join(home, 'ndjson', id + '.ndjson'),
      '--cursor', path.join(home, 'ndjson-cursors', id + '.cursor')],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
}
function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: 'sender', to: toId, type: 'direct', urgency: 'normal', message: row.body, timestamp: row.ts };
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
    }
  } finally { s.close(); }
}

// =======================================================================
// 1. defect 0960924d28be — `bytes` must be UTF-8 BYTES
// =======================================================================

// The field's own arithmetic, reproduced as a fixture: one em dash is 3 UTF-8
// bytes but 1 UTF-16 code unit, so the pre-fix value under-reported by exactly
// 2 per em dash — which is what reconciled both field deltas (5807->5805 with
// one, 3760->3756 with two).
const EM = '—';

test('bytes: a send with multi-byte codepoints reports real UTF-8 byte length, not UTF-16 code units', () => {
  const home = tmpHome();
  const repo = makeGitRepo('bytes');
  try {
    const message = 'a' + EM + 'b' + EM + 'c'; // 5 code units, 9 UTF-8 bytes
    assert.strictEqual(message.length, 5, 'fixture sanity: 5 UTF-16 code units');
    assert.strictEqual(Buffer.byteLength(message, 'utf8'), 9, 'fixture sanity: 9 UTF-8 bytes');

    const r = cli.run(['send', '--broadcast', '--message', message], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.bytes, 9,
      `THE FIX: a field named bytes must report BYTES (got ${r.result.bytes}); the pre-fix value 5 under-reported by 2 per em dash and was read in the field as evidence of truncation that never happened`);
  } finally { rm(home); rm(repo); }
});

test('bytes: a pure-ASCII send is unchanged (the two measures coincide there — no regression for the common case)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('bytes-ascii');
  try {
    const r = cli.run(['send', '--broadcast', '--message', 'plain ascii body'], ctx(home, { cwd: repo }));
    assert.strictEqual(r.result.bytes, 16);
    assert.strictEqual(r.result.bytes, 'plain ascii body'.length, 'ASCII: byte length and code-unit length agree, so nothing moved');
  } finally { rm(home); rm(repo); }
});

test('bytes: the reported value equals the byte length of the body a reader gets back (end-to-end, not just the echo)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('bytes-e2e');
  try {
    register(home, repo, 'primary-bytes-e2e');
    const message = 'head' + EM + 'tail';
    const sent = cli.run(['send', '--to', 'primary-bytes-e2e', '--message', message], ctx(home, { cwd: repo }));
    assert.equal(sent.result.ok, true, JSON.stringify(sent.result));
    const read = cli.run(['inbox', 'messages', 'primary-bytes-e2e'], ctx(home, { cwd: repo }));
    const row = (read.result.messages || []).find((m) => m && m.hash === sent.result.hash);
    assert.ok(row, 'the sent row must be readable back: ' + JSON.stringify(read.result));
    assert.strictEqual(sent.result.bytes, Buffer.byteLength(row.body, 'utf8'),
      'the reported bytes must equal the STORED body\'s real byte size — that equality is what makes the field usable as an integrity check at all');
  } finally { rm(home); rm(repo); }
});

test('MUTATION-KILL (bytes): restoring String(message).length re-creates the em-dash undercount', () => {
  mutantKit.withMutant(
    "        bytes: Buffer.byteLength(String(message), 'utf8'),\n",
    '        bytes: String(message).length,\n',
    (mutatedCli) => {
      const home = tmpHome();
      const repo = makeGitRepo('bytes-mutant');
      try {
        const r = mutatedCli.run(['send', '--broadcast', '--message', 'a' + EM + 'b' + EM + 'c'], ctx(home, { cwd: repo }));
        assert.strictEqual(r.result.bytes, 5,
          'RED (expected on the mutant): the UTF-16 measure reports 5 for a 9-byte body. If this fails, Buffer.byteLength is not what fixes the undercount.');
      } finally { rm(home); rm(repo); }
    },
    { prefix: 'anti-hall-wave11-bytes-mutant' }
  );
});

// =======================================================================
// 2. defect 3f6027ee462a — bounded recent access: --since / --tail
// =======================================================================

function seedTen(home, repo, id) {
  register(home, repo, id);
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push({ body: 'm' + i, ts: 1700000000000 + i * 60000 });
  seedPartition(home, repo, id, rows);
  return rows;
}

test('window: --tail N returns the LAST N rows (the newest), not the first N', () => {
  const home = tmpHome();
  const repo = makeGitRepo('tail');
  try {
    seedTen(home, repo, 'primary-tail');
    const r = cli.run(['inbox', 'messages', 'primary-tail', '--tail', '3'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.deepStrictEqual(r.result.messages.map((m) => m.body), ['m8', 'm9', 'm10'],
      'THE FIX: pre-fix --tail was silently dropped and the caller got m1..m10 (oldest-first) believing they had asked for the newest');
    assert.strictEqual(r.result.count, 3);
    assert.strictEqual(r.result.window.tail, 3);
    assert.strictEqual(r.result.window.withheld, 7, 'withholding is reported, never silent');
    assert.strictEqual(r.result.total, 10, 'total keeps reporting the REAL untruncated figure');
  } finally { rm(home); rm(repo); }
});

test('window: --since <index> returns only rows after that per-partition index', () => {
  const home = tmpHome();
  const repo = makeGitRepo('since-index');
  try {
    seedTen(home, repo, 'primary-since-ix');
    const r = cli.run(['inbox', 'messages', 'primary-since-ix', '--since', '7'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.deepStrictEqual(r.result.messages.map((m) => m.body), ['m8', 'm9', 'm10'],
      'a bare integer is an INDEX — the same space `cursor` counts in, which is what the field request asked for');
    assert.deepStrictEqual(r.result.window.since, { kind: 'index', value: 7 });
  } finally { rm(home); rm(repo); }
});

test('window: --since <ISO date> returns only rows at/after that timestamp', () => {
  const home = tmpHome();
  const repo = makeGitRepo('since-iso');
  try {
    const rows = seedTen(home, repo, 'primary-since-iso');
    const cutoff = new Date(rows[7].ts).toISOString(); // m8's own ts
    const r = cli.run(['inbox', 'messages', 'primary-since-iso', '--since', cutoff], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.deepStrictEqual(r.result.messages.map((m) => m.body), ['m8', 'm9', 'm10'],
      'an ISO 8601 value is a TIMESTAMP cutoff (inclusive)');
    assert.strictEqual(r.result.window.since.kind, 'ts');
    assert.strictEqual(r.result.window.since.value, Date.parse(cutoff));
  } finally { rm(home); rm(repo); }
});

test('window: --since and --tail compose — since filters first, then the tail bounds what is left', () => {
  const home = tmpHome();
  const repo = makeGitRepo('since-tail');
  try {
    seedTen(home, repo, 'primary-both');
    const r = cli.run(['inbox', 'messages', 'primary-both', '--since', '5', '--tail', '2'], ctx(home, { cwd: repo }));
    assert.deepStrictEqual(r.result.messages.map((m) => m.body), ['m9', 'm10']);
    assert.strictEqual(r.result.window.tail, 2);
    assert.deepStrictEqual(r.result.window.since, { kind: 'index', value: 5 });
  } finally { rm(home); rm(repo); }
});

test('window: it is a PURE READ — no cursor is advanced and every withheld row is still readable', () => {
  const home = tmpHome();
  const repo = makeGitRepo('window-nonacking');
  try {
    seedTen(home, repo, 'primary-pure');
    const repoKey = repokey.repoKeyForWorktree(repo);
    const cursorBefore = (() => {
      const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
      try { return s.cursorValue('primary-pure'); } finally { s.close(); }
    })();
    cli.run(['inbox', 'messages', 'primary-pure', '--tail', '2'], ctx(home, { cwd: repo }));
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let cursorAfter, bodies;
    try {
      cursorAfter = s.cursorValue('primary-pure');
      bodies = s.listMessages('primary-pure', { sinceCursor: 0 }).map((m) => m.body);
    } finally { s.close(); }
    assert.strictEqual(cursorAfter, cursorBefore, 'a windowed read must never move a cursor — that is precisely why it is confined to the non-acking verb');
    assert.strictEqual(bodies.length, 10, 'and every withheld row is exactly where it was');
  } finally { rm(home); rm(repo); }
});

test('window: an ack-bearing verb REFUSES --tail — it is never silently ignored there', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reject-read');
  try {
    seedTen(home, repo, 'primary-reject');
    // `inbox read` is the ack-bearing verb the coordinator's item names. Its
    // ack target is a CONTIGUOUS unread prefix; a most-recent-N tail skips
    // untouched middle rows, which this file's ack arithmetic cannot express
    // without risking the message loss Fix Wave 2/3 closed.
    const r = cli.run(['inbox', 'read', 'primary-reject', '--tail', '3'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false, 'the refusal must be an explicit failure: ' + JSON.stringify(r.result));
    assert.strictEqual(r.result.reason, 'window-flags-unsupported-on-acking-verb');
    assert.match(r.result.error, /inbox messages/, 'and it must name the verb that DOES support the window');
  } finally { rm(home); rm(repo); }
});

test('window: read-primary, peek-primary, inbox ack/count and `inbox messages --ack` all refuse the window flags', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reject-all');
  try {
    seedTen(home, repo, 'primary-reject-all');
    const cases = [
      ['inbox', 'read-primary', 'primary-reject-all', '--tail', '2'],
      ['inbox', 'peek-primary', 'primary-reject-all', '--tail', '2'],
      ['inbox', 'ack', 'primary-reject-all', '--since', '3'],
      ['inbox', 'count', 'primary-reject-all', '--since', '3'],
      ['inbox', 'messages', 'primary-reject-all', '--ack', '--ack-as-owner', '--tail', '2'],
    ];
    for (const argv of cases) {
      const r = cli.run(argv, ctx(home, { cwd: repo }));
      assert.equal(r.result.ok, false, argv.join(' ') + ' must be refused, got: ' + JSON.stringify(r.result));
      assert.strictEqual(r.result.reason, 'window-flags-unsupported-on-acking-verb', argv.join(' '));
    }
    // And the refusal is a NO-OP: nothing was read, nothing acked.
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      assert.strictEqual(s.cursorValue('primary-reject-all'), 0, 'a refused call must not have acked anything');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('window: a malformed --tail / --since is an ERROR, never a silent fallback to the unwindowed read', () => {
  const home = tmpHome();
  const repo = makeGitRepo('bad-window');
  try {
    seedTen(home, repo, 'primary-bad');
    const bad = cli.run(['inbox', 'messages', 'primary-bad', '--tail', 'abc'], ctx(home, { cwd: repo }));
    assert.equal(bad.result.ok, false, JSON.stringify(bad.result));
    assert.strictEqual(bad.result.reason, 'bad-tail');
    const zero = cli.run(['inbox', 'messages', 'primary-bad', '--tail', '0'], ctx(home, { cwd: repo }));
    assert.equal(zero.result.ok, false, '--tail 0 is not a window, it is a mistake: ' + JSON.stringify(zero.result));
    const badSince = cli.run(['inbox', 'messages', 'primary-bad', '--since', 'not-a-date'], ctx(home, { cwd: repo }));
    assert.equal(badSince.result.ok, false, JSON.stringify(badSince.result));
    assert.strictEqual(badSince.result.reason, 'bad-since');
  } finally { rm(home); rm(repo); }
});

test('window: a plain `inbox messages` with NO window flag is byte-for-byte unchanged (no window key at all)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('window-absent');
  try {
    seedTen(home, repo, 'primary-plain');
    const r = cli.run(['inbox', 'messages', 'primary-plain'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.strictEqual(r.result.count, 10);
    assert.strictEqual(r.result.window, undefined, 'the pre-fix response shape is untouched when no window flag is passed');
  } finally { rm(home); rm(repo); }
});

test('MUTATION-KILL (window): dropping the projection makes --tail silently ignored again', () => {
  mutantKit.withMutant(
    '    if (windowTail !== null && messages.length > windowTail) messages = messages.slice(-windowTail);\n',
    '',
    (mutatedCli) => {
      const home = tmpHome();
      const repo = makeGitRepo('window-mutant');
      try {
        seedTen(home, repo, 'primary-window-mutant');
        const r = mutatedCli.run(['inbox', 'messages', 'primary-window-mutant', '--tail', '3'], ctx(home, { cwd: repo }));
        assert.strictEqual(r.result.count, 10,
          'RED (expected on the mutant): without the slice the flag is accepted and then ignored — the exact silent-drop this defect is about.');
      } finally { rm(home); rm(repo); }
    },
    { prefix: 'anti-hall-wave11-window-mutant' }
  );
});

test('MUTATION-KILL (window): dropping the ack-verb rejection lets `inbox read --tail` through', () => {
  mutantKit.withMutant(
    "  if (sub !== 'messages') {\n    const rej = inboxWindowRejection(flags, 'inbox ' + String(sub));\n    if (rej) return rej;\n  }\n",
    '',
    (mutatedCli) => {
      const home = tmpHome();
      const repo = makeGitRepo('reject-mutant');
      try {
        seedTen(home, repo, 'primary-reject-mutant');
        const r = mutatedCli.run(['inbox', 'read', 'primary-reject-mutant', '--tail', '3'], ctx(home, { cwd: repo }));
        assert.notStrictEqual(r.result.reason, 'window-flags-unsupported-on-acking-verb',
          'RED (expected on the mutant): without the guard the ack-bearing verb accepts and ignores the flag. If this fails, the rejection is not what protects the ack path.');
      } finally { rm(home); rm(repo); }
    },
    { prefix: 'anti-hall-wave11-reject-mutant' }
  );
});

// =======================================================================
// 3. defect f85dedeaf61f — spawn must not conflate CREATE with LAUNCH
// =======================================================================

// Every spawn test pins the launch window explicitly so the suite never sleeps
// on the default and never depends on it.
const spawnCtx = (home, repo, io, waitMs) => ctx(home, {
  cwd: repo, io, env: { ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: String(waitMs === undefined ? 0 : waitMs) },
});

test('spawn: with no launch evidence, `launched` is "unknown" — reported DISTINCTLY from created:true', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-unknown');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-wave11-never-launched-' + Date.now());
    const io = { run: () => ({ ok: true, raw: JSON.stringify({ branch: 'feature/x', path: newWt }) }) };
    const r = cli.run(['spawn', 'feature/x'], spawnCtx(home, repo, io, 0));

    assert.equal(r.result.ok, true, 'a missing launch signal must NEVER fail the spawn verb');
    assert.strictEqual(r.result.created, true);
    assert.strictEqual(r.result.registered, true);
    assert.strictEqual(r.result.launched, 'unknown',
      'THE FIX: pre-fix the response offered only created/registered, so a workspace that never started a session was indistinguishable from a healthy spawn (field: ACTIVE in the roster for 25 minutes, sessionId null, 0-byte heartbeat log)');
    assert.strictEqual(r.result.launchEvidence, null);
    assert.ok(typeof r.result.launchHint === 'string' && /roster|heartbeat/.test(r.result.launchHint),
      'and it must name how to settle the verdict later');
  } finally { rm(home); rm(repo); }
});

test('spawn: `launched` is never the unearned value `false` — absence inside a short window is not proof of failure', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-never-false');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-wave11-nf-' + Date.now());
    const io = { run: () => ({ ok: true, raw: JSON.stringify({ path: newWt }) }) };
    const r = cli.run(['spawn', 'br'], spawnCtx(home, repo, io, 0));
    assert.notStrictEqual(r.result.launched, false,
      'claiming NOT-launched from a 0ms observation would be the same class of unearned claim as the created:true-implies-launched this fixes');
  } finally { rm(home); rm(repo); }
});

test('spawn: a fresh heartbeat for the new mesh id upgrades `launched` to true with named evidence', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-heartbeat');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-wave11-hb-' + Date.now());
    const meshId = inst.primaryWorkspaceId(newWt);
    // The child's own session writes this; here it stands in for a session that
    // came up between create and the check. Written INSIDE the `create` stub so
    // it genuinely postdates the spawn's recency floor (captured just before
    // `create`) — the floor is what stops a PRIOR occupant's leftover beat from
    // counting as this spawn's launch evidence, so the beat that is supposed to
    // count must really be produced during the spawn, as it is in production.
    const hb = liveness.heartbeatPathFor(meshId, home);
    const io = {
      run: () => {
        fs.mkdirSync(path.dirname(hb), { recursive: true });
        fs.writeFileSync(hb, JSON.stringify({ id: meshId, ts: Date.now() }));
        return { ok: true, raw: JSON.stringify({ path: newWt }) };
      },
    };
    const r = cli.run(['spawn', 'feature/hb'], spawnCtx(home, repo, io, 0));
    assert.strictEqual(r.result.launched, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.launchEvidence, 'heartbeat', 'the evidence must be named, not just asserted');
    assert.strictEqual(r.result.launchHint, undefined, 'no hint once the verdict is settled');
  } finally { rm(home); rm(repo); }
});

test('spawn: a registry row whose sessionId the CHILD filled in over the null seed counts as launch evidence', () => {
  // VERIFIED ORDERING (this is why the predicate is tested directly rather
  // than through cmdSpawn): cmdSpawn's own seed upsert writes sessionId null
  // and runs BEFORE the poll, so it overwrites any row a fixture pre-seeds.
  // In production the child registers DURING the poll window, which this
  // exercises against the predicate itself.
  const home = tmpHome();
  const repo = makeGitRepo('spawn-regsession');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-wave11-rs-' + Date.now());
    const meshId = inst.primaryWorkspaceId(newWt);
    const repoKey = repokey.repoKeyForWorktree(repo);
    const openStore = () => storeLib.openStore({ home, hash: repoKey, backend: 'journal' });

    const seeded = openStore();
    try { seeded.upsertRegistry({ id: meshId, worktreePath: newWt, sessionId: null }); } finally { seeded.close(); }
    const before = cli.checkSpawnLaunch(meshId, ctx(home, { cwd: repo, env: { ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0' } }), openStore);
    assert.strictEqual(before.launched, 'unknown', 'the blind seed alone is NOT evidence — that is the whole defect');

    const child = openStore();
    try { child.upsertRegistry({ id: meshId, worktreePath: newWt, sessionId: 'a-real-child-session' }); } finally { child.close(); }
    const after = cli.checkSpawnLaunch(meshId, ctx(home, { cwd: repo, env: { ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0' } }), openStore);
    assert.strictEqual(after.launched, true, JSON.stringify(after));
    assert.strictEqual(after.evidence, 'registry-session',
      'only the child\'s own register can make sessionId non-null over the null seed — that is what makes it evidence');
  } finally { rm(home); rm(repo); }
});

test('spawn: the launch window is configurable, and a bad env value falls back to the default instead of silently disabling the check', () => {
  assert.strictEqual(cli.spawnLaunchWaitMs({ ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '250' }), 250);
  assert.strictEqual(cli.spawnLaunchWaitMs({ ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0' }), 0, '0 means one immediate check, no sleep');
  const dflt = cli.spawnLaunchWaitMs({});
  assert.ok(dflt > 0 && dflt <= 2000, `the default must be small (got ${dflt}ms) — this verb must never block long`);
  assert.strictEqual(cli.spawnLaunchWaitMs({ ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: 'abc' }), dflt);
  assert.strictEqual(cli.spawnLaunchWaitMs({ ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '-5' }), dflt);
});

test('spawn: the launch check is bounded and never blocks past its window', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-bounded');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-wave11-bounded-' + Date.now());
    const io = { run: () => ({ ok: true, raw: JSON.stringify({ path: newWt }) }) };
    const started = Date.now();
    const r = cli.run(['spawn', 'feature/bounded'], spawnCtx(home, repo, io, 300));
    const elapsed = Date.now() - started;
    assert.strictEqual(r.result.launched, 'unknown');
    assert.strictEqual(r.result.launchWindowMs, 300, 'the window must be reported so the reader can judge the verdict');
    assert.ok(elapsed < 5000, `the check must stay bounded (took ${elapsed}ms for a 300ms window)`);
  } finally { rm(home); rm(repo); }
});

test('spawn: a create with no resolvable path still returns launched:"unknown" (nothing to poll for) and never fails', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-nopath');
  try {
    const io = { run: () => ({ ok: true, raw: 'not json at all' }) };
    const r = cli.run(['spawn', 'feature/y'], spawnCtx(home, repo, io, 0));
    assert.equal(r.result.ok, true);
    assert.strictEqual(r.result.registered, false);
    assert.strictEqual(r.result.launched, 'unknown');
  } finally { rm(home); rm(repo); }
});

test('MUTATION-KILL (spawn): reverting to a hardcoded launched:true re-conflates create with launch', () => {
  mutantKit.withMutant(
    '    launched: launch.launched,\n',
    '    launched: true,\n',
    (mutatedCli) => {
      const home = tmpHome();
      const repo = makeGitRepo('spawn-mutant');
      try {
        const newWt = path.join(os.tmpdir(), 'anti-hall-wave11-mutant-' + Date.now());
        const io = { run: () => ({ ok: true, raw: JSON.stringify({ path: newWt }) }) };
        const r = mutatedCli.run(['spawn', 'br'], spawnCtx(home, repo, io, 0));
        assert.strictEqual(r.result.launched, true,
          'RED (expected on the mutant): a workspace with zero launch evidence reports launched:true — the exact false-confidence the field report hit. If this fails, checkSpawnLaunch is not what produces the honest verdict.');
      } finally { rm(home); rm(repo); }
    },
    { prefix: 'anti-hall-wave11-spawn-mutant' }
  );
});
