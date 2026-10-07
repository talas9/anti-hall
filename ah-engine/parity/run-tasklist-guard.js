#!/usr/bin/env node
// Parity of the built-in `tasklist-guard` check against hooks/tasklist-guard.js (Stop).
//   node run-tasklist-guard.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--real 120] [--big 30] [--fuzz 300] [--seed 1]
// The engine answers every Stop on which Node does not block (with the same files written: the progress directory, the
// progress and history indexes, the resume-verification marker) and defers every Stop on which Node blocks. Compared: exit
// code, stdout, stderr and the whole file tree. Families:
//   work-*   one tool use per transcript with the work threshold at 1 and no task activity: Node blocks iff the tool use
//            counts as work, so the engine must answer exactly the ones Node leaves alone (answerWhenSilent);
//   tracked-* tracked work with a fresh or stale progress file, stale in-progress tasks, resets, TodoWrite;
//   resume-*, mode-*, switch-*, root-*: the resume nudge, plan mode, switches, project-root resolution;
//   real-*   whole and cut real transcripts.
const fs = require('fs'), os = require('os'), path = require('path');
const { arg, rng, runFx } = require('./hookfx.js');
const T = require('./tasklines.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const shared = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ah-tl-shared-'));
let nf = 0;
const put = (lines, name) => { const f = path.join(shared, (name || 'f' + nf++) + '.jsonl'); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
const today = new Date().toISOString().slice(0, 10);
const PROG = `proj/.anti-hall/progress/${today}/sess-1.md`, HIST = `proj/.anti-hall/history/${today}/sess-1.md`;
const stop = (tp, extra) => Object.assign({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '$PROJ', transcript_path: tp, stop_hook_active: false }, extra || {});
const scenarios = [];
const add = (id, payload, world, more) => scenarios.push(Object.assign({ id, world, steps: [{ payload }] }, more || {}));
const REPO = { gitdirs: ['proj'] };
const T1 = { files: { 'home/.anti-hall/settings.json': JSON.stringify({ guards: { tasklistWorkThreshold: 1 } }) }, gitdirs: ['proj'] };
const old = new Date(Date.now() - 40 * 864e5);
const touchOld = rel => W => fs.utimesSync(path.join(W, rel), old, old);
const withProgress = (extra, fresh) => Object.assign({ gitdirs: ['proj'], files: Object.assign({ [PROG]: '# progress\n' }, (extra && extra.files) || {}) }, extra ? { dirs: extra.dirs } : {});
const edit = (fp, n) => T.asst([T.use('Edit', { file_path: fp, old_string: 'a', new_string: 'b' + (n || '') })]);
const write = fp => T.asst([T.use('Write', { file_path: fp, content: 'x' })]);
const task = (n, s) => T.create(n, { subject: s }).lines;

// ---- work family: does this tool use count? -----------------------------------------------------------------------------
const cmds = [];
try { for (const l of fs.readFileSync(arg('--cmds', '../../fpr/cmds.jsonl'), 'utf8').split('\n')) if (l) { try { cmds.push(JSON.parse(l).cmd); } catch (_) { /* skip */ } } } catch (_) { /* optional */ }
const HAND = ['git commit -am x', 'git push origin dev', 'git status', 'git log --oneline', 'git checkout -b x', 'git stash', 'git reset --hard', 'git apply p.diff', 'git am p.mbox', 'git clean -fd', 'git switch main', 'git restore a', 'git rebase main', 'git merge x', 'git cherry-pick abc',
  'sed -i s/a/b/ f', 'sed -n 1p f', 'npm install', 'npm i x', 'npm ci', 'npm test', 'pnpm add x', 'yarn install', 'yarn dev', 'pip install x', 'pip list', 'patch -p1 < x.patch', 'patched', 'rm f', 'cp a b', 'mv a b', 'tee f', 'mkdir d', 'touch f', 'make', 'chmod +x f',
  'ls', 'cat f', 'echo hi', 'echo hi > f', 'echo hi >> f', 'echo hi 2>/dev/null', 'cmd 2>&1', 'cmd >&2', 'cmd &> f', 'cmd > /dev/null', 'cmd >| f', 'a && rm b', 'a; rm b', 'a | tee f', '(rm f)', 'echo $(rm f)', 'echo `rm f`', 'echo "rm f"', "echo 'git commit'", 'echo "a > b"', 'grep x f > out',
  'rm /tmp/x', 'rm -rf /private/tmp/claude-501/x/scratchpad/y', 'cat > /x/scratchpad/y <<EOF\nz\nEOF', 'cat > .anti-hall/progress/x.md <<EOF\nz\nEOF', 'echo x >> .anti-hall/history/2026/x.md', 'echo x >> .anti-hall/handovers/a/b.md', 'git commit -m x && rm /x/scratchpad/y',
  'cp /x/scratchpad/a /repo/b', 'cp /x/scratchpad/a /x/scratchpad/b', 'node devswarm.js inbox read-primary abc', 'node /a/b/devswarm.js heartbeat', 'devswarm.js send abc msg', 'node devswarm.js inbox pull && npm test', 'node devswarm.js roster > src/x.js', 'crontab -l', 'crontab -l > /tmp/x', 'crontab -l > src/x', 'crontab-parser x', '(crontab -l; echo x) | crontab -',
  'node devswarm.js send x <<EOF\na -> b\nEOF', 'node devswarm.js send x <<EOF\n$(rm f)\nEOF', 'node devswarm.js nudge x # <<EOF', 'cat <<EOF > f\nx\nEOF', 'cat <<-EOF\nx\nEOF', 'echo a<<<b', 'git commit\r\n', 'echo a\rrm b', 'echo a rm b', 'x\nrm f', 'RM f', 'Git Commit', 'sed -I x', 'sed --in-place x',
  '', ' ', 'rm', 'm', 'git', 'make -j4', 'echo "unclosed rm f', 'echo \'unclosed rm f', 'a \\" b; rm f', 'echo "a\\"b" > f'];
const WORDS = ['git commit', 'git push', 'rm', 'cp', 'mv', 'tee', 'mkdir', 'touch', 'make', 'chmod', 'sed -i', 'npm install', 'pip install', 'patch', 'git checkout', '>', '>>', '2>', '&>', '>&2', '"', "'", '\\', ';', '&&', '||', '|', '&', '(', ')', '`', '$(', '\n', '\r', ' ', '  ', '/scratchpad/', '/tmp/', '.anti-hall/progress/', '.anti-hall/history/', 'x', 'file.txt', '<<EOF', 'EOF', '#', 'devswarm.js', 'inbox read', 'crontab', '-l', '-i', '😀'];
let wi = 0;
const workScenario = (id, cmdOrTool) => {
  const lines = [T.prompt('go'), ...(typeof cmdOrTool === 'string' ? T.bash(cmdOrTool) : cmdOrTool)];
  add(id, stop(put(lines, 'w' + wi++)), T1, { answerWhenSilent: true });
};
for (const c of HAND) workScenario(`work-hand-${wi}`, c);
for (const c of cmds.slice(0, +arg('--real-cmds', 1500))) workScenario(`work-real-${wi}`, c);
for (let i = 0; i < +arg('--fuzz', 300); i++) { let c = ''; for (let k = 0, n = 1 + Math.floor(R() * 6); k < n; k++) c += pick(WORDS) + pick(['', ' ', ' ']); workScenario(`work-fuzz-${wi}`, c); }
for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) for (const fp of ['/p/src/a.js', '/p/x/scratchpad/y', '/p/.anti-hall/progress/2026-01-01/s.md', '/p/.anti-hall/history/x.md', '/p/.anti-hall/handovers/a.md', '', '/tmp/x', '/private/tmp/y', '/p/.anti-hall/other/z', 'rel.js', '.anti-hall/progress/x.md', '/p/scratchpad/y']) {
  workScenario(`work-tool-${tool}-${wi}`, [T.asst([T.use(tool, tool === 'NotebookEdit' ? { notebook_path: fp } : { file_path: fp })])]);
  if (tool !== 'NotebookEdit') workScenario(`work-tool-fp-${tool}-${wi}`, [T.asst([T.use(tool, { file_path: fp })])]);
}
for (const [id, blocks] of [['agent', [T.use('Agent', { prompt: 'x', description: 'd' })]], ['task', [T.use('Task', {})]], ['cron', [T.use('CronCreate', { x: 1 })]], ['read', [T.use('Read', { file_path: '/p/a' })]], ['grep', [T.use('Grep', { pattern: 'x' })]], ['bash-nocmd', [T.use('Bash', {})]], ['bash-num', [T.use('Bash', { command: 5 })]], ['edit-noinput', [{ type: 'tool_use', id: 'e1', name: 'Edit' }]], ['edit-numfp', [T.use('Edit', { file_path: 5 })]], ['two-edits', [T.use('Edit', { file_path: '/p/a' }), T.use('Write', { file_path: '/p/b' })]], ['name-lower', [T.use('edit', { file_path: '/p/a' })]]])
  workScenario(`work-shape-${id}`, [T.asst(blocks)]);
// timestamps: a counted action with and without a usable timestamp
workScenario('work-nots', [JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [T.use('Edit', { file_path: '/p/a.js' })] } })]);
workScenario('work-badts', [JSON.stringify({ type: 'assistant', timestamp: 'not a date', message: { id: 'm1', role: 'assistant', content: [T.use('Edit', { file_path: '/p/a.js' })] } })]);
workScenario('work-oddts', [JSON.stringify({ type: 'assistant', timestamp: 'Oct 5 2026 10:00', message: { id: 'm1', role: 'assistant', content: [T.use('Edit', { file_path: '/p/a.js' })] } })]);
workScenario('work-sidechain', [JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: T.ts(1), message: { id: 'm1', role: 'assistant', content: [T.use('Edit', { file_path: '/p/a.js' })] } })]);
workScenario('work-null-line', ['null', ...[T.asst([T.use('Edit', { file_path: '/p/a.js' })])]]);
add('work-null-todo', stop(put([T.prompt('go'), T.asst([T.use('TodoWrite', { todos: [null] })]), ...[T.asst([T.use('Edit', { file_path: '/p/a.js' })])]], 'ntd')), T1, { answerWhenSilent: true });
workScenario('work-broken-line', ['{"type":"assistant","message":{"content":[{"type":"tool_use"', T.asst([T.use('Edit', { file_path: '/p/a.js' })])]);

// ---- tracked work: threshold 3, task activity and progress freshness ----------------------------------------------------------------
const W3 = lines => put([T.prompt('go'), ...lines]);
const works = n => Array.from({ length: n }, (_, i) => edit('/p/src/f' + i + '.js', i));
const FRESH = { gitdirs: ['proj'], files: { [PROG]: '# progress\n' } };
const STALE = { gitdirs: ['proj'], files: { [PROG]: '# progress\n' } };
const staleStep = { before: touchOld(PROG) };
const track = (id, lines, world, opts) => {
  const o = opts || {};
  scenarios.push({ id, world, steps: [Object.assign({ payload: stop(W3(lines)) }, o.stale ? staleStep : {})], answerWhenSilent: !!o.answer });
};
for (const n of [0, 1, 2, 3, 4, 9]) track(`tracked-notasks-n${n}-fresh`, works(n), FRESH, { answer: n < 3 });
for (const n of [3, 4]) {
  track(`tracked-tasks-n${n}-fresh`, [...task(1, 'a'), ...works(n)], FRESH, { answer: true });
  track(`tracked-tasks-n${n}-stale`, [...task(1, 'a'), ...works(n)], STALE, { stale: true });
  track(`tracked-tasks-n${n}-missing`, [...task(1, 'a'), ...works(n)], REPO);
  track(`tracked-todowrite-n${n}-fresh`, [...T.todo([{ content: 'a', status: 'pending' }]), ...works(n)], FRESH, { answer: true });
  track(`tracked-update-only-n${n}-fresh`, [...T.update(4, { status: 'in_progress' }), ...works(n)], FRESH, { answer: true });
  track(`tracked-taskget-n${n}`, [...T.get(1, true), ...works(n)], FRESH);
  track(`tracked-tasks-n${n}-progress-is-dir`, [...task(1, 'a'), ...works(n)], { gitdirs: ['proj'], dirs: [PROG] });
  track(`tracked-tasks-n${n}-progress-symlink`, [...task(1, 'a'), ...works(n)], { gitdirs: ['proj'], files: { 'elsewhere.md': 'x' }, links: { [PROG]: '$W/elsewhere.md' } });
  track(`tracked-tasks-n${n}-history-file`, [...task(1, 'a'), ...works(n)], { gitdirs: ['proj'], files: { [PROG]: 'p', [HIST]: '- x\n' } }, { answer: true });
  track(`tracked-tasks-n${n}-history-only`, [...task(1, 'a'), ...works(n)], { gitdirs: ['proj'], files: { [HIST]: '- x\n' } });
  track(`tracked-tasks-n${n}-index-present`, [...task(1, 'a'), ...works(n)], { gitdirs: ['proj'], files: { [PROG]: 'p', 'proj/.anti-hall/progress/INDEX.md': '- sess-1 already\n' } }, { answer: true });
  
}
track('tracked-inprogress-one', [...task(1, 'a'), ...T.update(1, { status: 'in_progress' }), ...works(3)], FRESH, { answer: true });
track('tracked-inprogress-two-agentscan', [...task(1, 'a'), ...task(2, 'b'), ...T.update(1, { status: 'in_progress' }), ...T.update(2, { status: 'in_progress' }), ...works(3)], FRESH);
track('tracked-inprogress-two-below-threshold', [...task(1, 'a'), ...task(2, 'b'), ...T.update(1, { status: 'in_progress' }), ...T.update(2, { status: 'in_progress' }), ...works(2)], FRESH, { answer: true });
track('tracked-inprogress-two-low', [...task(1, 'a'), ...task(2, 'b'), ...T.update(1, { status: 'in_progress', priority: 'P2' }), ...T.update(2, { status: 'in_progress', metadata: { priority: 'low' } }), ...works(3)], FRESH, { answer: true });
track('tracked-inprogress-two-mixed', [...task(1, 'a'), ...task(2, 'b'), ...T.update(1, { status: 'in_progress', priority: 'P2' }), ...T.update(2, { status: 'in_progress', priority: 'P1' }), ...works(3)], FRESH, { answer: true });
track('tracked-completed', [...task(1, 'a'), ...T.update(1, { status: 'completed' }), ...works(4)], FRESH, { answer: true });
track('tracked-reset-notfound', [...task(1, 'a'), ...T.get(1, false), ...works(3)], FRESH);
track('tracked-restart', [...task(1, 'a'), ...task(2, 'b'), ...task(1, 'again'), ...works(3)], FRESH, { answer: true });
track('tracked-status-weird', [...task(1, 'a'), T.asst([T.use('TaskUpdate', { taskId: '1', status: 5 })]), ...works(3)], FRESH);
track('tracked-activity-only-in-wide-window', [...Array.from({ length: 6000 }, (_, i) => T.asst([T.text('filler ' + i + ' ' + 'x'.repeat(300))])), ...works(3)], FRESH);
{
  const filler = Array.from({ length: 2500 }, (_, i) => T.asst([T.text('filler ' + i + ' ' + 'x'.repeat(400))]));
  const f = put([T.prompt('go'), ...task(1, 'early'), ...task(2, 'early2'), ...filler, ...T.update(1, { status: 'in_progress' }), ...works(3)], 'wide1');
  add('tracked-truncated-backfill', stop(f), FRESH, { answerWhenSilent: true });
  const g = put([T.prompt('go'), ...task(1, 'early'), ...filler, ...works(3)], 'wide2');
  add('tracked-truncated-wide-activity', stop(g), FRESH, { answerWhenSilent: true });
  const h = put([T.prompt('go'), ...filler, ...works(3)], 'wide3');
  add('tracked-truncated-no-activity', stop(h), FRESH);
  const k = put([T.prompt('go'), ...task(1, 'early'), ...filler, ...T.update(1, { description: 'd' }), ...works(3)], 'wide4');
  add('tracked-truncated-unknown-task', stop(k), FRESH, { answerWhenSilent: true });
}
// progress freshness against the work time (timestamps are in the past; the file time decides)
track('fresh-file-newer-than-work', [...task(1, 'a'), ...works(3)], FRESH, { answer: true });
track('fresh-file-older-than-work', [...task(1, 'a'), ...works(3)], STALE, { stale: true });
{ // work timestamps in the future of the file: stale
  const fut = new Date(Date.now() + 864e5).toISOString();
  const lines = [T.prompt('go'), ...task(1, 'a'), ...[1, 2, 3].map(i => JSON.stringify({ type: 'assistant', timestamp: fut, message: { id: 'm' + i, role: 'assistant', content: [T.use('Edit', { file_path: '/p/f' + i })] } }))];
  add('fresh-work-in-future', stop(put(lines, 'fut')), FRESH);
  const nots = [T.prompt('go'), ...task(1, 'a'), ...[1, 2, 3].map(i => JSON.stringify({ type: 'assistant', message: { id: 'n' + i, role: 'assistant', content: [T.use('Edit', { file_path: '/p/f' + i })] } }))];
  add('fresh-no-work-ts-fresh-file', stop(put(nots, 'nots')), FRESH, { answerWhenSilent: true });
  scenarios.push({ id: 'fresh-no-work-ts-stale-file', world: STALE, steps: [Object.assign({ payload: stop(put(nots, 'nots2')) }, staleStep)] });
  scenarios.push({ id: 'fresh-ms-setting-small', world: { gitdirs: ['proj'], files: { [PROG]: 'p', 'home/.anti-hall/settings.json': JSON.stringify({ guards: { progressFreshMs: 1 } }) } }, steps: [{ payload: stop(put(nots, 'nots3')), before: W => { const t = new Date(Date.now() - 5000); fs.utimesSync(path.join(W, PROG), t, t); } }] });
  scenarios.push({ id: 'fresh-ms-setting-large', world: { gitdirs: ['proj'], files: { [PROG]: 'p', 'home/.anti-hall/settings.json': JSON.stringify({ guards: { progressFreshMs: 1e12 } }) } }, steps: [{ payload: stop(put(nots, 'nots4')), before: W => fs.utimesSync(path.join(W, PROG), old, old) }], answerWhenSilent: true });
}

// a command or tool call that writes the progress file counts as a fresh write (FIX 6); one that only reads it does not.
// The transcript lives in the world (its text names the world's own progress path through `$PROJ`).
{
  const PA = '$PROJ/.anti-hall/progress/' + today + '/sess-1.md';
  const staleWorld = lines => ({ gitdirs: ['proj'], files: { [PROG]: '# progress\n', 't.jsonl': lines.join('\n') + '\n' } });
  const cases = [['redirect-append', () => T.bash(`echo done >> ${PA}`), true], ['redirect-truncate', () => T.bash(`echo done > ${PA}`), true], ['redirect-dq', () => T.bash(`echo done > "${PA}"`), true], ['redirect-sq', () => T.bash(`echo done > '${PA}'`), true], ['tee', () => T.bash(`echo done | tee ${PA}`), true], ['tee-flag', () => T.bash(`echo done | tee -a ${PA}`), true],
    ['cp', () => T.bash(`cp /x/a ${PA}`), true], ['mv', () => T.bash(`mv /x/a ${PA}`), true], ['heredoc', () => T.bash(`cat >> ${PA} <<EOF\nx\nEOF`), true], ['write-tool', () => [write(PA)], true], ['edit-tool', () => [edit(PA)], true],
    ['read-only', () => T.bash(`cat ${PA} >> /elsewhere/log`), false], ['other-file', () => T.bash(`echo done >> /elsewhere/log`), false], ['fd-dup', () => T.bash(`cmd 2>&1 ${PA}`), false], ['quoted-text', () => T.bash(`echo "write > ${PA}"`), false], ['two-redirects', () => T.bash(`echo a > /x/y; echo b > ${PA}`), false], ['other-session', () => T.bash(`echo done >> $PROJ/.anti-hall/progress/${today}/sess-2.md`), false], ['other-day', () => T.bash(`echo done >> $PROJ/.anti-hall/progress/2020-01-01/sess-1.md`), false]];
  for (const [id, tail, answer] of cases) {
    const lines = [T.prompt('go'), ...task(1, 'a'), ...works(3), ...tail()];
    scenarios.push({ id: `fresh-write-${id}`, world: staleWorld(lines), answerWhenSilent: answer, steps: [Object.assign({ payload: stop('$W/t.jsonl') }, staleStep)] });
  }
}
// the grace boundary: work exactly 1000 ms newer than the file still counts as covered, 1 ms more does not
for (const [id, deltaMs, covered] of [['equal', 1000, true], ['plus1', 1001, false], ['minus1', 999, true], ['zero', 0, true]]) {
  const workTs = Date.UTC(2026, 9, 6, 8, 0, 30, 0);
  const mk = i => JSON.stringify({ type: 'assistant', timestamp: new Date(workTs).toISOString(), message: { id: 'b' + i, role: 'assistant', content: [T.use('Edit', { file_path: '/p/b' + i })] } });
  const lines = [T.prompt('go'), ...task(1, 'a'), ...[1, 2, 3].map(mk)];
  scenarios.push({ id: `fresh-boundary-${id}`, world: FRESH, answerWhenSilent: covered, steps: [{ payload: stop(put(lines, 'bd' + id)), before: W => { const t = new Date(workTs - deltaMs); fs.utimesSync(path.join(W, PROG), t, t); } }] });
}

// ---- cwd, root, session and payload shapes ---------------------------------------------------------------------------------------------------------
const TR = put([T.prompt('go'), ...task(1, 'a'), ...works(3)], 'shape');
for (const [id, p, w, ans] of [
  ['cwd-missing', stop(TR, { cwd: undefined }), FRESH, true], ['cwd-null', stop(TR, { cwd: null }), FRESH, true], ['cwd-num', stop(TR, { cwd: 5 }), FRESH, true], ['cwd-empty', stop(TR, { cwd: '' }), FRESH, true],
  ['cwd-nonexistent', stop(TR, { cwd: '$W/nowhere' }), FRESH, true], ['cwd-file', stop(TR, { cwd: '$W/afile' }), { files: { afile: 'x' }, gitdirs: ['proj'] }, true], ['cwd-subdir', stop(TR, { cwd: '$PROJ/src' }), { gitdirs: ['proj'], dirs: ['proj/src'], files: { [PROG]: 'p' } }, true],
  ['cwd-no-git', stop(TR, { cwd: '$W/plain' }), { dirs: ['plain'], files: { ['plain/.anti-hall/progress/' + today + '/sess-1.md']: 'p' } }, true], ['cwd-relative', stop(TR, { cwd: 'proj' }), FRESH, false], ['cwd-trailing-slash', stop(TR, { cwd: '$PROJ/' }), FRESH, true],
  ['cwd-nested-repo', stop(TR, { cwd: '$PROJ/inner' }), { gitdirs: ['proj', 'proj/inner'], files: { ['proj/.anti-hall/progress/' + today + '/sess-1.md']: 'p' } }, false],
  ['cwd-gitfile-worktree', stop(TR, { cwd: '$W/wt' }), { dirs: ['store/wt', 'wt'], files: { 'wt/.git': 'gitdir: $W/store/wt\n', 'store/wt/commondir': '../..\n' } }, false],
  ['cwd-gitfile-plain', stop(TR, { cwd: '$W/wt' }), { dirs: ['store/wt', 'wt'], files: { 'wt/.git': 'gitdir: $W/store/wt\n', ['wt/.anti-hall/progress/' + today + '/sess-1.md']: 'p' } }, true],
  ['cwd-home-repo', stop(TR, { cwd: '$HOME/sub' }), { gitdirs: ['home'], dirs: ['home/sub'] }, false],
  ['session-missing', stop(TR, { session_id: undefined }), { gitdirs: ['proj'], files: { ['proj/.anti-hall/progress/' + today + '/unknown-session.md']: 'p' } }, true],
  ['session-weird', stop(TR, { session_id: 'a/b c' }), { gitdirs: ['proj'], files: { ['proj/.anti-hall/progress/' + today + '/abc.md']: 'p' } }, true],
  ['session-number', stop(TR, { session_id: 7 }), { gitdirs: ['proj'], files: { ['proj/.anti-hall/progress/' + today + '/7.md']: 'p' } }, true],
  ['no-transcript', stop(undefined), FRESH, true], ['empty-transcript', stop(''), FRESH, true], ['num-transcript', stop(5), FRESH, true], ['missing-transcript', stop('$W/none.jsonl'), FRESH, true],
  ['null-payload', null, FRESH, true], ['array-payload', [1], FRESH, true],
  ['hook-active', stop(TR, { stop_hook_active: true }), FRESH, true], ['codex-turn', stop(TR, { turn_id: 't1', model: 'm' }), FRESH, true], ['codex-path', stop('$W/.codex/sessions/rollout-1.jsonl'), FRESH, true],
]) add(`shape-${id}`, p, w, ans ? { answerWhenSilent: true } : {});
add('shape-codex-two-inprogress', stop(put([T.prompt('go'), ...task(1, 'a'), ...task(2, 'b'), ...T.update(1, { status: 'in_progress' }), ...T.update(2, { status: 'in_progress' }), ...works(3)], 'cx'), { turn_id: 't1', model: 'm' }), FRESH, { answerWhenSilent: true });

// ---- modes, switches, resume verification -----------------------------------------------------------------------------------------------------------------------------
add('mode-plan', stop(TR, { permission_mode: 'plan' }), FRESH);
add('mode-plan-caps', stop(TR, { permission_mode: 'PLAN' }), FRESH);
for (const m of ['default', 'acceptEdits', '', null, 5, ['plan'], 'plan ']) add(`mode-other-${JSON.stringify(m)}`, stop(TR, { permission_mode: m }), FRESH, { answerWhenSilent: true });
add('mode-plan-no-transcript', stop(undefined, { permission_mode: 'plan' }), FRESH);
add('switch-off', stop(put([T.prompt('go'), ...works(5)], 'sw1')), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ guards: { tasklistGuard: false } }) } });
scenarios.push({ id: 'switch-option-off', world: REPO, steps: [{ payload: stop(put([T.prompt('go'), ...works(5)], 'sw2')), env: { CLAUDE_PLUGIN_OPTION_GUARDS_TASKLIST_GUARD: 'false' } }] });
scenarios.push({ id: 'judge-child', world: REPO, steps: [{ payload: stop(put([T.prompt('go'), ...works(5)], 'sw3')), env: { ANTIHALL_JUDGE_CHILD: '1' } }] });
add('skip', stop(put([T.prompt('go'), ...works(5)], 'sw4')), { gitdirs: ['proj'], files: { 'home/.anti-hall/skip.json': JSON.stringify({ 'tasklist-guard': Date.now() + 3.6e6 }) } });
add('skip-all', stop(put([T.prompt('go'), ...works(5)], 'sw5')), { gitdirs: ['proj'], files: { 'home/.anti-hall/skip.json': JSON.stringify({ all: Date.now() + 3.6e6 }) } });
for (const [id, v] of [['2', 2], ['5', 5], ['str', ' 4 '], ['zero', 0], ['garbage', 'x'], ['frac', 3.5], ['huge', 1e9]]) add(`threshold-${id}`, stop(put([T.prompt('go'), ...works(4)], 'th' + id)), { gitdirs: ['proj'], files: { 'home/.anti-hall/settings.json': JSON.stringify({ guards: { tasklistWorkThreshold: v } }) } }, { answerWhenSilent: id !== '2' && id !== 'zero' && id !== 'garbage' });
scenarios.push({ id: 'threshold-env', world: REPO, steps: [{ payload: stop(put([T.prompt('go'), ...works(4)], 'the')), env: { ANTIHALL_TASKLIST_WORK_THRESHOLD: '9' } }], answerWhenSilent: true });
// resume verification
const HOFF = { files: { 'handover.md': '# handover\n' } };
const marker = f => JSON.stringify({ handoverFile: f });
const resumeWorld = (hbody, extra) => ({ gitdirs: ['proj'], files: Object.assign({ 'ho/HANDOVER.md': hbody, 'home/.anti-hall/handover-resume-state-sess-1.json': marker('$W/ho/HANDOVER.md') }, extra || {}) });
const TRW = put([T.prompt('go'), ...works(3)], 'resume');
add('resume-nudge', stop(TRW), resumeWorld('# h\n'));
add('resume-verified', stop(TRW), resumeWorld('# h\nresume-verified: 2026 -- ok\n'), { answerWhenSilent: true });
add('resume-already-nudged', stop(TRW), resumeWorld('# h\n', { 'home/.anti-hall/resume-verify-nudged-sess-1.json': '{}' }));
add('resume-below-threshold', stop(put([T.prompt('go'), ...works(2)], 'resume2')), resumeWorld('# h\n'), { answerWhenSilent: true });
add('resume-missing-handover', stop(TRW), { gitdirs: ['proj'], files: { 'home/.anti-hall/handover-resume-state-sess-1.json': marker('$W/ho/none.md') } });
add('resume-relative-handover', stop(TRW), { gitdirs: ['proj'], files: { 'home/.anti-hall/handover-resume-state-sess-1.json': marker('ho/HANDOVER.md'), 'ho/HANDOVER.md': '# h\n' } });
add('resume-bad-marker', stop(TRW), { gitdirs: ['proj'], files: { 'home/.anti-hall/handover-resume-state-sess-1.json': '{nope' } });
add('resume-marker-no-file', stop(TRW), { gitdirs: ['proj'], files: { 'home/.anti-hall/handover-resume-state-sess-1.json': '{}' } });
add('resume-marker-empty-file', stop(TRW), { gitdirs: ['proj'], files: { 'home/.anti-hall/handover-resume-state-sess-1.json': marker('') } });
add('resume-marker-file-number', stop(TRW), { gitdirs: ['proj'], files: { 'home/.anti-hall/handover-resume-state-sess-1.json': JSON.stringify({ handoverFile: 5 }) } });
add('resume-path-quotes', stop(TRW), { gitdirs: ['proj'], files: { 'ho/a "q" \\ b.md': '# h\n', 'home/.anti-hall/handover-resume-state-sess-1.json': JSON.stringify({ handoverFile: '$W/ho/a "q" \\ b.md' }) } });
add('resume-path-unicode', stop(TRW), { gitdirs: ['proj'], files: { 'ho/é日本 😀.md': '# h\n', 'home/.anti-hall/handover-resume-state-sess-1.json': JSON.stringify({ handoverFile: '$W/ho/é日本 😀.md' }) } });
add('resume-path-newline', stop(TRW), { gitdirs: ['proj'], files: { 'ho/a\nb.md': '# h\n', 'home/.anti-hall/handover-resume-state-sess-1.json': JSON.stringify({ handoverFile: '$W/ho/a\nb.md' }) } });
add('resume-path-long', stop(TRW), { gitdirs: ['proj'], files: { ['ho/' + 'x'.repeat(200) + '.md']: '# h\n', 'home/.anti-hall/handover-resume-state-sess-1.json': JSON.stringify({ handoverFile: '$W/ho/' + 'x'.repeat(200) + '.md' }) } });
add('resume-nudged-is-dir', stop(TRW), resumeWorld('# h\n', {}), {});
scenarios.push({ id: 'resume-twice', world: resumeWorld('# h\n'), steps: [{ payload: stop(TRW) }, { payload: stop(TRW) }, { payload: stop(TRW) }] });

// ---- sequences: index idempotence across Stops ------------------------------------------------------------------------------------------------------------------------------
scenarios.push({ id: 'seq-index-idempotent', world: FRESH, answerWhenSilent: true, steps: [{ payload: stop(W3([...task(1, 'a'), ...works(3)])) }, { payload: stop(W3([...task(1, 'a'), ...works(3)])) }, { payload: stop(W3([...task(1, 'a'), ...works(2)])) }] });
scenarios.push({ id: 'seq-two-sessions', world: { gitdirs: ['proj'], files: { [PROG]: 'p', [`proj/.anti-hall/progress/${today}/sess-2.md`]: 'p' } }, answerWhenSilent: true, steps: [{ payload: stop(W3([...task(1, 'a'), ...works(3)])) }, { payload: stop(W3([...task(1, 'a'), ...works(3)]), { session_id: 'sess-2' }) }] });

// ---- real transcripts --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const realSmall = T.realFiles({ needle: '"name":"Edit"', min: 20e3, max: 450e3, limit: +arg('--real', 120), seed: 21 });
for (const f of realSmall) { add(`real-fresh-${path.basename(f, '.jsonl').slice(0, 8)}`, stop(f), FRESH, { answerWhenSilent: true }); add(`real-nofile-${path.basename(f, '.jsonl').slice(0, 8)}`, stop(f), REPO); }
const realBig = T.realFiles({ needle: '"name":"TaskCreate"', min: 600e3, max: 60e6, limit: +arg('--big', 30), seed: 23 });
for (const f of realBig) { add(`real-big-fresh-${path.basename(f, '.jsonl').slice(0, 8)}`, stop(f), FRESH, { answerWhenSilent: true }); add(`real-big-nofile-${path.basename(f, '.jsonl').slice(0, 8)}`, stop(f), REPO); }
console.error(`scenarios=${scenarios.length} shared=${shared}`);
runFx({ name: 'tasklist-guard', hookFile: 'tasklist-guard.js', check: 'tasklist-guard', engine: ENGINE, hooks: HOOKS, scenarios, conc: +arg('--conc', 6) }).then(() => { if (!process.argv.includes('--keep')) fs.rmSync(shared, { recursive: true, force: true }); });
