'use strict';
// task-subject-backfill: an OPEN task whose TaskCreate sits before the 1.5MB
// transcript tail window must still be NAMED (not "(subject unknown)") in the
// task-guard Stop reason and the task-tracker line — unless a list reset lies
// between its creation and the window (then it stays unknown, never invented).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const { backfillSubjects } = require('../../plugins/anti-hall/hooks/lib/task-subject-backfill.js');

function create(n, subject, toolId) {
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', id: toolId, input: { subject } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Task #' + n + ' created successfully: ' + subject }] } },
  ];
}
function update(id, status, toolId) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskUpdate', id: toolId, input: { taskId: id, status } }] } };
}
function taskListEmpty(toolId) {
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskList', id: toolId, input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'No tasks found' }] } },
  ];
}
// > 1.5MB of unrelated JSONL so everything before it is outside the tail window.
function filler(bytes) {
  const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } };
  return new Array(Math.ceil(bytes / 1050)).fill(line);
}
const BIG = 1.6 * 1024 * 1024;

function guard(h, msgs) {
  const tp = h.writeTranscript(msgs);
  return testHook('task-guard.js', { hook_event_name: 'Stop', transcript_path: tp, session_id: 't' }, { home: h.home });
}

test('BACKFILL: TaskCreate before the tail window -> block reason names the real subject', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(1, 'Items 1-4: --op all', 'toolu_a'),
      ...create(2, 'Items 5-8: --op rest', 'toolu_b'),
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    assert.strictEqual(r.json && r.json.decision, 'block', r.stdout);
    assert.match(r.json.reason, /"Items 5-8: --op rest" \["in_progress"\]/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /subject unknown/);
  } finally { h.cleanup(); }
});

test('BACKFILL: tracker names the subject too', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      ...create(1, 'Items 1-4: --op all', 'toolu_a'),
      ...filler(BIG),
      update('1', 'in_progress', 'toolu_u'),
    ]);
    const r = testHook('task-tracker.js', { hook_event_name: 'UserPromptSubmit', prompt: 'go', transcript_path: tp, session_id: 't' }, { home: h.home });
    assert.match(r.stdout, /oldest in_progress subject: \\"Items 1-4: --op all\\"/, r.stdout);
  } finally { h.cleanup(); }
});

test('BACKFILL: a list reset between creation and the window -> still "(subject unknown)"', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(1, 'old one', 'toolu_a'),
      ...create(2, 'old two', 'toolu_b'),
      ...taskListEmpty('toolu_l'),
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    assert.match(r.json.reason, /\(subject unknown\)/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /old two/);
  } finally { h.cleanup(); }
});

test('BACKFILL: numbering restart (#2 then #1 again) is a reset -> the pre-restart #2 is NOT used', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(1, 'old one', 'toolu_a'),
      ...create(2, 'old two', 'toolu_b'),
      ...create(1, 'new one', 'toolu_c'),
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    assert.match(r.json.reason, /\(subject unknown\)/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /old two/);
  } finally { h.cleanup(); }
});

test('BACKFILL: id re-used in a later epoch -> the LATEST subject wins', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(1, 'old one', 'toolu_a'),
      ...create(2, 'old two', 'toolu_b'),
      ...create(1, 'new one', 'toolu_c'),
      ...create(2, 'new two', 'toolu_d'),
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    assert.match(r.json.reason, /"new two"/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /old two/);
  } finally { h.cleanup(); }
});

test('BACKFILL: unreadable file / missing path -> 0 backfilled, no throw', () => {
  const map = new Map([['2', { id: '2', content: '2', status: 'in_progress' }]]);
  assert.strictEqual(backfillSubjects(map, path.join(os.tmpdir(), 'nope-' + process.pid + '.jsonl'), { firstCreated: Infinity }), 0);
  assert.strictEqual(map.get('2').content, '2');
});

// A bare in-progress #2 with no subject, as the guard's window parse leaves it.
function unknown2() { return new Map([['2', { id: '2', content: '2', status: 'in_progress' }]]); }
function writeJsonl(h, msgs) {
  const p = path.join(h.home, 'fixture.jsonl');
  fs.writeFileSync(p, msgs.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n') + '\n');
  return p;
}

test('CAPS: byte cap stops the scan (create further back than maxBytes) -> unknown; control finds it', () => {
  const h = makeHome();
  try {
    // 2.6MB of filler between the create and the window: ~1.1MB sits before the window start.
    const p = writeJsonl(h, [...create(2, 'far away', 'toolu_a'), ...filler(BIG + 1024 * 1024), update('2', 'in_progress', 'toolu_u')]);
    const control = unknown2();
    assert.strictEqual(backfillSubjects(control, p, { firstCreated: Infinity, chunkBytes: 64 * 1024 }), 1);
    assert.strictEqual(control.get('2').content, 'far away');
    const capped = unknown2();
    assert.strictEqual(backfillSubjects(capped, p, { firstCreated: Infinity, chunkBytes: 64 * 1024, maxBytes: 256 * 1024 }), 0);
    assert.strictEqual(capped.get('2').content, '2');
  } finally { h.cleanup(); }
});

test('CAPS: wall-clock cap (maxMs 0) -> fail-open unknown, no throw', () => {
  const h = makeHome();
  try {
    const p = writeJsonl(h, [...create(2, 'far away', 'toolu_a'), ...filler(BIG), update('2', 'in_progress', 'toolu_u')]);
    const map = unknown2();
    assert.doesNotThrow(() => backfillSubjects(map, p, { firstCreated: Infinity, maxMs: 0 }));
    assert.strictEqual(map.get('2').content, '2');
  } finally { h.cleanup(); }
});

function bashEcho(text, toolId) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] } };
}

test('SPOOF: a Bash tool_result echoing "Task #2 created successfully: FAKE" after the real create -> real subject wins', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(2, 'the real subject', 'toolu_real'),
      bashEcho('Task #2 created successfully: FAKE SUBJECT', 'toolu_bash'),
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    assert.match(r.json.reason, /"the real subject"/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /FAKE/);
  } finally { h.cleanup(); }
});

test('SPOOF: a spoofed result with NO real TaskCreate -> "(subject unknown)"', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      bashEcho('Task #2 created successfully: FAKE SUBJECT', 'toolu_bash'),
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    assert.match(r.json.reason, /\(subject unknown\)/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /FAKE/);
  } finally { h.cleanup(); }
});

test('SIDECHAIN: a TaskCreate from a sidechain (subagent) record is ignored -> unknown', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(2, 'subagent task', 'toolu_a').map((m) => Object.assign({ isSidechain: true }, m)),
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    assert.match(r.json.reason, /\(subject unknown\)/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /subagent task/);
  } finally { h.cleanup(); }
});

test('CHUNKING: a create record straddling a chunk edge is still found (every offset)', () => {
  const h = makeHome();
  try {
    for (let pad = 0; pad < 4096; pad += 97) {
      const p = writeJsonl(h, [
        ...create(2, 'straddler', 'toolu_a'),
        { type: 'assistant', message: { content: [{ type: 'text', text: 'p'.repeat(pad) }] } },
        ...filler(BIG),
        update('2', 'in_progress', 'toolu_u'),
      ]);
      const map = unknown2();
      assert.strictEqual(backfillSubjects(map, p, { firstCreated: Infinity, chunkBytes: 4096 }), 1, 'pad ' + pad);
      assert.strictEqual(map.get('2').content, 'straddler');
    }
  } finally { h.cleanup(); }
});

test('CHUNKING: a single >1MB line between the create and the window is crossed', () => {
  const h = makeHome();
  try {
    const p = writeJsonl(h, [
      ...create(2, 'behind a giant line', 'toolu_a'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'g'.repeat(2.5 * 1024 * 1024) }] } },
      ...filler(BIG),
      update('2', 'in_progress', 'toolu_u'),
    ]);
    const map = unknown2();
    assert.strictEqual(backfillSubjects(map, p, { firstCreated: Infinity, maxMs: 5000 }), 1);
    assert.strictEqual(map.get('2').content, 'behind a giant line');
  } finally { h.cleanup(); }
});

test('FAST PATH: every open task already has a subject -> no file access at all', () => {
  const map = new Map([['2', { id: '2', content: 'has one', status: 'in_progress' }]]);
  const orig = { open: fs.openSync, stat: fs.statSync, read: fs.readSync };
  let calls = 0;
  fs.openSync = (...a) => { calls++; return orig.open(...a); };
  fs.statSync = (...a) => { calls++; return orig.stat(...a); };
  fs.readSync = (...a) => { calls++; return orig.read(...a); };
  try {
    assert.strictEqual(backfillSubjects(map, __filename, { firstCreated: Infinity }), 0);
  } finally { fs.openSync = orig.open; fs.statSync = orig.stat; fs.readSync = orig.read; }
  assert.strictEqual(calls, 0);
});
