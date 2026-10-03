'use strict';
// hooks/devswarm-parent-gate.js — field regression fixed in 0.109.4.
//
// FIELD (0.109.1): the Primary's Stop gate blocked on 9 workspaces that were ALL
// archived in the DevSwarm app DB (its own attribution tagged them
// "[archived, app-archived]"), and for 5 of them said "waiting on a human answer
// in its own session" although those sessions no longer existed.
//
// Contract pinned here:
//   1. an archived family (app DB, anti-hall's own marker, or an archive-ignore
//      "held" marker) NEVER blocks; at most ONE aggregated advisory line.
//   2. "waiting on a human answer" needs a LIVE session AND an unanswered prompt
//      in its transcript; a dead session is never waiting.
//   3. an ACTIVE child with unread and no transcript still blocks (0.109.0).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

// The hook is a child process: it can only read the app DB when ITS node has
// node:sqlite (no flag needed on the CI matrix's node 22.13+/24).
const SQLITE_OK = cp.spawnSync(process.execPath, ['-e', "require('node:sqlite')"]).status === 0;
const skipNoSqlite = SQLITE_OK ? false : 'node:sqlite unavailable to the hook process';

function run(home, env) {
  return testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-primary' }), {
    home, env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

function root(home) { return path.join(home, '.anti-hall', 'devswarm'); }

function seedWorkspace(home, id, opts = {}) {
  const r = root(home);
  const wt = opts.worktreePath || path.join(home, 'wt', id);
  const inboxPath = path.join(r, 'inbox', id + '.ndjson');
  const cursorPath = path.join(r, 'cursor', id + '.json');
  for (const d of [path.join(r, 'workspaces'), path.dirname(inboxPath), path.dirname(cursorPath)]) fs.mkdirSync(d, { recursive: true });
  const desc = { id, worktreePath: wt, sessionId: 'sess-' + id, inboxPath, cursorPath };
  fs.writeFileSync(path.join(r, 'workspaces', id + '.json'), JSON.stringify(desc));
  const n = opts.unread == null ? 2 : opts.unread;
  const rows = Array.from({ length: n }, (_, i) => ({ m: 'real message ' + i, createdAt: Date.now() - 120000 + i }));
  fs.writeFileSync(inboxPath, rows.map((x) => JSON.stringify(x)).join('\n') + (n ? '\n' : ''));
  fs.writeFileSync(cursorPath, '0');
  return { wt, sid: 'sess-' + id, desc };
}

const iso = (t) => new Date(t).toISOString();
// An AskUserQuestion with no tool_result: the transcript shape a session that
// was paused for a human leaves behind — whether or not it is still running.
function writeAskTranscript(home, wt, sid) {
  const dir = liveness.projectDirFor(wt, home);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 5 * 60000;
  const lines = [
    { type: 'user', timestamp: iso(t0), message: { role: 'user', content: 'Which env?' } },
    { type: 'assistant', timestamp: iso(t0 + 1000), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask_' + sid, name: 'AskUserQuestion', input: { questions: [{ question: 'Which env?' }] } }] } },
  ];
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeSession(home, sid, pid) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-' + sid + '.json'), JSON.stringify({ pid, sessionId: sid, cwd: home, startedAt: Date.now() }));
}
// A pid that provably belonged to a process which has already exited.
function deadPid() {
  const r = cp.spawnSync(process.execPath, ['-e', '0']);
  return r.pid;
}

// App DB fixture: every listed id is ARCHIVED (isActive=0, isHidden=1).
function writeAppDb(home, archivedIds) {
  const sqlite = require('node:sqlite');
  const file = path.join(home, 'appdb', 'devswarm.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
  const ins = db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)');
  for (const a of archivedIds) ins.run(a.id, 'r1', a.wt, 1, 0);
  db.close();
  return file;
}

test('FIELD: 9 app-archived families with unread (5 with an old unanswered AskUserQuestion) -> no block, ONE advisory', { skip: skipNoSqlite }, () => {
  const h = makeHome();
  try {
    const seeded = [];
    for (let i = 1; i <= 9; i++) {
      const s = seedWorkspace(h.home, 'arch-' + i);
      if (i <= 5) { writeAskTranscript(h.home, s.wt, s.sid); writeSession(h.home, s.sid, deadPid()); }
      seeded.push({ id: 'arch-' + i, wt: s.wt });
    }
    const dbFile = writeAppDb(h.home, seeded);
    const r = run(h.home, { ANTIHALL_DEVSWARM_APP_DB: dbFile });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `archived families must never block; stdout=${r.stdout}`);
    const lines = r.stderr.split('\n').filter((l) => /archived workspace\(s\) still have unread mail/.test(l));
    assert.strictEqual(lines.length, 1, `exactly one aggregated advisory; stderr=${r.stderr}`);
    assert.match(lines[0], /9 archived workspace\(s\) still have unread mail \(ignored\)/);
    assert.doesNotMatch(r.stderr, /waiting on a human answer/);
    // Not counted toward escalation: a clean pass leaves no loop-state behind.
    const again = run(h.home, { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '1' });
    assert.strictEqual(again.stdout, '', `a second pass must not escalate archived mail; stdout=${again.stdout}`);
  } finally { h.cleanup(); }
});

test('an anti-hall-marker archived family (archived/<id>.json) with unread -> no block', () => {
  const h = makeHome();
  try {
    const s = seedWorkspace(h.home, 'marked');
    const adir = path.join(root(h.home), 'archived');
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, 'marked.json'), JSON.stringify(s.desc));
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `anti-hall-archived family must not block; stdout=${r.stdout}`);
    assert.match(r.stderr, /1 archived workspace\(s\) still have unread mail \(ignored\)/);
  } finally { h.cleanup(); }
});

test('an archive-ignore ("held") marked row with unread -> no block', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'held-twin');
    const idir = path.join(root(h.home), 'archive-ignore');
    fs.mkdirSync(idir, { recursive: true });
    fs.writeFileSync(path.join(idir, 'held-twin.json'), JSON.stringify({ id: 'held-twin', ignoredAt: Date.now() }));
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `a held/ignored row must not block; stdout=${r.stdout}`);
  } finally { h.cleanup(); }
});

test('an archived family does not hide an ACTIVE one: active still blocks, archived is not named', () => {
  const h = makeHome();
  try {
    const s = seedWorkspace(h.home, 'marked2');
    const adir = path.join(root(h.home), 'archived');
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, 'marked2.json'), JSON.stringify(s.desc));
    seedWorkspace(h.home, 'live-child', { unread: 3 });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.match(r.json.reason, /live-child/);
    assert.doesNotMatch(r.json.reason, /marked2/);
    assert.match(r.json.reason, /1 workspace\(s\)/);
  } finally { h.cleanup(); }
});

test('0.109.0 KEPT: an ACTIVE child with unread and NO transcript still blocks', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'active-notr');
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.match(r.json.reason, /2 unread/);
  } finally { h.cleanup(); }
});

test('a DEAD session with an unanswered AskUserQuestion in its old transcript is NOT "waiting"', () => {
  const h = makeHome();
  try {
    const s = seedWorkspace(h.home, 'dead-ask');
    writeAskTranscript(h.home, s.wt, s.sid);
    writeSession(h.home, s.sid, deadPid());
    const r = run(h.home);
    // Still an active child with real unread -> still blocks, but never as "waiting".
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.doesNotMatch(r.json.reason, /waiting on a human answer/, `reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});

test('no session record at all + unanswered AskUserQuestion transcript -> NOT "waiting"', () => {
  const h = makeHome();
  try {
    const s = seedWorkspace(h.home, 'nosess-ask');
    writeAskTranscript(h.home, s.wt, s.sid);
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.doesNotMatch(r.json.reason, /waiting on a human answer/, `reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});

test('an ALIVE session waiting on AskUserQuestion still blocks and names the wait', () => {
  const h = makeHome();
  try {
    const s = seedWorkspace(h.home, 'live-ask');
    writeAskTranscript(h.home, s.wt, s.sid);
    writeSession(h.home, s.sid, process.pid);
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.match(r.json.reason, /live-ask: waiting on a human answer in its own session/, `reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});
