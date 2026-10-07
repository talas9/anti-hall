#!/usr/bin/env node
// Parity of the built-in `failure-root-cause-nudge` check against hooks/failure-root-cause-nudge.js (PostToolUseFailure on
// Bash), run as the real script in a child process. The engine gets its own home; the once-per-turn state file
// (turn-gate/tg-<session>.json) is compared byte for byte after every step.
//   node run-failure-nudge.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--mode daemon|oneshot] [--conc 6] [--show 15] [--real 3000] [--seed 1]
// Corpus: (1) expected-failure commands x exit-code texts, (2) payload shapes incl. malformed raw stdin, (3) turn gating over
// transcripts (human prompts, tool results, meta/sidechain/injected entries, uuid/timestamp, partial tail line, agents),
// (4) seeded turn-gate state files of every shape, (5) switches and skip (env, settings.json, plugin option, skip.json),
// (6) real commands from the field data as failures, (7) fuzzed commands.
const { arg, runParity, readCmds, rng, safeSid } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
let n = 0;
const sid = () => `f${n++}`;
const add = (steps, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps });
const fail = (s, command, error, extra) => Object.assign({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', session_id: s, cwd: '/tmp', tool_input: { command }, error }, extra || {});
const one = (command, error, extra) => [{ payload: fail(sid(), command, error, extra) }];

// ---- transcripts (written into the home of the context that names them)
const jl = (...o) => o.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n';
const human = (uuid, text, extra) => Object.assign({ type: 'user', uuid, message: { role: 'user', content: text } }, extra || {});
const humanArr = (uuid, parts, extra) => Object.assign({ type: 'user', uuid, message: { role: 'user', content: parts } }, extra || {});
const asst = uuid => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
const TR = {
  plain: jl(human('u1', 'fix the bug'), asst('a1')),
  twoPrompts: jl(human('u1', 'first'), asst('a1'), human('u2', 'second'), asst('a2')),
  toolResultLast: jl(human('u1', 'run it'), asst('a1'), humanArr('u2', [{ type: 'tool_result', content: 'x' }])),
  injectedLast: jl(human('u1', 'real prompt'), human('u2', '<system-reminder>hi</system-reminder>'), human('u3', '  <task-notification>x'), human('u4', '<command-name>/x</command-name>')),
  metaLast: jl(human('u1', 'real'), human('u2', 'meta prompt', { isMeta: true }), human('u3', 'side', { isSidechain: true })),
  arrText: jl(human('u0', 'old'), humanArr('u9', [{ type: 'text', text: 'array prompt' }, { type: 'image' }])),
  arrNoText: jl(human('u1', 'old'), humanArr('u2', [{ type: 'image' }])),
  ts: jl({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'only timestamp' } }),
  noId: jl({ type: 'user', message: { content: 'no id at all' } }),
  numId: jl({ type: 'user', uuid: 12345, message: { content: 'numeric id' } }),
  emptyContent: jl(human('u1', 'real'), human('u2', '')),
  garbage: 'not json\n{"type":"user"\n"user" nope\n' + jl(human('ug', 'after garbage')),
  crlf: [JSON.stringify(human('c1', 'one')), JSON.stringify(asst('c2'))].join('\r\n') + '\r\n',
  noTrailingNl: JSON.stringify(human('n1', 'no newline at end')),
  unicode: jl(human('é-1', 'ünï ☃ \u{1F600}')),
  empty: '',
  onlyAssistant: jl(asst('a1'), asst('a2')),
  bigTail: jl(human('early', 'early prompt')) + jl(asst('x')).repeat(1) + ('{"type":"assistant","message":{"content":"' + 'z'.repeat(1000) + '"}}\n').repeat(700),
  bigTailPrompt: ('{"type":"assistant","message":{"content":"' + 'z'.repeat(1000) + '"}}\n').repeat(700) + jl(human('late', 'late prompt')),
  partialFirst: ('{"type":"user","uuid":"cut","message":{"content":"' + 'y'.repeat(530000) + '"}}\n') + jl(human('tail', 'tail prompt')),
};
const trFiles = Object.fromEntries(Object.entries(TR).map(([k, v]) => ['tr-' + k + '.jsonl', v]));
const withTr = (extra) => Object.assign({}, { files: Object.assign({}, trFiles, extra || {}) });

// ---- (1) expected-failure commands x error texts
const EXIT1 = 'Exit code 1\n';
const PRED = ['grep -q foo file', 'grep foo file', 'rg pattern src', 'test -f /nonexistent', '[ -d /x ]', '[[ -z "$X" ]]', 'diff a b', 'cmp a b', 'pgrep node', 'which nosuchtool', 'type foo',
  'git diff --quiet', 'git diff --exit-code HEAD', 'git -C /repo diff --quiet', 'git merge-base --is-ancestor a b', 'git grep foo', 'git cat-file -e HEAD:x', 'git ls-files --error-unmatch f', 'git show-ref --verify refs/heads/x',
  'git show-ref -q x', 'command -v node', 'command -V node', 'FOO=1 command -v x', 'cat f | grep x', 'ls | grep -q x', 'echo hi && grep x f', 'true && test -f x', 'echo a; grep x f', 'make\ngrep x f', 'cd /tmp && grep x f',
  'env grep x f', 'time grep x f', 'nice -n 5 grep x f', 'nohup grep x f', 'FOO=bar grep x f', '/usr/bin/grep x f', 'builtin test -f x', 'ack foo', 'ag foo', 'ugrep foo', 'egrep a f', 'fgrep a f', ': && grep a f', 'printf x && grep a f',
  'grep a f 2>/dev/null', 'grep a f > /dev/null 2>&1', 'cat <<< x | grep a', 'ls |& grep a', 'a \\\n| grep x', 'grep a f # comment', 'echo "a;b" ; grep x f', "echo 'a && b' && grep x f", 'grep "a|b" f', 'X=$(echo y) grep a f', 'grep a $(echo f)'];
const NOTPRED = ['npm test', 'make build', 'ls /nonexistent', 'cat nofile', 'git status', 'git diff', 'git push', 'grep a f || echo no', 'if grep a f; then echo y; fi', 'for i in 1 2; do grep a f; done', 'set -e; grep a f', 'grep a f; exit 1',
  'bash -e -c "grep a f"', 'sh -ec "grep a f"', 'grep a f &', 'grep a f & ', 'set -o pipefail; grep a f', 'cat <<EOF\nx\nEOF', 'grep a f && echo done', 'grep a f && npm test', 'echo $(grep a f)', 'grep a f | tee out', 'grep a f | wc -l',
  '(grep a f)', '{ grep a f; }', '! grep a f', 'eval "grep a f"', 'trap x EXIT; grep a f', 'exec grep a f', 'while true; do grep a f; done', 'case x in x) grep a f;; esac', 'function f { grep a f; }', '# only a comment', '', '   ', 'grep a f \\',
  "echo 'unbalanced", 'echo "unbalanced', 'echo `unbalanced', 'grep a `echo f`', 'tail -f x | grep a', 'test -f x || true', 'grep a f ; ', 'grep a f ;; ', 'echo x &&', 'curl -f http://x', 'node script.js', 'python3 -c "import sys; sys.exit(1)"'];
const ERR = ['Exit code 1\n', 'Exit code 1', 'Exit code 2\n', 'Exit code 01\n', 'Exit code 0\n', 'Exit code 10\n', 'exit code 1', '  Exit code 1\nstuff', 'Exit code 1abc', 'Exit code 1_', 'Exit code 1.5', 'Exit code 100000000000000000001', '', 'Error: something', undefined,
  'This agent is isolated in the worktree /x', 'This session is isolated in the worktree\nmore', '  This agent is isolated in the worktree', 'This agent is isolated in the worktrees', 'This workspace is isolated in the worktree'];
for (const c of PRED) for (const e of ERR) add(one(c, e), undefined, `exp-${c.slice(0, 24)}`);
for (const c of NOTPRED) for (const e of [EXIT1, 'Exit code 2\n', '']) add(one(c, e), undefined, `notexp-${c.slice(0, 24)}`);

// ---- (2) payload shapes
const base = () => fail(sid(), 'false', 'Exit code 1\n');
const shapes = {
  noTool: p => { delete p.tool_name; }, otherTool: p => { p.tool_name = 'Edit'; }, lowerTool: p => { p.tool_name = 'bash'; }, noInput: p => { delete p.tool_input; }, nullInput: p => { p.tool_input = null; },
  cmdNum: p => { p.tool_input.command = 5; }, cmdNull: p => { p.tool_input.command = null; }, cmdArr: p => { p.tool_input.command = ['a']; }, noCmd: p => { p.tool_input = {}; }, emptyCmd: p => { p.tool_input.command = ''; },
  errNum: p => { p.error = 1; }, errNull: p => { p.error = null; }, noErr: p => { delete p.error; }, interrupt: p => { p.is_interrupt = true; }, interruptStr: p => { p.is_interrupt = 'true'; }, interruptFalse: p => { p.is_interrupt = false; },
  noSid: p => { delete p.session_id; }, sidNum: p => { p.session_id = 7; }, sidEmpty: p => { p.session_id = ''; }, sidObj: p => { p.session_id = { a: 1 }; }, sidArr: p => { p.session_id = ['x', 'y']; }, sidBool: p => { p.session_id = true; }, sidZero: p => { p.session_id = 0; },
  agent: p => { p.agent_id = 'agent-1'; }, agentNum: p => { p.agent_id = 5; }, agentEmpty: p => { p.agent_id = ''; },
  longCmd: p => { p.tool_input.command = 'x'.repeat(200); }, cmd80: p => { p.tool_input.command = 'y'.repeat(80); }, cmd81: p => { p.tool_input.command = 'y'.repeat(81); },
  ws: p => { p.tool_input.command = '  echo \t a \n b   '; }, uni: p => { p.tool_input.command = 'echo é☃\u{1F600}x'; },
  emoji79: p => { p.tool_input.command = 'a'.repeat(79) + '\u{1F600}tail'; }, emoji80: p => { p.tool_input.command = 'a'.repeat(78) + '\u{1F600}tail'; }, emoji81: p => { p.tool_input.command = 'a'.repeat(80) + '\u{1F600}tail'; },
  cjk: p => { p.tool_input.command = '日本語'.repeat(40); }, nl: p => { p.tool_input.command = 'a\nb\r\nc d e'; }, bt: p => { p.tool_input.command = 'echo `x` "y" \'z\' \\ $ { }'; }, quote: p => { p.tool_input.command = 'echo "he said \\"hi\\""'; },
  tpNum: p => { p.transcript_path = 5; }, tpEmpty: p => { p.transcript_path = ''; }, tpMissing: p => { p.transcript_path = '/nonexistent/x.jsonl'; }, tpDir: p => { p.transcript_path = '/tmp'; },
};
for (const [k, f] of Object.entries(shapes)) { const p = base(); f(p); add([{ payload: p }], undefined, `shape-${k}`); const p2 = base(); f(p2); p2.session_id = p2.session_id === undefined ? undefined : p2.session_id; }
for (const [k, raw] of Object.entries({ notjson: 'not json', empty: '', ws: '   ', arr: '[1]', num: '5', str: '"x"', nul: 'null', tru: 'true', obj: '{}', truncated: '{"tool_name":"Bash"', bom: '﻿{"tool_name":"Bash"}', deep: '['.repeat(200) + ']'.repeat(200) }))
  add([{ payload: {}, raw }], undefined, `raw-${k}`);

// ---- (3) turn gating over transcripts
const tp = k => '$HOME/tr-' + k + '.jsonl';
const f1 = (s, k, command, extra) => ({ payload: fail(s, command || 'false', 'Exit code 2\nboom', Object.assign({ transcript_path: tp(k) }, extra || {})) });
const ctxT = withTr();
for (const k of Object.keys(TR)) {
  const s = sid();
  add([f1(s, k), f1(s, k, 'false2'), f1(s, k, 'false3'), f1(sid(), k)], ctxT, `turn-${k}`);
}
{ // a new turn: the same session, another transcript with a different newest prompt
  const s = sid();
  add([f1(s, 'plain'), f1(s, 'plain'), f1(s, 'twoPrompts'), f1(s, 'twoPrompts'), f1(s, 'plain'), f1(s, 'plain')], ctxT, 'turn-newturn');
  const s2 = sid();
  add([f1(s2, 'plain', 'x', { agent_id: 'ag1' }), f1(s2, 'plain', 'x', { agent_id: 'ag1' }), f1(s2, 'plain', 'x', { agent_id: 'ag2' }), f1(s2, 'plain', 'x'), f1(s2, 'plain', 'x'), f1(s2, 'plain', 'x', { agent_id: 'ag1' })], ctxT, 'turn-agents');
  const s3 = sid();
  add([f1(s3, 'plain', 'x', { transcript_path: undefined }), f1(s3, 'plain', 'x', { transcript_path: undefined }), f1(s3, 'plain', 'x', { transcript_path: 5 })], ctxT, 'turn-nopath');
  for (const id of ['weird id/1', 'ünï', 'a'.repeat(100), '\u{1F600}x', 'x y', '..', 'a.b-c_d', 12, true, ['a', 'b'], { k: 1 }, 'a'.repeat(79) + '\u{1F600}']) {
    add([f1(id, 'plain'), f1(id, 'plain')], withTr(), `turn-sid-${JSON.stringify(id).slice(0, 12)}`);
  }
}
// ---- (4) seeded turn-gate state files
const SLOT = 'failure-root-cause-nudge|main';
const STATES = {
  corrupt: '{nope', empty: '', arr: '[]', arrFull: '[1,2,3]', num: '5', zero: '0', str: '"x"', emptyStr: '""', nul: 'null', tru: 'true', fls: 'false', obj: '{}',
  sameTurn: JSON.stringify({ [SLOT]: { turn: 'u1', sigs: [''] } }), sameTurnNoEmpty: JSON.stringify({ [SLOT]: { turn: 'u1', sigs: ['x'] } }), otherTurn: JSON.stringify({ [SLOT]: { turn: 'u0', sigs: [''] } }),
  noSigs: JSON.stringify({ [SLOT]: { turn: 'u1' } }), sigsStr: JSON.stringify({ [SLOT]: { turn: 'u1', sigs: '' } }), turnNum: JSON.stringify({ [SLOT]: { turn: 1, sigs: [''] } }), slotNull: JSON.stringify({ [SLOT]: null }), slotStr: JSON.stringify({ [SLOT]: 'x' }),
  manySigs: JSON.stringify({ [SLOT]: { turn: 'u1', sigs: Array.from({ length: 30 }, (_, i) => 's' + i) } }),
  otherKeys: '{"z":1,"output-verify-guard|main":{"turn":"u1","sigs":["a","b"]},"a":{"x":[1,{"y":2}],"b":null},"10":1,"2":"two","01":3}',
  dupKeys: '{"a":1,"a":2,"' + SLOT + '":{"turn":"u0","sigs":[]}}', nested: '{"k":{"b":1,"a":2,"c":{"z":1,"y":2}}}', numbers: '{"n":1e3,"m":1.5,"big":12345678901234567890,"neg":-0,"tiny":1e-7,"huge":1e21,"f":0.1}',
  unicodeKeys: '{"é":1,"\u{1F600}":2,"a\\u0000b":3}', ws: '  {\n  "k" : 1 \n}\n', spaced: '{"a": [1, 2, {"b": 3}]}',
};
const stCtx = { files: Object.assign({}, trFiles, Object.fromEntries(Object.keys(STATES).map(k => ['.anti-hall/turn-gate/tg-st-' + k + '.json', STATES[k]]))) };
for (const k of Object.keys(STATES)) add([f1('st-' + k, 'plain'), f1('st-' + k, 'plain', 'again'), f1('st-' + k, 'twoPrompts', 'next turn')], stCtx, `state-${k}`);
// ---- (5) switches and skip
const sw = [f1('sw', 'plain'), f1('sw', 'plain', 'again')];
const swp = (extra) => Object.assign({ files: trFiles }, extra);
const ctxs = {
  off: swp({ settings: { guards: { failureRootCauseNudge: false } } }), offStr: swp({ settings: { guards: { failureRootCauseNudge: 'off' } } }), offNum: swp({ settings: { guards: { failureRootCauseNudge: 0 } } }), onStr: swp({ settings: { guards: { failureRootCauseNudge: 'yes' } } }),
  junk: swp({ settings: { guards: { failureRootCauseNudge: 'maybe' } } }), badjson: swp({ settings: '{no' }), section: swp({ settings: { guards: 5 } }),
  envOff: swp({ env: { ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE: 'off' } }), env0: swp({ env: { ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE: '0' } }), env1: swp({ env: { ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE: '1' }, settings: { guards: { failureRootCauseNudge: false } } }), envJunk: swp({ env: { ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE: 'zz' }, settings: { guards: { failureRootCauseNudge: false } } }),
  optFalse: swp({ env: { CLAUDE_PLUGIN_OPTION_GUARDS_FAILURE_ROOT_CAUSE_NUDGE: 'false' } }), optTrue: swp({ env: { CLAUDE_PLUGIN_OPTION_GUARDS_FAILURE_ROOT_CAUSE_NUDGE: 'true' } }), optHost: swp({ claude: { pluginConfigs: { 'anti-hall': { options: { guards_failure_root_cause_nudge: false } } } } }),
  noFilter: swp({ settings: { guards: { failureNudgeFilter: false } } }), noFilterEnv: swp({ env: { ANTIHALL_FAILURE_NUDGE_FILTER: 'off' } }), filterOnEnv: swp({ env: { ANTIHALL_FAILURE_NUDGE_FILTER: '1' }, settings: { guards: { failureNudgeFilter: false } } }), noFilterStr: swp({ settings: { guards: { failureNudgeFilter: 'no' } } }),
  skip: swp({ skip: { 'failure-root-cause-nudge': Date.now() + 3600e3 } }), skipAll: swp({ skip: { all: Date.now() + 3600e3 } }), skipExpired: swp({ skip: { 'failure-root-cause-nudge': Date.now() - 1000, all: Date.now() - 1000 } }), skipJunk: swp({ skip: '{no' }), skipStr: swp({ skip: { 'failure-root-cause-nudge': 'x' } }),
};
for (const [k, c] of Object.entries(ctxs)) {
  add(sw, c, `ctx-${k}`);
  add([f1('sw2', 'plain', 'grep a f', {}), { payload: fail('sw2', 'grep -q a f', EXIT1, { transcript_path: tp('plain') }) }, f1('sw2', 'plain', 'x')], c, `ctx2-${k}`);
}
// ---- (6) real commands as failures, (7) fuzz
const cmds = readCmds(arg('--cmds', '../../fpr/cmds.jsonl')).filter(c => !c.cmd.includes('$HOME')); // $HOME is replaced per home by the harness
const want = +arg('--real', 3000);
const tpk = Object.keys(TR);
for (let i = 0; i < Math.min(want, cmds.length); i++) {
  const c = cmds[Math.floor(R() * cmds.length)];
  add([{ payload: fail(sid(), c.cmd, pick([EXIT1, EXIT1, 'Exit code 2\n', 'Exit code 127\n', 'Exit code 1\nstdout...', ''])) }], undefined, `real-${i}`);
}
const WS = [' ', '\t', '\n', ';', '&&', '||', '|', '|&', '&', '\\\n', '  '];
const frag = ['grep', 'test', '[', 'diff', 'echo', 'true', ':', 'git', 'diff', '--quiet', '-q', 'x', 'f', 'command', '-v', 'node', '$(', ')', '`', '"', "'", '{', '}', '(', 'if', 'then', 'fi', '2>&1', '>', '<', '<<', 'set', '-e', 'exec', 'FOO=1', '!', '#'];
for (let i = 0; i < 4000; i++) {
  const parts = [];
  const k = 1 + Math.floor(R() * 9);
  for (let j = 0; j < k; j++) parts.push(pick(frag), pick(WS));
  add([{ payload: fail(sid(), parts.join(''), pick([EXIT1, EXIT1, EXIT1, 'Exit code 2\n'])) }], undefined, `fuzz-${i}`);
}
// the human-text / state fuzz over transcripts
for (let i = 0; i < 300; i++) {
  const s = sid();
  const k = pick(tpk);
  add([f1(s, k, 'false'), f1(s, pick(tpk), 'false'), f1(s, k, 'false')], ctxT, `turnfuzz-${i}`);
}
console.error(`scenarios=${scenarios.length}`);
const gate = p => { const s = p.session_id; const sidv = s === undefined || s === null ? '' : Array.isArray(s) ? s.join(',') : typeof s === 'object' ? '[object Object]' : String(s); return new RegExp('^turn-gate/tg-' + safeSid(sidv, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.json$'); };
runParity({ name: 'failure-root-cause-nudge', check: 'failure-root-cause-nudge', hookFile: 'failure-root-cause-nudge.js', nodeCli: true, events: ['PostToolUseFailure'], scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'daemon'), dual: true, stateFiles: gate, conc: +arg('--conc', 6), show: +arg('--show', 15) });
