'use strict';
// R11-B — the second Wave-11 batch. Each item states the ROOT CAUSE proven from
// the source before the fix, and each is mutation-checked where the fix is a
// single discriminating expression.
//
// 1. R11-A3 (P2): `inbox messages --tail N` ran AFTER the per-source read cap,
//    which by design keeps an EARLIEST structural prefix (devswarm.js's
//    "UNBOUNDED-READ CAP" block). Under `truncated:true` the tail therefore
//    returned the last N of the OLDEST batch while presenting them as the
//    newest. Reversing the cap's keep-direction is not available (the ack
//    arithmetic depends on the prefix property), so the call now REFUSES with
//    `reason:'tail-under-truncation'` and points at `--since`.
//
// 1b. A7: undated rows sort to +Infinity, i.e. straight into the slice `--tail`
//    takes from, so one legacy partition can fill the entire tail. The tail
//    path now reports `window.undatedKept` the way `--since` already did.
//
// 2. 13dedc334eb6 (P2): companion/lib/devswarm-drain-marker.js shipped with NO
//    writer — the parent gate's in-flight-drain downgrade could never fire. The
//    ack-bearing read path now marks at entry and clears in a `finally`.
//
// 3. carry-out (g): `heartbeat --summary`'s ownership refusal is benign
//    (`ok:true`) by design, but nothing said the SUMMARY was discarded.
//
// 4. c2a7813aa7d3 (P1): the id-derived authority gate had no escape hatch, so a
//    legitimate cross-project archive was impossible. `--force-cross-project
//    <id>` opens it, id-exact and audited.
//
// 5. b712da3bf077 (P1): no CLI targeted orphaned mesh partitions; a bulk attempt
//    with existing tooling died at 20/88. `reap-orphans` covers the shape,
//    dry-run first, capped, archive-verified.
//
// 6. d9a823ff1ca0 (P1): mesh registry vs hivecontrol drift, both directions,
//    with no way to see it. `reconcile-registry` reports it and pins the
//    upstream JSON shape instead of guessing.
//
// 7. Critic (A/B): `checkSpawnLaunch` accepted a PRIOR occupant's still-"fresh"
//    heartbeat as this spawn's launch evidence, and `spawnLaunchWaitMs` had no
//    upper bound (a synchronous Atomics.wait for as long as the env said).

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
const drainMarker = require('../../plugins/anti-hall/companion/lib/devswarm-drain-marker.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r11b-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r11b-repo-' + tag + '-'));
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
// seedPartition — append `rows` ({body, ts}) into `toId`'s mesh partition.
function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = {
        from: 'sender', to: toId, type: 'direct', urgency: 'normal',
        message: row.body, timestamp: row.ts,
      };
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
    }
  } finally { s.close(); }
}

// ===========================================================================
// 1. R11-A3 — --tail under truncation
// ===========================================================================

// The discriminating fixture: 12 rows, --limit 5 so the cap fires and keeps the
// EARLIEST 5, then --tail 2. Pre-fix this returned rows 4 and 5 (the last two of
// the oldest five) labelled as the newest; rows 11-12 were never even read.
//
// WHY A SIBLING PARTITION IS PART OF THE FIXTURE (verified from the source, not
// assumed): the per-source read cap is gated on `(wantsUnion || meshUnionActive)`,
// and `wantsUnion` is `doAck || forceUnread` — both of which make `windowActive`
// FALSE, since the window flags are refused on every ack-bearing/unread-scoped
// call. So the only way a truncated read and a `--tail` can co-occur at all is
// `meshUnionActive`: a second registry row sharing this worktree, which widens
// the read across sibling partitions. That is the exact shape a Primary with
// co-located workspaces has in the field, and it is the ONLY reachable form of
// the A3 defect.
function seedTruncatable(tag) {
  const home = tmpHome();
  const repo = makeGitRepo(tag);
  const id = 'wt-' + path.basename(repo).slice(-8);
  const sibling = id + '-sib';
  register(home, repo, id);
  register(home, repo, sibling); // same worktree => meshUnionActive
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push({ body: 'row-' + i, ts: 1000 + i });
  seedPartition(home, repo, id, rows);
  return { home, repo, id, sibling };
}

test('R11-A3: `--tail` under a TRUNCATED read refuses with tail-under-truncation instead of returning the oldest rows as the newest', () => {
  const f = seedTruncatable('tail-trunc');
  try {
    // Sanity first: the cap really does fire at this limit, and really does
    // keep the EARLIEST rows. Without this the refusal below could pass for
    // the wrong reason.
    const capped = cli.run(['inbox', 'messages', f.id, '--limit', '5'], ctx(f.home, { cwd: f.repo }));
    assert.strictEqual(capped.result.truncated, true, 'precondition: the read is truncated');
    assert.strictEqual(capped.result.messages[0].body, 'row-1',
      'precondition: the cap keeps the EARLIEST prefix — this is exactly why a tail over it is a lie');

    const r = cli.run(['inbox', 'messages', f.id, '--limit', '5', '--tail', '2'], ctx(f.home, { cwd: f.repo }));
    assert.strictEqual(r.result.ok, false, JSON.stringify(r.result));
    assert.strictEqual(r.result.reason, 'tail-under-truncation');
    assert.strictEqual(r.result.truncated, true);
    assert.strictEqual(r.result.requestedTail, 2);
    assert.match(r.result.hint, /--since/,
      'the refusal must name the flag that actually reaches recent mail, not just say no');
    assert.strictEqual(r.result.messages, undefined,
      'a refusal must not also hand back a set of messages the caller might use');
  } finally { rm(f.home); rm(f.repo); }
});

test('R11-A3: `--tail` on an UNtruncated read is unaffected and still returns the newest rows', () => {
  const f = seedTruncatable('tail-ok');
  try {
    const r = cli.run(['inbox', 'messages', f.id, '--tail', '2'], ctx(f.home, { cwd: f.repo }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.truncated, undefined, 'precondition: nothing was truncated');
    assert.deepStrictEqual(r.result.messages.map((m) => m.body), ['row-11', 'row-12'],
      'the genuine newest two — the refusal must be scoped to the truncated case only');
  } finally { rm(f.home); rm(f.repo); }
});

test('R11-A3 MUTATION-KILL: dropping the truncation guard restores the silent oldest-as-newest tail', () => {
  mutantKit.withMutant(
    '    if (windowTail !== null && truncatedCount > 0) {\n',
    '    if (false) {\n',
    (mutatedCli) => {
      const f = seedTruncatable('tail-mutant');
      try {
        const r = mutatedCli.run(['inbox', 'messages', f.id, '--limit', '5', '--tail', '2'],
          ctx(f.home, { cwd: f.repo }));
        assert.strictEqual(r.result.ok, true, 'RED (expected on the mutant): the call succeeds instead of refusing');
        assert.deepStrictEqual(r.result.messages.map((m) => m.body), ['row-4', 'row-5'],
          'RED (expected on the mutant): rows 4-5 (the tail of the OLDEST five) are returned as if they were the newest, '
          + 'while rows 11-12 were never read. If this fails, the truncation guard is not what fixes A3.');
      } finally { rm(f.home); rm(f.repo); }
    },
    { prefix: 'anti-hall-r11b-tail-mutant' }
  );
});

test('A7: the tail path reports window.undatedKept — undated rows sort last and can fill the whole tail', () => {
  const home = tmpHome();
  const repo = makeGitRepo('tail-undated');
  try {
    const id = 'wt-undated';
    register(home, repo, id);
    seedPartition(home, repo, id, [{ body: 'dated-1', ts: 1000 }, { body: 'dated-2', ts: 2000 }]);
    // Two LEGACY rows carrying no `ts` at all. They have to be appended to the
    // journal directly: appendMeshMessage defaults a missing timestamp to
    // Date.now() (verified), so the only way a ts-less row exists is as
    // pre-existing store data — which is exactly the "legacy partition" case
    // A7 is about. listMessages surfaces such a row as `ts: null`, and the
    // merge sort maps that to +Infinity, i.e. to the very end of the array —
    // precisely where `--tail 2` slices. So the "newest two" are in fact the
    // two with no date at all.
    const repoKey = repokey.repoKeyForWorktree(repo);
    const msgs = path.join(storeLib.journalDirForHash(home, repoKey), 'messages.ndjson');
    fs.appendFileSync(msgs,
      JSON.stringify({ workspaceId: id, body: 'undated-1', hash: 'legacy-1', mtype: 'direct' }) + '\n'
      + JSON.stringify({ workspaceId: id, body: 'undated-2', hash: 'legacy-2', mtype: 'direct' }) + '\n');

    const r = cli.run(['inbox', 'messages', id, '--tail', '2'], ctx(home, { cwd: repo }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.window.tail, 2);
    assert.strictEqual(r.result.window.undatedKept, 2,
      'both delivered rows are undated — the caller must be able to see that the "tail" is not date-ordered at all');
  } finally { rm(home); rm(repo); }
});

test('A7: a --tail read whose rows are ALL dated reports no undatedKept (the field is a signal, not noise)', () => {
  const f = seedTruncatable('tail-dated');
  try {
    const r = cli.run(['inbox', 'messages', f.id, '--tail', '2'], ctx(f.home, { cwd: f.repo }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.window.undatedKept, undefined,
      'omitted when zero, matching the surrounding omitted-when-empty convention');
  } finally { rm(f.home); rm(f.repo); }
});

// ===========================================================================
// 2. 13dedc334eb6 — the drain-marker WRITER
// ===========================================================================

function seedForRead(tag) {
  const home = tmpHome();
  const repo = makeGitRepo(tag);
  const id = 'primary-' + path.basename(repo).slice(-8);
  register(home, repo, id);
  seedPartition(home, repo, id, [{ body: 'm1', ts: 1000 }, { body: 'm2', ts: 2000 }]);
  return { home, repo, id };
}

test('drain marker: an ack-bearing read CLEARS the marker on the way out (no marker survives a completed drain)', () => {
  const f = seedForRead('drain-clear');
  try {
    const c = ctx(f.home, { cwd: f.repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-clear' } });
    const r = cli.run(['inbox', 'read-primary', f.id], c);
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(drainMarker.readDrainMarker(f.home, f.id, {}), null,
      'a finished drain must leave NO marker — a lingering one would silence the parent gate until its TTL expired');
    assert.ok(!fs.existsSync(drainMarker.drainMarkerPathFor(f.id, f.home)),
      'and the file itself is gone, not merely stale');
  } finally { rm(f.home); rm(f.repo); }
});

test('drain marker: DURING the read the marker exists, carries this session id, and is fresh', () => {
  const f = seedForRead('drain-during');
  try {
    // Observe the marker from INSIDE the read by throwing partway through it:
    // the throw proves the marker was written at ENTRY (before the work), and
    // the `finally` still has to clean it up afterwards.
    let seen = null;
    const openStoreReal = storeLib.openStore;
    storeLib.openStore = function patched(...args) {
      seen = drainMarker.readDrainMarker(f.home, f.id, {});
      storeLib.openStore = openStoreReal; // one-shot
      throw new Error('boom: simulated mid-drain failure');
    };
    let threw = false;
    try {
      cli.run(['inbox', 'read-primary', f.id], ctx(f.home, { cwd: f.repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-during' } }));
    } catch (_) { threw = true; } finally { storeLib.openStore = openStoreReal; }

    assert.ok(seen, 'a marker must exist while the drain is in flight — that is the whole point of the fix');
    assert.strictEqual(seen.sessionId, 'sess-during',
      'the id the parent gate compares against payload.session_id is CLAUDE_CODE_SESSION_ID');
    assert.strictEqual(seen.stale, false, 'and it must be fresh, or the gate ignores it');
    assert.strictEqual(seen.pid, process.pid, 'the pid leg is recorded too');
    // The `finally` must clear it even though the read blew up.
    assert.strictEqual(drainMarker.readDrainMarker(f.home, f.id, {}), null,
      'a THROWN drain must still clear its marker, or a crash silences the gate for a full TTL');
    assert.ok(threw || true, 'the throw is swallowed by run()\'s own error handling; the marker state is what matters');
  } finally { rm(f.home); rm(f.repo); }
});

test('drain marker: a NON-acking `inbox messages` read writes no marker (a read that consumes nothing is not a drain)', () => {
  const f = seedForRead('drain-noack');
  try {
    const r = cli.run(['inbox', 'messages', f.id], ctx(f.home, { cwd: f.repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-noack' } }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.ok(!fs.existsSync(drainMarker.drainMarkerPathFor(f.id, f.home)),
      'a pure read must never be able to silence the gate');
  } finally { rm(f.home); rm(f.repo); }
});

// ===========================================================================
// 3. carry-out (g) — heartbeat --summary ownership refusal
// ===========================================================================

test('carry-out (g): a --summary refused for ownership stays ok:true but now reports dropped + dropReason', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb-drop');
  const otherRepo = makeGitRepo('hb-drop-other');
  try {
    const owner = 'wt-owner';
    register(home, repo, owner);
    // The caller must be somewhere the target does NOT resolve from. Calling
    // from the owner's OWN worktree resolves to the owner via the mesh id no
    // matter what DEVSWARM_BUILDER_ID says (verified) — so the refusal fixture
    // has to run from a DIFFERENT worktree, which is also the real-world shape
    // of "a workspace summarising on another's behalf".
    const r = cli.run(['heartbeat', owner, '--summary', 'work in progress'],
      ctx(home, { cwd: otherRepo, env: { DEVSWARM_BUILDER_ID: 'someone-else-entirely' } }));
    assert.strictEqual(r.result.ok, true,
      'the refusal remains BENIGN at the top level — the base heartbeat succeeded and the control worked');
    assert.strictEqual(r.code, 0, 'and the exit code stays 0, unchanged');
    const mb = r.result.meshBroadcast;
    assert.strictEqual(mb.ok, false);
    assert.strictEqual(mb.dropped, true, 'the caller must be able to see the summary was NOT applied');
    assert.strictEqual(mb.dropReason, mb.reason, 'dropReason names the same cause the reason field carries');
    assert.match(mb.error, /DROPPED/, 'and the human-readable error says so too');
  } finally { rm(home); rm(repo); rm(otherRepo); }
});

test('carry-out (g): the OTHER benign reason (no-project) is untouched — no dropped/dropReason added', () => {
  const home = tmpHome();
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r11b-nongit-'));
  try {
    const r = cli.run(['heartbeat', 'wt-x', '--summary', 'hello'], ctx(home, { cwd: nonGit }));
    assert.strictEqual(r.result.ok, true);
    assert.strictEqual(r.result.meshBroadcast.reason, 'no-project');
    assert.strictEqual(r.result.meshBroadcast.dropped, undefined,
      'the brief scoped this to the ownership refusal — no other benign shape may change');
  } finally { rm(home); rm(nonGit); }
});

// ===========================================================================
// 4. c2a7813aa7d3 — --force-cross-project
// ===========================================================================

// A workspace registered under project A, archived from project B's cwd.
function seedCrossProject(tag) {
  const home = tmpHome();
  const repoA = makeGitRepo(tag + '-a');
  const repoB = makeGitRepo(tag + '-b');
  const id = 'wt-' + path.basename(repoA).slice(-8);
  register(home, repoA, id);
  return { home, repoA, repoB, id };
}

test('c2a7813aa7d3: a cross-project archive is still REFUSED without the flag, and the refusal now names the hatch', () => {
  const f = seedCrossProject('xproj-refuse');
  try {
    const r = cli.run(['archive', f.id], ctx(f.home, { cwd: f.repoB }));
    assert.strictEqual(r.result.ok, false, JSON.stringify(r.result));
    assert.strictEqual(r.result.reason, 'project-context-mismatch', 'the P0 gate still fires by default');
    assert.match(r.result.error, /--force-cross-project/,
      'the escape hatch must be discoverable from the refusal itself');
  } finally { rm(f.home); rm(f.repoA); rm(f.repoB); }
});

test('c2a7813aa7d3: the flag carrying the WRONG id is refused (it must restate the exact target)', () => {
  const f = seedCrossProject('xproj-wrongid');
  try {
    const r = cli.run(['archive', f.id, '--force-cross-project', 'some-other-workspace'], ctx(f.home, { cwd: f.repoB }));
    assert.strictEqual(r.result.ok, false, JSON.stringify(r.result));
    assert.strictEqual(r.result.reason, 'project-context-mismatch');
    assert.strictEqual(r.result.forceCrossProjectRejected, 'some-other-workspace');
    assert.match(r.result.error, /does NOT match this workspace id/,
      'a copy-pasted flag naming a different workspace must never open the gate');
  } finally { rm(f.home); rm(f.repoA); rm(f.repoB); }
});

test('c2a7813aa7d3: the flag naming the EXACT id is accepted, archives, and writes one audit line', () => {
  const f = seedCrossProject('xproj-accept');
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r11b-logs-'));
  const prevLogDir = process.env.ANTI_HALL_LOG_DIR;
  process.env.ANTI_HALL_LOG_DIR = logDir;
  try {
    const r = cli.run(['archive', f.id, '--force-cross-project', f.id], ctx(f.home, { cwd: f.repoB }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.descriptorArchived, true, 'the archive actually happened');

    const logPath = path.join(logDir, 'devswarm-authority-override.log');
    assert.ok(fs.existsSync(logPath), 'an accepted override must never be invisible after the fact');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'exactly ONE NDJSON line per override');
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.verb, 'archive');
    assert.strictEqual(entry.id, f.id);
    assert.ok(entry.ts, 'timestamped');
    assert.ok(entry.targetProject, 'the project the workspace is registered under');
    assert.notStrictEqual(entry.cwdProject, entry.targetProject,
      'the two project keys must actually differ — otherwise this was not a cross-project override at all');
  } finally {
    if (prevLogDir === undefined) delete process.env.ANTI_HALL_LOG_DIR; else process.env.ANTI_HALL_LOG_DIR = prevLogDir;
    rm(f.home); rm(f.repoA); rm(f.repoB); rm(logDir);
  }
});

// The gate guards four verbs. Archive is the ONLY one given the hatch, because
// the other three would move data / advance a foreign cursor while overridden —
// the exact P0 the gate closed. Pin that narrowing so a later change cannot
// widen it silently.
for (const verb of ['ensure', 'gate', 'inbox-ack']) {
  test('c2a7813aa7d3 NARROWING: `' + verb + '` still refuses cross-project EVEN WITH the flag (only archive gets the hatch)', () => {
    const f = seedCrossProject('xproj-narrow-' + verb.replace(/[^a-z]/g, ''));
    try {
      const argv = verb === 'inbox-ack'
        ? ['inbox', 'ack', f.id, '--force-cross-project', f.id]
        : verb === 'gate'
          ? ['gate', f.id, '--set', 'done', '--force-cross-project', f.id]
          : ['ensure', f.id, '--worktree', f.repoB, '--force-cross-project', f.id];
      const r = cli.run(argv, ctx(f.home, { cwd: f.repoB }));
      assert.strictEqual(r.result.ok, false, verb + ' must stay refused: ' + JSON.stringify(r.result));
      assert.strictEqual(r.result.reason, 'project-context-mismatch',
        'overriding this verb would re-open the cross-project data movement the gate exists to stop');
    } finally { rm(f.home); rm(f.repoA); rm(f.repoB); }
  });
}

// ===========================================================================
// 5. b712da3bf077 — reap-orphans
// ===========================================================================

// An ORPHAN in computeSummary's A2 sense: a partition that HAS messages (so
// listWorkspaceIds enumerates it) with real unread, and NO registry row to read
// them. Seeded directly, with no `register` call at all — which is both the
// simplest construction and the truest one: an orphan has never had, or no
// longer has, a registry row.
//
// (Registering several ids into one worktree does NOT work as a fixture here —
// same-worktree rows are duplicates by construction and the registration path
// folds all but one away, so only a single orphan would ever survive. Verified;
// this is why the partitions below are seeded rather than registered.)
function seedOrphans(tag, count) {
  const home = tmpHome();
  const repo = makeGitRepo(tag);
  const repoKey = repokey.repoKeyForWorktree(repo);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = 'wt-orph-' + tag.replace(/[^a-z0-9]/g, '') + '-' + i;
    seedPartition(home, repo, id, [{ body: 'stranded-' + i + '-a', ts: 5000 + i }, { body: 'stranded-' + i + '-b', ts: 6000 + i }]);
    ids.push(id);
  }
  return { home, repo, ids, repoKey };
}

test('reap-orphans: the DEFAULT is a dry run — it lists candidates and changes nothing', () => {
  const f = seedOrphans('dry', 2);
  try {
    const before = cli.run(['inbox', 'count', f.ids[0]], ctx(f.home, { cwd: f.repo }));
    const r = cli.run(['reap-orphans'], ctx(f.home, { cwd: f.repo }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.mode, 'dry-run', 'bare `reap-orphans` must NEVER mutate');
    assert.strictEqual(r.result.candidateCount, 2);
    const c = r.result.candidates[0];
    assert.ok(c.partitionId && Number.isFinite(c.unread) && c.reason,
      'each candidate names itself, its unread count and why it qualified: ' + JSON.stringify(c));
    assert.ok(Number.isFinite(c.lastMessageTs), 'and when its newest message arrived');
    assert.ok(!fs.existsSync(cli.reapedDir(f.home)), 'a dry run writes no archive');
    const after = cli.run(['inbox', 'count', f.ids[0]], ctx(f.home, { cwd: f.repo }));
    assert.strictEqual(after.result.unreadTotal, before.result.unreadTotal, 'and moves no cursor');
  } finally { rm(f.home); rm(f.repo); }
});

test('reap-orphans: --apply without --max is refused (there is deliberately no unbounded apply)', () => {
  const f = seedOrphans('nomax', 1);
  try {
    const r = cli.run(['reap-orphans', '--apply'], ctx(f.home, { cwd: f.repo, stdinIsTty: true }));
    assert.strictEqual(r.result.ok, false);
    assert.strictEqual(r.result.reason, 'max-required');
  } finally { rm(f.home); rm(f.repo); }
});

test('reap-orphans: a non-positive / non-integer --max is refused', () => {
  const f = seedOrphans('badmax', 1);
  try {
    for (const bad of ['0', '-1', '1.5', 'all']) {
      const r = cli.run(['reap-orphans', '--apply', '--max', bad], ctx(f.home, { cwd: f.repo, stdinIsTty: true }));
      assert.strictEqual(r.result.ok, false, '--max ' + bad + ' must be refused');
      assert.strictEqual(r.result.reason, 'bad-max', '--max ' + bad);
    }
  } finally { rm(f.home); rm(f.repo); }
});

test('reap-orphans: --max CAPS the pass — never more than N, and the shortfall is reported', () => {
  const f = seedOrphans('cap', 3);
  try {
    const r = cli.run(['reap-orphans', '--apply', '--max', '2'], ctx(f.home, { cwd: f.repo, stdinIsTty: true }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.candidateCount, 3);
    assert.strictEqual(r.result.reapedCount, 2, 'exactly N, never more');
    assert.strictEqual(r.result.capped, true, 'and a capped pass must never look like a complete one');
    assert.strictEqual(r.result.remaining, 1);
  } finally { rm(f.home); rm(f.repo); }
});

test('reap-orphans: REFUSES to apply under ANTIHALL_DEVSWARM_AUTOMATION=1 (no cron/supervisor may retire a partition)', () => {
  const f = seedOrphans('automation', 1);
  try {
    const r = cli.run(['reap-orphans', '--apply', '--max', '1'],
      ctx(f.home, { cwd: f.repo, stdinIsTty: true, env: { ANTIHALL_DEVSWARM_AUTOMATION: '1' } }));
    assert.strictEqual(r.result.ok, false);
    assert.strictEqual(r.result.reason, 'automation-refused');
    assert.ok(!fs.existsSync(cli.reapedDir(f.home)), 'and it refuses BEFORE doing any work');
  } finally { rm(f.home); rm(f.repo); }
});

test('reap-orphans: REFUSES to apply from a non-TTY stdin unless --i-am-a-human is also passed', () => {
  const f = seedOrphans('tty', 1);
  try {
    const refused = cli.run(['reap-orphans', '--apply', '--max', '1'], ctx(f.home, { cwd: f.repo, stdinIsTty: false }));
    assert.strictEqual(refused.result.ok, false);
    assert.strictEqual(refused.result.reason, 'non-interactive-refused');

    const allowed = cli.run(['reap-orphans', '--apply', '--max', '1', '--i-am-a-human'],
      ctx(f.home, { cwd: f.repo, stdinIsTty: false }));
    assert.strictEqual(allowed.result.ok, true, JSON.stringify(allowed.result));
    assert.strictEqual(allowed.result.reapedCount, 1, 'the human claim is the documented second belt');
  } finally { rm(f.home); rm(f.repo); }
});

test('reap-orphans: archives + VERIFIES the unread rows before retiring, and the partition stops being an orphan', () => {
  const f = seedOrphans('archive', 1);
  const id = f.ids[0];
  try {
    const r = cli.run(['reap-orphans', '--apply', '--max', '1'], ctx(f.home, { cwd: f.repo, stdinIsTty: true }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.reapedCount, 1);

    const archivePath = path.join(cli.reapedDir(f.home), id + '.ndjson');
    assert.ok(fs.existsSync(archivePath), 'the archive must exist BEFORE anything is retired');
    const lines = fs.readFileSync(archivePath, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, 'every unread row is archived, one per line');
    const bodies = lines.map((l) => JSON.parse(l).message.body).sort();
    assert.deepStrictEqual(bodies, ['stranded-0-a', 'stranded-0-b'], 'with their real content, not a summary');

    // LOSS-FREE: the source rows are still in the store, only the cursor moved.
    const s = storeLib.openStore({ home: f.home, hash: f.repoKey, backend: 'journal' });
    try {
      assert.strictEqual(s.messageCount(id), 2, 'no message row was deleted — this is a retire, not a destroy');
      assert.strictEqual(s.cursorValue(id), 2, 'the partition is retired by advancing its cursor to its own count');
    } finally { s.close(); }

    // And it no longer shows up as an orphan, which is the nagging the defect reported.
    const again = cli.run(['reap-orphans'], ctx(f.home, { cwd: f.repo }));
    assert.strictEqual(again.result.candidateCount, 0, 'the per-turn ORPHANED MESH warning has nothing left to report');
  } finally { rm(f.home); rm(f.repo); }
});

test('reap-orphans: a FAILED archive verify refuses to retire that partition — the source is left untouched', () => {
  const f = seedOrphans('verifyfail', 1);
  const id = f.ids[0];
  const realWrite = fs.writeFileSync;
  try {
    // Simulate a short/truncating write: the file lands with FEWER rows than
    // were meant to be archived. Loss-free means this must abort the retire.
    fs.writeFileSync = function patched(p, data, ...rest) {
      if (String(p).includes(path.join('reaped', id))) {
        const first = String(data).split('\n').filter(Boolean)[0];
        return realWrite.call(fs, p, first + '\n', ...rest); // 1 of 2 rows
      }
      return realWrite.call(fs, p, data, ...rest);
    };
    const r = cli.run(['reap-orphans', '--apply', '--max', '1'], ctx(f.home, { cwd: f.repo, stdinIsTty: true }));
    fs.writeFileSync = realWrite;

    assert.strictEqual(r.result.ok, true, 'the pass itself completes and reports honestly');
    assert.strictEqual(r.result.reapedCount, 0, 'but NOTHING was retired');
    assert.strictEqual(r.result.failedCount, 1);
    assert.strictEqual(r.result.failed[0].reason, 'archive-verify-failed');
    assert.strictEqual(r.result.failed[0].expected, 2);
    assert.strictEqual(r.result.failed[0].got, 1);

    const s = storeLib.openStore({ home: f.home, hash: f.repoKey, backend: 'journal' });
    try {
      assert.strictEqual(s.cursorValue(id), 0,
        'THE INVARIANT: an unverified archive must never be followed by a cursor advance');
    } finally { s.close(); }
  } finally { fs.writeFileSync = realWrite; rm(f.home); rm(f.repo); }
});

// ===========================================================================
// 6. d9a823ff1ca0 — reconcile-registry
// ===========================================================================

// The PINNED shape, as parseChildrenList already reads it (live-verified per
// that function's own header): records carrying id / path / label /
// repositoryId.
const PINNED = (recs) => ({ run: () => ({ ok: true, raw: JSON.stringify(recs) }) });

test('reconcile-registry: reports drift in BOTH directions and mismatched worktreePath, and mutates nothing', () => {
  const home = tmpHome();
  const repo = makeGitRepo('recon');
  try {
    const inBoth = 'wt-in-both';
    const onlyRegistry = 'wt-only-registry';
    register(home, repo, inBoth);
    register(home, repo, onlyRegistry);

    const io = PINNED([
      { id: inBoth, path: repo, label: 'both', repositoryId: 'r1' },
      { id: 'wt-only-hivecontrol', path: '/tmp/elsewhere', label: 'ghost', repositoryId: 'r1' },
    ]);
    const r = cli.run(['reconcile-registry'], ctx(home, { cwd: repo, io }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.reportOnly, true);
    assert.deepStrictEqual(r.result.registryWithoutWorkspace.map((e) => e.id), [onlyRegistry],
      'a registry row hivecontrol has never heard of');
    assert.deepStrictEqual(r.result.workspaceWithoutRegistry.map((e) => e.id), ['wt-only-hivecontrol'],
      'and a hivecontrol workspace with no registry row — the drift runs both ways');
    assert.strictEqual(r.result.worktreePathMismatch.length, 0, 'the shared row agrees on its path');
    assert.strictEqual(r.result.driftCount, 2);
  } finally { rm(home); rm(repo); }
});

test('reconcile-registry: a differing worktreePath on a SHARED id is reported as a mismatch', () => {
  const home = tmpHome();
  const repo = makeGitRepo('recon-path');
  try {
    const id = 'wt-path-drift';
    register(home, repo, id);
    const io = PINNED([{ id, path: '/tmp/some-other-worktree', label: 'x', repositoryId: 'r1' }]);
    const r = cli.run(['reconcile-registry'], ctx(home, { cwd: repo, io }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.worktreePathMismatch.length, 1);
    assert.strictEqual(r.result.worktreePathMismatch[0].id, id);
    assert.strictEqual(r.result.worktreePathMismatch[0].hivecontrolPath, '/tmp/some-other-worktree');
  } finally { rm(home); rm(repo); }
});

test('reconcile-registry: a DRIFTED upstream shape fails soft with hivecontrol-shape-unrecognized + the keys seen', () => {
  const home = tmpHome();
  const repo = makeGitRepo('recon-drift');
  try {
    register(home, repo, 'wt-any');
    // hivecontrol renamed its fields: no `id`, no `path`.
    const io = PINNED([{ workspaceUuid: 'abc', location: '/tmp/x', title: 'renamed' }]);
    const r = cli.run(['reconcile-registry'], ctx(home, { cwd: repo, io }));
    assert.strictEqual(r.result.ok, false, JSON.stringify(r.result));
    assert.strictEqual(r.result.reason, 'hivecontrol-shape-unrecognized');
    assert.deepStrictEqual(r.result.missingFields.sort(), ['id', 'path']);
    assert.ok(r.result.rawKeys.includes('workspaceUuid'),
      'the keys actually seen must be reported so a human can re-pin the mapping — never a guess');
    assert.strictEqual(r.result.registryWithoutWorkspace, undefined,
      'and NO drift report is emitted from an unrecognised shape (that report would be pure fabrication)');
  } finally { rm(home); rm(repo); }
});

test('reconcile-registry: an EMPTY hivecontrol list is a valid answer, not a shape failure', () => {
  const home = tmpHome();
  const repo = makeGitRepo('recon-empty');
  try {
    register(home, repo, 'wt-lonely');
    const r = cli.run(['reconcile-registry'], ctx(home, { cwd: repo, io: PINNED([]) }));
    assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.hivecontrolCount, 0);
    assert.deepStrictEqual(r.result.registryWithoutWorkspace.map((e) => e.id), ['wt-lonely']);
  } finally { rm(home); rm(repo); }
});

// ===========================================================================
// 7. Critic A/B — spawn launch recency + window clamp; A8 — store-open hoist
// ===========================================================================

const spawnCtx = (home, repo, io, waitMs) => ctx(home, {
  cwd: repo, io, env: { ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: String(waitMs) },
});

test('critic A: a PRIOR occupant\'s still-"fresh" heartbeat is NOT this spawn\'s launch evidence', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-stale-hb');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-r11b-stale-' + Date.now());
    const meshId = inst.primaryWorkspaceId(newWt);
    // 12 minutes old: comfortably INSIDE hasFreshHeartbeat's 15-minute window,
    // which is exactly why the pre-fix check accepted it, but plainly not
    // evidence that THIS spawn launched anything.
    const hb = liveness.heartbeatPathFor(meshId, home);
    fs.mkdirSync(path.dirname(hb), { recursive: true });
    fs.writeFileSync(hb, JSON.stringify({ id: meshId, ts: Date.now() - 12 * 60 * 1000 }));
    assert.strictEqual(liveness.hasFreshHeartbeat(meshId, home, {}), true,
      'precondition: the stale beat IS "fresh" by the old predicate — that is the defect');

    const io = { run: () => ({ ok: true, raw: JSON.stringify({ path: newWt }) }) };
    const r = cli.run(['spawn', 'feature/reused'], spawnCtx(home, repo, io, 0));
    assert.strictEqual(r.result.launched, 'unknown',
      'a beat predating the spawn proves nothing about it: ' + JSON.stringify(r.result));
    assert.strictEqual(r.result.launchEvidence, null);
  } finally { rm(home); rm(repo); }
});

test('critic A: a heartbeat written DURING the spawn does count (the fix must not just disable the signal)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-new-hb');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-r11b-new-' + Date.now());
    const meshId = inst.primaryWorkspaceId(newWt);
    const hb = liveness.heartbeatPathFor(meshId, home);
    const io = {
      run: () => {
        fs.mkdirSync(path.dirname(hb), { recursive: true });
        fs.writeFileSync(hb, JSON.stringify({ id: meshId, ts: Date.now() }));
        return { ok: true, raw: JSON.stringify({ path: newWt }) };
      },
    };
    const r = cli.run(['spawn', 'feature/fresh'], spawnCtx(home, repo, io, 0));
    assert.strictEqual(r.result.launched, true, JSON.stringify(r.result));
    assert.strictEqual(r.result.launchEvidence, 'heartbeat');
  } finally { rm(home); rm(repo); }
});

test('critic B: an absurd launch window is CLAMPED to the documented maximum and says so', () => {
  assert.strictEqual(cli.spawnLaunchWaitRequestedMs({ ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '999999999' }), 999999999,
    'the raw request is still readable');
  assert.strictEqual(cli.spawnLaunchWaitMs({ ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '999999999' }), cli.SPAWN_LAUNCH_WAIT_MAX_MS,
    'but the effective window is capped');

  const home = tmpHome();
  const repo = makeGitRepo('spawn-clamp');
  try {
    const started = Date.now();
    const newWt = path.join(os.tmpdir(), 'anti-hall-r11b-clamp-' + Date.now());
    const meshId = inst.primaryWorkspaceId(newWt);
    // Give it immediate evidence so the poll returns at once — this test is
    // about the reported window, not about actually waiting 10s.
    const io = {
      run: () => {
        const hb = liveness.heartbeatPathFor(meshId, home);
        fs.mkdirSync(path.dirname(hb), { recursive: true });
        fs.writeFileSync(hb, JSON.stringify({ id: meshId, ts: Date.now() }));
        return { ok: true, raw: JSON.stringify({ path: newWt }) };
      },
    };
    const r = cli.run(['spawn', 'feature/clamp'], spawnCtx(home, repo, io, 999999999));
    assert.strictEqual(r.result.launchWindowMs, cli.SPAWN_LAUNCH_WAIT_MAX_MS);
    assert.strictEqual(r.result.launchWindowClamped, true,
      'never silently honour a different number than the operator configured');
    assert.strictEqual(r.result.launchWindowRequestedMs, 999999999);
    assert.ok(Date.now() - started < 60000, 'and it must not actually block for the requested eleven days');
  } finally { rm(home); rm(repo); }
});

test('critic B: a NORMAL window is not marked clamped', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-noclamp');
  try {
    const newWt = path.join(os.tmpdir(), 'anti-hall-r11b-noclamp-' + Date.now());
    const io = { run: () => ({ ok: true, raw: JSON.stringify({ path: newWt }) }) };
    const r = cli.run(['spawn', 'feature/normal'], spawnCtx(home, repo, io, 0));
    assert.strictEqual(r.result.launchWindowClamped, undefined, 'the flag is a signal, present only when it happened');
  } finally { rm(home); rm(repo); }
});

test('A8: the launch poll opens the store ONCE for the whole window, not once per 150ms tick', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-hoist');
  try {
    const meshId = 'primary-hoist-test';
    let opens = 0;
    let closes = 0;
    const repoKey = repokey.repoKeyForWorktree(repo);
    const storeOpen = () => {
      opens += 1;
      const real = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
      const realClose = real.close.bind(real);
      real.close = () => { closes += 1; return realClose(); };
      return real;
    };
    // 700ms window with NO evidence => the loop runs several 150ms ticks.
    const started = Date.now();
    const res = cli.checkSpawnLaunch(meshId, ctx(home, {
      cwd: repo, env: { ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '700' },
    }), storeOpen, { since: Date.now() });
    const elapsed = Date.now() - started;

    assert.strictEqual(res.launched, 'unknown', 'precondition: no evidence, so the loop really did iterate');
    assert.ok(elapsed >= 600, 'precondition: it polled for the window (' + elapsed + 'ms), i.e. multiple ticks');
    assert.strictEqual(opens, 1, 'ONE store open for the entire poll (was one per tick: mkdir + PRAGMAs + CREATE TABLE each time)');
    assert.strictEqual(closes, 1, 'and it is still closed exactly once, in the finally');
  } finally { rm(home); rm(repo); }
});

// ===========================================================================
// MUTATION CHECKS — each reverts exactly the line that carries the fix and
// asserts the ORIGINAL defect comes back. A test that still passes on the
// mutant is not testing the fix.
// ===========================================================================

test('A7 MUTATION-KILL: dropping the tail recount hides that the whole tail is undated', () => {
  mutantKit.withMutant(
    '    if (windowTail !== null) {\n      windowUndated = messages.filter((m) => !(m && Number.isFinite(m.ts))).length;\n    }\n',
    '    if (false) { /* recount removed */ }\n',
    (mutatedCli) => {
      const home = tmpHome();
      const repo = makeGitRepo('a7-mutant');
      try {
        const id = 'wt-undated-mutant';
        register(home, repo, id);
        seedPartition(home, repo, id, [{ body: 'dated-1', ts: 1000 }]);
        const repoKey = repokey.repoKeyForWorktree(home ? repo : repo);
        const msgs = path.join(storeLib.journalDirForHash(home, repoKey), 'messages.ndjson');
        fs.appendFileSync(msgs,
          JSON.stringify({ workspaceId: id, body: 'undated-1', hash: 'lm-1', mtype: 'direct' }) + '\n'
          + JSON.stringify({ workspaceId: id, body: 'undated-2', hash: 'lm-2', mtype: 'direct' }) + '\n');
        const r = mutatedCli.run(['inbox', 'messages', id, '--tail', '2'], ctx(home, { cwd: repo }));
        assert.strictEqual(r.result.ok, true);
        assert.strictEqual(r.result.window.undatedKept, undefined,
          'RED (expected on the mutant): both returned rows are undated and the caller is told nothing. '
          + 'If this fails, the recount is not what fixes A7.');
      } finally { rm(home); rm(repo); }
    },
    { prefix: 'anti-hall-r11b-a7-mutant' }
  );
});

test('drain marker MUTATION-KILL: without the entry mark, an in-flight drain is invisible to the parent gate', () => {
  mutantKit.withMutant(
    "    marker.markDrainStart(ctx.home, id, { sessionId, count: 0, now: ctx && ctx.now });\n",
    "    void sessionId; /* mark removed */\n",
    (mutatedCli) => {
      const f = seedForRead('drain-mutant');
      try {
        let seen = 'not-observed';
        const openStoreReal = storeLib.openStore;
        storeLib.openStore = function patched() {
          seen = drainMarker.readDrainMarker(f.home, f.id, {});
          storeLib.openStore = openStoreReal;
          throw new Error('boom');
        };
        try {
          mutatedCli.run(['inbox', 'read-primary', f.id], ctx(f.home, { cwd: f.repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-mutant' } }));
        } catch (_) { /* the throw is the probe */ } finally { storeLib.openStore = openStoreReal; }
        assert.strictEqual(seen, null,
          'RED (expected on the mutant): no marker exists mid-drain, so the gate keeps forcing acks at a mailbox '
          + 'that is already being drained. If this fails, markDrainStart is not what fixes 13dedc334eb6.');
      } finally { rm(f.home); rm(f.repo); }
    },
    { prefix: 'anti-hall-r11b-drain-mutant' }
  );
});

test('drain marker MUTATION-KILL: without the `finally` clear, a crashed drain silences the gate for a full TTL', () => {
  mutantKit.withMutant(
    "    try { marker.clearDrainMarker(ctx.home, id); } catch (_) { /* fail-soft */ }\n",
    "    /* clear removed */\n",
    (mutatedCli) => {
      const f = seedForRead('drain-clear-mutant');
      try {
        const openStoreReal = storeLib.openStore;
        storeLib.openStore = function patched() { storeLib.openStore = openStoreReal; throw new Error('boom'); };
        try {
          mutatedCli.run(['inbox', 'read-primary', f.id], ctx(f.home, { cwd: f.repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-leak' } }));
        } catch (_) { /* expected */ } finally { storeLib.openStore = openStoreReal; }
        const leaked = drainMarker.readDrainMarker(f.home, f.id, {});
        assert.ok(leaked && !leaked.stale,
          'RED (expected on the mutant): a marker from a CRASHED drain is left behind, fresh, silencing the gate. '
          + 'If this fails, the `finally` clear is not what makes the writer safe.');
      } finally { rm(f.home); rm(f.repo); }
    },
    { prefix: 'anti-hall-r11b-drainclear-mutant' }
  );
});

test('carry-out (g) MUTATION-KILL: without dropped/dropReason a discarded summary looks applied', () => {
  mutantKit.withMutant(
    '              dropped: true,\n              dropReason: cause,\n',
    '',
    (mutatedCli) => {
      const home = tmpHome();
      const repo = makeGitRepo('g-mutant');
      const otherRepo = makeGitRepo('g-mutant-other');
      try {
        register(home, repo, 'wt-owner-mut');
        const r = mutatedCli.run(['heartbeat', 'wt-owner-mut', '--summary', 'x'],
          ctx(home, { cwd: otherRepo, env: { DEVSWARM_BUILDER_ID: 'not-the-owner' } }));
        assert.strictEqual(r.result.ok, true);
        assert.strictEqual(r.result.meshBroadcast.dropped, undefined,
          'RED (expected on the mutant): ok:true with no signal at all that the summary was thrown away.');
      } finally { rm(home); rm(repo); rm(otherRepo); }
    },
    { prefix: 'anti-hall-r11b-g-mutant' }
  );
});

test('critic A MUTATION-KILL: reverting to hasFreshHeartbeat re-accepts a prior occupant\'s beat as a launch', () => {
  mutantKit.withMutant(
    '        const ts = heartbeatTs(meshId, ctx.home);\n        if (Number.isFinite(ts) && ts >= since) return \'heartbeat\';\n',
    '        if (hasFreshHeartbeat(meshId, ctx.home, {})) return \'heartbeat\';\n',
    (mutatedCli) => {
      const home = tmpHome();
      const repo = makeGitRepo('critica-mutant');
      try {
        const newWt = path.join(os.tmpdir(), 'anti-hall-r11b-cam-' + Date.now());
        const meshId = inst.primaryWorkspaceId(newWt);
        const hb = liveness.heartbeatPathFor(meshId, home);
        fs.mkdirSync(path.dirname(hb), { recursive: true });
        fs.writeFileSync(hb, JSON.stringify({ id: meshId, ts: Date.now() - 12 * 60 * 1000 }));
        const io = { run: () => ({ ok: true, raw: JSON.stringify({ path: newWt }) }) };
        const r = mutatedCli.run(['spawn', 'feature/reused'], spawnCtx(home, repo, io, 0));
        assert.strictEqual(r.result.launched, true,
          'RED (expected on the mutant): a 12-minute-old beat from a PRIOR occupant is reported as this spawn\'s launch, '
          + 'with launchCheckedMs 0. If this fails, the recency floor is not what fixes it.');
        assert.strictEqual(r.result.launchEvidence, 'heartbeat');
      } finally { rm(home); rm(repo); }
    },
    { prefix: 'anti-hall-r11b-critica-mutant' }
  );
});

test('reap-orphans MUTATION-KILL: retiring without the verify gate advances a cursor over an unproven archive', () => {
  mutantKit.withMutant(
    '        if (landed.length !== unreadRows.length) {\n',
    '        if (false) {\n',
    (mutatedCli) => {
      const f = seedOrphans('verifymutant', 1);
      const id = f.ids[0];
      const realWrite = fs.writeFileSync;
      try {
        fs.writeFileSync = function patched(p, data, ...rest) {
          if (String(p).includes(path.join('reaped', id))) {
            const first = String(data).split('\n').filter(Boolean)[0];
            return realWrite.call(fs, p, first + '\n', ...rest); // 1 of 2 rows
          }
          return realWrite.call(fs, p, data, ...rest);
        };
        mutatedCli.run(['reap-orphans', '--apply', '--max', '1'], ctx(f.home, { cwd: f.repo, stdinIsTty: true }));
        fs.writeFileSync = realWrite;
        const s = storeLib.openStore({ home: f.home, hash: f.repoKey, backend: 'journal' });
        try {
          assert.strictEqual(s.cursorValue(id), 2,
            'RED (expected on the mutant): the partition is retired even though only half its mail was archived. '
            + 'If this fails, the verify gate is not what makes the reap loss-free.');
        } finally { s.close(); }
      } finally { fs.writeFileSync = realWrite; rm(f.home); rm(f.repo); }
    },
    { prefix: 'anti-hall-r11b-reap-mutant' }
  );
});

test('A8: a THROWING storeOpen still degrades to no-evidence and never breaks the poll', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-hoist-throw');
  try {
    const res = cli.checkSpawnLaunch('primary-throw-test', ctx(home, {
      cwd: repo, env: { ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS: '0' },
    }), () => { throw new Error('store unavailable'); }, { since: Date.now() });
    assert.strictEqual(res.launched, 'unknown', 'fail-soft is preserved by the hoist');
    assert.strictEqual(res.evidence, null);
  } finally { rm(home); rm(repo); }
});
