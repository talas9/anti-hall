'use strict';
// Every converted guard block/deny reason shares ONE readable shape
// (hooks/lib/block-message.js): a leading emoji from a small fixed set, an
// "anti-hall · <guard>: <what>" headline, short labelled lines, no ALL-CAPS banner,
// and the load-bearing facts the model needs (guard name, override command, tool).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload, HOOKS_DIR } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const bm = require('../../plugins/anti-hall/hooks/lib/block-message.js');

const ICONS = Object.values(bm.ICONS);
const LABELS = /^(Why|Do instead|Allowed here|Override \(only if the user explicitly asked\)): /;

// The shared shape: <icon> anti-hall · <guard>: <what>, then only labelled lines.
function assertShape(text, guard, label) {
  const lines = String(text).split('\n').filter(Boolean);
  assert.ok(lines.length >= 2 && lines.length <= 6, label + ': 2-6 lines, got ' + lines.length + '\n' + text);
  const m = /^(\S+) anti-hall · ([a-z0-9-]+): (.+)$/.exec(lines[0]);
  assert.ok(m, label + ': headline shape\n' + lines[0]);
  assert.ok(ICONS.includes(m[1]), label + ': icon from the fixed set, got ' + m[1]);
  assert.strictEqual(m[2], guard, label + ': guard name');
  for (const l of lines.slice(1)) assert.match(l, LABELS, label + ': labelled line "' + l.slice(0, 40) + '"');
  assert.doesNotMatch(lines[0], /\b[A-Z]{4,}(?: [A-Z]{2,})+\b/, label + ': no ALL-CAPS banner');
  assert.ok(lines.some((l) => l.startsWith('Why: ')), label + ': has Why');
  return lines;
}

function withCwd(fn) {
  const h = makeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-shape-'));
  try { return fn(h.home, cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); h.cleanup(); }
}
const ENV = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

test('helper: message() renders only the lines it is given, in order', () => {
  const t = bm.blockMessage({ guard: 'x-guard', what: 'a thing is blocked.', why: 'because.', instead: 'do y.', allowed: 'z.', override: 'cmd' });
  assert.deepStrictEqual(t.split('\n').map((l) => l.split(':')[0].replace(/^\S+ anti-hall · /, '')), [
    'x-guard', 'Why', 'Do instead', 'Allowed here', 'Override (only if the user explicitly asked)']);
  assert.strictEqual(bm.ICONS.update, '⬆️');
});

test('edit-guard (Claude + Codex apply_patch) block text has the shared shape and its facts', () => withCwd((home, cwd) => {
  const r = testHook('edit-guard.js', {
    hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 't', cwd,
    tool_input: { file_path: path.join(cwd, 'src.js'), old_string: 'x', new_string: 'y' },
  }, { home, env: ENV });
  assert.strictEqual(r.status, 2);
  const lines = assertShape(r.json.reason, 'edit-guard', 'edit-guard');
  assert.match(r.json.reason, /Edit blocked: the/);
  assert.match(r.json.reason, /skip edit-guard/);
  assert.match(r.json.reason, /15-min TTL/);
  const cx = testHook('edit-guard.js', {
    session_id: 'c', turn_id: 'turn-1', model: 'gpt-5.6-sol', cwd, hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: src.js\n+x\n*** End Patch' }, tool_use_id: 'c1',
  }, { home, env: {} });
  assert.strictEqual(cx.status, 2);
  assert.ok(cx.stderr.trim().length > 0, 'Codex needs non-empty stderr');
  assertShape(cx.json.reason, 'edit-guard', 'edit-guard codex');
  assert.match(cx.json.reason, /spawn_agent/);
  assert.doesNotMatch(cx.json.reason.split('\n').filter((l) => !l.startsWith('Override')).join('\n'), /scratchpad|a subagent/);
  assert.ok(lines.length <= 6);
}));

test('command-guard heavy-command block has the shared shape and its facts', () => withCwd((home, cwd) => {
  const r = testHook('command-guard.js', Object.assign(bashPayload('npm test'), { cwd }), { home, env: ENV });
  assert.strictEqual(r.status, 2);
  assertShape(r.json.reason, 'command-guard', 'command-guard');
  assert.match(r.json.reason, /verb: npm/);
  assert.match(r.json.reason, /Allowed here: Inline-allowed ONLY when piped to tail/);
  const cx = testHook('command-guard.js', Object.assign(bashPayload('npm test'), { cwd, turn_id: 't1', model: 'gpt-5.6-sol' }), { home, env: {} });
  assert.strictEqual(cx.status, 2);
  assert.ok(cx.stderr.trim().length > 0);
  assertShape(cx.json.reason, 'command-guard', 'command-guard codex');
  assert.match(cx.json.reason, /spawn_agent/);
  assert.doesNotMatch(cx.json.reason, /scratchpad|run_in_background|Haiku/);
}));

test('command-guard DevSwarm read redirect names its kill switch', () => withCwd((home, cwd) => {
  const r = testHook('command-guard.js', Object.assign(bashPayload('hivecontrol workspace monitor'), { cwd }),
    { home, env: Object.assign({ DEVSWARM_REPO_ID: 'repo-x' }, ENV) });
  assert.strictEqual(r.status, 2);
  assertShape(r.json.reason, 'devswarm-read-guard', 'devswarm-read-guard');
  assert.match(r.json.reason, /DISABLE_ANTIHALL_DEVSWARM=1/);
}));

test('git-guard force-push block has the shared shape (stderr only, Codex contract)', () => withCwd((home, cwd) => {
  const r = testHook('git-guard.js', Object.assign(bashPayload('git push --force origin main'), { cwd }), { home, env: ENV });
  assert.strictEqual(r.status, 2);
  assertShape(r.stderr, 'git-guard', 'git-guard force push');
  const c = testHook('git-guard.js', Object.assign(bashPayload('git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'), { cwd }), { home, env: ENV });
  assert.strictEqual(c.status, 2);
  assertShape(c.stderr, 'git-guard', 'git-guard self-credit');
}));

test('model-routing-guard strict block has the shared shape and its override', () => withCwd((home) => {
  const r = testHook('model-routing-guard.js', {
    hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 't', cwd: process.cwd(),
    tool_input: { subagent_type: 'general-purpose', prompt: 'fetch and download and tail the logs' },
  }, { home });
  assert.strictEqual(r.status, 2);
  assertShape(r.json.reason, 'model-routing-guard', 'model-routing-guard');
  assert.match(r.json.reason, /ANTIHALL_MODEL_ROUTING=advisory/);
}));

test('coordinator-work-guard block + nudge text have the shared shape', () => {
  const lib = require('../../plugins/anti-hall/hooks/lib/coordinator-work.js');
  const cfg = { windowMs: 600000, blockAt: 8 };
  const b = lib.BLOCK(8, cfg, 'node skip coordinator-work-guard');
  assertShape(b, 'coordinator-work-guard', 'coordinator-work block');
  assert.match(b, /node skip coordinator-work-guard/);
  assert.match(b, /15-min TTL/);
  const n = lib.NUDGE(5, cfg);
  assert.match(n, /^⚠️ anti-hall · coordinator-work-guard: /);
});
