'use strict';
// Shape coverage for the remaining converted families: Stop-hook guards
// (tasklist-guard, task-guard, speculation-guard), advisories/nudges
// (model-routing, task-tracker, auto-handover builders, limit/scan notes) and
// the doctor/update status lines. All share lib/block-message.js's shape.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { assertShape } = require('../helpers/block-shape.js');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const edit = (i) => ({
  type: 'assistant', timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'toolu_e' + i, input: { file_path: '/x/f' + i } }] },
});
const todoWrite = (todos) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', id: 'toolu_tw', input: { todos } }] },
});
const stop = (tp, cwd) => ({ hook_event_name: 'Stop', transcript_path: tp, session_id: 't', cwd });
const ctx = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

test('tasklist-guard Stop block has the shared shape (Claude) and neutral task wording on Codex', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([1, 2, 3, 4].map(edit));
    const r = testHook('tasklist-guard.js', stop(tp, h.home), { home: h.home });
    assert.strictEqual(r.json && r.json.decision, 'block', r.stdout);
    const lines = assertShape(r.json.reason, 'tasklist-guard', 'tasklist-guard', { requireWhy: true });
    assert.match(r.json.reason, /TaskCreate\/TaskUpdate/);
    assert.ok(lines.length <= 6);
    const h2 = makeHome();
    try {
      const tp2 = h2.writeTranscript([1, 2, 3, 4].map(edit));
      const cx = testHook('tasklist-guard.js', Object.assign(stop(tp2, h2.home), { turn_id: 't1', model: 'gpt-5.6-sol' }), { home: h2.home, env: {} });
      assert.strictEqual(cx.json && cx.json.decision, 'block', cx.stdout);
      assertShape(cx.json.reason, 'tasklist-guard', 'tasklist-guard codex', { requireWhy: true });
      assert.doesNotMatch(cx.json.reason, /TaskCreate|TaskUpdate|Edit tool|Write tool/);
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});

test('task-guard idle-neglect Stop block has the shared shape and neutral Codex wording', () => {
  const h = makeHome();
  try {
    const todos = [{ id: '1', content: 'refactor the parser', status: 'pending' }, { id: '2', content: 'add the cache layer', status: 'pending' }];
    const tp = h.writeTranscript([todoWrite(todos)]);
    const r = testHook('task-guard.js', stop(tp), { home: h.home });
    assert.strictEqual(r.json && r.json.decision, 'block', r.stdout);
    assertShape(r.json.reason, 'task-guard', 'task-guard', { requireWhy: true });
    assert.match(r.json.reason, /TaskUpdate/);
    const cx = testHook('task-guard.js', Object.assign(stop(tp), { turn_id: 't1', model: 'gpt-5.6-sol' }), { home: makeHome().home, env: {} });
    if (cx.json && cx.json.decision === 'block') {
      assertShape(cx.json.reason, 'task-guard', 'task-guard codex', { requireWhy: true });
      assert.doesNotMatch(cx.json.reason, /TaskUpdate|TaskCreate/);
    }
  } finally { h.cleanup(); }
});

test('speculation-guard Stop block has the shared shape', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }]);
    const r = testHook('speculation-guard.js', Object.assign(stop(tp), { last_assistant_message: 'The failure is probably a stale lockfile.' }), { home: h.home });
    assert.strictEqual(r.json && r.json.decision, 'block', r.stdout);
    assertShape(r.json.reason, 'speculation-guard', 'speculation-guard', { requireWhy: true });
  } finally { h.cleanup(); }
});

test('model-routing advisory (warn) and row-6 tip have the shared shape', () => {
  const h = makeHome();
  try {
    const r = testHook('model-routing-guard.js', {
      hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 't', cwd: process.cwd(),
      tool_input: { subagent_type: 'general-purpose', description: 'investigate the codebase structure', prompt: 'research and find all usages of the deprecated API, then gather results' },
    }, { home: h.home });
    assertShape(ctx(r), 'model-routing', 'model-routing advisory');
    assert.match(ctx(r), /^⚠️ /);
  } finally { h.cleanup(); }
});

test('task-tracker directive has the shared shape (tip icon)', () => {
  const h = makeHome();
  try {
    const r = testHook('task-tracker.js', { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: h.home }, { home: h.home });
    assertShape(ctx(r), 'task-tracker', 'task-tracker');
    assert.match(ctx(r), /^💡 /);
  } finally { h.cleanup(); }
});

test('auto-handover builders produce the shared shape', () => {
  const t = require(path.join(ROOT, 'hooks', 'lib', 'auto-handover-text.js'));
  const payload = { session_id: 's1', cwd: '/tmp/x' };
  assertShape(t.buildFireDirective({ pct: 85, estimated: false }, 'pct', payload, 0), 'auto-handover', 'fire pct', { requireWhy: true });
  assertShape(t.buildFireDirective({ pct: 85, used: 400000 }, 'tokens', payload, 300000), 'auto-handover', 'fire tokens', { requireWhy: true });
  assertShape(t.buildMilestoneNag(91, payload), 'auto-handover', 'milestone');
  assertShape(t.buildSoftAdvisory(80), 'auto-handover', 'soft');
  assertShape(t.buildPauseNag(70, payload), 'auto-handover', 'pause');
  assertShape(t.buildGateBackstop(95, { handoverPct: 80 }, { gateBudgetPct: 5 }, payload), 'auto-handover', 'backstop');
});

test('update-available advisory uses the update icon; claude-cli drift uses the warn icon', () => {
  const bm = require(path.join(ROOT, 'hooks', 'lib', 'block-message.js'));
  const u = bm.message({ kind: 'update', guard: 'version-alert', what: 'v9.9.9 is available (you are running v1.0.0).', instead: 'tell the user now: run /anti-hall:update.' });
  assertShape(u, 'version-alert', 'version-alert');
  assert.match(u, /^⬆️ /);
  const ok = bm.message({ kind: 'ok', guard: 'doctor', what: 'active.' });
  assert.match(ok, /^✅ /);
  const er = bm.message({ kind: 'error', guard: 'update', what: 'not updated.' });
  assert.match(er, /^❌ /);
});

test('doctor verdict and update headline use the status icons', () => {
  const h = makeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-doc-'));
  try {
    const r = require('node:child_process').spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'doctor.js'), '--check'], {
      cwd, encoding: 'utf8', env: Object.assign({}, process.env, { HOME: h.home, USERPROFILE: h.home }), timeout: 90000,
    });
    const out = r.stdout || '';
    assert.match(out, /(✅|❌) anti-hall · doctor: /, out.slice(-300));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); h.cleanup(); }
});
