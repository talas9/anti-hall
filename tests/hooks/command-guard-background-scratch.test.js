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
let dir; let jsFile; let pyFile; let shFile; let escapeLink; let pluginScript; let pluginLink;

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
  // A fake anti-hall plugin root inside tmp (a cache copy / dev checkout shape).
  const fakePlugin = path.join(dir, 'fake-plugin');
  fs.mkdirSync(path.join(fakePlugin, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(fakePlugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(fakePlugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'anti-hall' }));
  pluginScript = path.join(fakePlugin, 'scripts', 'settings.js');
  fs.writeFileSync(pluginScript, 'console.log(1)\n');
  pluginLink = path.join(dir, 'plugin-link.js');
  fs.symlinkSync(pluginScript, pluginLink);
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
    // valueless interpreter flags before the script (field: python3 -I probe.py > probe.out 2>&1)
    'python3 -I ' + pyFile + ' > ' + path.join(dir, 'probe.out') + ' 2>&1',
    'python3 -I -B ' + pyFile,
    'node --no-warnings ' + jsFile,
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
    // interpreter flags that load/run code or change which file runs stay refused
    'python3 -c "print(1)" ' + pyFile,
    'python3 -m http.server ' + pyFile,
    'python3 -W error ' + pyFile,
    'node --require ' + jsFile + ' ' + jsFile,
    'node --import ' + jsFile + ' ' + jsFile,
    // 0.113 P3 (mirrors 0.112 F1): anti-hall scripts and --confirmed never qualify.
    'node ' + pluginScript + ' set safety.commandGuard false',
    'node ' + pluginLink,
    'node ' + jsFile + ' --confirmed',
    'node ' + jsFile + ' --confirmed=yes',
  ];
  const wrong = cmds.filter((c) => run(c).status !== 2);
  assert.deepStrictEqual(wrong, []);
});

test('background-scratch: guards.allowBackgroundScratchScripts=false restores the block', () => {
  const res = run('node ' + jsFile, { settings: { guards: { allowBackgroundScratchScripts: false } } });
  assert.strictEqual(res.status, 2);
});

// Field report 0.118.0: the block text's own remedy shape (script > out; wc;
// grep -c) was refused even with run_in_background:true.
test('background-scratch: script chained with bounded read sinks passes in the background', () => {
  const out = path.join(dir, 'out.txt');
  const cmds = [
    'python3 ' + pyFile + ' > ' + out + '; wc -l ' + out + '; grep -c USER ' + out,
    'python3 ' + pyFile + ' && node ' + jsFile + ' | tail -5',
    'node ' + jsFile + ' | head -40',
  ];
  const wrong = cmds.filter((c) => run(c).status === 2);
  assert.deepStrictEqual(wrong, []);
  // Foreground keeps its verdict.
  assert.strictEqual(run(cmds[0], { bg: false }).status, 2);
});

test('background-scratch: a sink with a file operand outside scratch or an unknown flag stays blocked', () => {
  const out = path.join(dir, 'out.txt');
  const cmds = [
    'python3 ' + pyFile + '; head /etc/passwd',
    'python3 ' + pyFile + '; tail -n +1 --pid=123',
    'python3 ' + pyFile + '; wc -l /etc/passwd',
    'python3 ' + pyFile + '; grep -c root /etc/passwd',
    'python3 ' + pyFile + ' | head -q',
    'python3 ' + pyFile + '; tail -f ' + out,
    'python3 ' + pyFile + '; head -n 5 ' + out + ' /etc/passwd',
  ];
  const wrong = cmds.filter((c) => run(c).status !== 2);
  assert.deepStrictEqual(wrong, []);
});

test('background-scratch: chains to anything but bounded sinks stay blocked', () => {
  const cmds = [
    'python3 ' + pyFile + '; npm test',
    'python3 ' + pyFile + ' && node --test',
    'python3 ' + pyFile + ' | tee /nonexistent-anti-hall-dir/x',
    'python3 ' + pyFile + ' || npm test',
    'python3 ' + pyFile + ' & npm test',
    'wc -l ' + pyFile + '; npm test',
    'python3 ' + pyFile + '; grep foo ' + pyFile,   // unbounded grep is not a sink
  ];
  const wrong = cmds.filter((c) => run(c).status !== 2);
  assert.deepStrictEqual(wrong, []);
});

// Field report 0.118.0: `timeout N node <devswarm.js> roster | head` blocked
// while the same read-only verb without `timeout` passed.
test('timeout-wrapped anti-hall devswarm.js read verbs pass; heavy stays blocked', () => {
  const ok = [
    'timeout 30 node ~/.anti-hall/bin/devswarm.js roster 2>&1 | head -40',
    'timeout -k 5 30 node ~/.anti-hall/bin/devswarm.js inbox tick | tail -3',
    'timeout 30 node plugins/anti-hall/scripts/devswarm.js mesh read',
  ];
  assert.deepStrictEqual(ok.filter((c) => run(c, { bg: false }).status === 2), []);
  const bad = [
    'timeout 30 npm test | head',
    'timeout 30 node /tmp/evil.js',
    'timeout 30 node evilscripts/devswarm.js roster',
    'timeout 30 npm run build -- node scripts/devswarm.js list',
  ];
  assert.deepStrictEqual(bad.filter((c) => run(c, { bg: false }).status !== 2), []);
});

// L33: a scratch script run DIRECTLY (shebang + exec bit), background only,
// inside this session's OWN scratchpad. Env-prefix assignments stay refused.
function runOwn(command, opts) {
  const o = opts || {};
  const repo = fs.mkdtempSync(path.join('/tmp', 'bg-own-repo-'));
  const sid = 'l33-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const projDir = path.join('/tmp', 'claude-' + process.getuid(), repo.replace(/[^A-Za-z0-9]/g, '-'));
  const sp = path.join(projDir, sid, 'scratchpad');
  const otherSp = path.join(projDir, sid + '-other', 'scratchpad');
  fs.mkdirSync(sp, { recursive: true });
  fs.mkdirSync(otherSp, { recursive: true });
  const mk = (d, name, mode) => { const f = path.join(d, name); fs.writeFileSync(f, '#!/bin/sh\necho 1\n'); fs.chmodSync(f, mode); return f; };
  mk(sp, 'shoot.sh', 0o755);
  mk(sp, 'plain.sh', 0o644);
  mk(otherSp, 'foreign.sh', 0o755);
  fs.writeFileSync(path.join(sp, 'modal-shot.mjs'), 'console.log(1)\n');
  fs.symlinkSync(path.join(sp, 'shoot.sh'), path.join(sp, 'link.sh'));
  fs.symlinkSync(otherSp, path.join(sp, 'dirlink'));
  const xtmp = mk('/tmp', 'l33-' + process.pid + '-x.sh', 0o755);
  const h = makeHome();
  try {
    const toolInput = { command: command.split('@SP@').join(sp).split('@OTHER@').join(otherSp).split('@XTMP@').join(xtmp) };
    if (o.bg !== false) toolInput.run_in_background = true;
    return testHook(HOOK, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput, session_id: sid, cwd: repo },
      { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  } finally {
    h.cleanup();
    fs.rmSync(xtmp, { force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('background-scratch direct exec: an executable file in the OWN scratchpad runs in the background, alone or chained', () => {
  const ok = [
    '@SP@/shoot.sh',
    '@SP@/shoot.sh --flag value',
    'node @SP@/modal-shot.mjs && @SP@/shoot.sh',
    'node @SP@/modal-shot.mjs; @SP@/shoot.sh | tail -5',
  ];
  const wrong = ok.filter((c) => runOwn(c).status === 2);
  assert.deepStrictEqual(wrong, []);
});

test('background-scratch direct exec: refused for non-exec, foreign scratchpad, symlinks, /tmp, foreground, env prefix', () => {
  const bad = [
    '@SP@/plain.sh',                              // not executable
    '@OTHER@/foreign.sh',                         // another session's scratchpad
    '@SP@/link.sh',                               // symlink to an own-scratchpad file
    '@SP@/dirlink/foreign.sh',                    // symlinked directory component
    '@XTMP@',                                     // generic /tmp, not the own scratchpad
    '@SP@/missing.sh',
    'VARIANTS="A B C D" @SP@/shoot.sh',           // env prefix stays refused
    'FOO=1 @SP@/shoot.sh',
    '@SP@/shoot.sh && npm test',                  // chain to a non-sink
    '@SP@/shoot.sh --confirmed',
    '@SP@/shoot.sh $(npm test)',
  ];
  // A heavy `node` segment (the real field shape) makes the whole chain gated;
  // the bad direct-exec segment must then make the carve-out refuse.
  const wrong = bad.filter((c) => runOwn('node @SP@/modal-shot.mjs && ' + c).status !== 2);
  assert.deepStrictEqual(wrong, []);
  assert.strictEqual(runOwn('node @SP@/modal-shot.mjs && @SP@/shoot.sh', { bg: false }).status, 2, 'foreground keeps its verdict');
});

test('command-guard block text states the allowed background shapes and the no VAR= prefix rule', () => {
  const r = runOwn('node @SP@/modal-shot.mjs && VARIANTS="A B" @SP@/shoot.sh');
  assert.strictEqual(r.status, 2);
  assert.match(r.json.reason, /run with run_in_background/);
});

test('command-guard names git pull/fetch as state-changing remote operations (verdict unchanged: still blocked)', () => {
  for (const c of ['git pull origin main', 'git fetch --prune origin']) {
    const r = run(c, { bg: false });
    assert.strictEqual(r.status, 2, c);
    assert.match(r.json.reason, /state-changing remote command/, c);
    assert.doesNotMatch(r.json.reason, /heavy-pattern/, c);
  }
});
