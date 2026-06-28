'use strict';
// task-guard (Stop hook). Block => stdout {decision:'block'} + exit 0.
//
// Task discovery: TodoWrite tool_use entries (input.todos[]) — last write wins,
// each TodoWrite REPLACES the list. Open = status pending|in_progress. State file:
// session_id 't' -> ~/.anti-hall/last-stop-taskset-t.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'task-guard.js';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

// An assistant message carrying a TodoWrite tool_use with the given todos array.
function todoWrite(todos) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'TodoWrite', id: 'toolu_tw', input: { todos } }],
    },
  };
}

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

function isIdleNeglect(r) {
  return isBlock(r) && /IDLE NEGLECT/.test(r.json.reason || '');
}

// Write a FRESH agent heartbeat under <home>/.anti-hall/agents/<id>.json so the
// hook sees an in-flight subagent (matches agent-watchdog format: numeric ts).
function writeFreshAgent(h, id) {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(h.antiHall, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'),
    JSON.stringify({ id, ts: Date.now(), status: 'running', step: 'work' }), 'utf8');
}

test('BLOCK: open (pending/in_progress) tasks remain at Stop', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'wire up the parser', status: 'in_progress' },
        { id: '2', content: 'write the docs', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: all tasks completed', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'wire up the parser', status: 'completed' },
        { id: '2', content: 'write the docs', status: 'completed' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: no tasks at all', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done.' }] } },
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ESCAPE HATCH: skip.json {task-guard: future} -> allow despite open tasks', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'task-guard': Date.now() + 600000 });
    const tp = h.writeTranscript([
      todoWrite([{ id: '1', content: 'open task', status: 'pending' }]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `skip active; expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// ---- IDLE-NEGLECT (sharp) mode ----

test('IDLE NEGLECT: actionable-now pending + no agents -> idle-neglect block naming tasks', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'refactor the parser', status: 'pending' },
        { id: '2', content: 'add the cache layer', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r), `expected idle-neglect block; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /refactor the parser/, 'names the actionable task');
    assert.match(r.json.reason, /PARALLEL/, 'demands parallel dispatch');
  } finally {
    h.cleanup();
  }
});

test('NO IDLE NEGLECT: agents running -> generic nudge, not idle-neglect', () => {
  const h = makeHome();
  try {
    writeFreshAgent(h, 'worker-a');
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'refactor the parser', status: 'pending' },
        { id: '2', content: 'add the cache layer', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected a block; stdout: ${r.stdout}`);
    assert.ok(!isIdleNeglect(r), `agents running -> must NOT be idle-neglect; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('NO IDLE NEGLECT: all open tasks blocked -> generic nudge, not idle-neglect', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'foundation task', status: 'in_progress' },
        { id: '2', content: 'dependent task', status: 'pending', blockedBy: ['1'] },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected a block (task 1 in_progress is open); stdout: ${r.stdout}`);
    assert.ok(!isIdleNeglect(r), `only blocked/in_progress -> not idle-neglect; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('NO IDLE NEGLECT: pending task is owned by a subagent -> not actionable-now', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'owned work', status: 'pending', owner: 'worker-7' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(r), `owned pending task is not actionable-now; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('BLOCKER FREED on completion: dependent pending task becomes actionable (idle-neglect)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'foundation', status: 'completed' },
        { id: '2', content: 'dependent task', status: 'pending', blockedBy: ['1'] },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r), `blocker done -> task 2 actionable; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /dependent task/, 'names the now-unblocked task');
  } finally {
    h.cleanup();
  }
});

test('DANGLING blocker id (unknown) -> task treated blocked, NOT actionable (safer default)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '2', content: 'depends on missing 999', status: 'pending', blockedBy: ['999'] },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    // Still blocks (task is open), but as the generic nudge — NOT idle-neglect,
    // because the dangling blocker keeps it out of the actionable set.
    assert.ok(isBlock(r), `open task -> some block expected; stdout: ${r.stdout}`);
    assert.ok(!isIdleNeglect(r), `dangling blocker -> not actionable; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('GENERIC dedupe: same OPEN set (all blocked/owned) -> blocks once then dedupes', () => {
  const h = makeHome();
  try {
    // All open tasks are non-actionable (in_progress + owned), so this is the
    // GENERIC nudge path. The full open-set hash must dedupe a second identical Stop.
    const lines = [
      todoWrite([
        { id: '1', content: 'in flight', status: 'in_progress' },
        { id: '2', content: 'owned work', status: 'pending', owner: 'worker-7' },
      ]),
    ];
    const tp = h.writeTranscript(lines);
    const r1 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r1) && !isIdleNeglect(r1), `first should generic-block; stdout: ${r1.stdout}`);
    const tp2 = h.writeTranscript(lines);
    const r2 = testHook(HOOK, stopPayload(tp2), { home: h.home });
    assert.ok(!isBlock(r2), `identical open set must dedupe; stdout: ${r2.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('IDLE NEGLECT dedupe: same actionable set + no-agents -> no second block', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([{ id: '1', content: 'lonely task', status: 'pending' }]),
    ]);
    const r1 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r1), `first should idle-neglect; stdout: ${r1.stdout}`);
    const r2 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r2), `identical set must dedupe; stdout: ${r2.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('LOOP-SAFETY: cannot hard-loop — blocks capped even as actionable set churns', () => {
  const h = makeHome();
  try {
    // Each Stop presents a DIFFERENT actionable set (defeats hash dedupe), so only
    // the MAX_BLOCKS cap (5) can stop it. Verify it eventually goes quiet.
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      const tp = h.writeTranscript([
        todoWrite([{ id: 'task-' + i, content: 'churn ' + i, status: 'pending' }]),
      ]);
      const r = testHook(HOOK, stopPayload(tp), { home: h.home });
      if (isBlock(r)) blocked++;
    }
    assert.ok(blocked <= 5, `cap must hold; got ${blocked} blocks across 12 churning Stops`);
    assert.ok(blocked >= 1, `should have blocked at least once; got ${blocked}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

// ---- PRIORITY AWARENESS ----

test('PRIORITY (a): only-P2 pending tasks -> NO idle-neglect (P2 is non-nagging backlog)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'low prio chore', status: 'pending', priority: 'P2' },
        { id: '2', content: 'another backlog item', status: 'pending', priority: 'P2' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    // P2-only tasks must NOT trigger idle-neglect. They may still produce a
    // generic nudge (the tasks ARE open), but the sharp IDLE NEGLECT accusation
    // must not appear because no P0/P1 actionable task is pending.
    assert.ok(!isIdleNeglect(r), `P2-only tasks must not trigger idle-neglect; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRIORITY (b): P1 pending unowned unblocked task -> idle-neglect still fires', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'important work', status: 'pending', priority: 'P1' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r), `P1 task must still trigger idle-neglect; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRIORITY (b-metadata): P0 via metadata.priority -> idle-neglect fires', () => {
  // Verifies that priority set in inp.metadata.priority (harness convention) is
  // captured correctly and treated as actionable.
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'critical task', status: 'pending', metadata: { priority: 'P0' } },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r), `P0 via metadata.priority must trigger idle-neglect; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRIORITY: missing priority treated as P1 (fail-open) -> idle-neglect fires', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'unprioritized work', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r), `missing priority must default to actionable -> idle-neglect; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});
