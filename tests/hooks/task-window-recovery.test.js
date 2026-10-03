'use strict';
// task-window-recovery: when a task's TaskCreate / status / metadata updates lie
// BEFORE the 1.5MB transcript tail window and only a description-only TaskUpdate is
// inside it, the guard must RECOVER the real state from before the window instead
// of guessing `pending`: an owner-blocked or completed task must not be nagged.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const { backfillSubjects } = require('../../plugins/anti-hall/hooks/lib/task-subject-backfill.js');
const { unseenTask } = require('../../plugins/anti-hall/hooks/lib/task-state.js');

const asst = (content, extra) => Object.assign({ type: 'assistant', message: { role: 'assistant', content } }, extra || {});
function create(n, subject, toolId, extra) {
  return [
    asst([{ type: 'tool_use', name: 'TaskCreate', id: toolId, input: Object.assign({ subject }, extra || {}) }]),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Task #' + n + ' created successfully: ' + subject }] } },
  ];
}
function upd(id, input, toolId, extra) {
  return asst([{ type: 'tool_use', name: 'TaskUpdate', id: toolId, input: Object.assign({ taskId: id }, input) }], extra);
}
function taskListEmpty(toolId) {
  return [
    asst([{ type: 'tool_use', name: 'TaskList', id: toolId, input: {} }]),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'No tasks found' }] } },
  ];
}
function filler(bytes) {
  const line = asst([{ type: 'text', text: 'x'.repeat(1000) }]);
  return new Array(Math.ceil(bytes / 1050)).fill(line);
}
const BIG = 1.6 * 1024 * 1024;

function guard(h, msgs) {
  const tp = h.writeTranscript(msgs);
  return testHook('task-guard.js', { hook_event_name: 'Stop', transcript_path: tp, session_id: 't' }, { home: h.home });
}
const blocked = (r) => !!(r.json && r.json.decision === 'block');

test('CONTROL: everything inside the window, blockedOn external -> no nag', () => {
  const h = makeHome();
  try {
    const r = guard(h, [...create(17, 'wait on vendor', 'toolu_a'), upd('17', { metadata: { blockedOn: 'external' } }, 'toolu_u1'), upd('17', { description: 'd' }, 'toolu_u2')]);
    assert.strictEqual(blocked(r), false, r.stdout);
  } finally { h.cleanup(); }
});

test('(ii) create + metadata.blockedOn update BEFORE the window, description-only update inside -> no nag', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'wait on vendor', 'toolu_a'),
      upd('17', { metadata: { blockedOn: 'external' } }, 'toolu_u1'),
      ...filler(BIG),
      upd('17', { description: 'more detail' }, 'toolu_u2'),
    ]);
    assert.strictEqual(blocked(r), false, r.stdout);
  } finally { h.cleanup(); }
});

test('(ii-c) create with blockedOn owner BEFORE the window, description-only update inside -> no nag', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'owner decides', 'toolu_a', { metadata: { blockedOn: 'owner' } }),
      ...filler(BIG),
      upd('17', { description: 'more detail' }, 'toolu_u2'),
    ]);
    assert.strictEqual(blocked(r), false, r.stdout);
  } finally { h.cleanup(); }
});

test('(iii) create before the window, description-only update inside -> nags with the REAL subject (recovered pending)', () => {
  const h = makeHome();
  try {
    const r = guard(h, [...create(17, 'real open work', 'toolu_a'), ...filler(BIG), upd('17', { description: 'more' }, 'toolu_u')]);
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /"real open work"/, r.json.reason);
  } finally { h.cleanup(); }
});

test('(iii-b) task COMPLETED before the window, description-only update inside -> stays closed', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'done work', 'toolu_a'),
      upd('17', { status: 'completed' }, 'toolu_u1'),
      ...filler(BIG),
      upd('17', { description: 'post-hoc note' }, 'toolu_u2'),
    ]);
    assert.strictEqual(blocked(r), false, r.stdout);
  } finally { h.cleanup(); }
});

test('REAL RESET between the pre-window records and the window -> recovered values NOT applied: unknown, no nag', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'stale', 'toolu_a'),
      ...taskListEmpty('toolu_l'),
      ...filler(BIG),
      upd('17', { description: 'more' }, 'toolu_u'),
    ]);
    assert.strictEqual(blocked(r), false, r.stdout);
  } finally { h.cleanup(); }
});

test('QUOTED "No tasks found" (assistant text + tool_use input) between create and window is NOT a reset -> recovered', () => {
  const h = makeHome();
  try {
    const quote = 'the module docs say "No tasks found", "Task not found" and "TodoWrite" reset the list';
    const r = guard(h, [
      ...create(17, 'owner decides', 'toolu_a', { metadata: { blockedOn: 'owner' } }),
      asst([{ type: 'text', text: quote }]),
      asst([{ type: 'tool_use', name: 'Bash', id: 'toolu_b', input: { command: 'echo "No tasks found"; echo "Task not found"' } }]),
      ...filler(BIG),
      upd('17', { description: 'more' }, 'toolu_u'),
    ]);
    assert.strictEqual(blocked(r), false, r.stdout);
    // and the subject itself is recovered across the quote (pending variant)
    const h2 = makeHome();
    try {
      const r2 = guard(h2, [
        ...create(18, 'quoted but real', 'toolu_c'),
        asst([{ type: 'text', text: quote }]),
        ...filler(BIG),
        upd('18', { description: 'more' }, 'toolu_u'),
      ]);
      assert.strictEqual(blocked(r2), true, r2.stdout);
      assert.match(r2.json.reason, /"quoted but real"/, r2.json.reason);
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});

test('SIDECHAIN records are ignored: a sidechain blockedOn update does not mark the task owner-blocked', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'real open work', 'toolu_a'),
      upd('17', { metadata: { blockedOn: 'owner' } }, 'toolu_s', { isSidechain: true }),
      ...filler(BIG),
      upd('17', { description: 'more' }, 'toolu_u'),
    ]);
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /"real open work"/, r.json.reason);
  } finally { h.cleanup(); }
});

test('a later explicit status change INSIDE the window wins over a recovered one', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'finishing', 'toolu_a'),
      ...filler(BIG),
      upd('17', { status: 'completed' }, 'toolu_u'),
    ]);
    assert.strictEqual(blocked(r), false, r.stdout);
  } finally { h.cleanup(); }
});

test('later metadata update WITHOUT blockedOn does not clear an earlier blockedOn; explicit null does', () => {
  const h = makeHome();
  try {
    const keep = guard(h, [
      ...create(17, 'wait', 'toolu_a', { metadata: { blockedOn: 'owner' } }),
      upd('17', { metadata: { priority: 'P1' } }, 'toolu_u1'),
      ...filler(BIG),
      upd('17', { description: 'x' }, 'toolu_u2'),
    ]);
    assert.strictEqual(blocked(keep), false, keep.stdout);
    const h2 = makeHome();
    try {
      const cleared = guard(h2, [
        ...create(17, 'wait', 'toolu_a', { metadata: { blockedOn: 'owner' } }),
        upd('17', { metadata: { blockedOn: null } }, 'toolu_u1'),
        ...filler(BIG),
        upd('17', { description: 'x' }, 'toolu_u2'),
      ]);
      assert.strictEqual(blocked(cleared), true, cleared.stdout);
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});

test('CAPS: byte / time cap hit -> status stays UNKNOWN (not pending), no throw; control recovers', () => {
  const h = makeHome();
  try {
    const p = h.writeTranscript([...create(2, 'far away', 'toolu_a'), ...filler(BIG + 1024 * 1024), upd('2', { description: 'd' }, 'toolu_u')]);
    const mk = () => new Map([['2', unseenTask('2')]]);
    const control = mk();
    backfillSubjects(control, p, { firstCreated: Infinity, chunkBytes: 64 * 1024 });
    assert.strictEqual(control.get('2').status, 'pending');
    assert.strictEqual(control.get('2').content, 'far away');
    const capped = mk();
    assert.doesNotThrow(() => backfillSubjects(capped, p, { firstCreated: Infinity, chunkBytes: 64 * 1024, maxBytes: 256 * 1024 }));
    assert.strictEqual(capped.get('2').status, undefined);
    const timed = mk();
    assert.doesNotThrow(() => backfillSubjects(timed, p, { firstCreated: Infinity, maxMs: 0 }));
    assert.strictEqual(timed.get('2').status, undefined);
  } finally { h.cleanup(); }
});

function notFound(id, toolId) {
  return [
    upd(id, { status: 'completed' }, toolId),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Task #' + id + ' not found' }] } },
  ];
}
const UNKNOWN_NOTE = '1 task(s) in an unknown state (their records are too far back to read) — re-state each with TaskUpdate (status) to refresh.';

test('TRACKER: a recovered-open task shows in the per-turn "open tasks" line (open recomputed after the backfill)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([...create(17, 'recovered open', 'toolu_a'), ...filler(BIG), upd('17', { description: 'more' }, 'toolu_u')]);
    const r = testHook('task-tracker.js', { hook_event_name: 'UserPromptSubmit', prompt: 'go', transcript_path: tp, session_id: 't' }, { home: h.home });
    assert.match(r.stdout, /open tasks: 1 — update or close them\./, r.stdout);
  } finally { h.cleanup(); }
});

test('NOT-FOUND is per id: a mistyped TaskUpdate BEFORE the window does not silence the other tasks', () => {
  const h = makeHome();
  try {
    const r = guard(h, [...create(1, 'real open work', 'toolu_a'), ...notFound('99', 'toolu_nf'), ...filler(BIG), upd('1', { description: 'more' }, 'toolu_u')]);
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /"real open work"/, r.json.reason);
  } finally { h.cleanup(); }
});

test('NOT-FOUND is per id: a mistyped TaskUpdate INSIDE the window does not silence the other tasks', () => {
  const h = makeHome();
  try {
    const r = guard(h, [...create(1, 'real open work', 'toolu_a'), ...filler(BIG), ...notFound('99', 'toolu_nf'), upd('1', { description: 'more' }, 'toolu_u')]);
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /"real open work"/, r.json.reason);
  } finally { h.cleanup(); }
});

test('a REAL numbering restart (#1,#2,#1) is the boundary: the earlier epoch is not applied -> unknown, no nag, note shown', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(1, 'old one', 'toolu_a'),
      ...create(2, 'old two', 'toolu_b'),
      ...create(1, 'new one', 'toolu_c'),
      ...filler(BIG),
      upd('2', { description: 'more' }, 'toolu_u'),
    ]);
    assert.strictEqual(blocked(r), false, r.stdout);
    assert.ok(r.stdout.includes(UNKNOWN_NOTE), r.stdout);
  } finally { h.cleanup(); }
});

test('UNKNOWN NOTE: advisory only (never blocks by itself), throttled (not repeated for the same set), and joins a block reason', () => {
  const h = makeHome();
  try {
    const msgs = [...create(17, 'stale', 'toolu_a'), ...taskListEmpty('toolu_l'), ...filler(BIG), upd('17', { description: 'more' }, 'toolu_u')];
    const first = guard(h, msgs);
    assert.strictEqual(blocked(first), false, first.stdout);
    assert.ok(first.stdout.includes('[task-guard] ' + UNKNOWN_NOTE), first.stdout);
    const second = guard(h, msgs);
    assert.ok(!second.stdout.includes('unknown state'), 'throttled: ' + second.stdout);
    const h2 = makeHome();
    try {
      const r = guard(h2, [...create(17, 'stale', 'toolu_a'), ...taskListEmpty('toolu_l'), ...filler(BIG), ...create(5, 'visible open', 'toolu_v'), upd('17', { description: 'more' }, 'toolu_u')]);
      assert.strictEqual(blocked(r), true, r.stdout);
      assert.ok(r.json.reason.endsWith(UNKNOWN_NOTE), r.json.reason);
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});

test('UNKNOWN NOTE: the tracker line says it too, once', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([...create(17, 'stale', 'toolu_a'), ...taskListEmpty('toolu_l'), ...filler(BIG), upd('17', { description: 'more' }, 'toolu_u')]);
    const run = () => testHook('task-tracker.js', { hook_event_name: 'UserPromptSubmit', prompt: 'go', transcript_path: tp, session_id: 't' }, { home: h.home });
    assert.ok(run().stdout.includes(UNKNOWN_NOTE));
    assert.ok(!run().stdout.includes('unknown state'));
  } finally { h.cleanup(); }
});

test('RULE: a KNOWN open status stays open (listed) when the scan stops before the create; it is only excluded from idle-neglect and counted unknown', () => {
  const { openOf, unknownOf, classifyOpen } = require('../../plugins/anti-hall/hooks/lib/task-state.js');
  const h = makeHome();
  try {
    const mk = (status, tool) => [
      ...create(2, 'far away', 'toolu_a'), ...filler(1024 * 1024),
      upd('2', { status }, tool), ...filler(BIG), upd('2', { description: 'd' }, 'toolu_u'),
    ];
    for (const status of ['pending', 'in_progress']) {
      const p = h.writeTranscript(mk(status, 'toolu_s' + status));
      const map = new Map([['2', unseenTask('2')]]);
      backfillSubjects(map, p, { firstCreated: Infinity, chunkBytes: 64 * 1024, maxBytes: 256 * 1024 });
      assert.strictEqual(map.get('2').status, status);
      assert.strictEqual(map.get('2').blockUnknown, true);
      assert.strictEqual(openOf(map).length, 1, status + ' stays in the open set');
      assert.strictEqual(unknownOf(map).length, 1, status + ' is counted in the note');
      assert.strictEqual(classifyOpen(openOf(map), map).length, 0, status + ' is never an idle-neglect candidate');
    }
  } finally { h.cleanup(); }
});

test('FAR-BACK PENDING: status known pending in the window, create unreachable -> generic Stop block (not idle-neglect), real note appended', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'stale', 'toolu_a'), ...taskListEmpty('toolu_l'), ...filler(BIG),
      upd('17', { status: 'pending', description: 'more' }, 'toolu_u'),
    ]);
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /^Open tasks remain/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /IDLE NEGLECT/, r.json.reason);
    assert.match(r.json.reason, /\(subject unknown\)/, r.json.reason);
    assert.ok(r.json.reason.endsWith(UNKNOWN_NOTE), r.json.reason);
  } finally { h.cleanup(); }
});

test('COMPLETED before the window, RE-OPENED (status pending) inside it -> still nags, with the real subject', () => {
  const h = makeHome();
  try {
    const r = guard(h, [
      ...create(17, 'reopened work', 'toolu_a'),
      upd('17', { status: 'completed' }, 'toolu_u1'),
      ...filler(BIG),
      upd('17', { status: 'pending', description: 'again' }, 'toolu_u2'),
    ]);
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /"reopened work"/, r.json.reason);
    assert.ok(!r.json.reason.includes('unknown state'), r.json.reason);
  } finally { h.cleanup(); }
});

test('NO CACHE: nothing named task-window-cache is ever written', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([...create(17, 'real open work', 'toolu_a'), ...filler(BIG), upd('17', { description: 'more' }, 'toolu_u')]);
    testHook('task-guard.js', { hook_event_name: 'Stop', transcript_path: tp, session_id: 'S1' }, { home: h.home });
    testHook('task-tracker.js', { hook_event_name: 'UserPromptSubmit', prompt: 'go', transcript_path: tp, session_id: 'S1' }, { home: h.home });
    const dir = path.join(h.home, '.anti-hall');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepStrictEqual(names.filter((n) => /task-window-cache/.test(n)), [], names.join(','));
  } finally { h.cleanup(); }
});

test('PRUNE: the last-unknown-* throttle files are swept after the 7-day TTL (own file kept)', () => {
  const h = makeHome();
  try {
    const dir = path.join(h.home, '.anti-hall');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'last-unknown-guard-OLDSESSION.json');
    fs.writeFileSync(old, JSON.stringify({ hash: 'x', n: 1 }));
    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, eightDays, eightDays);
    const r = guard(h, [...create(17, 'stale', 'toolu_a'), ...taskListEmpty('toolu_l'), ...filler(BIG), upd('17', { description: 'more' }, 'toolu_u')]);
    assert.ok(r.stdout.includes(UNKNOWN_NOTE), r.stdout);
    assert.ok(!fs.existsSync(old), 'stale throttle file swept');
    assert.ok(fs.readdirSync(dir).some((n) => /^last-unknown-guard-t\.json$/.test(n)), 'own file kept');
  } finally { h.cleanup(); }
});

function asstMsg(id, content) { return { type: 'assistant', message: { id, role: 'assistant', content } }; }
function parallelCreates(base) {
  // ONE assistant message, two parallel TaskCreate calls; the harness numbered them in REVERSE.
  return [
    asstMsg('msg_par' + base, [{ type: 'tool_use', name: 'TaskCreate', id: 'toolu_pa' + base, input: { subject: 'alpha' } }]),
    asstMsg('msg_par' + base, [{ type: 'tool_use', name: 'TaskCreate', id: 'toolu_pb' + base, input: { subject: 'beta' } }]),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_pa' + base, content: 'Task #' + (base + 1) + ' created successfully: alpha' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_pb' + base, content: 'Task #' + base + ' created successfully: beta' }] } },
  ];
}

test('PARALLEL creates of ONE assistant message numbered in reverse are not a restart (backward scan)', () => {
  const h = makeHome();
  try {
    const r = guard(h, [...parallelCreates(1), ...filler(BIG), upd('2', { description: 'more' }, 'toolu_u')]);
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /"alpha"/, r.json.reason);
  } finally { h.cleanup(); }
});

test('PARALLEL creates of ONE assistant message numbered in reverse are not a restart (in-window parsers)', () => {
  const { reconstructTasks } = require('../../plugins/anti-hall/hooks/lib/task-state.js');
  const a = reconstructTasks({ data: parallelCreates(1).map((m) => JSON.stringify(m)).join('\n'), truncated: false });
  assert.strictEqual(a.windowReset, false);
  assert.strictEqual(a.taskMap.size, 2);
  const h = makeHome();
  try {
    const r = guard(h, parallelCreates(1));
    assert.strictEqual(blocked(r), true, r.stdout);
    assert.match(r.json.reason, /alpha/, r.json.reason);
    assert.match(r.json.reason, /beta/, r.json.reason);
  } finally { h.cleanup(); }
});

test('task-state: an update for an unseen id is status-UNKNOWN (not pending, not open); the in-window create fills it', () => {
  const { reconstructTasks } = require('../../plugins/anti-hall/hooks/lib/task-state.js');
  const L = (arr) => arr.map((m) => JSON.stringify(m)).join('\n');
  const a = reconstructTasks({ data: L([upd('9', { description: 'd' }, 'toolu_u')]), truncated: false });
  assert.strictEqual(a.taskMap.get('9').status, undefined);
  assert.strictEqual(a.open.length, 0);
  const b = reconstructTasks({ data: L([...create(9, 'named', 'toolu_a', { metadata: { blockedOn: 'owner' } }), upd('9', { description: 'd' }, 'toolu_u')]), truncated: false });
  assert.strictEqual(b.taskMap.get('9').status, 'pending');
  assert.strictEqual(b.taskMap.get('9').blockedOn, 'owner');
});

test('FAST PATH: nothing unknown -> no file access', () => {
  const map = new Map([['2', { id: '2', content: 'named', status: 'in_progress' }]]);
  const orig = { open: fs.openSync, stat: fs.statSync };
  let calls = 0;
  fs.openSync = (...a) => { calls++; return orig.open(...a); };
  fs.statSync = (...a) => { calls++; return orig.stat(...a); };
  try {
    assert.strictEqual(backfillSubjects(map, path.join(__dirname, 'x'), { firstCreated: Infinity }), 0);
  } finally { fs.openSync = orig.open; fs.statSync = orig.stat; }
  assert.strictEqual(calls, 0);
});
