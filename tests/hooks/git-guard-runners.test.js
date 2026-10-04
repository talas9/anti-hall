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
