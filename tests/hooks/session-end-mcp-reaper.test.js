'use strict';
// session-end-mcp-reaper.test.js — pure-function tests over an injected fake
// `ps` fixture (same pattern as tests/hooks/doctor-repair-orphaned-mcp-broker.test.js).
// Never spawns a real process; kill/term stubbed via killFn; stdin injected
// via `stdinRaw` (never the real fd 0, which would block in a test harness
// with no EOF); age lookups injected via `getAges`/`etimesExec`/`lstartExec`
// (never a real `ps -o etimes=`/`ps -o lstart=` call); managed-service checks
// injected via `platform`/`launchctlList`/`readCgroup` (never a real
// `launchctl list` or `/proc/<pid>/cgroup` read).
//
// Every test NOT specifically exercising the F1 launchd/systemd-managed
// narrowing passes `platform: NOOP_PLATFORM` — an inert value that is neither
// 'darwin' nor 'linux', so filterManagedServices takes its no-op pass-through
// branch and never touches the real machine's `launchctl`/`/proc`. Without
// this, every pre-existing test would silently depend on THIS machine's real
// `launchctl list` output, which is exactly the flakiness this suite must
// avoid.
//
// ROUND 3 REBUILD: a live `claude -p` probe (2026-09-05, real stdio MCP
// server, sampled every 500ms) showed Claude Code reaps its own MCP children
// BEFORE SessionEnd fires on a clean exit (3/3 runs), and SessionEnd does not
// run at all on a SIGKILL crash. The earlier "snapshot this session's live
// children + detached grace child" design (branch a) was therefore dead code
// by construction and has been removed entirely, along with its file and
// tests. This hook now does ONE thing: sweep PID-1-reparented MCP orphans
// left by a PREVIOUS crashed session, on by default.
//
// FINAL REVIEW ROUND (2026-09-05): two additive narrowings for false
// positives on OTHER users' machines (containers, launchd/systemd-managed
// services) — see the F1/F2 sections below.
//
// --- Mutation coverage (documented + proven; RED/GREEN evidence in the task report) ---
// M1: drop the `p.ppid !== 1` check in matchesInvariant. Caught by "a
//     live-parented MCP-signature process is NEVER selected" below.
// M2: drop the `age >= minAgeS` filter in sweepOrphans. Caught by "an orphan
//     younger than the age floor is skipped" below.
// M3 (F2): drop the `isInitPid1` gate at the top of sweepOrphans. Caught by
//     "container entrypoint at PID 1 -> sweep selects NOTHING" below.
// M4 (F1): drop the `filterManagedServices` call (or its darwin branch).
//     Caught by "a launchd-managed candidate is never selected" below.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.join(__dirname, '..', '..');
const HOOK_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'session-end-mcp-reaper.js');
const MCP_REAPER_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'mcp-reaper.js');
const hook = require(HOOK_JS);
const mcpReaper = require(MCP_REAPER_JS);

const NOOP_PLATFORM = 'test-inert-platform';

// Shared DEFAULT test options (P3 hardening, final review round): every
// sweepOrphans/main() call in this suite goes through callSweep/callMain
// below, which merge the caller's opts OVER this default. That way a test
// that forgets to pass `platform` can NEVER fall through to the real
// `process.platform` (darwin on this dev machine) and shell out to the real
// `launchctl` — the pinned default is neither 'darwin' nor 'linux' (inert
// pass-through), and `launchctlList` throws loudly if anything ever calls it
// despite that. The 9 tests that specifically exercise the F1 darwin/linux
// paths override `platform` (and `launchctlList`/`readCgroup` as needed)
// explicitly in their own call, which take precedence via object-spread order.
const DEFAULT_TEST_OPTS = {
  platform: NOOP_PLATFORM,
  launchctlList: () => {
    throw new Error(
      'TEST BUG: launchctl must never be invoked by this suite — a test needs an explicit platform/launchctlList override to exercise the darwin path'
    );
  },
};

function callSweep(procs, opts) {
  return hook.sweepOrphans(procs, mcpReaper, { ...DEFAULT_TEST_OPTS, ...(opts || {}) });
}

function callMain(opts) {
  return hook.main({ ...DEFAULT_TEST_OPTS, ...(opts || {}) });
}

function psLine(pid, ppid, cmd) {
  return `  ${pid}  ${ppid}  ${cmd}`;
}

function mcpChildCmd(name) {
  return `node /Users/example/.codex/mcp-servers/${name}/dist/index.js --stdio`;
}

function fakePsExec(stdout) {
  return () => ({ error: null, status: 0, signal: null, stdout });
}

// A fake age lookup: everything is "old enough" (default test posture) unless
// a test overrides it. Avoids real `ps -o etimes=`/`ps -o lstart=` spawning.
function fakeGetAges(map) {
  return () => new Map(Object.entries(map).map(([pid, age]) => [Number(pid), age]));
}

function tmpLogPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-end-reaper-test-'));
  return { logDir: dir, logFile: path.join(dir, 'session-end-reaper.log') };
}

function readNdjson(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Real observed wire payload (MEASURED 2026-09-05 via `claude -p` probe):
// session_id, transcript_path, cwd, prompt_id, hook_event_name, reason.
function realStdinFor(reason) {
  return JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/tmp/x.jsonl',
    cwd: '/Users/example/project',
    prompt_id: 'prompt-1',
    hook_event_name: 'SessionEnd',
    reason,
  });
}

// -----------------------------------------------------------------------
// extractReason
// -----------------------------------------------------------------------

test('extractReason: reads `reason` (the real wire field) as primary', () => {
  assert.strictEqual(hook.extractReason({ reason: 'other' }), 'other');
});

test('extractReason: falls back to `end_reason` ONLY when `reason` is absent', () => {
  assert.strictEqual(hook.extractReason({ end_reason: 'prompt_input_exit' }), 'prompt_input_exit');
  assert.strictEqual(hook.extractReason({ reason: 'other', end_reason: 'clear' }), 'other');
});

test('extractReason: neither field present -> null', () => {
  assert.strictEqual(hook.extractReason({ session_id: 'x' }), null);
  assert.strictEqual(hook.extractReason(null), null);
});

// -----------------------------------------------------------------------
// age lookup: parseEtimesOutput / parseLstartOutput / getAgesForPids
// -----------------------------------------------------------------------

test('parseEtimesOutput: parses pid + raw seconds lines', () => {
  const out = hook.parseEtimesOutput('  900  120\n  901  30\n');
  assert.strictEqual(out.get(900), 120);
  assert.strictEqual(out.get(901), 30);
});

test('parseLstartOutput: parses pid + lstart date string into an age in seconds', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  const started = 'Sat Sep  5 11:58:00 2026'; // 120s before "now" in local semantics; just assert non-negative + reasonable
  const out = hook.parseLstartOutput(`  900  ${started}`, now);
  assert.ok(out.has(900));
  assert.ok(out.get(900) >= 0);
});

test('parseLstartOutput: unparseable date -> pid absent (unknown)', () => {
  const out = hook.parseLstartOutput('  900  not a date', Date.now());
  assert.strictEqual(out.has(900), false);
});

test('getAgesForPids: etimes succeeds -> used directly, lstart never called', () => {
  let lstartCalled = false;
  const ages = hook.getAgesForPids([900, 901], {
    etimesExec: () => ({ error: null, status: 0, signal: null, stdout: '  900  120\n  901  30\n' }),
    lstartExec: () => {
      lstartCalled = true;
      return { error: null, status: 0, signal: null, stdout: '' };
    },
  });
  assert.strictEqual(ages.get(900), 120);
  assert.strictEqual(ages.get(901), 30);
  assert.strictEqual(lstartCalled, false);
});

test('getAgesForPids: etimes fails (macOS-shaped) -> falls back to lstart', () => {
  const now = Date.now();
  const ages = hook.getAgesForPids([900], {
    etimesExec: () => ({ error: null, status: 1, stdout: '' }), // macOS: "etimes: keyword not found"
    lstartExec: () => ({
      error: null,
      status: 0,
      signal: null,
      stdout: `  900  ${new Date(now - 120000).toString()}`,
    }),
    nowFn: () => now,
  });
  assert.ok(ages.has(900));
  assert.ok(Math.abs(ages.get(900) - 120) <= 2);
});

test('getAgesForPids: both probes fail -> pid absent from map (unknown age)', () => {
  const ages = hook.getAgesForPids([900], {
    etimesExec: () => ({ error: new Error('nope') }),
    lstartExec: () => ({ error: new Error('nope') }),
  });
  assert.strictEqual(ages.has(900), false);
});

// -----------------------------------------------------------------------
// isExcludedRunner
// -----------------------------------------------------------------------

test('isExcludedRunner: vitest/jest/playwright/tsx/ts-node/next dev/webpack all excluded', () => {
  assert.strictEqual(hook.isExcludedRunner('node node_modules/.bin/vitest --run tests/mcp-server.test.ts'), true);
  assert.strictEqual(hook.isExcludedRunner('next dev -p 3000'), true);
  assert.strictEqual(hook.isExcludedRunner(mcpChildCmd('alpha')), false);
});

// -----------------------------------------------------------------------
// F2: isInitPid1 / findPid1Cmd
// -----------------------------------------------------------------------

test('findPid1Cmd: returns the pid=1 row\'s cmd', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 2, ppid: 1, cmd: 'x' }];
  assert.strictEqual(hook.findPid1Cmd(procs), '/sbin/launchd');
});

test('findPid1Cmd: pid 1 absent from snapshot -> null', () => {
  assert.strictEqual(hook.findPid1Cmd([{ pid: 2, ppid: 1, cmd: 'x' }]), null);
});

test('isInitPid1: launchd/systemd/init all recognized as init', () => {
  assert.strictEqual(hook.isInitPid1('/sbin/launchd', mcpReaper), true);
  assert.strictEqual(hook.isInitPid1('/lib/systemd/systemd --system', mcpReaper), true);
  assert.strictEqual(hook.isInitPid1('/sbin/init', mcpReaper), true);
});

test('isInitPid1: a container entrypoint (python) is NOT init', () => {
  assert.strictEqual(hook.isInitPid1('python3 /app/server.py', mcpReaper), false);
});

test('isInitPid1: null/absent cmd -> not init (fail toward doing nothing)', () => {
  assert.strictEqual(hook.isInitPid1(null, mcpReaper), false);
});

// -----------------------------------------------------------------------
// F1: parseLaunchctlListOutput / getLaunchdManagedPids / isSystemdServicePid
// -----------------------------------------------------------------------

test('parseLaunchctlListOutput: parses numeric PID column, skips header and "-" (not running) rows', () => {
  const stdout = 'PID\tStatus\tLabel\n123\t0\tcom.apple.something\n-\t0\tcom.other.notrunning\n456\t0\tcom.another.thing\n';
  const set = hook.parseLaunchctlListOutput(stdout);
  assert.deepStrictEqual([...set].sort((a, b) => a - b), [123, 456]);
});

test('getLaunchdManagedPids: launchctl succeeds -> returns the parsed Set', () => {
  const set = hook.getLaunchdManagedPids({
    launchctlList: () => ({ error: null, status: 0, stdout: '123\t0\tcom.apple.foo\n' }),
  });
  assert.deepStrictEqual([...set], [123]);
});

test('getLaunchdManagedPids: launchctl throws -> null (unverifiable)', () => {
  const set = hook.getLaunchdManagedPids({
    launchctlList: () => {
      throw new Error('boom');
    },
  });
  assert.strictEqual(set, null);
});

test('getLaunchdManagedPids: launchctl exits non-zero -> null (unverifiable)', () => {
  const set = hook.getLaunchdManagedPids({ launchctlList: () => ({ error: null, status: 1, stdout: '' }) });
  assert.strictEqual(set, null);
});

test('isSystemdServicePid: cgroup readable and contains ".service" -> true', () => {
  assert.strictEqual(
    hook.isSystemdServicePid(900, { readCgroup: () => '0::/system.slice/foo.service\n' }),
    true
  );
});

test('isSystemdServicePid: cgroup readable, no ".service" -> false', () => {
  assert.strictEqual(hook.isSystemdServicePid(900, { readCgroup: () => '0::/user.slice/user-1000.slice\n' }), false);
});

test('isSystemdServicePid: cgroup UNREADABLE -> false (fail-SOFT, never skips on unknown)', () => {
  assert.strictEqual(
    hook.isSystemdServicePid(900, {
      readCgroup: () => {
        throw new Error('ENOENT');
      },
    }),
    false
  );
});

test('filterManagedServices: darwin, launchctl succeeds, candidate pid IS managed -> skipped', () => {
  const candidates = [{ pid: 900, ppid: 1, cmd: mcpChildCmd('managed') }];
  const { kept, skipped } = hook.filterManagedServices(candidates, {
    platform: 'darwin',
    launchctlList: () => ({ error: null, status: 0, stdout: '900\t0\tcom.apple.mcp\n' }),
  });
  assert.deepStrictEqual(kept, []);
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].reason, 'launchd-managed');
});

test('filterManagedServices: darwin, launchctl succeeds, candidate pid NOT in the managed set -> kept', () => {
  const candidates = [{ pid: 900, ppid: 1, cmd: mcpChildCmd('unmanaged') }];
  const { kept, skipped } = hook.filterManagedServices(candidates, {
    platform: 'darwin',
    launchctlList: () => ({ error: null, status: 0, stdout: '111\t0\tcom.apple.other\n' }),
  });
  assert.deepStrictEqual(kept.map((c) => c.pid), [900]);
  assert.deepStrictEqual(skipped, []);
});

test('filterManagedServices: darwin, launchctl THROWS -> every candidate is unverifiable and skipped (fail-closed)', () => {
  const candidates = [
    { pid: 900, ppid: 1, cmd: mcpChildCmd('a') },
    { pid: 901, ppid: 1, cmd: mcpChildCmd('b') },
  ];
  const { kept, skipped } = hook.filterManagedServices(candidates, {
    platform: 'darwin',
    launchctlList: () => {
      throw new Error('launchctl not found');
    },
  });
  assert.deepStrictEqual(kept, []);
  assert.strictEqual(skipped.length, 2);
  assert.ok(skipped.every((s) => s.reason === 'launchd-unverifiable'));
});

test('filterManagedServices: linux, cgroup contains ".service" -> skipped with systemd-service reason', () => {
  const candidates = [{ pid: 900, ppid: 1, cmd: mcpChildCmd('managed') }];
  const { kept, skipped } = hook.filterManagedServices(candidates, {
    platform: 'linux',
    readCgroup: () => '0::/system.slice/mcp-thing.service\n',
  });
  assert.deepStrictEqual(kept, []);
  assert.strictEqual(skipped[0].reason, 'systemd-service');
});

test('filterManagedServices: linux, cgroup UNREADABLE -> NOT skipped (fail-soft)', () => {
  const candidates = [{ pid: 900, ppid: 1, cmd: mcpChildCmd('unknown') }];
  const { kept, skipped } = hook.filterManagedServices(candidates, {
    platform: 'linux',
    readCgroup: () => {
      throw new Error('ENOENT');
    },
  });
  assert.deepStrictEqual(kept.map((c) => c.pid), [900]);
  assert.deepStrictEqual(skipped, []);
});

test('filterManagedServices: an inert/unknown platform -> pass-through, no side effects', () => {
  const candidates = [{ pid: 900, ppid: 1, cmd: mcpChildCmd('x') }];
  const { kept, skipped } = hook.filterManagedServices(candidates, { platform: NOOP_PLATFORM });
  assert.deepStrictEqual(kept.map((c) => c.pid), [900]);
  assert.deepStrictEqual(skipped, []);
});

// -----------------------------------------------------------------------
// sweepOrphans: the ONE function every safety check lives in
// -----------------------------------------------------------------------

test('sweepOrphans: an old, PID-1-reparented MCP-signature process IS selected', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 700, ppid: 1, cmd: mcpChildCmd('orphaned') }];
  const out = callSweep(procs, { platform: NOOP_PLATFORM, getAges: fakeGetAges({ 700: 3600 }) });
  assert.deepStrictEqual(out.map((p) => p.pid), [700]);
});

test('sweepOrphans: a LIVE-parented MCP-signature process is NEVER selected (mutation M1 target)', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: '/sbin/launchd' },
    { pid: 794, ppid: 1, cmd: '/usr/local/bin/claude' }, // THIS session's own live claude
    { pid: 900, ppid: 794, cmd: mcpChildCmd('this-sessions-own-mcp') }, // live-parented
  ];
  const out = callSweep(procs, { platform: NOOP_PLATFORM, getAges: fakeGetAges({ 900: 3600 }) });
  assert.deepStrictEqual(out, [], 'a live-parented MCP process must never be reaped by this sweep');
});

test('sweepOrphans: an orphan YOUNGER than the age floor is skipped (mutation M2 target)', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 700, ppid: 1, cmd: mcpChildCmd('just-started') }];
  const out = callSweep(procs, { platform: NOOP_PLATFORM, minAgeS: 60, getAges: fakeGetAges({ 700: 5 }) });
  assert.deepStrictEqual(out, [], 'a 5-second-old orphan is well under the 60s default floor');
});

test('sweepOrphans: an orphan with UNKNOWN age (both probes failed) is skipped (fail-soft)', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 700, ppid: 1, cmd: mcpChildCmd('unknown-age') }];
  const out = callSweep(procs, { platform: NOOP_PLATFORM, getAges: () => new Map() }); // pid absent -> unknown
  assert.deepStrictEqual(out, []);
});

test('sweepOrphans: ANTIHALL_REAPER_EXCLUDE protects an orphan', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 700, ppid: 1, cmd: mcpChildCmd('protected') }];
  const out = callSweep(procs, {
    platform: NOOP_PLATFORM,
    excludeRe: hook.buildExtraRe('protected'),
    getAges: fakeGetAges({ 700: 3600 }),
  });
  assert.deepStrictEqual(out, []);
});

test('sweepOrphans: ANTIHALL_REAPER_MATCH widens what counts as MCP', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 701, ppid: 1, cmd: 'node /Users/example/custom-tool/index.js --serve' }];
  const withoutMatch = callSweep(procs, { platform: NOOP_PLATFORM, getAges: fakeGetAges({ 701: 3600 }) });
  assert.deepStrictEqual(withoutMatch, []);
  const withMatch = callSweep(procs, {
    platform: NOOP_PLATFORM,
    extraRe: hook.buildExtraRe('custom-tool'),
    getAges: fakeGetAges({ 701: 3600 }),
  });
  assert.deepStrictEqual(withMatch.map((p) => p.pid), [701]);
});

test('sweepOrphans: a stale test-runner (vitest on a file named mcp-server.test.ts) is NEVER selected', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: '/sbin/launchd' },
    { pid: 700, ppid: 1, cmd: 'node node_modules/.bin/vitest --run tests/mcp-server.test.ts' },
  ];
  const out = callSweep(procs, { platform: NOOP_PLATFORM, getAges: fakeGetAges({ 700: 3600 }) });
  assert.deepStrictEqual(out, []);
});

test('sweepOrphans: this hook\'s OWN process line is never selected (matchesMcp\'s "mcp-reaper" substring exclusion)', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: '/sbin/launchd' },
    { pid: 700, ppid: 1, cmd: 'node /path/to/plugins/anti-hall/hooks/session-end-mcp-reaper.js' },
  ];
  const out = callSweep(procs, { platform: NOOP_PLATFORM, getAges: fakeGetAges({ 700: 3600 }) });
  assert.deepStrictEqual(out, [], 'the hook\'s own filename contains "mcp-reaper", hard-excluded by matchesMcp');
});

test('sweepOrphans: caps at maxCandidates even with 40 qualifying orphans', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }];
  const ages = {};
  for (let i = 0; i < 40; i++) {
    procs.push({ pid: 700 + i, ppid: 1, cmd: mcpChildCmd('c' + i) });
    ages[700 + i] = 3600;
  }
  const out = callSweep(procs, { platform: NOOP_PLATFORM, maxCandidates: 16, getAges: fakeGetAges(ages) });
  assert.strictEqual(out.length, 16);
});

test('sweepOrphans: container entrypoint at PID 1 with a live mcp-server-db child -> selects NOTHING (F2, mutation M3 target)', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: 'python3 /app/entrypoint.py' }, // container's own entrypoint, NOT init
    { pid: 50, ppid: 1, cmd: mcpChildCmd('db') }, // a NORMAL child of the entrypoint, not an orphan
  ];
  const out = callSweep(procs, { platform: NOOP_PLATFORM, getAges: fakeGetAges({ 50: 3600 }) });
  assert.deepStrictEqual(out, [], 'PID 1 is a container entrypoint, not init — ppid===1 here is NOT an orphan signal');
});

test('sweepOrphans: a launchd-managed candidate is NEVER selected (F1, mutation M4 target)', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 900, ppid: 1, cmd: mcpChildCmd('managed') }];
  const out = callSweep(procs, {
    platform: 'darwin',
    getAges: fakeGetAges({ 900: 3600 }),
    launchctlList: () => ({ error: null, status: 0, stdout: '900\t0\tcom.apple.mcp\n' }),
  });
  assert.deepStrictEqual(out, []);
});

test('sweepOrphans: onManagedSkip is invoked once per managed-skipped candidate', () => {
  const procs = [{ pid: 1, ppid: 0, cmd: '/sbin/launchd' }, { pid: 900, ppid: 1, cmd: mcpChildCmd('managed') }];
  const skips = [];
  callSweep(procs, {
    platform: 'darwin',
    getAges: fakeGetAges({ 900: 3600 }),
    launchctlList: () => ({ error: null, status: 0, stdout: '900\t0\tcom.apple.mcp\n' }),
    onManagedSkip: (s) => skips.push(s),
  });
  assert.strictEqual(skips.length, 1);
  assert.strictEqual(skips[0].pid, 900);
  assert.strictEqual(skips[0].reason, 'launchd-managed');
});

// -----------------------------------------------------------------------
// main(): reason gating
// -----------------------------------------------------------------------

for (const badReason of ['clear', 'resume', 'logout']) {
  test(`main(): reason="${badReason}" -> no-op, no log, no kill`, () => {
    const lines = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
    const { logDir, logFile } = tmpLogPaths();
    const killCalls = [];
    callMain({
      stdinRaw: realStdinFor(badReason),
      psExec: fakePsExec(lines.join('\n')),
      logDir,
      logFile,
      platform: NOOP_PLATFORM,
      getAges: fakeGetAges({ 700: 3600 }),
      killFn: (pid, sig) => killCalls.push({ pid, sig }),
      skipSleep: true,
    });
    assert.strictEqual(fs.existsSync(logFile), false);
    assert.strictEqual(killCalls.length, 0);
  });
}

test('main(): unparseable stdin -> no-op, fail-closed', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: 'not even json',
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 700: 3600 }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  assert.strictEqual(fs.existsSync(logFile), false);
  assert.strictEqual(killCalls.length, 0);
});

test('main(): `reason` absent but `end_reason` present (fallback alias) -> still acts', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: JSON.stringify({ session_id: 's', end_reason: 'prompt_input_exit' }),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 700: 3600 }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  assert.deepStrictEqual(killCalls.map((c) => c.sig), ['SIGTERM', 'SIGKILL']);
});

// -----------------------------------------------------------------------
// main(): F2 pid1-not-init gate
// -----------------------------------------------------------------------

test('main(): container entrypoint at PID 1 -> logs {event:"skip", reason:"pid1-not-init"}, no scan log, no kill', () => {
  const lines = [psLine(1, 0, 'python3 /app/entrypoint.py'), psLine(50, 1, mcpChildCmd('db'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 50: 3600 }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  const entries = readNdjson(logFile);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].event, 'skip');
  assert.strictEqual(entries[0].reason, 'pid1-not-init');
  assert.strictEqual(entries[0].pid1Cmd, 'python3 /app/entrypoint.py');
  assert.ok(!entries.some((e) => e.event === 'scan'), 'no scan log line — the sweep must do nothing else at all');
  assert.strictEqual(killCalls.length, 0);
});

// -----------------------------------------------------------------------
// main(): F1 launchd/systemd-managed skip + logging
// -----------------------------------------------------------------------

test('main(): darwin, candidate IS launchd-managed -> logs skip with reason, never killed', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(900, 1, mcpChildCmd('managed'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: 'darwin',
    getAges: fakeGetAges({ 900: 3600 }),
    launchctlList: () => ({ error: null, status: 0, stdout: '900\t0\tcom.apple.mcp\n' }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  const entries = readNdjson(logFile);
  const skipEntry = entries.find((e) => e.action === 'skip');
  assert.ok(skipEntry);
  assert.strictEqual(skipEntry.pid, 900);
  assert.strictEqual(skipEntry.reason, 'launchd-managed');
  const scan = entries.find((e) => e.event === 'scan');
  assert.strictEqual(scan.candidates, 0);
  assert.strictEqual(killCalls.length, 0);
});

test('main(): darwin, launchctl throws -> ALL candidates skipped as unverifiable, never killed', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(900, 1, mcpChildCmd('a')), psLine(901, 1, mcpChildCmd('b'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: 'darwin',
    getAges: fakeGetAges({ 900: 3600, 901: 3600 }),
    launchctlList: () => {
      throw new Error('launchctl not found');
    },
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  const entries = readNdjson(logFile);
  const skips = entries.filter((e) => e.action === 'skip');
  assert.strictEqual(skips.length, 2);
  assert.ok(skips.every((s) => s.reason === 'launchd-unverifiable'));
  assert.strictEqual(killCalls.length, 0);
});

// -----------------------------------------------------------------------
// main(): end-to-end sweep, TERM -> grace -> re-verify -> KILL
// -----------------------------------------------------------------------

test('main(): reason="prompt_input_exit" + an old orphan -> TERM then KILL, NDJSON logged', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('prompt_input_exit'),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 700: 3600 }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  const entries = readNdjson(logFile);
  const scan = entries.find((e) => e.event === 'scan');
  assert.ok(scan);
  assert.strictEqual(scan.candidates, 1);
  assert.ok(entries.some((e) => e.action === 'term' && e.pid === 700));
  assert.ok(entries.some((e) => e.action === 'kill' && e.pid === 700));
  assert.deepStrictEqual(killCalls.map((c) => c.sig), ['SIGTERM', 'SIGKILL']);
});

test('main(): no orphans -> scan-only log line (candidates: 0), no kill', () => {
  const lines = [psLine(1, 0, '/sbin/launchd')];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({}),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  const entries = readNdjson(logFile);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].candidates, 0);
  assert.strictEqual(killCalls.length, 0);
});

test('main(): a candidate gone by re-scan (exited on its own before KILL) is NOT re-selected for SIGKILL', () => {
  const linesBefore = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const linesAfter = [psLine(1, 0, '/sbin/launchd')]; // 700 gone
  let call = 0;
  const psExec = () => {
    call += 1;
    return { error: null, status: 0, signal: null, stdout: (call === 1 ? linesBefore : linesAfter).join('\n') };
  };
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec,
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 700: 3600 }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  const entries = readNdjson(logFile);
  assert.strictEqual(entries.filter((e) => e.action === 'kill').length, 0);
  assert.deepStrictEqual(killCalls.map((c) => c.sig), ['SIGTERM']);
});

test('main(): a candidate recycled into a live-parented process by re-scan is NOT killed', () => {
  const linesBefore = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const linesAfter = [psLine(1, 0, '/sbin/launchd'), psLine(500, 1, '/usr/bin/some-app'), psLine(700, 500, mcpChildCmd('alpha'))]; // recycled under a live parent
  let call = 0;
  const psExec = () => {
    call += 1;
    return { error: null, status: 0, signal: null, stdout: (call === 1 ? linesBefore : linesAfter).join('\n') };
  };
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec,
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 700: 3600 }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  assert.deepStrictEqual(killCalls.map((c) => c.sig), ['SIGTERM']);
});

// -----------------------------------------------------------------------
// main(): kill-switch, cap, fail-open paths, bounded log
// -----------------------------------------------------------------------

test('main(): kill-switch ANTI_HALL_SESSION_END_REAPER=0 -> no-op regardless of reason', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  const prev = process.env.ANTI_HALL_SESSION_END_REAPER;
  process.env.ANTI_HALL_SESSION_END_REAPER = '0';
  try {
    callMain({
      stdinRaw: realStdinFor('other'),
      psExec: fakePsExec(lines.join('\n')),
      logDir,
      logFile,
      platform: NOOP_PLATFORM,
      getAges: fakeGetAges({ 700: 3600 }),
      killFn: (pid, sig) => killCalls.push({ pid, sig }),
      skipSleep: true,
    });
  } finally {
    if (prev === undefined) delete process.env.ANTI_HALL_SESSION_END_REAPER;
    else process.env.ANTI_HALL_SESSION_END_REAPER = prev;
  }
  assert.strictEqual(fs.existsSync(logFile), false);
  assert.strictEqual(killCalls.length, 0);
});

test('main(): psExec throws -> fail-open, never throws, no kill', () => {
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  assert.doesNotThrow(() => {
    callMain({
      stdinRaw: realStdinFor('other'),
      psExec: () => {
        throw new Error('boom');
      },
      logDir,
      logFile,
      platform: NOOP_PLATFORM,
      getAges: fakeGetAges({}),
      killFn: (pid, sig) => killCalls.push({ pid, sig }),
      skipSleep: true,
    });
  });
  assert.strictEqual(killCalls.length, 0);
});

test('main(): ps exits non-zero -> fail-open, no kill', () => {
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: () => ({ error: null, status: 1, stdout: '' }),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({}),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  assert.strictEqual(killCalls.length, 0);
});

test('main(): ps output truncated (signal set) -> fail-open, no kill', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: () => ({ error: null, status: 0, signal: 'SIGTERM', stdout: lines.join('\n') }),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 700: 3600 }),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  assert.strictEqual(killCalls.length, 0);
});

test('main(): mcpReaperModPath unrequireable -> fail-open, no throw, no kill', () => {
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  assert.doesNotThrow(() => {
    callMain({
      stdinRaw: realStdinFor('other'),
      psExec: fakePsExec(''),
      logDir,
      logFile,
      mcpReaperModPath: '/no/such/module-xyz.js',
      platform: NOOP_PLATFORM,
      getAges: fakeGetAges({}),
      killFn: (pid, sig) => killCalls.push({ pid, sig }),
      skipSleep: true,
    });
  });
  assert.strictEqual(killCalls.length, 0);
});

test('main(): candidates capped at maxCandidates end-to-end', () => {
  const lines = [psLine(1, 0, '/sbin/launchd')];
  const ages = {};
  for (let i = 0; i < 40; i++) {
    lines.push(psLine(700 + i, 1, mcpChildCmd('c' + i)));
    ages[700 + i] = 3600;
  }
  const { logDir, logFile } = tmpLogPaths();
  const killCalls = [];
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    maxCandidates: 16,
    getAges: fakeGetAges(ages),
    killFn: (pid, sig) => killCalls.push({ pid, sig }),
    skipSleep: true,
  });
  const entries = readNdjson(logFile);
  const scan = entries.find((e) => e.event === 'scan');
  assert.strictEqual(scan.candidates, 16);
  assert.strictEqual(killCalls.filter((c) => c.sig === 'SIGTERM').length, 16);
});

test('main(): log file over 5MB -> logging is skipped (bounded log)', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(700, 1, mcpChildCmd('alpha'))];
  const { logDir, logFile } = tmpLogPaths();
  fs.writeFileSync(logFile, Buffer.alloc(hook.MAX_LOG_BYTES + 1, 'x'));
  const sizeBefore = fs.statSync(logFile).size;
  callMain({
    stdinRaw: realStdinFor('other'),
    psExec: fakePsExec(lines.join('\n')),
    logDir,
    logFile,
    platform: NOOP_PLATFORM,
    getAges: fakeGetAges({ 700: 3600 }),
    killFn: () => {},
    skipSleep: true,
  });
  const sizeAfter = fs.statSync(logFile).size;
  assert.strictEqual(sizeAfter, sizeBefore, 'no new NDJSON lines should be appended once over the 5MB cap');
});
