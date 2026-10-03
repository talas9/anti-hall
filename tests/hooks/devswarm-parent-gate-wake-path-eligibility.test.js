'use strict';
// Wake-path gate: positive proof of a LIVE child is required. Held and
// archive-ignored children are not live (gate policy `archived||held||ignored`),
// an undeterminable repo key is `unknown` (silent), a busy-advisory pass never
// rewrites loop-state, and a genuinely live child still blocks up to the cap.
// Isolated HOME (mkdtemp), real spawned hook, temp repo + child worktree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { writeSettings } = require('../helpers/settings-switch.js');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const installIngest = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const { resolveContext } = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));
const { wakeCoverage } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-wake-coverage.js'));
const { stateFileFor } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-gate-state.js'));

const HOOK = 'devswarm-parent-gate.js';
const CLAUDE_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_AI_AGENT: 'claude' };

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gwpe-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function setup({ unreadAgeMs = null } = {}) {
  const home = tmp('home');
  const repo = tmp('repo');
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  spawnSync('git', ['-C', repo, 'add', '.']);
  spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'i']);
  const top = resolveContext(repo, { home, missingPath: 'ancestor' }).worktreeRoot;
  const id = installIngest.primaryWorkspaceId(top);
  const wt = tmp('child');
  fs.rmSync(wt, { recursive: true, force: true });
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'c-' + path.basename(wt)]);
  const root = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(root, 'inbox', 'child1.ndjson');
  const cursorPath = path.join(root, 'cursor', 'child1.json');
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(inboxPath, unreadAgeMs == null ? ''
    : JSON.stringify({ m: '[Primary] fyi', createdAt: Date.now() - unreadAgeMs }) + '\n');
  fs.writeFileSync(cursorPath, '0');
  fs.writeFileSync(path.join(root, 'workspaces', 'child1.json'),
    JSON.stringify({ id: 'child1', worktreePath: wt, sessionId: 's-child1', inboxPath, cursorPath }));
  return { home, repo, id, wt, root, cleanup() { rm(home); rm(repo); rm(wt); } };
}
function stop(s, env) {
  return testHook(HOOK, { hook_event_name: 'Stop', session_id: 'gsess', cwd: s.repo, stop_hook_active: false },
    { home: s.home, env: Object.assign({ ANTIHALL_INGEST_DRY_RUN: '1' }, CLAUDE_ENV, env || {}) });
}
function blocked(r) { return !!(r.json && r.json.decision === 'block'); }

test('(a) only a HELD child -> no block, no warning', () => {
  const s = setup();
  try {
    writeSettings(s.home, { devswarm: { heldPartitions: 'child1' } });
    const r = stop(s);
    assert.ok(!blocked(r), 'stdout=' + r.stdout);
    assert.ok(!/WAKE|WATCHER|TICK/.test(r.stdout + r.stderr), r.stdout + r.stderr);
    const cov = wakeCoverage({ home: s.home, cwd: s.repo, id: s.id, env: { ANTIHALL_DEVSWARM_HELD_PARTITIONS: 'child1' } });
    assert.strictEqual(cov.liveChildren, false);
  } finally { s.cleanup(); }
});

test('(b) only an archive-IGNORED child -> no block, no warning', () => {
  const s = setup();
  try {
    fs.mkdirSync(path.join(s.root, 'archive-ignore'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'archive-ignore', 'child1.json'), '{}');
    const r = stop(s);
    assert.ok(!blocked(r), 'stdout=' + r.stdout);
    assert.ok(!/WAKE|WATCHER|TICK/.test(r.stdout + r.stderr), r.stdout + r.stderr);
    assert.strictEqual(wakeCoverage({ home: s.home, cwd: s.repo, id: s.id }).liveChildren, false);
  } finally { s.cleanup(); }
});

test('(c) repo key unresolvable / predicate throws -> unknown, silent, no block', () => {
  const s = setup();
  try {
    const nullKey = wakeCoverage({ home: s.home, cwd: s.repo, id: s.id, liveChildOpts: { repoKeyForWorktree: () => null } });
    assert.strictEqual(nullKey.unknown, true);
    assert.strictEqual(nullKey.liveChildren, false);
    const thrown = wakeCoverage({ home: s.home, cwd: s.repo, id: s.id,
      liveChildOpts: { readDescriptors: () => { throw new Error('boom'); } } });
    assert.strictEqual(thrown.unknown, true);
    assert.strictEqual(thrown.liveChildren, false);
    // Every caller (prompt line, spawn warning, Stop gate) goes through noWakePathLine.
    const { noWakePathLine } = require(path.join(ROOT, 'hooks', 'lib', 'devswarm-wake.js'));
    assert.strictEqual(noWakePathLine(nullKey, CLAUDE_ENV, 'cli', 'watcher', s.id), '');
    assert.strictEqual(noWakePathLine(thrown, CLAUDE_ENV, 'cli', 'watcher', s.id), '');
  } finally { s.cleanup(); }
});

test('(d) busy-advisory pass leaves the loop-state file untouched', () => {
  const s = setup({ unreadAgeMs: 5000 }); // fresh unread -> "awaiting child pickup" advisory
  try {
    const sf = stateFileFor('gsess', s.home);
    fs.mkdirSync(path.dirname(sf), { recursive: true });
    const seeded = JSON.stringify({ sig: 'other', blocks: 1, escalated: false, qSig: 'Q', qBlocks: 2, qEscalated: false, intents: { x: 1 }, intentAcks: 4 });
    fs.writeFileSync(sf, seeded);
    const r = stop(s);
    assert.ok(!blocked(r), 'stdout=' + r.stdout);
    assert.match(r.stderr, /awaiting child pickup/);
    assert.strictEqual(fs.readFileSync(sf, 'utf8'), seeded);
  } finally { s.cleanup(); }
});

test('(e) a genuinely live child, no watcher, no tick -> blocks up to the cap, then quiet', () => {
  const s = setup();
  try {
    let n = 0;
    for (let i = 0; i < 6; i++) if (blocked(stop(s))) n++;
    assert.strictEqual(n, 3);
  } finally { s.cleanup(); }
});
