#!/usr/bin/env node
// Parity of the PostToolUse pass of the built-in `coordinator-work-guard` check against `hooks/coordinator-work-guard.js`
// (PreToolUse and `--post`), end to end: the Node side runs both passes in its own home; the engine side answers the
// PostToolUse pass itself when it can and, as the dispatcher does, hands every other call (the PreToolUse pass, a command the
// engine cannot classify, a lock it cannot take) to the real Node hook in the engine's own home. Outputs and the state files
// (window files byte for byte except clock values; metrics, trips log and stamp at the end of each context) must be equal.
//   node run-coordinator-post.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--conc 4] [--show 15] [--real 600] [--seed 1] [--fuzz 600]
const fs = require('fs'), os = require('os'), path = require('path');
const { arg, runParity, readCmds, rng, safeSid } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
let n = 0;
const sid = () => `c${n++}`;
const add = (steps, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps });

const WORK = ['git commit -m x', 'git commit -am msg', 'git push', 'git push origin dev', 'git add -A && git commit -m y', 'git rebase main', 'git merge other', 'git cherry-pick abc', 'git reset --hard HEAD~1', 'git restore f', 'git rm f', 'git mv a b', 'git pull', 'git revert HEAD', 'git am x.patch',
  'gh pr create --title x --body y', 'gh pr merge 1', 'gh issue create --title x', 'gh release create v1', 'git tag v1', 'git tag -d v1'];
const RECOVERY = ['git rebase --abort', 'git merge --abort', 'git cherry-pick --abort', 'git am --abort', 'git revert --quit', 'git stash pop', 'git stash apply'];
const READ = ['ls', 'ls -la', 'git status', 'git log --oneline', 'git diff', 'git show HEAD', 'cat README.md | head -20', 'pwd', 'grep -r foo src', 'rg foo', 'wc -l f', 'git log --oneline | wc -l', 'which node', 'whoami', 'stat f', 'du -sh .', 'git rev-parse HEAD', 'git ls-files', 'git blame f', 'git describe', 'true', 'false', 'ls && pwd; git status', 'ls\ngit status'];
const OTHER = ['npm test', 'node script.js', 'echo hi', 'cd /tmp', 'make build', 'python3 x.py', 'curl -s http://localhost', 'cat <<EOF\nx\nEOF', 'ls $(pwd)', 'echo "a b" | wc -c', 'find . -name x', 'sleep 1', 'git diff --output=x', 'git log -o x', 'ls > out.txt', 'FOO=1 ls', 'ls *.js', 'bash -c "git commit -m x"', 'echo x > /tmp/ah-notes.md', 'sed -i s/a/b/ f', 'rm -rf build', 'mkdir -p x', 'touch f', 'cp a b', 'tee f < in', 'git status && git commit -m z', 'ls || git push', '  ', ''];
const ALL = [...WORK, ...RECOVERY, ...READ, ...OTHER];

const base = (event, s, command, id, extra) => Object.assign({ hook_event_name: event, tool_name: 'Bash', session_id: s, cwd: '/tmp', tool_input: { command } }, id ? { tool_use_id: id } : {}, extra || {});
const pre = (s, c, id, extra) => ({ payload: base('PreToolUse', s, c, id, extra) });
const post = (s, c, id, extra) => ({ payload: base('PostToolUse', s, c, id, extra), argv: ['--post'] });
const pair = (s, c, id, extra) => [pre(s, c, id, extra), post(s, c, id, extra)];

// ---- fixtures in each home
const T0 = Date.now();
const mk = (v, o) => JSON.stringify(Object.assign({ v: 1, version: v, firstTs: T0 - 1000, ts: [], armed: true, calls: 0, work: 0, blocks: 0, lastBlockAt: 0, skippedWouldBlock: 0, pre: [] }, o || {}));
function setupWith(extra) {
  return home => {
    const d = path.join(home, '.anti-hall');
    fs.mkdirSync(d, { recursive: true });
    const old = (name, body, days) => { const f = path.join(d, name); fs.writeFileSync(f, body); const t = new Date(Date.now() - days * 86400e3); fs.utimesSync(f, t, t); };
    // stale windows to be folded (versions, counters, a corrupt one, a tokenless-lock one)
    old('coordinator-work-session-stale-a.json', mk('0.1.0', { calls: 5, work: 3, blocks: 1, skippedWouldBlock: 2 }), 10);
    old('coordinator-work-session-stale-b.json', mk('0.1.0', { calls: 2, work: 1 }), 9);
    old('coordinator-work-session-stale-c.json', mk('0.2.0', { calls: 7, work: 7, blocks: 4 }), 8);
    old('coordinator-work-session-stale-d.json', '{not json', 20);
    old('coordinator-work-session-stale-e.json', '[1,2]', 20);
    old('coordinator-work-session-stale-f.json', JSON.stringify({ version: 12, calls: '5', work: 2 }), 30);
    old('coordinator-work-session-stale-g.json', mk('1', { calls: 1 }), 31);
    old('coordinator-work-session-fresh-h.json', mk('0.1.0', { calls: 9 }), 1);
    if (extra) extra(home, d, old);
  };
}
const lockRec = (ts, pid) => JSON.stringify({ pid: pid || process.pid, host: os.hostname(), ts, token: 'seed:' + ts });
const plain = { setup: setupWith() };
const lockWait = { ANTIHALL_TEST_HOME_ISOLATED: '1', ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS: '30' };
const cli = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const C = (extra, ctx) => Object.assign({ env: Object.assign({}, cli, (extra && extra.env) || {}), setup: setupWith() }, ctx || {});

// ---- scenarios: sessions of Pre/Post pairs under different thresholds
const mix = (m) => () => pick(m);
const SESS = (name, ctx, count, len, gen, opts) => {
  for (let i = 0; i < count; i++) {
    const s = sid();
    const steps = [];
    for (let k = 0; k < len; k++) {
      const c = gen();
      const id = opts && opts.noIds ? undefined : `t${k}`;
      const kind = R();
      if (kind < 0.8) steps.push(...pair(s, c, id, opts && opts.extra));
      else if (kind < 0.9) steps.push(post(s, c, id, opts && opts.extra));
      else steps.push(pre(s, c, id, opts && opts.extra));
    }
    add(steps, ctx, `${name}-${i}`);
  }
};
const workish = mix([...WORK, ...WORK, ...READ, ...RECOVERY, ...OTHER.slice(0, 8)]);
const anyc = mix(ALL);
const readc = mix(READ);
const ctxDefault = C();
SESS('default', ctxDefault, 40, 10, workish);
SESS('default-all', ctxDefault, 25, 12, anyc);
SESS('default-read', ctxDefault, 15, 8, readc);
SESS('default-noid', ctxDefault, 15, 9, workish, { noIds: true });
const thr = (nudge, block, window, cap, extra) => C({ env: Object.assign({ ANTIHALL_COORDINATOR_WORK_NUDGE_AT: String(nudge), ANTIHALL_COORDINATOR_WORK_BLOCK_AT: String(block) }, window === undefined ? {} : { ANTIHALL_COORDINATOR_WORK_WINDOW_MINUTES: String(window) }, cap === undefined ? {} : { ANTIHALL_COORDINATOR_WORK_MAX_ENTRIES: String(cap) }, extra || {}) });
for (const [k, c] of Object.entries({
  n1b2: thr(1, 2), n2b3: thr(2, 3), n2b0: thr(2, 0), n0b3: thr(0, 3), n3b5cap2: thr(3, 5, undefined, 2), n2b4cap1: thr(2, 4, undefined, 1), win0: thr(2, 3, 0), win1: thr(2, 3, 1), n5b6: thr(5, 6), floats: thr('2.7', '3.2'), junk: thr('abc', 'x'), neg: thr('-1', '-5'), blank: thr(' ', ''),
})) SESS(`thr-${k}`, c, 12, 9, workish);
// settings.json instead of the environment, junk shapes
for (const [k, s] of Object.entries({
  file: { guards: { coordinatorWorkNudgeAt: 2, coordinatorWorkBlockAt: 3 } }, fileStr: { guards: { coordinatorWorkNudgeAt: '2', coordinatorWorkBlockAt: ' 3 ' } }, fileJunk: { guards: { coordinatorWorkNudgeAt: true, coordinatorWorkBlockAt: [1], coordinatorWorkWindowMinutes: null } },
  fileWin: { guards: { coordinatorWorkWindowMinutes: 0 } }, fileBad: '{no', fileArr: '[1]', fileSection: { guards: 3 }, fileNeg: { guards: { coordinatorWorkNudgeAt: -3, coordinatorWorkMaxEntries: 0 } }, fileCap: { guards: { coordinatorWorkMaxEntries: 2, coordinatorWorkNudgeAt: 2 } },
})) SESS(`set-${k}`, C(undefined, { settings: s }), 8, 8, workish);
// switches: command-guard off / skipped, the guard's own skip, entry points, subagents, Codex
for (const [k, c] of Object.entries({
  cgOff: C(undefined, { settings: { safety: { commandGuard: false } } }), cgOffEnv: C({ env: { ANTIHALL_COMMAND_GUARD: 'off' } }), cgOn: C({ env: { ANTIHALL_COMMAND_GUARD: '1' } }, { settings: { safety: { commandGuard: false } } }),
  skipCg: C(undefined, { skip: { 'command-guard': Date.now() + 3600e3 } }), skipAll: C(undefined, { skip: { all: Date.now() + 3600e3 } }), skipGuard: C({ env: { ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '2' } }, { skip: { 'coordinator-work-guard': Date.now() + 3600e3 } }), skipExpired: C(undefined, { skip: { 'command-guard': Date.now() - 5000 } }),
  epVscode: C({ env: { CLAUDE_CODE_ENTRYPOINT: 'vscode' } }), epJetbrains: C({ env: { CLAUDE_CODE_ENTRYPOINT: 'jetbrains' } }), epIde: C({ env: { CLAUDE_CODE_ENTRYPOINT: 'terminal_ide_x' } }), epAgent: C({ env: { CLAUDE_CODE_ENTRYPOINT: 'agent_tool' } }), epUnknown: C({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }), epNone: { env: {}, setup: setupWith() }, epEmpty: C({ env: { CLAUDE_CODE_ENTRYPOINT: '' } }),
})) SESS(`sw-${k}`, c, 6, 8, workish);
for (const [k, extra] of Object.entries({ agent: { agent_id: 'a1' }, agentType: { agent_type: 'Explore' }, agentFalsy: { agent_id: '' }, agentNum: { agent_id: 0 }, codex: { turn_id: 't1', model: 'gpt-5.5' }, codexAgent: { turn_id: 't1', model: 'gpt-5.5', agent_id: 'x' }, codexNullAgent: { turn_id: 't1', model: 'gpt-5.5', agent_id: null }, codexHalf: { turn_id: 't1' } }))
  SESS(`who-${k}`, ctxDefault, 5, 7, workish, { extra });
SESS('who-codex-noep', { env: {}, setup: setupWith() }, 5, 7, workish, { extra: { turn_id: 't1', model: 'gpt-5.5' } });
// payload shapes
const shapes = {
  noTool: p => { delete p.tool_name; }, otherTool: p => { p.tool_name = 'Edit'; }, noSid: p => { delete p.session_id; }, sidBlank: p => { p.session_id = '   '; }, sidNum: p => { p.session_id = 5; }, sidPad: p => { p.session_id = '  pad' + p.session_id + '  '; }, sidLong: p => { p.session_id = p.session_id + 'L'.repeat(120); }, sidWeird: p => { p.session_id = p.session_id + 'a/b c\u{1F600}é'; },
  noInput: p => { delete p.tool_input; }, nullInput: p => { p.tool_input = null; }, cmdNum: p => { p.tool_input.command = 5; }, cmdEmpty: p => { p.tool_input.command = ''; }, cmdWs: p => { p.tool_input.command = '   '; }, noId: p => { delete p.tool_use_id; }, idNum: p => { p.tool_use_id = 5; }, idEmpty: p => { p.tool_use_id = ''; },
  longCmd: p => { p.tool_input.command = 'ls ' + 'a'.repeat(5000); }, unicodeCmd: p => { p.tool_input.command = 'ls é'; }, cr: p => { p.tool_input.command = 'ls\r\npwd'; },
};
for (const [k, f] of Object.entries(shapes)) {
  for (const c of ['ls', 'git commit -m x', 'git status && ls']) {
    const s = sid();
    const a = pair(s, c, 'x1'), b = pair(s, c, 'x2');
    for (const st of [...a, ...b]) f(st.payload);
    add([...a, ...b, ...pair(s, c, 'x3')], ctxDefault, `shape-${k}-${c.slice(0, 8)}`);
  }
}
// seeded session state (the engine reads and rewrites what Node wrote)
const SEEDS = {
  fresh: mk('0.1.0', { calls: 3, work: 3, ts: [T0 - 5000, T0 - 4000, T0 - 3000], armed: false }), armedTrue: mk('0.1.0', { calls: 3, work: 3, ts: [T0 - 5000, T0 - 4000, T0 - 3000], armed: true }), old: mk('0.1.0', { calls: 3, work: 3, ts: [T0 - 7200e3, T0 - 7100e3, T0 - 7000e3] }),
  withPre: mk('0.1.0', { pre: [{ id: 'p1', work: true, blockable: true }, { id: 'p2', work: false, blockable: false }, { id: 'p1', work: false, blockable: true }] }), manyPre: mk('0.1.0', { pre: Array.from({ length: 30 }, (_, i) => ({ id: 'q' + i, work: i % 2 === 0, blockable: true })) }),
  corrupt: '{not json', arr: '[1]', num: '5', nul: 'null', str: '"x"', empty: '', ver12: JSON.stringify({ version: 12, calls: 1 }), noVer: JSON.stringify({ calls: 1, work: 1 }), floats: mk('0.1.0', { calls: 1.5, work: 0.5, ts: [T0, 'x', null, 1e3] }), strNums: JSON.stringify({ version: '0.1.0', calls: '3', work: '2', firstTs: '5', ts: ['1', 2], armed: 'false' }),
  badPre: mk('0.1.0', { pre: [{ id: 5, work: true, blockable: true }, { id: '', work: true, blockable: true }, { id: 'ok', work: 'yes', blockable: true }, null, 'x', { id: 'good', work: true, blockable: false }] }), negCounters: mk('0.1.0', { calls: -1, work: -2, blocks: -3 }), extraKeys: JSON.stringify({ v: 1, version: '0.1.0', junk: [1], firstTs: T0, ts: [], armed: true, calls: 0, work: 0, blocks: 0, lastBlockAt: 0, skippedWouldBlock: 0, pre: [] }),
};
const seedCtx = C({ env: { ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '4', ANTIHALL_COORDINATOR_WORK_BLOCK_AT: '6' } });
seedCtx.setup = setupWith((home, d) => { for (const [k, v] of Object.entries(SEEDS)) fs.writeFileSync(path.join(d, `coordinator-work-session-seed-${k}.json`), v); });
for (const k of Object.keys(SEEDS)) add([...pair(`seed-${k}`, 'git commit -m a', 'p1'), ...pair(`seed-${k}`, 'git commit -m b', 'p2'), ...pair(`seed-${k}`, 'ls', 'p3'), ...pair(`seed-${k}`, 'git push', 'p4'), ...pair(`seed-${k}`, 'git commit -m c', 'q1'), post(`seed-${k}`, 'git status', 'q2')], seedCtx, `seed-${k}`);
// stored pre-verdicts are reused: a Post whose command differs from its Pre (the script was deleted) follows the stored verdict
for (let i = 0; i < 10; i++) { const s = sid(); add([pre(s, pick(WORK), 'k1'), post(s, 'ls', 'k1'), pre(s, 'ls', 'k2'), post(s, pick(WORK), 'k2'), pre(s, pick(WORK), 'k3'), post(s, pick(WORK), 'k3')], ctxDefault, `reuse-${i}`); }
// locks held by a live process, abandoned locks, and torn lock files
const lockCtx = (name, extra) => C({ env: Object.assign({ ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '2' }, lockWait) }, { setup: setupWith((home, d) => extra(home, d)) });
const held = Date.now() + 3600e3;
const lockScen = {
  sessionHeld: [(h, d) => fs.writeFileSync(path.join(d, 'coordinator-work-session-lk.json.lock'), lockRec(held)), ['lk']],
  sessionStale: [(h, d) => fs.writeFileSync(path.join(d, 'coordinator-work-session-lk.json.lock'), lockRec(Date.now() - 60e3, 999999)), ['lk']],
  sessionTorn: [(h, d) => { const f = path.join(d, 'coordinator-work-session-lk.json.lock'); fs.writeFileSync(f, '{"pid":'); const t = new Date(Date.now() - 60e3); fs.utimesSync(f, t, t); }, ['lk']],
  sessionTornFresh: [(h, d) => fs.writeFileSync(path.join(d, 'coordinator-work-session-lk.json.lock'), '{"pid":'), ['lk']],
  metricsHeld: [(h, d) => fs.writeFileSync(path.join(d, 'coordinator-work-metrics.json.lock'), lockRec(held)), ['lk']],
  metricsStale: [(h, d) => fs.writeFileSync(path.join(d, 'coordinator-work-metrics.json.lock'), lockRec(Date.now() - 60e3, 999999)), ['lk']],
  foldLockHeld: [(h, d) => fs.writeFileSync(path.join(d, 'coordinator-work-session-stale-a.json.lock'), lockRec(held)), ['lk']],
  foldLockStale: [(h, d) => fs.writeFileSync(path.join(d, 'coordinator-work-session-stale-a.json.lock'), lockRec(Date.now() - 60e3, 999999)), ['lk']],
};
for (const [k, [fn]] of Object.entries(lockScen)) add([...pair('lk', 'git commit -m a', 'a1'), ...pair('lk', 'git commit -m b', 'a2'), ...pair('lk', 'git commit -m c', 'a3'), post('lk', 'ls', 'a4'), post('lk', 'git push', 'a5')], lockCtx(k, fn), `lock-${k}`);
// real commands and fuzz
const cmds = readCmds(arg('--cmds', '../../fpr/cmds.jsonl')).filter(c => !c.cmd.includes('$HOME'));
const bySession = new Map();
for (const c of cmds) { if (!bySession.has(c.session)) bySession.set(c.session, []); bySession.get(c.session).push(c); }
let real = 0;
for (const [, list] of bySession) {
  if (real >= +arg('--real', 600)) break;
  const s = sid();
  const steps = [];
  list.slice(0, 12).forEach((c, k) => steps.push(...pair(s, c.cmd, 'r' + k, { cwd: '/tmp' })));
  real += Math.min(12, list.length);
  add(steps, C({ env: { ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '3', ANTIHALL_COORDINATOR_WORK_BLOCK_AT: '5' } }), `real-${real}`);
}
const WS = [' ', '\t', '\n', ';', '&&', '||', '|', '&', ' \\\n'];
const frag = ['ls', 'git', 'status', 'commit', '-m', 'x', 'push', 'cat', 'f', 'head', '|', '$(', ')', '"', "'", '>', '<', '*', '{', '}', '\\', 'FOO=1', 'log', '--output', '-o', 'diff', 'wc', 'grep', 'a.b', '/', '-', '=', '@', '%', '+', ','];
const fz = C({ env: { ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '3', ANTIHALL_COORDINATOR_WORK_BLOCK_AT: '6' } });
for (let i = 0; i < +arg('--fuzz', 600); i++) { const s = sid(), steps = []; for (let k = 0; k < 4; k++) { const parts = []; for (let j = 0, m = 1 + Math.floor(R() * 8); j < m; j++) parts.push(pick(frag), pick(WS)); steps.push(...pair(s, parts.join(''), 'f' + k)); } add(steps, fz, `fuzz-${i}`); }
console.error(`scenarios=${scenarios.length}`);

// ---- normalisation of what legitimately differs (clock values)
const normText = (f, t) => {
  if (/\.lock$/.test(f)) return 'LOCK';
  if (/^coordinator-work-session-.*\.json$/.test(f)) return t.replace(/"firstTs":(?!0[,}])[0-9.e+-]+/, '"firstTs":T').replace(/"lastBlockAt":(?!0[,}])[0-9.e+-]+/, '"lastBlockAt":T').replace(/"ts":\[([^\]]*)\]/, (m, a) => '"ts":[' + a.split(',').filter(Boolean).map(() => 'T').join(',') + ']');
  if (/trips\.log$/.test(f)) return t.split('\n').filter(Boolean).map(l => l.replace(/"ts":"[^"]*"/, '"ts":"T"')).sort().join('\n');
  if (/fold-stamp/.test(f)) return t.replace(/\d+/, 'T');
  return t;
};
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const files = p => { const sidv = typeof p.session_id === 'string' ? p.session_id.trim() : ''; return new RegExp('^coordinator-work-session-' + esc(safeSid(sidv, 80)) + '\\.json(\\.lock)?$'); };
runParity({
  name: 'coordinator-work-guard-post', check: 'coordinator-work-guard', hookFile: 'coordinator-work-guard.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: 'daemon', events: ['PreToolUse', 'PostToolUse'],
  dual: true, fallbackReal: true, fallbackArgv: { PostToolUse: ['--post'] }, stateFiles: files, stateNorm: normText,
  sharedFiles: /^(coordinator-work-metrics\.json|coordinator-work-trips\.log|\.coordinator-work-fold-stamp\.json|coordinator-work-session-(stale|fresh)-.*\.json)$/,
  conc: +arg('--conc', 4), show: +arg('--show', 15), nodeArgv: s => (s.payload.hook_event_name === 'PostToolUse' ? ['--post'] : []),
});
