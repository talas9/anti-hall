'use strict';
// edit-guard (PreToolUse Write|Edit|MultiEdit|NotebookEdit). Coordinator => may
// block (exit 2 + decision); subagent => always allow (exit 0). Mirrors
// command-guard.test.js's structure for the Edit-family tools instead of Bash.
//
// COORDINATOR env: CLAUDE_CODE_ENTRYPOINT='cli' AND no agent_id in the payload.
// SUBAGENT: agent_id in the PAYLOAD (the cmux-reliable signal).

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw, editPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'edit-guard.js';
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

// Coordinator run with a fresh fake HOME (no skip.json -> guard active).
function runCoord(payload, env) {
  const h = makeHome();
  try {
    return testHook(HOOK, payload, { home: h.home, env: Object.assign({}, COORD, env || {}) });
  } finally {
    h.cleanup();
  }
}

test('COORD BLOCK: cli + Edit on src/app.js', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }));
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
});

for (const tool of ['Write', 'MultiEdit', 'NotebookEdit']) {
  test(`COORD BLOCK: ${tool} variant`, () => {
    const r = runCoord(editPayload(tool, { filePath: 'src/app.js' }));
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

test('SUBAGENT ALLOW: cli + Edit + agent_id/agent_type present', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js', agentId: 'test-agent' }));
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('FAIL-OPEN: no entrypoint env -> allow', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, editPayload('Edit', { filePath: 'src/app.js' }), { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test("FAIL-OPEN: unknown entrypoint 'weird' -> allow", () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/app.js' }), { CLAUDE_CODE_ENTRYPOINT: 'weird' });
  assert.strictEqual(r.status, 0);
});

test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home, env: COORD }).status, 0);
  } finally {
    h.cleanup();
  }
});

const ALLOWLIST_PATHS = ['CLAUDE.md', '.claude/settings.json', '.anti-hall/x.md', 'PLAN.md'];
for (const p of ALLOWLIST_PATHS) {
  test(`ALLOWLIST: cli + Edit on ${p}`, () => {
    const r = runCoord(editPayload('Edit', { filePath: p }));
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

test("ALLOWLIST: env ANTIHALL_EDIT_GUARD_ALLOW='docs/**' on docs/x.md", () => {
  const r = runCoord(editPayload('Edit', { filePath: 'docs/x.md' }), { ANTIHALL_EDIT_GUARD_ALLOW: 'docs/**' });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

// BARE-FILENAME ROOT ANCHORING (P0 fix): DEFAULT_ALLOW patterns with no '/'
// ('CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'PLAN.md', 'STATE.json') must match
// ONLY a root-level file, never a same-named file nested anywhere else in the
// tree (a bug that previously allow-listed e.g. 'src/deep/nested/CLAUDE.md'
// because isAllowed tested the pattern against basename() with no path check).
const NESTED_BARE_BLOCKED = [
  'src/nested/CLAUDE.md',
  'src/app/PLAN.md',
  'a/b/STATE.json',
  'sub/AGENTS.md',
  'x/GEMINI.md',
];
for (const p of NESTED_BARE_BLOCKED) {
  test(`BARE-FILENAME NOT ROOT-ANCHORED: cli + Edit on ${p} -> BLOCKED`, () => {
    const r = runCoord(editPayload('Edit', { filePath: p }));
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', 'decision:block expected in stdout');
  });
}

const ROOT_BARE_ALLOWED = ['CLAUDE.md', 'PLAN.md', 'STATE.json'];
for (const p of ROOT_BARE_ALLOWED) {
  test(`BARE-FILENAME ROOT-ANCHORED: cli + Edit on root ${p} -> ALLOWED`, () => {
    const r = runCoord(editPayload('Edit', { filePath: p }));
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

test("ALLOWLIST: env ANTIHALL_EDIT_GUARD_ALLOW='**/CLAUDE.md' still opts nested CLAUDE.md back in", () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/nested/CLAUDE.md' }), { ANTIHALL_EDIT_GUARD_ALLOW: '**/CLAUDE.md' });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test("SKIP: writeSkip({'edit-guard': future}) -> allow", () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'edit-guard': Date.now() + 60000 });
    const r = testHook(HOOK, editPayload('Edit', { filePath: 'src/app.js' }), { home: h.home, env: COORD });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test("SKIP: writeSkip({all: future}) -> allow (honors broad 'all')", () => {
  const h = makeHome();
  try {
    h.writeSkip({ all: Date.now() + 60000 });
    const r = testHook(HOOK, editPayload('Edit', { filePath: 'src/app.js' }), { home: h.home, env: COORD });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('INJECTION: block reason does not echo file_path text', () => {
  const r = runCoord(editPayload('Edit', { filePath: 'src/INJECTSECRET.js' }));
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stdout.includes('INJECTSECRET'), 'stdout must not reflect file_path text');
  assert.ok(!r.stderr.includes('INJECTSECRET'), 'stderr must not reflect file_path text');
});
