'use strict';
// Parity: the 15 Bash pre/post guard invocations (12 files) expose
// evaluate(payload, env, { argv }) -> { exitCode, stdout, stderr } and never call
// process.exit; their CLI wrapper must behave BYTE-IDENTICALLY to evaluate().
// Every case runs twice, each from its own freshly seeded temp HOME: once as a spawned CLI and once
// in-process (the in-process runs share ONE process, so module state that leaks
// between calls shows up as a diff). Block cases carry an explicit expectation so the
// parity cannot pass vacuously on all-allow output.
//
// Corpus: a generic built-in command list always runs; point
// ANTIHALL_PARITY_CORPUS at a JSON array of command strings to add your own.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'plugins', 'anti-hall', 'hooks');
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' }; // main-thread (coordinator) marker
const CONCURRENCY = 6;

const GUARDS = {
  'git-guard': { file: 'git-guard.js' },
  'command-guard': { file: 'command-guard.js' },
  'coordinator-work-guard': { file: 'coordinator-work-guard.js' },
  'merge-side-pick': { file: 'merge-side-pick.js' },
  'merge-gate': { file: 'merge-gate.js' },
  'scan-throttle': { file: 'scan-throttle.js' },
  'api-guard': { file: 'api-guard.js' },
  'ship-it-guard': { file: 'ship-it-guard.js' },
  'output-verify-guard': { file: 'output-verify-guard.js' },
  'devswarm-parent-reply-tracker': { file: 'devswarm-parent-reply-tracker.js' },
  'devswarm-child-drain': { file: 'devswarm-child-drain.js' },
  'compact-declaration-guard': { file: 'compact-declaration-guard.js' },
};
for (const g of Object.values(GUARDS)) g.mod = require(path.join(HOOKS, g.file));

// ---- payload builders -------------------------------------------------------
const pre = (command, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 's1', cwd: ROOT }, extra || {});
const post = (command, response, extra) => Object.assign({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: response || { stdout: '', stderr: '' }, session_id: 's1', tool_use_id: 'tu1', cwd: ROOT }, extra || {});
const write = (file_path, content, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content }, session_id: 's1', cwd: ROOT }, extra || {});

// Dangerous git strings are built from pieces (git-guard scans this very file's text).
const FORCE_PUSH = 'git push --' + 'force origin main';
const CREDIT = 'Co-Authored' + '-By: Claude <noreply@anthropic.com>';
const STASH = 'git sta' + 'sh';

let transcriptSeq = 0;
// A distinct file per call: the case list is built eagerly, so a shared path would be overwritten.
function transcript(h, entries) {
  const p = path.join(h.home, 'transcript-' + (transcriptSeq++) + '.jsonl');
  fs.writeFileSync(p, entries.map((m) => JSON.stringify(m)).join('\n') + '\n');
  return p;
}
const user = (text) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });

// ---- the hand-built cases ---------------------------------------------------
// build(h) -> { payload | raw, env?, argv? }; expect: { exitCode, stdout?: RegExp, stderr?: RegExp, quiet?: true }
const CASES = [];
function add(guard, name, build, expect) { CASES.push({ guard, name, build, expect }); }
const MODE = { argv: ['--post'] };

// git-guard (pre + --audit)
add('git-guard', 'allow plain status', () => ({ payload: pre('git status') }), { exitCode: 0, quiet: true });
add('git-guard', 'block force push (stderr only)', () => ({ payload: pre(FORCE_PUSH) }), { exitCode: 2, stderr: /git-guard/ });
add('git-guard', 'block AI credit trailer in commit', () => ({ payload: pre('git commit -m "feat: x" -m "' + CREDIT + '"') }), { exitCode: 2, stderr: /git-guard/ });
add('git-guard', 'block + file-write tip', () => ({ payload: pre("cat > notes.md <<'EOF'\n" + CREDIT + '\nEOF\ngit commit -F notes.md') }), null);
add('git-guard', 'unparseable stdin', () => ({ raw: '{bad json' }), { exitCode: 0, quiet: true });
add('git-guard', 'no command', () => ({ payload: { tool_name: 'Bash', tool_input: {} } }), { exitCode: 0, quiet: true });
add('git-guard', '--audit with a self-credit HEAD commit', (h) => {
  const repo = path.join(h.home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '-A');
  g('commit', '-q', '-m', 'x', '-m', CREDIT);
  return { payload: post('git commit -m x', { stdout: '' }, { cwd: repo }), argv: ['--audit'] };
}, { exitCode: 0, stdout: /audit/ });
add('git-guard', '--audit clean', () => ({ payload: post('git status'), argv: ['--audit'] }), { exitCode: 0, quiet: true });

// command-guard
add('command-guard', 'heavy command blocks the main thread', () => ({ payload: pre('npm test'), env: COORD }), { exitCode: 2, stdout: /"decision":"block"/, stderr: /command-guard/ });
add('command-guard', 'bounded verify passes', () => ({ payload: pre('node --test tests/a.test.js | tail -5'), env: COORD }), { exitCode: 0, quiet: true });
add('command-guard', 'subagent passes a heavy command', () => ({ payload: pre('npm test', { agent_id: 'sub-1' }), env: COORD }), { exitCode: 0, quiet: true });
add('command-guard', 'devswarm native read is redirected', () => ({ payload: pre('hivecontrol workspace read-messages'), env: Object.assign({ DEVSWARM_REPO_ID: 'repo-1' }, COORD) }), { exitCode: 2, stderr: /command-guard|devswarm/ });
add('command-guard', 'devswarm native send is redirected', () => ({ payload: pre('hivecontrol workspace message-child abc "hi"'), env: Object.assign({ DEVSWARM_REPO_ID: 'repo-1' }, COORD) }), { exitCode: 2, stderr: /command-guard|devswarm/ });
add('command-guard', 'armed stash guard blocks a mutating stash', () => ({ payload: pre(STASH), env: Object.assign({ ANTIHALL_STASH_GUARD: '1' }, COORD) }), { exitCode: 2, stderr: /stash/i });
add('command-guard', 'unarmed stash passes', () => ({ payload: pre(STASH), env: COORD }), null);
add('command-guard', 'bash edit parity (sed -i)', () => ({ payload: pre("sed -i 's/a/b/' src/app.js"), env: COORD }), null);
add('command-guard', 'bash edit parity (redirect write)', () => ({ payload: pre('echo x > src/app.js'), env: COORD }), null);
add('command-guard', 'unparseable stdin', () => ({ raw: 'nope' }), { exitCode: 0, quiet: true });

// coordinator-work-guard
const CW_BLOCK = { ANTIHALL_COORDINATOR_WORK_BLOCK_AT: '1', ANTIHALL_COORDINATOR_WORK_NUDGE_AT: '1', ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS: '3000' };
add('coordinator-work-guard', 'pre blocks the first WORK call at blockAt=1', () => ({ payload: pre('git commit -qm x'), env: Object.assign({}, COORD, CW_BLOCK) }), { exitCode: 2, stdout: /"decision":"block"/ });
add('coordinator-work-guard', 'pre allows a non-work call', () => ({ payload: pre('ls'), env: Object.assign({}, COORD, CW_BLOCK) }), { exitCode: 0, quiet: true });
add('coordinator-work-guard', 'post nudges on the crossing', () => ({ payload: post('git commit -qm x'), env: Object.assign({}, COORD, CW_BLOCK), argv: ['--post'] }), { exitCode: 0, stdout: /additionalContext/ });
add('coordinator-work-guard', 'post quiet below nudgeAt', () => ({ payload: post('ls'), env: COORD, argv: ['--post'] }), { exitCode: 0, quiet: true });

// merge-side-pick
const SIDE_PICK = 'git checkout --' + 'ours a.txt';
add('merge-side-pick', 'pre advises a push after an untested side-pick', (h) => {
  require(path.join(HOOKS, 'lib', 'merge-side-pick.js')).record(h.home, 's1', SIDE_PICK);
  return { payload: pre('git push origin dev') };
}, { exitCode: 0, stdout: /additionalContext/ });
add('merge-side-pick', 'pre quiet with no side-pick', () => ({ payload: pre('git push origin dev') }), { exitCode: 0, quiet: true });
add('merge-side-pick', 'post records the side-pick', () => ({ payload: post(SIDE_PICK), argv: ['--post'] }), { exitCode: 0, quiet: true });

// merge-gate
const MG = { ANTIHALL_MERGE_GATE: '1' };
add('merge-gate', 'blocks an auto-merge after an unresolved hedge', (h) => ({ payload: pre('gh pr merge 42 --squash', { transcript_path: transcript(h, [assistantMessage('Built the dashboard, pending review by you.')]) }), env: MG }), { exitCode: 2, stderr: /merge-gate/ });
add('merge-gate', 'allows when no hedge', (h) => ({ payload: pre('gh pr merge 42 --squash', { transcript_path: transcript(h, [assistantMessage('All verified.')]) }), env: MG }), { exitCode: 0, quiet: true });
add('merge-gate', 'default off', (h) => ({ payload: pre('gh pr merge 42 --squash', { transcript_path: transcript(h, [assistantMessage('pending review')]) }) }), { exitCode: 0, quiet: true });
add('merge-gate', 'unparseable stdin', () => ({ raw: '' , env: MG }), { exitCode: 0, quiet: true });

// scan-throttle
const ST = { ANTI_HALL_THROTTLE_PATTERNS: '^\\s*reindex-repo\\b' };
add('scan-throttle', 'advises throttling a first-command scan', () => ({ payload: pre('reindex-repo --full'), env: ST }), { exitCode: 0, stdout: /scan-throttle/ });
add('scan-throttle', 'generic note for a compound scan', () => ({ payload: pre('cd app && reindex-repo --full'), env: ST }), null);
add('scan-throttle', 'quiet for an unrelated command', () => ({ payload: pre('ls -la'), env: ST }), { exitCode: 0, quiet: true });

// api-guard (python3 only: the probe fail-opens without it)
const HAS_PY = (() => { try { return spawnSync('python3', ['--version'], { timeout: 4000 }).status === 0; } catch (_) { return false; } })();
add('api-guard', 'blocks a fabricated node API', () => ({ payload: write(path.join(os.tmpdir(), 'x.js'), "const fs = require('fs');\nfs.quantumFork();\n") }), { exitCode: 2, stdout: /"decision":"block"/ });
if (HAS_PY) add('api-guard', 'blocks a fabricated python API', () => ({ payload: write(path.join(os.tmpdir(), 'x.py'), 'import os\nos.quantum_fork()\n') }), { exitCode: 2, stdout: /quantum_fork/ });
add('api-guard', 'allows real APIs', () => ({ payload: write(path.join(os.tmpdir(), 'x.js'), "const fs = require('fs');\nfs.readFileSync('x');\n") }), { exitCode: 0, quiet: true });
add('api-guard', 'shell write of fabricated code (Bash tool, reason on stderr)', () => ({ payload: pre("cat > " + path.join(os.tmpdir(), 'x.js') + " <<'EOF'\nconst fs = require('fs');\nfs.quantumFork();\nEOF") }), null);
add('api-guard', 'unparseable stdin', () => ({ raw: '{' }), { exitCode: 0, quiet: true });

// ship-it-guard
const SI = { ANTIHALL_SHIPIT_GATE: '1' };
add('ship-it-guard', 'blocks an L-risk file with no PLAN.md', (h) => ({ payload: write(path.join(h.home, '.github', 'workflows', 'deploy.yml'), 'x', { cwd: h.home }), env: SI }), { exitCode: 2, stderr: /ship-it-guard/ });
add('ship-it-guard', 'advises on an out-of-plan file', (h) => {
  fs.writeFileSync(path.join(h.home, 'PLAN.md'), '# Plan\n\n## Phases\n\n### Phase 1\n- files: src/a.js\n');
  return { payload: write(path.join(h.home, 'src', 'b.js'), 'x', { cwd: h.home }), env: SI };
}, null);
add('ship-it-guard', 'shell write needs the plan too', (h) => ({ payload: pre('echo x > .github/workflows/ci.yml', { cwd: h.home }), env: SI }), null);
add('ship-it-guard', 'default off', (h) => ({ payload: write(path.join(h.home, '.github', 'workflows', 'deploy.yml'), 'x', { cwd: h.home }) }), { exitCode: 0, quiet: true });

// output-verify-guard (post)
add('output-verify-guard', 'advises on a mixed pass/fail run', () => ({ payload: post('npm test', { stdout: 'FAIL src/foo.test.js\nTests: 2 failed, 8 passed, 10 total\n', stderr: '' }) }), { exitCode: 0, stdout: /output-verify-guard/ });
add('output-verify-guard', 'quiet on a clean run', () => ({ payload: post('node --test', { stdout: 'Tests: 2 passed, 2 total\n', stderr: '' }) }), { exitCode: 0, quiet: true });
add('output-verify-guard', 'quiet on a non-runner command', () => ({ payload: post('grep PASS FAIL file.txt', { stdout: 'PASS FAIL', stderr: '' }) }), { exitCode: 0, quiet: true });
add('output-verify-guard', 'unparseable stdin', () => ({ raw: '{' }), { exitCode: 0, quiet: true });

// devswarm-child-drain (post): a child workspace with an unread durable message
const REPO_KEY = 'repo-1';
const CHILD = { DEVSWARM_REPO_ID: REPO_KEY, DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' };
function seedChild(h, unread) {
  const dsw = path.join(h.home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(dsw, 'child-1.inbox.ndjson');
  const cursorPath = path.join(dsw, 'child-1.cursor');
  fs.mkdirSync(path.join(dsw, 'workspaces'), { recursive: true });
  const lines = [];
  for (let i = 0; i < unread; i++) lines.push(JSON.stringify({ from: 'primary-abc', to: 'child-1', type: 'direct', message: 'm' + i, timestamp: Date.now() + i }));
  fs.writeFileSync(inboxPath, lines.join('\n') + (lines.length ? '\n' : ''));
  fs.writeFileSync(cursorPath, '0');
  fs.writeFileSync(path.join(dsw, 'workspaces', 'child-1.json'), JSON.stringify({ id: 'child-1', inboxPath, cursorPath, worktreePath: ROOT }));
}
add('devswarm-child-drain', 'child with unread mail is nudged to drain', (h) => { seedChild(h, 2); return { payload: post('git status'), env: CHILD }; }, null);
add('devswarm-child-drain', 'child with an empty inbox is quiet', (h) => { seedChild(h, 0); return { payload: post('git status'), env: CHILD }; }, { exitCode: 0, quiet: true });
add('devswarm-child-drain', 'a non-devswarm session is quiet', () => ({ payload: post('git status') }), { exitCode: 0, quiet: true });
add('devswarm-child-drain', 'a subagent of the child is quiet', (h) => { seedChild(h, 2); return { payload: post('git status', {}, { agent_id: 'sub-1' }), env: CHILD }; }, { exitCode: 0, quiet: true });
add('devswarm-child-drain', 'unparseable stdin still reads the env', (h) => { seedChild(h, 2); return { raw: '{bad', env: CHILD }; }, null);

// devswarm-parent-reply-tracker (post; side-effect only)
add('devswarm-parent-reply-tracker', 'a send receipt from a Primary', () => ({
  payload: post('node devswarm.js send --to w1 --message hi', { stdout: JSON.stringify({ ok: true, action: 'send', type: 'direct', toId: 'w1', sent: true }) + '\n', stderr: '' }),
  env: { DEVSWARM_REPO_ID: REPO_KEY },
}), { exitCode: 0, quiet: true });
add('devswarm-parent-reply-tracker', 'a child workspace is ignored', () => ({ payload: post('ls'), env: CHILD }), { exitCode: 0, quiet: true });
add('devswarm-parent-reply-tracker', 'unparseable stdin', () => ({ raw: '{' }), { exitCode: 0, quiet: true });

// compact-declaration-guard
const DECL = (h) => transcript(h, [user('go'), assistantMessage('Work is saved. SAFE TO COMPACT.')]);
add('compact-declaration-guard', 'blocks new work after a SAFE TO COMPACT declaration', (h) => ({ payload: pre('git push origin dev', { transcript_path: DECL(h) }) }), { exitCode: 2, stdout: /"decision":"block"/, stderr: /compact-declaration-guard/ });
add('compact-declaration-guard', 'read-only Bash passes', (h) => ({ payload: pre('ls -la', { transcript_path: DECL(h) }) }), { exitCode: 0, quiet: true });
add('compact-declaration-guard', 'a subagent passes', (h) => ({ payload: pre('git push origin dev', { transcript_path: DECL(h), agent_id: 'sub-1' }) }), { exitCode: 0, quiet: true });
add('compact-declaration-guard', 'no declaration passes', (h) => ({ payload: pre('git push origin dev', { transcript_path: transcript(h, [user('go'), assistantMessage('Working on it.')]) }) }), { exitCode: 0, quiet: true });

// ---- the generic command corpus ---------------------------------------------
function builtinCorpus() {
  const out = [];
  const tests = ['tests/a.test.js', 'tests/b.test.js', 'src/foo_test.py', 'pkg/x_test.go'];
  const verbs = ['npm test', 'npm run build', 'npm install', 'npx vitest run', 'pytest -q', 'cargo build', 'cargo test', 'make all', 'make -j8', 'go build ./...', 'go test ./...', 'gradle build', 'mvn package', 'docker build .', 'docker compose up', 'pip install -r requirements.txt', 'yarn install', 'pnpm build', 'tsc --noEmit', 'eslint .'];
  const piped = [' | tail -5', ' | head -20', ' 2>&1 | tail -30', ' | wc -l', ''];
  for (const v of verbs) for (const p of piped.slice(0, 3)) out.push(v + p);
  for (const t of tests) { out.push('node --test ' + t + ' | tail -5'); out.push('node --test ' + t); out.push('pytest -q ' + t + ' | tail'); }
  const git = ['status', 'status --short', 'diff', 'diff --stat HEAD~1', 'log --oneline -5', 'show HEAD', 'branch -a', 'add -A', 'add src/a.js', 'commit -m "fix: thing"', 'commit -qm wip', 'commit --amend --no-edit', 'push', 'push origin dev', 'push -u origin feature', 'pull --rebase', 'fetch origin', 'checkout -b feature', 'checkout -- a.txt', 'switch dev', 'merge dev', 'rebase origin/dev', 'rebase --abort', 'cherry-pick abc123', 'revert HEAD', 'reset --soft HEAD~1', 'tag v1.2.3', 'tag -l', 'remote -v', 'rev-parse HEAD', 'worktree list', 'clean -n', 'blame a.txt', 'ls-files', 'config --get user.name', 'stash list', 'diff origin/dev...HEAD'];
  for (const g of git) out.push('git ' + g);
  out.push('git add -A && git commit -m "msg" && git push', 'git -C /tmp/some/repo status', 'cd src && git status', 'git commit -m "$(cat <<\'EOF\'\nfeat: add thing\n\nbody text\nEOF\n)"', 'git log --format=%H -n 3 | xargs git show --stat');
  out.push('gh pr create --title t --body b', 'gh pr merge 12 --squash', 'gh pr view 3', 'gh issue list', 'gh run list --limit 5', 'gh api repos/o/r/pulls', 'gh pr review 4 --approve', 'gh release create v1 --notes n');
  const files = ['ls', 'ls -la', 'ls -R src | head', 'pwd', 'cat README.md', 'head -50 file.txt', 'tail -f log.txt', 'wc -l *.js', 'find . -name "*.js" | head', 'find src -type f -newer a', 'grep -rn TODO src | head', 'grep -c foo bar.txt', 'rg pattern', 'sed -n "1,40p" a.js', 'sed -i "s/a/b/" a.js', 'sed -i.bak "s/a/b/" src/*.js', 'awk "{print $1}" data.txt', 'sort a | uniq -c', 'diff a b', 'cmp a b', 'stat file', 'file x.bin', 'du -sh .', 'df -h', 'which node', 'type git', 'echo hello', 'echo "a" > out.txt', 'echo a >> out.txt', 'printf "x\\n" | tee out.log', 'tee out.txt < in.txt', 'cp a.js b.js', 'mv a.js b.js', 'rm a.tmp', 'mkdir -p out/dir', 'touch x', 'chmod +x run.sh', 'ln -s a b', 'tar czf a.tgz src', 'unzip -q a.zip', 'curl -s http://localhost:3000/health', 'python3 -c "print(1)"', 'python3 -c "open(\'x.txt\',\'w\').write(\'a\')"', 'node -e "console.log(1)"', 'node -e "require(\'fs\').writeFileSync(\'x\',\'a\')"', 'node script.js', 'node scripts/build.js --check', 'bash run.sh', 'sh -c "echo hi"', 'bash -c "git status && ls"', './deploy.sh', 'source venv/bin/activate && pytest', 'eval "$(ssh-agent -s)"', 'env FOO=1 node a.js', 'FOO=1 BAR=2 node a.js', 'nice -n 19 make', 'time make', 'timeout 30 npm test', 'xargs -n1 echo < list.txt', 'for f in *.js; do node --check $f; done', 'while true; do sleep 1; done', 'sleep 30; echo done', 'kill 1234', 'ps aux | grep node', 'lsof -i :3000', 'uptime', 'date', 'whoami', 'uname -a', 'export A=1 && echo $A', 'cd /tmp && ls', '(cd src && ls)', '{ ls; pwd; }', 'ls $(pwd)', 'echo `date`', 'cat a.txt | sh', 'cat a.md | bash', 'bash x.md', 'bash -s < script.sh', 'tee >(bash) < in.txt', 'exec ls', 'command ls', 'sudo ls', 'ls; rm -rf build', 'test -f a && echo yes || echo no', '[ -d src ] && ls src', 'node --version', 'npm --version', 'reindex-repo --full', 'graphify update .', 'cd app && graphify update'];
  for (const f of files) out.push(f);
  out.push('node scripts/devswarm.js inbox read-primary abc', 'node scripts/devswarm.js send --to w1 --message hi', 'hivecontrol workspace list', 'hivecontrol workspace read-messages', 'hivecontrol workspace message-parent hi');
  out.push('echo "git push --' + 'force"', 'echo ' + FORCE_PUSH, "bash -c '" + FORCE_PUSH + "'", 'git commit -m "msg" -m "' + CREDIT + '"', 'echo "' + CREDIT + '" > notes.md', "git commit -F - <<'EOF'\nfeat: x\n\n" + CREDIT + '\nEOF');
  return out;
}

function corpus() {
  const list = builtinCorpus();
  const extra = process.env.ANTIHALL_PARITY_CORPUS;
  if (extra) { try { for (const c of JSON.parse(fs.readFileSync(extra, 'utf8'))) if (typeof c === 'string') list.push(c); } catch (_) { /* ignore a bad path */ } }
  return list;
}

// Heavy: shape-sensitive guards see the whole corpus; the rest a slice.
const FULL = [['git-guard', {}, 'pre'], ['command-guard', COORD, 'pre'], ['coordinator-work-guard', Object.assign({}, COORD, CW_BLOCK), 'pre'], ['scan-throttle', ST, 'pre']];
const SLICE = [['merge-side-pick', {}, 'pre'], ['merge-gate', MG, 'pre'], ['api-guard', {}, 'pre'], ['ship-it-guard', SI, 'pre'], ['output-verify-guard', {}, 'post'], ['coordinator-work-guard', Object.assign({}, COORD, CW_BLOCK), 'post', MODE], ['merge-side-pick', {}, 'post', MODE], ['git-guard', {}, 'post', { argv: ['--audit'] }], ['devswarm-parent-reply-tracker', {}, 'post'], ['devswarm-child-drain', CHILD, 'post']];
const SLICE_N = 40;
const commands = corpus();
for (const [guard, env, kind, mode] of FULL) commands.forEach((c, i) => add(guard, 'corpus#' + i + ' ' + JSON.stringify(c).slice(0, 60), () => ({ payload: kind === 'pre' ? pre(c) : post(c), env, argv: mode && mode.argv }), null));
for (const [guard, env, kind, mode] of SLICE) commands.slice(0, SLICE_N).forEach((c, i) => add(guard, 'corpus#' + i + ' ' + JSON.stringify(c).slice(0, 60), () => ({ payload: kind === 'pre' ? pre(c) : post(c, { stdout: 'PASS 1\nFAIL 1\n', stderr: '' }), env, argv: mode && mode.argv }), null));

// ---- runners ----------------------------------------------------------------
function isolatedEnv(home, extra) {
  return Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1' }, extra || {});
}
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(process.env)) saved[k] = process.env[k];
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
// maskSha: a commit made in two separately seeded repos differs by its (timestamp-dependent) sha only.
function normalize(r, homes, maskSha) {
  let s = JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
  if (maskSha) s = s.replace(/\b[0-9a-f]{7,40}\b/g, '<SHA>');
  for (const h of homes) for (const v of new Set([h, fs.realpathSync(h)])) s = s.split(JSON.stringify(v).slice(1, -1)).join('<HOME>');
  return s;
}
function prepare(c) {
  const h = makeHome();
  const b = c.build(h);
  return { h, b, env: isolatedEnv(h.home, b.env) };
}
function runInProcess(c, p) {
  const g = GUARDS[c.guard];
  return withEnv(p.env, () => {
    const payload = p.b.raw !== undefined ? undefined : p.b.payload;
    return g.mod.evaluate(payload, p.env, { argv: p.b.argv || [] });
  });
}
function runCli(c, p) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HOOKS, GUARDS[c.guard].file), ...(p.b.argv || [])], { env: p.env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }); });
    child.stdin.end(p.b.raw !== undefined ? p.b.raw : JSON.stringify(p.b.payload));
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

test('evaluate() and the CLI wrapper agree byte-for-byte on every guard case', async (t) => {
  // Two independently seeded homes per case: the in-process run and the CLI run
  // must not share state (stateful guards would otherwise see the other's writes).
  const prepared = CASES.map((c) => ({ c, inproc: prepare(c), cli: prepare(c) }));
  for (const p of prepared) {
    try { p.ev = runInProcess(p.c, p.inproc); } catch (e) { p.ev = { error: String(e && e.stack || e) }; }
  }
  await pool(prepared, CONCURRENCY, async (p) => { p.cliRes = await runCli(p.c, p.cli); });

  const mismatches = [];
  const seen = { blocks: 0, outputs: 0 };
  for (const p of prepared) {
    const { c } = p;
    const label = c.guard + ': ' + c.name;
    try {
      assert.ok(!p.ev.error, label + ' evaluate threw: ' + p.ev.error);
      assert.strictEqual(typeof p.ev.exitCode, 'number', label + ' evaluate() must return {exitCode, stdout, stderr}');
      const mask = c.name.indexOf('--audit with a self-credit') === 0;
      const a = normalize(p.cliRes, [p.cli.h.home], mask);
      const b = normalize(p.ev, [p.inproc.h.home], mask);
      if (a !== b) mismatches.push(label + '\n  cli : ' + a.slice(0, 400) + '\n  eval: ' + b.slice(0, 400));
      if (p.cliRes.exitCode === 2) seen.blocks++;
      if (p.cliRes.stdout || p.cliRes.stderr) seen.outputs++;
      if (c.expect) {
        const e = c.expect;
        assert.strictEqual(p.cliRes.exitCode, e.exitCode, label + ' exit code; stdout=' + p.cliRes.stdout.slice(0, 200) + ' stderr=' + p.cliRes.stderr.slice(0, 200));
        if (e.stdout) assert.match(p.cliRes.stdout, e.stdout, label + ' stdout');
        if (e.stderr) assert.match(p.cliRes.stderr, e.stderr, label + ' stderr');
        if (e.quiet) { assert.strictEqual(p.cliRes.stdout, '', label + ' quiet stdout'); assert.strictEqual(p.cliRes.stderr, '', label + ' quiet stderr'); }
      }
    } catch (err) { mismatches.push(String(err.message || err)); }
    p.cli.h.cleanup(); p.inproc.h.cleanup();
  }
  t.diagnostic(CASES.length + ' cases (' + commands.length + ' corpus commands), ' + seen.blocks + ' exit-2 blocks, ' + seen.outputs + ' with output');
  assert.deepStrictEqual(mismatches, [], mismatches.length + ' parity/expectation failures:\n' + mismatches.slice(0, 5).join('\n'));
  // Not vacuous: the corpus + hand cases must exercise real blocks and real output.
  assert.ok(seen.blocks >= 15, 'only ' + seen.blocks + ' block cases ran');
  assert.ok(seen.outputs >= 25, 'only ' + seen.outputs + ' cases produced output');
  assert.ok(CASES.length >= 200, 'only ' + CASES.length + ' cases');
});

test('an exit-2 block survives in-process, even when the caller wraps evaluate() in fail-open try/catch', () => {
  // The defect this refactor closes: a guard that signalled a block through process.exit() inside a
  // caller's fail-open block turned into an allow when grouped in-process. A returned decision cannot.
  const h = makeHome();
  try {
    const cases = [
      ['git-guard', pre(FORCE_PUSH), {}],
      ['command-guard', pre('npm test'), COORD],
      ['merge-gate', pre('gh pr merge 1', { transcript_path: transcript(h, [assistantMessage('first-pass, do not merge')]) }), MG],
      ['ship-it-guard', write(path.join(h.home, '.github', 'workflows', 'a.yml'), 'x', { cwd: h.home }), SI],
      ['api-guard', write(path.join(os.tmpdir(), 'x.js'), "const fs = require('fs');\nfs.quantumFork();\n"), {}],
      ['coordinator-work-guard', pre('git commit -qm x'), Object.assign({}, COORD, CW_BLOCK)],
      ['compact-declaration-guard', pre('git push origin dev', { transcript_path: DECL(h) }), {}],
    ];
    const realExit = process.exit;
    let exits = 0;
    process.exit = () => { exits++; };
    try {
      for (const [guard, payload, extra] of cases) {
        const env = isolatedEnv(h.home, extra);
        let d = null;
        try { d = withEnv(env, () => GUARDS[guard].mod.evaluate(payload, env, { argv: [] })); } catch (_) { /* fail-open caller */ }
        assert.ok(d && d.exitCode === 2, guard + ' must still block in-process, got ' + JSON.stringify(d));
      }
    } finally { process.exit = realExit; }
    assert.strictEqual(exits, 0, 'a guard called process.exit inside evaluate()');
  } finally { h.cleanup(); }
});

test('no guard file calls process.exit outside its CLI wrapper', () => {
  for (const g of Object.values(GUARDS)) {
    const src = fs.readFileSync(path.join(HOOKS, g.file), 'utf8');
    assert.ok(!/process\.exit\(/.test(src), g.file + ' still calls process.exit');
    assert.ok(/require\.main === module/.test(src), g.file + ' needs a require.main CLI wrapper');
    assert.strictEqual(typeof g.mod.evaluate, 'function', g.file + ' must export evaluate');
  }
});
