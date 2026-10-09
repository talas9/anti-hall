#!/usr/bin/env node
// Adversarial and fuzz corpus for run-command.js: node fuzz-command.js [--n 6000] [--seed 7] > fuzz.jsonl
// Part 1 is a fixed list of hand-written edge shapes aimed at each ported rule (light-exception look-alikes, the
// lookahead entries across newlines, quoting and escape tricks, heredocs, comments, process substitution, test
// operators, nested shells, write-target forms, gh/gcloud/sqlite grammars, non-ASCII). Part 2 is random: commands
// assembled from a vocabulary of verbs, flags, words, quotes and operators that the rules care about.
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--n', 6000), SEED = +arg('--seed', 7), UNICODE = +arg('--unicode', 0);
let s = SEED >>> 0; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = a => a[Math.floor(rnd() * a.length)];

const FIXED = [
  'node scripts/jev-report.js', 'node scripts/jev-report.js label x', 'node scripts/jev-report.js\nlabel', 'node scripts/jev-report.js; label',
  'node a/scripts/jev-report.js/scripts/jev-report.js x', 'node scripts/jev-report.jsx', 'NODE scripts/jev-report.js', 'X=1 node scripts/jev-report.js --since 1d',
  'node hooks/doctor.js', 'node hooks/doctor.js --repair', 'node hooks/doctor.js\n--repair', 'node hooks/doctor.js --repairs', 'node /x/hooks/doctor.js --fix-it',
  'go env', 'go env -w X=1', 'go env\n-w', 'go env GOPATH -w', 'go envx', 'cd x && go env -wx', 'go  env  -w', 'go env\t-w',
  'node scripts/settings.js show', 'node scripts/settings.js set x', 'node scripts/defect.js list', 'node scripts/defect.js rule', 'node statusline/phase.js',
  'node scripts/devswarm.js list', 'node skills/update/scripts/update.js', 'node "skills/update/scripts/update.js"', 'node skills/update/scripts/update.js.evil',
  'node companion/install-devswarm-supervisor.js', 'node ~/.anti-hall/bin/wake-watch.js', 'node $HOME/.anti-hall/bin/wake-watch.js',
  'git fetch', 'git fetch origin', 'git fetch --prune', 'git fetch origin +refs/heads/*:refs/x', 'git -C x fetch', 'git --git-dir=x fetch -p', 'git -c a=b fetch', 'git fetch origin main:main',
  'git push', 'git push --dry-run', 'git pull --dry-run origin', 'git clone x', 'git status && git push', 'echo git push', "echo 'git push'", 'GIT push',
  'sqlite3 -readonly db.sqlite "select 1"', 'sqlite3 db -readonly', 'sqlite3 -readonly db ".shell ls"', 'sqlite3 -readonly db < x.sql', 'cat x | sqlite3 -readonly db', 'sqlite3 -readonly db "ATTACH x"',
  'gh pr list', 'gh pr merge 1', 'gh pr view 1 --json x', 'gh api repos/x', 'gh api -X POST x', 'gh api x -f a=b', 'gh api graphql -f query=\'{ viewer { login } }\'',
  'gh api graphql -f query=\'mutation { x }\'', 'gh api graphql -F query=@q.graphql', 'gh workflow run x', 'gh constructor x', 'gh __proto__ x', 'gh secret set X', 'echo gh list',
  'gcloud run services list', 'gcloud run services describe x --region us', 'gcloud logging read "x" --limit 5', 'gcloud secrets versions access latest', 'gcloud compute ssh x',
  'gcloud projects list --format json | head -5', 'gcloud projects list | grep -c x', 'gcloud --version', 'firebase --version', 'helm -V', 'gcloud x list 2>&1', 'kubectl get pods', 'kubectl get pods delete',
  'node -e "console.log(1)"', 'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"', 'node -e "fs.readFileSync(\'x\')"', 'node -e "fs.cpSync(\'a\',\'b\')"', 'node --eval "x[\'y\']()"', 'node -e', 'node -p 1',
  'python3 -m pytest -q x.py', 'python3 -u script.py', 'node --inspect app.js', 'node app.js', 'deno run x', 'timeout 5 npm test', 'timeout -s KILL 5 git status', 'nice -n 5 npm test', 'sudo -u x npm i',
  'echo hi > out.txt', 'echo hi >> $LOG', 'echo hi > ~/x', 'echo hi >| f', 'echo hi &> f', 'echo hi 2>&1 > f', 'echo \\> f', 'echo "a > b"', 'echo a\\\\> f', 'echo hi >/dev/null 2>&1', 'echo > "x y"',
  'tee -a log', 'tee', 'sed -i "" s/a/b/ f', 'sed -i.bak s/a/b/ f', 'sed -e s/a/b/ -i f', 'sed -n 1p f', 'sed --in-place=.b s/x/y/ f', 'perl -pi -e s/a/b/ f', 'perl -e 1 f', 'perl -i f',
  'cp a b', 'cp a b/', 'cp -t dir a b', 'cp -tdir a', 'mv a b', 'cp a $D', 'mv x* y', 'cp a', 'cp -- a b', 'install a b', 'cp -S .x a b',
  'python3 -c "print(1)"', 'python3 -c "open(\'x\',\'w\').write(1)"', 'ruby -e "File.write(\'x\',1)"', 'perl -e \'open(F, ">x")\'',
  'cat <<EOF\nnpm test\nEOF', 'bash <<EOF\nnpm test\nEOF', 'bash <<\'EOF\'\necho > f\nEOF', 'cat <<EOF | sh\nmake\nEOF', 'cat <<-EOF\n\tx\n\tEOF\nls',
  'ls # npm test', 'ls #; npm test', 'ls \\# npm test', 'a=#; npm test', '# npm test\nls', "echo $'a\\' ; npm test'", "echo $'x' ; npm test",
  'diff <(sort a) <(sort b)', 'tee >(grep x) out.txt', 'cat <(npm test)', 'echo $((3 > 2))', '(( n > 5 )) && echo', '[[ a > b ]] && echo', 'if [[ x > y ]]; then ls; fi', '[ a > b ]',
  'echo ${HOME}/x > ${OUT}', 'echo ${A}x > f', 'bash -c "echo > f"', 'sh -c \'cd x && npm test\'', 'eval "make"', 'eval echo hi', 'bash -lc "ls"', 'zsh -xc "make"',
  'echo $(echo $(echo $(echo $(npm test))))', 'echo `make`', 'x=$(git push)', 'echo "$(npm run build)"', "echo '$(npm run build)'",
  'for f in *; do npm test; done', 'while true; do make; done', 'if npm test; then :; fi', '! npm test', 'then npm test', 'do make',
  'grep deploy x', 'grep -e deploy x', 'awk "/npm test/" f', 'sed "s/npm run build//" f', 'grep -A 5 npm test',
  'xargs npm test', 'find . | xargs -n1 make', 'env FOO=1 npm test', 'command npm test', 'exec make', 'taskpolicy -c utility nice -n 19 make',
  'git stash', 'git stash list', 'hivecontrol workspace monitor', 'devswarm workspace read-messages', 'cat ~/.anti-hall/devswarm/inbox/a.json', 'cat restore.txt',
  'echo café', 'ls é', 'echo   npm test', 'echo ſx', 'echo K', 'ls -la', 'printf "\\x00"',
  '', ' ', '\n', ';', '&&', '|', '()', '$(', '`', "'", '"', '\\', 'a\\', '<<', '<<EOF', 'cat <<', 'echo $\'', 'echo "unterminated', "echo 'unterminated",
  'npm', 'NPM test', 'Npm run build', './npm test', '/usr/bin/npm test', 'npm.cmd test', 'yarn', 'pnpm build', 'cargo --version', 'cargo version', 'cargo build', 'docker ps', 'docker build .',
];

const VERBS = ['ls', 'cat', 'echo', 'git', 'npm', 'node', 'python3', 'gh', 'gcloud', 'sed', 'cp', 'mv', 'tee', 'grep', 'bash', 'sh', 'eval', 'timeout', 'sudo', 'env', 'xargs', 'sqlite3', 'go', 'make', 'docker', 'perl', 'kubectl', 'cd', 'find', 'awk', 'head', 'tail', 'wc'];
const ARGS = ['-c', '-e', '-i', '-n', '-f', '-t', '-p', '--prune', '--dry-run', '--version', 'push', 'pull', 'fetch', 'status', 'log', 'list', 'get', 'describe', 'run', 'test', 'build', 'pr', 'api', 'graphql', 'merge', 'x.py', 'a.js', 'f.txt', 'dir/', '/tmp/x', '$X', '~/y', '*.js', '-readonly', 'db', 'env', '-w', 'scripts/jev-report.js', 'label', 'hooks/doctor.js', '--repair', 'origin', 'main', '1', '5'];
const OPS = [' ', ' ', ' ', ' && ', ' || ', '; ', ' | ', '\n', ' & ', ' > ', ' >> ', ' 2>&1 ', ' < ', ' $(', ') ', ' `', '` ', ' <(', ' >(', ' "', '" ', " '", "' ", ' \\', ' #', ' <<EOF\nx\nEOF\n', ' ((', ')) ', ' [[ ', ' ]] '];
const out = [];
for (const c of FIXED) out.push({ command: c, source: 'adversarial' });
while (out.length < N) {
  let c = '';
  const k = 1 + Math.floor(rnd() * 8);
  for (let i = 0; i < k; i++) {
    c += pick(VERBS);
    const a = Math.floor(rnd() * 4);
    for (let j = 0; j < a; j++) c += ' ' + pick(ARGS);
    if (i < k - 1) c += pick(OPS);
  }
  out.push({ command: c, source: 'fuzz' });
}
// Part 3 (--unicode N): non-ASCII characters injected into commands that carry a DevSwarm, stash, mailbox or inbox trigger, and
// into plain ones, to test the engine's trigger test on non-ASCII text (blank-like, joining, case-folding and astral characters).
const ODD = ['\u00a0', '\u2028', '\u2029', '\u3000', '\ufeff', '\u200b', '\u0085', '\u212a', '\u0130', '\u00e9', '\u0301', '\u2014', '\u{1F600}', '\ud83d', '\u017f', '\u1680', '\u180e'];
const TRIG = ['git stash', 'git stash pop', 'git stash list', 'hivecontrol workspace monitor', 'hivecontrol workspace read-messages', 'hivecontrol workspace message-child x', 'devswarm workspace read-messages',
  'node scripts/devswarm.js inbox', 'node scripts/devswarm.js send x', 'cat ~/.anti-hall/devswarm/inbox/a.json', 'ls ~/.anti-hall/devswarm/store', 'cat inbox/x', 'head store/y', 'echo "stash"', "echo 'devswarm.js'",
  'bash -c "hivecontrol workspace monitor"', 'echo $(hivecontrol workspace monitor)', 'eval "git stash"', 'sudo hivecontrol workspace monitor', 'FOO=1 hivecontrol workspace monitor', 'npm test', 'echo hi > out.txt', 'ls'];
const inject = c => { const n = 1 + Math.floor(rnd() * 3); let r = c; for (let i = 0; i < n; i++) { const at = Math.floor(rnd() * (r.length + 1)); r = r.slice(0, at) + pick(ODD) + r.slice(at); } return r; };
for (let i = 0; i < UNICODE; i++) { let c = pick(TRIG); if (rnd() < 0.3) c = c + pick(OPS) + pick(TRIG); out.push({ command: inject(c), source: 'unicode', cwd: rnd() < 0.15 ? '/tmp/' + pick(ODD) + '/inbox' : '/tmp' }); }
for (const o of out) console.log(JSON.stringify({ cwd: '/tmp', ...o }));
