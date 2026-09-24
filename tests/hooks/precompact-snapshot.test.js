'use strict';
// hooks/precompact-snapshot.js (PreCompact) — the mechanical safety net:
// writes PRECOMPACT-<n>.md (git state, task snapshot, last user messages
// verbatim, newest-handover pointer), NEVER prints anything (stdout could
// block compaction), always exits 0.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const find = require('../../plugins/anti-hall/hooks/lib/handover-find.js');

const HOOK = 'precompact-snapshot.js';

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-precompact-'));
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first commit');
  fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'x');
  return cwd;
}

function run(h, payload) {
  return testHookRaw(HOOK, JSON.stringify(payload), { home: h.home });
}

function snapDir(cwd, sid) {
  return path.join(cwd, '.anti-hall', 'handovers', find.localDate(), sid);
}

function transcript(h) {
  const entries = [
    { type: 'user', message: { role: 'user', content: 'rule one: never delete X until I confirm' }, timestamp: '2026-09-24T10:00:00Z' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'META should be skipped' } },
    { type: 'user', message: { role: 'user', content: '<task-notification>\nharness noise</task-notification>' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu1', name: 'TaskCreate', input: { subject: 'Build the thing' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'Task #7 created successfully: Build the thing' },
    ] } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'serial agents only, please' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt must be skipped' } },
  ];
  return h.writeTranscript(entries);
}

test('writes PRECOMPACT-1.md with git state, task snapshot, verbatim user messages; stdout empty; exit 0', () => {
  const h = makeHome();
  const cwd = makeRepo();
  try {
    const r = run(h, { session_id: 'sess-1', transcript_path: transcript(h), cwd, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'PreCompact must never print (a decision could block compaction)');
    const f = path.join(snapDir(cwd, 'sess-1'), 'PRECOMPACT-1.md');
    const body = fs.readFileSync(f, 'utf8');
    assert.match(body, /right before compaction \(trigger: auto\)/);
    assert.match(body, new RegExp('pwd: ' + cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(body, /HEAD: [0-9a-f]+ first commit/);
    assert.match(body, /dirty files: 1/);
    assert.match(body, /dirty\.txt/);
    assert.match(body, /\| 7 \| Build the thing \| in_progress \|/);
    assert.match(body, /rule one: never delete X until I confirm/);
    assert.match(body, /serial agents only, please/);
    assert.doesNotMatch(body, /META should be skipped/);
    assert.doesNotMatch(body, /harness noise/);
    assert.doesNotMatch(body, /subagent prompt must be skipped/);
    assert.match(body, /## Newest handover\nnone found/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('second compaction writes PRECOMPACT-2.md, names the newest handover, and keeps /compact instructions verbatim', () => {
  const h = makeHome();
  const cwd = makeRepo();
  try {
    const dir = snapDir(cwd, 'sess-2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'HANDOVER.md'), '# Handover\n');
    const p = { session_id: 'sess-2', transcript_path: transcript(h), cwd, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'focus on the API' };
    run(h, p);
    const r = run(h, p);
    assert.strictEqual(r.status, 0);
    const body = fs.readFileSync(path.join(dir, 'PRECOMPACT-2.md'), 'utf8');
    assert.match(body, /HANDOVER\.md \(modified /);
    assert.match(body, /## \/compact instructions \(verbatim\)\nfocus on the API/);
    assert.ok(fs.existsSync(path.join(dir, 'PRECOMPACT-1.md')), 'earlier snapshot is never overwritten');
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Codex rollout: user messages come from event_msg user_message entries', () => {
  const h = makeHome();
  const cwd = makeRepo();
  try {
    const tp = h.writeTranscript([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions (injected)' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'codex user rule: keep the API stable' } },
    ]);
    run(h, { session_id: 'codex-s', transcript_path: tp, cwd, hook_event_name: 'PreCompact', trigger: 'auto', turn_id: 't1' });
    const body = fs.readFileSync(path.join(snapDir(cwd, 'codex-s'), 'PRECOMPACT-1.md'), 'utf8');
    assert.match(body, /codex user rule: keep the API stable/);
    assert.doesNotMatch(body, /AGENTS\.md instructions/);
    assert.match(body, /not derivable/);
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('fail-open: garbage stdin, missing cwd, non-git dir, missing transcript -> exit 0, no stdout', () => {
  const h = makeHome();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-precompact-nogit-'));
  try {
    const r1 = testHookRaw(HOOK, 'not json', { home: h.home });
    assert.strictEqual(r1.status, 0);
    assert.strictEqual(r1.stdout, '');
    const r2 = run(h, { session_id: 's', hook_event_name: 'PreCompact', trigger: 'auto' });
    assert.strictEqual(r2.status, 0);
    assert.strictEqual(r2.stdout, '');
    const r3 = run(h, { session_id: 's', cwd: plain, transcript_path: path.join(plain, 'nope.jsonl'), hook_event_name: 'PreCompact', trigger: 'auto' });
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '');
    const body = fs.readFileSync(path.join(snapDir(plain, 's'), 'PRECOMPACT-1.md'), 'utf8');
    assert.match(body, /git: not a git repository/);
  } finally {
    h.cleanup();
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('never snapshots for a subagent payload', () => {
  const h = makeHome();
  const cwd = makeRepo();
  try {
    run(h, { session_id: 'sub', cwd, hook_event_name: 'PreCompact', trigger: 'auto', agent_id: 'a1', agent_type: 'x' });
    assert.ok(!fs.existsSync(snapDir(cwd, 'sub')));
  } finally {
    h.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registered on PreCompact in BOTH the Claude and Codex hooks.json, and in install-codex.js', () => {
  const root = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  const claude = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(root, 'codex', 'hooks', 'hooks.json'), 'utf8'));
  const has = (cfg) => (cfg.hooks.PreCompact || []).some((g) => g.hooks.some((x) => /precompact-snapshot\.js/.test(x.command)));
  assert.ok(has(claude), 'Claude hooks.json PreCompact');
  assert.ok(has(codex), 'Codex hooks.json PreCompact');
  const { ANTI_HALL_HOOKS } = require(path.join(root, 'codex', 'install-codex.js'));
  assert.ok((ANTI_HALL_HOOKS.PreCompact || []).length > 0, 'install-codex.js PreCompact');
});
