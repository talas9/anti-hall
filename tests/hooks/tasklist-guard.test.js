'use strict';
// tasklist-guard (Stop hook). Enforces: non-trivial work (>= threshold
// file-mutating actions) must be TRACKED (TaskCreate/TaskUpdate/TodoWrite) AND
// have a fresh per-session progress file in cwd. Block => stdout {decision:'block'}
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

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function safeSession(session) {
  const safe = String(session || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe || 'unknown-session';
}

function progressRel(session = 't', date = todayUtc()) {
  return path.join('.anti-hall', 'progress', date, safeSession(session) + '.md');
}

function progressPath(home, session = 't', date = todayUtc()) {
  return path.join(home, progressRel(session, date));
}

function historyRel(session = 't', date = todayUtc()) {
  return path.join('.anti-hall', 'history', date, safeSession(session) + '.md');
}

function historyPath(home, session = 't', date = todayUtc()) {
  return path.join(home, historyRel(session, date));
}

function writeHistory(home, session = 't') {
  const p = historyPath(home, session);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '# history\n- v0.0.0 -- fix: something. Cause/Fix/Verified.\n', 'utf8');
  return p;
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
// Like taskCreate but sets priority via metadata (harness convention: input.metadata.priority).
function taskCreateP(id, subject, status, priority) {
  const tuId = 'toolu_tc' + id;
  const lines = [{
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', id: tuId, input: { subject, status, metadata: { priority } } }] },
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

function writeProgress(home, mtimeMs, session = 't') {
  const p = progressPath(home, session);
  fs.mkdirSync(path.dirname(p), { recursive: true });
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

test('ALLOW: fresh session below threshold without per-session progress file', () => {
  const h = makeHome();
  try {
    const session = 'fresh-below-threshold';
    const tp = h.writeTranscript(edits(1));
    const r = testHook(HOOK, stopPayload(tp, h.home, session), { home: h.home });
    assert.ok(!isBlock(r), `below-threshold session must allow; stdout: ${r.stdout}`);
    assert.ok(!fs.existsSync(progressPath(h.home, session)), 'test setup must not create progress file');
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

test('REMINDER mentions the per-session history fix-ledger discipline when it fires', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(4));
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /\.anti-hall\/history\/\d{4}-\d{2}-\d{2}\/t\.md/);
    assert.match(r.json.reason, /Cause/);
    assert.match(r.json.reason, /Fix/);
    assert.match(r.json.reason, /Verified/);
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

test('BLOCK: missing per-session progress (4 edits + completed task) includes exact path', () => {
  const h = makeHome();
  try {
    const session = 'actual-session-42';
    const expected = progressRel(session);
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home, session), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /missing or stale/i);
    assert.ok(r.json.reason.includes(expected), `reason must include exact path ${expected}; got ${r.json.reason}`);
  } finally { h.cleanup(); }
});

test('BLOCK: stale per-session progress (4 edits + completed task + old-mtime progress)', () => {
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

test('ALLOW: fresh per-session progress avoids progress-freshness block', () => {
  const h = makeHome();
  try {
    const session = 'fresh-progress-session';
    writeProgress(h.home, null, session);
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home, session), { home: h.home });
    assert.ok(!isBlock(r), `fresh progress must allow; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('INDEX: same session fresh progress appends one progress index line only', () => {
  const h = makeHome();
  try {
    const session = 'index-session';
    writeProgress(h.home, null, session);
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const payload = stopPayload(tp, h.home, session);
    const r1 = testHook(HOOK, payload, { home: h.home });
    const r2 = testHook(HOOK, payload, { home: h.home });
    assert.ok(!isBlock(r1), `first run must allow; stdout: ${r1.stdout}`);
    assert.ok(!isBlock(r2), `second run must allow; stdout: ${r2.stdout}`);

    const indexPath = path.join(h.home, '.anti-hall', 'progress', 'INDEX.md');
    const index = fs.readFileSync(indexPath, 'utf8');
    const lines = index.split(/\r?\n/).filter((line) => line.includes(session));
    assert.deepStrictEqual(lines, [
      '- ' + todayUtc() + ' · ' + session + ' · [progress](../' + todayUtc() + '/' + session + '.md)',
    ]);
  } finally { h.cleanup(); }
});

test('HISTORY INDEX: a session with its own history file gets exactly one history index line', () => {
  const h = makeHome();
  try {
    const session = 'index-history-session';
    writeProgress(h.home, null, session);
    writeHistory(h.home, session);
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const payload = stopPayload(tp, h.home, session);
    const r1 = testHook(HOOK, payload, { home: h.home });
    const r2 = testHook(HOOK, payload, { home: h.home });
    assert.ok(!isBlock(r1), `first run must allow; stdout: ${r1.stdout}`);
    assert.ok(!isBlock(r2), `second run must allow; stdout: ${r2.stdout}`);

    const indexPath = path.join(h.home, '.anti-hall', 'history', 'INDEX.md');
    const index = fs.readFileSync(indexPath, 'utf8');
    const lines = index.split(/\r?\n/).filter((line) => line.includes(session));
    assert.deepStrictEqual(lines, [
      '- ' + todayUtc() + ' · ' + session + ' · [history](../' + todayUtc() + '/' + session + '.md)',
    ]);
  } finally { h.cleanup(); }
});

test('HISTORY INDEX: no history file yet -> no history index created, and it never affects blocking', () => {
  const h = makeHome();
  try {
    const session = 'no-history-yet-session';
    writeProgress(h.home, null, session); // fresh progress, no history file at all
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'do the work', 'completed'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home, session), { home: h.home });
    assert.ok(!isBlock(r), `absent history must never block; stdout: ${r.stdout}`);

    const indexPath = path.join(h.home, '.anti-hall', 'history', 'INDEX.md');
    assert.ok(!fs.existsSync(indexPath), 'history INDEX.md must not be created when no history file exists');
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

test('BLOCK: MULTIPLE in_progress + NO live agent (2 in_progress, fresh progress) — FIX 2/3', () => {
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
    // No ~/.anti-hall/agents heartbeat => agentsRunning() false => the 2 in_progress
    // are genuinely STALLED, so the block fires (new FIX-3 text, not the old serialize text).
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(isBlock(r), `expected block (no live agent); stdout: ${r.stdout}`);
    assert.match(r.json.reason, /in_progress but NO background agent is live|STALLED/i);
    assert.doesNotMatch(r.json.reason, /keep one task in_progress at a time/i); // no serialize advice
  } finally { h.cleanup(); }
});

test('ALLOW: MULTIPLE in_progress WITH a live agent heartbeat — FIX 3 (parallel work is OK)', () => {
  const h = makeHome();
  try {
    writeProgress(h.home);
    // Simulate a live background agent: a FRESH heartbeat under ~/.anti-hall/agents/.
    const agentsDir = path.join(h.antiHall, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'a1.json'), JSON.stringify({ ts: Date.now() }), 'utf8');
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreate(1, 'task one', 'pending'),
      ...taskCreate(2, 'task two', 'pending'),
      taskUpdate(1, 'in_progress'),
      taskUpdate(2, 'in_progress'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    // 2 in_progress is LEGITIMATE parallel work while an agent is live => no multi-in_progress block.
    assert.ok(!isBlock(r), `parallel work with a live agent must NOT block; stdout: ${r.stdout}`);
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
    fs.mkdirSync(progressPath(h.home), { recursive: true });
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

test('FAIL-OPEN: unwritable state dir -> exit 0, no block (FIX: persist-first) — cap safety', () => {
  // Point HOME at a regular FILE so ~/.anti-hall can never be created/written.
  // Without a durable cap state, blocking would loop forever, so the reconciled
  // ordering must fail-OPEN: persist first, and if it throws, emit no block.
  const h = makeHome();
  const fakeHome = path.join(h.home, 'home-is-a-file');
  fs.writeFileSync(fakeHome, 'not a dir', 'utf8');
  try {
    // Build a transcript that WOULD block (4 edits, no tasks, no progress file).
    // The progress-file lookup uses cwd (the real fixture home), not HOME, so the
    // block cause is reached; only the state PERSIST fails (HOME is a file).
    const tp = h.writeTranscript(edits(4));
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: fakeHome });
    assert.strictEqual(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
    assert.ok(!isBlock(r), `unwritable state dir must fail-open (no block); stdout: ${r.stdout}`);
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
  ['mkdir d', 'mkdir d'],
  ['tee f', 'tee f'],
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
  // LIVE false positives from the whole-plugin review (BASH_WORK_RE P1):
  ['stderr redirect (not a file write)', 'ls foo 2>/dev/null'],
  ['quoted redirect char in a --format string', 'git log --format="%an <%ae>"'],
  ['quoted write-verb inside a sentence', 'echo "do not touch this"'],
  ['fd duplication (not a file write)', 'some-cmd 2>&1'],
  ['grep for a bare write-verb word (not command position)', 'grep touch file.txt'],
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

// ---- PRIORITY AWARENESS ----

test('PRIORITY (c): all-P2 in_progress + one P0 actively-in_progress (no live agent, fresh progress) -> no stale-multi block', () => {
  // Scenario: owner is working a P0; two P2/backlog tasks are also in_progress.
  // Only P0/P1 count toward the stale-multi threshold. P0 count = 1, which is
  // the healthy single-in_progress invariant (FIX 2) → no block.
  const h = makeHome();
  try {
    writeProgress(h.home); // fresh + tracked
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreateP(1, 'critical feature', 'pending', 'P0'),
      ...taskCreateP(2, 'backlog item A', 'pending', 'P2'),
      ...taskCreateP(3, 'backlog item B', 'pending', 'P2'),
      taskUpdate(1, 'in_progress'),
      taskUpdate(2, 'in_progress'),
      taskUpdate(3, 'in_progress'),
    ]);
    // No live agent heartbeat; but inProgressCount (P0/P1 only) = 1 → healthy.
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r),
      `P2 in_progress tasks must not count toward stale-multi; P0 alone is healthy; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRIORITY: all-P2 in_progress (no P0/P1), no live agent, fresh progress -> no stale-multi block', () => {
  // Pure P2 backlog in_progress — inProgressCount = 0, well under the > 1 threshold.
  const h = makeHome();
  try {
    writeProgress(h.home);
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreateP(1, 'deferred chore A', 'pending', 'P2'),
      ...taskCreateP(2, 'deferred chore B', 'pending', 'P2'),
      taskUpdate(1, 'in_progress'),
      taskUpdate(2, 'in_progress'),
    ]);
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(!isBlock(r),
      `all-P2 in_progress must not trigger stale-multi; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('PRIORITY: two P0/P1 in_progress, no live agent, fresh progress -> stale-multi block still fires', () => {
  // Confirm that priority filter doesn't suppress the stale-multi check when two
  // HIGH-priority tasks are genuinely dangling with no agent running.
  const h = makeHome();
  try {
    writeProgress(h.home);
    const tp = h.writeTranscript([
      ...edits(4),
      ...taskCreateP(1, 'urgent task A', 'pending', 'P0'),
      ...taskCreateP(2, 'urgent task B', 'pending', 'P1'),
      taskUpdate(1, 'in_progress'),
      taskUpdate(2, 'in_progress'),
    ]);
    // inProgressCount = 2 (both P0/P1) and no live agent → stale-multi block.
    const r = testHook(HOOK, stopPayload(tp, h.home), { home: h.home });
    assert.ok(isBlock(r),
      `two P0/P1 in_progress with no live agent must still trigger stale-multi; stdout: ${r.stdout}`);
    assert.match(r.json.reason, /in_progress but NO background agent is live|STALLED/i);
  } finally {
    h.cleanup();
  }
});
