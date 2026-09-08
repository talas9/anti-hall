'use strict';
// D13 (v0.97.0) — `devswarm.js inbox tick <id> [--child]`. FIELD MEASUREMENT
// that motivated this verb: a child session's 5-minute mailbox-wake cron
// (pull + count, then a forced Stop-hook heartbeat EVERY tick) produced 1,225
// polling lines / 2.29 MB — about half that session's real content — almost
// entirely "mailbox empty" no-ops. `inbox tick` folds the cron prompt's own
// drain into ONE command (see devswarm-wake.js's drainCmd useTick branch)
// and leaves three cheap side effects behind:
//   1. a wake-tick marker (wake-tick/<id>.json) devswarm-child-gate.js reads
//      to skip a redundant forced heartbeat (see that hook's own test file
//      for the Stop-side half of this contract);
//   2. a heartbeat ts/state_ts refresh (heartbeats/<id>.json) — cheap
//      liveness signal, never fabricates progress/phase/wip/blockers;
//   3. a cron-found-mail.jsonl append, ONLY when unreadTotal>0 AND a
//      Monitor watcher lock file exists for the id — capped at 1000 lines.
// This file tests all three effects directly against scripts/devswarm.js
// (no mutant-kit needed — nothing here mutates devswarm.js itself).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { lockPathFor } = require('../../plugins/anti-hall/companion/lib/devswarm-wake-watch.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-tick-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-tick-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

function seedDirectRow(home, repoDir, toId, body) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    const fields = { from: 'sender', to: toId, type: 'direct', urgency: 'normal', message: body, timestamp: Date.now() };
    const hash = storeLib.meshMessageHash(fields);
    storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
  } finally { s.close(); }
}

function markerFile(home, id) { return path.join(home, '.anti-hall', 'devswarm', 'wake-tick', id + '.json'); }
function heartbeatFile(home, id) { return path.join(home, '.anti-hall', 'devswarm', 'heartbeats', id + '.json'); }
function cronFoundMailFile(home) { return path.join(home, '.anti-hall', 'devswarm', 'cron-found-mail.jsonl'); }

test('D13: inbox tick reports the SAME shape as inbox count and adds action:"tick"', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    const counted = cli.run(['inbox', 'count', 'w1'], ctx(home, { cwd: repo })).result;
    const ticked = cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo })).result;
    assert.strictEqual(ticked.ok, true);
    assert.strictEqual(ticked.action, 'tick');
    assert.strictEqual(ticked.unreadTotal, counted.unreadTotal);
    assert.strictEqual(ticked.meshGapWithheld, counted.meshGapWithheld);
  } finally { rm(home); rm(repo); }
});

test('D13: inbox tick writes wake-tick/<id>.json with {ts, unreadTotal, meshGapWithheld, known}', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    const before = Date.now();
    cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo }));
    const marker = JSON.parse(fs.readFileSync(markerFile(home, 'w1'), 'utf8'));
    assert.ok(Number.isFinite(marker.ts) && marker.ts >= before, `marker.ts must be a fresh timestamp; got ${JSON.stringify(marker)}`);
    assert.strictEqual(marker.unreadTotal, 0);
    assert.strictEqual(marker.meshGapWithheld, false);
    assert.strictEqual(marker.known, true, `a readable store on a genuine zero must record known:true; got ${JSON.stringify(marker)}`);
  } finally { rm(home); rm(repo); }
});

// Wave F1 (P0): a store-unavailable tick (project-context-mismatch — same
// repro shape as devswarm-cross-repo-partition.test.js's e586afdaa968) must
// write known:false into the marker, NOT known:true, even though unreadTotal
// reads 0 (the NDJSON-only component) — this is exactly the case
// devswarm-child-gate.js's tickMarkerFreshZero() must refuse to treat as a
// no-op (see that hook's own F1 KNOWN-GUARD tests).
test('F1 KNOWN-GUARD: a store-unavailable tick (foreign cwd, project-context-mismatch) writes known:false, unreadTotal still numeric', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('foreign-a');
  const repoB = makeGitRepo('foreign-b');
  try {
    register(home, repoB, 'w-foreign');
    const before = Date.now();
    const ticked = cli.run(['inbox', 'tick', 'w-foreign'], ctx(home, { cwd: repoA })).result;
    assert.strictEqual(ticked.ok, true);
    assert.strictEqual(ticked.known, false, `sanity: inbox tick itself must report known:false from a foreign cwd; got ${JSON.stringify(ticked)}`);
    assert.ok(Number.isFinite(ticked.unreadTotal), `unreadTotal must still be a number, not null, even when unknown; got ${JSON.stringify(ticked)}`);
    const marker = JSON.parse(fs.readFileSync(markerFile(home, 'w-foreign'), 'utf8'));
    assert.ok(Number.isFinite(marker.ts) && marker.ts >= before);
    assert.strictEqual(marker.known, false, `the marker must record known:false so the child-gate never treats this as a satisfied no-op; got ${JSON.stringify(marker)}`);
  } finally { rm(home); rm(repoA); rm(repoB); }
});

test('D13: inbox tick refreshes heartbeats/<id>.json ts/state_ts without fabricating other fields', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    // Seed an existing heartbeat with real authored fields + a stale ts.
    const hbPath = heartbeatFile(home, 'w1');
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    const staleTs = Date.now() - 999999;
    fs.writeFileSync(hbPath, JSON.stringify({
      id: 'w1', ts: staleTs, state_ts: staleTs, source: 'cli-heartbeat',
      progress_pct: 42, phase: 'implementing', wip: ['thing'], blockers: [], sessionId: 's-w1',
    }));
    const before = Date.now();
    cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo }));
    const beat = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    assert.ok(beat.ts >= before, `ts must be refreshed to now; got ${beat.ts}`);
    assert.ok(beat.state_ts >= before, `state_ts must be refreshed to now; got ${beat.state_ts}`);
    // Authored fields must be UNTOUCHED — a tick never fabricates/overwrites them.
    assert.strictEqual(beat.progress_pct, 42);
    assert.strictEqual(beat.phase, 'implementing');
    assert.deepStrictEqual(beat.wip, ['thing']);
    assert.strictEqual(beat.sessionId, 's-w1');
  } finally { rm(home); rm(repo); }
});

test('D13: inbox tick with NO prior heartbeat writes an honestly-empty one (matches cmdHeartbeat authorship rule)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    assert.ok(!fs.existsSync(heartbeatFile(home, 'w1')), 'sanity: no heartbeat yet');
    cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo }));
    const beat = JSON.parse(fs.readFileSync(heartbeatFile(home, 'w1'), 'utf8'));
    assert.strictEqual(beat.progress_pct, null);
    assert.strictEqual(beat.phase, null);
    assert.deepStrictEqual(beat.wip, []);
    assert.deepStrictEqual(beat.blockers, []);
    assert.strictEqual(beat.sessionId, null);
    assert.strictEqual(beat.source, 'inbox-tick');
  } finally { rm(home); rm(repo); }
});

test('D13: --child runs pull first (native queue import), same as the child branch of the drain', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    // register auto-creates the descriptor; --child should not error even
    // with no native binary reachable (pull is best-effort/fail-open here).
    register(home, repo, 'w1');
    const r = cli.run(['inbox', 'tick', 'w1', '--child'], ctx(home, { cwd: repo, env: { PATH: os.tmpdir() } }));
    assert.strictEqual(r.result.ok, true, 'tick --child must still report ok:true even when the native pull step no-ops');
    assert.strictEqual(r.result.action, 'tick');
  } finally { rm(home); rm(repo); }
});

// ----- cron-found-mail.jsonl measurement -----

test('D13 MEASUREMENT: no watcher lock -> unread found by a tick is NOT counted in cron-found-mail.jsonl', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    seedDirectRow(home, repo, 'w1', 'hello');
    // No lock file created — the watcher was never armed for this id.
    cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo }));
    assert.ok(!fs.existsSync(cronFoundMailFile(home)), 'cron-found-mail.jsonl must not be created without an armed watcher lock');
  } finally { rm(home); rm(repo); }
});

test('D13 MEASUREMENT: watcher lock present + unreadTotal>0 -> one line appended to cron-found-mail.jsonl', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    seedDirectRow(home, repo, 'w1', 'hello');
    const lockPath = lockPathFor(home, 'w1');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const ticked = cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo })).result;
    assert.ok(ticked.unreadTotal > 0, `sanity: this tick must have found unread mail; got ${JSON.stringify(ticked)}`);
    const lines = fs.readFileSync(cronFoundMailFile(home), 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.strictEqual(row.id, 'w1');
    assert.ok(row.unreadTotal > 0);
    assert.ok(Number.isFinite(row.ts));
  } finally { rm(home); rm(repo); }
});

test('D13 MEASUREMENT: watcher lock present but unreadTotal===0 -> nothing appended', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    const lockPath = lockPathFor(home, 'w1');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo }));
    assert.ok(!fs.existsSync(cronFoundMailFile(home)), 'an empty mailbox must never append, even with an armed lock');
  } finally { rm(home); rm(repo); }
});

test('D13 MEASUREMENT: cron-found-mail.jsonl is capped at 1000 lines (oldest rotated out, never truncated to less)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('a');
  try {
    register(home, repo, 'w1');
    const p = cronFoundMailFile(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const pre = [];
    for (let i = 0; i < 1000; i++) pre.push(JSON.stringify({ ts: i, id: 'other', unreadTotal: 1 }));
    fs.writeFileSync(p, pre.join('\n') + '\n');
    seedDirectRow(home, repo, 'w1', 'hello');
    const lockPath = lockPathFor(home, 'w1');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    cli.run(['inbox', 'tick', 'w1'], ctx(home, { cwd: repo }));
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1000, 'must stay capped at 1000, not grow to 1001');
    const first = JSON.parse(lines[0]);
    assert.strictEqual(first.ts, 1, 'the oldest (ts:0) row must have been rotated out, not the new one');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.id, 'w1', 'the NEW row must be the newest (last) line');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// defect 735b179362e8 (B): a child that addresses `inbox tick`/`heartbeat`
// with an id OTHER than its own real DEVSWARM_BUILDER_ID (e.g. it
// substituted its meshId instead) is warned, not refused — fail-open, since
// an operator MAY legitimately tick a sibling's id. Covers cmdInboxTick;
// devswarm-cli-heartbeat.test.js style coverage for cmdHeartbeat mirrors the
// same warnIdMismatch() helper (scripts/devswarm.js).
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk, ...rest) => { out += String(chunk); return orig.call(process.stderr, ...(rest.length ? [chunk, ...rest] : [chunk])); };
  try { const result = fn(); return { result, stderr: out }; }
  finally { process.stderr.write = orig; }
}

test('ID MISMATCH (735b179362e8): a CHILD ticking an id different from its own DEVSWARM_BUILDER_ID -> idMismatch:true + one stderr warning naming both ids, never refused', () => {
  const home = tmpHome();
  const repo = makeGitRepo('mismatch-tick');
  try {
    register(home, repo, 'wrong-mesh-id');
    // Wave 3 addendum item 8: warnIdMismatch now gates on
    // isChildWorkspaceCorroborated(env, home, cwd) — env.DEVSWARM_BUILDER_ID
    // ('real-builder-id') must itself be a REGISTERED, on-disk-corroborated
    // workspace for the warning to fire at all (an uncorroborated env var
    // must never trigger it — see the PRIMARY-with-leaked-env-var test
    // below). Register it too so this test still exercises the mismatch
    // path, not the (now separately covered) no-corroboration no-op.
    register(home, repo, 'real-builder-id');
    const env = { DEVSWARM_SOURCE_BRANCH: 'feature/x', DEVSWARM_BUILDER_ID: 'real-builder-id' };
    const { result, stderr } = captureStderr(() =>
      cli.run(['inbox', 'tick', 'wrong-mesh-id'], ctx(home, { cwd: repo, env })).result);
    assert.strictEqual(result.ok, true, 'must never refuse over an id mismatch (fail-open)');
    assert.strictEqual(result.idMismatch, true);
    assert.ok(stderr.includes('wrong-mesh-id'), `warning must name the argv id; stderr=${stderr}`);
    assert.ok(stderr.includes('real-builder-id'), `warning must name the real DEVSWARM_BUILDER_ID; stderr=${stderr}`);
  } finally { rm(home); rm(repo); }
});

test('ID MISMATCH (735b179362e8): a CHILD ticking its OWN DEVSWARM_BUILDER_ID -> idMismatch:false, no warning', () => {
  const home = tmpHome();
  const repo = makeGitRepo('match-tick');
  try {
    register(home, repo, 'real-builder-id');
    const env = { DEVSWARM_SOURCE_BRANCH: 'feature/x', DEVSWARM_BUILDER_ID: 'real-builder-id' };
    const { result, stderr } = captureStderr(() =>
      cli.run(['inbox', 'tick', 'real-builder-id'], ctx(home, { cwd: repo, env })).result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.idMismatch, false);
    assert.strictEqual(stderr, '', `no warning expected when ids match; stderr=${stderr}`);
  } finally { rm(home); rm(repo); }
});

test('ID MISMATCH (735b179362e8): the PRIMARY (not a child — DEVSWARM_SOURCE_BRANCH unset) never gets the warning even with DEVSWARM_BUILDER_ID mismatched', () => {
  const home = tmpHome();
  const repo = makeGitRepo('primary-tick');
  try {
    register(home, repo, 'some-workspace');
    const env = { DEVSWARM_BUILDER_ID: 'unrelated-id' }; // no DEVSWARM_SOURCE_BRANCH -> Primary
    const { result, stderr } = captureStderr(() =>
      cli.run(['inbox', 'tick', 'some-workspace'], ctx(home, { cwd: repo, env })).result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.idMismatch, false, 'the mismatch check is child-only');
    assert.strictEqual(stderr, '');
  } finally { rm(home); rm(repo); }
});

test('ID MISMATCH item 8 (P2): a Primary with a LEAKED/uncorroborated DEVSWARM_SOURCE_BRANCH is never told to switch ids, even with a mismatched DEVSWARM_BUILDER_ID', () => {
  const home = tmpHome();
  const repo = makeGitRepo('leaked-branch-tick');
  try {
    // Only 'some-workspace' is registered/corroborated — env.DEVSWARM_BUILDER_ID
    // ('real-builder-id') has NO registered descriptor and cwd is not under the
    // real DevSwarm worktree layout, so isChildWorkspaceCorroborated must be
    // false even though DEVSWARM_SOURCE_BRANCH LOOKS like a child signal (a
    // Primary that merely inherited a leaked/stale env var from a parent
    // process). warnIdMismatch must stay silent — the bare, uncorroborated
    // isChildWorkspace() check this used to gate on would have fired here.
    register(home, repo, 'some-workspace');
    const env = { DEVSWARM_SOURCE_BRANCH: 'feature/x', DEVSWARM_BUILDER_ID: 'real-builder-id' };
    const { result, stderr } = captureStderr(() =>
      cli.run(['inbox', 'tick', 'some-workspace'], ctx(home, { cwd: repo, env })).result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.idMismatch, false,
      'an uncorroborated DEVSWARM_SOURCE_BRANCH must never trigger the id-mismatch warning');
    assert.strictEqual(stderr, '', `no warning expected without on-disk corroboration; stderr=${stderr}`);
  } finally { rm(home); rm(repo); }
});

test('ID MISMATCH (735b179362e8): cmdHeartbeat mirrors the same fail-open warn-not-refuse contract', () => {
  const home = tmpHome();
  const repo = makeGitRepo('mismatch-hb');
  try {
    // Item 8: corroborate env.DEVSWARM_BUILDER_ID first — see the tick test above.
    register(home, repo, 'real-builder-id');
    const env = { DEVSWARM_SOURCE_BRANCH: 'feature/x', DEVSWARM_BUILDER_ID: 'real-builder-id' };
    const { result, stderr } = captureStderr(() =>
      cli.run(['heartbeat', 'wrong-mesh-id'], ctx(home, { cwd: repo, env })).result);
    assert.strictEqual(result.ok, true, 'must never refuse over an id mismatch (fail-open)');
    assert.strictEqual(result.idMismatch, true);
    assert.ok(stderr.includes('wrong-mesh-id') && stderr.includes('real-builder-id'), `warning must name both ids; stderr=${stderr}`);
  } finally { rm(home); rm(repo); }
});
