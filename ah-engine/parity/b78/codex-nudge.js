// Corpus for codex-nudge (Stop): transcript scanning, thresholds, exclusions, quota gating, Jev, state and pruning.
const fs = require('fs'), path = require('path'), cp = require('child_process');
exports.scenarios = (lib) => {
  const out = [];
  const add = (id, setup, extra) => out.push(Object.assign({ id, setup }, extra || {}));
  const uid = process.getuid();
  const SID = 'sess-1';
  // sandbox layout: <root>/repo (git), <root>/home, transcript under home/.claude/projects/<enc>/<sid>.jsonl, TMPDIR=<root>/tmp
  const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
  const tuLine = (tus, wrap) => JSON.stringify(wrap === 'flat' ? tus[0] : wrap === 'messages' ? { type: 'x', messages: tus.map(t => ({ content: [t] })) } : wrap === 'parts' ? { parts: tus } : wrap === 'tool_uses' ? { tool_uses: tus } : wrap === 'msgobj' ? { message: { content: tus } } : { type: 'assistant', message: { content: tus } });
  const edit = (f, name) => ({ type: 'tool_use', name: name || 'Edit', id: 't', input: { file_path: f } });
  const base = (root) => {
    const repo = lib.repo(root, 'repo', { 'a.js': 'x\n' });
    const cwd = repo;
    const tdir = path.join(root, 'home/.claude/projects', enc(cwd));
    fs.mkdirSync(tdir, { recursive: true });
    return { cwd, repo, transcript: path.join(tdir, SID + '.jsonl'), scratch: path.join(root, 'tmp', 'claude-' + uid, enc(cwd), SID, 'scratchpad') };
  };
  // build(root, ctx) -> {lines:[...], payload:{...}} ; helper `mk` wires the usual payload.
  const mk = (lines, o) => (root) => {
    const b = base(root);
    const ls = typeof lines === 'function' ? lines(root, b) : lines;
    const text = Array.isArray(ls) ? ls.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join((o && o.eol) || '\n') + ((o && o.noFinalNewline) ? '' : '\n') : String(ls);
    fs.writeFileSync(b.transcript, text);
    if (o && o.before) o.before(root, b);
    const payload = Object.assign({ hook_event_name: 'Stop', session_id: SID, cwd: b.cwd, transcript_path: b.transcript, stop_hook_active: false }, typeof (o && o.payload) === 'function' ? o.payload(root, b) : (o && o.payload) || {});
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    return { payload, env: (o && o.env) || {} };
  };
  const E = (n, ext, dir) => Array.from({ length: n }, (_, i) => edit(`${dir || ''}/f${i}.${ext || 'js'}`));
  const under = (b, rel) => path.join(b.repo, rel);
  const edits = (n, ext) => (root, b) => [tuLine(Array.from({ length: n }, (_, i) => edit(under(b, `f${i}.${ext || 'js'}`))))];

  // ---- thresholds
  for (const n of [0, 1, 2, 3, 4, 7]) add('edits-' + n, mk(edits(n)));
  add('edits-md-only', mk(edits(5, 'md')));
  add('edits-json-only', mk(edits(5, 'json')));
  add('edits-upper-ext', mk(edits(4, 'JS')));
  add('edits-all-exts', mk((r, b) => ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte', 'dart', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'cs', 'scala', 'sh', 'bash', 'sql', 'txt', 'jsonl', 'yml'].map(e => tuLine([edit(under(b, 'f.' + e))]))));
  add('edits-no-ext', mk((r, b) => [tuLine([edit(under(b, 'Makefile')), edit(under(b, 'a.js.bak')), edit(under(b, '.js')), edit(under(b, 'x.js/'))])]));
  add('edits-tools-mix', mk((r, b) => [tuLine([edit(under(b, 'a.js'), 'Write'), edit(under(b, 'b.js'), 'MultiEdit'), edit(under(b, 'c.js'), 'NotebookEdit'), edit(under(b, 'd.js'), 'edit'), edit(under(b, 'e.js'), 'Read')])]));
  add('edits-same-file-4x', mk((r, b) => [tuLine([edit(under(b, 'a.js')), edit(under(b, 'a.js')), edit(under(b, 'a.js')), edit(under(b, 'a.js'))])]));
  add('edits-same-base-different-dirs', mk((r, b) => [tuLine([edit(under(b, 'x/a.js')), edit(under(b, 'y/a.js')), edit(under(b, 'z/a.js'))])]));
  add('edits-6-files-names', mk(edits(6)));
  add('edits-unicode-names', mk((r, b) => [tuLine(['é.js', '\u{1F600}.py', 'sp ace.ts', 'tab\there.go', 'new\nline.rs'].map(n => edit(under(b, n))))]));
  add('edits-sort-bmp-vs-astral', mk((r, b) => [tuLine(['.js', '\u{1F600}.js', 'a.js', '～.js'].map(n => edit(under(b, n))))]));
  add('edits-file_path-types', mk((r, b) => [tuLine([{ type: 'tool_use', name: 'Edit', input: { file_path: 5 } }, { type: 'tool_use', name: 'Edit', input: { file_path: null } }, { type: 'tool_use', name: 'Edit', input: { file_path: ['a.js'] } }, { type: 'tool_use', name: 'Edit', input: [1] }, { type: 'tool_use', name: 'Edit', input: 'a.js' }, { type: 'tool_use', name: 'Edit' }, { type: 'tool_use', name: 'Edit', input: { file_path: under(b, 'ok.js') } }])]));
  add('tool-name-types', mk((r, b) => [tuLine([{ type: 'tool_use', name: 5, input: { file_path: under(b, 'a.js') } }, { type: 'tool_use', name: ['Edit'], input: { file_path: under(b, 'a.js') } }, { type: 'tool_use', name: '', input: { file_path: under(b, 'a.js') } }, { type: 'tool_use', input: { file_path: under(b, 'a.js') } }])]));
  for (const wrap of ['flat', 'messages', 'parts', 'tool_uses', 'msgobj']) add('wrap-' + wrap, mk((r, b) => (wrap === 'flat' ? E(4, 'js', b.repo).map(t => JSON.stringify(t)) : [tuLine(E(4, 'js', b.repo), wrap)])));
  add('wrap-nested-deep', mk((r, b) => [JSON.stringify({ message: { content: [{ content: [{ message: { parts: E(4, 'js', b.repo) } }] }] } })]));
  add('wrap-string-array-elems', mk((r, b) => [JSON.stringify({ content: ['x', 5, null, ...E(4, 'js', b.repo)] })]));
  // ---- codex review present
  const review = (t) => (r, b) => [tuLine([...E(4, 'js', b.repo), t])];
  for (const [id, t] of [['agent-codex-rescue', { type: 'tool_use', name: 'Agent', input: { subagent_type: 'codex:codex-rescue' } }], ['task-codex', { type: 'tool_use', name: 'Task', input: { subagent_type: 'codex' } }], ['agentType', { type: 'tool_use', name: 'Agent', input: { agentType: 'codex:codex-rescue' } }], ['agent_type', { type: 'tool_use', name: 'Agent', input: { agent_type: 'Codex:x' } }], ['codexy', { type: 'tool_use', name: 'Agent', input: { subagent_type: 'codexy' } }], ['codex-dash', { type: 'tool_use', name: 'Agent', input: { subagent_type: 'codex-rescue' } }], ['codex-underscore', { type: 'tool_use', name: 'Agent', input: { subagent_type: 'codex_x' } }], ['not-codex', { type: 'tool_use', name: 'Agent', input: { subagent_type: 'general-purpose' } }], ['type-num', { type: 'tool_use', name: 'Agent', input: { subagent_type: 5, agentType: 'codex' } }], ['type-empty-first', { type: 'tool_use', name: 'Agent', input: { subagent_type: '', agentType: 'codex' } }], ['skill-codex', { type: 'tool_use', name: 'Skill', input: { skill: 'codex:rescue' } }], ['skill-command', { type: 'tool_use', name: 'Skill', input: { command: '/CODEX:setup' } }], ['skill-other', { type: 'tool_use', name: 'Skill', input: { skill: 'review' } }], ['skill-num', { type: 'tool_use', name: 'Skill', input: { skill: 5 } }], ['bash-codex', { type: 'tool_use', name: 'Bash', input: { command: 'codex exec x' } }]]) add('review-' + id, mk(review(t)));
  // ---- min threshold settings
  for (const v of ['1', '2', '3', '4', '5', '0', '-3', '3.5', '2.5', 'abc', '', ' 4 ', '0x4', '0x3', '1e1', 'Infinity', '-Infinity', '4abc', '.5', '5.', '+4', '0b100', '0o4', '1_0', '٤']) add('min-env-' + JSON.stringify(v), mk(edits(4)), { env: { ANTIHALL_CODEX_NUDGE_MIN: v } });
  for (const v of [1, 2, 5, 0, -1, 3.5, 4, 4.0, 1e9, '5', ' 5 ', 'x', true, false, null, [4], { a: 1 }]) add('min-settings-' + JSON.stringify(v), (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ codexNudge: { min: v } })); return mk(edits(4))(root); });
  add('min-env-beats-settings', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ codexNudge: { min: 9 } })); return mk(edits(4))(root); }, { env: { ANTIHALL_CODEX_NUDGE_MIN: '2' } });
  add('min-env-junk-falls-to-settings', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ codexNudge: { min: 9 } })); return mk(edits(4))(root); }, { env: { ANTIHALL_CODEX_NUDGE_MIN: 'zzz' } });
  add('min-settings-section-array', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ codexNudge: [1] })); return mk(edits(4))(root); });
  add('min-settings-corrupt', (root) => { lib.write(root, 'home/.anti-hall/settings.json', '{nope'); return mk(edits(4))(root); });
  // ---- switches
  for (const v of ['off', '0', 'false', 'no', 'on', '1', 'maybe', '']) add('switch-env-' + JSON.stringify(v), mk(edits(4)), { env: { ANTIHALL_CODEX_NUDGE: v } });
  add('switch-settings-false', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ codexNudge: { enabled: false } })); return mk(edits(4))(root); });
  add('switch-settings-str-off', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ codexNudge: { enabled: 'off' } })); return mk(edits(4))(root); });
  add('switch-plugin-option-false', mk(edits(4)), { env: { CLAUDE_PLUGIN_OPTION_CODEX_NUDGE_ENABLED: 'false' } });
  add('switch-plugin-option-true', mk(edits(4)), { env: { CLAUDE_PLUGIN_OPTION_CODEX_NUDGE_ENABLED: 'true' } });
  add('skip-own', (root) => { lib.write(root, 'home/.anti-hall/skip.json', JSON.stringify({ 'codex-nudge': 4102444800000 })); return mk(edits(4))(root); });
  add('skip-all', (root) => { lib.write(root, 'home/.anti-hall/skip.json', JSON.stringify({ all: 4102444800000 })); return mk(edits(4))(root); });
  add('skip-expired', (root) => { lib.write(root, 'home/.anti-hall/skip.json', JSON.stringify({ 'codex-nudge': 1000 })); return mk(edits(4))(root); });
  add('judge-child', mk(edits(4)), { env: { ANTIHALL_JUDGE_CHILD: '1' } });
  // ---- payload shapes
  add('no-transcript-path', mk(edits(4), { payload: { transcript_path: undefined } }));
  add('transcript-relative', mk(edits(4), { payload: { transcript_path: 'rel/t.jsonl' } }));
  add('transcript-num', mk(edits(4), { payload: { transcript_path: 5 } }));
  add('transcript-missing-file', mk(edits(4), { payload: (r, b) => ({ transcript_path: b.transcript + '.nope' }) }));
  add('transcript-is-dir', mk(edits(4), { payload: (r, b) => ({ transcript_path: path.dirname(b.transcript) }) }));
  add('transcript-empty', mk('', {}));
  add('payload-array', () => ({ payload: '[1]' }));
  add('payload-null', () => ({ payload: 'null' }));
  add('payload-malformed', () => ({ payload: '{"a":' }));
  add('payload-empty', () => ({ payload: '' }));
  // ---- transcript content shapes
  add('lines-invalid-json-mixed', mk((r, b) => ['not json', '{"a":', tuLine(E(4, 'js', b.repo)), '[1,2', '']));
  add('lines-crlf', mk((r, b) => [tuLine(E(2, 'js', b.repo)), tuLine(E(2, 'ts', b.repo))], { eol: '\r\n' }));
  add('lines-no-final-newline', mk((r, b) => [tuLine(E(4, 'js', b.repo))], { noFinalNewline: true }));
  add('lines-whitespace-padded', mk((r, b) => ['   ' + tuLine(E(4, 'js', b.repo)) + '  \t']));
  add('lines-lone-surrogate-escape', mk((r, b) => [tuLine(E(3, 'js', b.repo)), '{"type":"tool_use","name":"Edit","input":{"file_path":"' + b.repo + '/\\ud83d.js"}}']));
  add('lines-deep-nesting', mk((r, b) => ['['.repeat(200) + ']'.repeat(200), tuLine(E(4, 'js', b.repo))]));
  add('lines-number-out-of-range', mk((r, b) => ['{"n":1e999}', tuLine(E(4, 'js', b.repo))]));
  add('lines-bom-first', mk((r, b) => ['﻿' + tuLine(E(4, 'js', b.repo))]));
  add('transcript-big-tail-cut', mk((r, b) => { const pad = 'x'.repeat(1000); const ls = []; for (let i = 0; i < 700; i++) ls.push(JSON.stringify({ type: 'user', message: { content: pad + i } })); ls.push(tuLine(E(4, 'js', b.repo))); return ls; }));
  add('transcript-big-edits-before-window', mk((r, b) => { const pad = 'x'.repeat(1000); const ls = [tuLine(E(4, 'js', b.repo))]; for (let i = 0; i < 700; i++) ls.push(JSON.stringify({ type: 'user', message: { content: pad + i } })); return ls; }));
  add('transcript-exact-window', mk((r, b) => { const one = tuLine(E(4, 'js', b.repo)); const padLen = 524288 - Buffer.byteLength(one) - 1; return [one, 'z'.repeat(0)].slice(0, 1).concat([]).map(l => l).concat([]).concat([]) && [one + ' '.repeat(Math.max(0, padLen))]; }));
  add('transcript-utf8-multibyte-cut', mk((r, b) => { const ls = ['é'.repeat(300000)]; ls.push(tuLine(E(4, 'js', b.repo))); return ls; }));
  // ---- exclusions: scratchpad and worktree
  add('scratch-excluded', (root) => { const x = mk((r, b) => [tuLine([...E(2, 'js', b.repo), edit(path.join(b.scratch, 'x.py')), edit(path.join(b.scratch, 'y.py'))])])(root); return x; });
  add('scratch-excluded-all', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.scratch, `x${i}.py`))))]));
  add('scratch-wrong-session', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.scratch, '..', 'other-session', 'scratchpad', `x${i}.py`))))]));
  add('scratch-via-tmp-roots', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`/tmp/claude-${uid}/${enc(b.cwd)}/${SID}/scratchpad/x${i}.py`)))]), { env: { TMPDIR: null } });
  add('scratch-tmpdir-trailing-slash', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.scratch, `x${i}.py`))))]), {});
  add('scratch-tmp-env', (root) => { const x = mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(r, 'alt', 'claude-' + uid, enc(b.cwd), SID, 'scratchpad', `x${i}.py`))))])(root); x.env = { TMPDIR: null, TMP: path.join(root, 'alt') + '/' }; return x; });
  add('scratch-session-id-invalid', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.scratch, `x${i}.py`))))], { payload: { session_id: 'a b' } }));
  add('scratch-no-session-id', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.scratch, `x${i}.py`))))], { payload: { session_id: undefined } }));
  add('scratch-transcript-relative', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.scratch, `x${i}.py`))))], { payload: { transcript_path: 'rel/x.jsonl' } }));
  add('outside-worktree-excluded', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`/elsewhere/f${i}.js`)))]));
  add('outside-worktree-mixed', mk((r, b) => [tuLine([...E(2, 'js', b.repo), edit('/elsewhere/a.js'), edit('/elsewhere/b.js')])]));
  add('relative-paths-with-cwd', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`sub/f${i}.js`)))]));
  add('relative-dotdot-escape', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`../outside/f${i}.js`)))]));
  add('relative-no-cwd', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`sub/f${i}.js`)))], { payload: { cwd: undefined } }));
  add('absolute-no-cwd', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`/x/f${i}.js`)))], { payload: { cwd: undefined } }));
  add('cwd-relative', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`/x/f${i}.js`)))], { payload: { cwd: 'sub' } }));
  add('cwd-num', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`/x/f${i}.js`)))], { payload: { cwd: 5 } }));
  add('cwd-not-a-repo', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(`/x/f${i}.js`)))], { payload: (r) => ({ cwd: r }) }));
  add('cwd-missing-dir-ancestor', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.repo, 'gone', `f${i}.js`))))], { payload: (r, b) => ({ cwd: path.join(b.repo, 'gone', 'deeper') }) }));
  add('cwd-subdir-of-repo', mk((r, b) => [tuLine(E(4, 'js', b.repo))], { before: (r, b) => fs.mkdirSync(path.join(b.repo, 'sub')), payload: (r, b) => ({ cwd: path.join(b.repo, 'sub') }) }));
  add('cwd-inside-dotgit', mk((r, b) => [tuLine(E(4, 'js', b.repo))], { payload: (r, b) => ({ cwd: path.join(b.repo, '.git') }) }));
  add('cwd-symlink-to-repo', mk((r, b) => [tuLine(E(4, 'js', b.repo))], { before: (r, b) => fs.symlinkSync(b.repo, path.join(r, 'lnk')), payload: (r) => ({ cwd: path.join(r, 'lnk') }) }));
  add('edit-path-symlink-into-repo', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(r, 'lnk2', `f${i}.js`))))], { before: (r, b) => fs.symlinkSync(b.repo, path.join(r, 'lnk2')) }));
  add('edit-path-symlink-out-of-repo', mk((r, b) => [tuLine(Array.from({ length: 4 }, (_, i) => edit(path.join(b.repo, 'lnk3', `f${i}.js`))))], { before: (r, b) => fs.symlinkSync('/tmp', path.join(b.repo, 'lnk3')) }));
  add('linked-worktree', (root) => { const b = base(root); const wt = path.join(root, 'wt'); lib.git(b.repo, 'worktree', 'add', '-q', wt, '-b', 'feat'); const tdir = path.join(root, 'home/.claude/projects', enc(wt)); fs.mkdirSync(tdir, { recursive: true }); const tp = path.join(tdir, SID + '.jsonl'); fs.writeFileSync(tp, tuLine([...E(2, 'js', wt), ...E(2, 'js', b.repo)]) + '\n'); return { payload: { hook_event_name: 'Stop', session_id: SID, cwd: wt, transcript_path: tp } }; });
  add('submodule', (root) => { const b = base(root); const sub = lib.repo(root, 'subsrc', { 's.js': 's\n' }); lib.sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'], { cwd: b.repo, env: Object.assign({}, process.env, lib.GITENV) }); lib.git(b.repo, 'commit', '-q', '-m', 'sub'); const cwd = path.join(b.repo, 'vendor/sub'); const tdir = path.join(root, 'home/.claude/projects', enc(cwd)); fs.mkdirSync(tdir, { recursive: true }); const tp = path.join(tdir, SID + '.jsonl'); fs.writeFileSync(tp, tuLine([...E(2, 'js', cwd), ...E(2, 'js', b.repo)]) + '\n'); return { payload: { hook_event_name: 'Stop', session_id: SID, cwd, transcript_path: tp } }; });
  add('nested-repo-in-repo', (root) => { const b = base(root); const inner = lib.repo(root, 'repo/inner', { 'i.js': 'i\n' }); const tdir = path.join(root, 'home/.claude/projects', enc(inner)); fs.mkdirSync(tdir, { recursive: true }); const tp = path.join(tdir, SID + '.jsonl'); fs.writeFileSync(tp, tuLine([...E(2, 'js', inner), ...E(2, 'js', b.repo)]) + '\n'); return { payload: { hook_event_name: 'Stop', session_id: SID, cwd: inner, transcript_path: tp } }; });
  // ---- quota gating
  const qrec = (q) => (r) => lib.write(r, 'home/.anti-hall/codex-availability.json', JSON.stringify({ available: true, quota: q }));
  add('quota-live', mk(edits(4), { before: qrec({ available: false, until: Date.now() + 3600000, reason: 'x' }) }));
  add('quota-expired', mk(edits(4), { before: qrec({ available: false, until: Date.now() - 3600000, reason: 'x' }) }));
  add('quota-live-switch-off', mk(edits(4), { before: qrec({ available: false, until: Date.now() + 3600000, reason: 'x' }) }), { env: { ANTIHALL_CODEX_QUOTA_DETECT: '0' } });
  add('quota-job-log', mk(edits(4), { before: (r) => lib.write(r, 'home/.claude/plugins/data/codex-openai-codex/state/repoA/jobs/a.log', "You've hit your usage limit. try again at Oct 3rd, 2030 9:11 PM.\n", 60) }));
  add('quota-job-log-switch-off', mk(edits(4), { before: (r) => lib.write(r, 'home/.claude/plugins/data/codex-openai-codex/state/repoA/jobs/a.log', "You've hit your usage limit. try again at Oct 3rd, 2030 9:11 PM.\n", 60) }), { env: { ANTIHALL_CODEX_QUOTA_DETECT: '0' } });
  add('quota-state-corrupt', mk(edits(4), { before: (r) => lib.write(r, 'home/.anti-hall/codex-availability.json', '{nope') }));
  add('quota-state-lone-surrogate', mk(edits(4), { before: (r) => lib.write(r, 'home/.anti-hall/codex-availability.json', '{"a":"\\ud83d"}') }));
  // ---- Jev
  add('jev-enabled-shadow', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ jev: { enabled: true } })); return mk(edits(4))(root); });
  add('jev-enabled-env', mk(edits(4)), { env: { ANTIHALL_JEV: '1' } });
  add('jev-enabled-off-integration', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ jev: { enabled: true }, jevIntegrations: { codexNudgeSubstantial: 'off' } })); return mk(edits(4))(root); });
  add('jev-disabled-env-zero', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ jev: { enabled: true } })); return mk(edits(4))(root); }, { env: { ANTIHALL_JEV: '0' } });
  add('jev-enabled-on-integration', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ jev: { enabled: true }, jevIntegrations: { codexNudgeSubstantial: 'on' } })); return mk(edits(4))(root); });
  add('jev-legacy-file-off-integration', (root) => { lib.write(root, 'home/.anti-hall/jev.json', JSON.stringify({ enabled: true, integrations: { codexNudgeSubstantial: 'off' } })); return mk(edits(4))(root); });
  add('jev-legacy-file', (root) => { lib.write(root, 'home/.anti-hall/jev.json', JSON.stringify({ enabled: true })); return mk(edits(4))(root); });
  add('jev-enabled-but-edits-below-min', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ jev: { enabled: true } })); return mk(edits(1))(root); });
  // ---- session id and state file
  for (const [id, sid] of [['num', 12345], ['array', ['a', 'b']], ['empty-array', []], ['object', { a: 1 }], ['zero', 0], ['empty', ''], ['true', true], ['unicode', 'sess-é\u{1F600}'], ['slashes', 'a/b\\c:d'], ['long', 's'.repeat(300)], ['dots', '..'], ['null', null], ['missing', undefined], ['float', 1.5e21]]) add('sid-' + id, mk(edits(4), { payload: { session_id: sid } }));
  const st = (name, txt) => mk(edits(4), { before: (r) => lib.write(r, `home/.anti-hall/codex-nudge-state-${name}.json`, txt) });
  const sigOf = (names) => require('crypto').createHash('sha1').update([...names].sort().join('|')).digest('hex');
  const fourNames = ['f0.js', 'f1.js', 'f2.js', 'f3.js'];
  add('state-same-sig', st(SID, JSON.stringify({ sig: sigOf(fourNames), nudges: 1 })));
  add('state-other-sig', st(SID, JSON.stringify({ sig: 'abc', nudges: 1 })));
  add('state-cap-reached', st(SID, JSON.stringify({ sig: 'abc', nudges: 2 })));
  add('state-cap-over', st(SID, JSON.stringify({ sig: 'abc', nudges: 7 })));
  add('state-nudges-string', st(SID, JSON.stringify({ sig: 'abc', nudges: '2' })));
  add('state-nudges-float', st(SID, JSON.stringify({ sig: 'abc', nudges: 1.5 })));
  add('state-nudges-neg', st(SID, JSON.stringify({ sig: 'abc', nudges: -5 })));
  add('state-nudges-huge', st(SID, '{"sig":"abc","nudges":1e999}'));
  add('state-sig-number', st(SID, JSON.stringify({ sig: 5, nudges: 1 })));
  add('state-array', st(SID, '[1]'));
  add('state-null', st(SID, 'null'));
  add('state-string', st(SID, '"x"'));
  add('state-corrupt', st(SID, '{nope'));
  add('state-empty', st(SID, ''));
  add('state-whitespace', st(SID, '  \n '));
  add('state-lone-surrogate', st(SID, '{"sig":"\\ud83d"}'));
  add('state-extra-keys-dropped', st(SID, JSON.stringify({ sig: 'abc', nudges: 1, extra: 1 })));
  add('state-is-dir', mk(edits(4), { before: (r) => fs.mkdirSync(path.join(r, `home/.anti-hall/codex-nudge-state-${SID}.json`)) }));
  add('state-dir-unwritable', mk(edits(4), { before: (r) => fs.chmodSync(path.join(r, 'home/.anti-hall'), 0o555) }));
  add('anti-hall-is-file', mk(edits(4), { before: (r) => { fs.rmSync(path.join(r, 'home/.anti-hall'), { recursive: true }); fs.writeFileSync(path.join(r, 'home/.anti-hall'), 'f'); } }));
  // ---- pruning of other sessions' state
  const old = (r, name, days) => lib.write(r, `home/.anti-hall/codex-nudge-state-${name}.json`, '{}', days * 86400);
  add('prune-old-and-new', mk(edits(4), { before: (r) => { old(r, 'old1', 10); old(r, 'old2', 8); old(r, 'fresh', 1); old(r, 'edge', 6.9); lib.write(r, 'home/.anti-hall/other-file.json', '{}', 20 * 86400); lib.write(r, 'home/.anti-hall/codex-nudge-state-x.txt', '{}', 20 * 86400); lib.write(r, 'home/.anti-hall/codex-nudge-statex.json', '{}', 20 * 86400); } }));
  add('prune-own-old-file-kept', mk(edits(4), { before: (r) => { old(r, SID, 30); }, env: {} }));
  add('prune-stamp-recent', mk(edits(4), { before: (r) => { old(r, 'old1', 10); lib.write(r, 'home/.anti-hall/.prune-stamp-codex-nudge-state.json', JSON.stringify({ lastSweep: Date.now() - 1000 })); } }));
  add('prune-stamp-old', mk(edits(4), { before: (r) => { old(r, 'old1', 10); lib.write(r, 'home/.anti-hall/.prune-stamp-codex-nudge-state.json', JSON.stringify({ lastSweep: Date.now() - 7 * 3600 * 1000 })); } }));
  add('prune-stamp-future', mk(edits(4), { before: (r) => { old(r, 'old1', 10); lib.write(r, 'home/.anti-hall/.prune-stamp-codex-nudge-state.json', JSON.stringify({ lastSweep: Date.now() + 99999999 })); } }));
  add('prune-stamp-corrupt', mk(edits(4), { before: (r) => { old(r, 'old1', 10); lib.write(r, 'home/.anti-hall/.prune-stamp-codex-nudge-state.json', '{x'); } }));
  add('prune-stamp-string', mk(edits(4), { before: (r) => { old(r, 'old1', 10); lib.write(r, 'home/.anti-hall/.prune-stamp-codex-nudge-state.json', JSON.stringify({ lastSweep: String(Date.now()) })); } }));
  add('prune-symlink-old', mk(edits(4), { before: (r) => { lib.write(r, 'target.json', '{}', 40 * 86400); fs.symlinkSync(path.join(r, 'target.json'), path.join(r, 'home/.anti-hall/codex-nudge-state-lnk.json')); } }));
  add('prune-dir-named-like-state', mk(edits(4), { before: (r) => { fs.mkdirSync(path.join(r, 'home/.anti-hall/codex-nudge-state-d.json')); } }));
  add('not-nudging-no-prune', mk(edits(1), { before: (r) => { old(r, 'old1', 10); } }));
  add('same-sig-no-prune', mk(edits(4), { before: (r) => { old(r, 'old1', 10); lib.write(r, `home/.anti-hall/codex-nudge-state-${SID}.json`, JSON.stringify({ sig: sigOf(fourNames), nudges: 1 })); } }));
  // ---- fuzz: random transcripts and settings, same seed for both sides ----
  let seed = 777; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const EXTS = ['js', 'ts', 'py', 'md', 'json', 'rs', 'JS', 'sh', 'txt', '', 'go', 'sql', 'jsx.bak'];
  const NAMES = ['a', 'b', 'c', 'caf\u00e9', '\u{1F600}', 'sp ace', 'x'.repeat(40), 'f1', 'f2', 'f3', 'dup', 'dup'];
  const DIRS = ['', 'sub/', 'sub/deep/', '../out/', '/elsewhere/', 'REPO/', 'REPO/sub/', 'REPO/x/../y/', 'SCRATCH/', 'REPO/lnk3/'];
  const fpath = () => { const d = pick(DIRS); return (d.startsWith('REPO/') ? d.replace('REPO', '@REPO@') : d.startsWith('SCRATCH/') ? '@SCRATCH@/' : d) + pick(NAMES) + (rnd() < 0.9 ? '.' + pick(EXTS) : ''); };
  const fuzzTu = () => { const r = rnd(); if (r < 0.7) return { type: 'tool_use', name: pick(['Edit', 'Edit', 'Write', 'MultiEdit', 'Read', 'Bash', 5, '']), input: rnd() < 0.9 ? { file_path: rnd() < 0.9 ? fpath() : pick([5, null, ['x'], '']) } : pick([null, 'x', [1], {}]) }; if (r < 0.85) return { type: 'tool_use', name: pick(['Agent', 'Task']), input: { [pick(['subagent_type', 'agentType', 'agent_type'])]: pick(['codex:codex-rescue', 'codex', 'Codex:x', 'codexy', 'general-purpose', '', 5, null, 'codex-rescue']) } }; return { type: 'tool_use', name: 'Skill', input: { skill: pick(['codex:rescue', 'review', 5, '']), command: pick(['/codex', '', 7, undefined]) } }; };
  const wrap = (tus) => pick([() => ({ type: 'assistant', message: { content: tus } }), () => ({ content: tus }), () => ({ parts: tus }), () => ({ tool_uses: tus }), () => ({ messages: tus.map(t => ({ content: [t] })) }), () => tus[0], () => ({ message: { messages: [{ parts: tus }] } }), () => ({ type: 'x', message: 'str' })])();
  const nfuzz = +lib.arg('--fuzz', 120);
  for (let i = 0; i < nfuzz; i++) {
    const env = rnd() < 0.3 ? { ANTIHALL_CODEX_NUDGE_MIN: pick(['1', '2', '5', '0', 'x', '2.5']) } : {};
    const abstract = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => JSON.stringify(wrap(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => fuzzTu()))));
    add('fuzz-' + i, (root) => mk((r, b) => abstract.map(l => l.split('@REPO@').join(b.repo).split('@SCRATCH@').join(b.scratch)), { before: (r, b) => { try { fs.symlinkSync('/tmp', path.join(b.repo, 'lnk3')); } catch (_) {} }, env })(root));
  }
  return out;
};
