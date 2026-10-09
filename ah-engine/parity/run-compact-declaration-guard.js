#!/usr/bin/env node
// Parity of the built-in `compact-declaration-guard` check against hooks/compact-declaration-guard.js (PreToolUse).
//   node run-compact-declaration-guard.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--edits fpr/edits.jsonl] [--mode oneshot|daemon|both] [--real 6000] [--win 700] [--seed 1]
// The engine may answer only allow, or defer (a possible declaration, or something it cannot judge exactly); Node may
// answer allow or block. So: whenever the engine answers, Node must have allowed (MISMATCH otherwise), and every call
// Node blocks must come back deferred. Two groups are strict about deferral too: `cls-*` (a transcript with an active
// declaration, so Node blocks exactly the calls it counts as new work) must defer the same calls, and `ncls-*` nothing
// else; a deferral where Node allowed there is a work-classification divergence and counts as a MISMATCH.
// Corpus: (1) hand-written transcripts (Claude and Codex shapes, resets, retractions, escapes, lone surrogates, damaged
// lines, a transcript larger than the tail, empty, missing, a directory, a relative path), (2) windows cut from real
// Claude transcripts and Codex rollouts with and without an injected declaration, (3) real Bash commands and real file
// paths judged against a transcript that holds an active declaration, (4) handover-path and cwd variants, (5) fuzz.
const fs = require('fs'), path = require('path');
const { arg, runParity, readCmds, rng } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const files = {};
const TH = '$HOME/t';
let nf = 0;
const put = (lines, name, eol) => { const f = `t/${name || 'f' + nf++}.jsonl`; files[f] = lines.join(eol === undefined ? '\n' : eol); return `$HOME/${f}`; };
const base = (tool, input, tp, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: tool, session_id: 's', cwd: '$HOME/proj', transcript_path: tp, tool_input: input }, extra || {});
const add = (payload, ctx, id) => scenarios.push({ id, ctx, steps: [{ payload }] });
const J = o => JSON.stringify(o);
const user = t => J({ type: 'user', message: { role: 'user', content: t } });
const userBlocks = t => J({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
const asst = t => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const asstStr = t => J({ type: 'assistant', message: { role: 'assistant', content: t } });
const tool = () => J({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
const toolRes = () => J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const notify = () => user('<task-notification>agent done</task-notification>');
const cx = {
  user: t => J({ type: 'event_msg', payload: { type: 'user_message', message: t } }), asst: t => J({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] } }),
  call: () => J({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }), compacted: () => J({ type: 'compacted', payload: {} }),
};
const SAFE = '✅ SAFE TO COMPACT';
const WORK = [['Bash', { command: 'git commit -am x' }], ['Bash', { command: 'git push origin dev' }], ['Bash', { command: 'ls' }], ['Agent', { prompt: 'x' }], ['Task', {}], ['Write', { file_path: 'a.js' }], ['Edit', { file_path: 'a.js' }], ['MultiEdit', { file_path: 'a.js' }], ['NotebookEdit', { notebook_path: 'a.ipynb' }], ['Read', { file_path: 'a.js' }], ['Grep', {}], ['Bash', {}]];

// ---- (1) hand-written transcripts ---------------------------------------------------------------------------
const T = {
  declared: [user('go'), asst('done'), asst(SAFE)], declStr: [user('go'), asstStr('SAFE TO COMPACT')], declThenUser: [user('go'), asst(SAFE), user('next')], declThenUserBlocks: [asst(SAFE), userBlocks('next')],
  declThenNotify: [user('go'), asst(SAFE), notify()], declThenToolRes: [user('go'), asst(SAFE), tool(), toolRes()], declThenTool: [user('go'), asst(SAFE), tool()], declThenText: [user('go'), asst(SAFE), asst('more text')],
  notSafe: [user('go'), asst('NOT SAFE TO COMPACT')], retracted: [user('go'), asst(SAFE), asst('RETRACT SAFE TO COMPACT: not yet')], quoted: [user('go'), asst('the guard blocks "SAFE TO COMPACT" phrases')], question: [user('go'), asst('Is it safe to compact now?')],
  lower: [user('go'), asst('It is safe to compact now.')], lowerMid: [user('go'), asst('we are safe to compact later')], safeFor: [user('go'), asst('safe for a context reset')], good: [user('go'), asst('GOOD POINT TO /compact NOW')],
  safeOnly: [user('go'), asst('this is safe code')], safeWord: [user('go'), asst('SAFE')], SAFE_CAPS: [user('go'), asst('SaFe tO cOmPaCt')],
  noTurnReset: [asst(SAFE), user('<system-reminder>x</system-reminder>real prompt')], remindersOnly: [asst(SAFE), user('<system-reminder>x</system-reminder>')], twoReminders: [asst(SAFE), user('<system-reminder>a</system-reminder> <system-reminder>b</system-reminder>go')],
  unclosedReminder: [asst(SAFE), user('<system-reminder>never closed go')], localCmd: [asst(SAFE), user('<local-command-stdout>x</local-command-stdout>')], compactCmd: [asst(SAFE), user('<command-name>/compact</command-name>')],
  bashOut: [asst(SAFE), user('<bash-stdout>x</bash-stdout>')], meta: [asst(SAFE), J({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta prompt' } })], summary: [asst(SAFE), J({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } })],
  sidechain: [user('go'), J({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: SAFE }] } })], sidechainUser: [asst(SAFE), J({ type: 'user', isSidechain: true, message: { role: 'user', content: 'x' } })],
  boundary: [asst(SAFE), J({ type: 'system', subtype: 'compact_boundary', compactMetadata: {} })], emptyUser: [asst(SAFE), user('   ')], userNoMsg: [asst(SAFE), J({ type: 'user' })], assistantNoMsg: [user('go'), J({ type: 'assistant' })],
  userStrMsg: [asst(SAFE), J({ type: 'user', message: 'plain string' })], userNumMsg: [asst(SAFE), J({ type: 'user', message: 5 })], blocksNoText: [user('go'), J({ type: 'assistant', message: { content: [{ type: 'text' }, { type: 'text', text: 5 }, null, { type: 'text', text: '  ' }, { type: 'text', text: SAFE }] } })],
  codexDecl: [cx.user('go'), cx.asst(SAFE)], codexReset: [cx.asst(SAFE), cx.user('next')], codexCall: [cx.user('go'), cx.asst(SAFE), cx.call()], codexCompacted: [cx.asst(SAFE), cx.compacted()], codexNotTyped: [cx.asst(SAFE), cx.user('<task-notification>x')],
  codexNumMsg: [cx.asst(SAFE), J({ type: 'event_msg', payload: { type: 'user_message', message: 5 } })], codexNoPayload: [cx.asst(SAFE), J({ type: 'event_msg' })], codexArrPayload: [J({ type: 'response_item', payload: [1] })],
  escaped: ['{"type":"assistant","message":{"content":[{"type":"text","text":"s\\u0061fe to compact"}]}}'], escapedSafe: [user('go'), '{"type":"assistant","message":{"content":[{"type":"text","text":"\\u2705 \\u0053AFE TO COMPACT"}]}}'],
  loneSurrogate: [user('go'), '{"type":"assistant","message":{"content":[{"type":"text","text":"x \\ud83d y SAFE TO COMPACT"}]}}'], loneSurrogateNoSafe: [user('go'), '{"type":"assistant","message":{"content":[{"type":"text","text":"x \\ud83d y"}]}}'],
  unicodeEsc: [user('go'), '{"type":"assistant","message":{"content":[{"type":"text","text":"caf\\u00e9"}]}}'], badJson: [user('go'), '{not json', asst(SAFE)], badJsonSafe: ['{"type":"assistant", SAFE TO COMPACT', asst('x')], truncatedLast: [user('go'), asst(SAFE), '{"type":"assistant","message":{"content":[{"type":"te'],
  truncatedLastSafe: [user('go'), '{"type":"assistant","message":{"content":[{"type":"text","text":"SAFE TO COM'], exponent: [user('go'), '{"type":"user","message":{"content":"x"},"n":1e999}', asst(SAFE)], deep: [user('go'), '['.repeat(300) + ']'.repeat(300), asst(SAFE)],
  blanks: ['', '', user('go'), '', asst(SAFE), ''], scalar: ['5', '"str"', 'null', 'true', '[1]', user('go'), asst(SAFE)], bom: ['﻿' + user('go'), asst(SAFE)], noTrailingNl: [user('go'), asst(SAFE)],
  asstText2: [user('go'), asst('line one'), asst('SAFE TO COMPACT'), tool(), asst('after tool')], multiline: [user('go'), asst('intro\n\n✅ SAFE TO COMPACT NOW\n')], table: [user('go'), asst('| a | SAFE TO COMPACT |')],
  nonAscii: [user('go'), asst('éè SAFE \u{1F600} TO COMPACT')], longline: [user('go'), asst('x'.repeat(200000) + ' SAFE TO COMPACT')], safeInToolResult: [user('go'), J({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SAFE TO COMPACT' }] } })],
  safeInUser: [user('please say SAFE TO COMPACT')], safeInThinking: [user('go'), J({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'SAFE TO COMPACT' }] } })],
};
const tps = {};
for (const [k, lines] of Object.entries(T)) tps[k] = put(lines, k, k === 'noTrailingNl' ? '\n' : undefined);
tps.crlf = put([user('go'), asst(SAFE)], 'crlf', '\r\n'); tps.empty = put([], 'empty'); tps.ws = put(['  ', '\n'], 'ws'); files['t/dir/x'] = 'x'; tps.dir = '$HOME/t/dir'; tps.missing = '$HOME/t/missing.jsonl';
// larger than the tail: a declaration near the start is out of reach, one near the end is not
const filler = Array.from({ length: 4000 }, (_, i) => asst('filler ' + i + ' ' + 'x'.repeat(400)));
tps.bigStart = put([user('go'), asst(SAFE), ...filler, tool()], 'bigStart'); tps.bigEnd = put([user('go'), ...filler, asst(SAFE)], 'bigEnd'); tps.bigMid = put([...filler.slice(0, 2000), asst(SAFE), ...filler.slice(2000), user('x')], 'bigMid');
tps.bigPartial = put([...filler, asst(SAFE)].map((l, i) => (i === 1500 ? l.replace('filler', 'SAFE TO COMPACT filler') : l)), 'bigPartial'); tps.bigNoNl = put([...filler, asst('SAFE TO COMPACT')], 'bigNoNl');
tps.relative = 't/declared.jsonl'; tps.emptyPath = ''; tps.numPath = 5; tps.none = undefined; tps.tilde = '~/t/declared.jsonl';
const HD = {};
for (const [tk, tp] of Object.entries(tps)) for (const [tl, input] of WORK) add(base(tl, input, tp), undefined, `hand-${tk}-${tl}-${JSON.stringify(input).slice(0, 25)}`);

// payload shapes against a declared transcript
const D = tps.declared;
for (const [id, p] of [
  ['subagent-id', base('Agent', {}, D, { agent_id: 'a1' })], ['subagent-type', base('Write', { file_path: 'a' }, D, { agent_type: 't' })], ['subagent-null', base('Write', { file_path: 'a' }, D, { agent_id: null })], ['subagent-empty', base('Write', { file_path: 'a' }, D, { agent_id: '' })],
  ['not-object', [1]], ['null', null], ['no-tool', { hook_event_name: 'PreToolUse', transcript_path: D, tool_input: { command: 'rm x' } }], ['num-tool', base(5, { command: 'rm x' }, D)], ['no-input', base('Write', undefined, D)], ['null-input', base('Write', null, D)],
  ['str-input', base('Write', 'x', D)], ['cmd-on-edit', base('Edit', { command: 'rm x', file_path: 'a' }, D)], ['cmd-on-other', base('Grep', { command: 'rm x' }, D)], ['cmd-num', base('Bash', { command: 5 }, D)],
  ['notebook-only', base('NotebookEdit', { notebook_path: '$HOME/.anti-hall/handovers/x.md' }, D)], ['both-paths', base('Write', { file_path: 'a.js', notebook_path: '$HOME/.anti-hall/handovers/x' }, D)], ['num-path', base('Write', { file_path: 5 }, D)],
]) add(p, undefined, `shape-${id}`);
// handover edits are exempt, resolved against the working directory
for (const tl of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) for (const [cwd, fp] of [
  ['$HOME/proj', '$HOME/proj/.anti-hall/handovers/h.md'], ['$HOME/proj', '.anti-hall/handovers/h.md'], ['$HOME/proj', './.anti-hall/handovers/h.md'], ['$HOME/proj', '.anti-hall/handovers/2026/x/h.md'], ['$HOME/proj', '.anti-hall/handovers/'],
  ['$HOME/proj', '.anti-hall/handovers'], ['$HOME/proj', '.anti-hall/handovers-x/h.md'], ['$HOME/proj', '.anti-hall/handovers/../h.md'], ['$HOME/proj/.anti-hall', 'handovers/h.md'], ['$HOME/proj', '../.anti-hall/handovers/h.md'], ['$HOME/proj', '$HOME/.anti-hall/handovers/h.md'],
  ['$HOME/proj', 'x/.anti-hall/handovers/h.md'], ['$HOME/proj', 'x.anti-hall/handovers/h.md'], ['$HOME/proj', '.anti-hall//handovers//h.md'], ['$HOME/proj', '.anti-hall/handovers/\nh.md'], ['/', '.anti-hall/handovers/h.md'], [undefined, '.anti-hall/handovers/h.md'], ['rel', '.anti-hall/handovers/h.md'],
  [undefined, '/abs/.anti-hall/handovers/h.md'], ['rel', '/abs/.anti-hall/handovers/h.md'], ['', '.anti-hall/handovers/h.md'], [5, '.anti-hall/handovers/h.md'], ['$HOME/proj', '.ANTI-HALL/handovers/h.md'], ['$HOME/proj', '.anti-hall/handovers/é.md'],
]) add(base(tl, tl === 'NotebookEdit' ? { notebook_path: fp } : { file_path: fp }, D, { cwd }), undefined, `handover-${tl}-${cwd}-${fp.slice(0, 40)}`);

// switches and skip
const ctxs = {
  off: { settings: { guards: { compactDeclarationGuard: false } } }, offStr: { settings: { guards: { compactDeclarationGuard: 'off' } } }, optOff: { env: { CLAUDE_PLUGIN_OPTION_GUARDS_COMPACT_DECLARATION_GUARD: 'false' } }, optStoredOff: { claude: { pluginConfigs: { 'anti-hall': { options: { guards_compact_declaration_guard: false } } } } },
  skip: { skip: { 'compact-declaration-guard': Date.now() + 3600e3 } }, skipAll: { skip: { all: Date.now() + 3600e3 } }, skipExpired: { skip: { all: Date.now() - 1e3 } },
};
const sctx = {};
for (const [k, c] of Object.entries(ctxs)) { sctx[k] = Object.assign({ files }, c); for (const [tl, input] of WORK.slice(0, 7)) add(base(tl, input, D), sctx[k], `ctx-${k}-${tl}`); }

// ---- (2) windows of real transcripts ---------------------------------------------------------------------------
const list = require('child_process').execSync(`find ${process.env.HOME}/.claude/projects ${process.env.HOME}/.codex/sessions -name '*.jsonl' -size +20k -size -6M 2>/dev/null | head -4000`, { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);
const DECLS = ['✅ SAFE TO COMPACT', 'safe to compact', 'Not safe to compact yet', 'It is "SAFE TO COMPACT" per the doc', 'Is it safe to compact?', 'RETRACT SAFE TO COMPACT: wait', 'SAFE TO /compact', 'safe for a context reset', 'all done.\n\nSAFE TO COMPACT NOW', 'this is safe', 'unsafe operation', 'HANDOVER COMPLETE — SAFE TO COMPACT'];
const NWIN = +arg('--win', 700);
let wins = 0;
const winPaths = [];
for (let attempts = 0; wins < NWIN && attempts < NWIN * 4 && list.length; attempts++) {
  const f = pick(list);
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  if (lines.length < 6) continue;
  const len = 4 + Math.floor(R() * 120), start = Math.floor(R() * Math.max(1, lines.length - len));
  let w = lines.slice(start, start + len).filter(l => l.length < 60000);
  const codex = f.includes('/.codex/');
  const r = R();
  if (r < 0.5) { const at = Math.floor(R() * (w.length + 1)); w.splice(at, 0, codex ? cx.asst(pick(DECLS)) : asst(pick(DECLS))); if (R() < 0.3) w.splice(Math.min(w.length, at + 1 + Math.floor(R() * 3)), 0, codex ? cx.user('next') : user('next')); }
  winPaths.push(put(w, `win${wins}`)); wins++;
}
for (const tp of winPaths) for (const [tl, input] of [['Bash', { command: 'git commit -am x' }], ['Write', { file_path: 'a.js' }], ['Agent', {}], ['Bash', { command: 'ls' }]]) add(base(tl, input, tp), undefined, `win-${path.basename(tp)}-${tl}`);

// ---- (3) real commands and paths against a transcript with an active declaration ----------------------------------
const cmds = readCmds(arg('--cmds', '../../fpr/cmds.jsonl'));
const want = +arg('--real', 6000);
for (let i = 0; i < want; i++) add(base('Bash', { command: pick(cmds).cmd }, D), undefined, `cls-cmd-${i}`);
const WORDS = ['git commit', 'git push', 'git tag', 'gh pr merge', 'gh pr create', 'rm', 'cp', 'mv', 'tee', 'mkdir', 'touch', 'make', 'chmod', 'sed -i', 'npm install', 'pip install', 'patch', 'git checkout', 'echo x >', 'echo x >>', 'cat 2>&1', 'cmd >&2', 'a 2> b', 'a &> b', 'a >| b', 'a >>& b', 'ls', 'git status', 'git log'];
const FZ = [' ', '\t', '\n', '\r', ' ', ' ', ';', '&&', '||', '|', '&', '(', ')', '`', '$(', '"', "'", '\\', '>', '>>', '>&', '2>', '1>&2', '&>', '<', '<<EOF\nx\nEOF', 'echo "rm x"', "echo 'git push'", 'x'];
for (let i = 0; i < 6000; i++) {
  let c = '';
  for (let k = 0, n = 1 + Math.floor(R() * 5); k < n; k++) c += pick([...WORDS, ...FZ]) + pick(['', ' ', '  ']);
  add(base('Bash', { command: c }, D), undefined, `cls-fuzz-${i}`);
}
const edits = [];
try { for (const l of fs.readFileSync(arg('--edits', '../../fpr/edits.jsonl'), 'utf8').split('\n')) if (l) { try { edits.push(JSON.parse(l)); } catch { /* skip */ } } } catch { /* optional */ }
for (let i = 0; i < 1500; i++) { const e = pick(edits.length ? edits : [{ tool: 'Write', file: 'a.js', cwd: null }]); add(base(e.tool, { file_path: e.file }, D, { cwd: e.cwd || '$HOME/proj' }), undefined, `cls-edit-${i}`); }
console.error(`scenarios=${scenarios.length} transcript-files=${Object.keys(files).length} windows=${wins}`);
// every scenario that names no ctx shares one, with the transcript files in its home
const MAIN = { files };
for (const sc of scenarios) if (!sc.ctx) sc.ctx = MAIN;
runParity({ name: 'compact-declaration-guard', check: 'compact-declaration-guard', hookFile: 'compact-declaration-guard.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), events: ['PreToolUse'], tools: ['*'], strictDeferPrefix: 'cls-' });
