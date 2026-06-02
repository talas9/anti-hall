'use strict';
// tasklist-guard (Stop hook). Enforces: non-trivial work (>= threshold
// file-mutating actions) must be TRACKED (TaskCreate/TaskUpdate/TodoWrite) AND
// have a fresh .anti-hall-progress.md in cwd. Block => stdout {decision:'block'}
// + exit 0 (NOT exit 2). State: ~/.anti-hall/tasklist-guard-state-<session>.json.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'tasklist-guard.js';

// cwd defaults to the fake home so the progress-file lookup is isolated per test.
function stopPayload(transcriptPath, cwd, session = 't') {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, cwd, session_id: session };
}

function edit(i) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'toolu_e' + i, input: { file_path: '/x/f' + i } }] },
  };
}
function edits(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(edit(i));
  return a;
}
// TaskCreate tool_use + its tool_result (carries the numeric id) so the parser
// can reconstruct task state with the given status.
function taskCreate(id, subject, status) {
  const tuId = 'toolu_tc' + id;
  const lines = [{
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', id: tuId, input: { subject, status } }] },
  }, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuId, content: 'Task #' + id + ' created successfully: ' + subject }] },
  }];
  return lines;
}
function taskUpdate(id, status) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskUpdate', id: 'toolu_tu' + id, input: { taskId: String(id), status } }] },
  };
}

function writeProgress(home, mtimeMs) {
  const p = path.join(home, '.anti-hall-progress.md');
  fs.writeFileSync(p, '# progress\n- done: x\n- next: y\n', 'utf8');
  if (mtimeMs != null) {
    const sec = mtimeMs / 1000;
    fs.utimesSync(p, sec, sec);
  }
  return p;
}

// A Bash tool_use carrying `cmd`. The hook counts it as +1 work iff the command
// matches BASH_WORK_RE (the fail-open mutating-command heuristic).
function bash(i, cmd) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_b' + i, input: { command: cmd } }] },
  };
}
// n copies of the same Bash command -> n work points (when the command matches).
function bashes(cmd, n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(bash(i, cmd));
  return a;
}

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

test('ALLOW: trivial session (1 edit, below threshold)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(1));
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r), `expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('BLOCK: no tasklist (4 edits, no task activity, no progress file)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(4));
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /tracked\s+NO\s+tasks/i);
  } finally { h.cleanup(); }
});

test('ALLOW: tracked + fresh progress (4 edits + TaskCreate completed + fresh progress)', () => {
  const h = makeHome();
  try {
    writeProgress(h.home); // mtime = now -> fresh
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r), `expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('BLOCK: stale progress (4 edits + completed task + old-mtime progress)', () => {
  const h = makeHome();
  try {
    // mtime 10 min in the past; tiny fresh-window so it reads as stale.
    writeProgress(h.home, Date.now() - 10 * 60 * 1000);
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home, env: { ANTIHALL_PROGRESS_FRESH_MS: '1000' } });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /missing or stale/i);
  } finally { h.cleanup(); }
});

test('ALLOW: single in_progress is healthy (4 edits + 1 in_progress, fresh progress) — FIX 2', () => {
  const h = makeHome();
  try {
    writeProgress(h.home); // fresh + tracked + only ONE in_progress => no block cause
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'pending'),
      taskUpdate(1, 'in_progress'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r), `single in_progress is the healthy invariant; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('BLOCK (not due to staleness): single in_progress + 4 edits + NO progress file — FIX 2', () => {
  const h = makeHome();
  try {
    // No progress file written -> the block cause is the missing/stale progress
    // file, NOT staleInProgress (a lone in_progress is healthy under FIX 2).
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'pending'),
      taskUpdate(1, 'in_progress'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(isBlock(r), `expected block (no progress file); stdout: ${r.stdout}`);
    assert.match(r.json.reason, /missing or stale/i);
    assert.doesNotMatch(r.json.reason, /Multiple tasks are in_progress/i);
  } finally { h.cleanup(); }
});

test('BLOCK: MULTIPLE in_progress at once (2 in_progress, fresh progress) — FIX 2', () => {
  const h = makeHome();
  try {
    writeProgress(h.home); // fresh + tracked, so the sub-cause is multi-in_progress
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'task one', 'pending'),
      ...taskCreate(2, 'task two', 'pending'),
      taskUpdate(1, 'in_progress'),
      taskUpdate(2, 'in_progress'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /Multiple tasks are in_progress/i);
  } finally { h.cleanup(); }
});

test('DEDUP: same transcript twice -> 2nd Stop allows (no churn re-block)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(4));
    const p = stopPayload(tp, h.home);
    const r1 = testHook(HOOK, p, { home: h.home });
    assert.ok(isBlock(r1), `1st should block; stdout: ${r1.stdout}`);
    const r2 = testHook(HOOK, p, { home: h.home });
    assert.ok(!isBlock(r2), `2nd (identical signal) should allow; stdout: ${r2.stdout}`);
  } finally { h.cleanup(); }
});

test('CAP: never blocks more than MAX_BLOCKS (3) across changing signals', () => {
  const h = makeHome();
  try {
    let blocks = 0;
    // Each round adds more edits so WORK_COUNT bucket changes -> defeats hash
    // dedup -> exercises the hard cap.
    for (let round = 0; round < 6; round++) {
      const tp = h.writeTranscript(edits(4 + round * 4));
      const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
      if (isBlock(r)) blocks++;
    }
    assert.ok(blocks <= 3, `expected <= 3 blocks, got ${blocks}`);
    assert.ok(blocks >= 1, `expected at least 1 block, got ${blocks}`);
  } finally { h.cleanup(); }
});

test('ESCAPE HATCH: skip.json {tasklist-guard: future} -> allow', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'tasklist-guard': Date.now() + 600000 });
    const tp = h.writeTranscript(edits(4));
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r), `skip active; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ESCAPE HATCH: skip.json {all: future} -> allow (non-destructive guard)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ all: Date.now() + 600000 });
    const tp = h.writeTranscript(edits(4));
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r), `all-skip active; expected allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('LOOP-SAFE: cumulative cap — >3 DISTINCT blocking signals stop after MAX_BLOCKS total', () => {
  const h = makeHome();
  try {
    // Drive 6 Stops, each with a DIFFERENT work bucket so the signal hash CHANGES
    // every Stop (defeats the hash dedup). The `blocks` counter must be CUMULATIVE
    // per session (climbing across hash churn, never reset on hash change), so the
    // hook stops blocking after exactly MAX_BLOCKS=3 TOTAL blocks regardless of how
    // many distinct signals arrive. This is what makes loops impossible without
    // any stop_hook_active early-exit.
    const results = [];
    for (let round = 0; round < 6; round++) {
      // 4, 8, 12, ... edits -> distinct work bucket -> distinct hash each Stop.
      const tp = h.writeTranscript(edits(4 + round * 4));
      const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
      results.push(Boolean(isBlock(r)));
    }
    const totalBlocks = results.filter(Boolean).length;
    assert.strictEqual(totalBlocks, 3, `cumulative cap must be exactly MAX_BLOCKS=3; got ${totalBlocks} (${results})`);
    // And the cap must be the FIRST three (cumulative), not scattered: once capped, stays quiet.
    assert.deepStrictEqual(results, [true, true, true, false, false, false], `expected first-3-block then quiet; got ${results}`);
  } finally { h.cleanup(); }
});

test('BLOCK: progress file that is a DIRECTORY -> not fresh — FIX 4', () => {
  const h = makeHome();
  try {
    // Create a DIRECTORY named like the progress file. A dir mtime always looks
    // fresh; lstat + isFile() must reject it so the block still fires.
    fs.mkdirSync(path.join(h.home, '.anti-hall-progress.md'));
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(isBlock(r), `dir-as-progress must read as not-fresh; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /missing or stale/i);
  } finally { h.cleanup(); }
});

test('ALLOW: a real fresh regular progress file -> allow — FIX 4', () => {
  const h = makeHome();
  try {
    writeProgress(h.home); // real regular file, mtime now
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r), `real fresh file must allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: cwd points at a nonexistent dir -> progressFresh, no progress-cause block — FIX 5', () => {
  const h = makeHome();
  try {
    // 4 edits + a completed task (so sawTaskActivity true, no multi-in_progress);
    // the ONLY remaining possible block cause would be progress freshness, which
    // must fail-open when cwd is unreadable -> no block.
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const missingCwd = path.join(h.home, 'does', 'not', 'exist');
    const r = testHook(HOOK, stopPayload(tp, missingCwd), { home: h.home });
    assert.ok(!isBlock(r), `missing cwd must fail-open on freshness; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: empty stdin -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: no transcript_path -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, { hook_event_name: 'Stop', cwd: h.home, session_id: 't' }, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!isBlock(r));
  } finally { h.cleanup(); }
});

// --- FIX B: Bash mutating-command regex coverage (driven through the hook) -----
// Each MATCH command, repeated 4x (>= threshold) with NO task activity and NO
// progress file, must count as work and BLOCK. Each NO-MATCH command, even
// repeated 4x, must NOT count as work -> stays below threshold -> ALLOW. (Use a
// distinct session per case so loop-state never cross-contaminates.)
const BASH_MATCH = [
  ['git commit', 'git commit -m "wip"'],
  ['rm at start', 'rm tmpfile'],
  ['rm after &&', 'ls && rm tmpfile'],
  ['rm in $()', 'echo $(rm tmpfile)'],
  ['rm in backticks', 'echo `rm tmpfile`'],
  ['rm after newline', 'echo ok\nrm tmpfile'],
  ['rm in subshell', '(rm tmpfile)'],
  ['git rebase', 'git rebase main'],
  ['git checkout', 'git checkout main'],
  ['touch x', 'touch x'],
  ['make build', 'make build'],
  ['chmod +x', 'chmod +x script.sh'],
  ['sed -i', 'sed -i s/a/b/ file'],
  ['pnpm add', 'pnpm add lodash'],
  ['cat x > out.txt', 'cat x > out.txt'],
  ['echo y >> log', 'echo y >> log'],
];
for (const [label, cmd] of BASH_MATCH) {
  test(`FIX B MATCH: 4x \`${label}\` (no tasks/progress) -> block`, () => {
    const h = makeHome();
    try {
      const tp = h.writeTranscript(bashes(cmd, 4));
      const r = testHook(HOOK, stopPayload(tp, h.home, 'm-' + label.replace(/\W/g, '')), { home: h.home });
      assert.ok(isBlock(r), `\`${cmd}\` should count as Bash work -> block; stdout: ${r.stdout}`);
    } finally { h.cleanup(); }
  });
}

const BASH_NOMATCH = [
  ['quoted rm', 'echo "please rm this"'],
  ['cp in path', 'ls /cp/path'],
  ['grep mv', 'grep mv file'],
  ['git status', 'git status'],
  ['plain ls', 'ls'],
];
for (const [label, cmd] of BASH_NOMATCH) {
  test(`FIX B NO-MATCH: 4x \`${label}\` -> below threshold -> allow`, () => {
    const h = makeHome();
    try {
      const tp = h.writeTranscript(bashes(cmd, 4));
      const r = testHook(HOOK, stopPayload(tp, h.home, 'n-' + label.replace(/\W/g, '')), { home: h.home });
      assert.ok(!isBlock(r), `\`${cmd}\` must NOT count as work -> allow; stdout: ${r.stdout}`);
    } finally { h.cleanup(); }
  });
}
