'use strict';
// api-guard (PreToolUse on Write/Edit/MultiEdit). Verifies code the model is
// about to write against the INSTALLED runtime and BLOCKS when a real
// stdlib/builtin module is missing a referenced attribute (a fabricated API).
// Block => stdout {decision:'block'} + exit 2. Fail-open (exit 0) on anything
// uncertain — a guard that blocks valid code is worse than useless.
//
// Cross-platform: `node` is always present (it runs these tests); `python3` may
// be absent (e.g. Windows CI), where the hook fail-opens by design — so the
// Python BLOCK assertions are gated on python3 being available.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'api-guard.js';

function has(bin) {
  try { return spawnSync(bin, ['--version'], { timeout: 4000 }).status === 0; }
  catch (_) { return false; }
}
const HAS_PY = has('python3');
const HAS_NODE = has('node');

function write(file_path, content) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content }, session_id: 't', cwd: process.cwd() };
}
function edit(file_path, new_string) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path, old_string: 'x', new_string }, session_id: 't', cwd: process.cwd() };
}
function run(payload) {
  const h = makeHome();
  try { return testHook(HOOK, payload, { home: h.home }); }
  finally { h.cleanup(); }
}

// ---- Python BLOCK (fabricated stdlib APIs) -------------------------------
test('BLOCK: python os.quantum_fork (fake module fn)', { skip: !HAS_PY }, () => {
  const r = run(write('/tmp/x.py', 'import os\nos.quantum_fork()\n'));
  assert.strictEqual(r.status, 2, 'expected block, got ' + r.status + ' :: ' + r.stdout);
  assert.ok(r.json && r.json.decision === 'block', 'missing decision:block');
  assert.ok(/quantum_fork/.test(r.json.reason), 'reason should name the fake symbol');
});

test('BLOCK: python asyncio.run_all (fake) via Edit', { skip: !HAS_PY }, () => {
  const r = run(edit('/tmp/x.py', 'import asyncio\nasyncio.run_all([a, b])\n'));
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(/run_all/.test(r.json.reason));
});

test('BLOCK: python from-import OrderedDict.move_to_front (fake method)', { skip: !HAS_PY }, () => {
  const r = run(write('/tmp/x.py', 'from collections import OrderedDict\nd = OrderedDict()\nd2 = OrderedDict.move_to_front\n'));
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(/move_to_front/.test(r.json.reason));
});

// ---- Python ALLOW (real APIs) --------------------------------------------
test('ALLOW: python os.getpid + OrderedDict.move_to_end (real)', { skip: !HAS_PY }, () => {
  const r = run(write('/tmp/x.py', 'import os\nfrom collections import OrderedDict\nos.getpid()\nOrderedDict.move_to_end\n'));
  assert.strictEqual(r.status, 0, 'real APIs must NOT block :: ' + r.stdout);
});

test('ALLOW: python 3rd-party module not introspected (numpy.foo)', { skip: !HAS_PY }, () => {
  // numpy is not in the stdlib allowlist -> we never check it -> fail open.
  const r = run(write('/tmp/x.py', 'import numpy\nnumpy.foo_bar_baz()\n'));
  assert.strictEqual(r.status, 0);
});

// ---- JS/Node BLOCK -------------------------------------------------------
test('BLOCK: node crypto.createHashStream (fake builtin method)', { skip: !HAS_NODE }, () => {
  const r = run(write('/tmp/x.js', "const crypto = require('crypto');\ncrypto.createHashStream('sha256');\n"));
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(/createHashStream/.test(r.json.reason));
});

test('BLOCK: node Promise.allSettledRace (fake global static)', { skip: !HAS_NODE }, () => {
  const r = run(write('/tmp/x.mjs', 'await Promise.allSettledRace([p1, p2]);\n'));
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(/allSettledRace/.test(r.json.reason));
});

// ---- JS/Node ALLOW -------------------------------------------------------
test('ALLOW: node crypto.createHash + Promise.allSettled (real)', { skip: !HAS_NODE }, () => {
  const r = run(write('/tmp/x.js', "const crypto = require('crypto');\ncrypto.createHash('sha256');\nPromise.allSettled([p]);\n"));
  assert.strictEqual(r.status, 0, 'real APIs must NOT block :: ' + r.stdout);
});

// ---- Fail-open / scope ---------------------------------------------------
test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try { assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0); }
  finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try { assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0); }
  finally { h.cleanup(); }
});

test('SCOPE: non-code file (.md) with fake-looking text -> allow', () => {
  const r = run(write('/tmp/notes.md', 'os.quantum_fork() is great, use Promise.allSettledRace too'));
  assert.strictEqual(r.status, 0);
});

test('SCOPE: non-Write/Edit tool (Bash) -> allow', () => {
  const r = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'os.quantum_fork' }, session_id: 't', cwd: process.cwd() });
  assert.strictEqual(r.status, 0);
});

test('SCOPE: python code with no stdlib refs -> allow', { skip: !HAS_PY }, () => {
  const r = run(write('/tmp/x.py', 'def add(a, b):\n    return a + b\n'));
  assert.strictEqual(r.status, 0);
});

test('SKIP HATCH: api-guard skipped -> allow even with fake API', { skip: !HAS_PY }, () => {
  const h = makeHome();
  try {
    // skip.json with a far-future expiry for api-guard
    const fs = require('node:fs');
    const p = require('node:path');
    const dir = p.join(h.home, '.anti-hall');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p.join(dir, 'skip.json'), JSON.stringify({ 'api-guard': Date.now() + 3600000 }));
    const r = testHook(HOOK, write('/tmp/x.py', 'import os\nos.quantum_fork()\n'), { home: h.home });
    assert.strictEqual(r.status, 0, 'skip hatch should allow');
  } finally { h.cleanup(); }
});
