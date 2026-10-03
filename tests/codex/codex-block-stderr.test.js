'use strict';
// Every exit-2 block path of the Codex-registered PreToolUse guards must put a
// non-empty reason on STDERR, equal to the stdout JSON reason.
//
// Why: Codex reads stdout JSON only on exit 0. On exit 2 it takes the block
// reason from stderr, and an exit 2 with empty stderr is recorded as a failed
// hook ("PreToolUse hook exited with code 2 but did not write a blocking reason
// to stderr") and the tool call PROCEEDS
// (codex-rs/hooks/src/events/pre_tool_use.rs, rust-v0.160.0). Claude Code uses
// the JSON blocking decision's reason when there is one and stderr otherwise
// (code.claude.com/docs/en/hooks, "Exit code 2"), so an identical stderr text
// leaves the Claude message unchanged.
//
// The static companion (tests/hygiene/codex-block-stderr.test.js) catches any
// exit-2 site that does not write stderr.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function assertStderrBlock(r) {
  assert.strictEqual(r.status, 2, 'expected a block; stdout=' + r.stdout);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected; stdout=' + r.stdout);
  assert.ok(r.stderr.trim().length > 0, 'Codex needs the block reason on stderr');
  assert.strictEqual(r.stderr.trim(), r.json.reason.trim(), 'stderr must equal the JSON reason');
}

function withHome(fn) {
  const h = makeHome();
  try { return fn(h); } finally { h.cleanup(); }
}

// ------------------------------------------------------------- command-guard
const CG = 'command-guard.js';
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const DEVSWARM = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-x' };

test('command-guard: heavy command on the coordinator -> stderr carries the reason', () => withHome((h) => {
  assertStderrBlock(testHook(CG, bashPayload('npm test'), { home: h.home, env: COORD }));
}));

test('command-guard: devswarm-read-guard (monitor) -> stderr carries the reason', () => withHome((h) => {
  assertStderrBlock(testHook(CG, bashPayload('hivecontrol workspace monitor'), { home: h.home, env: DEVSWARM }));
}));

test('command-guard: devswarm raw inbox file read -> stderr carries the reason', () => withHome((h) => {
  const cmd = 'cat ' + path.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson');
  assertStderrBlock(testHook(CG, bashPayload(cmd), { home: h.home, env: DEVSWARM }));
}));

test('command-guard: devswarm-send-guard -> stderr carries the reason', () => withHome((h) => {
  assertStderrBlock(testHook(CG, bashPayload('hivecontrol workspace message-parent hi'), { home: h.home, env: DEVSWARM }));
}));

test('command-guard: subagent mailbox guard -> stderr carries the reason', () => withHome((h) => {
  const r = testHook(CG, bashPayload('node scripts/devswarm.js inbox ack ws1', { agentId: 'sub-1' }), { home: h.home, env: {} });
  assertStderrBlock(r);
}));

test('command-guard: armed git-stash guard, Codex main-thread shape (no entrypoint) -> stderr carries the reason', () => withHome((h) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-stash-stderr-'));
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, '.anti-hall'));
    fs.writeFileSync(path.join(repo, '.anti-hall', 'protected-stashes'), 'wip@{0}\n');
    const payload = Object.assign(bashPayload('git stash push'), {
      cwd: repo, turn_id: 'turn-1', model: 'gpt-5.5', permission_mode: 'default', tool_use_id: 'call_1',
    });
    assertStderrBlock(testHook(CG, payload, { home: h.home, env: {} }));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}));

// ------------------------------------------------- compact-declaration-guard
test('compact-declaration-guard: Codex rollout shape (Bash) -> stderr carries the reason', () => withHome((h) => {
  fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: { compactDeclarationGuard: true } }));
  const ts = () => new Date().toISOString();
  const tp = h.writeTranscript([
    { timestamp: ts(), type: 'event_msg', payload: { type: 'user_message', message: 'wrap up' } },
    { timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '✅ SAFE TO COMPACT NOW' }] } },
  ]);
  const payload = { hook_event_name: 'PreToolUse', session_id: 'cdg-1', cwd: process.cwd(), transcript_path: tp, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } };
  assertStderrBlock(testHook('compact-declaration-guard.js', payload, { home: h.home }));
}));

// ------------------------------------------------------------ lib/emit-block
test('emitBlock: stdout JSON, identical stderr reason, exit 2', () => {
  const { spawnSync } = require('node:child_process');
  const lib = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'emit-block.js');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(lib)}).emitBlock('no: because')`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.deepStrictEqual(JSON.parse(r.stdout), { decision: 'block', reason: 'no: because' });
  assert.strictEqual(r.stderr, 'no: because\n');
  const r2 = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(lib)}).emitBlock('r', { decision: 'block', reason: 'r', extra: 1 })`], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(r2.stdout), { decision: 'block', reason: 'r', extra: 1 });
  assert.strictEqual(r2.stderr, 'r\n');
});
