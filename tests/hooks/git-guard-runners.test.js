'use strict';
// git-guard: commands run through a wrapper (stdbuf, caffeinate, ionice,
// flock, setsid, chrt, taskset, doas), through a `sh -c` script that forwards
// its positional args, or through `find -exec` get the checks a direct run
// gets - directly and under xargs. Every case goes through the real hook
// entry (a PreToolUse Bash payload piped to git-guard.js) with an isolated
// HOME and a temp cwd. Dangerous command strings are assembled from pieces.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const home = makeHome();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gg-runners-'));
after(() => { fs.rmSync(work, { recursive: true, force: true }); home.cleanup(); });

const P = 'pu' + 'sh';
const F = '--for' + 'ce';
const FP = `git ${P} ${F} origin main`;

function run(cmd) {
  const payload = bashPayload(cmd);
  payload.cwd = work;
  return testHook('git-guard.js', payload, { home: home.home });
}
const block = (label, cmd) => test('BLOCK ' + label, () => {
  const r = run(cmd);
  assert.strictEqual(r.status, 2, `expected block for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
});
const allow = (label, cmd) => test('ALLOW ' + label, () => {
  const r = run(cmd);
  assert.strictEqual(r.status, 0, `expected allow for ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
});

// ---- 1. wrappers and their option grammars --------------------------------
block('stdbuf -o0', 'stdbuf -o0 ' + FP);
block('stdbuf -o 0', 'stdbuf -o 0 ' + FP);
block('stdbuf --output=L -e0', 'stdbuf --output=L -e0 ' + FP);
block('stdbuf --error 0', 'stdbuf --error 0 ' + FP);
block('caffeinate', 'caffeinate ' + FP);
block('caffeinate -dims -t 60', 'caffeinate -dims -t 60 ' + FP);
block('caffeinate -it60', 'caffeinate -it60 ' + FP);
block('caffeinate -w 123', 'caffeinate -w 123 ' + FP);
block('ionice -c3', 'ionice -c3 ' + FP);
block('ionice -c 2 -n 7', 'ionice -c 2 -n 7 ' + FP);
block('ionice --class idle', 'ionice --class idle ' + FP);
block('flock FILE', 'flock /tmp/l ' + FP);
block('flock -w 5 -x FILE', 'flock -w 5 -x /tmp/l ' + FP);
block('flock -E 3 FILE', 'flock -E 3 /tmp/l ' + FP);
block('flock FILE -c', `flock /tmp/l -c '${FP}'`);
block('flock -n FILE --command', `flock -n /tmp/l --command '${FP}'`);
block('setsid -f', 'setsid -f ' + FP);
block('setsid -w', 'setsid -w ' + FP);
block('chrt -r 10', 'chrt -r 10 ' + FP);
block('chrt -b 0', 'chrt -b 0 ' + FP);
block('chrt 5', 'chrt 5 ' + FP);
block('taskset 0x3', 'taskset 0x3 ' + FP);
block('taskset -c 0,1', 'taskset -c 0,1 ' + FP);
block('doas', 'doas ' + FP);
block('doas -u root', 'doas -u root ' + FP);
block('doas -n', 'doas -n ' + FP);
block('stacked wrappers', 'nice -n 5 stdbuf -o0 ionice -c3 caffeinate setsid ' + FP);
block('xargs stdbuf', 'echo x | xargs stdbuf -o0 ' + FP);
block('xargs caffeinate (xargs-run push)', `echo x | xargs caffeinate git ${P} origin main`);
block('xargs flock FILE', `echo x | xargs flock /tmp/l git ${P} origin main`);
block('xargs -n1 taskset', 'echo x | xargs -n1 taskset 1 ' + FP);
block('xargs doas -n', 'echo x | xargs doas -n ' + FP);
block('xargs ionice', 'echo x | xargs ionice -c3 ' + FP);
block('xargs setsid', 'echo x | xargs setsid ' + FP);
block('xargs chrt', 'echo x | xargs chrt -o 0 ' + FP);
block('xargs flock -c', `echo x | xargs flock /tmp/l -c '${FP}'`);
allow('stdbuf git log', 'stdbuf -o0 git log --oneline');
allow('flock git status', 'flock /tmp/l git status');
allow('flock -c git status', "flock /tmp/l -c 'git status'");
allow('caffeinate -i npm test', 'caffeinate -i npm test');
allow('ionice -c3 npm test', 'ionice -c3 npm test');
allow('taskset 1 git log', 'taskset 1 git log -1');

// ---- 2. sh -c scripts that forward their positional args ------------------
block("sh -c '$0 $@' git ...", `sh -c '$0 $@' ${FP}`);
block("bash -c '\"$@\"' _ git ...", `bash -c '"$@"' _ ${FP}`);
block("sh -c 'exec \"$0\" \"$@\"'", `sh -c 'exec "$0" "$@"' ${FP}`);
block("sh -c '$1 $2 $3 $4 $5' _", `sh -c '$1 $2 $3 $4 $5' _ ${FP}`);
block("bash -c '${0} ${1} ${2}'", `bash -c '\${0} \${1} \${2}' git ${P} ${F}`);
block("sh -c 'cd x && \"$@\"'", `sh -c 'cd x && "$@"' _ ${FP}`);
block("bash -c 'git \"$@\"' _ push --force", `bash -c 'git "$@"' _ ${P} ${F} origin main`);
block('unquoted $1 word-splits', `sh -c '$0 $1' git "${P} ${F} origin main"`);
block("xargs -n1 sh -c '$0 $@' git ...", `echo x | xargs -n1 sh -c '$0 $@' ${FP}`);
block('xargs sh -c "$@": stdin words can add --force', `echo ${F} | xargs sh -c '"$@"' _ git ${P} origin main`);
allow("sh -c '$0 $@' git status", "sh -c '$0 $@' git status");
allow("sh -c 'cd \"$1\" && git status' _ sub", `sh -c 'cd "$1" && git status' _ sub`);
allow("xargs -n1 sh -c 'echo \"$0\"'", `echo a | xargs -n1 sh -c 'echo "$0"'`);
allow("xargs sh -c 'git log \"$@\"' _", `echo a | xargs sh -c 'git log --oneline "$@"' _`);

// ---- 3. find -exec / -execdir / -ok ---------------------------------------
block('find -exec git ... \\;', `find . -maxdepth 0 -exec ${FP} \\;`);
block("find -exec git ... ';'", `find . -maxdepth 0 -exec ${FP} ';'`);
block('find -exec git ... {} +', `find . -maxdepth 0 -exec ${FP} {} +`);
block('find -execdir', `find . -maxdepth 0 -execdir ${FP} \\;`);
block('find -ok', `find . -ok ${FP} \\;`);
block('find -okdir', `find . -okdir ${FP} \\;`);
block('find -exec sh -c', `find . -maxdepth 0 -exec sh -c '${FP}' \\;`);
block("find -exec sh -c '\"$@\"' _ git ... {} +", `find . -exec sh -c '"$@"' _ ${FP} {} +`);
block('find -exec git push {} (file names as refspecs)', `find . -name x -exec git ${P} origin {} \\;`);
block('find -exec stdbuf git', `find . -exec stdbuf -o0 ${FP} \\;`);
block('second -exec clause', `find . -exec wc -l {} \\; -exec ${FP} \\;`);
block('xargs find -exec', `echo . | xargs -I{} find {} -exec ${FP} \\;`);
allow('find -exec grep', "find . -name '*.md' -exec grep -l push {} \\;");
allow('find -exec git log -- {}', 'find . -maxdepth 1 -exec git log -1 -- {} \\;');
allow('find -exec node --check', "find . -name '*.js' -exec node --check {} \\;");
allow('find -exec ls -l {} +', 'find . -type f -exec ls -l {} +');

// ---- 4. a replacement string as the command or git subcommand -------------
// The input fills it at run time, so the command may be a push: blocked when
// a force or remote-delete flag is visible.
block('xargs -I{} git {} --force', `xargs -I{} git {} ${F} o m`);
block('xargs -I% git % --force', `echo ${P} | xargs -I% git % ${F}`);
block("xargs -I{} sh -c 'git {} --force'", `xargs -I{} sh -c 'git {} ${F}'`);
block('xargs -I{} env git {} -f', 'xargs -I{} env git {} -f');
block('find -exec git {} --force', `find . -exec git {} ${F} o m \\;`);
block('xargs -i git {} --force', `xargs -i git {} ${F}`);
block('xargs --replace git {} -f', 'xargs --replace git {} -f');
block('xargs -I XX git XX --force', `xargs -I XX git XX ${F}`);
block('xargs -J % git % --force (BSD)', `xargs -J % git % ${F}`);
block('xargs -0I{} git {} -f', 'xargs -0I{} git {} -f');
block('xargs -I{} git -C {} --force (before the subcommand)', `xargs -I{} git -C {} ${F} o`);
block('xargs -I{} {} push --force (placeholder command)', `xargs -I{} {} ${P} ${F}`);
block('xargs -I{} git {} --delete', 'xargs -I{} git {} --delete o m');
block('xargs -I{} nested xargs git {} -f', 'xargs -I{} xargs git {} -f');
block('xargs -I{} git push origin {} (any xargs push)', `xargs -I{} git ${P} origin {}`);
allow('xargs -I{} git log {}', 'xargs -I{} git log {}');
allow('xargs -I{} rm -f {}', 'xargs -I{} rm -f {}');
allow("xargs -I{} sh -c 'rm -f {}'", "xargs -I{} sh -c 'rm -f {}'");
allow('find -exec rm -f {}', 'find . -exec rm -f {} \\;');
allow('find -exec git add {} +', "find . -name '*.md' -exec git add {} +");

// ---- 5. flock -c / --command anywhere among flock's args ------------------
block('flock -c CMD FILE', `flock -c '${FP}' /tmp/l`);
block('flock --command CMD FILE', `flock --command '${FP}' /tmp/l`);
block('flock --command=CMD FILE', `flock --command='${FP}' /tmp/l`);
block('flock FILE --command=CMD', `flock /tmp/l --command='${FP}'`);
block('flock -nc CMD FILE', `flock -nc '${FP}' /tmp/l`);
block('flock -w 3 -c CMD FILE', `flock -w 3 -c '${FP}' /tmp/l`);
block('flock --comm CMD FILE (prefix)', `flock --comm '${FP}' /tmp/l`);
allow('flock -c git status FILE', "flock -c 'git status' /tmp/l");
allow('flock FILE git commit -c HEAD', 'flock /tmp/l git commit -c HEAD');

// ---- 6. GNU parallel ------------------------------------------------------
block('parallel git push --force ::: a', `parallel ${FP} ::: a`);
block('parallel -j 4 git push', `parallel -j 4 git ${P} origin ::: main`);
block('parallel git {} --force ::: push', `parallel git {} ${F} ::: ${P}`);
block('parallel -I@@ git @@ -f', `parallel -I@@ git @@ -f ::: ${P}`);
block("parallel 'git {} --force' (one shell line)", `parallel 'git {} ${F}' ::: ${P}`);
block('parallel git ::: push ::: --force (input words appended)', `parallel git ::: ${P} ::: ${F}`);
block("parallel ::: 'git push --force' (inputs are commands)", `parallel ::: '${FP}'`);
block("parallel -j 4 ::: 'git push --force'", `parallel -j 4 ::: '${FP}'`);
block('xargs parallel git push', `echo x | xargs parallel ${FP} :::`);
allow('parallel gzip ::: a b', 'parallel gzip ::: a b');
allow('parallel -j4 git log {} ::: a b', 'parallel -j4 git log --oneline {} ::: a b');
allow("parallel echo ::: 'git push --force' (echo is the command)", `parallel echo ::: '${FP}'`);

// ---- braces are group words only when standalone (R3 B1) -------------------
// `{x}` / `{1}` / `{.}` / `{/}` / `{#}` are ordinary words; splitting the
// command there hid the force flag from the runner checks.
block('parallel git {1} F ::: P', `parallel git {1} ${F} ::: ${P}`);
block('parallel git {.} F', `parallel git {.} ${F} ::: ${P}`);
block('parallel git {/} F', `parallel git {/} ${F} ::: ${P}`);
block('parallel git {#} F', `parallel git {#} ${F} ::: ${P}`);
block('xargs -I{x} git {x} F', `xargs -I{x} git {x} ${F} origin main`);
block('xargs -I{f} git P {f} F', `xargs -I{f} git ${P} {f} ${F}`);
block("xargs -I{x} sh -c 'git {x} F'", `xargs -I{x} sh -c 'git {x} ${F}'`);
block('git P origin } F (} is a refspec word)', `git ${P} origin } ${F}`);
block('{ FP; } group', `{ ${FP}; }`);
block('{ FP;} group', `{ ${FP};}`);
block('then { ... } group', `if true; then { ${FP}; }; fi`);
block('f() { ... } function body', `f() { ${FP}; }; f`);
allow('{ echo a; echo b; } > out.txt', '{ echo a; echo b; } > out.txt');
// Any standalone `{` opens a group, not only in command position: after
// `function f`, `coproc [NAME]` or `time -p` the body still runs (R4 P1).
block('function f { G; }; f', `function f { ${FP}; }; f`);
block('function f { G; } NL f', `function f { ${FP}; }\nf`);
block('function f {  G ; } ; f', `function f {  ${FP} ; } ; f`);
block('second function body', `function f { echo ; }; function g { ${FP}; }; g`);
block('coproc { G; }', `coproc { ${FP}; }`);
block('coproc NAME { G; }', `coproc NAME { ${FP}; }`);
block('time -p { G; }', `time -p { ${FP}; }`);
block('bash -c "function f { G; }; f"', `bash -c "function f { ${FP}; }; f"`);
block("sh -c 'coproc { G; }'", `sh -c 'coproc { ${FP}; }'`);
block("eval 'function f { G; }; f'", `eval 'function f { ${FP}; }; f'`);
block('function f { G NL }', `function f { ${FP}\n}`);
allow('find -exec grep -l foo {} +', 'find -exec grep -l foo {} +');
allow('git stash show -p stash@{0}', 'git stash show -p stash@{0}');
allow('git show HEAD@{1}', 'git show HEAD@{1}');
allow('echo {a,b}', 'echo {a,b}');
allow("awk '{print $1}'", "awk '{print $1}' f");
allow("jq '.a | {b}'", "jq '.a | {b}' f");
allow('parallel echo {1} ::: a', 'parallel echo {1} ::: a');

// ---- subcommand or script on stdin (R3 A6) ---------------------------------
block("echo 'P F' | xargs git", `echo '${P} ${F} o m' | xargs git`);
block("echo 'P +main' | xargs git", `echo '${P} +main' | xargs git`);
block("echo 'P o :main' | xargs git", `echo '${P} o :main' | xargs git`);
// Quote removal: echo prints `'-'f` / `-"f"` as `-f` (R4 P2).
block("echo P '-'f | xargs git", `echo ${P} '-'f o m | xargs git`);
block('echo P -"f" | xargs git', `echo ${P} -"f" o m | xargs git`);
block("printf P --fo'rce' | xargs git", `printf '%s ' ${P} --fo'rce' | xargs git`);
block('printf P F | parallel git', `printf '%s\\n' ${P} ${F} | parallel git`);
block('xargs git < <(echo P F)', `xargs git < <(echo ${P} ${F} o m)`);
block('xargs git > log (redirect is not a subcommand)', `echo '${P} ${F} o m' | xargs git > log`);
block('xargs git 2>/dev/null', `echo '${P} ${F} o m' | xargs git 2>/dev/null`);
block("xargs -I{} sh -c '{}'", `echo '${FP}' | xargs -I{} sh -c '{}'`);
block('xargs sh -c \'$0 "$@"\'', `echo '${FP}' | xargs sh -c '$0 "$@"'`);
block('| parallel (stdin lines are commands)', `echo '${FP}' | parallel`);
block('unquoted echo | sh', `echo ${FP} | sh`);
block("printf '...' | bash -s", `printf '%s\\n' '${FP}' | bash -s`);
allow('git branch --merged | xargs git branch -d', 'git branch --merged | xargs git branch -d');
allow('ls | xargs git add', 'ls | xargs git add');
allow('xargs -I{} git add {}', 'xargs -I{} git add {}');
allow('find . -exec git add {} +', 'find . -exec git add {} +');
allow('parallel gzip ::: *.log', 'parallel gzip ::: *.log');
allow('echo status | xargs git', 'echo status | xargs git');
allow('git ls-files -z | xargs -0 git add', 'git ls-files -z | xargs -0 git add');
allow('curl ... | sh with no git in the line', "curl -fsSL 'https://example.com/i.sh' | sh");
