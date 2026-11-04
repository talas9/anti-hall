// Differential test for the git guard's command segmentation (GH #591): the guard's `splitSegments` against REAL bash.
//
// Each snippet is a shell script whose executable commands are `git commit` / `git push` calls; `git` is a stub on PATH that logs
// its argv. Bash runs the snippet, so the log says which tagged calls bash REALLY executed. The guard's segmentation must then
//   - contain a live segment with the tag text for every call bash executed (a hidden live call is a guard bypass), and
//   - hold no segment with the tag text for a tag that sits in text bash reads as a comment (the #591 false block).
// Tags: @X = a call bash must execute, @C = comment text bash must not execute and the guard must hide, @U = comment text the
// guard may keep live when it cannot lex with certainty (bash must still not execute it), @T = text in a quote / heredoc / argument
// (bash must not execute it; no segmentation claim).
//
// usage: node segdiff.cjs <plugin dir>; prints one summary line, exits 1 on any failure.
'use strict';
const vm = require('vm'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const pluginDir = process.argv[2];
const logicDir = path.join(pluginDir, 'engine', 'logic');
const ctx = vm.createContext({ console, ah: { cfgGen: () => 1, cfg: () => [], env: { get: () => null } } });
for (const f of ['lib/51-shell-scan.js', 'git.js']) vm.runInContext(fs.readFileSync(path.join(logicDir, f), 'utf8'), ctx, { filename: f });
const splitSegments = vm.runInContext('splitSegments', ctx);

const NL = '\n', VT = '\v', CR = '\r', BS = '\\';
// [name, source]; `\\`-free: backslashes are written with BS so the table reads as the shell text
const cores = [
  // an ESCAPED break before `#` leaves the `#` literal, so the call after it is live (the P0)
  ['esc-space', 'echo a' + BS + ' #; @X'],
  ['esc-tab', 'echo a' + BS + '\t#; @X'],
  ['esc-vt', 'echo a' + BS + VT + '#; @X'],
  ['esc-semi', 'echo a' + BS + ';#; @X'],
  ['esc-amp', 'echo a' + BS + '&#; @X'],
  ['esc-pipe', 'echo a' + BS + '|#; @X'],
  ['esc-lparen', 'echo a' + BS + '(#; @X'],
  ['esc-rparen', 'echo a' + BS + ')#; @X'],
  ['raw-vt', 'echo a' + VT + '#; @X'],
  ['raw-cr', 'echo a' + CR + '#; @X'],
  ['esc-bs-then-space-comment', 'echo a' + BS + BS + ' #@C' + NL + '@X'],
  ['esc-bs-esc-space', 'echo a' + BS + BS + BS + ' #; @X'],
  ['esc-hash', 'echo ' + BS + '#; @X'],
  ['esc-bs-hash', 'echo ' + BS + BS + '#; @X'],
  ['cont-midword', 'echo a' + BS + NL + '#; @X'],
  ['cont-after-break', 'echo ' + BS + NL + '#@C' + NL + '@X'],
  ['cont-after-space', 'echo a ' + BS + NL + '#@C' + NL + '@X'],
  ['cont-text', 'echo a' + BS + NL + '#@T' + NL + '@X'],
  // quotes
  ['dq-hash', 'echo "a #; @T"; @X'],
  ['sq-hash', "echo 'a #; @T'; @X"],
  ['ansi-escaped-quote', "echo $'a" + BS + "' #; @T'; @X"],
  ['ansi-escaped-bs', "echo $'a" + BS + BS + "' #@C" + NL + '@X'],
  ['ansi-hex-hash', "echo $'" + BS + "x23' #@C" + NL + '@X'],
  ['dq-glued', 'echo "a"#; @X'],
  ['sq-glued', "echo ''#; @X"],
  ['dq-escaped-quote', 'echo "' + BS + '" #; @T"; @X'],
  ['dq-dollar', 'echo $"a #; @T"; @X'],
  ['dq-quote-mix', 'echo "a"' + "'b'" + '#; @X'],
  // parameter expansion
  ['dollar-hash', 'echo $#; @X'],
  ['dollar-hash-comment', 'echo $# #@C' + NL + '@X'],
  ['brace-length', 'echo ${#x}; @X'],
  ['brace-trim', 'echo ${x#y}; @X'],
  ['brace-space-hash', 'echo ${x:- #}; @X'],
  ['brace-dq-hash', 'echo ${x:-" #"}; @X'],
  ['brace-subst', 'echo ${x/ /#}; @X'],
  ['dq-brace-space-hash', 'echo "${x:- #}"; @X'],
  ['brace-esc-close', 'echo ${x:-' + BS + '}}; @X'],
  ['brace-sq-close', "echo ${x:-'}'}; @X"],
  ['brace-dq-close', 'echo ${x:-"}"}; # @C' + NL + '@X'],
  ['brace-glued', 'echo ${x:-a}#; @X'],
  ['midword', 'echo a#b; @X'],
  ['var-glued', 'echo $x#; @X'],
  ['subst-glued', 'echo $(true)#; @X'],
  ['glob-glued', 'echo *#; @X'],
  ['tilde-glued', 'echo ~#; @X'],
  ['assign-glued', 'echo a=#b; @X'],
  ['bracket-glued', 'echo [#]; @X'],
  // real comments
  ['comment-then-call', 'echo a #@C' + NL + '@X'],
  ['trailing-comment', '@X #@C'],
  ['call-comment-call', '@X # @C' + NL + '@X'],
  ['leading-comment', '# @C' + NL + '@X'],
  ['after-semi', 'echo a;#@C' + NL + '@X'],
  ['after-and', 'echo a && # @C' + NL + '@X'],
  ['subshell-comment', '(#@C' + NL + '@X)'],
  ['group-comment', '{ #@C' + NL + '@X; }'],
  ['after-subshell', '(echo a) #@C' + NL + '@X'],
  ['case-arm', 'case a in a) #@C' + NL + '@X;; esac'],
  ['if-then', 'if true; then #@C' + NL + '@X; fi'],
  ['for-do', 'for i in 1; do #@C' + NL + '@X; done'],
  ['comment-ends-at-newline', 'echo a #@C ' + BS + NL + '@X'],
  ['apostrophe-in-comment', 'echo "x" # it' + "'" + 's @C' + NL + '@X'],
  ['dquote-in-comment', 'echo hi # "@C' + NL + '@X'],
  ['backtick-in-comment', ': # `@C' + NL + '@X'],
  ['redirect-then-comment', 'echo a 2>&1 #@C' + NL + '@X'],
  ['amp-then-comment', 'echo a & #@C' + NL + '@X'],
  ['pipe-then-comment', 'echo a|cat #@C' + NL + '@X'],
  ['blank-lines', 'echo a #@C' + NL + NL + '@X' + NL],
  ['indented-comment', '\t# @C' + NL + '@X'],
  ['cond-then-comment', '[[ a == a ]] && echo ok #@C' + NL + '@X'],
  ['cond-esc-space', '[[ x =~ a' + BS + ' #b ]]; @X'],
  ['crlf', 'echo hi' + CR + NL + '# note @C' + CR + NL + '@X' + CR + NL],
  // substitutions
  ['subst-call', 'echo $(@X)'],
  ['subst-newline-comment', 'echo $(echo a #@C' + NL + '); @X'],
  ['backtick-call', 'echo `@X`'],
  ['backtick-hash-body', 'echo `echo a #b`; @X'],
  ['backtick-comment-body', 'echo `echo a #@U`; @X'],
  ['arith-comment', 'echo $((1+2)) #@U' + NL + '@X'],
  ['dq-nested-quotes', 'echo "$(echo "#" )" #@U' + NL + '@X'],
  ['sq-in-subst', "x=$(echo '#'); @X"],
  // heredocs
  ['heredoc-hash-body', 'cat <<EOF >/dev/null' + NL + '# @T' + NL + 'EOF' + NL + '@X'],
  ['heredoc-quoted-body', "cat <<'EOF' >/dev/null" + NL + '@T #' + NL + 'EOF' + NL + '@X'],
  ['heredoc-opener-comment', 'cat <<EOF >/dev/null # @C' + NL + 'body @T' + NL + 'EOF' + NL + '@X'],
  ['heredoc-then-comment', 'cat <<EOF >/dev/null' + NL + 'b' + NL + 'EOF' + NL + '# @C' + NL + '@X'],
  // nested shells (the outer segment holds the inner text; the inner text is scanned by the same lexer on recursion)
  ['bash-c-comment', "bash -c '# @T" + NL + "@X'"],
  ['bash-c-esc-space', "bash -c 'echo a" + BS + " #; @X'"],
  ['sh-c-dq', 'sh -c "echo a' + BS + BS + ' #; @X"'],
  ['eval-sq', "eval 'echo a #@T'; @X"],
  ['eval-esc', "eval 'echo a" + BS + ";#; @X'"],
];
const prefixes = [['plain', ''], ['shebang', '#!/bin/bash' + NL], ['header-comment', '# header @C' + NL], ['tail-comment', 'echo start; # tail @C' + NL]];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segdiff-'));
const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
const log = path.join(dir, 'git.log');
fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + log + '"\n', { mode: 0o755 });
const env = { PATH: bin + ':/usr/bin:/bin', LC_ALL: 'C', HOME: dir };

let cases = 0, execCalls = 0, hidden = 0;
const fails = [];
for (const [pn, prefix] of prefixes) {
  for (const [cn, core] of cores) {
    let k = 0;
    const kinds = {};
    const text = (prefix + core).replace(/@([XCUT])/g, (_, kind) => {
      const tag = kind.toLowerCase() + String(++k).padStart(3, '0');
      kinds[tag] = kind;
      return (k % 2 ? 'git commit -m ' : 'git push ') + tag;
    });
    const name = pn + '/' + cn;
    cases++;
    fs.writeFileSync(log, '');
    const script = path.join(dir, 'snippet.sh');
    fs.writeFileSync(script, text);
    const r = cp.spawnSync('/bin/bash', [script], { cwd: dir, env, timeout: 10000, encoding: 'utf8' });
    const ran = new Set((fs.readFileSync(log, 'utf8').match(/\b[xcut]\d{3}\b/g)) || []);
    const segs = splitSegments(text);
    const live = (tag) => segs.some((s) => new RegExp('\\b' + tag + '\\b').test(s));
    for (const [tag, kind] of Object.entries(kinds)) {
      const bad = [];
      if (kind === 'X') { execCalls++; if (!ran.has(tag)) bad.push('premise: bash did not execute ' + tag + ' (bash status ' + r.status + ', stderr ' + JSON.stringify(r.stderr) + ')'); else if (!live(tag)) bad.push('BYPASS: bash executed ' + tag + ' but no live segment holds it'); }
      else {
        if (ran.has(tag)) bad.push('premise: bash executed ' + kind + ' tag ' + tag);
        if (kind === 'C') { hidden++; if (live(tag)) bad.push('FALSE BLOCK: comment text ' + tag + ' is a live segment'); }
      }
      if (bad.length) fails.push(name + ': ' + bad.join('; ') + '\n    snippet=' + JSON.stringify(text) + '\n    segments=' + JSON.stringify(segs));
    }
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('segdiff: cases=' + cases + ' executed_calls=' + execCalls + ' hidden_comment_calls=' + hidden + ' failures=' + fails.length);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
