'use strict';
// git-guard: a shell wrapper that only STORES its argument (`local cmd="$1"`)
// and passes it on as data (a guard test harness piping JSON to a hook) does
// not run it, so the call args are not scanned as a command - but a wrapper
// that later RUNS the stored variable still blocks. Field replay: 12 harness
// scripts were blocked as "via shell function `run_test`: force push".
// Dangerous strings are assembled from pieces so this file is not itself a
// force push to any scanner.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const FP = 'gi' + 't pu' + 'sh --for' + 'ce origin main';
const h = makeHome();
function run(command) {
  return testHook('git-guard.js', Object.assign(bashPayload(command), { cwd: '/tmp' }), { home: h.home, env: { GIT_CONFIG_NOSYSTEM: '1' } });
}
const BLOCK_RE = /force push[^\n]* is blocked/;

const ALLOW = [
  ['real harness: local cmd="$1", echoed and passed to node as argv',
    'run_test() {\n  local cmd="$1"\n  local payload\n  payload=$(node -e \'console.log(JSON.stringify({tool_input:{command:process.argv[1]}}))\' "$cmd")\n  echo "=== CMD: $cmd ==="\n  echo "$payload" | node git-guard.js\n  echo "exit=$?"\n}\nrun_test \'' + FP + '\''],
  ['plain assignment c=$1, only echoed', 'r() { c=$1; echo "$c"; }\nr \'' + FP + '\''],
  ['declare + braced form, data argv', 'r() { declare c="${1}"; node x.js "$c"; }\nr \'' + FP + '\''],
];
for (const [name, cmd] of ALLOW) {
  test('ALLOW: ' + name, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  });
}

const BLOCK = [
  ['assigned then run in command position', 't(){ c="$1"; $c; }; t \'' + FP + '\''],
  ['local + quoted command position', 't(){ local c="$1"; "$c"; }; t \'' + FP + '\''],
  ['assigned then eval', 't(){ c="$1"; eval "$c"; }; t \'' + FP + '\''],
  ['assigned then eval, unquoted', 't(){ c=$1; eval $c; }; t \'' + FP + '\''],
  ['assigned then run with args', 't(){ c="$1"; $c --x; }; t \'' + FP + '\''],
  ['assigned then bash -c', 't(){ c="$1"; bash -c "$c"; }; t \'' + FP + '\''],
  ['assigned then piped to a shell', 't(){ c="$1"; echo "$c" | sh; }; t \'' + FP + '\''],
  ['assigned then here-string to a shell', 't(){ c="$1"; bash <<< "$c"; }; t \'' + FP + '\''],
  ['assigned then sourced via process substitution', 't(){ c="$1"; source <(echo "$c"); }; t \'' + FP + '\''],
  ['derived variable run', 't(){ c="$1"; d="$c"; eval "$d"; }; t \'' + FP + '\''],
  ['derived command-substitution variable run', 't(){ c="$1"; d=$(echo "$c"); $d; }; t \'' + FP + '\''],
  ['braced assignment and braced use', 't(){ c="${1}"; ${c}; }; t \'' + FP + '\''],
  ['run inside if/then', 't(){ c="$1"; if true; then $c; fi; }; t \'' + FP + '\''],
  ['direct $1 use (no assignment) still blocks', 't(){ eval "$1"; }; t \'' + FP + '\''],
];
for (const [name, cmd] of BLOCK) {
  test('BLOCK: ' + name, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, BLOCK_RE);
  });
}
