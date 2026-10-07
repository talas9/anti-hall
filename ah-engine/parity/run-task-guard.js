#!/usr/bin/env node
// Parity of the built-in `task-guard` check against hooks/task-guard.js (Stop).
//   node run-task-guard.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks [--real 300] [--big 80] [--fuzz 200]
// The engine answers the Stops where no task is open (state file removed, pruning advisory, unknown-state note) and defers
// every other Stop. Compared: exit code, stdout, stderr and the whole file tree. A deferral is never a mismatch, but the
// scenarios that must be answered (no open task) are listed in `mustAnswer`, so an engine that defers everything fails.
const fs = require('fs'), os = require('os'), path = require('path');
const { arg, rng, runFx } = require('./hookfx.js');
const T = require('./tasklines.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const shared = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ah-tg-shared-'));
let nf = 0;
const put = (lines, name) => { const f = path.join(shared, (name || 'f' + nf++) + '.jsonl'); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
const scenarios = [];
const stop = (tp, extra) => Object.assign({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '$PROJ', transcript_path: tp, stop_hook_active: false }, extra || {});
const add = (id, payload, world, more) => scenarios.push(Object.assign({ id, world, steps: [{ payload }] }, more || {}));
const W = { gitdirs: ['proj'] };

// ---- hand-written task histories ---------------------------------------------------------------------------------
const c = (n, s, extra) => T.create(n, Object.assign({ subject: s }, extra || {}));
const H = {};
H.empty = [T.prompt('hello')];
H.oneOpen = [...c(1, 'open one').lines];
H.oneDone = [...c(1, 'done one').lines, ...T.update(1, { status: 'completed' })];
H.inProgress = [...c(1, 'wip').lines, ...T.update(1, { status: 'in_progress' })];
H.inProgressHyphen = [...c(1, 'wip').lines, ...T.update(1, { status: 'in-progress' })];
H.upperStatus = [...c(1, 'x').lines, ...T.update(1, { status: 'PENDING' })];
H.cancelled = [...c(1, 'x').lines, ...T.update(1, { status: 'cancelled' })];
H.canceled = [...c(1, 'x').lines, ...T.update(1, { status: 'Canceled' })];
H.deleted = [...c(1, 'x').lines, ...T.update(1, { status: 'deleted' })];
H.doneThenReopen = [...c(1, 'x').lines, ...T.update(1, { status: 'completed' }), ...T.update(1, { status: 'pending' })];
H.twoOneOpen = [...c(1, 'a').lines, ...c(2, 'b').lines, ...T.update(1, { status: 'completed' })];
H.twoDone = [...c(1, 'a').lines, ...c(2, 'b').lines, ...T.update(1, { status: 'completed' }), ...T.update(2, { status: 'done' })];
H.updateOnly = [...T.update(5, { status: 'completed' })];
H.updateOnlyOpen = [...T.update(5, { status: 'in_progress' })];
H.updateNoStatus = [...T.update(5, { description: 'only text' })];
H.updateOwnerOnly = [...T.update(5, { owner: 'agent-1' })];
H.updateThenCreate = [...T.update(1, { description: 'd' }), ...c(1, 'created later').lines];
H.restartNumbering = [...c(1, 'old').lines, ...c(2, 'old2').lines, ...c(1, 'new after restart').lines];
H.restartDone = [...c(1, 'old').lines, ...c(1, 'new').lines, ...T.update(1, { status: 'completed' })];
H.listEmpty = [...c(1, 'x').lines, ...T.list(true)];
H.listNotEmpty = [...c(1, 'x').lines, ...T.list(false)];
H.getNotFound = [...c(1, 'x').lines, ...T.get(1, false)];
H.getNotFoundOther = [...c(1, 'x').lines, ...T.get(9, false)];
H.getFound = [...c(1, 'x').lines, ...T.get(1, true)];
H.todoOpen = [...T.todo([{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }])];
H.todoDone = [...T.todo([{ content: 'a', status: 'completed' }])];
H.todoThenCreate = [...T.todo([{ content: 'a', status: 'pending' }]), ...c(1, 'x').lines, ...T.update(1, { status: 'completed' })];
H.todoIds = [...T.todo([{ id: 't1', content: 'a', status: 'completed' }, { id: 7, content: 'b', status: 'completed' }, { content: 'c' }])];
H.todoBadElem = [...T.todo([null])];
H.todoStringElem = [...T.todo(['x'])];
H.todoNotArray = [T.asst([T.use('TodoWrite', { todos: 'x' })])];
H.todoEmpty = [...T.todo([])];
H.addBlockedBy = [...c(1, 'a').lines, ...c(2, 'b').lines, ...T.update(2, { addBlockedBy: ['1'], status: 'completed' }), ...T.update(1, { status: 'completed' })];
H.blockedOn = [...c(1, 'x', { metadata: { blockedOn: 'owner' } }).lines, ...T.update(1, { status: 'completed' })];
H.parallelCreates = (() => { const a = T.use('TaskCreate', { subject: 'p1' }), b = T.use('TaskCreate', { subject: 'p2' }); const m = T.mid(); return [J2(m, [a, b]), T.user([T.res(b.id, 'Task #1 created successfully: p2'), T.res(a.id, 'Task #2 created successfully: p1')]), ...T.update(1, { status: 'completed' }), ...T.update(2, { status: 'completed' })]; })();
function J2(m, blocks) { return JSON.stringify({ type: 'assistant', timestamp: T.ts(3), message: { id: m, role: 'assistant', content: blocks } }); }
H.sidechain = [JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'm', role: 'assistant', content: [T.use('TaskCreate', { subject: 'side' })] } })];
H.nullLine = [...c(1, 'a').lines, 'null', ...T.update(1, { status: 'completed' })];
H.numberLine = [...c(1, 'a').lines, '5', '"str"', 'true', '[1,2]', ...T.update(1, { status: 'completed' })];
H.brokenLine = [...c(1, 'a').lines, '{"type":"assistant","message":{"content":[{"type":"tool_use"', ...T.update(1, { status: 'completed' })];
H.blankLines = ['', '   ', ...c(1, 'a').lines, '', ...T.update(1, { status: 'completed' })];
H.crlf = null; // handled below
H.statusNumber = [...c(1, 'a').lines, T.asst([T.use('TaskUpdate', { taskId: '1', status: 5 })])];
H.statusObject = [T.asst([T.use('TaskUpdate', { taskId: '1', status: { a: 1 } })])];
H.statusEmptyString = [...c(1, 'a').lines, ...T.update(1, { status: '' })];
H.statusNull = [...c(1, 'a').lines, ...T.update(1, { status: null })];
H.taskIdNumber = [...c(1, 'a').lines, T.asst([T.use('TaskUpdate', { taskId: 1, status: 'completed' })])];
H.taskIdAlt = [...c(1, 'a').lines, T.asst([T.use('TaskUpdate', { id: '1', status: 'completed' })]), T.asst([T.use('TaskUpdate', { task_id: '1', status: 'completed' })])];
H.taskIdObject = [T.asst([T.use('TaskUpdate', { taskId: { x: 1 }, status: 'completed' })])];
H.taskIdNull = [T.asst([T.use('TaskUpdate', { taskId: null, status: 'completed' })])];
H.inputString = [T.asst([{ type: 'tool_use', id: 'tu_s', name: 'TaskUpdate', input: 'x' }])];
H.inputMissing = [T.asst([{ type: 'tool_use', id: 'tu_m', name: 'TaskCreate' }])];
H.createNoId = [T.asst([{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'x' } }])];
H.createNumId = [T.asst([{ type: 'tool_use', id: 5, name: 'TaskCreate', input: { subject: 'x' } }])];
H.createSubjectVariants = [T.asst([T.use('TaskCreate', { title: 't' })]), T.asst([T.use('TaskCreate', { content: 'c' })]), T.asst([T.use('TaskCreate', { description: 'd' })]), T.asst([T.use('TaskCreate', {})])];
H.createSubjectObject = [T.asst([T.use('TaskCreate', { subject: { a: 1 } })])];
H.createStatus = [...T.create(1, { subject: 'x', status: 'completed' }).lines];
H.createStatusWeird = [...T.create(1, { subject: 'x', status: 7 }).lines];
H.nested = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'n1', name: 'TaskCreate', input: { subject: 'nested' } }] }, messages: [{ content: [T.use('TaskUpdate', { taskId: '9', status: 'completed' })] }] })];
H.toolUsesKey = [JSON.stringify({ tool_uses: [T.use('TaskCreate', { subject: 'tu' })] }), JSON.stringify({ parts: [T.use('TaskUpdate', { taskId: '3', status: 'completed' })] })];
H.resultOnly = [T.user([T.res('toolu_x', 'Task #3 created successfully: x')])];
H.resultNotString = [...(() => { const tu = T.use('TaskCreate', { subject: 'x' }); return [T.asst([tu]), T.user([T.res(tu.id, [{ type: 'text', text: 'Task #1 created successfully: x' }])])]; })()];
H.resultCaps = [...(() => { const tu = T.use('TaskCreate', { subject: 'x' }); return [T.asst([tu]), T.user([T.res(tu.id, 'TASK  #1   CREATED   SUCCESSFULLY')]), ...T.update(1, { status: 'completed' })]; })()];
H.resultLeadingZero = [...(() => { const tu = T.use('TaskCreate', { subject: 'x' }); return [T.asst([tu]), T.user([T.res(tu.id, 'Task #007 created successfully')]), ...T.update(7, { status: 'completed' })]; })()];
H.unicode = [...c(1, 'café 日本語 😀').lines, ...T.update(1, { status: 'completed' })];
H.manyDone = Array.from({ length: 14 }, (_, i) => [...c(i + 1, 'd' + i).lines, ...T.update(i + 1, { status: 'completed' })]).flat();
H.tenDone = Array.from({ length: 10 }, (_, i) => [...c(i + 1, 'd' + i).lines, ...T.update(i + 1, { status: 'completed' })]).flat();
H.elevenDone = Array.from({ length: 11 }, (_, i) => [...c(i + 1, 'd' + i).lines, ...T.update(i + 1, { status: i % 2 ? 'cancelled' : 'done' })]).flat();
H.manyDoneOneOpen = [...H.manyDone, ...c(15, 'still open').lines];
H.manyDeleted = Array.from({ length: 14 }, (_, i) => [...c(i + 1, 'd' + i).lines, ...T.update(i + 1, { status: 'deleted' })]).flat();
H.unknownMany = Array.from({ length: 4 }, (_, i) => T.update(i + 20, { description: 'x' })).flat();
const tps = {};
for (const [k, lines] of Object.entries(H)) if (lines) tps[k] = put(lines, k);
tps.crlf = (() => { const f = path.join(shared, 'crlf.jsonl'); fs.writeFileSync(f, [...c(1, 'a').lines, ...T.update(1, { status: 'completed' })].join('\r\n') + '\r\n'); return f; })();
tps.noTrailingNewline = (() => { const f = path.join(shared, 'nonl.jsonl'); fs.writeFileSync(f, [...c(1, 'a').lines, ...T.update(1, { status: 'completed' })].join('\n')); return f; })();
tps.empty0 = (() => { const f = path.join(shared, 'empty0.jsonl'); fs.writeFileSync(f, ''); return f; })();
tps.dir = shared; tps.missing = path.join(shared, 'missing.jsonl');
tps.invalidUtf8 = (() => { const f = path.join(shared, 'badutf8.jsonl'); fs.writeFileSync(f, Buffer.concat([Buffer.from([...c(1, 'a').lines].join('\n') + '\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(T.update(1, { status: 'completed' }).join('\n') + '\n')])); return f; })();
tps.bom = (() => { const f = path.join(shared, 'bom.jsonl'); fs.writeFileSync(f, '﻿' + [...c(1, 'a').lines, ...T.update(1, { status: 'completed' })].join('\n') + '\n'); return f; })();
for (const [k, tp] of Object.entries(tps)) add(`hand-${k}`, stop(tp), W, { mustAnswer: ['empty', 'oneDone', 'twoDone', 'updateOnly', 'todoDone', 'listEmpty', 'cancelled', 'deleted', 'manyDone', 'tenDone', 'elevenDone', 'unknownMany', 'empty0', 'missing', 'dir', 'crlf', 'noTrailingNewline'].includes(k) });

// ---- payload shapes against one history --------------------------------------------------------------------------
const D = tps.oneDone;
for (const [id, p] of [
  ['no-transcript', stop(undefined)], ['empty-transcript', stop('')], ['number-transcript', stop(5)], ['null-payload', null], ['array-payload', [1]], ['no-session', stop(D, { session_id: undefined })],
  ['session-number', stop(D, { session_id: 7 })], ['session-object', stop(D, { session_id: { a: 1 } })], ['session-unicode', stop(D, { session_id: 'sé/ss 😀' })], ['session-empty', stop(D, { session_id: '' })],
  ['session-long', stop(D, { session_id: 'x'.repeat(300) })], ['hook-active', stop(D, { stop_hook_active: true })], ['agent', stop(D, { agent_id: 'a1' })], ['extra', stop(D, { foo: [1, 2] })],
  ['relative-transcript', stop('t.jsonl')], ['tilde', stop('~/x.jsonl')],
]) add(`shape-${id}`, p, W, { mustAnswer: ['no-transcript', 'empty-transcript', 'number-transcript', 'no-session', 'session-number', 'session-unicode', 'session-empty', 'session-long', 'hook-active', 'agent', 'extra'].includes(id) });

// ---- switches, skip, judge child, state files ---------------------------------------------------------------------------------
const off = { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ guards: { taskGuard: false } }) } };
add('switch-off', stop(tps.oneOpen), off);
add('switch-off-string', stop(tps.oneOpen), { files: { 'home/.anti-hall/settings.json': JSON.stringify({ guards: { taskGuard: 'off' } }) } });
scenarios.push({ id: 'switch-option-off', world: W, steps: [{ payload: stop(tps.oneOpen), env: { CLAUDE_PLUGIN_OPTION_GUARDS_TASK_GUARD: 'false' } }] });
scenarios.push({ id: 'judge-child', world: W, steps: [{ payload: stop(tps.oneOpen), env: { ANTIHALL_JUDGE_CHILD: '1' } }] });
add('skip-guard', stop(tps.oneOpen), { files: { 'home/.anti-hall/skip.json': JSON.stringify({ 'task-guard': Date.now() + 3.6e6 }) } });
add('skip-all', stop(tps.oneOpen), { files: { 'home/.anti-hall/skip.json': JSON.stringify({ all: Date.now() + 3.6e6 }) } });
add('skip-expired', stop(tps.oneOpen), { files: { 'home/.anti-hall/skip.json': JSON.stringify({ 'task-guard': Date.now() - 1e3 }) } });
add('state-file-removed', stop(tps.oneDone), { files: { 'home/.anti-hall/last-stop-taskset-sess-1': JSON.stringify({ hash: 'abc', blocks: 2 }) } }, { mustAnswer: true });
add('state-file-kept-when-open', stop(tps.oneOpen), { files: { 'home/.anti-hall/last-stop-taskset-sess-1': JSON.stringify({ hash: 'abc', blocks: 2 }) } });
add('state-file-other-session', stop(tps.oneDone), { files: { 'home/.anti-hall/last-stop-taskset-other': 'x' } }, { mustAnswer: true });
add('state-file-weird-session-key', stop(tps.oneDone, { session_id: 'a/b c' }), { files: { 'home/.anti-hall/last-stop-taskset-a_b_c': 'x' } }, { mustAnswer: true });
add('state-file-is-dir', stop(tps.oneDone), { dirs: ['home/.anti-hall/last-stop-taskset-sess-1'] }, { mustAnswer: true });
add('state-dir-missing-home', stop(tps.oneDone), {}, { mustAnswer: true });
// pruning advisory thresholds and settings
for (const [id, settings, key] of [['limit-3', { guards: { pruneCompletedTasksAfter: 3 } }, 'manyDone'], ['limit-string', { guards: { pruneCompletedTasksAfter: ' 5 ' } }, 'manyDone'], ['limit-hex', { guards: { pruneCompletedTasksAfter: '0x5' } }, 'manyDone'],
  ['limit-zero', { guards: { pruneCompletedTasksAfter: 0 } }, 'manyDone'], ['limit-neg', { guards: { pruneCompletedTasksAfter: -4 } }, 'manyDone'], ['limit-frac', { guards: { pruneCompletedTasksAfter: 2.5 } }, 'manyDone'], ['limit-garbage', { guards: { pruneCompletedTasksAfter: 'abc' } }, 'manyDone'],
  ['limit-bool', { guards: { pruneCompletedTasksAfter: true } }, 'manyDone'], ['limit-null', { guards: { pruneCompletedTasksAfter: null } }, 'manyDone'], ['limit-big', { guards: { pruneCompletedTasksAfter: 1e9 } }, 'manyDone'], ['limit-1', { guards: { pruneCompletedTasksAfter: 1 } }, 'tenDone'],
  ['limit-empty', { guards: { pruneCompletedTasksAfter: '' } }, 'elevenDone'], ['limit-exp', { guards: { pruneCompletedTasksAfter: '1e1' } }, 'elevenDone']])
  add(`prune-${id}`, stop(tps[key]), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify(settings) } });
scenarios.push({ id: 'prune-env-3', world: W, steps: [{ payload: stop(tps.manyDone), env: { ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER: '3' } }] });
scenarios.push({ id: 'prune-env-garbage', world: W, steps: [{ payload: stop(tps.manyDone), env: { ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER: 'zzz' } }] });
// unknown-state note: set-change throttle and the per-session maximum, over a sequence of Stops
const seq = (id, steps, world) => scenarios.push({ id, world: world || W, steps: steps.map(s => ({ payload: s.payload || s, env: s.env })) });
seq('unknown-note-repeat', [stop(tps.unknownMany), stop(tps.unknownMany), stop(tps.unknownMany)]);
seq('unknown-note-changes', [stop(tps.unknownMany), stop(tps.updateOnly), stop(tps.unknownMany), stop(tps.updateOnlyOpen), stop(H.updateNoStatus && tps.updateNoStatus)]);
seq('unknown-note-two-sessions', [stop(tps.unknownMany, { session_id: 'a' }), stop(tps.unknownMany, { session_id: 'b' }), stop(tps.unknownMany, { session_id: 'a' })]);
seq('unknown-note-corrupt-state', [stop(tps.unknownMany)], { files: { 'home/.anti-hall/last-unknown-guard-sess-1.json': '{nope' } });
seq('unknown-note-state-n-string', [stop(tps.unknownMany)], { files: { 'home/.anti-hall/last-unknown-guard-sess-1.json': JSON.stringify({ hash: 'x', n: '2' }) } });
seq('unknown-note-state-max', [stop(tps.unknownMany)], { files: { 'home/.anti-hall/last-unknown-guard-sess-1.json': JSON.stringify({ hash: 'x', n: 3 }) } });
seq('unknown-note-state-array', [stop(tps.unknownMany)], { files: { 'home/.anti-hall/last-unknown-guard-sess-1.json': '[1,2]' } });
seq('unknown-note-state-object-n', [stop(tps.unknownMany)], { files: { 'home/.anti-hall/last-unknown-guard-sess-1.json': JSON.stringify({ hash: 'x', n: { a: 1 } }) } });
seq('unknown-note-state-dir', [stop(tps.unknownMany)], { dirs: ['home/.anti-hall/last-unknown-guard-sess-1.json'] });
seq('unknown-note-ro-home', [stop(tps.unknownMany)], { files: { 'home/.anti-hall/keep': 'x' }, modes: { 'home/.anti-hall': '555' } });
// state-prune sweep: an old state file goes, a fresh one and a different prefix stay; the stamp throttles the next sweep
const oldTime = new Date(Date.now() - 20 * 864e5);
const pruneWorld = { files: { 'home/.anti-hall/last-unknown-guard-old.json': '{}', 'home/.anti-hall/last-unknown-guard-new.json': '{}', 'home/.anti-hall/last-unknown-tracker-old.json': '{}', 'home/.anti-hall/other-old.json': '{}' } };
scenarios.push({ id: 'prune-sweep', world: pruneWorld, steps: [{ payload: stop(tps.unknownMany, { session_id: 's1' }), before: W2 => { for (const f of ['last-unknown-guard-old.json', 'last-unknown-tracker-old.json', 'other-old.json']) fs.utimesSync(path.join(W2, 'home/.anti-hall', f), oldTime, oldTime); } }, { payload: stop(tps.unknownMany, { session_id: 's2' }) }] });
scenarios.push({ id: 'prune-stamp-recent', world: { files: { 'home/.anti-hall/.prune-stamp-last-unknown.json': JSON.stringify({ lastSweep: Date.now() - 1000 }), 'home/.anti-hall/last-unknown-guard-old.json': '{}' } }, steps: [{ payload: stop(tps.unknownMany), before: W2 => fs.utimesSync(path.join(W2, 'home/.anti-hall/last-unknown-guard-old.json'), oldTime, oldTime) }] });
scenarios.push({ id: 'prune-stamp-future', world: { files: { 'home/.anti-hall/.prune-stamp-last-unknown.json': JSON.stringify({ lastSweep: Date.now() + 1e9 }), 'home/.anti-hall/last-unknown-guard-old.json': '{}' } }, steps: [{ payload: stop(tps.unknownMany), before: W2 => fs.utimesSync(path.join(W2, 'home/.anti-hall/last-unknown-guard-old.json'), oldTime, oldTime) }] });
scenarios.push({ id: 'prune-stamp-garbage', world: { files: { 'home/.anti-hall/.prune-stamp-last-unknown.json': 'xx', 'home/.anti-hall/last-unknown-guard-old.json': '{}' } }, steps: [{ payload: stop(tps.unknownMany), before: W2 => fs.utimesSync(path.join(W2, 'home/.anti-hall/last-unknown-guard-old.json'), oldTime, oldTime) }] });

// ---- truncated transcripts: the window holds only part of the history and the backfill reads before it ----------------------------------------------
const filler = Array.from({ length: 4200 }, (_, i) => T.asst([T.text('filler ' + i + ' ' + 'x'.repeat(380))]));
const big = (id, before, inside) => { const f = put([T.prompt('go'), ...before, ...filler, ...inside], 'big-' + id); add(`big-${id}`, stop(f), W); return f; };
const C = (n, s, extra) => c(n, s, extra).lines;
big('open-before-desc-inside', [...C(1, 'early')], [...T.update(1, { description: 'later text' })]);
big('closed-before-desc-inside', [...C(1, 'early'), ...T.update(1, { status: 'completed' })], [...T.update(1, { description: 'later text' })]);
big('closed-before-status-inside-open', [...C(1, 'early'), ...T.update(1, { status: 'completed' })], [...T.update(1, { status: 'in_progress' })]);
big('open-before-closed-inside', [...C(1, 'early')], [...T.update(1, { status: 'completed' })]);
big('two-tasks-one-closed', [...C(1, 'a'), ...C(2, 'b'), ...T.update(1, { status: 'completed' })], [...T.update(1, { description: 'x' }), ...T.update(2, { description: 'y' })]);
big('two-closed', [...C(1, 'a'), ...C(2, 'b'), ...T.update(1, { status: 'completed' }), ...T.update(2, { status: 'cancelled' })], [...T.update(1, { description: 'x' }), ...T.update(2, { description: 'y' })]);
big('deleted-before', [...C(1, 'a'), ...T.update(1, { status: 'deleted' })], [...T.update(1, { description: 'x' })]);
big('create-only-before', [...C(1, 'a')], [...T.update(1, { owner: 'agent' })]);
big('update-chain-before', [...C(1, 'a'), ...T.update(1, { status: 'in_progress' }), ...T.update(1, { status: 'completed' })], [...T.update(1, { description: 'x' })]);
big('update-chain-reopen', [...C(1, 'a'), ...T.update(1, { status: 'completed' }), ...T.update(1, { status: 'pending' })], [...T.update(1, { description: 'x' })]);
big('todowrite-before', [...T.todo([{ content: 'old', status: 'pending' }]), ...C(1, 'a')], [...T.update(1, { description: 'x' })]);
big('todowrite-between', [...C(1, 'a'), ...T.todo([{ content: 'reset', status: 'completed' }])], [...T.update(1, { description: 'x' })]);
big('tasklist-empty-between', [...C(1, 'a'), ...T.list(true)], [...T.update(1, { description: 'x' })]);
big('restart-numbering-between', [...C(1, 'old'), ...T.update(1, { status: 'completed' }), ...C(1, 'new-after-restart')], [...T.update(1, { description: 'x' })]);
big('notfound-between', [...C(1, 'a'), ...T.get(1, false)], [...T.update(1, { description: 'x' })]);
big('notfound-update-between', [...C(1, 'a'), ...(() => { const tu = T.use('TaskUpdate', { taskId: '1', status: 'completed' }); return [T.asst([tu]), T.user([T.res(tu.id, 'Task #1 not found')])]; })()], [...T.update(1, { description: 'x' })]);
big('window-has-create-too', [...C(1, 'a')], [...C(2, 'b'), ...T.update(1, { description: 'x' }), ...T.update(2, { status: 'completed' })]);
big('window-restart', [...C(1, 'a'), ...C(2, 'b')], [...C(1, 'fresh list'), ...T.update(1, { status: 'completed' })]);
big('only-high-ids', [...C(1, 'a'), ...C(2, 'b'), ...C(3, 'c'), ...T.update(3, { status: 'completed' })], [...T.update(3, { description: 'x' })]);
big('many-unknown', [...C(1, 'a'), ...C(2, 'b'), ...C(3, 'c'), ...C(4, 'd')], [...T.update(1, { description: 'x' }), ...T.update(2, { description: 'x' }), ...T.update(3, { description: 'x' }), ...T.update(4, { description: 'x' })]);
big('many-unknown-closed', [...C(1, 'a'), ...C(2, 'b'), ...C(3, 'c'), ...C(4, 'd'), ...[1, 2, 3, 4].flatMap(i => T.update(i, { status: 'completed' }))], [...[1, 2, 3, 4].flatMap(i => T.update(i, { description: 'x' }))]);
big('blockedby-before', [...C(1, 'a'), ...C(2, 'b'), ...T.update(2, { addBlockedBy: ['1'] }), ...T.update(1, { status: 'completed' }), ...T.update(2, { status: 'completed' })], [...T.update(2, { description: 'x' })]);
big('blockedon-before', [...C(1, 'a', { metadata: { blockedOn: 'owner' } })], [...T.update(1, { description: 'x' })]);
big('sidechain-before', [JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'sc', role: 'assistant', content: [T.use('TaskCreate', { subject: 'side' })] } }), ...C(1, 'a'), ...T.update(1, { status: 'completed' })], [...T.update(1, { description: 'x' })]);
big('parallel-creates-before', (() => { const a = T.use('TaskCreate', { subject: 'p1' }), b = T.use('TaskCreate', { subject: 'p2' }); const m = T.mid(); return [J2(m, [a, b]), T.user([T.res(b.id, 'Task #1 created successfully: p2'), T.res(a.id, 'Task #2 created successfully: p1')]), ...T.update(1, { status: 'completed' }), ...T.update(2, { status: 'completed' })]; })(), [...T.update(1, { description: 'x' }), ...T.update(2, { description: 'x' })]);
big('quoted-markers-before', [...C(1, 'a'), ...T.update(1, { status: 'completed' }), T.asst([T.text('the harness said "No tasks found" and "Task not found" and "Task #1 created successfully"')])], [...T.update(1, { description: 'x' })]);
big('bad-line-before', [...C(1, 'a'), '{"broken', ...T.update(1, { status: 'completed' })], [...T.update(1, { description: 'x' })]);
big('null-line-before', [...C(1, 'a'), 'null', ...T.update(1, { status: 'completed' })], [...T.update(1, { description: 'x' })]);
big('window-cuts-a-line', [...C(1, 'a'), ...T.update(1, { status: 'completed' })], [...T.update(1, { description: 'x' })]);
{ // far before the window: beyond what the engine scans exactly (it must defer, never guess)
  const ff = Array.from({ length: 24000 }, (_, i) => T.asst([T.text('far ' + i + ' ' + 'y'.repeat(380))]));
  const f = put([T.prompt('go'), ...C(1, 'ancient'), ...T.update(1, { status: 'completed' }), ...ff, ...T.update(1, { description: 'x' })], 'big-far');
  add('big-far-before', stop(f), W);
}

// ---- real transcripts ------------------------------------------------------------------------------------------------------------------------
const realSmall = T.realFiles({ needle: '"name":"TaskCreate"', min: 20e3, max: 1.4e6, limit: +arg('--real', 300), seed: 3 });
for (const f of realSmall) add(`real-whole-${path.basename(f, '.jsonl').slice(0, 8)}`, stop(f), W);
// windows cut from real transcripts (tasks seen only through updates, partial histories)
const winSrc = T.realFiles({ needle: '"name":"TaskUpdate"', min: 50e3, max: 8e6, limit: 80, seed: 5 });
let wn = 0;
for (const f of winSrc) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  for (let k = 0; k < 4; k++) {
    const len = 20 + Math.floor(R() * 400), start = Math.floor(R() * Math.max(1, lines.length - len));
    add(`real-window-${wn++}`, stop(put(lines.slice(start, start + len), 'win' + wn)), W);
  }
}
// large real transcripts: the tail window truncates, the backfill reads backward
const realBig = T.realFiles({ needle: '"name":"TaskCreate"', min: 1.7e6, max: 60e6, limit: +arg('--big', 80), seed: 7 });
for (const f of realBig) add(`real-big-${path.basename(f, '.jsonl').slice(0, 8)}`, stop(f), W);

// ---- fuzz (mutated hand-written histories) -----------------------------------------------------------------------------------------------------
const ALL = Object.values(H).filter(Boolean);
for (let i = 0; i < +arg('--fuzz', 200); i++) {
  const lines = [];
  for (let k = 0, n = 1 + Math.floor(R() * 4); k < n; k++) lines.push(...pick(ALL));
  if (R() < 0.3) lines.splice(Math.floor(R() * lines.length), 0, pick(['null', '5', '{"a":', '', '[]', '"x"']));
  add(`fuzz-${i}`, stop(put(lines, 'fz' + i)), W);
}
console.error(`scenarios=${scenarios.length} shared=${shared}`);
const must = new Set(scenarios.filter(s => s.mustAnswer).map(s => s.id));
runFx({ name: 'task-guard', hookFile: 'task-guard.js', check: 'task-guard', engine: ENGINE, hooks: HOOKS, scenarios, conc: +arg('--conc', 6), mayDefer: sc => !must.has(sc.id) })
  .then(() => fs.rmSync(shared, { recursive: true, force: true }));
