'use strict';
// devswarm-parent-inbox.js — NO MAILBOX WAKE PATH line. A Primary with live
// children but no watcher and/or no recent inbox tick is told, per prompt, with
// the shared emit-dedupe keepalive. Real spawned hook, isolated HOME, temp repo.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { switchOff } = require('../helpers/settings-switch.js');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const installIngest = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const { resolveContext } = require(path.join(ROOT, 'companion', 'lib', 'identity.js'));
const { lockPathFor } = require(path.join(ROOT, 'companion', 'lib', 'devswarm-wake-watch.js'));

const HOOK = 'devswarm-parent-inbox.js';
const CLAUDE_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_AI_AGENT: 'claude' };

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wp-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeRepo() {
  const dir = tmp('repo');
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'i']);
  return dir;
}
function setup({ child = true } = {}) {
  const home = tmp('home');
  const repo = makeRepo();
  const top = resolveContext(repo, { home, missingPath: 'ancestor' }).worktreeRoot;
  const id = installIngest.primaryWorkspaceId(top);
  if (child) {
    const wt = tmp('child');
    fs.rmSync(wt, { recursive: true, force: true });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'c-' + path.basename(wt)]);
    const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'child1.json'), JSON.stringify({ id: 'child1', worktreePath: wt, sessionId: 's-child1' }));
  }
  return { home, repo, id, cleanup() { rm(home); rm(repo); } };
}
function writeLock(s) {
  const p = lockPathFor(s.home, s.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts: Date.now(), pid: process.pid }));
}
function writeTick(s, ageMin) {
  const dir = path.join(s.home, '.anti-hall', 'devswarm', 'wake-tick');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, s.id + '.json'), JSON.stringify({ ts: Date.now() - ageMin * 60000 }));
}
function run(s, extra) {
  const o = Object.assign({ session_id: 'sess', transcript_path: null }, extra || {});
  const r = testHook(HOOK, { hook_event_name: 'UserPromptSubmit', session_id: o.session_id, prompt: 'hi', cwd: s.repo, transcript_path: o.transcript_path || undefined },
    { home: s.home, env: Object.assign({ ANTIHALL_INGEST_DRY_RUN: '1', ANTIHALL_EMIT_DEDUPE: '1' }, CLAUDE_ENV, o.env || {}), expectJson: true });
  assert.strictEqual(r.status, 0);
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function seg(c) { return c.split('\n\n').find((x) => /^NO MAILBOX /.test(x)) || ''; }

test('Primary + live child + no watcher + no tick -> the full NO MAILBOX WAKE PATH line (<400 chars)', () => {
  const s = setup();
  try {
    const line = seg(run(s));
    assert.ok(line.startsWith('NO MAILBOX WAKE PATH:'), line);
    assert.ok(line.includes('wake-watch.js'), line);
    assert.ok(line.includes('inbox tick ' + s.id + ' --quiet'), line);
    // The two launcher paths are install-dependent (a temp-dir path here, ~35 chars each under the
    // stable ~/.anti-hall/bin launchers); the fixed wording must stay well inside 400.
    const fixed = line.replace(/node \S*wake-watch\.js/, 'node W').replace(/node \S*devswarm\.js/, 'node C');
    assert.ok(fixed.length < 330, 'fixed length ' + fixed.length + ': ' + fixed);
  } finally { s.cleanup(); }
});

test('only the cron missing -> the short NO MAILBOX TICK line; a lapsed watcher under a live cron is NOT nagged (the tick re-arms it)', () => {
  const s = setup();
  try {
    writeTick(s, 5);
    assert.strictEqual(seg(run(s)), '', 'watcher lapsed at its 30-min cap, cron alive: the cron tick re-arms it, no nag');
  } finally { s.cleanup(); }
  const s2 = setup();
  try {
    writeLock(s2);
    assert.ok(seg(run(s2)).startsWith('NO MAILBOX TICK'));
  } finally { s2.cleanup(); }
});

test('healthy (watcher live + fresh tick) -> no line', () => {
  const s = setup();
  try {
    writeLock(s); writeTick(s, 5);
    assert.strictEqual(seg(run(s)), '');
  } finally { s.cleanup(); }
});

test('no live children -> no line even with no watcher and no tick', () => {
  const s = setup({ child: false });
  try {
    assert.strictEqual(seg(run(s)), '');
  } finally { s.cleanup(); }
});

test('a child session is unaffected (the Primary hook is a no-op for a child)', () => {
  const s = setup();
  try {
    assert.strictEqual(seg(run(s, { env: { DEVSWARM_SOURCE_BRANCH: 'main' } })), '');
  } finally { s.cleanup(); }
});

test('a non-Claude agent (no CronCreate/Monitor) is never told to call them', () => {
  const s = setup();
  try {
    assert.strictEqual(seg(run(s, { env: { DEVSWARM_AI_AGENT: 'codex' } })), '');
  } finally { s.cleanup(); }
});

test('devswarm.wakeWatch off + fresh tick -> nothing is missing, no line', () => {
  const s = setup();
  try {
    switchOff(s.home, 'devswarm', 'wakeWatch');
    writeTick(s, 5);
    assert.strictEqual(seg(run(s)), '');
  } finally { s.cleanup(); }
});

test('throttle: shown once, suppressed while pending, re-shown by the keepalive while the gap persists', () => {
  const s = setup();
  try {
    const tp = path.join(s.home, 'transcript.jsonl');
    const att = (ts, text) => JSON.stringify({
      type: 'attachment', timestamp: new Date(ts).toISOString(),
      attachment: { type: 'hook_additional_context', content: [text], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit' },
    }) + '\n';
    fs.writeFileSync(tp, att(Date.now() - 3600 * 1000, 'OLDER TURN'));
    const env = {};
    const first = run(s, { transcript_path: tp, env });
    assert.ok(seg(first).startsWith('NO MAILBOX WAKE PATH'), 'first showing');
    assert.strictEqual(seg(run(s, { transcript_path: tp, env })), '', 'pending copy is suppressed (burst collapse)');
    fs.appendFileSync(tp, att(Date.now(), first)); // delivered
    let reshown = -1;
    for (let i = 0; i < 14 && reshown < 0; i++) {
      const c = run(s, { transcript_path: tp, env });
      if (seg(c)) reshown = i; else fs.appendFileSync(tp, att(Date.now(), 'other turn ' + i));
    }
    // Quiet right after delivery (index 0 suppressed), then the guards.injectionRepeatEvery keepalive re-shows it.
    // (The exact turn depends on emit-dedupe's 1s timestamp tolerance against back-to-back fixture attachments.)
    assert.ok(reshown >= 1, 'index ' + reshown);
  } finally { s.cleanup(); }
});
