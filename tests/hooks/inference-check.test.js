'use strict';
// Unsupported-inference coverage: lib/inference-check.js (deterministic, behind
// guards.inferenceCheck, default off) wired into speculation-guard, and the
// speculation-judge `cli` backend (jev.judgeBackend) with a fake `claude` on
// PATH. No network, no real CLI, isolated HOME.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const bench = require('../../eval/inference-bench.js');
const ic = require('../../plugins/anti-hall/hooks/lib/inference-check.js');
const jc = require('../../plugins/anti-hall/hooks/lib/judge-core.js');

const CLAIM = 'The crash is caused by the cache race.';

function user(text) { return { type: 'user', message: { role: 'user', content: text } }; }
function toolCall(id, name, input) { return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }; }
function toolResult(id, out) { return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] } }; }

function guard(h, lines, reply, env) {
  const tp = h.writeTranscript(lines);
  return testHook('speculation-guard.js',
    { hook_event_name: 'Stop', transcript_path: tp, session_id: 'inf', last_assistant_message: reply },
    { home: h.home, env: Object.assign({ ANTIHALL_JEV: '0' }, env || {}) });
}
const blocked = (r) => !!(r.json && r.json.decision === 'block');
const ON = { ANTIHALL_INFERENCE_CHECK: 'on' };

// ---- corpus gate -------------------------------------------------------------
test('eval corpus: 84 labelled cases, balanced, fixed split', () => {
  assert.strictEqual(bench.CASES.length, 84);
  assert.strictEqual(bench.CASES.filter((c) => c.label === 'pos').length, 42);
});

for (const shape of ['claude', 'codex']) {
  test('detector on the eval corpus (' + shape + ' transcripts): precision >= 0.9 and recall >= 0.9', () => {
    const rows = bench.CASES.map((c) => ({
      label: c.label,
      flagged: !!ic.findUnsupportedClaim(require('../../plugins/anti-hall/hooks/lib/quote-mask.js').maskQuotedText(c.reply), bench.transcriptLines(c, shape), c.reply),
    }));
    const s = bench.score(rows);
    assert.ok(s.precision >= 0.9, 'precision ' + s.precision);
    assert.ok(s.recall >= 0.9, 'recall ' + s.recall);
  });
}

// ---- lib units ---------------------------------------------------------------
test('findCausalClaims: skips questions, conditionals, plans and first-person rationale', () => {
  assert.strictEqual(ic.findCausalClaims('Is the crash caused by the cache race?').length, 0);
  assert.strictEqual(ic.findCausalClaims('If the token expired, the job would fail because auth breaks.').length, 0);
  assert.strictEqual(ic.findCausalClaims('I used a Map because lookups are constant time.').length, 0);
  assert.strictEqual(ic.findCausalClaims('Plan: retry three times because transient failures are common.').length, 0);
  assert.strictEqual(ic.findCausalClaims(CLAIM).length, 1);
  assert.strictEqual(ic.findCausalClaims("It can't read the config because the file is root-owned.").length, 1);
});

test('findUnsupportedClaim: label forms, "comes down to", "is what", code-span causes, trailing modal clauses', () => {
  const { maskQuotedText } = require('../../plugins/anti-hall/hooks/lib/quote-mask.js');
  const lines = [JSON.stringify(user('Why does it crash?'))];
  const flags = (t) => !!ic.findUnsupportedClaim(maskQuotedText(t), lines, t);
  for (const t of [
    'Root cause: the cache race.',
    'The worker crashes. Cause: the cache race.',
    'The crash comes down to the cache race.',
    'The cache race is what crashes the worker.',
    'The crash is caused by the `cacheRace` flag.',
    'The crash is caused by the cache race, which I could fix next.',
  ]) assert.ok(flags(t), 'should flag: ' + t);
  for (const t of [
    'Root cause: unknown yet.',
    'You wrote "the crash is caused by the cache race", so I will check.',
    'Is the crash caused by the cache race?',
  ]) assert.ok(!flags(t), 'should not flag: ' + t);
  // A code-span identifier the evidence shows supports the claim.
  const ev = [lines[0], JSON.stringify(toolCall('g', 'Grep', { pattern: 'cacheRace' })), JSON.stringify(toolResult('g', 'src/w.js:3: if (cacheRace) throw'))];
  const t = 'The crash is caused by the `cacheRace` flag.';
  assert.ok(!ic.findUnsupportedClaim(maskQuotedText(t), ev, t));
});

test('collectEvidence: tool results and observation inputs count; authored Write content does not', () => {
  const lines = [
    toolCall('a', 'Write', { file_path: '/r/notes.md', content: 'crash caused by cache race' }),
    toolResult('a', 'File written'),
    toolCall('b', 'Bash', { command: 'kubectl get deploy consumer' }),
    toolResult('b', 'replicas: 1'),
  ].map((o) => JSON.stringify(o));
  const ev = ic.collectEvidence(lines).join('\n');
  assert.ok(ev.includes('kubectl get deploy consumer') && ev.includes('replicas: 1'));
  assert.ok(!ev.includes('cache race'), 'Write input must not be evidence');
});

test('lastUserPrompt: newest typed prompt; tool results and notifications are skipped', () => {
  const lines = [user('first'), user('Why does it crash?'), toolResult('x', 'out'), user('<task-notification>done</task-notification>')].map((o) => JSON.stringify(o));
  assert.strictEqual(ic.lastUserPrompt(lines), 'Why does it crash?');
});

// ---- speculation-guard wiring ----------------------------------------------------
test('guard default (inferenceCheck off): unsupported confident cause is allowed, as before', () => {
  const h = makeHome();
  try { assert.ok(!blocked(guard(h, [user('Why does it crash?')], CLAIM))); } finally { h.cleanup(); }
});

test('guard inferenceCheck on: unsupported confident cause blocks once, in the shared shape', () => {
  const h = makeHome();
  try {
    const r = guard(h, [user('Why does it crash?')], CLAIM, ON);
    assert.ok(blocked(r), r.stdout);
    assert.match(r.json.reason, /^⛔ anti-hall · speculation-guard: your reply states a cause as fact \('The crash is caused by the cache race\.'\)/);
    assert.match(r.json.reason, /\nWhy: .+\nDo instead: /);
    // Same message again -> loop-safe allow.
    assert.ok(!blocked(guard(h, [user('Why does it crash?')], CLAIM, ON)));
  } finally { h.cleanup(); }
});

test('guard inferenceCheck on: a tool result that mentions the cause allows the claim', () => {
  const h = makeHome();
  try {
    const lines = [user('Why does it crash?'), toolCall('t1', 'Bash', { command: 'node worker.js' }), toolResult('t1', 'Error: cache race detected between loader threads')];
    assert.ok(!blocked(guard(h, lines, CLAIM, ON)));
  } finally { h.cleanup(); }
});

test('guard inferenceCheck on: Codex rollout evidence allows the claim', () => {
  const h = makeHome();
  try {
    const lines = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'Why does it crash?' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"node worker.js"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Error: cache race detected' } },
    ];
    assert.ok(!blocked(guard(h, lines, CLAIM, ON)));
    assert.ok(blocked(guard(h, [lines[0]], CLAIM, ON)));
  } finally { h.cleanup(); }
});

test('guard inferenceCheck on: an acknowledged hedge no longer hides a separate unsupported cause', () => {
  const h = makeHome();
  try {
    // 'should be' is a hedge; 'running' is an acknowledgment, so the hedge path allows.
    const reply = 'The deploy should be done; the tests are running now. The outage was caused by the DNS resolver timeout.';
    assert.ok(!blocked(guard(h, [user('status?')], reply)), 'off: allowed as before');
    assert.ok(blocked(guard(h, [user('status?')], reply, ON)), 'on: the unsupported cause blocks');
  } finally { h.cleanup(); }
});

test('guard inferenceCheck on: explicit unverified flag, quoted claim, and plans are allowed', () => {
  const h = makeHome();
  try {
    for (const reply of [
      'Unverified: the crash is caused by the cache race. I will run the worker to check.',
      'You wrote "the crash is caused by the cache race", so I will reproduce it first.',
      'Next step: check whether the crash is caused by the cache race.',
    ]) assert.ok(!blocked(guard(h, [user('Why does it crash?')], reply, ON)), reply);
  } finally { h.cleanup(); }
});

test('guard inferenceCheck on: skip.json for speculation-guard still wins', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'speculation-guard': Date.now() + 600000 });
    assert.ok(!blocked(guard(h, [user('Why does it crash?')], CLAIM, ON)));
  } finally { h.cleanup(); }
});

// ---- judge-core --------------------------------------------------------------
test('buildJudgeInput: user request, evidence (newest kept), message; secrets scrubbed', () => {
  const secret = 'sk-' + 'ant-api03-' + 'A'.repeat(40);
  const input = jc.buildJudgeInput('The cause is X.', ['old', 'token=' + secret + ' cache race'], 'Why?');
  assert.match(input, /^USER REQUEST:\nWhy\?\n\nTOOL EVIDENCE \(most recent last\):\n\[1\] old\n\[2\] /);
  assert.ok(input.includes('cache race') && !input.includes(secret));
  assert.match(input, /MESSAGE to evaluate:\n\nThe cause is X\.$/);
});

test('cliArgs: the judge child has no tools, no MCP, no settings files and no hooks', () => {
  const a = jc.cliArgs('claude-haiku-4-5');
  const at = (f) => a[a.indexOf(f) + 1];
  assert.strictEqual(at('--tools'), '');
  assert.strictEqual(at('--setting-sources'), '');
  assert.deepStrictEqual(JSON.parse(at('--settings')), { disableAllHooks: true });
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--no-session-persistence') && a.includes('-p'));
});

test('parseDecision: fenced/embedded JSON parsed, anything else null', () => {
  assert.deepStrictEqual(jc.parseDecision('```json\n{"decision":"allow"}\n```'), { decision: 'allow' });
  assert.strictEqual(jc.parseDecision('{"decision":"maybe"}'), null);
  assert.strictEqual(jc.parseDecision('no json'), null);
});

// ---- speculation-judge cli backend (fake `claude` on PATH) --------------------
function fakeClaude(dir, behaviour) {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/usr/bin/env node\n' +
    "const fs = require('fs');\n" +
    "let input = ''; process.stdin.on('data', (d) => { input += d; }).on('end', () => {\n" +
    "  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), child: process.env.ANTIHALL_JUDGE_CHILD, input }));\n" +
    '  ' + behaviour + '\n' +
    '});\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function judgeCli(h, behaviour, extraEnv) {
  const bindir = fs.mkdtempSync(path.join(h.home, 'bin-'));
  fakeClaude(bindir, behaviour);
  const log = path.join(h.home, 'fake-claude.json');
  const tp = h.writeTranscript([user('Why does the worker crash?')]);
  const r = testHook('speculation-judge.js',
    { hook_event_name: 'Stop', transcript_path: tp, session_id: 'jc', last_assistant_message: CLAIM },
    { home: h.home, env: Object.assign({ ANTIHALL_JEV: '0', ANTIHALL_SEMANTIC_JUDGE: '1', ANTIHALL_JUDGE_BACKEND: 'cli', FAKE_CLAUDE_LOG: log, PATH: bindir + path.delimiter + process.env.PATH }, extraEnv || {}) });
  let call = null;
  try { call = JSON.parse(fs.readFileSync(log, 'utf8')); } catch (_) { /* not called */ }
  return { r, call };
}
const SAY = (obj) => "process.stdout.write(JSON.stringify({ is_error: false, result: '" + JSON.stringify(obj).replace(/'/g, "\\'") + "' }));";

test('judge cli backend: block answer -> block in the shared shape; child is isolated and marked', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    const { r, call } = judgeCli(h, SAY({ decision: 'block', claim: 'the cache race causes the crash' }));
    assert.ok(blocked(r), r.stdout);
    assert.match(r.json.reason, /^⛔ anti-hall · speculation-judge: your reply states 'the cache race causes the crash' as fact/);
    assert.strictEqual(call.child, '1');
    assert.ok(call.argv.includes('--strict-mcp-config'));
    assert.match(call.input, /USER REQUEST:\nWhy does the worker crash\?/);
  } finally { h.cleanup(); }
});

test('judge cli backend: allow answer, non-zero exit, or garbage -> no block (fail-open)', { skip: process.platform === 'win32' }, () => {
  for (const b of [SAY({ decision: 'allow' }), 'process.exit(3);', "process.stdout.write('not json');"]) {
    const h = makeHome();
    try { assert.ok(!blocked(judgeCli(h, b).r), b); } finally { h.cleanup(); }
  }
});

test('judge cli backend: missing claude binary -> no block', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([user('Why?')]);
    const r = testHook('speculation-judge.js',
      { hook_event_name: 'Stop', transcript_path: tp, session_id: 'jm', last_assistant_message: CLAIM },
      { home: h.home, env: { ANTIHALL_JEV: '0', ANTIHALL_SEMANTIC_JUDGE: '1', ANTIHALL_JUDGE_BACKEND: 'cli', PATH: path.join(os.tmpdir(), 'no-such-bin-dir') } });
    assert.strictEqual(r.status, 0);
    assert.ok(!blocked(r));
  } finally { h.cleanup(); }
});

test('judge: ANTIHALL_JUDGE_CHILD=1 exits before any call (no recursion)', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    const { r, call } = judgeCli(h, SAY({ decision: 'block', claim: 'x' }), { ANTIHALL_JUDGE_CHILD: '1' });
    assert.ok(!blocked(r));
    assert.strictEqual(call, null, 'the CLI must not be spawned');
  } finally { h.cleanup(); }
});

test('judge auto backend with no key uses the CLI; api backend with no key calls nothing', { skip: process.platform === 'win32' }, () => {
  let h = makeHome();
  try {
    const { r, call } = judgeCli(h, SAY({ decision: 'block', claim: 'x' }), { ANTIHALL_JUDGE_BACKEND: 'auto' });
    assert.ok(blocked(r) && call);
  } finally { h.cleanup(); }
  h = makeHome();
  try {
    const { r, call } = judgeCli(h, SAY({ decision: 'block', claim: 'x' }), { ANTIHALL_JUDGE_BACKEND: 'api' });
    assert.ok(!blocked(r));
    assert.strictEqual(call, null);
  } finally { h.cleanup(); }
});
