#!/usr/bin/env node
// Parity of the built-in `task-lifecycle-log` check against hooks/task-lifecycle-log.js (TaskCreated / TaskCompleted).
//   node run-task-lifecycle-log.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks [--fuzz 300] [--seed 1]
// Compared: exit code, stdout, stderr and the whole file tree both worlds hold afterwards (ledger, INDEX.md, any directory
// the hook created), see hookfx.js. Corpus: field shapes, text sanitizing (control characters, white space, emoji at the cut,
// limits), session id forms, repo-root resolution (git dir, subdirectory, git file, broken git file, cwd inside the git
// directory, symlinked cwd, missing cwd, cwd that is a file, checkout at HOME), existing ledger/index content, switches,
// unwritable directories, malformed stdin, and a seeded fuzz.
const { arg, rng, runFx } = require('./hookfx.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const base = (extra, ev) => Object.assign({ hook_event_name: ev || 'TaskCreated', session_id: 'sess-1', cwd: '$PROJ', task_id: '7', task_subject: 'write the parser', transcript_path: '/x' }, extra || {});
const add = (id, payload, world, more) => scenarios.push(Object.assign({ id, world, steps: [{ payload }] }, more || {}));
const addRaw = (id, raw, world) => scenarios.push({ id, world, steps: [{ raw }] });
const REPO = { gitdirs: ['proj'] };

// ---- plain events and field shapes -----------------------------------------------------------------------------
for (const ev of ['TaskCreated', 'TaskCompleted', 'Stop', 'taskcreated', 'TaskUpdated', '', null, 5, ['TaskCreated']]) add(`event-${JSON.stringify(ev)}`, base({ hook_event_name: ev }), REPO);
add('no-event', (() => { const p = base(); delete p.hook_event_name; return p; })(), REPO);
add('teammate', base({ teammate_name: 'builder-1' }), REPO);
add('teammate-long', base({ teammate_name: 'x'.repeat(150) }), REPO);
add('teammate-ws', base({ teammate_name: '  a\t\nb  ' }), REPO);
add('teammate-num', base({ teammate_name: 5 }), REPO);
add('subject-missing', (() => { const p = base(); delete p.task_subject; return p; })(), REPO);
for (const s of ['', 0, false, null, 5, ['a'], { a: 1 }, true]) add(`subject-${JSON.stringify(s)}`, base({ task_subject: s }), REPO);
add('subject-long', base({ task_subject: 'y'.repeat(400) }), REPO);
add('subject-exact-200', base({ task_subject: 'z'.repeat(200) }), REPO);
add('subject-201', base({ task_subject: 'z'.repeat(201) }), REPO);
add('subject-ctl', base({ task_subject: 'a\u0000b\u001fc\u007fd\u009fe f g　h' }), REPO);
add('subject-newlines', base({ task_subject: 'line1\nline2\r\n\tline3' }), REPO);
add('subject-unicode', base({ task_subject: 'café — naïve 日本語 ünïcödé' }), REPO);
add('subject-emoji-cut-pair', base({ task_subject: 'a'.repeat(199) + '😀tail' }), REPO);
add('subject-emoji-cut-clean', base({ task_subject: 'a'.repeat(198) + '😀tail' }), REPO);
add('subject-trim-then-cut', base({ task_subject: ' '.repeat(10) + 'b'.repeat(300) }), REPO);
add('subject-md', base({ task_subject: '- [x] **bold** `code` | pipe' }), REPO);
for (const t of [7, 0, -1, 1.5, 1e21, 1e-7, 123456789012345680000, true, false, null, '', '   ', ' 12 ', 'abc', ['a', 'b'], [1, [2, 3]], [null, 1], { a: 1 }, 'x'.repeat(250), 'ünï\u0000cøde', '12\n34']) add(`task-id-${JSON.stringify(t)}`, base({ task_id: t }), REPO);
add('task-id-missing', (() => { const p = base(); delete p.task_id; return p; })(), REPO);
add('task-id-emoji-cut', base({ task_id: 'a'.repeat(199) + '😀' }), REPO);
for (const s of ['sess-1', 'a/b', '../../etc', 'ünï', '', '   ', null, 5, true, ['a', 'b'], { x: 1 }, 'x'.repeat(300), 'a.b.c', 'A_B-c', '😀😀', 1.5, 0]) add(`session-${JSON.stringify(s).slice(0, 40)}`, base({ session_id: s }), REPO);
add('session-missing', (() => { const p = base(); delete p.session_id; return p; })(), REPO);
for (const c of [undefined, null, '', 5, true, [], {}]) add(`cwd-${JSON.stringify(c)}`, (() => { const p = base(); if (c === undefined) delete p.cwd; else p.cwd = c; return p; })(), REPO);
add('extra-fields', base({ task_description: 'desc', foo: { bar: [1, 2] } }), REPO);
for (const raw of ['', '   ', 'not json', '{', '[]', 'null', '5', '"str"', 'true', '{"hook_event_name":"TaskCreated"', '﻿{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":"1"}',
  '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":"1","session_id":"s\\ud83d"}', '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":"\\ud800x"}',
  '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":"1","task_id":"2"}', '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":"1e5"}', '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":1E2}',
  '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":12345678901234567890123}', '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":0.1}', '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":-0}',
  '{"hook_event_name":"TaskCreated","cwd":"$PROJ","task_id":"\\u0000"}', '{"hook_event_name":"TaskCreated","cwd":"$PROJ\\u0000x","task_id":"1"}']) addRaw(`raw-${JSON.stringify(raw).slice(0, 50)}`, raw, REPO);
add('huge-subject', base({ task_subject: 'q'.repeat(2_000_000) }), REPO);
add('deep-json', base({ extra: JSON.parse('['.repeat(60) + ']'.repeat(60)) }), REPO);

// ---- project-root resolution -----------------------------------------------------------------------------------------
add('root-plain-no-git', base(), {});
add('root-subdir-of-repo', base({ cwd: '$PROJ/src/deep' }), { gitdirs: ['proj'], dirs: ['proj/src/deep'] });
add('root-cwd-trailing-slash', base({ cwd: '$PROJ/' }), REPO);
add('root-cwd-dotdot', base({ cwd: '$PROJ/src/../src' }), { gitdirs: ['proj'], dirs: ['proj/src'] });
add('root-cwd-dot', base({ cwd: '$PROJ/./' }), REPO);
add('root-cwd-double-slash', base({ cwd: '$PROJ//src' }), { gitdirs: ['proj'], dirs: ['proj/src'] });
add('root-inside-git-dir', base({ cwd: '$PROJ/.git/hooks' }), { gitdirs: ['proj'], dirs: ['proj/.git/hooks'] });
add('root-at-git-dir', base({ cwd: '$PROJ/.git' }), REPO);
add('root-git-file-valid', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'gitdir: $W/gitstore/wt\n' }, dirs: ['gitstore/wt'] });
add('root-git-file-relative', base({ cwd: '$PROJ/sub' }), { files: { 'proj/.git': 'gitdir: ../gitstore/wt\n' }, dirs: ['gitstore/wt', 'proj/sub'] });
add('root-git-file-crlf', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'gitdir: $W/gitstore/wt\r\n' }, dirs: ['gitstore/wt'] });
add('root-git-file-leading-blank', base({ cwd: '$PROJ' }), { files: { 'proj/.git': '\n\n  gitdir:   $W/gitstore/wt   \n' }, dirs: ['gitstore/wt'] });
add('root-git-file-second-line', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'junk\ngitdir: $W/gitstore/wt\n' }, dirs: ['gitstore/wt'] });
add('root-git-file-no-newline', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'gitdir: $W/gitstore/wt' }, dirs: ['gitstore/wt'] });
add('root-git-file-missing-target', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'gitdir: $W/nowhere\n' } });
add('root-git-file-target-is-file', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'gitdir: $W/afile\n', afile: 'x' } });
add('root-git-file-garbage', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'hello world\n' } });
add('root-git-file-empty', base({ cwd: '$PROJ' }), { files: { 'proj/.git': '' } });
add('root-git-file-empty-value', base({ cwd: '$PROJ' }), { files: { 'proj/.git': 'gitdir:   \n' } });
add('root-git-file-cwd-in-target', base({ cwd: '$W/gitstore/wt/sub' }), { files: { 'proj/.git': 'gitdir: $W/gitstore/wt\n' }, dirs: ['gitstore/wt/sub'] });
add('root-git-symlink-to-dir', base({ cwd: '$PROJ' }), { dirs: ['realgit'], links: { 'proj/.git': '$W/realgit' } });
add('root-git-broken-symlink', base({ cwd: '$PROJ' }), { links: { 'proj/.git': '$W/nope' } });
add('root-symlinked-cwd', base({ cwd: '$W/link' }), { gitdirs: ['proj'], links: { link: '$PROJ' } });
add('root-symlinked-cwd-sub', base({ cwd: '$W/link/src' }), { gitdirs: ['proj'], dirs: ['proj/src'], links: { link: '$PROJ' } });
add('root-symlink-in-middle', base({ cwd: '$W/a/b' }), { gitdirs: ['proj'], dirs: ['proj/x'], links: { 'a/b': '$PROJ/x' } });
add('root-cwd-missing', base({ cwd: '$W/nonexistent/deep/dir' }), {});
add('root-cwd-missing-in-repo', base({ cwd: '$PROJ/gone/er' }), REPO);
add('root-cwd-is-file', base({ cwd: '$W/afile' }), { files: { afile: 'x' } });
add('root-cwd-nul', base({ cwd: '$PROJ\u0000/x' }), REPO);
add('root-relative-cwd', base({ cwd: 'proj' }), REPO);
add('root-relative-dot', base({ cwd: '.' }), REPO);
add('root-relative-dotdot', base({ cwd: '../x' }), REPO);
add('root-home-is-repo', base({ cwd: '$HOME/sub' }), { gitdirs: ['home'], dirs: ['home/sub'] });
add('root-home-is-repo-at-home', base({ cwd: '$HOME' }), { gitdirs: ['home'] });
add('root-home-sub-repo', base({ cwd: '$HOME/proj2' }), { gitdirs: ['home', 'home/proj2'] });
add('root-nested-repo', base({ cwd: '$PROJ/inner/x' }), { gitdirs: ['proj', 'proj/inner'], dirs: ['proj/inner/x'] });
add('root-submodule-like', base({ cwd: '$PROJ/mod' }), { gitdirs: ['proj'], files: { 'proj/mod/.git': 'gitdir: ../.git/modules/mod\n' }, dirs: ['proj/.git/modules/mod'] });
add('root-spaces-in-path', base({ cwd: '$W/my proj/x y' }), { gitdirs: ['my proj'], dirs: ['my proj/x y'] });
add('root-unicode-path', base({ cwd: '$W/projé/日本' }), { gitdirs: ['projé'], dirs: ['projé/日本'] });
add('root-git-dir-symlink-under', base({ cwd: '$PROJ' }), { dirs: ['store/g'], links: { 'proj/.git': '$W/store/g' } });
add('root-tilde-cwd', base({ cwd: '~/proj' }), REPO);
add('root-root-dir', base({ cwd: '/' }), {});

// ---- ledger and index state ------------------------------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const HD = `proj/.anti-hall/history/${today}`;
add('state-existing-ledger', base(), { gitdirs: ['proj'], files: { [`${HD}/sess-1.md`]: '- earlier line\n' } });
add('state-existing-ledger-no-newline', base(), { gitdirs: ['proj'], files: { [`${HD}/sess-1.md`]: '- earlier line' } });
add('state-index-has-session', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history/INDEX.md': '- 2020-01-01 · sess-1 · [history](../x)\n' } });
add('state-index-has-substring', base({ session_id: 'ab' }), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history/INDEX.md': 'something abc something\n' } });
add('state-index-other', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history/INDEX.md': '- other\n' } });
add('state-index-no-newline', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history/INDEX.md': '- other' } });
add('state-index-is-dir', base(), { gitdirs: ['proj'], dirs: ['proj/.anti-hall/history/INDEX.md'] });
add('state-ledger-is-dir', base(), { gitdirs: ['proj'], dirs: [`${HD}/sess-1.md`] });
add('state-history-is-file', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history': 'x' } });
add('state-anti-hall-is-file', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall': 'x' } });
add('state-index-invalid-utf8', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history/INDEX.md': 'x�y\n' } });
add('state-readonly-history', base(), { gitdirs: ['proj'], dirs: ['proj/.anti-hall/history'], modes: { 'proj/.anti-hall/history': '555' } });
add('state-readonly-ledger', base(), { gitdirs: ['proj'], files: { [`${HD}/sess-1.md`]: 'x\n' }, modes: { [`${HD}/sess-1.md`]: '444' } });
add('state-readonly-index', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history/INDEX.md': 'x\n' }, modes: { 'proj/.anti-hall/history/INDEX.md': '444' } });
add('state-readonly-proj', base(), { gitdirs: ['proj'], modes: { proj: '555' } });
add('state-big-index', base(), { gitdirs: ['proj'], files: { 'proj/.anti-hall/history/INDEX.md': '- l\n'.repeat(50000) } });

// ---- sequences (idempotent index, ledger growth) ------------------------------------------------------------------------------
const seq = (id, steps, world) => scenarios.push({ id, world: world || REPO, steps: steps.map(p => ({ payload: p })) });
seq('seq-two-events', [base(), base({ hook_event_name: 'TaskCompleted' })]);
seq('seq-many', Array.from({ length: 12 }, (_, i) => base({ task_id: String(i), hook_event_name: i % 2 ? 'TaskCompleted' : 'TaskCreated', teammate_name: i % 3 ? 'mate' : undefined })));
seq('seq-two-sessions', [base({ session_id: 'a' }), base({ session_id: 'b' }), base({ session_id: 'a' }), base({ session_id: 'ab' })]);
seq('seq-substring-sessions', [base({ session_id: 'abc' }), base({ session_id: 'b' }), base({ session_id: 'bc' })]);
seq('seq-two-cwds', [base({ cwd: '$PROJ' }), base({ cwd: '$PROJ/src' })], { gitdirs: ['proj'], dirs: ['proj/src'] });
seq('seq-bad-then-good', [base({ task_id: '' }), base({ cwd: '' }), base()]);

// ---- switches -------------------------------------------------------------------------------------------------------------------
const off = { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ maintenance: { taskLifecycleLog: false } }) } };
add('switch-file-off', base(), off);
add('switch-file-off-string', base(), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ maintenance: { taskLifecycleLog: 'off' } }) } });
add('switch-file-on-string', base(), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ maintenance: { taskLifecycleLog: 'on' } }) } });
add('switch-file-garbage', base(), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': '{not json' } });
add('switch-file-number-0', base(), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ maintenance: { taskLifecycleLog: 0 } }) } });
add('switch-file-unrelated', base(), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ maintenance: { other: false } }) } });
scenarios.push({ id: 'switch-option-off', world: REPO, steps: [{ payload: base(), env: { CLAUDE_PLUGIN_OPTION_MAINTENANCE_TASK_LIFECYCLE_LOG: 'false' } }] });
scenarios.push({ id: 'switch-option-default-true', world: off, steps: [{ payload: base(), env: { CLAUDE_PLUGIN_OPTION_MAINTENANCE_TASK_LIFECYCLE_LOG: 'true' } }] });
add('switch-stored-option-off', base(), { gitdirs: ['proj'], files: { 'home/.claude/settings.json': JSON.stringify({ pluginConfigs: { 'anti-hall': { options: { maintenance_task_lifecycle_log: false } } } }) } });

// ---- seeded fuzz --------------------------------------------------------------------------------------------------------------------
const FZ_TEXT = ['', ' ', 'plain', 'with  spaces', 'tab\there', 'nl\nnl', 'ünï', '日本語', '😀', 'a'.repeat(199) + '😀', 'a'.repeat(200), 'a'.repeat(201), '\u0000', '\u0085', ' x ', ' ', '﻿', 'x'.repeat(5000), '"quoted"', '\\back', '<b>', '- list', '| t |'];
const FZ_VAL = [...FZ_TEXT, 0, 1, 7, -3, 2.5, true, false, null, [], ['x'], [1, 2], {}, { a: 1 }];
const FZ_WORLDS = [REPO, {}, { gitdirs: ['proj'], dirs: ['proj/s'] }];
for (let i = 0; i < +arg('--fuzz', 300); i++) {
  const p = { hook_event_name: pick(['TaskCreated', 'TaskCompleted', 'TaskCreated', 'Other']), session_id: pick(FZ_VAL), cwd: pick(['$PROJ', '$PROJ', '$PROJ/s', '$W/none', '', 5]), task_id: pick(FZ_VAL), task_subject: pick(FZ_VAL), teammate_name: pick(FZ_VAL) };
  for (const k of Object.keys(p)) if (R() < 0.08) delete p[k];
  add(`fuzz-${i}`, p, pick(FZ_WORLDS));
}
console.error(`scenarios=${scenarios.length}`);
runFx({ name: 'task-lifecycle-log', hookFile: 'task-lifecycle-log.js', check: 'task-lifecycle-log', engine: ENGINE, hooks: HOOKS, scenarios, conc: +arg('--conc', 6) });
