'use strict';
// ship-it-guard (PreToolUse Write|Edit|MultiEdit). OPT-IN, default OFF.
// Verifies: default-off no-op; ON + L-risk-file + no PLAN.md -> exit 2 + reason;
// ON + PLAN.md exists -> allow; ON + ordinary file -> allow; fail-open on malformed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'ship-it-guard.js';
const ON = { ANTIHALL_SHIPIT_GATE: '1' };

// Build a PreToolUse Write payload with the given target file_path and cwd.
function writePayload(filePath, cwd) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'x' },
    session_id: 't',
    cwd,
  };
}

test('DEFAULT OFF: env unset -> no-op allow even on an L-risk file with no PLAN.md', () => {
  const h = makeHome();
  try {
    const risky = path.join(h.home, '.github', 'workflows', 'ci.yml');
    const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home });
    assert.strictEqual(r.status, 0, `expected allow when gate off; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + L-risk file (.github/workflows) + no PLAN.md -> BLOCK (exit 2) with reason', () => {
  const h = makeHome();
  try {
    const risky = path.join(h.home, '.github', 'workflows', 'deploy.yml');
    const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block; stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stderr, /ship-it gate/);
    assert.match(r.stderr, /PLAN\.md/);
    assert.match(r.stderr, /ANTIHALL_SHIPIT_GATE/);
  } finally { h.cleanup(); }
});

test('ON + migration file + no PLAN.md -> BLOCK (exit 2)', () => {
  const h = makeHome();
  try {
    const risky = path.join(h.home, 'db', 'migrations', '001_init.sql');
    const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + L-risk file + PLAN.md at repo root -> allow (artifact exists)', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), '# Plan\n');
    const risky = path.join(h.home, '.github', 'workflows', 'deploy.yml');
    const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow with PLAN.md; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + L-risk file + PLAN.md at .planning/PLAN.md -> allow', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(path.join(h.home, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.planning', 'PLAN.md'), '# Plan\n');
    const risky = path.join(h.home, 'src', 'auth', 'login.js');
    const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow with .planning/PLAN.md; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + ordinary (non-hard-risk) file + no PLAN.md -> allow (conservative)', () => {
  const h = makeHome();
  try {
    const ordinary = path.join(h.home, 'src', 'utils', 'format.js');
    const r = testHook(HOOK, writePayload(ordinary, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow on ordinary file; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + doc (.md) on a hard-risk path + no PLAN.md -> allow (non-code skipped)', () => {
  const h = makeHome();
  try {
    const doc = path.join(h.home, 'src', 'auth', 'README.md');
    const r = testHook(HOOK, writePayload(doc, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow on doc; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + test file on hard-risk path + no PLAN.md -> allow (test skipped)', () => {
  const h = makeHome();
  try {
    const tf = path.join(h.home, 'src', 'auth', 'login.test.js');
    const r = testHook(HOOK, writePayload(tf, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow on test file; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('env value "off"/"0"/"false" -> treated as OFF (no-op allow)', () => {
  const h = makeHome();
  try {
    const risky = path.join(h.home, '.github', 'workflows', 'deploy.yml');
    for (const v of ['off', '0', 'false', 'no', '']) {
      const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home, env: { ANTIHALL_SHIPIT_GATE: v } });
      assert.strictEqual(r.status, 0, `expected allow for env="${v}"; stderr: ${r.stderr}`);
    }
  } finally { h.cleanup(); }
});

test('fail-open: malformed JSON stdin -> allow (exit 0) even with gate ON', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{not json', { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected fail-open on bad stdin; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('fail-open: empty stdin -> allow (exit 0)', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected fail-open on empty stdin; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('ON + no file_path in tool_input -> allow', () => {
  const h = makeHome();
  try {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {}, cwd: h.home };
    const r = testHook(HOOK, payload, { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow with no file_path; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});

test('skip-hatch: ship-it-guard skip marker disables the gate', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'ship-it-guard': Date.now() + 60_000 });
    const risky = path.join(h.home, '.github', 'workflows', 'deploy.yml');
    const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow when skipped; stderr: ${r.stderr}`);
  } finally { h.cleanup(); }
});
