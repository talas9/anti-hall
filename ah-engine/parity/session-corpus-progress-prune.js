// progress-prune scenarios (see session-corpus.js): a project (a git repository, a plain directory, a worktree, a symlink),
// its progress and history ledgers, the prune throttle, and the weekly gitignore reminder (which runs the real git).
exports.build = function (ctx, h) {
  const { H, P, merge, off, HOUR, DAY, switchMatrix } = h;
  const out = [];
  const hook = 'progress-prune';
  const q = JSON.stringify;
  const PR = '.anti-hall/progress/';
  const HI = '.anti-hall/history/';
  const STATE = '.anti-hall/progress-prune-state.json';
  const GSTATE = '.anti-hall/gitignore-hint-state.json';
  const old = '2026-09-01', old2 = '2026-09-02';
  const prog = (date, sid, content, mtimeOffset) => P(PR + date + '/' + sid + '.md', { content: content === undefined ? '# progress\nline 2\n' : content, mtimeOffset: mtimeOffset === undefined ? -30 * HOUR : mtimeOffset });
  const add = (id, files, extra) => out.push(Object.assign({ id: `${hook}-${id}`, hook, files: files || {} }, extra || {}));
  const rep = (id, files, extra) => add(id, files, Object.assign({ git: ['proj'] }, extra || {}));
  const noHint = { env: { ANTIHALL_GITIGNORE_HINT: 'off' } };
  const ignoreAll = { afterGit: { 'proj/.gitignore': '.anti-hall/\n' } };

  // ---- the prune --------------------------------------------------------------------------------------------------------
  rep('nothing-to-prune', P(PR + '.keep', ''), ignoreAll);
  rep('one-old-file', prog(old, 's1'), ignoreAll);
  rep('two-dates', merge(prog(old, 's1'), prog(old2, 's2', 'two\n')), ignoreAll);
  rep('todays-dir-untouched', merge(prog('{{TODAY}}', 's1', 'today\n'), prog(old, 's2')), ignoreAll);
  rep('only-today', prog('{{TODAY}}', 's1', 'today\n'), ignoreAll);
  rep('legacy-skipped', merge(prog('legacy', 's1'), prog(old, 's2')), ignoreAll);
  rep('index-md-dir-skipped', merge(prog('INDEX.md', 's1'), prog(old, 's2')), ignoreAll);
  rep('index-md-file-skipped', merge(P(PR + 'INDEX.md', '# index\n'), prog(old, 's2')), ignoreAll);
  rep('recent-file-kept', merge(prog(old, 's1', 'x\n', -3 * HOUR), prog(old, 's2')), ignoreAll);
  rep('edge-just-old-enough', prog(old, 's1', 'x\n', -6 * HOUR - 5 * 60000), ignoreAll);
  rep('edge-just-too-recent', prog(old, 's1', 'x\n', -6 * HOUR + 5 * 60000), ignoreAll);
  rep('future-mtime-kept', prog(old, 's1', 'x\n', 2 * HOUR), ignoreAll);
  rep('non-md-kept', merge(P(PR + old + '/notes.txt', 'x'), P(PR + old + '/s1.MD', 'x'), P(PR + old + '/s2.md.bak', 'x'), prog(old, 's3')), ignoreAll);
  rep('nested-dir-ignored', merge(P(PR + old + '/sub/s1.md', 'x'), prog(old, 's2')), ignoreAll);
  rep('symlinked-md-ignored', merge(H('target.md', 'x'), { ['proj/' + PR + old + '/lnk.md']: { link: '{{HOME}}/target.md' } }, prog(old, 's2')), ignoreAll);
  rep('dir-named-md', merge(P(PR + old + '/dir.md/x', ''), prog(old, 's2')), ignoreAll);
  rep('date-dir-is-file', merge(P(PR + '2026-08-01', 'x'), prog(old, 's2')), ignoreAll);
  rep('weird-names', merge(prog(old, '.', 'dot\n'), prog(old, 'a.md', 'ammd\n'), prog(old, 'é日本 x', 'uni\n'), prog(old, 'with space', 's\n'), prog(old, '-dash', 'd\n')), ignoreAll);
  rep('name-is-just-md', P(PR + old + '/.md', { content: 'x\n', mtimeOffset: -30 * HOUR }), ignoreAll);
  rep('arbitrary-date-dir-names', merge(prog('not-a-date', 's1'), prog('2026-9-1', 's2'), prog('9999-12-31', 's3'), prog('', 's4')), ignoreAll);
  rep('many-files', merge(...Array.from({ length: 60 }, (_, i) => prog(i % 2 ? old : old2, 's' + String(i).padStart(3, '0'), 'n' + i + '\n', (i % 5 === 0 ? -2 : -30) * HOUR))), ignoreAll);
  // content shapes
  const contents = { empty: '', 'no-newline': 'a', crlf: 'a\r\nb\r\n', 'lone-cr': 'a\rb\r', 'cr-end': 'a\r', 'blank-lines': '\n\n\n', 'unicode': 'é日本😀\n', 'braces': '{pruned_at} {quote} {x}\n', 'long-line': 'x'.repeat(100000) + '\n', 'trailing-crs': 'a\r\r\nb\r\r', 'tabs-controls': 'a\tb\u0001\u0007\n', 'dollar-backslash': 'a $1 $& \\n \\\\ "q"\n', bom: '﻿x\n', nul: 'a\u0000b\n', 'ls-ps': 'a b c\n' };
  for (const [id, c] of Object.entries(contents)) rep('content-' + id, prog(old, 's1', c), ignoreAll);
  rep('content-invalid-utf8', P(PR + old + '/s1.md', { content: Buffer.from([0x61, 0xff, 0xfe, 0x62, 0xc3, 0x28, 0x0a, 0xe2, 0x82]), mtimeOffset: -30 * HOUR }), ignoreAll);
  rep('content-huge', prog(old, 's1', 'line of text\n'.repeat(200000)), ignoreAll);
  // the history ledger
  rep('history-exists-appended', merge(prog(old, 's1', 'new\n'), P(HI + old + '/s1.md', '# existing history\n')), ignoreAll);
  rep('history-exists-no-newline', merge(prog(old, 's1', 'new\n'), P(HI + old + '/s1.md', 'no newline at end')), ignoreAll);
  rep('history-dir-exists-empty', merge(prog(old, 's1'), P(HI + old + '/', '')), ignoreAll);
  rep('history-parent-is-file', merge(prog(old, 's1'), P('.anti-hall/history', 'x')), ignoreAll);
  rep('history-date-is-file', merge(prog(old, 's1'), P(HI + old, 'x')), ignoreAll);
  rep('history-target-is-dir', merge(prog(old, 's1'), P(HI + old + '/s1.md/x', '')), ignoreAll);
  rep('history-target-readonly', merge(prog(old, 's1'), P(HI + old + '/s1.md', { content: 'ro\n', mode: 0o444 })), ignoreAll);
  rep('history-dir-readonly', merge(prog(old, 's1'), P(HI + old + '/x', ''), { }), Object.assign({ exec: [['chmod', '555', 'proj/' + HI + old]] }, ignoreAll));
  rep('history-other-session-untouched', merge(prog(old, 's1'), P(HI + old + '/s9.md', 'other\n')), ignoreAll);
  rep('progress-file-unreadable', prog(old, 's1', 'x\n'), Object.assign({ exec: [['chmod', '000', 'proj/' + PR + old + '/s1.md']] }, ignoreAll));
  rep('progress-dir-unreadable', merge(prog(old, 's1'), prog(old2, 's2')), Object.assign({ exec: [['chmod', '000', 'proj/' + PR + old]] }, ignoreAll));
  rep('progress-dir-absent', P('.anti-hall/other/x', ''), ignoreAll);
  rep('progress-is-file', P('.anti-hall/progress', 'x'), ignoreAll);
  rep('anti-hall-absent', P('src/a.txt', 'x'), ignoreAll);
  // the throttle
  const st = (id, text, extra) => rep('throttle-' + id, merge(prog(old, 's1'), H(STATE, text)), Object.assign({}, ignoreAll, extra || {}));
  st('fresh', `{"{{KEY}}":{"lastPrunedAt":${off(-HOUR)}}}`);
  st('edge-in', `{"{{KEY}}":{"lastPrunedAt":${off(-DAY + 10000)}}}`);
  st('edge-out', `{"{{KEY}}":{"lastPrunedAt":${off(-DAY - 10000)}}}`);
  st('stale', `{"{{KEY}}":{"lastPrunedAt":${off(-3 * DAY)}}}`);
  st('future', `{"{{KEY}}":{"lastPrunedAt":${off(HOUR)}}}`);
  st('other-key-only', `{"cwd_other":{"lastPrunedAt":${off(-HOUR)}},"zz":1}`);
  st('other-keys-kept-and-order', `{"b":1,"{{KEY}}":{"lastPrunedAt":${off(-3 * DAY)},"x":1},"a":{"n":[1,2]}}`);
  st('entry-not-object', '{"{{KEY}}":5}'); st('entry-array', '{"{{KEY}}":[]}'); st('entry-null', '{"{{KEY}}":null}'); st('entry-string', '{"{{KEY}}":"x"}');
  st('lastPrunedAt-string', '{"{{KEY}}":{"lastPrunedAt":"x"}}'); st('lastPrunedAt-null', '{"{{KEY}}":{"lastPrunedAt":null}}'); st('lastPrunedAt-zero', '{"{{KEY}}":{"lastPrunedAt":0}}'); st('lastPrunedAt-negative', '{"{{KEY}}":{"lastPrunedAt":-1}}');
  st('lastPrunedAt-1e999', '{"{{KEY}}":{"lastPrunedAt":1e999}}', { expectDefer: true });
  st('file-array', '[1]'); st('file-null', 'null'); st('file-string', '"x"'); st('file-number', '5'); st('file-malformed', '{"a":'); st('file-empty', ''); st('file-bom', '﻿{}');
  st('file-surrogate', '{"x":"\\ud800"}', { expectDefer: true });
  rep('throttle-absent', prog(old, 's1'), ignoreAll);
  rep('throttle-written-without-work', P(PR + old + '/', ''), ignoreAll);
  rep('throttle-not-written-when-no-progress-dir', P('src/x', ''), ignoreAll);
  rep('throttle-file-is-dir', merge(prog(old, 's1'), { ['home/' + STATE + '/x']: '' }), ignoreAll);
  rep('throttle-bare-home-mkdir', prog(old, 's1'), Object.assign({ bare: true }, ignoreAll));

  // ---- where the project root is -----------------------------------------------------------------------------------------------
  const body = merge(prog(old, 's1'));
  rep('cwd-subdir', merge(body, P('src/deep/x.txt', '')), Object.assign({ payload: { cwd: '{{PROJ}}/src/deep' } }, ignoreAll));
  rep('cwd-subdir-trailing-slash', merge(body, P('src/x.txt', '')), Object.assign({ payload: { cwd: '{{PROJ}}/src/' } }, ignoreAll));
  rep('cwd-dotdot', merge(body, P('src/x.txt', '')), Object.assign({ payload: { cwd: '{{PROJ}}/src/../src/.' } }, ignoreAll));
  rep('cwd-inside-progress', body, Object.assign({ payload: { cwd: '{{PROJ}}/' + PR + old } }, ignoreAll));
  rep('cwd-inside-anti-hall', body, Object.assign({ payload: { cwd: '{{PROJ}}/.anti-hall' } }, ignoreAll));
  rep('cwd-inside-dot-git', body, Object.assign({ payload: { cwd: '{{PROJ}}/.git/hooks' } }, ignoreAll));
  rep('cwd-is-dot-git', body, Object.assign({ payload: { cwd: '{{PROJ}}/.git' } }, ignoreAll));
  rep('cwd-nonexistent', body, Object.assign({ payload: { cwd: '{{PROJ}}/gone' } }, ignoreAll));
  rep('cwd-file', merge(body, P('afile', 'x')), Object.assign({ payload: { cwd: '{{PROJ}}/afile' } }, ignoreAll));
  rep('cwd-symlink-to-repo', body, Object.assign({ payload: { cwd: '{{BASE}}/link' } }, ignoreAll, { exec: [['ln', '-s', '{{PROJ}}', 'link']] }));
  rep('cwd-symlink-to-subdir', merge(body, P('src/x', '')), Object.assign({ payload: { cwd: '{{BASE}}/link' } }, ignoreAll, { exec: [['ln', '-s', '{{PROJ}}/src', 'link']] }));
  rep('cwd-unicode-path', merge(body), Object.assign({}, ignoreAll, { git: ['é日本'], payload: { cwd: '{{BASE}}/é日本' }, files: undefined }));
  out.pop();
  add('cwd-unicode-path', merge(P(PR + old + '/s1.md', { content: 'u\n', mtimeOffset: -30 * HOUR })), { git: ['proj'], afterGit: { 'proj/.gitignore': '.anti-hall/\n' }, payload: { cwd: '{{PROJ}}' } });
  add('non-git-plain-dir', body);
  add('non-git-subdir', merge(body, P('src/x', '')), { payload: { cwd: '{{PROJ}}/src' } });
  add('non-git-subdir-progress-in-sub', merge(P('src/' + PR + old + '/s1.md', { content: 'x\n', mtimeOffset: -30 * HOUR }), P('src/x', '')), { payload: { cwd: '{{PROJ}}/src' } });
  rep('nested-repo-uses-inner', merge(body, P('inner/' + PR + old + '/s9.md', { content: 'inner\n', mtimeOffset: -30 * HOUR })), { git: ['proj', 'proj/inner'], payload: { cwd: '{{PROJ}}/inner' }, afterGit: { 'proj/inner/.gitignore': '.anti-hall/\n', 'proj/.gitignore': '.anti-hall/\n' } });
  rep('nested-plain-subdir-of-repo', merge(body, P('plain/x', '')), Object.assign({ payload: { cwd: '{{PROJ}}/plain' } }, ignoreAll));
  // HOME is a repository (a dotfiles repo): the prune root falls back to cwd, the reminder does not
  add('home-is-repo-cwd-in-home', merge(H('work/' + PR + old + '/w1.md', { content: 'work\n', mtimeOffset: -30 * HOUR }), H(PR + old2 + '/h1.md', { content: 'home\n', mtimeOffset: -30 * HOUR })), { git: ['home'], payload: { cwd: '{{HOME}}/work' }, afterGit: { 'home/.gitignore': '.anti-hall/\n' } });
  add('home-is-repo-cwd-is-home', merge(H(PR + old + '/h1.md', { content: 'home\n', mtimeOffset: -30 * HOUR })), { git: ['home'], payload: { cwd: '{{HOME}}' }, afterGit: { 'home/.gitignore': '.anti-hall/\n' } });
  add('home-is-repo-hint', merge(H(PR + old + '/h1.md', { content: 'home\n', mtimeOffset: -30 * HOUR })), { git: ['home'], payload: { cwd: '{{HOME}}' } });
  add('repo-inside-home-dir', merge(body), { git: ['proj'], afterGit: ignoreAll.afterGit });
  // a `.git` file (a linked worktree or a submodule)
  const wt = (id, gitfile, extra) => add('gitfile-' + id, merge(body, { 'proj/.git': gitfile }), Object.assign({ afterGit: undefined, payload: { cwd: '{{PROJ}}' } }, extra || {}));
  add('worktree-real', merge(body), { exec: [['git', 'init', '-q', 'main'], ['git', '-C', 'main', 'commit', '-q', '--allow-empty', '-m', 'x'], ['git', '-C', 'main', 'worktree', 'add', '-q', '{{PROJ}}', '-b', 'wtb']], payload: { cwd: '{{PROJ}}' }, files: undefined });
  out.pop();
  add('worktree-real', {}, { exec: [['git', 'init', '-q', 'main'], ['git', '-C', 'main', 'commit', '-q', '--allow-empty', '-m', 'x'], ['git', '-C', 'main', 'worktree', 'add', '-q', '{{PROJ}}', '-b', 'wtb']], afterGit: { 'proj/.anti-hall/progress/2026-09-01/s1.md': 'wt\n', 'main/.git/info/exclude': '.anti-hall/\n' }, payload: { cwd: '{{PROJ}}' } });
  add('worktree-real-hint', {}, { exec: [['git', 'init', '-q', 'main'], ['git', '-C', 'main', 'commit', '-q', '--allow-empty', '-m', 'x'], ['git', '-C', 'main', 'worktree', 'add', '-q', '{{PROJ}}', '-b', 'wtb']], afterGit: { 'proj/.anti-hall/progress/x': '' }, payload: { cwd: '{{PROJ}}' } });
  add('worktree-subdir', {}, { exec: [['git', 'init', '-q', 'main'], ['git', '-C', 'main', 'commit', '-q', '--allow-empty', '-m', 'x'], ['git', '-C', 'main', 'worktree', 'add', '-q', '{{PROJ}}', '-b', 'wtb']], afterGit: { 'proj/sub/x': '', 'proj/.anti-hall/progress/x': '' }, payload: { cwd: '{{PROJ}}/sub' } });
  const realGit = { exec: [['git', 'init', '-q', 'realgit']] };
  // gitdir files of the usual shape point at a real git directory; other shapes are read by JavaScript's pattern (Node decides)
  const gf = (id, content, extra) => add('gitfile-' + id, merge(body, { 'proj/.git': content }), Object.assign({ exec: [['git', 'init', '-q', '--bare', 'bare.git']], payload: { cwd: '{{PROJ}}' } }, extra || {}));
  gf('abs', 'gitdir: {{BASE}}/bare.git\n'); gf('abs-no-newline', 'gitdir: {{BASE}}/bare.git'); gf('rel', 'gitdir: ../bare.git\n'); gf('rel-dot', 'gitdir: ./../bare.git\n');
  gf('missing-target', 'gitdir: {{BASE}}/nowhere\n'); gf('target-is-file', 'gitdir: {{BASE}}/home\n'); gf('no-gitdir-text', 'hello\n'); gf('empty', ''); gf('binary', '\u0000\u0001\u0002');
  gf('upper', 'GITDIR: {{BASE}}/bare.git\n'); gf('no-space', 'gitdir:{{BASE}}/bare.git\n', { expectDefer: true }); gf('two-spaces', 'gitdir:  {{BASE}}/bare.git\n', { expectDefer: true });
  gf('trailing-space', 'gitdir: {{BASE}}/bare.git \n', { expectDefer: true }); gf('crlf', 'gitdir: {{BASE}}/bare.git\r\n', { expectDefer: true }); gf('leading-space', ' gitdir: {{BASE}}/bare.git\n', { expectDefer: true });
  gf('two-lines', 'gitdir: {{BASE}}/bare.git\ngitdir: {{BASE}}/other\n', { expectDefer: true }); gf('blank-first', '\ngitdir: {{BASE}}/bare.git\n', { expectDefer: true }); gf('empty-path', 'gitdir: \n', { expectDefer: true });
  gf('comment-first', '# c\ngitdir: {{BASE}}/bare.git\n', { expectDefer: true });
  add('gitfile-symlink-to-dir', merge(body, { 'proj/.git': { link: '{{BASE}}/bare.git' } }), { exec: [['git', 'init', '-q', '--bare', 'bare.git']], payload: { cwd: '{{PROJ}}' } });
  add('gitdir-empty-dir', merge(body, { 'proj/.git/': '' }), { payload: { cwd: '{{PROJ}}' } });
  add('gitdir-dir-with-junk', merge(body, { 'proj/.git/x': 'y' }), { afterGit: undefined, payload: { cwd: '{{PROJ}}' } });

  // ---- the gitignore reminder -----------------------------------------------------------------------------------------------------
  const hint = (id, files, extra) => rep('hint-' + id, files, extra);
  const anti = P('.anti-hall/x', '');
  hint('not-ignored', anti);
  hint('ignored-gitignore', anti, ignoreAll);
  hint('ignored-no-slash', anti, { afterGit: { 'proj/.gitignore': '.anti-hall\n' } });
  hint('ignored-glob', anti, { afterGit: { 'proj/.gitignore': '.anti-*\n' } });
  hint('ignored-info-exclude', anti, { afterGit: { 'proj/.git/info/exclude': '.anti-hall/\n' } });
  hint('not-ignored-other-pattern', anti, { afterGit: { 'proj/.gitignore': 'node_modules/\n' } });
  hint('negated', anti, { afterGit: { 'proj/.gitignore': '.anti-hall/\n!.anti-hall/probe\n' } });
  hint('negated-dir', anti, { afterGit: { 'proj/.gitignore': '.anti-hall/*\n!.anti-hall/probe\n' } });
  hint('ignored-only-progress', anti, { afterGit: { 'proj/.gitignore': '.anti-hall/progress/\n' } });
  hint('ignored-global-xdg', merge(anti, H('.config/git/ignore', '.anti-hall/\n')), { env: { XDG_CONFIG_HOME: '{{HOME}}/.config' } });
  hint('ignored-global-default-xdg', merge(anti, H('.config/git/ignore', '.anti-hall/\n')));
  hint('ignored-global-excludesfile', merge(anti, H('.gitconfig', '[core]\n\texcludesFile = {{HOME}}/gl\n'), H('gl', '.anti-hall/\n')));
  hint('ignored-core-excludesfile-env', merge(anti, H('gl2', '.anti-hall/\n')), { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '{{HOME}}/gl2' } });
  hint('anti-hall-is-file', P('.anti-hall', 'x'));
  hint('anti-hall-symlink-to-dir', { }, { exec: [['mkdir', 'realdir'], ['ln', '-s', '{{BASE}}/realdir', 'proj/.anti-hall']] });
  hint('anti-hall-dangling-symlink', {}, { exec: [['ln', '-s', '{{BASE}}/nowhere', 'proj/.anti-hall']] });
  hint('anti-hall-empty-dir', P('.anti-hall/', ''));
  hint('env-git-dir-scrubbed', anti, { env: { GIT_DIR: '{{BASE}}/nowhere' } });
  hint('env-git-work-tree-scrubbed', anti, { env: { GIT_WORK_TREE: '{{BASE}}/nowhere' } });
  hint('env-git-index-scrubbed', anti, { env: { GIT_INDEX_FILE: '{{BASE}}/nowhere' } });
  hint('env-git-common-dir-scrubbed', anti, { env: { GIT_COMMON_DIR: '{{BASE}}/nowhere' } });
  hint('env-git-prefix-scrubbed', anti, { env: { GIT_PREFIX: 'zz/' } });
  hint('env-git-ceiling', anti, { env: { GIT_CEILING_DIRECTORIES: '{{BASE}}' } });
  hint('env-no-path', anti, { env: { PATH: '/nonexistent' } });
  hint('env-empty-path', anti, { env: { PATH: '' } });
  hint('env-path-unset', anti, { env: { PATH: null } });
  hint('env-switch-off', anti, { env: { ANTIHALL_GITIGNORE_HINT: 'off' } });
  hint('env-switch-on', anti, { env: { ANTIHALL_GITIGNORE_HINT: 'on' } });
  hint('env-switch-junk', anti, { env: { ANTIHALL_GITIGNORE_HINT: 'zz' } });
  hint('settings-off', merge(anti, H('.anti-hall/settings.json', q({ guards: { gitignoreHint: false } }))));
  hint('settings-on-env-off', merge(anti, H('.anti-hall/settings.json', q({ guards: { gitignoreHint: true } }))), { env: { ANTIHALL_GITIGNORE_HINT: '0' } });
  hint('option-off', anti, { env: { CLAUDE_PLUGIN_OPTION_GUARDS_GITIGNORE_HINT: 'false' } });
  hint('stored-option-off', merge(anti, H('.claude/settings.json', q({ pluginConfigs: { 'anti-hall': { options: { guards_gitignore_hint: false } } } }))));
  hint('prune-off-hint-on', merge(anti, prog(old, 's1'), H('.anti-hall/settings.json', q({ maintenance: { progressPrune: false } }))));
  hint('prune-off-hint-off', merge(anti, prog(old, 's1'), H('.anti-hall/settings.json', q({ maintenance: { progressPrune: false }, guards: { gitignoreHint: false } }))));
  hint('prune-on-hint-on', merge(anti, prog(old, 's1')));
  hint('prune-on-hint-ignored', merge(anti, prog(old, 's1')), ignoreAll);
  // a stand-in git that answers with a chosen exit code, after an optional pause: the probe's three outcomes
  const fakeGit = (code, sleep) => ({ ['home/bin/git']: { content: `#!/bin/sh\n${sleep ? 'sleep ' + sleep + '\n' : ''}${code === 'kill' ? 'kill -9 $$' : 'exit ' + code}\n`, mode: 0o755 } });
  const fakePath = { env: { PATH: '{{HOME}}/bin:' + process.env.PATH } };
  for (const c of [0, 1, 2, 3, 127, 128, 255, 'kill']) hint('fake-git-exit-' + c, merge(anti, fakeGit(c)), fakePath);
  hint('fake-git-slow-ignored', merge(anti, fakeGit(0, 2.7)), Object.assign({ expectDefer: true }, fakePath));
  hint('fake-git-slow-not-ignored', merge(anti, fakeGit(1, 2.7)), Object.assign({ expectDefer: true }, fakePath));
  hint('fake-git-fast-not-ignored', merge(anti, fakeGit(1, 0.2)), fakePath);
  hint('fake-git-not-executable', merge(anti, { ['home/bin/git']: { content: '#!/bin/sh\nexit 1\n', mode: 0o644 } }), fakePath);
  // the weekly state
  const gs = (id, text, extra) => hint('state-' + id, merge(anti, H(GSTATE, text)), extra);
  gs('fresh', `{"{{PROJ}}":${off(-HOUR)}}`); gs('edge-in', `{"{{PROJ}}":${off(-7 * DAY + 10000)}}`); gs('edge-out', `{"{{PROJ}}":${off(-7 * DAY - 10000)}}`); gs('stale', `{"{{PROJ}}":${off(-30 * DAY)}}`);
  gs('future', `{"{{PROJ}}":${off(HOUR)}}`); gs('other-project', `{"/elsewhere":${off(-HOUR)}}`); gs('other-kept-order', `{"/b":1,"{{PROJ}}":${off(-30 * DAY)},"/a":2}`);
  gs('string-value', '{"{{PROJ}}":"x"}'); gs('null-value', '{"{{PROJ}}":null}'); gs('object-value', `{"{{PROJ}}":{"a":1}}`); gs('negative', '{"{{PROJ}}":-1}'); gs('zero', '{"{{PROJ}}":0}');
  gs('array', '[]'); gs('null', 'null'); gs('malformed', '{'); gs('empty', ''); gs('number', '5'); gs('surrogate', '{"x":"\\ud800"}', { expectDefer: true });
  hint('state-is-dir', merge(anti, { ['home/' + GSTATE + '/x']: '' }));
  hint('state-bare-home', anti, { bare: true });
  hint('state-written-once-then-quiet', anti, { env: {} });

  // ---- payloads --------------------------------------------------------------------------------------------------------------------
  const pl = merge(prog(old, 's1'), anti);
  rep('payload-no-cwd', pl, { payload: { cwd: undefined } });
  rep('payload-empty-cwd', pl, { payload: { cwd: '' } });
  rep('payload-number-cwd', pl, { payload: { cwd: 5 } });
  rep('payload-null-cwd', pl, { payload: { cwd: null } });
  rep('payload-relative-cwd', pl, { payload: { cwd: 'proj' }, expectDefer: true });
  rep('payload-dot-cwd', pl, { payload: { cwd: '.' }, expectDefer: true });
  rep('payload-malformed', pl, { raw: '{', expectDefer: true });
  rep('payload-empty', pl, { raw: '', expectDefer: true });
  rep('payload-null', pl, { raw: 'null', expectDefer: true });
  rep('payload-array', pl, { raw: '[]', expectDefer: true });
  rep('payload-other-event', pl, { payload: { hook_event_name: 'Stop' }, expectDefer: true });
  rep('payload-subagent', pl, { payload: { agent_id: 'x' } });
  rep('payload-source-fields', pl, { payload: { source: 'resume', model: 'm', transcript_path: '/x' } });
  rep('payload-huge', pl, { payload: { junk: 'x'.repeat(300000) } });
  // the maintenance switch (it has no environment variable)
  out.push(...switchMatrix(hook, { files: merge(prog(old, 's1'), anti), extra: { git: ['proj'], env: { ANTIHALL_GITIGNORE_HINT: 'off' } } },
    { section: 'maintenance', key: 'progressPrune', env: [], option: 'maintenance_progress_prune', guard: 'progress-prune' }));
  return out;
};
