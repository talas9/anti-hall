// Corpus for precompact-snapshot (PreCompact): payload shapes, repositories, transcripts, numbering, handovers.
const fs = require('fs'), path = require('path');
exports.scenarios = (lib) => {
  const out = [];
  const add = (id, setup, extra) => out.push(Object.assign({ id, setup }, extra || {}));
  const SID = 'sess-1';
  const day = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
  const user = (t, extra) => JSON.stringify(Object.assign({ type: 'user', timestamp: '2026-10-07T10:00:00.000Z', message: { role: 'user', content: t } }, extra || {}));
  const asst = (...items) => JSON.stringify({ type: 'assistant', message: { content: items } });
  const toolUse = (name, input, id) => ({ type: 'tool_use', name, input, id });
  const toolRes = (id, content) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  // standard sandbox: repo with a commit, a transcript file; build -> payload
  const mk = (o) => (root) => {
    o = o || {};
    const repo = o.noRepo ? (fs.mkdirSync(path.join(root, 'plain'), { recursive: true }), path.join(root, 'plain')) : lib.repo(root, 'repo', o.files);
    const tdir = path.join(root, 'home/.claude/projects', enc(repo)); fs.mkdirSync(tdir, { recursive: true });
    const tp = path.join(tdir, SID + '.jsonl');
    const lines = typeof o.lines === 'function' ? o.lines(root, repo) : o.lines;
    if (lines !== undefined) fs.writeFileSync(tp, Array.isArray(lines) ? lines.join('\n') + (o.noNl ? '' : '\n') : lines);
    if (o.before) o.before(root, repo);
    const p = Object.assign({ hook_event_name: 'PreCompact', session_id: SID, cwd: repo, transcript_path: tp, trigger: 'auto' }, typeof o.payload === 'function' ? o.payload(root, repo, tp) : o.payload || {});
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    return { payload: p, env: o.env || {} };
  };
  const hdir = (repo, sid, date) => path.join(repo, '.anti-hall/handovers', date || day(), sid || SID);
  const hand = (repo, sid, name, content, ageSec, date) => lib.write(hdir(repo, sid, date), name, content === undefined ? '# h\n' : content, ageSec);

  // ---- basics
  add('basic-no-transcript', mk({}));
  add('basic-trigger-manual', mk({ payload: { trigger: 'manual' } }));
  for (const t of ['auto', 'manual', 'x', '', null, 5, undefined]) add('trigger-' + JSON.stringify(t), mk({ payload: { trigger: t } }));
  for (const ci of ['keep it', '  padded  ', '', '   ', 5, null, 'multi\nline  text', 'café \u{1F600}']) add('custom-' + JSON.stringify(ci), mk({ payload: { custom_instructions: ci } }));
  for (const [id, sid] of [['num', 7], ['zero', 0], ['empty', ''], ['array', ['a', 'b']], ['empty-array', []], ['object', { a: 1 }], ['slash', 'a/b..c'], ['unicode', 'sess-é\u{1F600}'], ['spaces', 'a b c'], ['null', null], ['missing', undefined], ['true', true], ['long', 's'.repeat(300)], ['dash-underscore', 'a_b-c.d']]) add('sid-' + id, mk({ payload: { session_id: sid } }));
  for (const [id, v] of [['null', null], ['zero', 0], ['empty', ''], ['false', false], ['str', 'x'], ['obj', {}]]) { add('agent_id-' + id, mk({ payload: { agent_id: v } })); add('agent_type-' + id, mk({ payload: { agent_type: v } })); }
  add('skip-own', (root) => { lib.write(root, 'home/.anti-hall/skip.json', JSON.stringify({ 'precompact-snapshot': 4102444800000 })); return mk({})(root); });
  add('skip-all', (root) => { lib.write(root, 'home/.anti-hall/skip.json', JSON.stringify({ all: 4102444800000 })); return mk({})(root); });
  add('skip-expired', (root) => { lib.write(root, 'home/.anti-hall/skip.json', JSON.stringify({ 'precompact-snapshot': 1000 })); return mk({})(root); });
  add('switch-off-settings', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ maintenance: { precompactSnapshot: false } })); return mk({})(root); });
  add('switch-off-settings-str', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ maintenance: { precompactSnapshot: 'off' } })); return mk({})(root); });
  add('switch-off-plugin-option', mk({}), { env: { CLAUDE_PLUGIN_OPTION_MAINTENANCE_PRECOMPACT_SNAPSHOT: 'false' } });
  add('switch-plugin-option-default', mk({}), { env: { CLAUDE_PLUGIN_OPTION_MAINTENANCE_PRECOMPACT_SNAPSHOT: 'true' } });
  add('judge-child-env-ignored', mk({}), { env: { ANTIHALL_JUDGE_CHILD: '1' } });
  // ---- payload shapes
  add('no-cwd', mk({ payload: { cwd: undefined } }));
  add('cwd-empty', mk({ payload: { cwd: '' } }));
  add('cwd-num', mk({ payload: { cwd: 5 } }));
  add('cwd-relative', mk({ payload: { cwd: 'rel/path' } }));
  add('cwd-missing-dir', mk({ payload: (r) => ({ cwd: path.join(r, 'nope') }) }));
  add('cwd-dotdot', mk({ payload: (r, repo) => ({ cwd: path.join(repo, 'x', '..') }) , before: (r, repo) => fs.mkdirSync(path.join(repo, 'x')) }));
  add('payload-array', () => ({ payload: '[1]' }));
  add('payload-null', () => ({ payload: 'null' }));
  add('payload-malformed', () => ({ payload: '{"a":' }));
  add('payload-empty', () => ({ payload: '' }));
  add('transcript-missing', mk({ payload: { transcript_path: undefined } }));
  add('transcript-relative', mk({ payload: { transcript_path: 'rel/t.jsonl' } }));
  add('transcript-num', mk({ payload: { transcript_path: 5 } }));
  add('transcript-nofile', mk({ payload: (r, repo, tp) => ({ transcript_path: tp + '.none' }) }));
  add('transcript-dir', mk({ payload: (r, repo, tp) => ({ transcript_path: path.dirname(tp) }) }));
  add('transcript-empty-file', mk({ lines: '' }));
  // ---- repository shapes
  add('repo-clean', mk({}));
  add('repo-dirty-mix', mk({ before: (r, repo) => { lib.write(repo, 'a.txt', 'changed\n'); lib.write(repo, 'new.txt', 'n\n'); lib.write(repo, 'staged.txt', 's\n'); lib.git(repo, 'add', 'staged.txt'); } }));
  add('repo-dirty-70', mk({ before: (r, repo) => { for (let i = 0; i < 70; i++) lib.write(repo, `d/f${String(i).padStart(2, '0')}.txt`, 'x'); } }));
  add('repo-dirty-exact-50', mk({ before: (r, repo) => { for (let i = 0; i < 50; i++) lib.write(repo, `f${String(i).padStart(2, '0')}.txt`, 'x'); } }));
  add('repo-dirty-51', mk({ before: (r, repo) => { for (let i = 0; i < 51; i++) lib.write(repo, `f${String(i).padStart(2, '0')}.txt`, 'x'); } }));
  add('repo-unicode-names', mk({ before: (r, repo) => { lib.write(repo, 'café.txt', 'x'); lib.write(repo, 'sp ace.txt', 'x'); lib.write(repo, 'tab\tname.txt', 'x'); lib.write(repo, '\u{1F600}.txt', 'x'); } }));
  add('repo-renamed-deleted', mk({ before: (r, repo) => { lib.git(repo, 'mv', 'a.txt', 'b.txt'); lib.write(repo, 'gone.txt', 'g'); lib.git(repo, 'add', 'gone.txt'); lib.git(repo, 'commit', '-q', '-m', 'g'); fs.rmSync(path.join(repo, 'gone.txt')); } }));
  add('repo-detached', mk({ before: (r, repo) => { lib.git(repo, 'checkout', '-q', '--detach'); } }));
  add('repo-no-commits', (root) => { const d = path.join(root, 'repo'); fs.mkdirSync(d, { recursive: true }); lib.git(d, 'init', '-q', '-b', 'main'); lib.write(d, 'x.txt', 'x'); const tdir = path.join(root, 'home/.claude/projects', enc(d)); fs.mkdirSync(tdir, { recursive: true }); return { payload: { hook_event_name: 'PreCompact', session_id: SID, cwd: d, trigger: 'auto' } }; });
  add('repo-upstream-ahead', mk({ before: (r, repo) => { const bare = path.join(r, 'bare.git'); lib.sh('git', ['init', '-q', '--bare', bare]); lib.git(repo, 'remote', 'add', 'origin', bare); lib.git(repo, 'push', '-q', '-u', 'origin', 'main'); lib.write(repo, 'more.txt', 'm'); lib.git(repo, 'add', '-A'); lib.git(repo, 'commit', '-q', '-m', 'ahead'); } }));
  add('repo-long-subject', (root) => mk({ before: (r, repo) => { lib.write(repo, 'z.txt', 'z'); lib.git(repo, 'add', '-A'); lib.git(repo, 'commit', '-q', '-m', 'subject with  double  spaces and é\u{1F600} unicode ' + 'x'.repeat(300)); } })(root));
  add('cwd-subdir', mk({ before: (r, repo) => fs.mkdirSync(path.join(repo, 'sub')), payload: (r, repo) => ({ cwd: path.join(repo, 'sub') }) }));
  add('cwd-not-git', mk({ noRepo: true }));
  add('cwd-in-handovers-dir', mk({ before: (r, repo) => fs.mkdirSync(path.join(repo, '.anti-hall/handovers'), { recursive: true }), payload: (r, repo) => ({ cwd: path.join(repo, '.anti-hall/handovers') }) }));
  add('cwd-symlink', mk({ before: (r, repo) => fs.symlinkSync(repo, path.join(r, 'lnk')), payload: (r) => ({ cwd: path.join(r, 'lnk') }) }));
  add('cwd-is-home-repo', (root) => { const home = path.join(root, 'home'); lib.git(home, 'init', '-q', '-b', 'main'); lib.write(home, 'dot.txt', 'd'); lib.git(home, 'add', 'dot.txt'); lib.git(home, 'commit', '-q', '-m', 'dots'); fs.mkdirSync(path.join(home, 'proj'), { recursive: true }); return { payload: { hook_event_name: 'PreCompact', session_id: SID, cwd: home, trigger: 'auto' } }; });
  add('cwd-in-home-repo-subdir', (root) => { const home = path.join(root, 'home'); lib.git(home, 'init', '-q', '-b', 'main'); lib.write(home, 'dot.txt', 'd'); lib.git(home, 'add', 'dot.txt'); lib.git(home, 'commit', '-q', '-m', 'dots'); fs.mkdirSync(path.join(home, 'proj'), { recursive: true }); return { payload: { hook_event_name: 'PreCompact', session_id: SID, cwd: path.join(home, 'proj'), trigger: 'auto' } }; });
  add('cwd-linked-worktree', mk({ before: (r, repo) => { lib.git(repo, 'worktree', 'add', '-q', path.join(r, 'wt'), '-b', 'feat'); }, payload: (r) => ({ cwd: path.join(r, 'wt') }) }));
  add('cwd-submodule', (root) => { const repo = lib.repo(root, 'repo', {}); const sub = lib.repo(root, 'subsrc', { 's.txt': 's' }); lib.sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'], { cwd: repo, env: Object.assign({}, process.env, lib.GITENV) }); lib.git(repo, 'commit', '-q', '-m', 'sub'); return { payload: { hook_event_name: 'PreCompact', session_id: SID, cwd: path.join(repo, 'vendor/sub'), trigger: 'auto' } }; });
  add('cwd-nested-repo', (root) => { const repo = lib.repo(root, 'repo', {}); const inner = lib.repo(root, 'repo/inner', { 'i.txt': 'i' }); return { payload: { hook_event_name: 'PreCompact', session_id: SID, cwd: inner, trigger: 'auto' } }; });
  add('cwd-dir-named-git-file', (root) => { const d = path.join(root, 'weird'); fs.mkdirSync(d); lib.write(d, '.git', 'gitdir: /nonexistent\n'); return { payload: { hook_event_name: 'PreCompact', session_id: SID, cwd: d, trigger: 'auto' } }; });
  // ---- numbering and existing files
  add('num-existing-1-2', mk({ before: (r, repo) => { hand(repo, SID, 'PRECOMPACT-1.md', 'a'); hand(repo, SID, 'PRECOMPACT-2.md', 'b'); } }));
  add('num-gap', mk({ before: (r, repo) => { hand(repo, SID, 'PRECOMPACT-5.md', 'a'); hand(repo, SID, 'PRECOMPACT-2.md', 'b'); } }));
  add('num-nonmatching', mk({ before: (r, repo) => { for (const n of ['PRECOMPACT-.md', 'PRECOMPACT-x.md', 'PRECOMPACT-1.txt', 'precompact-9.md', 'PRECOMPACT-1.md.bak', 'HANDOVER.md']) hand(repo, SID, n, 'a'); } }));
  add('num-leading-zero', mk({ before: (r, repo) => { hand(repo, SID, 'PRECOMPACT-007.md', 'a'); } }));
  add('num-huge', mk({ before: (r, repo) => { hand(repo, SID, 'PRECOMPACT-99999999999999999999.md', 'a'); } }));
  add('num-other-session', mk({ before: (r, repo) => { hand(repo, 'other', 'PRECOMPACT-9.md', 'a'); } }));
  add('num-other-date', mk({ before: (r, repo) => { hand(repo, SID, 'PRECOMPACT-4.md', 'a', undefined, '2020-01-01'); } }));
  add('num-dir-named-like-file', mk({ before: (r, repo) => { fs.mkdirSync(path.join(hdir(repo, SID), 'PRECOMPACT-3.md'), { recursive: true }); } }));
  add('dir-is-file', mk({ before: (r, repo) => { fs.mkdirSync(path.join(repo, '.anti-hall/handovers', day()), { recursive: true }); lib.write(repo, `.anti-hall/handovers/${day()}/${SID}`, 'file'); } }));
  add('handovers-is-file', mk({ before: (r, repo) => { lib.write(repo, '.anti-hall/handovers', 'file'); } }));
  add('repo-unwritable', mk({ before: (r, repo) => { fs.mkdirSync(path.join(repo, '.anti-hall'), { recursive: true }); fs.chmodSync(path.join(repo, '.anti-hall'), 0o555); } }));
  // ---- newest handover
  add('handover-same-session', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 3600); } }));
  add('handover-other-newer', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 3600); hand(repo, 'other', 'HANDOVER.md', '# b', 10); } }));
  add('handover-only-other', mk({ before: (r, repo) => { hand(repo, 'other', 'HANDOVER.md', '# b', 10); hand(repo, 'third', 'HANDOVER-2.md', '# c', 5); } }));
  add('handover-tie', mk({ before: (r, repo) => { hand(repo, 'aaa', 'HANDOVER.md', '# a', 100); hand(repo, 'bbb', 'HANDOVER.md', '# b', 100); } }));
  add('handover-seq-names', mk({ before: (r, repo) => { for (const n of ['HANDOVER.md', 'HANDOVER-2.md', 'HANDOVER-10.md', 'HANDOVER-x.md', 'HANDOVER-.md', 'HANDOVER2.md']) hand(repo, SID, n, '# a', 100); } }));
  add('handover-huge-seq', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER-99999999999999999999.md', '# a', 100); } }));
  add('handover-symlink-dir-ignored', mk({ before: (r, repo) => { hand(repo, 'real', 'HANDOVER.md', '# a', 100); fs.symlinkSync(hdir(repo, 'real'), path.join(repo, '.anti-hall/handovers', day(), 'lnk')); } }));
  add('handover-symlink-file', mk({ before: (r, repo) => { lib.write(r, 'elsewhere.md', '# a', 50); fs.mkdirSync(hdir(repo, SID), { recursive: true }); fs.symlinkSync(path.join(r, 'elsewhere.md'), path.join(hdir(repo, SID), 'HANDOVER.md')); } }));
  add('handover-dir-named-like-file', mk({ before: (r, repo) => { fs.mkdirSync(path.join(hdir(repo, SID), 'HANDOVER.md'), { recursive: true }); } }));
  add('handover-old-dates', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 100, '2020-01-01'); hand(repo, SID, 'HANDOVER.md', '# b', 90, '2021-02-02'); } }));
  add('handover-fractional-mtime', mk({ before: (r, repo) => { const f = hand(repo, SID, 'HANDOVER.md', '# a'); const t = 1790000000.987654; fs.utimesSync(f, t, t); } }));
  // ---- user messages
  const msgs = (n) => Array.from({ length: n }, (_, i) => user('message number ' + i));
  for (const n of [0, 1, 9, 10, 11, 25]) add('msgs-' + n, mk({ lines: msgs(n) }));
  add('msgs-trim-and-empty', mk({ lines: [user('  padded  '), user(''), user('   \n '), user('real')] }));
  add('msgs-harness-tags', mk({ lines: ['<task-notification>x', '<local-command-stdout>x', '<local-command-caveat>x', '<system-reminder>x', '<bash-stdout>x', '<bash-stderr>x', '<command-name>x', '<command-message>x', '<command-args>x', '<command-other>x', '<bash-std>x', 'real message', ' <system-reminder> leading space trimmed'].map(t => user(t)) }));
  add('msgs-flags', mk({ lines: [user('a', { isMeta: true }), user('b', { isSidechain: true }), user('c', { isCompactSummary: true }), user('d', { isMeta: false }), user('e', { isMeta: 0 }), user('f', { isMeta: 'yes' }), user('g', { isMeta: null })] }));
  add('msgs-array-content', mk({ lines: [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'image', source: 'x' }, { type: 'text', text: 5 }] } }), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }, { type: 'text', text: 'hidden by tool_result' }] } }), JSON.stringify({ type: 'user', message: { content: [] } }), JSON.stringify({ type: 'user', message: { content: [null, { type: 'text', text: 'ok' }] } })] }));
  add('msgs-weird-message', mk({ lines: [JSON.stringify({ type: 'user', message: 'str' }), JSON.stringify({ type: 'user', message: null }), JSON.stringify({ type: 'user', message: { content: 5 } }), JSON.stringify({ type: 'user', message: [1] }), JSON.stringify({ type: 'user' }), JSON.stringify({ type: 'assistant', message: { content: 'user' } })] }));
  add('msgs-codex-shape', mk({ lines: [JSON.stringify({ type: 'event_msg', timestamp: 't1', payload: { type: 'user_message', message: 'codex says hi' } }), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS.md injection' }] } }), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 5 } }), JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x' } })] }));
  add('msgs-timestamps', mk({ lines: [user('a', { timestamp: 5 }), user('b', { timestamp: null }), JSON.stringify({ type: 'user', message: { content: 'c' } }), user('d', { timestamp: '' })] }));
  add('msgs-long-4000', mk({ lines: [user('x'.repeat(4000)), user('y'.repeat(4001)), user('z'.repeat(9000))] }));
  add('msgs-long-emoji-boundary', mk({ lines: [user('a'.repeat(3999) + '\u{1F600}' + 'tail'), user('b'.repeat(3998) + '\u{1F600}\u{1F600}x'), user('\u{1F600}'.repeat(3000))] }));
  add('msgs-unicode', mk({ lines: [user('café \u{1F600} 中文'), user('line1\nline2\r\nline3'), user('````text fence inside ````'), user('| pipes | here |')] }));
  add('msgs-user-in-string-only', mk({ lines: [JSON.stringify({ type: 'assistant', message: { content: 'the word "user" appears' } })] }));
  add('msgs-invalid-lines', mk({ lines: ['not json "user"', '{"type":"user","message":{"content":"ok"}}', '{"type":"user"', '', '   ', user('after')] }));
  add('msgs-lone-surrogate', mk({ lines: [user('fine'), '{"type":"user","message":{"content":"bad \\ud83d here"}}'] }));
  add('msgs-number-out-of-range', mk({ lines: [user('fine'), '{"type":"user","n":1e999,"message":{"content":"x"}}'] }));
  add('msgs-deep', mk({ lines: [user('fine'), '{"type":"user","message":{"content":"x"},"d":' + '['.repeat(300) + ']'.repeat(300) + '}'] }));
  add('msgs-crlf', mk({ lines: msgs(3), noNl: true, before: (r, repo) => {} }));
  add('transcript-big-tail', mk({ lines: () => { const pad = 'p'.repeat(2000); const ls = []; for (let i = 0; i < 1000; i++) ls.push(user(pad + i)); return ls; } }));
  add('transcript-big-multibyte-cut', mk({ lines: () => { const ls = [user('é'.repeat(1000000)), user('é'.repeat(1000000)), user('last')]; return ls; } }));
  add('transcript-exact-cap', mk({ lines: () => { const one = user('first'); const pad = 1572864 - Buffer.byteLength(one) - 1; return [one + ' '.repeat(Math.max(0, pad))]; } }));
  // ---- task list
  add('tasks-todowrite', mk({ lines: [asst(toolUse('TodoWrite', { todos: [{ content: 'first', status: 'completed' }, { content: 'second | pipe', status: 'in_progress' }, { subject: 'third', status: 'pending' }, { content: '', subject: 'sub-fallback' }, null, 'str', { content: 5 }, { content: 'x'.repeat(300), status: 7 }] }))] }));
  add('tasks-todowrite-empty', mk({ lines: [asst(toolUse('TodoWrite', { todos: [] }))] }));
  add('tasks-todowrite-replaced', mk({ lines: [asst(toolUse('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] })), asst(toolUse('TodoWrite', { todos: [{ content: 'b', status: 'pending' }] }))] }));
  add('tasks-todowrite-not-array', mk({ lines: [asst(toolUse('TodoWrite', { todos: 'x' }))] }));
  add('tasks-create-update', mk({ lines: [asst(toolUse('TaskCreate', { subject: 'Do A' }, 'tu1')), toolRes('tu1', 'Task #1 created successfully: Do A'), asst(toolUse('TaskCreate', { subject: 'Do B' }, 'tu2')), toolRes('tu2', [{ type: 'text', text: 'Task #2 created successfully: Do B' }]), asst(toolUse('TaskUpdate', { taskId: '1', status: 'in_progress' })), asst(toolUse('TaskUpdate', { taskId: 2, status: 'deleted' })), asst(toolUse('TaskUpdate', { taskId: '9', status: 'pending', subject: 'ghost' }))] }));
  add('tasks-update-before-create', mk({ lines: [asst(toolUse('TaskUpdate', { taskId: '1', status: 'completed' })), asst(toolUse('TaskCreate', { subject: 'Late' }, 'tu1')), toolRes('tu1', 'Task #1 created successfully: Late')] }));
  add('tasks-ids-variants', mk({ lines: [asst(toolUse('TaskUpdate', { id: 'abc', status: 'x' })), asst(toolUse('TaskUpdate', { taskId: null, id: 4, status: 'y' })), asst(toolUse('TaskUpdate', { taskId: 0, status: 'z' })), asst(toolUse('TaskUpdate', { taskId: '', status: 'w' })), asst(toolUse('TaskUpdate', { status: 'nothing' })), asst(toolUse('TaskUpdate', { taskId: ['a', 'b'], subject: 5, status: { a: 1 } }))] }));
  add('tasks-create-id-types', mk({ lines: [asst(toolUse('TaskCreate', { subject: 'n' }, 5)), toolRes(5, 'Task #1 created successfully'), asst(toolUse('TaskCreate', { subject: 'z' }, 0)), toolRes(0, 'Task #2 created successfully'), asst(toolUse('TaskCreate', { subject: 'o' }, { a: 1 })), asst(toolUse('TaskCreate', { subject: 't' }, true)), toolRes(true, 'Task #3 created successfully'), asst(toolUse('TaskCreate', { subject: 'nid' })), toolRes(undefined, 'Task #4 created successfully')] }));
  add('tasks-create-text-variants', mk({ lines: [asst(toolUse('TaskCreate', {}, 'a')), toolRes('a', 'Task #12 created successfully: x'), asst(toolUse('TaskCreate', { subject: 'b' }, 'b')), toolRes('b', 'no number here'), asst(toolUse('TaskCreate', { subject: 'c' }, 'c')), toolRes('c', [{ type: 'text', text: 'Task #٣ created successfully' }]), asst(toolUse('TaskCreate', { subject: 'd' }, 'd')), toolRes('d', null)] }));
  add('tasks-recreate-keeps-status', mk({ lines: [asst(toolUse('TaskUpdate', { taskId: '1', status: 'in_progress' })), asst(toolUse('TaskCreate', { subject: 'S' }, 'a')), toolRes('a', 'Task #1 created successfully')] }));
  add('tasks-sidechain-ignored', mk({ lines: [JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [toolUse('TodoWrite', { todos: [{ content: 'side', status: 'pending' }] })] } }), JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [toolUse('TodoWrite', { todos: [{ content: 'main', status: 'pending' }] })] } })] }));
  add('tasks-only-user-lines', mk({ lines: [user('TodoWrite is a tool'), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'x' }] } }] } })] }));
  add('tasks-weird-items', mk({ lines: [JSON.stringify({ type: 'assistant', message: { content: [null, 0, 'TaskCreate', { type: 'tool_use' }, toolUse('TodoWrite', null), toolUse('TaskUpdate', 'str')] } }), JSON.stringify({ type: 'assistant', message: { content: 'TodoWrite' } }), JSON.stringify(['TodoWrite'])] }));
  add('tasks-many-cells', mk({ lines: [asst(toolUse('TodoWrite', { todos: [{ content: 'café \u{1F600}\n\tline | two', status: 'pending' }, { content: '\u{1F600}'.repeat(150), status: 'pending' }, { content: 'a'.repeat(199) + '\u{1F600}', status: 'pending' }] }))] }));
  add('tasks-and-messages-together', mk({ lines: [user('first'), asst(toolUse('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] })), user('second'), asst(toolUse('TaskCreate', { subject: 'N' }, 'q')), toolRes('q', 'Task #3 created successfully'), user('third')] }));
  // ---- fuzz: random transcripts, same seed for both sides ----
  let seed = 4242; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const WORDS = ['', ' ', 'a', 'caf\u00e9', '\u{1F600}', '|', '||x', 'line\nbreak', 'tab\there', '<system-reminder>x', '<task-notification>', '  pad  ', 'x'.repeat(250), '\u{1F600}'.repeat(120), 'deleted', 'pending', 'completed', 'in_progress', '0', 'TodoWrite', 'user'];
  const scalar = () => pick([null, true, false, 0, 1, -1, 2.5, 1e21, '', 'x', 'deleted', 'pending', pick(WORDS), pick(WORDS)]);
  const rv = (d) => { const r = rnd(); if (d <= 0 || r < 0.55) return scalar(); if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 3) }, () => rv(d - 1)); const o = {}; for (const k of ['content', 'subject', 'status', 'type', 'text', 'id', 'taskId']) if (rnd() < 0.4) o[k] = rv(d - 1); return o; };
  const fuzzLine = () => {
    const r = rnd();
    if (r < 0.25) return user(pick(WORDS) + pick(WORDS));
    if (r < 0.35) return JSON.stringify({ type: pick(['user', 'assistant', 'event_msg', 'x', 5]), isMeta: pick([undefined, true, false, 0, 'x']), isSidechain: pick([undefined, true, false, 'true']), message: rv(2), payload: rv(2), timestamp: pick([undefined, 't', 5, null]) });
    if (r < 0.55) return asst(toolUse('TodoWrite', { todos: rnd() < 0.9 ? Array.from({ length: Math.floor(rnd() * 4) }, () => rv(1)) : rv(1) }));
    if (r < 0.7) return asst(toolUse('TaskCreate', rnd() < 0.8 ? { subject: rv(0) } : rv(1), rnd() < 0.8 ? 'id' + Math.floor(rnd() * 4) : rv(0)));
    if (r < 0.82) return asst(toolUse('TaskUpdate', rnd() < 0.85 ? { taskId: pick([1, '1', '2', 3, null, 'x', ['a']]), status: rv(0), subject: rv(0) } : rv(1)));
    if (r < 0.92) return toolRes('id' + Math.floor(rnd() * 4), pick(['Task #' + Math.floor(rnd() * 4) + ' created successfully', 'x', null, [{ type: 'text', text: 'Task #1 created successfully' }], rv(1)]));
    return pick(['', ' ', 'not json', '{"type":"user"', '[1]', 'null', '5', JSON.stringify(rv(3))]);
  };
  const nfuzz = +lib.arg('--fuzz', 120);
  for (let i = 0; i < nfuzz; i++) { const L = Array.from({ length: 2 + Math.floor(rnd() * 10) }, fuzzLine); add('fuzz-' + i, mk({ lines: L })); }
  return out;
};
