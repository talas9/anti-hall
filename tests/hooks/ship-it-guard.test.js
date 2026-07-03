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

test('ON + L-risk file + PLAN.md ONLY at .planning/PLAN.md (no repo-root PLAN.md) -> block (GSD discontinued, 2026-07-03)', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(path.join(h.home, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.planning', 'PLAN.md'), '# Plan\n');
    const risky = path.join(h.home, 'src', 'auth', 'login.js');
    const r = testHook(HOOK, writePayload(risky, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 2, `expected block — .planning/PLAN.md is no longer a recognized location; stderr: ${r.stderr}`);
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

// =============================================================================
// MECHANISM 2 — PLAN-CONFORMANCE ADVISORY (never blocks). Only engages when
// PLAN.md parses into a real Step-2 shape ("## Phases" + >=1 phase declaring a
// `files:` list) — the structural stand-in for "the work is L-tier."
// =============================================================================

// A real Step-2-shaped PLAN.md: two phases, each declaring a `files:` list,
// mirroring skills/ship-it/SKILL.md's Step 2 template exactly.
function planWithPhases() {
  return [
    '# Feature — Plan',
    '',
    '## Intent',
    'Ship the thing.',
    '',
    '## Decisions',
    '- use X',
    '',
    '## Blast radius',
    'src/auth, src/utils',
    '',
    '## Phases',
    '### Phase 1: user can log in',
    '- depends_on: none',
    '- parallel_group: none',
    '- files: src/auth/login.js, src/auth/session.js',
    '- read_first: src/auth/login.js',
    '- steps: implement login',
    '- edge_cases: bad password',
    '- acceptance: npm test',
    '### Phase 2: user can log out',
    '- depends_on: Phase 1',
    '- parallel_group: none',
    '- files: src/auth/logout.js',
    '- read_first: src/auth/logout.js',
    '- steps: implement logout',
    '- edge_cases: already logged out',
    '- acceptance: npm test',
    '',
    '## Progress',
    '- [ ] Phase 1 — pending',
    '- [ ] Phase 2 — pending',
    '',
  ].join('\n');
}

test('CONFORMANCE: Write INSIDE a declared phase files: list -> no advisory (silent allow)', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), planWithPhases());
    const target = path.join(h.home, 'src', 'auth', 'login.js'); // declared in Phase 1
    const r = testHook(HOOK, writePayload(target, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0, `expected allow; stderr: ${r.stderr}`);
    assert.strictEqual(r.json, null, `expected silent allow, no advisory; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('CONFORMANCE: Write OUTSIDE every phase files: list -> ADVISORY (exit 0, additionalContext, not a block)', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), planWithPhases());
    const target = path.join(h.home, 'src', 'billing', 'invoice.js'); // not declared anywhere
    const r = testHook(HOOK, writePayload(target, h.home), { home: h.home, env: ON, expectJson: true });
    assert.strictEqual(r.status, 0, `advisory must not block; stderr: ${r.stderr}`);
    assert.ok(r.json && r.json.hookSpecificOutput, `expected hookSpecificOutput advisory; json: ${JSON.stringify(r.json)}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(r.json.hookSpecificOutput.additionalContext, /PLAN-CONFORMANCE/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /does not/);
    assert.ok(!r.json.decision, 'advisory must never carry a block decision');
  } finally { h.cleanup(); }
});

test('CONFORMANCE: applies to an ORDINARY (non-hard-risk) file too, not just hard-risk paths', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), planWithPhases());
    const target = path.join(h.home, 'src', 'ui', 'button.js'); // ordinary, not hard-risk, not declared
    const r = testHook(HOOK, writePayload(target, h.home), { home: h.home, env: ON, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json && r.json.hookSpecificOutput, `expected advisory on ordinary out-of-scope file; json: ${JSON.stringify(r.json)}`);
  } finally { h.cleanup(); }
});

test('CONFORMANCE + hard-risk interplay: hard-risk file not declared in an existing PLAN.md -> ADVISORY, never BLOCK', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), planWithPhases());
    const target = path.join(h.home, '.github', 'workflows', 'deploy.yml'); // hard-risk, undeclared
    const r = testHook(HOOK, writePayload(target, h.home), { home: h.home, env: ON, expectJson: true });
    assert.strictEqual(r.status, 0, `must not block once a PLAN.md exists; stderr: ${r.stderr}`);
    assert.ok(r.json && r.json.hookSpecificOutput, `expected advisory; json: ${JSON.stringify(r.json)}`);
    assert.ok(!r.json.decision, 'must never fall back to a block');
  } finally { h.cleanup(); }
});

test('CONFORMANCE: MultiEdit (file_path + edits[] shape) outside every phase files: list -> ADVISORY', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), planWithPhases());
    const target = path.join(h.home, 'src', 'random', 'thing.js');
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: { file_path: target, edits: [{ old_string: 'a', new_string: 'b' }] },
      cwd: h.home,
    };
    const r = testHook(HOOK, payload, { home: h.home, env: ON, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json && r.json.hookSpecificOutput, `expected advisory on MultiEdit shape; json: ${JSON.stringify(r.json)}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /thing\.js/);
  } finally { h.cleanup(); }
});

test('CONFORMANCE (L-tier gating): stub PLAN.md ("# Plan", no Phases section) -> conformance skipped, no advisory', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), '# Plan\n');
    const target = path.join(h.home, 'src', 'whatever', 'thing.js');
    const r = testHook(HOOK, writePayload(target, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json, null, `stub plan (no Phases) must not be treated as L-tier; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('CONFORMANCE (L-tier gating): "## Phases" present but no phase declares files: -> conformance skipped, no advisory', () => {
  const h = makeHome();
  try {
    const content = [
      '# Plan', '', '## Phases', '### Phase 1: does a thing',
      '- depends_on: none', '- steps: do it', '- acceptance: it works', '',
    ].join('\n');
    fs.writeFileSync(path.join(h.home, 'PLAN.md'), content);
    const target = path.join(h.home, 'src', 'whatever', 'thing.js');
    const r = testHook(HOOK, writePayload(target, h.home), { home: h.home, env: ON });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json, null, `no files: field anywhere must not be treated as scope; stdout: ${r.stdout}`);
  } finally { h.cleanup(); }
});
