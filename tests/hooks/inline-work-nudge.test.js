'use strict';
// devswarm.inlineWorkNudge: advisory note from edit-guard.js (PreToolUse edit family)
// for a DevSwarm PRIMARY that has made more than devswarm.inlineWorkNudgeThreshold
// main-thread edits while actionable tasks are pending and it has proven zero live
// children. Once per session; never blocks; silent when liveness is unknown.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, editPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'edit-guard.js';
const PRIMARY = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-x' };
const CHILD = Object.assign({}, PRIMARY, { DEVSWARM_SOURCE_BRANCH: 'feature/y' });
const NOTE_RE = /^DEVSWARM PRIMARY: you have made several direct file edits/;
const ALLOWED = '.anti-hall/plans/p.md'; // allowlisted: edit-guard lets the coordinator write it

function cwdDir(doctrine) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-iwn-'));
  if (doctrine) fs.writeFileSync(path.join(d, 'CLAUDE.md'), '- NO WORKSPACES FOR REAL WORK\n');
  return d;
}
const pendingTask = [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'build the thing', description: 'build the thing' } }] } },
  { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'tc1', type: 'tool_result', content: 'Task #1 created successfully: build the thing' }] } },
];
function setup(opts) {
  const o = opts || {};
  const h = makeHome();
  if (o.settings) fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify(o.settings));
  const tp = h.writeTranscript(o.noTasks ? [] : pendingTask);
  return { h, tp, cwd: cwdDir(o.doctrine) };
}
function edit(s, env, sid) {
  const p = editPayload('Edit', { filePath: ALLOWED, cwd: s.cwd });
  p.transcript_path = s.tp;
  p.session_id = sid || 'sess-1';
  return testHook(HOOK, p, { home: s.h.home, env });
}
const note = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const THRESH = { devswarm: { inlineWorkNudgeThreshold: 2 } };

test('fires on the call after the threshold, not below it, and only once', () => {
  const s = setup({ settings: THRESH });
  try {
    assert.strictEqual(note(edit(s, PRIMARY)), '');      // 1
    assert.strictEqual(note(edit(s, PRIMARY)), '');      // 2 (== threshold: not "more than")
    const r3 = edit(s, PRIMARY);                         // 3 > 2
    assert.strictEqual(r3.status, 0);
    assert.match(note(r3), NOTE_RE);
    assert.ok(!('decision' in r3.json), 'advisory only');
    assert.ok(note(r3).length < 450, 'size ' + note(r3).length);
    assert.strictEqual(note(edit(s, PRIMARY)), '');      // never twice
    assert.strictEqual(note(edit(s, PRIMARY)), '');
  } finally { s.h.cleanup(); }
});

test('default threshold is 5: silent for 5 calls, fires on the 6th', () => {
  const s = setup();
  try {
    for (let i = 1; i <= 5; i++) assert.strictEqual(note(edit(s, PRIMARY)), '', 'call ' + i);
    assert.match(note(edit(s, PRIMARY)), NOTE_RE);
  } finally { s.h.cleanup(); }
});

test('a separate session has its own count', () => {
  const s = setup({ settings: THRESH });
  try {
    for (let i = 0; i < 3; i++) edit(s, PRIMARY, 'sess-A');
    assert.strictEqual(note(edit(s, PRIMARY, 'sess-B')), '');
  } finally { s.h.cleanup(); }
});

test('silent in a no-workspace repo', () => {
  const s = setup({ settings: THRESH, doctrine: true });
  try { for (let i = 0; i < 5; i++) assert.strictEqual(note(edit(s, PRIMARY)), ''); } finally { s.h.cleanup(); }
});

test('silent for a child workspace session', () => {
  const s = setup({ settings: THRESH });
  try { for (let i = 0; i < 5; i++) assert.strictEqual(note(edit(s, CHILD)), ''); } finally { s.h.cleanup(); }
});

test('silent outside DevSwarm', () => {
  const s = setup({ settings: THRESH });
  try { for (let i = 0; i < 5; i++) assert.strictEqual(note(edit(s, { CLAUDE_CODE_ENTRYPOINT: 'cli' })), ''); } finally { s.h.cleanup(); }
});

test('silent with no pending actionable task', () => {
  const s = setup({ settings: THRESH, noTasks: true });
  try { for (let i = 0; i < 5; i++) assert.strictEqual(note(edit(s, PRIMARY)), ''); } finally { s.h.cleanup(); }
});

test('silent when liveness cannot be determined (registered workspaces, cwd not resolvable to a project)', () => {
  const s = setup({ settings: THRESH });
  try {
    const dir = path.join(s.h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'w1.json'), JSON.stringify({ id: 'w1', worktreePath: path.join(s.h.home, 'wt1'), sessionId: 'sx' }));
    for (let i = 0; i < 5; i++) assert.strictEqual(note(edit(s, PRIMARY)), '');
  } finally { s.h.cleanup(); }
});

test('setting off -> silent', () => {
  const s = setup({ settings: { devswarm: { inlineWorkNudge: false, inlineWorkNudgeThreshold: 2 } } });
  try { for (let i = 0; i < 5; i++) assert.strictEqual(note(edit(s, PRIMARY)), ''); } finally { s.h.cleanup(); }
});

test('a blocked call prints only its block JSON and does not use up the note', () => {
  const s = setup({ settings: { devswarm: { inlineWorkNudgeThreshold: 1 } } });
  try {
    const p = editPayload('Edit', { filePath: 'src/app.js', cwd: s.cwd });
    p.transcript_path = s.tp;
    p.session_id = 'sess-1';
    const r = testHook(HOOK, p, { home: s.h.home, env: PRIMARY });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.json.decision, 'block');
    assert.ok(!/several direct file edits/.test(r.stdout));
    assert.match(note(edit(s, PRIMARY)), NOTE_RE); // 2nd call > 1, still unused
  } finally { s.h.cleanup(); }
});

test('schema / manifest parity for the inline-work settings', () => {
  const plugin = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  const schema = require(path.join(plugin, 'hooks', 'lib', 'settings-schema.js'));
  const m = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  const a = schema.findSetting('devswarm', 'inlineWorkNudge');
  const b = schema.findSetting('devswarm', 'inlineWorkNudgeThreshold');
  assert.deepStrictEqual([a.default, a.env], [true, 'ANTIHALL_DEVSWARM_INLINE_WORK_NUDGE']);
  assert.deepStrictEqual([b.default, b.env], [5, 'ANTIHALL_DEVSWARM_INLINE_WORK_NUDGE_THRESHOLD']);
  assert.strictEqual(m.userConfig[a.pluginOption].default, true);
  assert.strictEqual(m.userConfig[b.pluginOption].default, 5);
});
