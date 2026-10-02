'use strict';
// ask-guard (PreToolUse AskUserQuestion — optional, default off). Setting
// guards.noBlockingQuestions: off | advise | block. Covers the three modes, the
// DESTRUCTIVE:/CREDENTIAL: marker (header and question text, start-anchored,
// case-sensitive, first question only), fail-open, the skip override, the DevSwarm
// child sentence, the hooks.json registration and the schema/docs parity.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'ask-guard.js';
const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'anti-hall');

function payload(questions) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions },
    session_id: 't',
    cwd: process.cwd(),
  };
}
const q = (question, header, extra) => Object.assign({
  question, header,
  options: [{ label: 'Option A (Recommended)', description: 'a' }, { label: 'Option B', description: 'b' }],
  multiSelect: false,
}, extra || {});

function homeWith(mode) {
  const h = makeHome();
  if (mode) fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify({ guards: { noBlockingQuestions: mode } }));
  return h;
}
function run(h, pl, env) { return testHook(HOOK, pl, { home: h.home, env: env || {} }); }

const ADVISE = "Standing rule: do not hold work on a question. Take the recommended option, say which you took, and continue; list anything destructive or irreversible as a non-blocking 'needs your OK' line.";
const BLOCK_START = 'Blocked by guards.noBlockingQuestions: decide the recommended option yourself, state it in your reply, and continue.';
const CHILD_RE = /DevSwarm child workspace.*devswarm\.js send --to-primary --question/;

function assertBlocked(r) {
  assert.strictEqual(r.status, 2, `expected exit 2; stdout=${r.stdout}`);
  assert.strictEqual(r.json.decision, 'block');
  assert.ok(r.json.reason.startsWith(BLOCK_START), r.json.reason);
  assert.ok(r.json.reason.includes('re-issue it with the question header starting with DESTRUCTIVE: — or CREDENTIAL: if it needs a secret only the user can supply.'));
}
function assertSilent(r) {
  assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '');
}

test('default (setting unset) and explicit off: no output', () => {
  const h = homeWith(null);
  try {
    assertSilent(run(h, payload([q('Which one?', 'Pick')])));
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify({ guards: { noBlockingQuestions: 'off' } }));
    assertSilent(run(h, payload([q('Which one?', 'Pick')])));
  } finally { h.cleanup(); }
});

test('advise: allows the call (exit 0, no decision) and adds the standing-rule context', () => {
  const h = homeWith('advise');
  try {
    const r = run(h, payload([q('Which one?', 'Pick')]));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(r.json.hookSpecificOutput.additionalContext, ADVISE);
    assert.ok(!('decision' in r.json) && !('permissionDecision' in r.json.hookSpecificOutput), 'never emits an allow/deny decision');
  } finally { h.cleanup(); }
});

test('block: blocks with decision:block + exit 2 and the exact message', () => {
  const h = homeWith('block');
  try { assertBlocked(run(h, payload([q('Which one?', 'Pick')]))); } finally { h.cleanup(); }
});

test('env ANTIHALL_NO_BLOCKING_QUESTIONS selects the mode', () => {
  const h = homeWith(null);
  try {
    assertBlocked(run(h, payload([q('Which one?', 'Pick')]), { ANTIHALL_NO_BLOCKING_QUESTIONS: 'block' }));
    assert.ok(run(h, payload([q('Which one?', 'Pick')]), { ANTIHALL_NO_BLOCKING_QUESTIONS: 'advise' }).json.hookSpecificOutput);
  } finally { h.cleanup(); }
});

test('settings are home-only: a repository file cannot turn the guard on', () => {
  const h = homeWith(null);
  const proj = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ask-guard-proj-'));
  try {
    fs.mkdirSync(path.join(proj, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.anti-hall', 'settings.json'), JSON.stringify({ guards: { noBlockingQuestions: 'block' } }));
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ guards: { noBlockingQuestions: 'block' } }));
    const pl = payload([q('Which one?', 'Pick')]);
    pl.cwd = proj;
    assertSilent(run(h, pl));
  } finally { h.cleanup(); fs.rmSync(proj, { recursive: true, force: true }); }
});

test('block: DESTRUCTIVE: / CREDENTIAL: in the header is allowed and logged', () => {
  for (const marker of ['DESTRUCTIVE:', 'CREDENTIAL:']) {
    const h = homeWith('block');
    try {
      assertSilent(run(h, payload([q('Drop the table?', marker + ' drop')])));
      const log = fs.readFileSync(path.join(h.home, '.anti-hall', 'logs', 'ask-guard.ndjson'), 'utf8').trim().split('\n');
      assert.strictEqual(log.length, 1);
      const row = JSON.parse(log[0]);
      assert.strictEqual(row.event, 'marker-allowed');
      assert.strictEqual(row.marker, marker.slice(0, -1));
    } finally { h.cleanup(); }
  }
});

test('block: the marker at the start of the question text is allowed (header is only ~12 chars)', () => {
  for (const marker of ['DESTRUCTIVE:', 'CREDENTIAL:']) {
    const h = homeWith('block');
    try {
      assertSilent(run(h, payload([q('  ' + marker + ' may I delete the old bucket?', 'Cleanup')])));
      assertSilent(run(h, payload([{ question: marker + ' paste the token', options: [] }]))); // no header field at all
    } finally { h.cleanup(); }
  }
});

test('block: a marker NOT at the start, lower-case, or without the colon is not accepted', () => {
  const h = homeWith('block');
  try {
    assertBlocked(run(h, payload([q('Is this DESTRUCTIVE: really?', 'Pick')])));
    assertBlocked(run(h, payload([q('Which one?', 'Re: DESTRUCTIVE: x')])));
    assertBlocked(run(h, payload([q('Which one?', 'destructive: x')])));
    assertBlocked(run(h, payload([q('Which one?', 'CREDENTIAL x')])));
    assertBlocked(run(h, payload([q('Which one?', 'DESTRUCTIVE')])));
  } finally { h.cleanup(); }
});

test('block: only the FIRST question counts', () => {
  const h = homeWith('block');
  try {
    assertBlocked(run(h, payload([q('First?', 'Pick'), q('Second?', 'DESTRUCTIVE: x')])));
    assertSilent(run(h, payload([q('First?', 'DESTRUCTIVE: x'), q('Second?', 'Pick')])));
  } finally { h.cleanup(); }
});

test('malformed or empty payloads fail open in every mode (exit 0, no output)', () => {
  for (const mode of ['advise', 'block']) {
    const h = homeWith(mode);
    try {
      for (const raw of ['', '{bad', 'null', '[]', '"x"']) assertSilent(testHookRaw(HOOK, raw, { home: h.home }));
    } finally { h.cleanup(); }
  }
  const h = homeWith('block');
  try {
    // block mode with a payload that has no usable questions blocks (no marker), but never crashes
    for (const ti of [undefined, null, {}, { questions: 'x' }, { questions: [] }, { questions: [null] }]) {
      const r = run(h, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: ti });
      assert.ok(r.status === 2 || r.status === 0, 'status ' + r.status);
      assert.strictEqual(r.stderr, '');
    }
  } finally { h.cleanup(); }
});

test('unreadable settings (corrupt file, or a directory) fail open to off', () => {
  const h = homeWith(null);
  try {
    const f = path.join(h.home, '.anti-hall', 'settings.json');
    fs.writeFileSync(f, '{not json');
    assertSilent(run(h, payload([q('Which one?', 'Pick')])));
    fs.rmSync(f);
    fs.mkdirSync(f);
    assertSilent(run(h, payload([q('Which one?', 'Pick')])));
  } finally { h.cleanup(); }
});

test('an unrecognized tool_name is ignored', () => {
  const h = homeWith('block');
  try {
    const pl = payload([q('Which one?', 'Pick')]);
    pl.tool_name = 'Bash';
    assertSilent(run(h, pl));
  } finally { h.cleanup(); }
});

test('skip override: ask-guard (and a broad all) silence it', () => {
  for (const key of ['ask-guard', 'all']) {
    const h = homeWith('block');
    try {
      h.writeSkip({ [key]: Date.now() + 60000 });
      assertSilent(run(h, payload([q('Which one?', 'Pick')])));
      h.writeSkip({ [key]: Date.now() - 1000 }); // expired -> active again
      assertBlocked(run(h, payload([q('Which one?', 'Pick')])));
    } finally { h.cleanup(); }
  }
});

test('DevSwarm child sentence: present for a child workspace (advise and block), absent otherwise', () => {
  const child = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' };
  const primary = { DEVSWARM_REPO_ID: 'repo-1' };
  let h = homeWith('advise');
  try {
    assert.match(run(h, payload([q('x?', 'Pick')]), child).json.hookSpecificOutput.additionalContext, CHILD_RE);
    const p = run(h, payload([q('x?', 'Pick')]), primary).json.hookSpecificOutput.additionalContext;
    assert.strictEqual(p, ADVISE);
    assert.ok(!CHILD_RE.test(run(h, payload([q('x?', 'Pick')])).json.hookSpecificOutput.additionalContext));
  } finally { h.cleanup(); }
  h = homeWith('block');
  try {
    assert.match(run(h, payload([q('x?', 'Pick')]), child).json.reason, CHILD_RE);
    assert.ok(!CHILD_RE.test(run(h, payload([q('x?', 'Pick')]), primary).json.reason));
  } finally { h.cleanup(); }
});

test('hooks.json registers the guard under PreToolUse with matcher AskUserQuestion (Claude only)', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const groups = claude.hooks.PreToolUse.filter((g) => g.hooks.some((x) => /ask-guard\.js/.test(x.command)));
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].matcher, 'AskUserQuestion');
  assert.strictEqual(groups[0].hooks.length, 1);
  assert.deepStrictEqual(groups[0].hooks[0], {
    type: 'command',
    command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/ask-guard.js"',
    timeout: 10,
  });
  assert.ok(!/hooks\/ask-guard\.js/.test(fs.readFileSync(path.join(PLUGIN, 'codex', 'hooks', 'hooks.json'), 'utf8')), 'no Codex registration');
});

test('schema / manifest / docs parity for guards.noBlockingQuestions', () => {
  const schema = require(path.join(PLUGIN, 'hooks', 'lib', 'settings-schema.js'));
  const e = schema.findSetting('guards', 'noBlockingQuestions');
  assert.ok(e, 'schema entry exists');
  assert.strictEqual(e.type, 'enum');
  assert.deepStrictEqual(e.values, ['off', 'advise', 'block']);
  assert.strictEqual(e.default, 'off');
  assert.strictEqual(e.env, 'ANTIHALL_NO_BLOCKING_QUESTIONS');
  assert.strictEqual(e.pluginOption, 'guards_no_blocking_questions');
  assert.ok(!e.homeOnly, 'env and /config option must stay usable');
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(manifest.userConfig.guards_no_blocking_questions.default, 'off');
  assert.match(manifest.userConfig.guards_no_blocking_questions.description, /off \| advise \| block/);
  for (const f of ['docs/GUIDE.md', 'llms.txt']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(t.includes('guards.noBlockingQuestions'), f);
    assert.ok(t.includes('ANTIHALL_NO_BLOCKING_QUESTIONS'), f);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'docs', 'GUIDE.md'), 'utf8'), /in block mode those flows must use the `DESTRUCTIVE:`\/`CREDENTIAL:` marker/);
});
