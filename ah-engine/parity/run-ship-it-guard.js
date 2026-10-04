#!/usr/bin/env node
// Parity of the built-in `ship-it-guard` check against hooks/ship-it-guard.js (PreToolUse on Edit/Write/MultiEdit,
// Bash and apply_patch).
//   node run-ship-it-guard.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--edits fpr/edits.jsonl] [--mode oneshot|daemon|both] [--real 6000] [--seed 1]
// Corpus: (1) hand-written cases over many PLAN.md shapes, switch sources and payload shapes, (2) real file paths
// (Edit/Write targets from local transcripts and path-like tokens from real Bash commands) judged under several
// working directories, (3) real paths rewritten onto hard-risk directories, (4) fuzzed plans (white space, CRLF,
// Unicode separators, repeated headings). The gate is off by default, so most contexts turn it on.
const fs = require('fs');
const { arg, runParity, readCmds, rng } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const add = (payload, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps: [{ payload }] });
const pl = (tool, input, cwd, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: tool, session_id: 's', cwd, tool_input: input }, extra || {});
const edit = (file, cwd, tool) => pl(tool || 'Edit', { file_path: file }, cwd);

// ---- plans -------------------------------------------------------------------------------------------------
const REAL_PLAN = `# Plan\n\n## Blast radius\nthings\n\n## Phases\n\n### Phase 1: db\n- goal: migrate\n- files: src/db/a.js, \`lib/b.ts\`, ./docs/c.md\n- verify: tests\n\n### Phase 2: api\n- files:\n  - src/api/routes.js\n  - "src/api/auth/token.js" and more.\n- risk: low\n\n## Progress\n- [ ] phase 1 (see notes/x.txt)\n`;
const plans = {
  none: null,
  stub: '# Plan\n',
  empty: '',
  real: REAL_PLAN,
  nophases: '# Plan\n\nfiles: src/a.js\n',
  nofiles: '## Phases\n### Phase 1\n- goal: x\n',
  nophaseheading: '## Phases\n- files: src/a.js\n',
  lower: '## phases\n### p\n- FILES: src/a.js\n',
  crlf: '## Phases\r\n### Phase 1\r\n- files: src/a.js, lib/b.ts\r\n- verify: x\r\n',
  unicode: '## Phases ### Phase 1 - files: src/a.js ',
  tabs: '##\tPhases\n###\tPhase 1\n-\tfiles:\tsrc/a.js\n',
  dup: '## Phases\n### a\n- files: x/a.js\n## Phases\n### b\n- files: y/b.js\n',
  h4: '## Phases\n#### sub\n### a\n- files: src/a.js\n',
  glob: '## Phases\n### a\n- files: src/**/*.js, *.md, src/\n',
  prose: '## Phases\n### a\n- files: update the app and the docs, e.g. src/app.js. then done\n',
  bom: '﻿## Phases\n### a\n- files: src/a.js\n',
  nested: '## Phases\n### a\n- files: src/a.js\n  - src/b.js\n- other: z\n### b\n- files: c/d.py\n',
  twoSectionsEnd: '## Phases\n### a\n- files: src/a.js\n## Progress\n### x\n- files: never/seen.js\n',
  backslash: '## Phases\n### a\n- files: src\\win\\a.js\n',
  dotsemi: '## Phases\n### a\n- files: src/a.js; src/b.js: and ./lib/c.ts.\n',
  longext: '## Phases\n### a\n- files: readme.abcdefghijk, file.abcdefghij\n',
  invalidutf8: Buffer.from([0x23, 0x23, 0x20, 0x50, 0x68, 0x61, 0x73, 0x65, 0x73, 0x0a, 0x23, 0x23, 0x23, 0x20, 0x61, 0x0a, 0x2d, 0x20, 0x66, 0x69, 0x6c, 0x65, 0x73, 0x3a, 0x20, 0xff, 0xfe, 0x20, 0x73, 0x72, 0x63, 0x2f, 0x61, 0x2e, 0x6a, 0x73, 0x0a]).toString('latin1'),
};
const files = {};
for (const [k, v] of Object.entries(plans)) if (v !== null) files[`p_${k}/PLAN.md`] = k === 'invalidutf8' ? Buffer.from(v, 'latin1') : v;
files['p_dirplan/PLAN.md/x'] = 'a directory named PLAN.md';
files['p_none/.keep'] = '';
// fuzzed plans
const FR = ['src/a.js', 'lib/b.ts', 'docs/c.md', './x/y.py', 'a b', '`q/r.js`', '"s/t.js"', '(u/v.go)', 'w.rs,', 'src/db/migrations/001.sql', 'auth/login.js', 'app.swift.'];
const SEP = ['\n', '\r\n', '\n\n', ' ', '\r', ' '];
const WS = [' ', '\t', '  ', ' ', '　', '﻿'];
function fuzzPlan(i) {
  const nl = () => pick(SEP);
  const phases = Math.floor(R() * 4);
  let t = R() < 0.3 ? '# Plan' + nl() : '';
  if (R() < 0.2) t += '## Notes' + nl() + '- files: ignored/before.js' + nl();
  t += '##' + pick(WS) + (R() < 0.2 ? 'phases' : 'Phases') + (R() < 0.1 ? 'x' : '') + nl();
  for (let p = 0; p < phases; p++) {
    t += '###' + pick(WS) + 'Phase ' + p + nl();
    if (R() < 0.7) t += '-' + pick(WS) + (R() < 0.15 ? 'Files' : 'files') + ':' + pick(WS) + Array.from({ length: 1 + Math.floor(R() * 4) }, () => pick(FR)).join(pick([', ', ' ', nl() + '  - ', '\t'])) + nl();
    if (R() < 0.5) t += '- verify: tests' + nl();
    if (R() < 0.1) t += '####' + pick(WS) + 'deeper' + nl();
  }
  if (R() < 0.4) t += '##' + pick(WS) + 'Progress' + nl() + '- files: late/x.js' + nl();
  return t;
}
const NFUZZ = 400;
for (let i = 0; i < NFUZZ; i++) files[`f${i}/PLAN.md`] = fuzzPlan(i);

const ON = { settings: { guards: { shipitGate: true } }, files };
const HOME = '$HOME';
const dirs = Object.keys(plans).map(k => `${HOME}/p_${k}`).concat([`${HOME}/p_dirplan`, `${HOME}/nonexistent`, '/', '/tmp']);

// ---- (1) hand-written ----------------------------------------------------------------------------------------
const RISKY = ['db/migrations/001_init.sql', 'src/auth/login.js', '.github/workflows/ci.yml', 'migrate/run.py', 'x/security/keys.go', 'lib/crypto/aes.rs', 'app/user_auth.ts', 'a.password.js', 'x.migration.sql', 'Migrations/V1.cs', 'AUTH/Login.java',
  'src\\auth\\x.js', '.GITHUB\\WORKFLOWS\\a.yml', 'src/session.rb', 'secrets.py', 'src/auth', 'src/authentic/x.js'];
const SAFE = ['src/a.js', 'README.md', 'tests/auth/login.test.js', 'src/auth/login.test.js', 'src/auth/spec/x.js', 'docs/migrations/notes.txt', 'PLAN.md', 'sub/plan.md', 'x/PLAN.MD', 'a.spec.ts', 'src/__tests__/x.js', 'migrations.md', 'x/Test/y.js', 'tests'];
for (const d of dirs) {
  for (const f of [...RISKY, ...SAFE, `${d}/src/a.js`, `${d}/src/api/routes.js`, `${d}/lib/b.ts`, `${d}/other.js`, 'src/db/a.js', 'docs/c.md', 'x/y.py']) {
    add(edit(f, d), ON, `unit-${d.slice(-14)}-${f}`);
  }
  add(pl('MultiEdit', { file_path: 'src/a.js', edits: [{ file_path: 'src/db/migrations/x.sql' }, { file_path: 'q.js' }, { nope: 1 }, null, { file_path: 5 }] }, d), ON, `multi-${d}`);
  add(pl('Write', { file_path: `${d}/src/a.js` }, d), ON, `write-${d}`);
  add(pl('NotebookEdit', { notebook_path: 'a.ipynb', file_path: 'src/auth/x.js' }, d), ON, `nb-${d}`);
}
for (const [id, p] of [
  ['no-tool-input', pl('Edit', undefined, `${HOME}/p_none`)], ['null-input', pl('Edit', null, `${HOME}/p_none`)], ['str-input', pl('Edit', 'x', `${HOME}/p_none`)], ['arr-input', pl('Edit', [1], `${HOME}/p_none`)],
  ['num-path', pl('Edit', { file_path: 5 }, `${HOME}/p_none`)], ['empty-path', pl('Edit', { file_path: '' }, `${HOME}/p_none`)],
  ['no-cwd', pl('Edit', { file_path: 'src/auth/x.js' }, undefined)], ['rel-cwd', pl('Edit', { file_path: 'src/auth/x.js' }, 'rel/dir')], ['num-cwd', pl('Edit', { file_path: 'src/auth/x.js' }, 5)], ['empty-cwd', pl('Edit', { file_path: 'src/auth/x.js' }, '')],
  ['no-cwd-nonrisky-noncode', pl('Edit', { file_path: 'README.md' }, undefined)],
  ['bash-write', pl('Bash', { command: 'echo x > src/auth/login.js' }, `${HOME}/p_none`)], ['bash-nocmd', pl('Bash', {}, `${HOME}/p_none`)], ['bash-noop', pl('Bash', { command: 'ls' }, `${HOME}/p_real`)],
  ['patch', pl('apply_patch', { command: '*** Begin Patch\n*** Add File: src/auth/x.js\n+x\n*** End Patch' }, `${HOME}/p_none`)],
  ['no-tool', { hook_event_name: 'PreToolUse', session_id: 's', cwd: `${HOME}/p_none`, tool_input: { file_path: 'src/auth/x.js' } }],
  ['abs-risky-abs-plan-cwd', edit(`${HOME}/p_real/src/db/migrations/1.sql`, `${HOME}/p_real`)], ['abs-outside', edit('/etc/auth/x.conf', `${HOME}/p_real`)],
  ['dotdot', edit('../p_real/src/a.js', `${HOME}/p_real/sub/..`)], ['trailing-slash-cwd', edit('src/a.js', `${HOME}/p_real/`)], ['dotted-cwd', edit('src/a.js', `${HOME}/./p_real/.`)],
  ['unicode-path', edit('src/é/auth/x.js', `${HOME}/p_none`)], ['space-path', edit('my dir/migrations/x.sql', `${HOME}/p_none`)],
  ['same-as-cwd', edit(`${HOME}/p_real`, `${HOME}/p_real`)], ['plan-itself', edit(`${HOME}/p_real/PLAN.md`, `${HOME}/p_real`)],
]) add(p, ON, `shape-${id}`);

// ---- switches ---------------------------------------------------------------------------------------------
const probe = [edit('src/auth/login.js', `${HOME}/p_none`), edit('src/zzz.js', `${HOME}/p_real`), pl('Bash', { command: 'echo > x' }, `${HOME}/p_none`)];
const ctxs = {
  off: { files }, offExplicit: { settings: { guards: { shipitGate: false } }, files }, envOn: { env: { ANTIHALL_SHIPIT_GATE: '1' }, files }, envOnWord: { env: { ANTIHALL_SHIPIT_GATE: ' On ' }, files },
  envOff: { env: { ANTIHALL_SHIPIT_GATE: '0' }, settings: { guards: { shipitGate: true } }, files }, envJunk: { env: { ANTIHALL_SHIPIT_GATE: 'zz' }, settings: { guards: { shipitGate: true } }, files },
  strOn: { settings: { guards: { shipitGate: 'yes' } }, files }, numOn: { settings: { guards: { shipitGate: 1 } }, files }, numTwo: { settings: { guards: { shipitGate: 2 } }, files }, objOn: { settings: { guards: { shipitGate: {} } }, files },
  optOn: { env: { CLAUDE_PLUGIN_OPTION_GUARDS_SHIPIT_GATE: 'true' }, files }, optDefault: { env: { CLAUDE_PLUGIN_OPTION_GUARDS_SHIPIT_GATE: 'false' }, settings: {}, files },
  optStored: { claude: { pluginConfigs: { 'anti-hall': { options: { guards_shipit_gate: true } } } }, files }, optStoredFlat: { claude: { pluginConfigs: { 'anti-hall@anti-hall': { guards_shipit_gate: 'true' } } }, files },
  optStoredDefault: { claude: { pluginConfigs: { 'anti-hall': { options: { guards_shipit_gate: false } } } }, settings: { guards: { shipitGate: true } }, files },
  skip: { settings: { guards: { shipitGate: true } }, skip: { 'ship-it-guard': Date.now() + 3600e3 }, files }, skipAll: { settings: { guards: { shipitGate: true } }, skip: { all: Date.now() + 3600e3 }, files },
  skipExpired: { settings: { guards: { shipitGate: true } }, skip: { all: Date.now() - 1e3 }, files }, badSettings: { settings: '{x', files },
};
for (const [k, c] of Object.entries(ctxs)) for (const [i, p] of probe.entries()) add(p, c, `ctx-${k}-${i}`);

// ---- (2) real paths ----------------------------------------------------------------------------------------
const want = +arg('--real', 6000);
const rows = [];
try { for (const l of fs.readFileSync(arg('--edits', '../../fpr/edits.jsonl'), 'utf8').split('\n')) if (l) { try { rows.push(JSON.parse(l)); } catch { /* skip */ } } } catch { /* optional */ }
const tokens = new Set();
for (const c of readCmds(arg('--cmds', '../../fpr/cmds.jsonl'))) {
  for (const t of c.cmd.split(/\s+/)) if (/^[./~A-Za-z0-9_\\-][^"'`$;|&<>()*?]*\/[^"'`$;|&<>()*?]+$/.test(t) && t.length < 200) tokens.add(t);
  if (tokens.size > 40000) break;
}
const toks = [...tokens];
const realPaths = [...rows.map(r => r.file), ...toks];
let real = 0;
for (const r of rows) { add(pl(r.tool, { file_path: r.file }, r.cwd || `${HOME}/p_real`), ON, `real-edit-${real}`); real++; }
while (real < want) { const f = pick(toks); add(edit(f, pick(dirs)), ON, `real-token-${real}`); real++; }
// ---- (3) real names on hard-risk directories ---------------------------------------------------------------
const RDIRS = ['migrations', 'auth', '.github/workflows', 'security', 'crypto', 'migrate', 'authn'];
for (let i = 0; i < 1500; i++) {
  const base = pick(realPaths).split('/').pop() || 'x.js';
  const f = pick([`${pick(RDIRS)}/${base}`, `src/${pick(RDIRS)}/${base}`, `${base.replace(/\.[^.]*$/, '')}.${pick(['auth', 'token', 'secret', 'login', 'migration', 'migrations', 'session'])}.js`, `${pick(dirs)}/${pick(RDIRS)}/${base}`]);
  add(edit(f, pick(dirs)), ON, `risk-${i}`);
}
// ---- (4) fuzzed plans: every plan against declared-looking and unrelated targets --------------------------------
for (let i = 0; i < NFUZZ; i++) for (const f of ['src/a.js', 'lib/b.ts', 'x/y.py', 'src/db/migrations/001.sql', 'auth/login.js', 'late/x.js', 'never/seen.js', `${HOME}/f${i}/src/a.js`, 'a b', 'w.rs', 'app.swift']) add(edit(f, `${HOME}/f${i}`), ON, `fuzz-${i}-${f}`);
console.error(`scenarios=${scenarios.length} real=${real} fuzzplans=${NFUZZ}`);
runParity({ name: 'ship-it-guard', check: 'ship-it-guard', hookFile: 'ship-it-guard.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), events: ['PreToolUse'], tools: ['*'] });
