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

test('GLOBAL HEARTBEAT ALONE does not silence IDLE NEGLECT (it is not this session\'s agent)', () => {
  // ~/.anti-hall/agents/*.json is machine-global (any session/project writes it).
  // It used to blanket-suppress IDLE NEGLECT for every pending task; coverage is
  // now per task from THIS transcript (lib/dispatch-demand.js).
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
    assert.ok(isIdleNeglect(r), `global heartbeat only -> IDLE NEGLECT still fires; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('GENERIC SUPPRESSED: open in_progress task + fresh recent-spawn.json -> NO block (FIX 2)', () => {
  // The phase-tracker heartbeat (recent-spawn.json) makes agentsRunning() true.
  // An in_progress task is open but the live agent is handling it -> suppress generic block.
  const h = makeHome();
  try {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const agentsDir = path2.join(h.antiHall, 'agents');
    fs2.mkdirSync(agentsDir, { recursive: true });
    fs2.writeFileSync(path2.join(agentsDir, 'recent-spawn.json'),
      JSON.stringify({ ts: Date.now() }), 'utf8');
    const tp = h.writeTranscript([
      todoWrite([{ id: '1', content: 'work in progress', status: 'in_progress' }]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `live agent + in_progress task -> generic block suppressed; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('GENERIC block FIRES: open in_progress task + NO heartbeat -> blocks (FIX 2)', () => {
  // No heartbeat => agentsRunning() false => genuinely-neglected in_progress task => block.
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([{ id: '1', content: 'stalled work', status: 'in_progress' }]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `no agents + in_progress task -> generic block must fire; stdout: ${r.stdout}`);
    assert.ok(!isIdleNeglect(r), `in_progress is not actionable -> not idle-neglect; reason: ${r.json && r.json.reason}`);
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

// ---- OWNER-BLOCKED MARKER (field report: a Primary faked a blockedBy to
// silence IDLE NEGLECT when every pending task was genuinely blocked on the
// owner). isOwnerBlocked() recognizes an EXPLICIT marker instead. ----

test('OWNER-BLOCKED (metadata.blockedOn): every pending task marked owner-blocked -> NO idle-neglect', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'flash the dev board', status: 'pending', metadata: { blockedOn: 'owner' } },
        { id: '2', content: 'pick the auth provider', status: 'pending', metadata: { blockedOn: 'user' } },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(r), `owner-blocked tasks must never drive idle-neglect; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('OWNER-BLOCKED (subject prefix "OWNER:"): non-dispatchable without any blockedOn field', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'OWNER: approve the production deploy window', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(r), `"OWNER:" subject prefix must suppress idle-neglect; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('OWNER-BLOCKED (subject prefix "OWNER DECISION", case-insensitive): non-dispatchable', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'owner decision: pick the cloud region', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(r), `"owner decision" prefix (case-insensitive) must suppress idle-neglect; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('OWNER-BLOCKED marker does not suppress a DIFFERENT, genuinely actionable task', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'OWNER: sign off on the migration', status: 'pending' },
        { id: '2', content: 'write the release notes', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isIdleNeglect(r), `a genuinely actionable sibling task must still trigger idle-neglect; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /write the release notes/, 'names only the actionable task');
    assert.ok(!/sign off on the migration/.test(r.json.reason), 'must not name the owner-blocked task as actionable');
  } finally {
    h.cleanup();
  }
});

test('OWNER-BLOCKED marker is honored through TaskCreate/TaskUpdate (not just TodoWrite)', () => {
  const h = makeHome();
  try {
    const createEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'TaskCreate', id: 'toolu_c1', input: { subject: 'wait for hardware from the owner', metadata: { blockedOn: 'owner' } } }],
      },
    };
    const resultEntry = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c1', content: 'Task #1 created successfully: wait for hardware from the owner' }] },
    };
    const tp = h.writeTranscript([createEntry, resultEntry]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(r), `TaskCreate-marked owner-blocked task must not drive idle-neglect; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('OWNER-BLOCKED MARKER SETTING: guards.taskGuardOwnerBlockedMarker off -> falls back to pre-marker behavior (blocks)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'OWNER: approve the budget', status: 'pending' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTIHALL_TASK_GUARD_OWNER_BLOCKED_MARKER: 'off' } });
    assert.ok(isIdleNeglect(r), `marker disabled via setting -> task must be treated as ordinary actionable work; stdout: ${r.stdout}`);
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

test('PRIORITY (c): only-P3 pending tasks -> NO idle-neglect (P3 is non-nagging backlog, same as P2)', () => {
  // The filter must be consistent: guards.idleNeglectMinPriority defaults to
  // P1, so anything below P1 (P2, P3, ...) is backlog and must NOT nag. Before
  // the fix, isActionablePriority only special-cased the literal string 'p2'
  // (plus 'low'/'deferred'), so an explicit P3 fell through to the fail-open
  // "unrecognized -> actionable" branch and WRONGLY triggered idle-neglect.
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'someday maybe', status: 'pending', priority: 'P3' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isIdleNeglect(r), `P3-only tasks must not trigger idle-neglect; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRIORITY (d): guards.idleNeglectMinPriority=P2 lowers the bar -> P2 task nags, P3 still does not', () => {
  const h = makeHome();
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(
      path.join(h.antiHall, 'settings.json'),
      JSON.stringify({ guards: { idleNeglectMinPriority: 'P2' } }),
      'utf8'
    );

    const tpP2 = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'promoted backlog item', status: 'pending', priority: 'P2' },
      ]),
    ]);
    const rP2 = testHook(HOOK, stopPayload(tpP2), { home: h.home });
    assert.ok(isIdleNeglect(rP2), `with min priority P2, a P2 task must trigger idle-neglect; stdout: ${rP2.stdout}`);

    const tpP3 = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'still backlog', status: 'pending', priority: 'P3' },
      ]),
    ]);
    const rP3 = testHook(HOOK, stopPayload(tpP3), { home: h.home });
    assert.ok(!isIdleNeglect(rP3), `with min priority P2, a P3 task must still not trigger idle-neglect; stdout: ${rP3.stdout}`);
  } finally {
    h.cleanup();
  }
});

// ---- GENERIC NUDGE honours honest blocked markers (blockedBy an OPEN task,
// or metadata.blockedOn owner/user/human/external). ----

test('GENERIC: every open task honestly blocked -> no nudge at all', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'ship after review', status: 'pending', blockedBy: ['2'] },
        { id: '2', content: 'waiting on vendor API key', status: 'in_progress', metadata: { blockedOn: 'external' } },
        { id: '3', content: 'owner picks region', status: 'in_progress', metadata: { blockedOn: 'owner' } },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `all-blocked open set must not nudge; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('GENERIC: an unblocked open task still nudges and lists ONLY the unblocked ones; dedup kept', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'ship after review', status: 'pending', blockedBy: ['2'] },
        { id: '2', content: 'waiting on vendor API key', status: 'in_progress', metadata: { blockedOn: 'external' } },
        { id: '3', content: 'refactor the parser', status: 'in_progress' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r) && !isIdleNeglect(r), `expected the generic nudge; got ${JSON.stringify(r.json)}`);
    const reason = r.json.reason;
    assert.match(reason, /refactor the parser/);
    assert.doesNotMatch(reason, /ship after review|vendor API key/);
    assert.match(reason, /blockedBy/);
    assert.match(reason, /blockedOn/);
    const r2 = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r2), 'same unblocked set must dedupe on the next Stop');
  } finally {
    h.cleanup();
  }
});

test('GENERIC: a blockedBy naming a completed or unknown task does not hide the task', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'done prerequisite', status: 'completed' },
        { id: '2', content: 'follow-up work', status: 'in_progress', blockedBy: ['1'] },
        { id: '3', content: 'fake-blocked work', status: 'in_progress', blockedBy: ['999'] },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected the generic nudge; got ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /follow-up work/);
    assert.match(r.json.reason, /fake-blocked work/);
  } finally {
    h.cleanup();
  }
});

test("OWNER-BLOCKED: metadata.blockedOn 'external' suppresses idle-neglect", () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'wait for upstream release', status: 'pending', metadata: { blockedOn: 'External' } },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `external-blocked task must not nudge; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

// ---- R1-2: a self-referential (A->A) or cyclic (A<->B) fake blockedBy is
// NOT an honest blocker -- it never reaches a task that can actually make
// progress, so the generic nudge must still list the task(s) involved. ----

test('GENERIC: self-referential blockedBy (A->A) does not silence the nudge', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'self-blocked task', status: 'pending', blockedBy: ['1'] },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `self-referential blockedBy must still nudge; got ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /self-blocked task/);
  } finally {
    h.cleanup();
  }
});

test('GENERIC: cyclic blockedBy (A<->B) does not silence the nudge for either task', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'cyclic task A', status: 'pending', blockedBy: ['2'] },
        { id: '2', content: 'cyclic task B', status: 'in_progress', blockedBy: ['1'] },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `cyclic blockedBy must still nudge; got ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /cyclic task A/);
    assert.match(r.json.reason, /cyclic task B/);
  } finally {
    h.cleanup();
  }
});

// ---- R5R1-P2-2: canReachTerminal used to be a memoized DFS whose memoized
// `false` depended on which node was "visiting" first, so the same graph
// gave a different verdict depending on TodoWrite order. A real fixpoint
// (seed terminal tasks, then repeatedly add any open task with a valid
// blocker already in the set) must give the SAME verdict regardless of
// order: A blockedBy [B,T], B blockedBy [A], T is owner-blocked (terminal,
// so T reaches nothing further and is itself filtered as owner-blocked). ----

test('GENERIC: order-independent verdict — A blockedBy [B,T], B blockedBy [A], T owner-blocked (order A,B,T)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'cross-blocked task A', status: 'pending', blockedBy: ['2', '3'] },
        { id: '2', content: 'cross-blocked task B', status: 'in_progress', blockedBy: ['1'] },
        { id: '3', content: 'owner picks the terminal', status: 'in_progress', metadata: { blockedOn: 'owner' } },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `A and B both honestly reach the owner-blocked terminal; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('GENERIC: order-independent verdict — same graph, TodoWrite order B,A,T', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '2', content: 'cross-blocked task B', status: 'in_progress', blockedBy: ['1'] },
        { id: '1', content: 'cross-blocked task A', status: 'pending', blockedBy: ['2', '3'] },
        { id: '3', content: 'owner picks the terminal', status: 'in_progress', metadata: { blockedOn: 'owner' } },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `same graph, different TodoWrite order, must give the same verdict; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('GENERIC: A blockedBy an unblocked open B -> A excluded, B listed', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'genuinely blocked A', status: 'pending', blockedBy: ['2'] },
        { id: '2', content: 'genuinely unblocked B', status: 'in_progress' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected the generic nudge; got ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /genuinely unblocked B/);
    assert.doesNotMatch(r.json.reason, /genuinely blocked A/);
  } finally {
    h.cleanup();
  }
});

// ---- TASK-LIST EPOCH (0.117 field report): a restart/usage-limit resume
// resets the harness's native task store, but a stale id from the PREVIOUS
// process was still sitting in the scan window with nothing to trigger the
// pre-existing "ids restarted at #1" reset. ----

function taskUpdateEntry(tuid, input) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'TaskUpdate', input }] },
  };
}
function toolResult(tuid, text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: text }] },
  };
}
function taskListCall(tuid) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'TaskList', input: {} }] },
  };
}
function taskGetCall(tuid, taskId) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'TaskGet', input: { taskId } }] },
  };
}

test('EPOCH RESET: a TaskList "No tasks found" result drops every task seen before it', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      // PREVIOUS process left #3 in_progress in the scan window.
      taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
      // The harness restarted / resumed: TaskList now reports the store empty.
      taskListCall('toolu_l1'),
      toolResult('toolu_l1', 'No tasks found'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow after epoch reset; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// TOKEN-SAVING LEVER 2 (0.117.0, guards.pruneCompletedTasksAfter): advisory
// (never a block of its own) once completed/cancelled tasks exceed the
// threshold (default 10).
// ---------------------------------------------------------------------------

function completedTodos(n) {
  const todos = [];
  for (let i = 0; i < n; i++) todos.push({ id: 'c' + i, content: 'done task ' + i, status: 'completed' });
  return todos;
}

test('PRUNE ADVISORY: > 10 completed tasks -> one-line advisory printed, no block of its own', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([todoWrite(completedTodos(11))]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `all-completed tasks must never block; got ${JSON.stringify(r.json)}`);
    assert.match(r.stdout, /\[task-guard\] 11 completed\/cancelled tasks/);
    assert.match(r.stdout, /prune them with/i);
  } finally {
    h.cleanup();
  }
});

test('EPOCH RESET: a "Task not found" result (TaskGet/TaskUpdate on a stale id) drops every task seen before it', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
      taskGetCall('toolu_g1', '3'),
      toolResult('toolu_g1', 'Task #3 not found'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow after epoch reset; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRUNE ADVISORY: exactly 10 completed tasks (at threshold, not over) -> no advisory', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([todoWrite(completedTodos(10))]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.doesNotMatch(r.stdout, /\[task-guard\].*completed\/cancelled/);
  } finally {
    h.cleanup();
  }
});

test('EPOCH RESET: a fresh TaskCreate after the reset is still tracked normally', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
      taskListCall('toolu_l1'),
      toolResult('toolu_l1', 'No tasks found'),
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_c1', name: 'TaskCreate', input: { subject: 'fresh work after resume' } }] },
      },
      toolResult('toolu_c1', 'Task #1 created successfully: fresh work after resume'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected block on the fresh post-reset task; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /fresh work after resume/);
    assert.doesNotMatch(r.json.reason, /"3"\s*\[/);
  } finally {
    h.cleanup();
  }
});

// ---- deadly-loop round-1 finding (2): text content alone is not proof of
// which tool produced it — only a REAL TaskList/TaskGet/TaskUpdate result
// may reset the reconstructed task map, and "Task not found" drops only the
// one stale id, never the whole map. ----

function bashCall(tuid, command) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'Bash', input: { command } }] },
  };
}

test('EPOCH RESET regression: a Bash result that merely PRINTS "No tasks found" does not wipe the task map', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
      bashCall('toolu_b1', 'echo "No tasks found"'),
      toolResult('toolu_b1', 'No tasks found'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `a Bash result must not silence IDLE NEGLECT for task 3; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('EPOCH RESET regression: a TaskGet on a mistyped/stale id drops only that id, leaving other open tasks tracked', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
      taskUpdateEntry('toolu_u4', { taskId: '4', status: 'in_progress' }),
      taskGetCall('toolu_g1', '3'),
      toolResult('toolu_g1', 'Task not found'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `task 4 must still be reported open; stdout: ${r.stdout}`);
    assert.doesNotMatch(r.json.reason, /"3"/, 'task 3 (the stale id) must be dropped');
  } finally {
    h.cleanup();
  }
});

// ---- SUBJECT UNKNOWN (0.117 field report): the UserPromptSubmit/Stop nudge
// printed the bare task id where the subject should be, e.g.
// `oldest in_progress subject: "3"`. ----

test('SUBJECT UNKNOWN: a TaskUpdate-only task (no TaskCreate in window) is named "(subject unknown)", never the bare id', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      taskUpdateEntry('toolu_u3', { taskId: '3', status: 'in_progress' }),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected the generic nudge; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /\(subject unknown\)/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /"3"\s*\[/, r.json.reason);
  } finally {
    h.cleanup();
  }
});

// ---- DEVSWARM CHILD ATTENDANCE (owner naming a mesh child workspace): an
// in_progress task delegated to a child workspace over the mesh has no local
// ~/.anti-hall/agents/ heartbeat (agentsRunning() never sees it), so before
// this fix it false-blocked/nudged as if neglected. devswarmChildAttended()
// consults the DevSwarm app's own database (companion/lib/devswarm-app-db.js
// appArchivedVerdict — the same ground-truth reader devswarm-parent-gate.js
// uses) to tell a LIVE child from an ARCHIVED/unknown one. ----

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skipSqlite = sqlite ? false : 'node:sqlite unavailable';

// devswarmAppDbFixture() -> { dbFile, env } — a throwaway app DB with one LIVE
// builder (b-active: isActive=1, isHidden=0) and one ARCHIVED builder
// (b-archived: isActive=0, isHidden=1). env points ANTIHALL_DEVSWARM_APP_DB at
// it with caching disabled, matching tests/companion/devswarm-app-db.test.js's
// own fixture pattern.
function devswarmAppDbFixture(h) {
  const fs = require('node:fs');
  const path = require('node:path');
  const dbFile = path.join(h.home, 'app-devswarm.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
  const ins = db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)');
  ins.run('b-active', 'r1', path.join(h.home, 'wt-active'), 0, 1);
  ins.run('b-archived', 'r1', path.join(h.home, 'wt-archived'), 1, 0);
  db.close();
  return { dbFile, env: { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' } };
}

test('ATTENDED: in_progress task owned by a LIVE devswarm child workspace -> no block', { skip: skipSqlite }, () => {
  const h = makeHome();
  try {
    const f = devswarmAppDbFixture(h);
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'delegated to the child', status: 'in_progress', owner: 'b-active' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: f.env });
    assert.ok(!isBlock(r), `a live devswarm child owner must not block; reason: ${r.json && r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('STILL BLOCKS: owner names an ARCHIVED devswarm workspace', { skip: skipSqlite }, () => {
  const h = makeHome();
  try {
    const f = devswarmAppDbFixture(h);
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'delegated to a dead child', status: 'in_progress', owner: 'b-archived' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: f.env });
    assert.ok(isBlock(r), `an archived devswarm child owner must still block; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('STILL BLOCKS: owner names an UNKNOWN workspace id', { skip: skipSqlite }, () => {
  const h = makeHome();
  try {
    const f = devswarmAppDbFixture(h);
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'delegated to nobody the app knows', status: 'in_progress', owner: 'b-nonexistent' },
      ]),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: f.env });
    assert.ok(isBlock(r), `an unknown workspace owner must still block; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('STILL BLOCKS: devswarm registry unreadable (no app DB) -> fail-open to the pre-existing block', { skip: skipSqlite }, () => {
  const h = makeHome();
  try {
    const path = require('node:path');
    const tp = h.writeTranscript([
      todoWrite([
        { id: '1', content: 'delegated, but no app DB to check', status: 'in_progress', owner: 'b-active' },
      ]),
    ]);
    // Point at a DB file that does not exist -> appArchivedVerdict returns null.
    const env = { ANTIHALL_DEVSWARM_APP_DB: path.join(h.home, 'missing.db'), ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env });
    assert.ok(isBlock(r), `an unreadable registry must fail open to the current block behavior; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRUNE ADVISORY: guards.pruneCompletedTasksAfter env override lowers the threshold', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([todoWrite(completedTodos(3))]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home, env: { ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER: '2' } });
    assert.match(r.stdout, /\[task-guard\] 3 completed\/cancelled tasks/);
  } finally {
    h.cleanup();
  }
});
