'use strict';
// command-guard.js — background scratch scripts (owner-approved 2026-09-26).
// MAIN THREAD ONLY: a Bash call with tool_input.run_in_background === true may
// run ONE `<python3|node|sh|bash> <script file> [args…]` segment when the file
// lives in the session scratchpad or a tmp root. Foreground runs keep today's
// verdict. Setting: guards.allowBackgroundScratchScripts (default true).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';
let dir; let jsFile; let pyFile; let shFile; let escapeLink;

before(() => {
  // '/tmp', not os.tmpdir(): the hook child runs with a controlled env
  // (no TMPDIR), so its os.tmpdir() is /tmp — a macOS /var/folders dir would
  // not be a tmp root for it.
  dir = fs.mkdtempSync(path.join('/tmp', 'bg-scratch-'));
  jsFile = path.join(dir, 'probe.js');
  pyFile = path.join(dir, 'probe.py');
  shFile = path.join(dir, 'probe.sh');
  fs.writeFileSync(jsFile, 'console.log(1)\n');
  fs.writeFileSync(pyFile, 'print(1)\n');
  fs.writeFileSync(shFile, 'echo 1\n');
  // A tmp-looking path whose realpath is OUTSIDE every tmp root.
  escapeLink = path.join(dir, 'escape.js');
  fs.symlinkSync(process.execPath, escapeLink);
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function run(command, opts) {
  const o = opts || {};
  const h = makeHome();
  try {
    if (o.settings) fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify(o.settings));
    const toolInput = { command };
    if (o.bg !== false) toolInput.run_in_background = o.bg === undefined ? true : o.bg;
    const payload = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput,
      session_id: 't', cwd: dir,
    };
    return testHook(HOOK, payload, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  } finally {
    h.cleanup();
  }
}

test('background-scratch: a tmp/scratchpad script runs in the background', () => {
  const cmds = [
    'python3 ' + pyFile,
    'node ' + jsFile + ' --flag value',
    'node probe.js',                              // relative to the payload cwd
    'bash ' + shFile,
    'python3 ' + pyFile + ' > ' + path.join(dir, 'out.log'),
  ];
  const wrong = cmds.filter((c) => run(c).status === 2);
  assert.deepStrictEqual(wrong, []);
});

test('background-scratch: the same command in the foreground keeps its verdict (blocked)', () => {
  for (const c of ['python3 ' + pyFile, 'node ' + jsFile]) {
    assert.strictEqual(run(c, { bg: false }).status, 2, c);
    assert.strictEqual(run(c, { bg: 'true' }).status, 2, 'string "true" is not a boolean: ' + c);
  }
});

test('background-scratch: negatives stay blocked even with run_in_background', () => {
  const cmds = [
    'npm test',
    'node ' + escapeLink,                                   // symlink resolving outside tmp
    'node /nonexistent-anti-hall-dir/x.js',                 // outside every tmp root
    'node ' + path.join(dir, 'missing.js'),                 // not an existing file
    'bash -c "npm test"',
    'node -e "require(\'child_process\').execSync(\'npm test\')"',
    'node ' + jsFile + ' && npm test',
    'node ' + jsFile + '; npm test',
    'node ' + jsFile + ' | sh',
    'node ' + jsFile + ' $(npm test)',
    'node ' + jsFile + ' `npm test`',
    'FOO=1 node ' + jsFile,
    'nohup node ' + jsFile,
    'node ' + jsFile + ' > /nonexistent-anti-hall-dir/out.log',
    'node ' + jsFile + ' < /etc/hosts',
    'node ' + jsFile + ' # trailing',
  ];
  const wrong = cmds.filter((c) => run(c).status !== 2);
  assert.deepStrictEqual(wrong, []);
});

test('background-scratch: guards.allowBackgroundScratchScripts=false restores the block', () => {
  const res = run('node ' + jsFile, { settings: { guards: { allowBackgroundScratchScripts: false } } });
  assert.strictEqual(res.status, 2);
});
