'use strict';
// 0.117.1 item B — field defect: a CHILD's FIRST-EVER interaction with its
// own workspace id is commonly a direct `heartbeat <id> --summary ...`, with
// no prior `register` call. Root-caused against the REAL devswarm.js CLI:
// `broadcastFamilyOwns`'s ownership check required a PRE-EXISTING registry
// row for the target id before it would consider ANY of its legs (a1/a2/a3)
// — a never-registered id has no row at all, so the check fell straight
// through to the fail-closed default and the summary was silently DROPPED
// (`meshBroadcast.ok:false, reason:'caller-not-registered'`) even though the
// caller was the one and only process that could possibly be heartbeating
// under it. The dropped summary never reaches the shared store's `recent[]`,
// so hooks/devswarm-child-gate.js's alreadyReportedThisEpisode() (which reads
// ONLY recent[]) never sees the attempt and the Stop gate re-fires the same
// "emit a heartbeat" instruction forever.
//
// FIX: broadcastFamilyOwns gained leg (a0) — when `id` has NO registry row
// anywhere, a cwd-resolved caller (`callerKind === 'resolved'`, independently
// verified ground truth, never a forgeable DEVSWARM_BUILDER_ID declaration)
// with no descriptor and no PRE-EXISTING heartbeat for `id` owns it (nothing
// anywhere claims `id` yet, so there is nothing to impersonate). Also added:
// a plain top-level `note: 'summary NOT recorded: <reason>'` on any drop, so
// the drop is impossible to miss in the raw JSON output.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// Point the shared central logger at an isolated dir BEFORE requiring
// anything that may log — never write into the real ~/.anti-hall/logs (see
// tests/scripts/devswarm-v064.test.js's established pattern).
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

test('item B FIX: a child\'s FIRST-EVER heartbeat --summary (never registered) is ACCEPTED, not dropped', () => {
  const home = tmpHome();
  const repo = makeGitRepo('first-claim');
  try {
    const id = '85129db4-071f-4e30-b5a6-0c279e4e2704';
    // No `register` call at all — mirrors the field repro exactly.
    const r = cli.run(
      ['heartbeat', id, '--summary', 'doing stuff'],
      ctx(home, { cwd: repo, env: {} })
    );
    assert.strictEqual(r.result.ok, true);
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a --summary heartbeat must attempt a mesh broadcast');
    assert.strictEqual(mb.ok, true, 'a first-ever self-heartbeat must not be dropped: ' + JSON.stringify(mb));
    assert.ok(!mb.dropped);
    assert.strictEqual(r.result.note, undefined, 'no drop note on a successful broadcast');
  } finally { rm(home); rm(repo); }
});

test('item B FIX: the accepted first-claim broadcast reaches recent[] (what alreadyReportedThisEpisode reads)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('first-claim-recent');
  try {
    const id = 'child-uuid-recent';
    const r = cli.run(
      ['heartbeat', id, '--summary', 'working on step 2'],
      ctx(home, { cwd: repo, env: {} })
    );
    assert.strictEqual(r.result.meshBroadcast.ok, true);
    const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
    const repoKey = repokey.repoKeyForWorktree(repo);
    const summaryPath = path.join(home, '.anti-hall', 'devswarm', 'summaries', repoKey + '.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const recent = Array.isArray(summary.recent) ? summary.recent : [];
    assert.ok(recent.some((row) => row && row.from === id),
      'the gate\'s alreadyReportedThisEpisode reads recent[] for from===DEVSWARM_BUILDER_ID — the accepted broadcast must land there: ' + JSON.stringify(recent));
  } finally { rm(home); rm(repo); }
});

test('item B NEGATIVE CONTROL: a descriptor-only id (no registry row, but already claimed) still DROPS', () => {
  const home = tmpHome();
  const repo = makeGitRepo('descriptor-only');
  try {
    // (a0) requires NO descriptor, not just no registry row — a descriptor
    // without a row is itself evidence `id` was already claimed at some
    // point (e.g. a tombstoned/re-homed registry row whose descriptor
    // survived), so this must still fall through to the fail-closed default.
    const id = 'descriptor-only-id';
    const descPath = cli.descriptorPath(home, id);
    fs.mkdirSync(path.dirname(descPath), { recursive: true });
    fs.writeFileSync(descPath, JSON.stringify({ id, worktreePath: repo, sessionId: 'some-old-session' }));
    const r = cli.run(
      ['heartbeat', id, '--summary', 'trying to claim'],
      ctx(home, { cwd: repo, env: {} })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, false, 'a descriptor-only id must not be (a0)-claimable: ' + JSON.stringify(mb));
    assert.strictEqual(mb.dropped, true);
    assert.strictEqual(r.result.note, 'summary NOT recorded: ' + mb.dropReason,
      'the drop must be surfaced as a plain top-level note');
  } finally { rm(home); rm(repo); }
});

test('item B NEGATIVE CONTROL: a SECOND caller for the same never-registered id (already heartbeated once) still DROPS', () => {
  const home = tmpHome();
  const repo = makeGitRepo('first-claim-race');
  const other = makeGitRepo('first-claim-race-other');
  try {
    const id = 'contested-id';
    // First caller (repo) legitimately claims it via (a0).
    const r1 = cli.run(['heartbeat', id, '--summary', 'i claimed it first'], ctx(home, { cwd: repo, env: {} }));
    assert.strictEqual(r1.result.meshBroadcast.ok, true);
    // A second, unrelated worktree now finds hadPriorHeartbeat=true for `id`
    // -> (a0) no longer applies, and no other leg (a1/a2/a3) applies either
    // (still no registry row for `id`) -> fails closed.
    const r2 = cli.run(['heartbeat', id, '--summary', 'i want it too'], ctx(home, { cwd: other, env: {} }));
    const mb2 = r2.result.meshBroadcast;
    assert.ok(mb2, 'a broadcast attempt must be reported');
    assert.strictEqual(mb2.ok, false, 'a second, unrelated claim on an already-heartbeated id must not be accepted: ' + JSON.stringify(mb2));
    assert.strictEqual(mb2.dropped, true);
  } finally { rm(home); rm(repo); rm(other); }
});

test('MUTATION (item B): reverting (a0) reproduces the field drop for a never-registered first heartbeat', () => {
  mutantKit.withMutant(
    [
      "    if (!targetRow || !targetRow.worktreePath) {",
      "      // (a0) FIRST-EVER CLAIM (0.117.1 fix, field defect: a child's very",
      "      // FIRST interaction with its own id is often a direct `heartbeat <id>",
      "      // --summary ...` — no prior `register` call at all). No registry row",
      "      // for `id` exists ANYWHERE, so there is nothing to impersonate; this",
      "      // is a strictly WEAKER precondition than the existing (a3) placeholder",
      "      // leg below (which already requires no descriptor + no prior",
      "      // heartbeat, just for a row that happens to exist). Scoped to a",
      "      // cwd-resolved caller only (`callerKind === 'resolved'` — independently",
      "      // verified ground truth, never a forgeable `DEVSWARM_BUILDER_ID`",
      "      // declaration) so a caller cannot merely CLAIM to be some id via env;",
      "      // it must be standing in a real git worktree. Also requires no",
      "      // descriptor and no PRE-EXISTING heartbeat for `id` (same",
      "      // hadPriorHeartbeat signal (a3) uses) so a genuinely already-claimed-",
      "      // but-unregistered id (heartbeat file exists, descriptor exists, just",
      "      // no registry row) still falls through to the fail-closed default.",
      "      if (callerKind === 'resolved' && !hadPriorHeartbeat) {",
      "        try {",
      "          if (!readDescriptorFile(home, target)) return true;",
      "        } catch (_) {}",
      "      }",
      "      return false;",
      "    }",
    ].join('\n'),
    [
      "    if (!targetRow || !targetRow.worktreePath) return false;",
    ].join('\n'),
    (mutated) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-mutant-'));
      fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-0117b-mutant-repo-'));
      cp.spawnSync('git', ['init', '-q', repo]);
      cp.spawnSync('git', ['-C', repo, 'config', 'user.email', 'a@b.c']);
      cp.spawnSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'x');
      cp.spawnSync('git', ['-C', repo, 'add', '.']);
      cp.spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
      try {
        const id = 'mutant-first-claim-id';
        const r = mutated.run(
          ['heartbeat', id, '--summary', 'doing stuff'],
          Object.assign({ home, backend: 'journal', env: {} }, { cwd: repo })
        );
        const mb = r.result.meshBroadcast;
        assert.strictEqual(mb && mb.ok, false,
          'MUTANT must reproduce the field defect — a never-registered first heartbeat drops');
        assert.strictEqual(mb.reason, 'caller-not-registered');
      } finally { rm(home); rm(repo); }
    }
  );
});
