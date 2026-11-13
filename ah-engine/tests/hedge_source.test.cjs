// Exercise the actual engine and shipped plugin logic; AH_ENGINE_BIN can name a prebuilt frozen host.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const bin = process.env.AH_ENGINE_BIN || path.join(root, 'ah-engine/target/debug/ah-engine');
const assistant = (text, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const user = text => ({ type: 'user', message: { role: 'user', content: text } });
function run(check, records, reply, host = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg722-'));
  try {
    fs.mkdirSync(path.join(dir, '.anti-hall'));
    fs.writeFileSync(path.join(dir, '.anti-hall/settings.json'), JSON.stringify({ jev: { enabled: false } }));
    const tp = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(tp, records.map(JSON.stringify).join('\n') + '\n');
    const payload = { hook_event_name: check === 'merge-gate' ? 'PreToolUse' : 'Stop', session_id: 'mg722', cwd: dir,
      transcript_path: tp, tool_name: 'Bash', tool_input: { command: 'gh pr merge 5' } };
    if (reply !== undefined) payload.last_assistant_message = reply;
    if (host === 'codex') payload.host = 'codex';
    const args = check === 'merge-gate' ? ['hook', '--event', 'PreToolUse', '--host', host] : ['check', check];
    const out = spawnSync(bin, args, { cwd: dir, encoding: 'utf8', input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, HOME: dir, AH_ENGINE_DIR: path.join(dir, 'state'),
        AH_ENGINE_PLUGIN_ROOT: process.env.AH_TEST_PLUGIN_ROOT || path.join(root, 'plugins/anti-hall'), AH_ENGINE_DISPATCH_IN_PROCESS: '1',
        ANTIHALL_MERGE_GATE: '1', ANTIHALL_MERGE_GATE_CLEAR_STEP: '1', ANTIHALL_INGEST_DRY_RUN: '1' } });
    assert.ifError(out.error);
    assert.ok(out.status === 0 || out.status === 2, out.stderr);
    if (out.status === 2) return { decision: 'block', reason: out.stderr };
    const verdict = out.stdout.trim() ? JSON.parse(out.stdout) : { decision: 'allow' };
    assert.ok(!JSON.stringify(verdict).includes('script_error'), JSON.stringify(verdict));
    return verdict;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function blocked(v) { return JSON.stringify(v).includes('block') || JSON.stringify(v).includes('code":2'); }
for (const host of ['claude', 'codex']) {
  for (const [name, records] of [
    ['user protocol', [user('<system-reminder>VERIFY-FIRST: avoid first-pass.</system-reminder>'), assistant('Ready to merge.')]],
    ['assistant reminder', [assistant('<system-reminder>VERIFY-FIRST: avoid first-pass.</system-reminder>\nReady to merge.')]],
    ['meta assistant protocol', [assistant('VERIFY-FIRST: avoid first-pass.', { isMeta: true }), assistant('Ready to merge.')]],
    ['earlier tool block', [user('Ship it'), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'merge check: your last message says "first pass"' }] } }, assistant('Ready to merge.')]],
    ['quoted protocol', [assistant('> VERIFY-FIRST: first-pass is a hedge example.')]],
    ['inline quoted protocol', [assistant('"first-pass"')]],
    ['open fenced protocol', [assistant('```text\nVERIFY-FIRST: first-pass is a hedge example.')]],
    ['fenced protocol', [assistant('```text\nVERIFY-FIRST: first-pass is a hedge example.\n```')]],
    ['repeated reminder block', [assistant('<system-reminder>merge check: the merge is paused: your last message says \"first pass\" and no real user prompt has resolved it.</system-reminder>'), assistant('Ready to merge.')]],
    ['unquoted earlier block', [assistant('merge check: first pass has not been resolved.'), assistant('Ready to merge.')]],
    ['synthetic origin', [assistant('first pass', { origin: { kind: 'hook' } }), assistant('Ready to merge.')]],
    ['echoed block', [assistant('merge check: the merge is paused: your last message says "first pass" and no real user prompt has resolved it.')]],
  ]) test(`merge ${host} ignores ${name}`, () => assert.equal(blocked(run('merge-gate', records, undefined, host)), false));
  test(`merge ${host} blocks own last hedge`, () => assert.equal(blocked(run('merge-gate', [assistant('This is a first pass.')], undefined, host)), true));
  test(`merge ${host} keeps own hedge beside reminder`, () => assert.equal(blocked(run('merge-gate', [assistant('<system-reminder>Protocol.</system-reminder>\nThis is a first pass.')], undefined, host)), true));
}
for (const [check, phrase] of [['speculation-guard', 'It probably works.'], ['claim-evidence-guard', 'Tests pass.']]) {
  for (const [name, reply] of [
    ['reminder', `<system-reminder>${phrase}</system-reminder>\nI am checking the result.`],
    ['quoted protocol', `> ${phrase}`],
    ['inline quoted protocol example', `VERIFY-FIRST rule 4 quotes "${phrase}" as a hedge example.`],
    ['open fenced protocol', `\`\`\`text\n${phrase}`],
    ['fenced protocol', `\`\`\`text\n${phrase}\n\`\`\``],
  ]) test(`${check} ignores ${name}`, () => assert.equal(blocked(run(check, [user('Check it'), assistant(reply)], reply)), false));
  test(`${check} ignores echoed guard feedback`, () => {
    const reply = `claim check: ${phrase}`;
    assert.equal(blocked(run(check, [user('Check it'), assistant(reply)], reply)), false);
  });
  test(`${check} blocks own assertion`, () => assert.equal(blocked(run(check, [user('Check it'), assistant(phrase)], phrase)), true));
  test(`${check} preserves own assertion beside reminder`, () => {
    const reply = `<system-reminder>Protocol.</system-reminder>\n${phrase}`;
    assert.equal(blocked(run(check, [user('Check it'), assistant(reply)], reply)), true);
  });
}

test('speculation transcript fallback ignores synthetic assistant context', () => {
  assert.equal(blocked(run('speculation-guard', [user('Check it'), assistant('I am checking.'), assistant('It probably works.', { isMeta: true })])), false);
});
test('merge retains a genuine unresolved earlier hedge', () => {
  assert.equal(blocked(run('merge-gate', [assistant('This is a first pass.'), assistant('Ready to merge.') ])), true);
});
test('merge allows a real user resolution after an own hedge', () => {
  assert.equal(blocked(run('merge-gate', [assistant('This is a first pass.'), user('owner approved') ])), false);
});

for (const [check, phrase] of [['speculation-guard', 'It probably works.'], ['claim-evidence-guard', 'Tests pass.'], ['merge-gate', 'This is a first pass.']]) {
  test(`${check} keeps own prose after a closed protocol fence`, () => {
    const reply = `\`\`\`text\nProtocol.\n\`\`\`\n${phrase}`;
    assert.equal(blocked(run(check, [user('Check it'), assistant(reply)], reply)), true);
  });
}
