'use strict';
// failure-root-cause-nudge noise filter: expected exit-1 predicates, harness
// refusals and per-turn repeats stay silent; real failures still nudge.
// output-verify-guard: identical advisory shown once per turn.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { isExpectedNonzero, isHarnessRefusal } = require('../../plugins/anti-hall/hooks/lib/expected-failure.js');

const HOOK = 'failure-root-cause-nudge.js';
const ctx = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';

function transcript(home, turns) {
  const p = path.join(home, 'tr.jsonl');
  fs.writeFileSync(p, turns.map((t) => JSON.stringify({ type: 'user', uuid: t, message: { role: 'user', content: 'prompt ' + t } })).join('\n') + '\n');
  return p;
}
function fail(home, command, error, extra) {
  return testHook(HOOK, Object.assign({
    hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command },
    error, session_id: 'sess-1', cwd: process.cwd(),
  }, extra || {}), { home });
}

test('expected exit 1: predicates are not failures', () => {
  const yes = [
    'grep -q foo file.txt',
    'cd /x; grep -rn foo src',
    'cat a | grep -c foo',
    'test -f /nope',
    '[ -d /nope ]',
    'diff a b',
    'diff a b && echo SAME',
    'test -f x && echo yes',
    'git diff --quiet',
    'git merge-base --is-ancestor HEAD origin/dev && echo ff',
    'command -v nosuchtool',
    'pgrep -f server',
    '/usr/bin/grep -n "a;b" f',
    'command grep -n foo f',
    'echo start\nls\ngrep -n foo f',
  ];
  for (const c of yes) assert.strictEqual(isExpectedNonzero(c, 'Exit code 1\n'), true, c);
});

test('expected exit 1: anything that could hide a real failure still nudges', () => {
  const no = [
    'npm test',
    'make && grep foo out',                    // make could be the one that failed
    'grep foo f && npm run deploy',            // deploy decides the status
    'grep foo f || exit 1',
    'grep foo f | tee out',                    // tee decides
    'set -e; grep foo f; true',
    'set -o pipefail; cat x | grep foo',
    'grep foo <<EOF\nbar\nEOF',                // heredoc
    'bash -c "grep foo f"',
    'eval "grep foo f"',
    'for f in *; do grep foo $f; done',
    'if grep -q foo f; then echo y; fi',
    '(grep foo f)',
    'grep foo f &',
    'cd /missing && grep foo f',               // cd could be the failing link
    'test -f "$(mktemp)"',                     // substitution decides
    '! grep foo f',
    'python3 check.py',
    '',
  ];
  for (const c of no) assert.strictEqual(isExpectedNonzero(c, 'Exit code 1\n'), false, JSON.stringify(c));
  // Real errors from the same verbs use other exit codes.
  assert.strictEqual(isExpectedNonzero('grep foo f', 'Exit code 2\ngrep: f: No such file'), false);
  assert.strictEqual(isExpectedNonzero('diff a b', 'Exit code 2\n'), false);
  // Unknown exit code (error text missing / different shape) -> never suppress.
  assert.strictEqual(isExpectedNonzero('grep foo f', ''), false);
  assert.strictEqual(isExpectedNonzero('grep foo f', undefined), false);
});

test('harness refusal detection', () => {
  assert.strictEqual(isHarnessRefusal('This agent is isolated in the worktree /x, but this command names git in a form too complex'), true);
  assert.strictEqual(isHarnessRefusal('This session is isolated in the worktree /x'), true);
  assert.strictEqual(isHarnessRefusal('Exit code 1\nThis agent is isolated in the worktree'), false);
});

test('hook: grep no-match is silent, real failure still nudges', () => {
  const h = makeHome();
  try {
    assert.strictEqual(ctx(fail(h.home, 'grep -q foo f', 'Exit code 1\n')), '');
    const r = testHook(HOOK, {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' },
      error: 'Exit code 1\nboom', session_id: 'sess-1', cwd: process.cwd(),
    }, { home: h.home, expectJson: true });
    assert.ok(ctx(r).includes('npm test'));
  } finally { h.cleanup(); }
});

test('hook: harness refusal is silent', () => {
  const h = makeHome();
  try {
    assert.strictEqual(ctx(fail(h.home, 'git foo $(x)', 'This agent is isolated in the worktree /w, but this command is too complex. Refusing to run it')), '');
  } finally { h.cleanup(); }
});

test('hook: once per turn, again after the next human prompt; injected messages are not turns', () => {
  const h = makeHome();
  try {
    const tp = transcript(h.home, ['t1']);
    const go = (cmd) => ctx(testHook(HOOK, {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: cmd },
      error: 'Exit code 1\nx', session_id: 'sess-turn', transcript_path: tp, cwd: process.cwd(),
    }, { home: h.home }));
    assert.ok(go('npm test').includes('npm test'), 'first failure in turn 1 nudges');
    assert.strictEqual(go('npm run build'), '', 'second failure in turn 1 is silent');
    fs.appendFileSync(tp, JSON.stringify({ type: 'user', uuid: 'n1', message: { role: 'user', content: '<task-notification>done</task-notification>' } }) + '\n');
    assert.strictEqual(go('npm run lint'), '', 'a task-notification is not a new turn');
    fs.appendFileSync(tp, JSON.stringify({ type: 'user', uuid: 'tr', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }) + '\n');
    assert.strictEqual(go('npm run lint'), '', 'a tool_result is not a new turn');
    fs.appendFileSync(tp, JSON.stringify({ type: 'user', uuid: 't2', message: { role: 'user', content: 'next prompt' } }) + '\n');
    assert.ok(go('npm test').includes('npm test'), 'next human prompt re-arms the nudge');
  } finally { h.cleanup(); }
});

test('hook: unreadable transcript fails OPEN (nudges every time)', () => {
  const h = makeHome();
  try {
    const go = () => ctx(testHook(HOOK, {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' },
      error: 'Exit code 1', session_id: 'sess-x', transcript_path: path.join(h.home, 'missing.jsonl'), cwd: process.cwd(),
    }, { home: h.home }));
    assert.ok(go().length > 0);
    assert.ok(go().length > 0);
  } finally { h.cleanup(); }
});

test('hook: a subagent (agent_id) gets its own first nudge', () => {
  const h = makeHome();
  try {
    const tp = transcript(h.home, ['t1']);
    const go = (agent) => ctx(testHook(HOOK, {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' },
      error: 'Exit code 1', session_id: 'sess-a', transcript_path: tp, agent_id: agent, cwd: process.cwd(),
    }, { home: h.home }));
    assert.ok(go('').length > 0);
    assert.strictEqual(go(''), '');
    assert.ok(go('agent-9').length > 0, 'subagent has not seen the reminder yet');
    assert.strictEqual(go('agent-9'), '');
  } finally { h.cleanup(); }
});

test('hook: guards.failureNudgeFilter off restores nudge-on-every-failure', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, {
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'grep -q foo f' },
      error: 'Exit code 1\n', session_id: 'sess-off', cwd: process.cwd(),
    }, { home: h.home, env: { ANTIHALL_FAILURE_NUDGE_FILTER: 'off' }, expectJson: true });
    assert.ok(ctx(r).length > 0);
  } finally { h.cleanup(); }
});

test('output-verify-guard: identical mixed result is shown once per turn', () => {
  const h = makeHome();
  try {
    const tp = transcript(h.home, ['t1']);
    const go = (env) => testHook('output-verify-guard.js', {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_response: { stdout: 'PASS a.test.js\nFAIL b.test.js\n8 passed, 2 failed' },
      session_id: 'sess-ov', transcript_path: tp, cwd: process.cwd(),
    }, { home: h.home, env: env || {} });
    assert.ok(ctx(go()).includes('output-verify-guard'));
    assert.strictEqual(ctx(go()), '', 'same signals again in the same turn: silent');
    assert.ok(ctx(go({ ANTIHALL_OUTPUT_VERIFY_ONCE_PER_TURN: 'off' })).length > 0, 'setting off restores every advisory');
    fs.appendFileSync(tp, JSON.stringify({ type: 'user', uuid: 't2', message: { role: 'user', content: 'again' } }) + '\n');
    assert.ok(ctx(go()).length > 0, 'new turn re-arms');
  } finally { h.cleanup(); }
});
