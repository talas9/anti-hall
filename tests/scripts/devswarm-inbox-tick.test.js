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

test('D13: inbox tick writes wake-tick/<id>.json with {ts, unreadTotal, meshGapWithheld}', () => {
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
  } finally { rm(home); rm(repo); }
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
