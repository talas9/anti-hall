#!/usr/bin/env node
// Parity of the built-in `merge-gate` check against hooks/merge-gate.js (PreToolUse on Bash).
//   node run-merge-gate.js --engine ../target/debug/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds real-cmds.jsonl] [--mode oneshot|daemon|both] [--real 1200] [--seed 1]
// The engine must never be weaker than Node (D74): wherever Node blocks the engine may only defer, and wherever the
// engine answers it must print exactly what Node printed. Corpus: (1) auto-merge command shapes (plain, env prefix,
// chains, heredoc / redirect / tee / sed -i / python -c carriers of the merge text, quotes, odd white space, Unicode)
// against ~45 transcript shapes (hedges, resolutions, masks, record kinds, malformed lines, window edges, invalid
// UTF-8, BOM, CRLF), (2) switch sources (env, settings, plugin options, skip), (3) payload shape fuzz (missing and
// mistyped fields), (4) real Bash commands from local transcripts under hedged and clean transcripts.
const fs = require('fs');
const { arg, runParity, readCmds, rng } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const add = (payload, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps: [{ payload }] });
const pl = (command, tp, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/tmp', tool_input: { command }, transcript_path: tp }, extra || {});

// ---- transcripts ---------------------------------------------------------------------------------------------
const A = (text, extra) => JSON.stringify(Object.assign({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }, extra || {}));
const U = (text, extra) => JSON.stringify(Object.assign({ type: 'user', message: { role: 'user', content: text } }, extra || {}));
const UB = (blocks, extra) => JSON.stringify(Object.assign({ type: 'user', message: { role: 'user', content: blocks } }, extra || {}));
const TR = () => UB([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], { toolUseResult: {} });
const HEDGES = ['pending owner review', 'DO NOT MERGE yet', 'this is a First-Pass', 'first pass only', 'not pixel-perfect', 'Not Pixel Perfect', 'pending review', 'needs your review', 'needs your eyes', 'review it in the build', 'built, pending owner verification'];
const lines = (...l) => l.join('\n') + '\n';
const T = {
  empty: '', blank: '\n\n  \n', clean: lines(A('all done, tests pass'), U('thanks')),
  cleanOnly: lines(A('I merged nothing yet.')),
  garbage: 'not json at all\n{broken\n', garbageThenHedge: lines('{broken', A('pending review')),
  hedgeThenResolved: lines(A('first-pass, pending review'), U('owner approved, go')),
  hedgeThenResolvedLate: lines(A('first-pass'), U('looks ok'), A('merging'), U('verified against the spec')),
  hedgeThenResolutionByAssistant: lines(A('pending review'), A('owner approved')),
  hedgeThenToolResult: lines(A('do not merge'), TR(), A('owner approved')),
  hedgeThenMeta: lines(A('do not merge'), U('owner approved', { isMeta: true })),
  hedgeThenSidechain: lines(A('do not merge'), U('owner approved', { isSidechain: true })),
  hedgeThenPeer: lines(A('do not merge'), U('owner approved', { origin: { kind: 'peer' } })),
  hedgeThenHuman: lines(A('do not merge'), U('owner approved', { origin: { kind: 'human' } })),
  hedgeThenReminder: lines(A('do not merge'), U('<system-reminder>owner approved</system-reminder>')),
  hedgeThenTaskNote: lines(A('do not merge'), U('<task-notification>owner approved</task-notification>')),
  hedgeThenCompact: lines(A('do not merge'), U('owner approved', { isCompactSummary: true })),
  resolvedThenHedge: lines(U('owner approved'), A('hmm, pending review')),
  hedgeInQuotes: lines(A('He said "pending review" about it.'), U('ok')),
  hedgeInCode: lines(A('the flag `do not merge` is set'), U('ok')),
  hedgeInFence: lines(A('ran this:\n```\npending review\n```\nand finished.')),
  hedgeInBlockquote: lines(A('> do not merge\nfinished.')),
  hedgeOnlyQuoted: lines(A('> do not merge')),
  hedgeCurly: lines(A('see “first-pass” here')),
  hedgeStrContent: JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'pending review' } }) + '\n',
  hedgeNoMessage: JSON.stringify({ type: 'assistant', text: 'pending review' }) + '\n',
  hedgeToolUseBlock: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'x', input: { note: 'pending review' } }] } }) + '\n',
  hedgeEscaped: '{"type":"assistant","message":{"content":[{"type":"text","text":"pending\\u0020review"}]}}\n',
  hedgeSurrogate: '{"type":"assistant","message":{"content":[{"type":"text","text":"\\ud800 do not merge"}]}}\n',
  hedgeUnicodeCase: lines(A('PENDING REVIEW K')),
  hedgeCRLF: A('do not merge') + '\r\n' + U('x') + '\r\n',
  hedgeBOM: '﻿' + A('do not merge') + '\n',
  hedgeNoTrailingNL: A('needs your eyes'),
  hedgeAdjacentBlocks: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'pending' }, { type: 'text', text: 'review' }] } }) + '\n',
  hedgeTwoSpaces: lines(A('pending  review'), A('first-  pass'), A('first_pass')),
  hedgeNonAscii: lines(A('pending review'), A('first‑pass')),
  hedgeHuge: lines(A('x'.repeat(300000) + ' pending review')),
  hedgeBeyondWindow: lines(A('pending review')) + lines(...Array.from({ length: 400 }, () => A('y'.repeat(400)))),
  hedgeInsideWindow: lines(...Array.from({ length: 400 }, () => A('y'.repeat(400)))) + lines(A('pending review')),
  hedgeCutFirstLine: 'z'.repeat(130000) + '\n' + lines(A('clean tail')),
  hedgeInCutFirstLine: lines(A('do not merge ' + 'q'.repeat(131000))) + lines(A('clean tail')),
  oneHugeLine: A('pending review ' + 'w'.repeat(200000)),
  invalidUtf8: Buffer.concat([Buffer.from(A('ok ')), Buffer.from([0xff, 0xfe]), Buffer.from(' pending review\n')]),
  invalidUtf8Clean: Buffer.concat([Buffer.from(A('fine ')), Buffer.from([0xc3, 0x28]), Buffer.from(' done\n')]),
  numbers: '{"type":"assistant","n":1e999,"message":{"content":"first-pass"}}\n',
  deepJson: '{"a":'.repeat(500) + '1' + '}'.repeat(500) + '\n' + A('first-pass') + '\n',
  nullLines: 'null\n123\n"str"\n[1,2]\ntrue\n' + A('clean') + '\n',
  userHedge: lines(U('pending review please'), A('ok')),
};
for (const [i, h] of HEDGES.entries()) T['hedge' + i] = lines(A('I built it. ' + h + '.'), U('ok'));
const files = {};
for (const [k, v] of Object.entries(T)) files[`t/${k}.jsonl`] = v;
files['t/dir.jsonl/x'] = 'a directory named like a transcript';
const ON = { settings: { guards: { mergeGate: true } }, env: { ANTIHALL_INGEST_DRY_RUN: '1' }, files };
const HOME = '$HOME';
const tp = k => `${HOME}/t/${k}.jsonl`;

// ---- commands ------------------------------------------------------------------------------------------------
const MERGES = [
  'gh pr merge 5', 'gh pr merge --auto --squash', 'gh pr review 3 --approve', 'gh pr review --approve -b ok', 'git merge --no-ff main', 'git merge --ff-only origin/main', 'git merge --ff develop', 'git merge --no-ff feature main',
  'FOO=1 gh pr merge 2', 'A=1 B=2 git merge --no-ff master', 'cd repo && gh pr merge 9', 'git fetch; git merge --no-ff origin/develop', 'true || gh pr merge 1', 'ls | gh pr merge 4',
  'hivecontrol workspace merge-into-source', 'hivecontrol workspace merge-from-source --force', 'gh   pr   merge   7', '\tgh pr merge 8', 'gh pr merge 5 # done', 'GH_TOKEN=x gh pr merge 1 -R a/b',
  // carriers of the merge text: heredoc, redirect, tee, sed -i, python -c (Node splits on newlines and separators, quotes are not honoured)
  'cat <<EOF\ngh pr merge 1\nEOF', "cat > run.sh <<'EOF'\ngh pr merge 1\nEOF", 'echo "gh pr merge 1" > /tmp/x.sh', "echo 'gh pr merge 1' | tee /tmp/x.sh", 'printf "git merge --no-ff main\\n" >> deploy.sh',
  "sed -i 's/a/gh pr merge 1/' run.sh", "python3 -c 'import os; os.system(\"gh pr merge 1\")'", 'python -c "open(\'m.sh\',\'w\').write(\'gh pr merge 2\')"', 'bash -c "gh pr merge 3"', 'sh -c \'git merge --no-ff main\'', 'eval "gh pr merge 3"',
  'git commit -m "gh pr merge 5"', 'echo gh pr merge 5', 'grep "gh pr merge" notes.md', 'xargs -I{} gh pr merge {} < ids.txt', '$(echo gh) pr merge 1', 'g\\h pr merge 1', 'gh pr "merge" 1', "gh pr 'merge' 1",
  'gh pr merge 4', 'gh pr merge 5 git status', 'git merge --no-ff main', 'GH pr merge 1', 'gh PR merge 1',
  // not auto-merges
  'git merge feature', 'git merge --no-ff feature', 'git merge --no-commit main', 'git merge --abort', 'gh pr view 3', 'gh pr review 3 --comment', 'gh pr create', 'gh pr list', 'git status', 'ls', 'echo hi',
  'hivecontrol workspace status', 'hivecontrol workspace merge', 'gh', 'gh pr', 'git merge', 'merge', '', '   ', 'git push origin main', 'gh api repos/a/b/merges',
];

// ---- (1) commands x transcripts ------------------------------------------------------------------------------
const keys = Object.keys(T);
for (const k of keys) {
  for (const c of [...MERGES.slice(0, 6), pick(MERGES), pick(MERGES), 'git status']) add(pl(c, tp(k)), ON, `cross-${k}-${c.slice(0, 20)}`);
}
for (const c of MERGES) for (const k of ['clean', 'hedge0', 'hedgeThenResolved', 'hedgeInQuotes', 'empty', 'garbage', 'hedgeSurrogate']) add(pl(c, tp(k)), ON, `cmd-${k}-${c.slice(0, 30)}`);

// ---- transcript path shapes ----------------------------------------------------------------------------------
for (const [id, p] of [['missing', undefined], ['null', null], ['empty', ''], ['num', 5], ['obj', {}], ['arr', [tp('hedge0')]], ['nonexistent', `${HOME}/t/nope.jsonl`], ['dir', `${HOME}/t/dir.jsonl`], ['relative', 't/hedge0.jsonl'], ['dotdot', `${HOME}/t/../t/hedge0.jsonl`],
  ['tilde', '~/t/hedge0.jsonl'], ['file-url', `file://${HOME}/t/hedge0.jsonl`], ['nul', `${HOME}/t/hedge0.jsonl\u0000x`], ['trailing-slash', `${HOME}/t/hedge0.jsonl/`], ['space', ` ${HOME}/t/hedge0.jsonl`], ['unicode', `${HOME}/t/é.jsonl`]]) {
  add(pl('gh pr merge 1', p), ON, `tp-${id}`);
}

// ---- (2) switch sources ---------------------------------------------------------------------------------------
const probe = [pl('gh pr merge 1', tp('hedge0')), pl('gh pr merge 1', tp('clean')), pl('git status', tp('hedge0'))];
const base = { env: { ANTIHALL_INGEST_DRY_RUN: '1' }, files };
const ctxs = {
  off: { ...base }, offExplicit: { ...base, settings: { guards: { mergeGate: false } } }, envOn: { env: { ...base.env, ANTIHALL_MERGE_GATE: '1' }, files }, envOnWord: { env: { ...base.env, ANTIHALL_MERGE_GATE: ' On ' }, files },
  envOff: { env: { ...base.env, ANTIHALL_MERGE_GATE: '0' }, settings: { guards: { mergeGate: true } }, files }, envOffWord: { env: { ...base.env, ANTIHALL_MERGE_GATE: 'off' }, settings: { guards: { mergeGate: true } }, files },
  envJunk: { env: { ...base.env, ANTIHALL_MERGE_GATE: 'zz' }, settings: { guards: { mergeGate: true } }, files }, strOn: { ...base, settings: { guards: { mergeGate: 'yes' } } }, numOn: { ...base, settings: { guards: { mergeGate: 1 } } },
  numTwo: { ...base, settings: { guards: { mergeGate: 2 } } }, objOn: { ...base, settings: { guards: { mergeGate: {} } } },
  optOn: { env: { ...base.env, CLAUDE_PLUGIN_OPTION_GUARDS_MERGE_GATE: 'true' }, files }, optDefault: { env: { ...base.env, CLAUDE_PLUGIN_OPTION_GUARDS_MERGE_GATE: 'false' }, settings: {}, files },
  optStored: { ...base, claude: { pluginConfigs: { 'anti-hall': { options: { guards_merge_gate: true } } } } }, optStoredFlat: { ...base, claude: { pluginConfigs: { 'anti-hall@anti-hall': { guards_merge_gate: 'true' } } } },
  optStoredDefault: { ...base, claude: { pluginConfigs: { 'anti-hall': { options: { guards_merge_gate: false } } } }, settings: { guards: { mergeGate: true } } },
  skip: { ...ON, skip: { 'merge-gate': Date.now() + 3600e3 } }, skipAll: { ...ON, skip: { all: Date.now() + 3600e3 } }, skipExpired: { ...ON, skip: { all: Date.now() - 1e3 } }, skipOther: { ...ON, skip: { 'git-guard': Date.now() + 3600e3 } },
  badSettings: { ...base, settings: '{x' }, badSkip: { ...ON, skip: '{x' },
};
for (const [k, c] of Object.entries(ctxs)) for (const [i, p] of probe.entries()) add(p, c, `ctx-${k}-${i}`);

// ---- (3) payload shape fuzz -----------------------------------------------------------------------------------
const shapes = {
  'no-tool-input': { hook_event_name: 'PreToolUse', tool_name: 'Bash', transcript_path: tp('hedge0') },
  'null-input': pl(null, tp('hedge0'), { tool_input: null }), 'str-input': pl(null, tp('hedge0'), { tool_input: 'gh pr merge 1' }), 'arr-input': pl(null, tp('hedge0'), { tool_input: ['gh pr merge 1'] }),
  'num-cmd': pl(5, tp('hedge0')), 'obj-cmd': pl({ a: 1 }, tp('hedge0')), 'arr-cmd': pl(['gh pr merge 1'], tp('hedge0')), 'null-cmd': pl(null, tp('hedge0')), 'bool-cmd': pl(true, tp('hedge0')),
  'other-tool': pl('gh pr merge 1', tp('hedge0'), { tool_name: 'Write' }), 'no-tool': pl('gh pr merge 1', tp('hedge0'), { tool_name: undefined }),
  'extra-fields': pl('gh pr merge 1', tp('hedge0'), { agent_id: 'a', turn_id: 't', model: 'm' }), 'huge-cmd': pl('gh pr merge 1 ' + 'x'.repeat(500000), tp('hedge0')), 'unicode-cmd': pl('gh pr merge 1 😀 é', tp('hedge0')),
  'cmd-newline': pl('\n\ngh pr merge 1\n\n', tp('hedge0')), 'cmd-crlf': pl('echo a\r\ngh pr merge 1\r\n', tp('clean')), 'cmd-nul': pl('gh pr merge 1\u0000', tp('hedge0')),
};
for (const [id, p] of Object.entries(shapes)) add(p, ON, `shape-${id}`);

// ---- (4) real commands -----------------------------------------------------------------------------------------
const want = +arg('--real', 1200);
let real = [];
try { real = readCmds(arg('--cmds', '../../../port-b13.real-cmds.jsonl')); } catch { /* optional */ }
const mergeish = real.filter(c => /merge|approve/.test(c.cmd));
for (let i = 0; i < Math.min(want, real.length * 2); i++) {
  const c = i % 5 === 0 && mergeish.length ? pick(mergeish) : pick(real);
  add(pl(c.cmd, tp(pick(['clean', 'hedge0', 'hedgeThenResolved', 'garbage', 'empty', 'hedgeInQuotes']))), ON, `real-${i}`);
}
console.error(`scenarios=${scenarios.length} real=${real.length}`);
runParity({ name: 'merge-gate', check: 'merge-gate', hookFile: 'merge-gate.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), events: ['PreToolUse'], tools: ['*'] });
