'use strict';
// Issue #94: guard block text must not tell a Codex model Claude-specific things
// (scratchpad script, run_in_background, Haiku, "subagent" with no Codex tool).
// Codex payloads (turn_id + model, or apply_patch) get Codex wording; Claude
// payloads match the golden reasons (fixture regenerated for the shared shape; generated from the
// pre-fix hooks). Exit 2 + non-empty stderr is kept on Codex.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload, HOOKS_DIR } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const ROOT = path.resolve(HOOKS_DIR, '..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-guard-reasons.json'), 'utf8'));
const ENVS = {
  coord: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
  primary: { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-x' },
  child: { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'b' },
};
// Codex sets no CLAUDE_CODE_ENTRYPOINT (a Codex process that has it is a Claude-side worker).
const CODEX_ENVS = {
  coord: {},
  primary: { DEVSWARM_REPO_ID: 'repo-x' },
  child: { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'b' },
};
const CODEX = { turn_id: 'turn-1', model: 'gpt-5.6-sol' };
const CLAUDE_ONLY = /scratchpad|run_in_background|Haiku|a subagent/;

function withCwd(fn) {
  const h = makeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-g94-'));
  try { return fn(h.home, cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); h.cleanup(); }
}
const norm = (x, cwd) => (x ? x.split(ROOT).join('<ROOT>').split(cwd).join('<CWD>') : null);
const cmdPayload = (cwd, extra) => Object.assign(bashPayload('npm test'), { cwd }, extra || {});
const editPayload = (cwd, extra) => Object.assign({
  hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 't', cwd,
  tool_input: { file_path: path.join(cwd, 'src.js'), old_string: 'x', new_string: 'y' },
}, extra || {});

for (const [name, env] of Object.entries(ENVS)) {
  test('Claude text matches the golden reasons: command-guard ' + name, () => withCwd((home, cwd) => {
    const r = testHook('command-guard.js', cmdPayload(cwd), { home, env });
    assert.strictEqual(r.status, GOLDEN['command-guard:' + name].status);
    assert.strictEqual(norm(r.json.reason, cwd), GOLDEN['command-guard:' + name].reason);
  }));
  test('Claude text matches the golden reasons: edit-guard ' + name, () => withCwd((home, cwd) => {
    const r = testHook('edit-guard.js', editPayload(cwd), { home, env });
    assert.strictEqual(r.status, GOLDEN['edit-guard:' + name].status);
    assert.strictEqual(norm(r.json.reason, cwd), GOLDEN['edit-guard:' + name].reason);
  }));
  test('Codex text: command-guard ' + name + ' has no Claude-only vocabulary', () => withCwd((home, cwd) => {
    const r = testHook('command-guard.js', cmdPayload(cwd, CODEX), { home, env: CODEX_ENVS[name] });
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.trim().length > 0 && r.stderr.trim() === r.json.reason.trim());
    assert.doesNotMatch(norm(r.json.reason, cwd), CLAUDE_ONLY);
    assert.match(r.json.reason, /spawn_agent/);
  }));
}

test('Codex text: command-guard names the Codex cheap tier', () => withCwd((home, cwd) => {
  const r = testHook('command-guard.js', cmdPayload(cwd, CODEX), { home, env: CODEX_ENVS.coord });
  assert.match(r.json.reason, /gpt-5\.6-luna/);
}));

for (const [name, env] of Object.entries(CODEX_ENVS)) {
  test('Codex text: edit-guard ' + name + ' (apply_patch) names spawn_agent, no scratchpad', () => withCwd((home, cwd) => {
    const patch = '*** Begin Patch\n*** Add File: src.js\n+x\n*** End Patch';
    const p = Object.assign(CODEX, {});
    const r = testHook('edit-guard.js', {
      session_id: 'c', turn_id: 'turn-1', model: p.model, cwd, hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch', tool_input: { command: patch }, tool_use_id: 'call_1',
    }, { home, env });
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.trim().length > 0 && r.stderr.trim() === r.json.reason.trim());
    assert.doesNotMatch(norm(r.json.reason, cwd), CLAUDE_ONLY);
    assert.match(r.json.reason, /spawn_agent/);
  }));
}

test('Codex text: edit-guard malformed apply_patch names spawn_agent', () => withCwd((home, cwd) => {
  const r = testHook('edit-guard.js', {
    session_id: 'c', turn_id: 'turn-1', model: 'gpt-5.6-sol', cwd, hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\nnonsense' }, tool_use_id: 'c1',
  }, { home, env: CODEX_ENVS.coord });
  assert.strictEqual(r.status, 2);
  assert.match(r.json.reason, /spawn_agent/);
  assert.doesNotMatch(r.json.reason, /a subagent/);
}));
