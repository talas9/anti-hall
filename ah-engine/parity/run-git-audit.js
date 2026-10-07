#!/usr/bin/env node
// Parity of the built-in `git-audit` check against `hooks/git-guard.js --audit` (PostToolUse on Bash). Fixture repositories are
// built in each home (Node's and the engine's) with fixed author and commit dates, so both see the same hashes and ages.
//   node run-git-audit.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--mode daemon|oneshot] [--conc 6] [--show 15] [--real 1500] [--seed 1]
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { arg, runParity, readCmds, rng } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const T0 = Math.floor(Date.now() / 1000);
let n = 0;
const sid = () => `g${n++}`;
const add = (steps, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps });

// the trailer text is assembled so this file itself never carries a credit line
const CREDIT = ['Co-Authored', 'By: Claude <noreply@anthropic.com>'].join('-');
const GEN = '\u{1F916} ' + ['Generated', 'with [Claude Code](https://claude.com/claude-code)'].join(' ');
const REPOS = {
  recent: [{ m: 'feat: x\n\n' + CREDIT, age: 60 }],
  old: [{ m: 'feat: x\n\n' + CREDIT, age: 3000 }],
  clean: [{ m: 'feat: clean', age: 30 }, { m: 'fix: clean2', age: 20 }],
  mixed: [{ m: 'one', age: 100 }, { m: 'two\n\n' + CREDIT, age: 50 }, { m: 'three\n\n' + GEN, age: 10 }, { m: 'four', age: 5 }],
  generated: [{ m: 'x\n\n' + GEN, age: 40 }],
  lower: [{ m: 'x\n\n' + CREDIT.toLowerCase().replace('claude <noreply@anthropic.com>', 'GPT <x@openai.com>'), age: 40 }],
  escaped: [{ m: 'x \\n\\n' + CREDIT, age: 40 }],
  human: [{ m: 'x\n\nCo-authored-by: Alice <alice@example.com>', age: 40 }],
  twentyfive: Array.from({ length: 25 }, (_, i) => ({ m: i === 0 ? 'oldest\n\n' + CREDIT : 'c' + i, age: 200 - i })),
  emptymsg: [{ m: ' ', age: 30 }],
  unicode: [{ m: 'ünï ☃ \u{1F600}\n\n' + CREDIT, age: 25 }],
  'sp ace': [{ m: 'x\n\n' + CREDIT, age: 25 }],
  empty: [],
};
const ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, args, env) => cp.execFileSync('git', args, { cwd, env: Object.assign({}, ENV, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
function commit(dir, msg, age, i) {
  fs.writeFileSync(path.join(dir, 'f.txt'), 'v' + i + '\n');
  git(dir, ['add', '-A']);
  const d = '@' + (T0 - age) + ' +0000';
  const msgFile = path.join(dir, '.msg');
  fs.writeFileSync(msgFile, msg);
  git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty-message', '--cleanup=verbatim', '-F', msgFile], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  fs.unlinkSync(msgFile);
}
function setup(home) {
  for (const [name, commits] of Object.entries(REPOS)) {
    const dir = path.join(home, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    commits.forEach((c, i) => commit(dir, c.m, c.age, i));
  }
  const aliased = path.join(home, 'aliased');
  fs.mkdirSync(aliased, { recursive: true });
  git(aliased, ['init', '-q', '-b', 'main']);
  commit(aliased, 'a\n\n' + CREDIT, 30, 0);
  for (const [k, v] of Object.entries({ 'alias.ci': 'commit', 'alias.cm': 'commit -m', 'alias.sh': '!git commit -m x', 'alias.st': 'status', 'alias.chain': 'ci', 'alias.loop': 'loop', 'alias.opt': '-c x.y=1 commit', 'alias.rb': 'rebase' })) git(aliased, ['config', k, v]);
  fs.mkdirSync(path.join(home, 'recent', 'sub dir'), { recursive: true });
}
const H = '$HOME';
const post = (s, command, extra) => ({ payload: Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: s, cwd: H + '/recent', tool_input: { command } }, extra || {}), argv: ['--audit'] });
const ctx = { setup };
const one = (cmd, cwdRepo, extra) => add([post(sid(), cmd, Object.assign({ cwd: H + '/' + (cwdRepo || 'recent') }, extra || {}))], ctx, `u-${(cwdRepo || 'recent')}-${cmd.slice(0, 30)}`);

const VERBS = ['git commit -m x', 'git commit --amend --no-edit', 'git cherry-pick abc', 'git revert HEAD', 'git merge other', 'git rebase main', 'git rebase -i HEAD~3', 'git pull', 'git am x.patch', 'git commit -am msg', 'git tag -a v1 -m x', 'git stash', 'git push', 'git status', 'git log', 'git diff', 'git add .', 'git checkout x', 'git switch x', 'git reset --hard', 'git fetch', 'git ci -m x', 'git cm x', 'git sh', 'git st', 'git chain', 'git loop', 'git opt', 'git rb', 'git unknownsub', 'git', 'git -C /nonexistent commit -m x', 'GIT_DIR=x git commit', 'FOO=1 git commit -m x', 'sudo git commit -m x', 'env git commit -m x', 'command git commit -m x', 'time git commit -m x', 'nice git commit -m x', 'xargs git commit', 'echo git commit', 'echo "git commit"', 'ls', 'true'];
const REPONAMES = Object.keys(REPOS).filter(r => r !== 'empty');
for (const r of [...REPONAMES, 'empty', 'aliased']) for (const v of VERBS) one(v, r);
// wrappers and structure
const WRAP = c => [c, `bash -c '${c}'`, `sh -c "${c}"`, `eval "${c}"`, `eval '${c}'`, `bash -lc "${c}"`, `zsh -c '${c}'`, `(${c})`, `{ ${c}; }`, `echo x && ${c}`, `${c} && echo done`, `false; ${c}`, `true || ${c}`, `${c} &`, `${c} | cat`, `echo $(${c})`, `cat <<EOF\n${c}\nEOF`, `FOO=1 ${c}`, `bash -c "bash -c '${c}'"`, `eval "eval '${c}'"`, `bash -c "eval 'bash -c \\"${c}\\"'"`, `echo '${c}' | sh`, `xargs -I{} sh -c "{}" <<< "${c}"`];
for (const w of WRAP('git commit -m x')) for (const r of ['recent', 'clean', 'mixed']) one(w, r);
for (const w of WRAP('git -C $HOME/mixed commit -m x')) one(w, 'clean');
// cd handling and -C forms
for (const c of ['cd $HOME/mixed && git commit -m x', 'cd mixed && git commit -m x', 'cd .. && cd mixed && git commit -m x', 'cd /nonexistent && git commit -m x', 'cd -- && git commit', 'cd -P $HOME/mixed && git commit', 'cd && git commit', 'cd ~ && git commit', 'cd "$HOME/mixed" && git commit', "cd '$HOME/sp ace' && git commit", 'cd $HOME/sp\\ ace && git commit',
  'git -C $HOME/mixed commit -m x', 'git -C mixed commit -m x', 'git -C ../mixed commit -m x', 'git -C $HOME/mixed -c user.name=x commit', 'git -c user.name=x -C $HOME/mixed commit', 'git --git-dir=$HOME/mixed/.git commit', 'git --git-dir $HOME/mixed/.git commit', 'git --work-tree=$HOME/mixed commit', 'git --namespace x commit', 'git --no-pager -C $HOME/mixed commit', 'git -C $HOME/mixed -C $HOME/clean commit', 'git -C $HOME/mixed -C ../clean commit', 'git -C . commit', 'git -C ./sub\\ dir commit', 'git -C "sub dir" commit',
  'cd $HOME/mixed && git commit -m x; cd $HOME/clean && git commit -m y', 'cd $HOME/mixed; git commit; cd $HOME/recent; git commit', 'cd $HOME/mixed && git commit && cd $HOME/mixed && git commit', 'git -C $HOME/mixed commit; git -C $HOME/mixed commit', 'git -C $HOME/mixed commit; git -C $HOME/recent commit; git -C $HOME/old commit', 'git -C $HOME/clean commit; git -C $HOME/old commit',
  '(cd $HOME/mixed && git commit)', 'bash -c "cd $HOME/mixed && git commit"', 'cd $HOME/mixed\ngit commit', 'cd $HOME/mixed && bash -c "git commit"', 'pushd $HOME/mixed && git commit', 'cd $HOME/mixed || git commit', 'cd $HOME/aliased && git ci', 'cd $HOME/aliased && git cm x', 'cd $HOME/aliased && git sh', 'cd $HOME/aliased && git chain', 'git -C $HOME/aliased ci -m x', 'git -C $HOME/aliased st']) one(c, pick(['recent', 'clean', 'sub dir']));
add([post(sid(), 'git commit -m x', { cwd: H + '/recent/sub dir' })], ctx, 'u-cwd-subdir');
// shapes (the Bash matcher of the hook wiring, not the hook, is what keeps other tools out, so no tool-name shapes here)
const base = () => post(sid(), 'git commit -m x');
for (const [k, f] of Object.entries({
  noInput: p => { delete p.payload.tool_input; }, nullInput: p => { p.payload.tool_input = null; }, cmdNum: p => { p.payload.tool_input.command = 5; }, cmdEmpty: p => { p.payload.tool_input.command = ''; }, noCmd: p => { p.payload.tool_input = {}; },
  noCwd: p => { delete p.payload.cwd; }, cwdEmpty: p => { p.payload.cwd = ''; }, cwdNum: p => { p.payload.cwd = 5; }, cwdRel: p => { p.payload.cwd = 'recent'; }, cwdMissing: p => { p.payload.cwd = '/nonexistent/dir'; }, cwdNotRepo: p => { p.payload.cwd = '/tmp'; }, cwdSlash: p => { p.payload.cwd = H + '/recent/'; },
  noSid: p => { delete p.payload.session_id; },
})) { const p = base(); f(p); add([p], ctx, `shape-${k}`); }
add([post(sid(), 'git commit', { cwd: H + '/old' })], ctx, 'win-old');
// switches
const sw = { off: { guards: { gitGuard: false } }, safetyOff: { safety: { gitGuard: false } }, safetyStr: { safety: { gitGuard: 'off' } }, safetyOn: { safety: { gitGuard: 'on' } }, junk: { safety: { gitGuard: 'zz' } } };
for (const [k, s] of Object.entries(sw)) add([post(sid(), 'git commit -m x', {}), post(sid(), 'git -C $HOME/mixed commit')], { setup, settings: s }, `ctx-${k}`);
for (const [k, e] of Object.entries({ envOff: { ANTIHALL_GIT_GUARD: 'off' }, env0: { ANTIHALL_GIT_GUARD: '0' }, env1: { ANTIHALL_GIT_GUARD: '1' }, optFalse: { CLAUDE_PLUGIN_OPTION_SAFETY_GIT_GUARD: 'false' } })) add([post(sid(), 'git commit -m x'), post(sid(), 'git -C $HOME/mixed commit')], { setup, env: e }, `ctx-${k}`);
for (const [k, s] of Object.entries({ skip: { 'git-guard': Date.now() + 3600e3 }, skipAll: { all: Date.now() + 3600e3 }, skipExpired: { 'git-guard': Date.now() - 1000 }, skipJunk: '{no' })) add([post(sid(), 'git commit -m x'), post(sid(), 'git -C $HOME/mixed commit')], { setup, skip: s }, `ctx-${k}`);
// real commands, run in a fixture repo
const cmds = readCmds(arg('--cmds', '../../fpr/cmds.jsonl'));
const gitCmds = cmds.filter(c => /\bgit\b/.test(c.cmd));
for (let i = 0; i < Math.min(+arg('--real', 1500), gitCmds.length); i++) add([post(sid(), gitCmds[Math.floor(R() * gitCmds.length)].cmd, { cwd: H + '/' + pick(['recent', 'mixed', 'clean', 'aliased']) })], ctx, `real-${i}`);
// fuzz
const WS = [' ', '\t', '\n', ';', '&&', '||', '|', '&', ' \\\n'];
const frag = ['git', 'commit', '-m', 'x', '-C', '$HOME/mixed', '$HOME/recent', 'cd', 'eval', 'bash', '-c', '"git commit"', "'git commit'", '$(', ')', '`', '(', ')', '-c', 'user.name=x', '--amend', 'ci', 'sh', 'sudo', 'env', 'FOO=1', '--git-dir', '$HOME/mixed/.git'];
for (let i = 0; i < 1500; i++) { const parts = []; for (let j = 0, k = 1 + Math.floor(R() * 10); j < k; j++) parts.push(pick(frag), pick(WS)); add([post(sid(), parts.join(''), { cwd: H + '/' + pick(['recent', 'mixed', 'aliased']) })], ctx, `fuzz-${i}`); }
console.error(`scenarios=${scenarios.length}`);
runParity({ name: 'git-audit', check: 'git-audit', hookFile: 'git-guard.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'daemon'), events: ['PostToolUse'], conc: +arg('--conc', 6), show: +arg('--show', 15), nodeArgv: () => ['--audit'] });
