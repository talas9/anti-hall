'use strict';
// Coordinator detection for Codex payloads, on every tool (not only apply_patch).
//
// The payloads below are real codex-cli 0.160.0 PreToolUse payloads captured
// from a live `codex exec` run with a logging hook, with paths replaced:
//   main thread: session_id, turn_id, transcript_path, cwd, hook_event_name,
//                model, permission_mode, tool_name, tool_input, tool_use_id
//   subagent:    the same keys plus agent_id and agent_type
// A native Codex hook process has no CLAUDE_CODE_ENTRYPOINT; a Codex started
// from inside a Claude Code session inherits it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'coordinator-detect.js');

const MAIN = {
  session_id: '01a102fe-6130-7830-81c2-f7d43573e17b',
  turn_id: '01a102fe-61a6-7680-a36e-98a52806f988',
  transcript_path: '/home/user/.codex/sessions/2026/10/03/rollout-2026-10-03T00-00-00-01a102fe.jsonl',
  cwd: '/home/user/project',
  hook_event_name: 'PreToolUse',
  model: 'gpt-5.6-sol',
  permission_mode: 'bypassPermissions',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  tool_use_id: 'exec-6a0477d7-38e6-4910-a488-7ab7b06ce1d3',
};
const SUB = Object.assign({}, MAIN, {
  session_id: '01a10303-baff-77b0-b320-7d99e0ae22b9',
  turn_id: '01a10303-f37e-74d0-bf90-fdb0e25f86e0',
  agent_id: '01a10303-f341-7573-a0ac-576f353427c2',
  agent_type: 'executor',
  model: 'gpt-5.5',
  tool_use_id: 'call_pq5nUwZtRz4wb5RZl8CwMRXi',
});

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}
function isCoordinator(payload, entrypoint) {
  delete require.cache[require.resolve(MOD)];
  return withEnv({ CLAUDE_CODE_ENTRYPOINT: entrypoint }, () => require(MOD).isCoordinator(payload));
}

// ------------------------------------------------------------- unit: detection
test('Codex main thread (Bash, no agent keys, no entrypoint) -> coordinator', () => {
  assert.strictEqual(isCoordinator(MAIN), true);
});

test('Codex main thread on other events (UserPromptSubmit / Stop shape) -> coordinator', () => {
  const ups = { session_id: MAIN.session_id, turn_id: MAIN.turn_id, transcript_path: MAIN.transcript_path, cwd: MAIN.cwd, hook_event_name: 'UserPromptSubmit', model: MAIN.model, permission_mode: MAIN.permission_mode, prompt: 'hi' };
  assert.strictEqual(isCoordinator(ups), true);
  assert.strictEqual(isCoordinator(Object.assign({}, ups, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: null })), true);
});

test('Codex subagent (agent_id/agent_type) -> not coordinator', () => {
  assert.strictEqual(isCoordinator(SUB), false);
  const idOnly = Object.assign({}, SUB); delete idOnly.agent_type;
  assert.strictEqual(isCoordinator(idOnly), false);
});

test('Codex launched from inside Claude Code (entrypoint inherited) -> worker, not coordinator', () => {
  for (const ep of ['cli', 'agent_tool', 'vscode', 'sdk-ts']) {
    assert.strictEqual(isCoordinator(MAIN, ep), false, ep);
  }
});

test('malformed or partial Codex-looking payloads fail open (not coordinator)', () => {
  const variants = [
    Object.assign({}, MAIN, { turn_id: '' }),
    Object.assign({}, MAIN, { turn_id: 42 }),
    Object.assign({}, MAIN, { turn_id: null }),
    Object.assign({}, MAIN, { model: '' }),
    Object.assign({}, MAIN, { model: { id: 'x' } }),
    (() => { const p = Object.assign({}, MAIN); delete p.model; return p; })(),
    (() => { const p = Object.assign({}, MAIN); delete p.turn_id; return p; })(),
  ];
  for (const v of variants) assert.strictEqual(isCoordinator(v), false, JSON.stringify({ turn_id: v.turn_id, model: v.model }));
  for (const v of [null, undefined, 'turn_id', 7, [], [MAIN]]) assert.strictEqual(isCoordinator(v), false, String(v));
});

test('Claude Code shapes unchanged: no turn_id/model -> entrypoint decides', () => {
  const claude = { session_id: 's', transcript_path: '/t.jsonl', cwd: '/w', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1' };
  assert.strictEqual(isCoordinator(claude), false);
  assert.strictEqual(isCoordinator(claude, 'cli'), true);
  assert.strictEqual(isCoordinator(Object.assign({}, claude, { agent_id: 'a' }), 'cli'), false);
  // Claude Code sends turn_id only on MessageDisplay, never with model; still entrypoint-driven.
  assert.strictEqual(isCoordinator(Object.assign({}, claude, { turn_id: 't' }), 'cli'), true);
  assert.strictEqual(isCoordinator(Object.assign({}, claude, { turn_id: 't' })), false);
});

// ------------------------------------------------- end to end: command-guard
function withRepo(fn) {
  const h = makeHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-coord-'));
  try { return fn(h.home, repo); } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    h.cleanup();
  }
}

test('command-guard: Codex main-thread `npm test` -> BLOCK with the reason on stderr', () => withRepo((home, repo) => {
  const r = testHook('command-guard.js', Object.assign({}, MAIN, { cwd: repo }), { home, env: {} });
  assert.strictEqual(r.status, 2, 'stdout=' + r.stdout);
  assert.ok(r.json && r.json.decision === 'block');
  assert.match(r.json.reason, /Heavy command detected/);
  assert.strictEqual(r.stderr.trim(), r.json.reason.trim());
}));

test('command-guard: Codex subagent `npm test` -> allowed', () => withRepo((home, repo) => {
  const r = testHook('command-guard.js', Object.assign({}, SUB, { cwd: repo }), { home, env: {} });
  assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
}));

test('command-guard: Codex main thread with inherited CLAUDE_CODE_ENTRYPOINT -> allowed (worker)', () => withRepo((home, repo) => {
  const r = testHook('command-guard.js', Object.assign({}, MAIN, { cwd: repo }), { home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
}));

test('command-guard: malformed Codex payload (numeric turn_id) -> allowed (fail open)', () => withRepo((home, repo) => {
  const r = testHook('command-guard.js', Object.assign({}, MAIN, { cwd: repo, turn_id: 42 }), { home, env: {} });
  assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
}));
