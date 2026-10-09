'use strict';
// Coordinator-drift Phase 5 (F1): coordinator-work-guard.js + lib/coordinator-work.js.
// A per-session time window of successful WORK Bash calls in the main thread:
// a nudge when the window reaches nudgeAt (once per crossing), a Pre block of a
// blockable WORK call when the window already holds blockAt - 1. Metrics,
// the ordered-lock fold of stale session files, and the dispatch-report view.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'coordinator-work-guard.js');
const LIB_PATH = path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'coordinator-work.js');
const REPORT = path.join(ROOT, 'plugins', 'anti-hall', 'scripts', 'dispatch-report.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json'), 'utf8')).version;
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const WAIT = { ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS: '3000' };
const DAY = 86400000;
const WORK = 'git commit -qm x';
const lib = () => require(LIB_PATH);
delete process.env.S;

const BASE = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cw-guard-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const REPO = path.join(BASE, 'repo');
const X = path.join(BASE, 'x'); // tmp dir, not a git work tree

function put(file, body, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode) fs.chmodSync(file, mode);
  return file;
}
function git(cwd, ...args) {
  const r = childProcess.spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
}
const SH = '#!/bin/sh\necho x\n';
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);
const OLD = Date.now() / 1000 - 2 * 86400;

fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q');
put(path.join(REPO, 'scripts/lint.sh'), SH, 0o755);
put(path.join(REPO, 'gradlew'), SH, 0o755);
put(path.join(REPO, '.gitignore'), '.venv/\n');
put(path.join(REPO, 'a.txt'), 'a\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'init');
for (const rel of ['gradlew', '.gitignore', 'a.txt']) fs.utimesSync(path.join(REPO, rel), OLD, OLD);
// scripts/lint.sh stays tracked + clean with a FRESH mtime (as after a checkout).
put(path.join(REPO, '.venv/bin/pytest'), SH, 0o755);
put(path.join(REPO, '.claude/push.sh'), SH, 0o755);
put(path.join(X, '.venv/bin/p.sh'), SH, 0o755);

const statePath = (home, sid) => path.join(home, '.anti-hall', 'coordinator-work-session-' + sid + '.json');
const metricsPath = (home) => path.join(home, '.anti-hall', 'coordinator-work-metrics.json');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
const sessionFiles = (home) => { try { return fs.readdirSync(path.join(home, '.anti-hall')).filter((f) => f.startsWith('coordinator-work-session-')); } catch (_) { return []; } };

function payload(command, sid, event, extra) {
  return Object.assign({ hook_event_name: event, tool_name: 'Bash', tool_input: { command }, session_id: sid, cwd: REPO }, extra || {});
}
function pre(home, command, opts = {}) {
  return testHook(HOOK, payload(command, opts.sid || 's1', 'PreToolUse'), { home, env: Object.assign({}, COORD, opts.env || {}) });
}
function childEnv(home, env) {
  return Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1' }, COORD, env || {});
}
function post(home, command, opts = {}) {
  const r = childProcess.spawnSync(process.execPath, [HOOK, '--post'], {
    input: JSON.stringify(payload(command, opts.sid || 's1', 'PostToolUse', { tool_response: { stdout: '' } })),
    encoding: 'utf8', env: childEnv(home, opts.env), timeout: 60000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function postAsync(home, command, opts = {}) {
  return new Promise((resolve) => {
    const c = childProcess.spawn(process.execPath, [HOOK, '--post'], { env: childEnv(home, Object.assign({ ANTIHALL_TEST_HOME_ISOLATED: home }, WAIT, opts.env || {})) });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ status: code, stdout: out }));
    c.stdin.end(JSON.stringify(payload(command, opts.sid || 's1', 'PostToolUse', { tool_response: { stdout: '' } })));
  });
}
function seed(home, sid, fields, mtimeMs) {
  const p = statePath(home, sid);
  put(p, JSON.stringify(Object.assign({ v: 1, version: VERSION, firstTs: 0, ts: [], armed: true, calls: 0, work: 0, blocks: 0, lastBlockAt: 0, skippedWouldBlock: 0 }, fields)));
  if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}
const recent = (n) => Array.from({ length: n }, (_, i) => Date.now() - (n - i) * 1000);
const CFG = { tMs: 600000, nudgeAt: 4, blockAt: 7, cap: 50 };

test('no-op inputs: empty, malformed, no session_id, non-Bash, subagent -> exit 0 and no state', () => {
  const { home } = makeHome();
  const raw = (input) => childProcess.spawnSync(process.execPath, [HOOK, '--post'], { input, encoding: 'utf8', env: childEnv(home) });
  for (const input of ['', '{bad']) assert.strictEqual(raw(input).status, 0);
  assert.strictEqual(raw(JSON.stringify(payload(WORK, '', 'PostToolUse'))).status, 0);
  assert.strictEqual(raw(JSON.stringify(Object.assign(payload(WORK, 's1', 'PostToolUse'), { tool_name: 'Read' }))).status, 0);
  assert.strictEqual(raw(JSON.stringify(Object.assign(payload(WORK, 's1', 'PostToolUse'), { agent_id: 'a1', agent_type: 'general-purpose' }))).status, 0);
  assert.strictEqual(pre(home, '').status, 0);
  assert.deepStrictEqual(sessionFiles(home), []);
});

test('4 WORK posts: the 4th nudges, the 5th is silent', () => {
  const { home } = makeHome();
  const outs = [1, 2, 3, 4, 5].map(() => post(home, WORK).stdout);
  assert.strictEqual(outs[0] + outs[1] + outs[2], '');
  assert.match(outs[3], /coordinator-work-guard: 4 state-changing calls/);
  const j = JSON.parse(outs[3]);
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(outs[3].length < 10000);
  assert.strictEqual(outs[4], '');
  assert.strictEqual(readJson(metricsPath(home)).nudges, 1);
});

test('pure: expiry at +11 min, re-arm before append, firstTs set once', () => {
  const L = lib();
  const s = L.emptyState('9.9.9');
  const t0 = 1_000_000_000_000;
  const crossings = [];
  for (let i = 0; i < 4; i++) { const r = L.stepPost(s, { now: t0 + i * 1000, work: true }, CFG); if (r.crossing) crossings.push(r.crossing.count); }
  assert.deepStrictEqual(crossings, [4]);
  assert.strictEqual(s.firstTs, t0);
  // +11 min: all four expired; the pruned count (0) re-arms before the append.
  const later = t0 + 11 * 60000;
  assert.strictEqual(L.checkPre(s, { now: later, work: true, blockable: true }, CFG).count, 0);
  for (let i = 0; i < 4; i++) { const r = L.stepPost(s, { now: later + i * 1000, work: true }, CFG); if (r.crossing) crossings.push(r.crossing.count); }
  assert.deepStrictEqual(crossings, [4, 4]);
  assert.strictEqual(s.firstTs, t0);
  assert.strictEqual(s.calls, 8);
  assert.strictEqual(s.work, 8);
  // A non-WORK post counts a call, not a window entry.
  L.stepPost(s, { now: later + 5000, work: false }, CFG);
  assert.strictEqual(s.calls, 9);
  assert.strictEqual(s.ts.length, 4);
  assert.strictEqual(L.sessionStart(null, t0), t0 - 21600000);
  assert.strictEqual(L.sessionStart(s, t0 + 1), t0);
});

test('6 WORK posts, then a WORK Pre -> exit 2 with an absolute, quoted skip command', () => {
  const { home } = makeHome();
  for (let i = 0; i < 6; i++) post(home, WORK);
  const r = pre(home, WORK);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.decision, 'block');
  assert.match(j.reason, /^\S+ anti-hall · coordinator-work-guard: 6 state-changing calls/);
  const m = j.reason.match(/node '([^']+)' skip coordinator-work-guard/);
  assert.ok(m, j.reason);
  assert.ok(path.isAbsolute(m[1]));
  assert.ok(fs.existsSync(m[1]), m[1]);
  assert.ok(r.stdout.length < 10000);
  assert.ok(j.reason.length < 1200, String(j.reason.length));
  assert.strictEqual(readJson(statePath(home, 's1')).blocks, 1);
  assert.strictEqual(readJson(metricsPath(home)).blocks, 1);
});

test('Pre at count 6: block table', () => {
  const { home } = makeHome();
  put(path.join(home, 'push.sh'), SH, 0o755);
  put(path.join(home, 'go/bin/golangci-lint'), ELF, 0o755);
  put(path.join(home, '.local/bin/p.sh'), SH, 0o755);
  put(path.join(home, 'Library/x.sh'), SH, 0o755);
  const oldX = put(path.join(home, '.local/bin/x'), SH, 0o755);
  fs.utimesSync(oldX, OLD, OLD);
  seed(home, 's1', { firstTs: Date.now() - 3600000, ts: recent(6), armed: false, calls: 6, work: 6 });
  const rows = [
    ['git status', 0],
    ['git am --abort && git status', 0],
    ['python3 -c "import subprocess;subprocess.run([\'git\',\'push\'])"', 2],
    ['python3 -c "import os;os.system(\'echo x > a.txt\')"', 0],
    ['git am --skip', 2],
    ['git am --abort && git am -3 -q p.patch', 2],
    ['bash ~/push.sh', 2],
    ['bash .claude/push.sh', 2],
    ['bash ' + path.join(X, '.venv/bin/p.sh'), 2],
    ['./gradlew build', 0],
    ['bash scripts/lint.sh', 0],
    ['.venv/bin/pytest -q', 0],
    ['~/go/bin/golangci-lint run', 0],
    ['bash ~/.local/bin/p.sh', 2],
    ['bash ~/Library/x.sh', 2],
    ['~/.local/bin/x', 0],
  ];
  const got = rows.map(([c]) => [c, pre(home, c).status]);
  assert.deepStrictEqual(got, rows);
});

test('no state firstTs: sessionStartTs is now - 6 h', () => {
  const { home } = makeHome();
  const x = put(path.join(home, '.local/bin/x'), SH, 0o755);
  seed(home, 's1', { firstTs: 0, ts: recent(6), armed: false, calls: 6, work: 6 });
  const t7 = (Date.now() - 7 * 3600000) / 1000;
  fs.utimesSync(x, t7, t7);
  assert.strictEqual(pre(home, '~/.local/bin/x').status, 0);
  const t1 = (Date.now() - 3600000) / 1000;
  fs.utimesSync(x, t1, t1);
  assert.strictEqual(pre(home, '~/.local/bin/x').status, 2);
});

test('skip active at count 6 -> exit 0, skippedWouldBlock 1, attempted share unchanged', () => {
  const { home, writeSkip } = makeHome();
  seed(home, 's1', { firstTs: Date.now() - 3600000, ts: recent(6), armed: false, calls: 6, work: 6 });
  const before = lib().summary(home).versions[VERSION].attemptedShare;
  writeSkip({ 'coordinator-work-guard': Date.now() + 15 * 60000 });
  assert.strictEqual(pre(home, WORK).status, 0);
  const s = readJson(statePath(home, 's1'));
  assert.strictEqual(s.skippedWouldBlock, 1);
  assert.strictEqual(s.blocks, 0);
  const sum = lib().summary(home);
  assert.strictEqual(sum.versions[VERSION].attemptedShare, before);
  assert.strictEqual(sum.skippedWouldBlock, 1);
  assert.strictEqual(sum.sessionsWithSkippedWouldBlock, 1);
});

test('the plugin version and firstTs are recorded', () => {
  const { home } = makeHome();
  post(home, 'git status');
  const s = readJson(statePath(home, 's1'));
  assert.strictEqual(s.version, VERSION);
  assert.ok(s.firstTs > 0);
  assert.strictEqual(s.calls, 1);
  assert.strictEqual(s.work, 0);
});

test('observe-only (nudgeAt 0, blockAt 0): 8 WORK posts record state, no output, no metrics', () => {
  const { home } = makeHome();
  const env = { ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '0', ANTIHALL_COORDINATOR_WORK_BLOCK_AT: '0' };
  const outs = [];
  for (let i = 0; i < 8; i++) outs.push(post(home, WORK, { env }).stdout);
  assert.strictEqual(outs.join(''), '');
  assert.strictEqual(pre(home, WORK, { env }).status, 0);
  assert.strictEqual(readJson(statePath(home, 's1')).work, 8);
  assert.ok(!fs.existsSync(metricsPath(home)));
});

test('windowMinutes 0 -> no state file', () => {
  const { home } = makeHome();
  const env = { ANTIHALL_COORDINATOR_WORK_WINDOW_MINUTES: '0' };
  post(home, WORK, { env });
  assert.strictEqual(pre(home, WORK, { env }).status, 0);
  assert.deepStrictEqual(sessionFiles(home), []);
});

test('a corrupt state file is rewritten', () => {
  const { home } = makeHome();
  put(statePath(home, 's1'), '{not json');
  post(home, WORK);
  const s = readJson(statePath(home, 's1'));
  assert.ok(s);
  assert.strictEqual(s.calls, 1);
  assert.strictEqual(s.work, 1);
});

test('a non-WORK post leaves metrics untouched', () => {
  const { home } = makeHome();
  post(home, 'git status && ls');
  assert.ok(!fs.existsSync(metricsPath(home)));
  assert.strictEqual(readJson(statePath(home, 's1')).work, 0);
});

test('a 70,000-char command is not WORK', () => {
  const { home } = makeHome();
  post(home, 'git commit -m ' + 'x'.repeat(70000));
  const s = readJson(statePath(home, 's1'));
  assert.strictEqual(s.calls, 1);
  assert.strictEqual(s.work, 0);
});

test('fold: a stale session folds into byVersion once; a second post within 6 h does not fold', () => {
  const { home } = makeHome();
  const old = seed(home, 'old', { version: '0.1.0', calls: 10, work: 3, blocks: 1, skippedWouldBlock: 0 }, Date.now() - 8 * DAY);
  post(home, 'git status', { sid: 'other' });
  assert.ok(!fs.existsSync(old));
  assert.deepStrictEqual(readJson(metricsPath(home)).byVersion['0.1.0'], { sessions: 1, calls: 10, work: 3, blocks: 1, skippedWouldBlock: 0 });
  const old2 = seed(home, 'old2', { version: '0.1.0', calls: 5, work: 1 }, Date.now() - 8 * DAY);
  post(home, 'git status', { sid: 'other' });
  assert.ok(fs.existsSync(old2));
  assert.strictEqual(readJson(metricsPath(home)).byVersion['0.1.0'].sessions, 1);
});

test('fold race: a fold racing live posts on a resumed old session loses no call, double-counts none', async () => {
  const { home } = makeHome();
  seed(home, 'old', { version: '0.1.0', calls: 10, work: 3 }, Date.now() - 8 * DAY);
  const runs = [];
  for (let i = 0; i < 8; i++) runs.push(postAsync(home, WORK, { sid: 'old' }));
  runs.push(postAsync(home, 'git status', { sid: 'other' }));
  await Promise.all(runs);
  const live = readJson(statePath(home, 'old'));
  const m = readJson(metricsPath(home));
  const bv = m && m.byVersion && m.byVersion['0.1.0'];
  const a = !!live && live.calls === 18 && live.work === 11 && live.version === '0.1.0' && !bv;
  const b = !!bv && bv.sessions === 1 && bv.calls + (live ? live.calls : 0) === 18 &&
    bv.work + (live ? live.work : 0) === 11 && (!live || live.version !== '0.1.0');
  assert.ok(a !== b && (a || b), JSON.stringify({ live, bv }));
});

test('concurrency: 8 parallel posts -> 8 entries, and a reader never sees invalid JSON', async () => {
  const { home } = makeHome();
  const p = statePath(home, 's1');
  let bad = 0;
  let reads = 0;
  const timer = setInterval(() => {
    let raw = null;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return; }
    reads++;
    try { JSON.parse(raw); } catch (_) { bad++; }
  }, 2);
  try {
    await Promise.all(Array.from({ length: 8 }, () => postAsync(home, WORK)));
  } finally {
    clearInterval(timer);
  }
  const s = readJson(p);
  assert.strictEqual(s.ts.length, 8);
  assert.strictEqual(s.calls, 8);
  assert.strictEqual(bad, 0, 'invalid JSON reads: ' + bad + '/' + reads);
});

test('dispatch-report --json: attempted share = (work + blocks)/(calls + blocks); skippedWouldBlock separate', () => {
  const { home } = makeHome();
  put(metricsPath(home), JSON.stringify({ v: 1, nudges: 2, blocks: 3, byVersion: { '0.1.0': { sessions: 1, calls: 10, work: 3, blocks: 1, skippedWouldBlock: 2 } } }));
  seed(home, 'live', { version: '0.2.0', firstTs: Date.now(), calls: 5, work: 2, blocks: 2, skippedWouldBlock: 1 });
  const env = { PATH: process.env.PATH, HOME: home, ANTIHALL_TEST_ISOLATION: '1' };
  const r = childProcess.spawnSync(process.execPath, [REPORT, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const cw = JSON.parse(r.stdout).coordinatorWork;
  assert.strictEqual(cw.nudges, 2);
  assert.strictEqual(cw.blocks, 3);
  assert.strictEqual(cw.versions['0.1.0'].attemptedShare, (3 + 1) / (10 + 1));
  assert.strictEqual(cw.versions['0.1.0'].postedShare, 3 / 10);
  assert.strictEqual(cw.versions['0.2.0'].attemptedShare, (2 + 2) / (5 + 2));
  assert.strictEqual(cw.versions['0.2.0'].sessions, 1);
  assert.strictEqual(cw.skippedWouldBlock, 3);
  assert.strictEqual(cw.sessionsWithSkippedWouldBlock, 1);
  assert.deepStrictEqual(cw.blocksPerSession, { mean: 1.5, max: 2 });
  const t = childProcess.spawnSync(process.execPath, [REPORT], { encoding: 'utf8', env });
  assert.match(t.stdout, /coordinator work: nudges 2 · blocks 3 · blocks\/session mean 1\.5 max 2 · skipped would-be blocks 3 \(1 sessions\)/);
  assert.match(t.stdout, /0\.1\.0: sessions 1 · work share 30% \(attempted 36\.4%\)/);
  assert.match(t.stdout, /baseline: node scripts\/coordinator-work-baseline\.js <transcript\.jsonl>/);
  assert.match(t.stdout, /known gaps: /);
});

// ---- fix wave 1 ----

test('safety.commandGuard off or command-guard skipped: no block, no state', () => {
  for (const mode of ['off', 'skip']) {
    const { home, writeSkip } = makeHome();
    const env = mode === 'off' ? { ANTIHALL_COMMAND_GUARD: 'off' } : {};
    if (mode === 'skip') writeSkip({ 'command-guard': Date.now() + 15 * 60000 });
    post(home, WORK, { env });
    assert.deepStrictEqual(sessionFiles(home), [], mode);
    seed(home, 's1', { firstTs: Date.now() - 3600000, ts: recent(6), armed: false, calls: 6, work: 6 });
    const before = fs.readFileSync(statePath(home, 's1'), 'utf8');
    assert.strictEqual(pre(home, WORK, { env }).status, 0, mode);
    post(home, WORK, { env });
    assert.strictEqual(fs.readFileSync(statePath(home, 's1'), 'utf8'), before, mode);
  }
});

function hookAt(home, event, command, toolUseId) {
  const p = payload(command, 's1', event, { tool_use_id: toolUseId });
  if (event === 'PreToolUse') return testHook(HOOK, p, { home, env: COORD });
  p.tool_response = { stdout: '' };
  const r = childProcess.spawnSync(process.execPath, [HOOK, '--post'], { input: JSON.stringify(p), encoding: 'utf8', env: childEnv(home), timeout: 60000 });
  return { status: r.status };
}

test('Post uses the Pre verdict for the same tool_use_id (a script removed by the command still counts)', () => {
  const { home } = makeHome();
  const s1 = put(path.join(REPO, 'new2.sh'), SH, 0o755);
  assert.strictEqual(hookAt(home, 'PreToolUse', 'bash ./new2.sh && rm new2.sh', 'tu-1').status, 0);
  fs.rmSync(s1);
  hookAt(home, 'PostToolUse', 'bash ./new2.sh && rm new2.sh', 'tu-1');
  let s = readJson(statePath(home, 's1'));
  assert.deepStrictEqual([s.calls, s.work, s.ts.length], [1, 1, 1]);
  const gone = put(path.join(X, 'x', 'gone.sh'), SH, 0o755);
  const c = gone + ' && rm ' + gone;
  hookAt(home, 'PreToolUse', c, 'tu-2');
  fs.rmSync(gone);
  hookAt(home, 'PostToolUse', c, 'tu-2');
  s = readJson(statePath(home, 's1'));
  assert.deepStrictEqual([s.calls, s.work, s.ts.length], [2, 2, 2]);
  assert.ok(!(s.pre || []).some((e) => e.id === 'tu-1' || e.id === 'tu-2'), 'consumed entries are removed');
});

test('Pre verdicts are capped at 20 per session (oldest dropped)', () => {
  const L = lib();
  const s = L.emptyState('9.9.9');
  for (let i = 0; i < 25; i++) L.rememberPre(s, 'id' + i, { work: true, blockable: true });
  assert.strictEqual(s.pre.length, 20);
  assert.strictEqual(s.pre[0].id, 'id5');
  assert.deepStrictEqual(L.takePre(s, 'id24'), { work: true, blockable: true });
  assert.strictEqual(L.takePre(s, 'id24'), null);
  assert.strictEqual(L.normalize({ pre: [{ id: 'a', work: true, blockable: false }, { id: 3 }, null] }).pre.length, 1);
});

test('NUDGE: the block clause is dropped when blockAt <= 0', () => {
  const L = lib();
  assert.match(L.NUDGE(4, CFG), /call 7 in the window is blocked/);
  for (const blockAt of [0, -1]) {
    const t = L.NUDGE(4, Object.assign({}, CFG, { blockAt }));
    assert.doesNotMatch(t, /blocked|\b0th\b/);
    assert.match(t, /delegate the rest to a subagent now\.$/);
  }
});
