'use strict';
// target-session: worktree + published sessionId -> ONE live HEADLESS claude pid,
// or ABSTAIN. All process/fs access is injected, so these are pure unit tests.
// The load-bearing cases are the confirm-gate counter-examples: (1) a stale
// bootstrap wrapper sharing cwd + the session-id STRING forces >1 candidate ->
// abstain; (2) a lone INTERACTIVE `claude --resume <uuid>` (a human takeover, no
// -p) -> abstain; (3) a candidate whose argv uuid != descriptor.sessionId ->
// abstain; (4) the supervisor's own pid / a descendant -> excluded.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'target-session.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_UUID = 'ffffffff-1111-2222-3333-444444444444';
const WT = '/Users/dev/work/wt-1';
const SELF = 999999; // a fake supervisor pid the tests can never collide with

// Build a runners object from a proc list + a cwd map + a transcript-exists set.
function mkRunners({ psLines, cwdByPid, transcripts }) {
  return {
    ps: () => psLines.join('\n') + '\n',
    cwdOf: (pid) => (pid in cwdByPid ? cwdByPid[pid] : null),
    transcriptExists: (dir, uuid) => transcripts.has(dir + '::' + uuid),
  };
}
// Every findTarget call binds an explicit sessionId + selfPid so the tests are
// hermetic (never depend on the real process.pid).
function find(runners, over) {
  return M.findTarget(Object.assign({ worktreePath: WT, sessionId: UUID, home: '/home/x', selfPid: SELF, runners }, over || {}));
}

test('encodeWorktreePath: every / and . -> - (lossy, forward-only)', () => {
  assert.strictEqual(M.encodeWorktreePath('/Users/dev/work/app.v2'), '-Users-dev-work-app-v2');
  assert.strictEqual(M.encodeWorktreePath('/a.b/c'), '-a-b-c');
});

test('projectDirFor: joins encoded path under ~/.claude/projects', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  assert.strictEqual(dir, path.join('/home/x', '.claude', 'projects', '-Users-dev-work-wt-1'));
});

test('parseSessionArg: extracts uuid from --session-id and --resume', () => {
  assert.strictEqual(M.parseSessionArg('claude -p --session-id ' + UUID), UUID);
  assert.strictEqual(M.parseSessionArg('claude --resume ' + UUID + ' --dangerously-skip-permissions'), UUID);
  assert.strictEqual(M.parseSessionArg('claude -p'), null);
  assert.strictEqual(M.parseSessionArg('vim ' + UUID + '.jsonl'), null); // uuid without a session flag
});

test('isHeadless: -p / --print => true; interactive resume => false', () => {
  assert.strictEqual(M.isHeadless('claude -p --resume ' + UUID), true);
  assert.strictEqual(M.isHeadless('claude --print --resume ' + UUID), true);
  assert.strictEqual(M.isHeadless('claude --resume ' + UUID), false);       // interactive takeover
  assert.strictEqual(M.isHeadless('claude --session-id ' + UUID), false);
});

test('parsePs: parses pid/ppid/command triples', () => {
  const rows = M.parsePs('  100 1 claude --resume ' + UUID + '\n 200 100 node mcp\n');
  assert.deepStrictEqual(rows, [
    { pid: 100, ppid: 1, cmd: 'claude --resume ' + UUID },
    { pid: 200, ppid: 100, cmd: 'node mcp' },
  ]);
});

test('candidatesFromPs: only claude+session-flag; tags headless', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: 'claude -p --resume ' + UUID },
    { pid: 2, ppid: 0, cmd: 'node /x/mcp-server.js --resume ' + UUID }, // not claude
    { pid: 3, ppid: 0, cmd: 'claude -p' },                              // no session flag
    { pid: 4, ppid: 0, cmd: 'claude --resume ' + UUID },               // interactive (no -p)
  ];
  const c = M.candidatesFromPs(procs);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c.map((x) => x.pid), [1, 4]);
  assert.strictEqual(c.find((x) => x.pid === 1).headless, true);
  assert.strictEqual(c.find((x) => x.pid === 4).headless, false);
});

test('descendantsOf: collects the whole subtree of a root pid', () => {
  const procs = [
    { pid: 10, ppid: 1, cmd: 'a' },
    { pid: 11, ppid: 10, cmd: 'b' },
    { pid: 12, ppid: 11, cmd: 'c' },
    { pid: 20, ppid: 1, cmd: 'd' },
  ];
  const set = M.descendantsOf(procs, 10);
  assert.ok(set.has(11) && set.has(12));
  assert.ok(!set.has(20));
});

test('findTarget: exactly one confirmed headless candidate -> target', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID + ' --dangerously-skip-permissions'],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, undefined);
  assert.strictEqual(r.pid, 100);
  assert.strictEqual(r.uuid, UUID);
});

test('CONFIRM-GATE: wrapper sharing cwd + uuid string -> 2 candidates -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: [
      '100 1  claude -p --resume ' + UUID + ' --dangerously-skip-permissions',
      '90 1   sh -c claude -p --resume ' + UUID, // stale bootstrap wrapper, same cwd + uuid, also headless
    ],
    cwdByPid: { 100: WT, 90: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'multiple-candidates');
  assert.strictEqual(r.candidates.length, 2);
});

test('IDENTITY-BINDING: a human takeover — interactive `claude --resume <uuid>` in the cwd -> ABSTAIN, never a kill', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude --resume ' + UUID], // NO -p: a person rescuing the worktree by hand
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'interactive-candidate');
});

test('IDENTITY-BINDING: argv uuid != descriptor.sessionId -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + OTHER_UUID], // different session entirely
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + OTHER_UUID, dir + '::' + UUID]),
  });
  const r = find(runners); // sessionId defaults to UUID
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: missing sessionId -> ABSTAIN (cannot identity-bind)', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners, { sessionId: '' });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-session-id');
});

test('SELF-EXCLUSION: a candidate that IS the supervisor pid is excluded -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: [SELF + ' 1 claude -p --resume ' + UUID],
    cwdByPid: { [SELF]: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('SELF-EXCLUSION: a candidate in the supervisor process tree is excluded -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: [
      SELF + ' 1 node supervisor',
      '100 ' + SELF + ' claude -p --resume ' + UUID, // direct child of the supervisor
    ],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: zero candidates -> ABSTAIN (no-candidate)', () => {
  const runners = mkRunners({ psLines: ['1 0 launchd'], cwdByPid: {}, transcripts: new Set() });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: candidate cwd mismatch -> excluded -> ABSTAIN', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: '/some/other/dir' }, // wrong cwd
    transcripts: new Set([dir + '::' + UUID]),
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('findTarget: transcript file missing -> excluded -> ABSTAIN', () => {
  const runners = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: WT },
    transcripts: new Set(), // no <dir>/<sessionId>.jsonl
  });
  const r = find(runners);
  assert.strictEqual(r.ambiguous, true);
});

test('findTarget: no worktreePath -> abstain (never throws)', () => {
  const r = find(mkRunners({ psLines: [], cwdByPid: {}, transcripts: new Set() }), { worktreePath: '' });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-worktree-path');
});

test('findTarget: a throwing ps runner -> abstain (fail-open)', () => {
  const r = find({ ps: () => { throw new Error('boom'); }, cwdOf: () => null, transcriptExists: () => false });
  assert.strictEqual(r.ambiguous, true);
});

test('findTarget: empty ps output (a timed-out probe = NO DATA) -> abstain, never kill', () => {
  // P1-8: a hung/timed-out ps returns '' in the default runner. No data must map
  // to abstain (no-candidate) — never a kill on an incomplete enumeration.
  const r = find(mkRunners({ psLines: [], cwdByPid: {}, transcripts: new Set() }));
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.reason, 'no-candidate');
});

test('verifyTarget: fresh re-derivation confirms the same pid/uuid, else false (TOCTOU seam)', () => {
  const dir = M.projectDirFor(WT, '/home/x');
  const good = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: WT },
    transcripts: new Set([dir + '::' + UUID]),
  });
  assert.strictEqual(M.verifyTarget({ worktreePath: WT, sessionId: UUID, home: '/home/x', selfPid: SELF, runners: good, pid: 100, uuid: UUID }), true);
  // pid recycled to a process in a different cwd -> no longer confirmable.
  const recycled = mkRunners({
    psLines: ['100 1 claude -p --resume ' + UUID],
    cwdByPid: { 100: '/some/other/dir' },
    transcripts: new Set([dir + '::' + UUID]),
  });
  assert.strictEqual(M.verifyTarget({ worktreePath: WT, sessionId: UUID, home: '/home/x', selfPid: SELF, runners: recycled, pid: 100, uuid: UUID }), false);
});
