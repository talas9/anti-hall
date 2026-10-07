#!/usr/bin/env node
// Parity of the built-in `edit-guard` check against hooks/edit-guard.js (PreToolUse on Write, Edit, MultiEdit,
// NotebookEdit and, for Codex, apply_patch). The Node hook is a script with no evaluate(), so each Node answer is a real
// `node edit-guard.js` process with an isolated HOME and an explicit environment.
//   node run-edit-guard.js --engine ../target/debug/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--edits real-edits.jsonl] [--mode oneshot|daemon|both] [--real 600] [--seed 1]
// The engine must never be weaker than Node (D74): wherever Node blocks the engine may only defer or print the same
// block, and wherever it answers it must print exactly what Node printed. Corpus: (1) every path spelling that does or
// does not reach ~/.anti-hall/bin (literal, relative to the cwd, `..` traversal, repeated and trailing slashes, case and
// backslash variants, symlinked directories and files, a symlinked launcher directory, a missing leaf), for each edit
// tool, with and without agent markers, for each entry point; (2) entry points and subagent markers (Claude and Codex
// shapes); (3) switches (safety.editGuard, skip); (4) payload shape fuzz; (5) real edit targets.
const { arg, runParity, rng } = require('./guardlib.js');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const add = (payload, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps: [{ payload }] });
const HOME = '$HOME';
const pl = (tool, input, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: tool, session_id: 'sess-1', cwd: HOME, tool_input: input }, extra || {});
const edit = (file, extra, tool) => pl(tool || 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, extra);
const base = { env: { ANTIHALL_INGEST_DRY_RUN: '1' }, files: { '.anti-hall/bin/launcher.sh': '#!/bin/sh\n', '.anti-hall/bin/sub/inner.sh': 'x', '.anti-hall/other.txt': 'x', 'proj/a.txt': 'x', 'realbin/r.sh': 'x' }, links: { 'lnk': '$HOME/.anti-hall/bin', 'lnkfile': '$HOME/.anti-hall/bin/launcher.sh', 'lnkroot': '$HOME/.anti-hall', 'lnkproj': '$HOME/proj', 'lnkloop': '$HOME/lnkloop' } };
const ctx = (entry, o = {}) => Object.assign({}, base, o, { env: Object.assign({}, base.env, entry === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entry }, o.env || {}) });
const CE = new Map();
const cx = e => { const k = String(e); if (!CE.has(k)) CE.set(k, ctx(e)); return CE.get(k); };
const CTX = { cli: ctx('cli'), agent: ctx('agent_tool'), none: ctx(undefined), sdk: ctx('sdk-ts'), vscode: ctx('vscode'), ide: ctx('terminal_ide_x') };

// ---- (1) path spellings ----------------------------------------------------------------------------------------------
const BIN = `${HOME}/.anti-hall/bin`;
const PATHS = [
  `${BIN}/x.sh`, `${BIN}/launcher.sh`, BIN, `${BIN}/`, `${BIN}//x.sh`, `${BIN}/sub/inner.sh`, `${BIN}/sub/new/deep.sh`, `${BIN}/../bin/x.sh`, `${BIN}/./x.sh`, `${HOME}/.anti-hall/bin/../other.txt`, `${HOME}/.anti-hall/other.txt`, `${HOME}/.anti-hall/binx/x.sh`, `${HOME}/.anti-hall/bin.sh`,
  `${HOME}/.anti-hall/BIN/x.sh`, `${HOME}/.Anti-Hall/bin/x.sh`, `${HOME}/.anti-hall\\bin\\x.sh`, `${HOME}/.anti-hall\\bin`, `${HOME}\\.anti-hall\\bin\\x.sh`, `${HOME}/.anti-hall/bin\\x.sh`, `${BIN} /x.sh`, ` ${BIN}/x.sh`, `${BIN}/x.sh `, `${BIN}/é.sh`, `${BIN}/x\u0000.sh`,
  `${HOME}//.anti-hall//bin//x.sh`, `${HOME}/./.anti-hall/./bin/x.sh`, `${HOME}/proj/../.anti-hall/bin/x.sh`, `${HOME}/proj/../../${HOME.length ? '' : ''}x`, `${HOME}/${'a/'.repeat(300)}../../x`,
  '.anti-hall/bin/x.sh', './.anti-hall/bin/x.sh', '.anti-hall/bin', '.anti-hall/bin/', '../.anti-hall/bin/x.sh', 'proj/../.anti-hall/bin/launcher.sh', '~/.anti-hall/bin/x.sh', '$HOME/.anti-hall/bin/x.sh', '${HOME}/.anti-hall/bin/x.sh', '~', '', 'x.sh', 'proj/a.txt', '.anti-hall/other.txt', '.anti-hall/bin.txt',
  'lnk/x.sh', 'lnk/launcher.sh', 'lnk', 'lnk/', 'lnk/sub/inner.sh', 'lnk/sub/new.sh', 'lnkfile', `${HOME}/lnk/launcher.sh`, `${HOME}/lnkfile`, 'lnkroot/bin/launcher.sh', 'lnkroot/bin/x.sh', 'lnkroot/other.txt', 'lnkproj/a.txt', 'lnkproj/../.anti-hall/bin/launcher.sh', 'lnkloop', 'lnkloop/x', 'proj/lnk/launcher.sh',
  '/etc/passwd', '/', '/tmp/x', '/nonexistent/.anti-hall/bin/x.sh', `${HOME}/realbin/r.sh`, `${HOME}/.anti-hall/bin/launcher.sh/extra`,
];
const TOOLS = [['Edit', 'file_path'], ['Write', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']];
for (const [ek, c] of Object.entries(CTX)) {
  for (const f of PATHS) {
    for (const [t, field] of TOOLS) { if (ek !== 'cli' && ek !== 'agent' && t !== 'Edit') continue; add(pl(t, { [field]: f }), c, `path-${ek}-${t}-${f.replace(/[^A-Za-z0-9]/g, '_').slice(0, 40)}`); }
  }
}
// the field the tool does not read
for (const f of [BIN + '/x.sh', 'proj/a.txt']) { add(pl('NotebookEdit', { file_path: f }), CTX.cli, `wrongfield-nb-${f.slice(-8)}`); add(pl('Edit', { notebook_path: f }), CTX.cli, `wrongfield-edit-${f.slice(-8)}`); }
// the cwd varies, the path is relative
for (const cwd of [HOME, `${HOME}/`, `${HOME}/proj`, `${HOME}/.anti-hall`, `${HOME}/.anti-hall/bin`, `${HOME}/.anti-hall/bin/sub`, `${HOME}/lnk`, `${HOME}/lnkproj`, '/', '/tmp', 'rel', '', 5, null, undefined, ['x'], `${HOME}/proj/..`, `${HOME}/nonexistent`]) {
  for (const f of ['x.sh', 'bin/x.sh', 'launcher.sh', '../bin/launcher.sh', '../../.anti-hall/bin/x.sh', 'sub/inner.sh', '.']) for (const ek of ['cli', 'agent']) add(pl('Edit', { file_path: f }, { cwd }), CTX[ek], `cwd-${ek}-${String(JSON.stringify(cwd)).replace(/[^A-Za-z0-9]/g, '_').slice(0, 24)}-${f}`);
}
// a launcher directory that is itself a symlink, and one that does not exist
const SYM = { env: base.env, files: { 'realbin/r.sh': 'x', 'other/o.txt': 'x', 'realroot/bin/r.sh': 'x', 'realroot/other.txt': 'x' }, links: { '.anti-hall': '$HOME/realroot' } };
const NOBIN = { env: base.env, files: { 'proj/a.txt': 'x' } };
const BINLINK = { env: base.env, files: { 'realbin/r.sh': 'x', '.anti-hall/other.txt': 'x' }, links: { '.anti-hall/bin': '$HOME/realbin' } };
const BINFILE = { env: base.env, files: { '.anti-hall/bin': 'a file named bin' } };
const mkc = (c, entry) => Object.assign({}, c, { env: Object.assign({}, c.env, { CLAUDE_CODE_ENTRYPOINT: entry }) });
for (const [name, c] of Object.entries({ nobin: NOBIN, binlink: BINLINK, binfile: BINFILE, rootlink: SYM })) {
  for (const entry of ['cli', 'agent_tool']) {
    const cc = mkc(c, entry);
    for (const f of [`${BIN}/x.sh`, `${BIN}/r.sh`, `${HOME}/realbin/r.sh`, `${HOME}/realbin/new.sh`, `${HOME}/.anti-hall/other.txt`, BIN, `${HOME}/realroot/bin/x.sh`, 'realbin/r.sh', '.anti-hall/bin/r.sh']) add(edit(f), cc, `bindir-${name}-${entry}-${f.replace(/[^A-Za-z0-9]/g, '_').slice(-30)}`);
  }
}

// ---- (2) entry points and subagent markers ---------------------------------------------------------------------------
const FILES = [`${BIN}/x.sh`, 'proj/a.txt', '.anti-hall/other.txt', 'src/main.rs'];
const ENTRIES = ['cli', 'agent_tool', 'vscode', 'jetbrains', 'vim', 'emacs', 'terminal_ide_x', 'terminal_ide_', 'terminal_ide', 'sdk-ts', 'sdk-py', 'remote', 'CLI', ' cli', 'cli ', 'agent_tool ', '', undefined, 'mcp', 'github-action'];
const MARKERS = [{}, { agent_id: 'a1' }, { agent_type: 'general' }, { agent_id: '' }, { agent_id: null }, { agent_id: 0 }, { agent_id: false }, { agent_type: '' }, { agent_id: 'a', agent_type: 'b' }, { agent_id: [] }, { agent_id: {} }, { agent_id: 1 },
  { turn_id: 't1', model: 'm' }, { turn_id: 't1', model: 'm', agent_id: 'a' }, { turn_id: 't1', model: 'm', agent_id: '' }, { turn_id: 't1', model: 'm', agent_id: null }, { turn_id: 't1', model: '' }, { turn_id: '', model: 'm' }, { turn_id: 5, model: 'm' }, { turn_id: 't', model: 'm', agent_type: 0 }];
for (const e of ENTRIES) for (const m of MARKERS) for (const f of FILES.slice(0, 2)) add(edit(f, m), cx(e), `entry-${String(e).replace(/[^A-Za-z0-9]/g, '_')}-${JSON.stringify(m).replace(/[^A-Za-z0-9]/g, '_').slice(0, 30)}-${f.slice(-6)}`);
// Codex-shaped payloads for the Claude tool names and for apply_patch
for (const e of [undefined, 'cli', 'agent_tool']) for (const m of [{ turn_id: 't', model: 'm' }, { turn_id: 't', model: 'm', agent_id: 'a' }]) {
  for (const [t, inp] of [['apply_patch', { command: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch' }], ['apply_patch', { command: `*** Begin Patch\n*** Add File: ${BIN}/x.sh\n+x\n*** End Patch` }], ['apply_patch', { command: 'junk' }], ['apply_patch', {}], ['Edit', { file_path: 'proj/a.txt' }], ['Write', { file_path: `${BIN}/x.sh` }]]) add(pl(t, inp, m), cx(e), `codex-${e}-${t}-${JSON.stringify(inp).length}-${Object.keys(m).length}`);
}
for (const e of [undefined, 'cli']) for (const [i, c] of ['*** Begin Patch\n*** Update File: proj/a.txt\n@@\n-a\n+b\n*** End Patch', `*** Begin Patch\n*** Add File: ../.anti-hall/bin/y.sh\n+x\n*** End Patch`, `*** Begin Patch\n*** Update File: a\n*** Move to: ${BIN}/z\n@@\n+x\n*** End Patch`, '*** Begin Patch\n*** End Patch', '', 'not a patch'].entries()) add(pl('apply_patch', { command: c }), cx(e), `patch-${e}-${i}`);

// ---- (3) switches --------------------------------------------------------------------------------------------------------
const probe = [edit(BIN + '/x.sh'), edit('proj/a.txt'), edit(BIN + '/x.sh', { agent_id: 'a' }), edit('proj/a.txt', { agent_id: 'a' })];
const S = (o) => ctx('cli', o);
const sw = {
  def: S(), off: S({ settings: { safety: { editGuard: false } } }), offWord: S({ settings: { safety: { editGuard: 'off' } } }), offNum: S({ settings: { safety: { editGuard: 0 } } }), onExplicit: S({ settings: { safety: { editGuard: true } } }), junk: S({ settings: { safety: { editGuard: 'maybe' } } }),
  envOff: S({ env: { ANTIHALL_EDIT_GUARD: 'off' } }), envOff0: S({ env: { ANTIHALL_EDIT_GUARD: '0' } }), envOn: S({ env: { ANTIHALL_EDIT_GUARD: '1' }, settings: { safety: { editGuard: false } } }), envJunk: S({ env: { ANTIHALL_EDIT_GUARD: 'zz' }, settings: { safety: { editGuard: false } } }),
  optOff: S({ env: { CLAUDE_PLUGIN_OPTION_SAFETY_EDIT_GUARD: 'false' } }), optStored: S({ claude: { pluginConfigs: { 'anti-hall': { options: { safety_edit_guard: false } } } } }), optStoredFlat: S({ claude: { pluginConfigs: { 'anti-hall@anti-hall': { safety_edit_guard: 'false' } } } }),
  optDefault: S({ env: { CLAUDE_PLUGIN_OPTION_SAFETY_EDIT_GUARD: 'true' }, settings: { safety: { editGuard: false } } }),
  skip: S({ skip: { 'edit-guard': Date.now() + 3600e3 } }), skipAll: S({ skip: { all: Date.now() + 3600e3 } }), skipExpired: S({ skip: { all: Date.now() - 1e3 } }), skipOther: S({ skip: { 'git-guard': Date.now() + 3600e3 } }), badSettings: S({ settings: '{x' }), badSkip: S({ skip: '{x' }),
  // HOME handling: empty, relative, unset
  homeEmpty: S({ env: { HOME: '' } }), homeRel: S({ env: { HOME: 'rel/home' } }), homeUnset: S({ env: { HOME: undefined } }), homeTrailing: S({ env: { HOME: '__HOME__/' } }), homeDots: S({ env: { HOME: '__HOME__/./proj/..' } }),
};
for (const [k, c] of Object.entries(sw)) for (const [i, p] of probe.entries()) add(p, c, `sw-${k}-${i}`);

// ---- (4) payload shape fuzz ------------------------------------------------------------------------------------------------
const shapes = {
  'no-tool-input': { hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: HOME }, 'null-input': pl('Edit', null), 'str-input': pl('Edit', 'x'), 'arr-input': pl('Edit', [1]), 'num-input': pl('Edit', 5), 'true-input': pl('Edit', true),
  'path-num': pl('Edit', { file_path: 5 }), 'path-arr': pl('Edit', { file_path: [BIN + '/x.sh'] }), 'path-obj': pl('Edit', { file_path: {} }), 'path-true': pl('Edit', { file_path: true }), 'path-null': pl('Edit', { file_path: null }), 'path-zero': pl('Edit', { file_path: 0 }), 'path-empty': pl('Edit', { file_path: '' }),
  'path-huge': pl('Edit', { file_path: BIN + '/' + 'x'.repeat(100000) }), 'path-unicode': pl('Edit', { file_path: `${BIN}/😀/é.sh` }), 'path-newline': pl('Edit', { file_path: `${BIN}/a\nb` }),
  'cwd-obj': pl('Edit', { file_path: 'x' }, { cwd: {} }), 'cwd-num': pl('Edit', { file_path: 'x.sh' }, { cwd: 5 }), 'cwd-true': pl('Edit', { file_path: 'x.sh' }, { cwd: true }),
  'tool-missing': { hook_event_name: 'PreToolUse', cwd: HOME, tool_input: { file_path: BIN + '/x.sh' } }, 'tool-num': pl(5, { file_path: BIN + '/x.sh' }), 'tool-lower': pl('edit', { file_path: BIN + '/x.sh' }), 'tool-space': pl('Edit ', { file_path: BIN + '/x.sh' }), 'tool-bash': pl('Bash', { command: 'echo x > ' + BIN + '/x.sh' }),
  'tool-read': pl('Read', { file_path: BIN + '/x.sh' }), 'tool-notebook-nopath': pl('NotebookEdit', {}), 'tool-multi-edits': pl('MultiEdit', { file_path: 'a', edits: [{ file_path: BIN + '/x.sh' }] }),
  'extra-fields': pl('Edit', { file_path: BIN + '/x.sh' }, { permission_mode: 'plan', transcript_path: '/x', agent_id: undefined }),
};
for (const [id, p] of Object.entries(shapes)) for (const ek of ['cli', 'agent']) add(p, CTX[ek], `shape-${ek}-${id}`);

// ---- (5) real edit targets --------------------------------------------------------------------------------------------------
const want = +arg('--real', 600);
let edits = [];
try { edits = fs.readFileSync(arg('--edits', '../../../port-b13.real-edits.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* optional */ }
for (let i = 0; i < Math.min(want, edits.length * 2); i++) {
  const e = pick(edits);
  const tool = pick(['Edit', 'Write', 'MultiEdit']);
  add(pl(tool, { file_path: e.file }, pick([{}, {}, { agent_id: 'a' }])), pick([CTX.cli, CTX.agent, CTX.none, CTX.vscode]), `real-${i}`);
}
console.error(`scenarios=${scenarios.length} edits=${edits.length}`);

// ---- the Node side: a real hook process ------------------------------------------------------------------------------------
function nodeFn(payload, env, hooks) {
  const clean = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = String(v).replace('__HOME__', env.HOME || '');
  const r = cp.spawnSync(process.execPath, ['--no-concurrent-recompilation', '--no-concurrent-sparkplug', path.join(hooks, 'edit-guard.js')], { input: JSON.stringify(payload), env: clean, cwd: '/tmp', encoding: 'utf8', timeout: 30000 });
  return { exitCode: r.status === 2 ? 2 : 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}
runParity({ name: 'edit-guard', check: 'edit-guard', nodeFn, scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), events: ['PreToolUse'], tools: ['*'] });
