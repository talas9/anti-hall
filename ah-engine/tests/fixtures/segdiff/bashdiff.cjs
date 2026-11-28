// Fail-safe differential test (GH #591): ~50 hand-picked shell snippets, each run under REAL `bash -c` with a stub `git` that logs argv.
// Every git call bash really executed must be held by a live segment of the guard's `splitSegments` (a hidden executed call is a
// bypass). Comment text may be kept live when the lexer is unsure, so nothing is asserted for calls bash did not run.
// usage: node bashdiff.cjs <plugin dir>; prints one summary line, exits 1 on any failure.
'use strict';
const vm = require('vm'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const logicDir = path.join(process.argv[2], 'engine', 'logic');
const ctx = vm.createContext({ console, ah: { cfgGen: () => 1, cfg: () => [], env: { get: () => null } } });
for (const f of ['lib/51-shell-scan.js', 'git.js']) vm.runInContext(fs.readFileSync(path.join(logicDir, f), 'utf8'), ctx, { filename: f });
const splitSegments = vm.runInContext('splitSegments', ctx);
const NL = '\n', BS = '\\', CR = '\r';
// @A = a git call (commit or push alternating). The snippet text is the argument of `bash -c`.
const snippets = [
  ['esc-space-hash', 'echo a' + BS + ' #; @A'],
  ['esc-hash', 'echo ' + BS + '#x; @A'],
  ['mid-word-hash', 'echo a#b; @A'],
  ['dollar-hash', 'echo $#; @A'],
  ['brace-len', 'x=abc; echo ${#x}; @A'],
  ['heredoc-hash-lines', 'cat <<E >/dev/null' + NL + '# one' + NL + '#two' + NL + 'E' + NL + '@A'],
  ['after-semi', 'true;# c' + NL + '@A'],
  ['after-and', 'true&&# c' + NL + '@A'],
  ['after-and-space', 'true && # c' + NL + '@A'],
  ['after-pipe', 'true | # c' + NL + 'cat; @A'],
  ['after-paren', '(# c' + NL + 'true); @A'],
  ['after-brace', '{ # c' + NL + 'true; }; @A'],
  ['after-newline', 'true' + NL + '# c' + NL + '@A'],
  ['crlf', 'true # c' + CR + NL + '@A'],
  ['cont-then-hash', 'echo a ' + BS + NL + '# c' + NL + '@A'],
  ['hash-after-cont', 'echo a ' + BS + NL + ' # c' + NL + '@A'],
  ['dq-hash', 'echo "# c"; @A'],
  ['sq-hash', "echo '# c'; @A"],
  ['dq-hash-then-comment', 'echo "#" # c' + NL + '@A'],
  ['subst-hash', 'echo $(echo a # c' + NL + '); @A'],
  ['subst-hash-in-dq', 'echo "$(echo a # c' + NL + ')"; @A'],
  ['arith-cmd', '(( 1 # 2 )); @A'],
  ['arith-cmd-base', '((1#2)); @A'],
  ['arith-for', 'for (( i=0 # ; i<1; i++ )); do :; done; @A; @A'],
  ['arith-expansion', 'echo $(( 1 + 2 )) # c; @A' + NL + '@A'],
  ['arith-expansion-comment', 'echo $((1+2)) # c' + NL + '@A'],
  ['pid-then-quote', 'echo $$' + "'x" + BS + "'; @A"],
  ['pid-then-hash', 'echo $$ # c' + NL + '@A'],
  ['brace-param-comment', 'echo "${1}"' + NL + '# git commit -m x && git push' + NL + '@A'],
  ['subst-then-comment', 'echo "$(true)"' + NL + '# git commit -m x && git push' + NL + '@A'],
  ['backtick-then-comment', 'echo "`true`"' + NL + '# c' + NL + '@A'],
  ['comment-ends-backslash', 'echo a # c' + BS + NL + '@A'],
  ['comment-ends-two-backslashes', 'echo a # c' + BS + BS + NL + '@A'],
  ['case-pattern', 'case x in x) echo a;; # c' + NL + 'esac; @A'],
  ['case-hash-pattern', 'case "#" in "#") true;; esac; @A'],
  ['procsub', 'cat <(echo a # c' + NL + ') >/dev/null; @A'],
  ['procsub-quoted', 'cat <(echo "#") >/dev/null; @A'],
  ['nested-bash-sq', "bash -c 'echo a; @A # c'"],
  ['nested-bash-esc', "bash -c 'echo a" + BS + " #; @A'"],
  ['nested-sh-dq', 'sh -c "true; # c' + NL + '@A"'],
  ['eval-sq', "eval 'true # c" + NL + "@A'"],
  ['unterminated-sq-comment', "true # it's" + NL + '@A'],
  ['unterminated-dq-comment', 'true # say "hi' + NL + '@A'],
  ['ansi-c-quote', "echo $'a" + BS + "'#'; @A"],
  ['dq-escaped-quote', 'echo "a' + BS + '" # b"; @A'],
  ['hash-then-semi-comment', 'true #; @A' + NL + '@A'],
  ['brace-expansion', 'echo {a,b}# x; @A'],
  ['var-assign-hash', 'x=#y; @A'],
  ['redirect-hash', 'echo a >/dev/null #c' + NL + '@A'],
  ['tab-hash', 'true\t# c' + NL + '@A'],
  ['compound-comment', 'if true; then # c' + NL + '@A; fi'],
  ['func-body', 'f() { # c' + NL + '@A; }; f'],
  ['dq-brace-two', 'echo "${1}" "${2}"' + NL + 'echo b' + NL + '# c' + NL + '@A'],
  ['heredoc-quoted', "cat <<'E' >/dev/null" + NL + "# x" + NL + 'E' + NL + '@A'],
  ['dollar-dq', 'echo $"a # b"; @A'],
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bashdiff-'));
const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
const log = path.join(dir, 'git.log');
fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + log + '"\n', { mode: 0o755 });
const env = { PATH: bin + ':/usr/bin:/bin', LC_ALL: 'C', HOME: dir };
const fails = []; let executed = 0;
for (const [name, src] of snippets) {
  let k = 0;
  const text = src.replace(/@A/g, () => (++k % 2 ? 'git commit -m ' : 'git push ') + 't' + String(k).padStart(3, '0'));
  fs.writeFileSync(log, '');
  const r = cp.spawnSync('/bin/bash', ['-c', text], { cwd: dir, env, timeout: 10000, encoding: 'utf8' });
  const ran = new Set(fs.readFileSync(log, 'utf8').match(/\bt\d{3}\b/g) || []);
  const segs = splitSegments(text);
  if (!ran.size) fails.push(name + ': premise: bash executed no tagged git call (status ' + r.status + ', stderr ' + JSON.stringify(r.stderr) + ')');
  for (const tag of ran) {
    executed++;
    if (!segs.some((s) => new RegExp('\\b' + tag + '\\b').test(s))) fails.push(name + ': BYPASS: bash executed ' + tag + ' but no live segment holds it\n    snippet=' + JSON.stringify(text) + '\n    segments=' + JSON.stringify(segs));
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('bashdiff: snippets=' + snippets.length + ' executed_calls=' + executed + ' failures=' + fails.length);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
