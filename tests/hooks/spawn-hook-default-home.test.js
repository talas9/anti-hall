'use strict';
// spawn-hook-default-home — regression guard for the shared test helper
// tests/helpers/spawn-hook.js.
//
// PROVEN DEFECT: testHook()/testHookRaw() built their child env with
// `isolatedEnv(opts.home || process.env.HOME)`. When a call site omitted
// opts.home, the child hook ran against the DEVELOPER'S REAL HOME. Hooks
// persist state under ~/.anti-hall/ (devswarm-child-gate writes
// ~/.anti-hall/devswarm/child-drain/ records, for example), so `npm test`
// silently wrote into real machine state. Two such call sites existed
// (tests/hooks/devswarm-child-drain.test.js, the two FAIL-OPEN cases).
//
// FIX: the fallback is now a lazily-created, disposable mkdtemp dir.
//
// This file proves it two ways:
//   1. FUNCTIONAL — spawn a probe "hook" through testHook with NO opts.home and
//      assert the HOME it resolves is inside the temp dir, not os.homedir().
//   2. STATIC — the helper must never reintroduce a `process.env.HOME` fallback
//      in its env-merge expressions.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const HELPER_JS = path.join(__dirname, '..', 'helpers', 'spawn-hook.js');

// A probe standing in for a hook: reads stdin (like every hook does) and prints
// the HOME its own os.homedir() resolves to. testHook accepts an ABSOLUTE path,
// so it does not have to live in the hooks dir.
const PROBE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-spawn-hook-probe-'));
const PROBE_JS = path.join(PROBE_DIR, 'home-probe.js');
fs.writeFileSync(
  PROBE_JS,
  "let b='';process.stdin.on('data',c=>{b+=c;});process.stdin.on('end',()=>{"
  + "process.stdout.write(require('os').homedir());});\n",
);

function insideTmp(p) {
  const tmp = os.tmpdir();
  let realTmp = tmp;
  try { realTmp = fs.realpathSync(tmp); } catch (_) {}
  return p.startsWith(tmp) || p.startsWith(realTmp);
}

test('functional: testHook WITHOUT opts.home never resolves the real machine home', () => {
  const r = testHook(PROBE_JS, { hook_event_name: 'PreToolUse' });
  const resolved = (r.stdout || '').trim();
  assert.notStrictEqual(resolved, os.homedir(),
    'a testHook call that omits opts.home must NOT run against the real machine home');
  assert.ok(insideTmp(resolved),
    'the default HOME must be a disposable temp dir, got: ' + resolved);
});

test('functional: testHookRaw WITHOUT opts.home never resolves the real machine home', () => {
  const r = testHookRaw(PROBE_JS, '{bad json');
  const resolved = (r.stdout || '').trim();
  assert.notStrictEqual(resolved, os.homedir(),
    'a testHookRaw call that omits opts.home must NOT run against the real machine home');
  assert.ok(insideTmp(resolved),
    'the default HOME must be a disposable temp dir, got: ' + resolved);
});

test('functional: an explicit opts.home still wins over the default', () => {
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-spawn-hook-explicit-'));
  try {
    const r = testHook(PROBE_JS, { hook_event_name: 'PreToolUse' }, { home: mine });
    assert.ok((r.stdout || '').trim().length > 0, 'probe must report a home');
    assert.ok((r.stdout || '').trim().indexOf(path.basename(mine)) !== -1,
      'explicit opts.home must be the child HOME, got: ' + r.stdout);
  } finally {
    try { fs.rmSync(mine, { recursive: true, force: true }); } catch (_) {}
  }
});

test('static: spawn-hook.js never falls back to process.env.HOME for the child HOME', () => {
  const src = fs.readFileSync(HELPER_JS, 'utf8');
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(
    code,
    /isolatedEnv\(\s*opts\.home\s*\|\|\s*process\.env\.HOME\s*\)/,
    'the real-home fallback must not come back — use the disposable defaultHome()',
  );
  assert.match(
    code,
    /isolatedEnv\(\s*opts\.home\s*\|\|\s*defaultHome\(\)\s*\)/,
    'both env-merge sites must fall back to the disposable defaultHome()',
  );
});

test.after(() => {
  try { fs.rmSync(PROBE_DIR, { recursive: true, force: true }); } catch (_) {}
});
