// Corpus for handover-resume (SessionStart): sources, discovery, freshness, writer activity, shape, snapshots, state.
const fs = require('fs'), path = require('path');
exports.scenarios = (lib) => {
  const out = [];
  const add = (id, setup, extra) => out.push(Object.assign({ id, setup }, extra || {}));
  const SID = 'sess-1';
  const D = 86400;
  const day = (offsetDays) => { const d = new Date(Date.now() - (offsetDays || 0) * D * 1000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const enc = (p) => p.replace(/[/\\:.]/g, '-');
  const hdir = (repo, sid, date) => path.join(repo, '.anti-hall/handovers', date || day(), sid || SID);
  const hand = (repo, sid, name, content, ageSec, date) => lib.write(hdir(repo, sid, date), name, content === undefined ? '# handover\nSituation\n' : content, ageSec);
  const FULL = '# H\n\n## Resume-verification checklist\n- do it\n';
  // sandbox: a repo + payload; `o.before(root, repo)` adds handovers; payload is SessionStart
  const mk = (o) => (root) => {
    o = o || {};
    const repo = o.noRepo ? (fs.mkdirSync(path.join(root, 'plain'), { recursive: true }), path.join(root, 'plain')) : lib.repo(root, 'repo', o.files);
    if (o.before) o.before(root, repo);
    const p = Object.assign({ hook_event_name: 'SessionStart', session_id: SID, cwd: repo, source: 'startup', transcript_path: path.join(root, 'home/.claude/projects', enc(repo), SID + '.jsonl') }, typeof o.payload === 'function' ? o.payload(root, repo) : o.payload || {});
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    return { payload: p, env: o.env || {} };
  };
  const one = (ageSec, content, name) => (r, repo) => { hand(repo, SID, name || 'HANDOVER.md', content, ageSec); };

  // ---- sources and presence
  for (const src of ['startup', 'resume', 'clear', 'compact', '', 'other', undefined, 5, null]) {
    add('src-' + JSON.stringify(src) + '-with-handover', mk({ before: one(3600), payload: { source: src } }));
    add('src-' + JSON.stringify(src) + '-none', mk({ payload: { source: src } }));
  }
  add('none-handovers-dir-empty', mk({ before: (r, repo) => fs.mkdirSync(path.join(repo, '.anti-hall/handovers'), { recursive: true }), payload: { source: 'clear' } }));
  add('none-handovers-is-file', mk({ before: (r, repo) => lib.write(repo, '.anti-hall/handovers', 'f'), payload: { source: 'clear' } }));
  add('none-handovers-symlink-dir', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# x', 100); fs.renameSync(path.join(repo, '.anti-hall/handovers'), path.join(r, 'moved')); fs.symlinkSync(path.join(r, 'moved'), path.join(repo, '.anti-hall/handovers')); }, payload: { source: 'compact' } }));
  add('none-dir-no-md', mk({ before: (r, repo) => { hand(repo, SID, 'notes.txt', 'x', 100); }, payload: { source: 'clear' } }));
  // ---- age
  for (const [id, age] of [['1h', 3600], ['6d', 6 * D], ['6.99d', 6.99 * D], ['7.01d', 7.01 * D], ['30d', 30 * D], ['future', -3600]]) add('age-' + id, mk({ before: one(age), payload: { source: 'compact' } }));
  add('age-stale-clear-no-negative', mk({ before: one(30 * D), payload: { source: 'clear' } }));
  // ---- session preference
  add('sess-same-vs-newer-other', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 3600); hand(repo, 'other', 'HANDOVER.md', '# b', 10); } }));
  add('sess-only-other', mk({ before: (r, repo) => { hand(repo, 'other', 'HANDOVER.md', '# b', 10); } }));
  add('sess-no-session-id', mk({ before: (r, repo) => { hand(repo, 'other', 'HANDOVER.md', '# b', 10); }, payload: { session_id: undefined } }));
  add('sess-empty-session-id', mk({ before: (r, repo) => { hand(repo, 'other', 'HANDOVER.md', '# b', 10); }, payload: { session_id: '' } }));
  add('sess-same-stale-other-fresh', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 30 * D); hand(repo, 'other', 'HANDOVER.md', '# b', 10); } }));
  add('sess-tie', mk({ before: (r, repo) => { hand(repo, 'aaa', 'HANDOVER.md', '# a', 100); hand(repo, 'bbb', 'HANDOVER.md', '# b', 100); } }));
  add('sess-seq-2', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 200); hand(repo, SID, 'HANDOVER-2.md', '# b', 100); } }));
  add('sess-seq-3', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER-3.md', '# b', 100); } }));
  add('sess-seq-10', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER-10.md', '# b', 100); } }));
  add('sess-seq-0', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER-0.md', '# b', 100); } }));
  add('sess-seq-huge', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER-99999999999999999999.md', '# b', 100); } }));
  for (const [id, sid] of [['num', 12345], ['zero', 0], ['false', false], ['true', true], ['array', ['a', 'b']], ['object', { a: 1 }], ['null', null], ['weird', 'a b/c..d'], ['unicode', 'sess-é\u{1F600}'], ['long', 's'.repeat(300)]]) add('sid-' + id, mk({ before: (r, repo) => { hand(repo, 'other', 'HANDOVER.md', '# b', 100); }, payload: { session_id: sid } }));
  // ---- INDEX.md outcome
  const idx = (lines) => (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 3600); hand(repo, SID, 'HANDOVER-2.md', '# a', 1800); lib.write(repo, '.anti-hall/handovers/INDEX.md', lines.join('\n')); };
  const row = (seq, outcome, sid, date) => `- ${date || day()} · ${sid || SID} · seq ${seq} · ${outcome} · [sub] · [main](${day()}/${SID}/HANDOVER.md)`;
  add('index-match-seq', mk({ before: idx([row(1, 'first outcome'), row(2, 'second outcome')]) }));
  add('index-fallback-last', mk({ before: idx([row(1, 'first outcome'), row(5, 'later outcome')]) }));
  add('index-other-session', mk({ before: idx([row(1, 'other', 'someone-else')]) }));
  add('index-other-date', mk({ before: idx([row(1, 'old', SID, '2020-01-01')]) }));
  add('index-short-row', mk({ before: idx([`- ${day()} · ${SID} · seq 2`]) }));
  add('index-empty-outcome', mk({ before: idx([`- ${day()} · ${SID} · seq 2 ·  · x`]) }));
  add('index-unicode-outcome', mk({ before: idx([row(2, 'café \u{1F600} 中文')]) }));
  add('index-crlf', mk({ before: idx([row(2, 'crlf outcome') + '\r', '']) }));
  add('index-dotless-separators', mk({ before: idx([`- ${day()} | ${SID} | seq 2 | ascii pipes | x`]) }));
  add('index-is-dir', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', '# a', 3600); fs.mkdirSync(path.join(repo, '.anti-hall/handovers/INDEX.md')); } }));
  // ---- freshness (git)
  add('fresh-clean', mk({ before: one(3600) }));
  add('fresh-dirty', mk({ before: (r, repo) => { one(3600)(r, repo); lib.write(repo, 'new.txt', 'n'); lib.write(repo, 'a.txt', 'changed\n'); } }));
  add('fresh-commits-since', mk({ before: (r, repo) => { one(3 * 3600)(r, repo); for (let i = 0; i < 2; i++) { lib.write(repo, `c${i}.txt`, 'c'); lib.git(repo, 'add', '-A'); lib.sh('git', ['commit', '-q', '-m', 'c' + i], { cwd: repo, env: Object.assign({}, process.env, lib.GITENV, { GIT_AUTHOR_DATE: new Date((lib.BASE - 3600) * 1000).toISOString(), GIT_COMMITTER_DATE: new Date((lib.BASE - 3600) * 1000).toISOString() }) }); } } }));
  add('fresh-not-git', mk({ noRepo: true, before: (r, repo) => { one(3600)(r, repo); } }));
  add('fresh-subdir-cwd', mk({ before: (r, repo) => { one(3600)(r, repo); fs.mkdirSync(path.join(repo, 'sub')); }, payload: (r, repo) => ({ cwd: path.join(repo, 'sub') }) }));
  add('fresh-detached', mk({ before: (r, repo) => { one(3600)(r, repo); lib.git(repo, 'checkout', '-q', '--detach'); } }));
  add('fresh-no-commits', (root) => { const d = path.join(root, 'repo'); fs.mkdirSync(d, { recursive: true }); lib.git(d, 'init', '-q', '-b', 'main'); hand(d, SID, 'HANDOVER.md', '# a', 3600); return { payload: { hook_event_name: 'SessionStart', session_id: SID, cwd: d, source: 'startup' } }; });
  add('fresh-dirty-many', mk({ before: (r, repo) => { one(3600)(r, repo); for (let i = 0; i < 30; i++) lib.write(repo, `u${i}.txt`, 'x'); } }));
  add('fresh-future-mtime', mk({ before: one(-7200) }));
  // ---- writer activity
  const tr = (r, repo, sid, ageSec) => { const f = lib.write(r, `home/.claude/projects/${enc(repo)}/${sid}.jsonl`, '{}\n', ageSec); return f; };
  add('writer-kept-running', mk({ before: (r, repo) => { one(3 * 3600)(r, repo); tr(r, repo, SID, 600); } }));
  add('writer-within-grace', mk({ before: (r, repo) => { one(3600)(r, repo); tr(r, repo, SID, 3600 - 120); } }));
  add('writer-exactly-grace', mk({ before: (r, repo) => { one(3600)(r, repo); tr(r, repo, SID, 3600 - 300); } }));
  add('writer-older-than-handover', mk({ before: (r, repo) => { one(3600)(r, repo); tr(r, repo, SID, 7200); } }));
  add('writer-no-transcript', mk({ before: one(3600) }));
  add('writer-other-session-handover', mk({ before: (r, repo) => { hand(repo, 'other', 'HANDOVER.md', '# a', 3 * 3600); tr(r, repo, 'other', 600); } }));
  add('writer-session-id-invalid', mk({ before: (r, repo) => { hand(repo, 'a b', 'HANDOVER.md', '# a', 3 * 3600); tr(r, repo, 'a b', 600); }, payload: { session_id: undefined } }));
  add('writer-minutes-rounding', mk({ before: (r, repo) => { one(3 * 3600)(r, repo); tr(r, repo, SID, 3 * 3600 - 29 * 60 - 30); } }));
  add('writer-cwd-subdir-second-root', mk({ before: (r, repo) => { one(3 * 3600)(r, repo); fs.mkdirSync(path.join(repo, 'sub')); tr(r, path.join(repo, 'sub'), SID, 600); }, payload: (r, repo) => ({ cwd: path.join(repo, 'sub') }) }));
  add('writer-first-root-wins-even-if-small-gap', mk({ before: (r, repo) => { one(3600)(r, repo); fs.mkdirSync(path.join(repo, 'sub')); tr(r, repo, SID, 3500); tr(r, path.join(repo, 'sub'), SID, 100); }, payload: (r, repo) => ({ cwd: path.join(repo, 'sub') }) }));
  add('writer-fractional-mtime', mk({ before: (r, repo) => { const f = hand(repo, SID, 'HANDOVER.md', '# a'); const t = lib.BASE - 4 * 3600 + 0.5; fs.utimesSync(f, t, t); const g = lib.write(r, `home/.claude/projects/${enc(repo)}/${SID}.jsonl`, '{}'); const u = lib.BASE - 600 + 0.25; fs.utimesSync(g, u, u); } }));
  // ---- handover shape
  const shape = (content, files) => mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', content, 3600); for (const f of files || []) hand(repo, SID, f, 'x', 3600); } });
  add('shape-checklist', shape(FULL));
  add('shape-checklist-lower', shape('## resume-verification CHECKLIST\n'));
  add('shape-checklist-space-before-title', shape('##    Resume-verification checklist'));
  add('shape-checklist-newline-between', shape('##\n\nResume-verification checklist'));
  add('shape-checklist-indented', shape('  ## Resume-verification checklist'));
  add('shape-checklist-h3', shape('### Resume-verification checklist'));
  add('shape-checklist-word-boundary', shape('## Resume-verification checklists'));
  add('shape-checklist-boundary-underscore', shape('## Resume-verification checklist_x'));
  add('shape-checklist-boundary-punct', shape('## Resume-verification checklist: do'));
  add('shape-checklist-boundary-unicode', shape('## Resume-verification checklisté'));
  add('shape-checklist-crlf', shape('# H\r\n## Resume-verification checklist\r\n'));
  add('shape-checklist-cr-only', shape('# H\r## Resume-verification checklist'));
  add('shape-checklist-ls', shape('# H ## Resume-verification checklist'));
  add('shape-checklist-after-text', shape('text ## Resume-verification checklist'));
  add('shape-checklist-kelvin', shape('## Resume-verification checKlist'));
  add('shape-checklist-fullwidth-space', shape('##　Resume-verification checklist'));
  add('shape-checklist-nbsp', shape('## Resume-verification checklist'));
  add('shape-no-checklist', shape('# no section\n'));
  add('shape-empty-file', shape(''));
  add('shape-binary', shape('\u0000\u0001ÿ garbage'));
  for (const fs_ of [[], ['state.md'], ['trials.md'], ['decisions.md', 'knowledge.md'], ['state.md', 'decisions.md', 'trials.md', 'knowledge.md'], ['state.md/']]) add('shape-details-' + fs_.join('+'), mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', FULL, 3600); for (const f of fs_) { if (f.endsWith('/')) fs.mkdirSync(path.join(hdir(repo, SID), f), { recursive: true }); else hand(repo, SID, f, 'x', 3600); } } }));
  add('shape-detail-is-dir', mk({ before: (r, repo) => { hand(repo, SID, 'HANDOVER.md', FULL, 3600); fs.mkdirSync(path.join(hdir(repo, SID), 'trials.md')); } }));
  add('shape-handover-is-dir', mk({ before: (r, repo) => { fs.mkdirSync(path.join(hdir(repo, SID), 'HANDOVER.md'), { recursive: true }); } }));
  // ---- PreCompact snapshots
  const snap = (name, ageSec, sid) => (r, repo) => { hand(repo, sid || SID, name, '# snap', ageSec); };
  add('snap-newer-than-handover', mk({ before: (r, repo) => { one(3600)(r, repo); snap('PRECOMPACT-1.md', 600)(r, repo); } }));
  add('snap-older-than-handover', mk({ before: (r, repo) => { one(600)(r, repo); snap('PRECOMPACT-1.md', 3600)(r, repo); } }));
  add('snap-two-newest-wins', mk({ before: (r, repo) => { one(3600)(r, repo); snap('PRECOMPACT-1.md', 900)(r, repo); snap('PRECOMPACT-2.md', 600)(r, repo); } }));
  add('snap-same-mtime-seq-wins', mk({ before: (r, repo) => { one(3600)(r, repo); snap('PRECOMPACT-3.md', 600)(r, repo); snap('PRECOMPACT-12.md', 600)(r, repo); snap('PRECOMPACT-2.md', 600)(r, repo); } }));
  add('snap-stale-ignored', mk({ before: (r, repo) => { one(3600)(r, repo); snap('PRECOMPACT-1.md', 8 * D)(r, repo); } }));
  add('snap-other-session-ignored', mk({ before: (r, repo) => { one(3600)(r, repo); snap('PRECOMPACT-1.md', 600, 'other')(r, repo); } }));
  add('snap-only', mk({ before: snap('PRECOMPACT-1.md', 600) }));
  add('snap-only-clear', mk({ before: snap('PRECOMPACT-1.md', 600), payload: { source: 'clear' } }));
  add('snap-only-stale-handover', mk({ before: (r, repo) => { one(30 * D)(r, repo); snap('PRECOMPACT-1.md', 600)(r, repo); } }));
  add('snap-only-other-session-handover', mk({ before: (r, repo) => { hand(repo, 'other', 'HANDOVER.md', '# b', 20 * D); snap('PRECOMPACT-1.md', 600)(r, repo); } }));
  add('snap-only-no-session-id', mk({ before: snap('PRECOMPACT-1.md', 600), payload: { session_id: undefined } }));
  add('snap-huge-seq', mk({ before: (r, repo) => { one(3600)(r, repo); snap('PRECOMPACT-99999999999999999999.md', 600)(r, repo); } }));
  add('snap-fractional-mtime', mk({ before: (r, repo) => { one(3600)(r, repo); const f = hand(repo, SID, 'PRECOMPACT-1.md', 's'); const t = 1790000000.987654; fs.utimesSync(f, t, t); } }));
  // ---- platform, event name, switches
  add('codex-turn-id', mk({ before: one(3600, FULL), payload: { turn_id: 't1' } }));
  add('codex-rollout', mk({ before: one(3600), payload: { transcript_path: '/h/.codex/sessions/x/rollout-1.jsonl' } }));
  add('codex-snapshot-only', mk({ before: snap('PRECOMPACT-1.md', 600), payload: { turn_id: 't1', source: 'compact' } }));
  for (const ev of [undefined, '', 'PostCompact', 'SessionStart', 5, null, 'weird\nname']) add('event-' + JSON.stringify(ev), mk({ before: one(3600), payload: { hook_event_name: ev } }));
  add('event-negative', mk({ payload: { hook_event_name: 'Custom', source: 'clear' } }));
  add('switch-off-settings', (root) => { lib.write(root, 'home/.anti-hall/settings.json', JSON.stringify({ context: { handoverResume: false } })); return mk({ before: one(3600) })(root); });
  add('switch-off-plugin-option', mk({ before: one(3600) }), { env: { CLAUDE_PLUGIN_OPTION_CONTEXT_HANDOVER_RESUME: 'false' } });
  add('judge-child', mk({ before: one(3600) }), { env: { ANTIHALL_JUDGE_CHILD: '1' } });
  // ---- cwd shapes
  add('cwd-none', mk({ before: one(3600), payload: { cwd: undefined } }));
  add('cwd-empty', mk({ before: one(3600), payload: { cwd: '' } }));
  add('cwd-num', mk({ before: one(3600), payload: { cwd: 5 } }));
  add('cwd-relative', mk({ before: one(3600), payload: { cwd: 'rel' } }));
  add('cwd-missing', mk({ before: one(3600), payload: (r) => ({ cwd: path.join(r, 'nope') }) }));
  add('cwd-subdir', mk({ before: (r, repo) => { one(3600)(r, repo); fs.mkdirSync(path.join(repo, 'a/b'), { recursive: true }); }, payload: (r, repo) => ({ cwd: path.join(repo, 'a/b') }) }));
  add('cwd-in-handovers', mk({ before: one(3600), payload: (r, repo) => ({ cwd: path.join(repo, '.anti-hall/handovers') }) }));
  add('cwd-symlink', mk({ before: (r, repo) => { one(3600)(r, repo); fs.symlinkSync(repo, path.join(r, 'lnk')); }, payload: (r) => ({ cwd: path.join(r, 'lnk') }) }));
  add('cwd-not-git-with-handovers', mk({ noRepo: true, before: one(3600) }));
  add('cwd-home-repo', (root) => { const home = path.join(root, 'home'); lib.git(home, 'init', '-q', '-b', 'main'); lib.write(home, 'dot.txt', 'd'); lib.git(home, 'add', 'dot.txt'); lib.git(home, 'commit', '-q', '-m', 'dots'); hand(home, SID, 'HANDOVER.md', '# h', 3600); return { payload: { hook_event_name: 'SessionStart', session_id: SID, cwd: home, source: 'startup' } }; });
  add('cwd-linked-worktree', mk({ before: (r, repo) => { lib.git(repo, 'worktree', 'add', '-q', path.join(r, 'wt'), '-b', 'feat'); hand(path.join(r, 'wt'), SID, 'HANDOVER.md', '# h', 3600); }, payload: (r) => ({ cwd: path.join(r, 'wt') }) }));
  add('cwd-submodule', (root) => { const repo = lib.repo(root, 'repo', {}); const sub = lib.repo(root, 'subsrc', { 's.txt': 's' }); lib.sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'], { cwd: repo, env: Object.assign({}, process.env, lib.GITENV) }); lib.git(repo, 'commit', '-q', '-m', 'sub'); hand(path.join(repo, 'vendor/sub'), SID, 'HANDOVER.md', '# h', 3600); return { payload: { hook_event_name: 'SessionStart', session_id: SID, cwd: path.join(repo, 'vendor/sub'), source: 'startup' } }; });
  // ---- state file
  add('state-written', mk({ before: one(3600) }));
  add('state-overwritten', mk({ before: (r, repo) => { one(3600)(r, repo); lib.write(r, `home/.anti-hall/handover-resume-state-${SID}.json`, 'old'); } }));
  add('state-dir-blocks', mk({ before: (r, repo) => { one(3600)(r, repo); fs.mkdirSync(path.join(r, `home/.anti-hall/handover-resume-state-${SID}.json`)); } }));
  add('state-anti-hall-is-file', mk({ before: (r, repo) => { one(3600)(r, repo); fs.rmSync(path.join(r, 'home/.anti-hall'), { recursive: true }); fs.writeFileSync(path.join(r, 'home/.anti-hall'), 'f'); } }));
  add('state-not-written-for-snapshot-only', mk({ before: snap('PRECOMPACT-1.md', 600) }));
  add('state-sid-sanitized', mk({ before: one(3600), payload: { session_id: 'a/b c' } }));
  add('large-handover-path-unicode', mk({ before: (r, repo) => { hand(repo, 'sess-é', 'HANDOVER.md', FULL, 3600); }, payload: { session_id: 'sess-é' } }));
  return out;
};
