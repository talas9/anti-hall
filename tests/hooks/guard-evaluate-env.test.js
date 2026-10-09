'use strict';
// A guard's evaluate(payload, env) decides from its `env` ARGUMENT only. Each case runs the guard
// in-process with an env that DIFFERS from process.env (a different HOME, an on/off var, a skip
// marker, an entrypoint var) and asserts the decision follows the argument; the "ambient" side
// (process.env / the process HOME) is set to the opposite value so reading it would flip the result.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'plugins', 'anti-hall', 'hooks');
const guard = (f) => require(path.join(HOOKS, f)).evaluate;

const pre = (command, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 's1', cwd: ROOT }, extra || {});
const post = (command, response, extra) => Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: response || { stdout: '', stderr: '' }, session_id: 's1', tool_use_id: 'tu1', cwd: ROOT }, extra || {});
const write = (file_path, content, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content }, session_id: 's1', cwd: ROOT }, extra || {});
const FORCE_PUSH = 'git push --' + 'force origin main'; // built from pieces: git-guard scans this file's text
const envFor = (home, extra) => Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1' }, extra || {});
const PROC_HOME = process.env.HOME; // the ambient (process) home isolate-home.js created

// Run fn with process.env keys temporarily set, then restore them exactly.
function withProcessEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function writeSettings(home, obj) {
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify(obj));
}

test('git-guard: the skip marker is read from env.HOME, never the process home', () => {
  const evaluate = guard('git-guard.js');
  const a = makeHome(); const b = makeHome();
  a.writeSkip({ 'git-guard': Date.now() + 60000 });
  assert.strictEqual(evaluate(pre(FORCE_PUSH), envFor(a.home)).exitCode, 0, 'env home with a skip marker allows');
  assert.strictEqual(evaluate(pre(FORCE_PUSH), envFor(b.home)).exitCode, 2, 'env home without one blocks');
  // Ambient process home carries the marker; env points elsewhere -> still blocks.
  const ambient = path.join(PROC_HOME, '.anti-hall', 'skip.json');
  fs.mkdirSync(path.dirname(ambient), { recursive: true });
  fs.writeFileSync(ambient, JSON.stringify({ 'git-guard': Date.now() + 60000 }));
  try {
    assert.strictEqual(evaluate(pre(FORCE_PUSH), envFor(b.home)).exitCode, 2, 'process-home marker must not apply');
  } finally { fs.rmSync(ambient, { force: true }); }
});

test('git-guard: the on/off var comes from the env argument', () => {
  const evaluate = guard('git-guard.js');
  const h = makeHome();
  assert.strictEqual(evaluate(pre(FORCE_PUSH), envFor(h.home)).exitCode, 2);
  assert.strictEqual(evaluate(pre(FORCE_PUSH), envFor(h.home, { ANTIHALL_GIT_GUARD: 'off' })).exitCode, 0, 'env off var disables');
  withProcessEnv({ ANTIHALL_GIT_GUARD: 'off' }, () => {
    assert.strictEqual(evaluate(pre(FORCE_PUSH), envFor(h.home)).exitCode, 2, 'ambient off var must not apply');
  });
});

test('command-guard: coordinator detection and the skip marker follow the env argument', () => {
  const evaluate = guard('command-guard.js');
  const h = makeHome();
  const coord = envFor(h.home, { CLAUDE_CODE_ENTRYPOINT: 'cli' });
  withProcessEnv({ CLAUDE_CODE_ENTRYPOINT: 'agent_tool' }, () => {
    assert.strictEqual(evaluate(pre('npm test'), coord).exitCode, 2, 'env says coordinator even though the process env says subagent');
  });
  withProcessEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, () => {
    assert.strictEqual(evaluate(pre('npm test'), envFor(h.home, { CLAUDE_CODE_ENTRYPOINT: 'agent_tool' })).exitCode, 0, 'env says subagent even though the process env says coordinator');
  });
  assert.strictEqual(evaluate(pre('npm test'), envFor(h.home, { CLAUDE_CODE_ENTRYPOINT: 'cli', ANTIHALL_COMMAND_GUARD: 'off' })).exitCode, 0, 'env off var disables');
  h.writeSkip({ 'command-guard': Date.now() + 60000 });
  assert.strictEqual(evaluate(pre('npm test'), coord).exitCode, 0, 'env-home skip marker allows');
  // env state must not leak past the call: a following call with the plain process env behaves per process env.
  assert.strictEqual(evaluate(pre('npm test'), envFor(makeHome().home, { CLAUDE_CODE_ENTRYPOINT: 'cli' })).exitCode, 2);
});

test('coordinator-work-guard: thresholds come from the env argument and state lands in env.HOME', () => {
  const evaluate = guard('coordinator-work-guard.js');
  const h = makeHome();
  const cfg = { CLAUDE_CODE_ENTRYPOINT: 'cli', ANTIHALL_COORDINATOR_WORK_BLOCK_AT: '1', ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '1', ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS: '3000' };
  const r = evaluate(pre('git commit -qm x'), envFor(h.home, cfg), { argv: [] });
  assert.strictEqual(r.exitCode, 2, 'the block threshold set only in the env argument applies');
  assert.ok(fs.readdirSync(path.join(h.home, '.anti-hall')).length > 0, 'state written under env.HOME');
  const quiet = evaluate(pre('git commit -qm x'), envFor(makeHome().home, { CLAUDE_CODE_ENTRYPOINT: 'cli' }), { argv: [] });
  assert.strictEqual(quiet.exitCode, 0, 'no thresholds in env -> default window does not block the first call');
});

test('merge-gate: the opt-in var comes from the env argument', () => {
  const evaluate = guard('merge-gate.js');
  const h = makeHome();
  const tp = path.join(h.home, 't.jsonl');
  fs.writeFileSync(tp, JSON.stringify(assistantMessage('Built the dashboard, pending review by you.')) + '\n');
  const payload = pre('gh pr merge 42 --squash', { transcript_path: tp });
  assert.strictEqual(evaluate(payload, envFor(h.home, { ANTIHALL_MERGE_GATE: '1' })).exitCode, 2);
  assert.strictEqual(evaluate(payload, envFor(h.home)).exitCode, 0, 'default off');
  withProcessEnv({ ANTIHALL_MERGE_GATE: '1' }, () => {
    assert.strictEqual(evaluate(payload, envFor(h.home)).exitCode, 0, 'ambient opt-in must not apply');
  });
  h.writeSkip({ 'merge-gate': Date.now() + 60000 });
  assert.strictEqual(evaluate(payload, envFor(h.home, { ANTIHALL_MERGE_GATE: '1' })).exitCode, 0, 'env-home skip marker allows');
});

test('ship-it-guard: the opt-in var and the skip marker follow the env argument', () => {
  const evaluate = guard('ship-it-guard.js');
  const h = makeHome();
  const payload = write(path.join(h.home, '.github', 'workflows', 'deploy.yml'), 'x', { cwd: h.home });
  assert.strictEqual(evaluate(payload, envFor(h.home, { ANTIHALL_SHIPIT_GATE: '1' })).exitCode, 2);
  assert.strictEqual(evaluate(payload, envFor(h.home)).exitCode, 0, 'default off');
  withProcessEnv({ ANTIHALL_SHIPIT_GATE: '1' }, () => {
    assert.strictEqual(evaluate(payload, envFor(h.home)).exitCode, 0, 'ambient opt-in must not apply');
  });
  h.writeSkip({ 'ship-it-guard': Date.now() + 60000 });
  assert.strictEqual(evaluate(payload, envFor(h.home, { ANTIHALL_SHIPIT_GATE: '1' })).exitCode, 0);
});

test('output-verify-guard: the off var follows the env argument', () => {
  const evaluate = guard('output-verify-guard.js');
  const h = makeHome();
  const payload = post('npm test', { stdout: 'FAIL src/foo.test.js\nTests: 2 failed, 8 passed, 10 total\n', stderr: '' });
  assert.match(evaluate(payload, envFor(h.home)).stdout, /output-verify-guard/);
  assert.strictEqual(evaluate(payload, envFor(h.home, { ANTIHALL_OUTPUT_VERIFY_GUARD: 'off' })).stdout, '', 'env off var disables');
  withProcessEnv({ ANTIHALL_OUTPUT_VERIFY_GUARD: 'off' }, () => {
    assert.match(evaluate(payload, envFor(h.home)).stdout, /output-verify-guard/, 'ambient off var must not apply');
  });
});

test('api-guard: settings.json is read from env.HOME', () => {
  const evaluate = guard('api-guard.js');
  const off = makeHome(); const on = makeHome();
  writeSettings(off.home, { guards: { apiGuard: false } });
  const payload = write(path.join(os.tmpdir(), 'x.js'), "const fs = require('fs');\nfs.quantumFork();\n");
  assert.strictEqual(evaluate(payload, envFor(on.home)).exitCode, 2, 'a home without the setting blocks');
  assert.strictEqual(evaluate(payload, envFor(off.home)).exitCode, 0, 'a home with guards.apiGuard=false allows');
  // The ambient process home turns the guard off; env.HOME does not -> still blocks.
  writeSettings(PROC_HOME, { guards: { apiGuard: false } });
  try {
    assert.strictEqual(evaluate(payload, envFor(on.home)).exitCode, 2, 'process-home settings must not apply');
  } finally { fs.rmSync(path.join(PROC_HOME, '.anti-hall', 'settings.json'), { force: true }); }
});

test('compact-declaration-guard: settings.json and the skip marker come from env.HOME', () => {
  const evaluate = guard('compact-declaration-guard.js');
  const h = makeHome(); const off = makeHome();
  writeSettings(off.home, { guards: { compactDeclarationGuard: false } });
  const tp = path.join(h.home, 't.jsonl');
  fs.writeFileSync(tp, [{ type: 'user', isSidechain: false, message: { role: 'user', content: 'go' } }, assistantMessage('Work is saved. SAFE TO COMPACT.')].map((m) => JSON.stringify(m)).join('\n') + '\n');
  const payload = pre('git push origin dev', { transcript_path: tp });
  assert.strictEqual(evaluate(payload, envFor(h.home)).exitCode, 2);
  assert.strictEqual(evaluate(payload, envFor(off.home)).exitCode, 0, 'setting in env.HOME disables');
  h.writeSkip({ 'compact-declaration-guard': Date.now() + 60000 });
  assert.strictEqual(evaluate(payload, envFor(h.home)).exitCode, 0, 'env-home skip marker allows');
});

test('merge-side-pick: reads its state from env.HOME, not the process home', () => {
  const evaluate = guard('merge-side-pick.js');
  const lib = require(path.join(HOOKS, 'lib', 'merge-side-pick.js'));
  const h = makeHome(); const other = makeHome();
  lib.record(h.home, 's1', 'git checkout --' + 'ours a.txt');
  const push = pre('git push origin dev');
  assert.match(evaluate(push, envFor(h.home)).stdout, /additionalContext/, 'env.HOME holds the side-pick');
  assert.strictEqual(evaluate(push, envFor(other.home)).stdout, '', 'a different env.HOME has none');
});

test('scan-throttle: the pattern and on/off vars come from the env argument', () => {
  const evaluate = guard('scan-throttle.js');
  const h = makeHome();
  const payload = pre('reindex-repo --full');
  const on = envFor(h.home, { ANTI_HALL_THROTTLE_PATTERNS: '^\\s*reindex-repo\\b' });
  assert.match(evaluate(payload, on).stdout, /scan-throttle/);
  assert.strictEqual(evaluate(payload, envFor(h.home)).stdout, '', 'no pattern in env -> quiet');
  assert.strictEqual(evaluate(payload, Object.assign({}, on, { ANTIHALL_SCAN_THROTTLE: '0' })).stdout, '', 'env off var disables');
});

test('devswarm-child-drain: workspace state is read from env.HOME', () => {
  const evaluate = guard('devswarm-child-drain.js');
  const h = makeHome(); const other = makeHome();
  const dsw = path.join(h.home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(dsw, 'child-1.inbox.ndjson');
  const cursorPath = path.join(dsw, 'child-1.cursor');
  fs.mkdirSync(path.join(dsw, 'workspaces'), { recursive: true });
  fs.writeFileSync(inboxPath, JSON.stringify({ from: 'primary-abc', to: 'child-1', type: 'direct', message: 'm0', timestamp: Date.now() }) + '\n');
  fs.writeFileSync(cursorPath, '0');
  fs.writeFileSync(path.join(dsw, 'workspaces', 'child-1.json'), JSON.stringify({ id: 'child-1', inboxPath, cursorPath, worktreePath: ROOT }));
  const child = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' };
  assert.match(evaluate(post('git status'), envFor(h.home, child)).stdout, /additionalContext/, 'env.HOME holds the unread mail');
  assert.strictEqual(evaluate(post('git status'), envFor(other.home, child)).stdout, '', 'a different env.HOME has no workspace');
});

test('devswarm-parent-reply-tracker: the reply record lands in env.HOME, not the process home', () => {
  const evaluate = guard('devswarm-parent-reply-tracker.js');
  const h = makeHome();
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
  const before = walk(path.join(PROC_HOME, '.anti-hall')).length;
  const send = post('node devswarm.js send --to w1 --message hi', { stdout: JSON.stringify({ ok: true, action: 'send', type: 'direct', toId: 'w1', sent: true }) + '\n', stderr: '' });
  assert.strictEqual(evaluate(send, envFor(h.home, { DEVSWARM_REPO_ID: 'repo-1' })).exitCode, 0);
  assert.ok(walk(path.join(h.home, '.anti-hall')).some((f) => /replies\.json$/.test(f)), 'reply record written under env.HOME');
  assert.strictEqual(walk(path.join(PROC_HOME, '.anti-hall')).length, before, 'the process home is untouched');
  // An env without DEVSWARM_REPO_ID is inert even when the process env carries it.
  const h2 = makeHome();
  withProcessEnv({ DEVSWARM_REPO_ID: 'repo-1' }, () => { evaluate(send, envFor(h2.home)); });
  assert.deepStrictEqual(walk(path.join(h2.home, '.anti-hall')), [], 'ambient DEVSWARM_REPO_ID must not arm the tracker');
});
