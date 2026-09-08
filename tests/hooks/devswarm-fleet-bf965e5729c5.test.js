'use strict';
// Regression test for defect bf965e5729c5 (P1, partial): devswarm-parent-inbox.js's
// live workspace table re-does expensive per-row liveness reads (heartbeat file +
// transcript-mtime-backed richer liveness) EVERY turn, for EVERY registry row —
// including already-archived rows, whose richer-liveness result is thrown away
// (the `archivedRow ? {...} : displayStatus(...)` branch never consults
// dormant/idleAlive). Field report: 1.07s for one turn's worth of this loop on a
// 30-row registry under load avg ~516; roster (a separate command reading the
// same class of per-row signals) took >120s twice on the same machine. That
// field latency was NOT reproduced locally — this defect is ruled `partial`
// (see `defect.js show bf965e5729c5`), open pending a local repro/field
// instrumentation.
//
// Fix under test (R2 review): the archived check runs BEFORE the EXPENSIVE
// transcript-mtime-backed richer liveness calls (readActivityTs/
// rowLivenessState) — an archived row skips those entirely, since their
// result (dormant/idleAlive) is never consulted by the archived-row display
// branch. The heartbeat read itself STAYS unconditional (R2 Critic P2-8):
// skipping it for archived rows would let the table's "last" column go
// silently stale for an archived row that still emits heartbeats. A
// cross-turn disk cache was tried and REMOVED (R2 Critic P2-4/5/6: net cost
// for this hook's actual per-turn cadence, plus two correctness bugs) — this
// file no longer tests any caching behavior.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-inbox-bf965-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}
const REPO_CWD = makeGitRepo();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function payload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function tableSeg(c) {
  return c.split('\n\n').find((s) => s.startsWith('DEVSWARM WORKSPACES')) || '';
}
function tableRow(c, id) {
  return tableSeg(c).split('\n').find((l) => l.startsWith('| ' + id + ' ')) || '';
}
function swarmDir(home) {
  const d = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function wsEntry(overrides) {
  return Object.assign({
    worktreePath: REPO_CWD,
    sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    total: 0, cursor: 0, unread: 0, directUnread: 0,
    broadcastUnread: 0, urgencyMax: null, working_on: null,
    gates: {}, archive_ready: false,
  }, overrides || {});
}
function writeSharedSummary(home, workspacesRaw, extra) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = {};
  for (const id of Object.keys(workspacesRaw || {})) {
    const raw = workspacesRaw[id];
    workspaces[id] = raw && typeof raw === 'object' ? wsEntry(raw) : raw;
  }
  const obj = {
    generatedAt: (extra && extra.generatedAt) != null ? extra.generatedAt : Date.now(),
    requiredGates: [], workspaces, recent: [], archivedRegistryRows: [],
  };
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(obj));
}
function writeHeartbeat(home, id, beat) {
  const p = path.join(swarmDir(home), 'heartbeats', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(beat));
}
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'parent-inbox-bf965-home-'));
}

test('bf965e5729c5: a non-archived row reflects the current heartbeat every turn (no stale cache)', () => {
  const home = makeHome();
  writeSharedSummary(home, { child1: {} });
  writeHeartbeat(home, 'child1', { ts: Date.now(), progress_pct: 10 });

  const r1 = testHook(HOOK, payload(), { home, env: PRIMARY_ENV, expectJson: true });
  assert.equal(r1.status, 0);
  assert.ok(tableRow(ctx(r1), 'child1').includes('10%'), 'first turn must reflect the seeded 10% heartbeat');

  // Change the heartbeat with NO summary rewrite: since the disk cache was
  // removed, the very next turn must reflect the NEW value immediately —
  // there is no TTL/mtime window during which a stale value could replay.
  writeHeartbeat(home, 'child1', { ts: Date.now(), progress_pct: 90 });
  const r2 = testHook(HOOK, payload(), { home, env: PRIMARY_ENV, expectJson: true });
  const row2 = tableRow(ctx(r2), 'child1');
  assert.ok(row2.includes('90%'), 'a heartbeat change must be reflected on the VERY NEXT turn, got: ' + row2);

  fs.rmSync(home, { recursive: true, force: true });
});

test('bf965e5729c5: no row-cache file is ever written (the disk cache was removed)', () => {
  const home = makeHome();
  writeSharedSummary(home, { child2: {} });
  writeHeartbeat(home, 'child2', { ts: Date.now(), progress_pct: 5 });

  const r = testHook(HOOK, payload(), { home, env: PRIMARY_ENV, expectJson: true });
  assert.equal(r.status, 0);

  const swarm = swarmDir(home);
  const leftover = fs.readdirSync(swarm).filter((f) => f.startsWith('parent-inbox-row-cache-'));
  assert.deepStrictEqual(leftover, [], 'no parent-inbox-row-cache-*.json file should exist after a turn');

  fs.rmSync(home, { recursive: true, force: true });
});

test('bf965e5729c5: an archived row STILL renders correctly (label=archived) with no heartbeat file at all', () => {
  const home = makeHome();
  // archive_ready true + a local archived/<id>.json marker -> archivedRow=true
  // via isArchivedWorkspace (companion/lib/devswarm-archived.js); no heartbeat
  // file is ever written for this id, proving the archived path does not
  // REQUIRE one to exist (readHeartbeat fails open to null either way).
  const archDir = path.join(swarmDir(home), 'archived');
  fs.mkdirSync(archDir, { recursive: true });
  fs.writeFileSync(path.join(archDir, 'child3.json'), JSON.stringify({
    id: 'child3', worktreePath: REPO_CWD, archivedAt: Date.now(),
  }));
  writeSharedSummary(home, { child3: {} });

  const r = testHook(HOOK, payload(), { home, env: PRIMARY_ENV, expectJson: true });
  assert.equal(r.status, 0);
  const row = tableRow(ctx(r), 'child3');
  assert.ok(row.includes('archived'), 'archived row must render label=archived even with no heartbeat file, got: ' + row);

  fs.rmSync(home, { recursive: true, force: true });
});

test('bf965e5729c5 (R2 Critic P2-8): an archived row WITH a heartbeat still shows a fresh "last" column, not a stale one', () => {
  const home = makeHome();
  const archDir = path.join(swarmDir(home), 'archived');
  fs.mkdirSync(archDir, { recursive: true });
  fs.writeFileSync(path.join(archDir, 'child4.json'), JSON.stringify({
    id: 'child4', worktreePath: REPO_CWD, archivedAt: Date.now(),
  }));
  writeSharedSummary(home, { child4: {} });
  // A heartbeat stamped "now" — if the heartbeat read were skipped entirely
  // for archived rows, `activityTs` would fall back to whatever the verdict
  // alone carries (nothing here), rendering "—" (unknown) instead of "0s"/
  // a few seconds — the exact staleness regression P2-8 called out.
  writeHeartbeat(home, 'child4', { ts: Date.now(), progress_pct: 50 });

  const r = testHook(HOOK, payload(), { home, env: PRIMARY_ENV, expectJson: true });
  const row = tableRow(ctx(r), 'child4');
  assert.ok(row.includes('archived'), 'still archived: ' + row);
  assert.ok(!/\|\s*—\s*\|\s*$/.test(row), 'the "last" column must NOT be unknown ("—") when a fresh heartbeat exists, got: ' + row);

  fs.rmSync(home, { recursive: true, force: true });
});
