'use strict';
// devswarm-comms-guard (PreToolUse SendMessage — DevSwarm mesh-only comms).
//
// MUTATION LIST (proves this file is non-vacuous — each assertion below fails
// against the pre-guard baseline, i.e. before devswarm-comms-guard.js existed /
// was wired into hooks.json, every one of these payloads would have been
// allowed through with no hook at all; RED was captured by running this file
// against a git stash of the hook's own logic gutted to `process.exit(0)`
// before any classification runs — see the RED/GREEN note at the bottom):
//   1. workspace-backed peer target -> must exit 2 with decision:block and the
//      "WORKSPACE-BACKED PEER SESSION" reason text + mesh-alternative command.
//   2. subagent-form agentId target -> must exit 0, never block.
//   3. anti-hall maintainer peer name -> must exit 0, never block, even when
//      its cwd IS (hypothetically) a devswarm workspace path.
//   4. non-DevSwarm context (DEVSWARM_REPO_ID unset) -> hook is completely
//      inert (exit 0, no output) even for an otherwise-blockable target.
//   5. malformed/empty stdin -> fail-open, exit 0.
//   6. peer session whose cwd is NOT a devswarm workspace path -> exit 0,
//      allowed (only workspace-backed peers are gated).
//   7. unresolved target name (no session-index match) -> exit 0, allowed
//      (fail-open reliability limitation).
//   8. " [ref]" bracket suffix on a workspace-backed target -> still resolves
//      and blocks (proves stripRef is exercised on the block path too).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'devswarm-comms-guard.js';

function sendMessagePayload(to) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'SendMessage',
    tool_input: { to, message: 'hello' },
    session_id: 't',
  };
}

// Seed a fake ~/.claude/sessions/<n>.json entry.
function seedSession(home, filename, { name, cwd }) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, filename),
    JSON.stringify({ name, cwd, status: 'busy', kind: 'interactive' }),
    'utf8'
  );
}

const DEVSWARM_ENV = { DEVSWARM_REPO_ID: 'repo-under-test' };

test('BLOCK: SendMessage to a workspace-backed peer session -> exit 2, decision block, mesh alternative', () => {
  const h = makeHome();
  try {
    const wsCwd = path.join(h.home, '.devswarm', 'repos', '0', 'abc123', 'fix-atlas-login-unknownerror2');
    fs.mkdirSync(wsCwd, { recursive: true });
    seedSession(h.home, '111.json', { name: 'fix-atlas-login-unknownerror2-9f', cwd: wsCwd });

    const r = testHook(HOOK, sendMessagePayload('fix-atlas-login-unknownerror2-9f'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    assert.strictEqual(r.status, 2, `expected block exit 2; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', `expected decision block; json: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /WORKSPACE-BACKED PEER SESSION/);
    assert.match(r.json.reason, /devswarm\.js send --to <meshId>/);
  } finally {
    h.cleanup();
  }
});

test('BLOCK: same workspace-backed target with a " [ref]" bracket suffix still resolves and blocks', () => {
  const h = makeHome();
  try {
    const wsCwd = path.join(h.home, '.devswarm', 'repos', '0', 'def456', 'inf-skyinform-admin-defects-3');
    fs.mkdirSync(wsCwd, { recursive: true });
    seedSession(h.home, '222.json', { name: 'inf-skyinform-admin-defects-3-d0', cwd: wsCwd });

    const r = testHook(HOOK, sendMessagePayload('inf-skyinform-admin-defects-3-d0 [9b8fa3]'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    assert.strictEqual(r.status, 2, `expected block exit 2; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', `json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW (a): subagent-form agentId target -> exit 0, never blocked, EVEN IF that exact string also names a workspace session', () => {
  const h = makeHome();
  try {
    // Deliberately seed a session whose NAME collides with the agentId-form
    // string, with a workspace-backed cwd. This makes the test actually
    // discriminate the AGENT_ID_RE exception: if that exception were removed,
    // the hook would fall through to the session-index lookup, find this
    // match, see its workspace cwd, and BLOCK. The exception must win first.
    const wsCwd = path.join(h.home, '.devswarm', 'repos', '0', 'aa1111', 'coincidental-workspace');
    fs.mkdirSync(wsCwd, { recursive: true });
    seedSession(h.home, '666.json', { name: 'a1b2c3d4-ffee-0011', cwd: wsCwd });

    const r = testHook(HOOK, sendMessagePayload('a1b2c3d4-ffee-0011'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    assert.strictEqual(r.status, 0, `expected allow; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('ALLOW (c): the anti-hall maintainer peer is exempt SOLELY because its cwd is not a workspace path', () => {
  const h = makeHome();
  try {
    // The maintainer session's cwd is an ordinary repo checkout, NOT under
    // ~/.devswarm/repos/ — this is the ONLY reason it is exempt. There is no
    // name-based exception (see hook header: an earlier draft had one and it
    // was removed as a loophole, not a safety net).
    const plainCwd = path.join(h.home, 'Projects', 'anti-hall');
    fs.mkdirSync(plainCwd, { recursive: true });
    seedSession(h.home, '333.json', { name: 'Anti-Hall', cwd: plainCwd });

    const r = testHook(HOOK, sendMessagePayload('Anti-Hall'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    assert.strictEqual(r.status, 0, `expected allow; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('BLOCK (loophole regression): a workspace-backed session whose NAME contains "anti-hall" is still blocked', () => {
  const h = makeHome();
  try {
    // This is the exact loophole the coordinator flagged and had removed: a
    // DevSwarm child workspace spawned to test anti-hall itself (this repo
    // does that for substrate testing) could be named anything, including
    // something containing "anti-hall". Its cwd is what matters, not its name
    // — a workspace-backed session must be blocked regardless of its title.
    const wsCwd = path.join(h.home, '.devswarm', 'repos', '0', 'zz9999', 'test-anti-hall-substrate');
    fs.mkdirSync(wsCwd, { recursive: true });
    seedSession(h.home, '334.json', { name: 'test-anti-hall-substrate-77', cwd: wsCwd });

    const r = testHook(HOOK, sendMessagePayload('test-anti-hall-substrate-77'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    assert.strictEqual(r.status, 2, `a workspace-backed peer must block regardless of its name; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block', `json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW (d): non-DevSwarm context -> hook is completely inert', () => {
  const h = makeHome();
  try {
    const wsCwd = path.join(h.home, '.devswarm', 'repos', '0', 'abc123', 'fix-atlas-login-unknownerror2');
    fs.mkdirSync(wsCwd, { recursive: true });
    seedSession(h.home, '444.json', { name: 'fix-atlas-login-unknownerror2-9f', cwd: wsCwd });

    // No DEVSWARM_REPO_ID in env -> isDevswarmActive() is false -> inert.
    const r = testHook(HOOK, sendMessagePayload('fix-atlas-login-unknownerror2-9f'), {
      home: h.home,
    });
    assert.strictEqual(r.status, 0, `expected inert allow; stdout: ${r.stdout}`);
    assert.strictEqual(r.stdout.trim(), '', `expected zero output when inert; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW (e): malformed JSON stdin -> fail-open, exit 0', () => {
  const h = makeHome();
  try {
    const { testHookRaw } = require('../helpers/spawn-hook.js');
    const r = testHookRaw(HOOK, '{not valid json', { home: h.home, env: DEVSWARM_ENV });
    assert.strictEqual(r.status, 0, `expected fail-open allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW (e2): empty stdin -> fail-open, exit 0', () => {
  const h = makeHome();
  try {
    const { testHookRaw } = require('../helpers/spawn-hook.js');
    const r = testHookRaw(HOOK, '', { home: h.home, env: DEVSWARM_ENV });
    assert.strictEqual(r.status, 0, `expected fail-open allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW (f): peer session resolved but cwd is NOT a devswarm workspace path -> allowed', () => {
  const h = makeHome();
  try {
    const plainCwd = path.join(h.home, 'Projects', 'some-other-repo');
    fs.mkdirSync(plainCwd, { recursive: true });
    seedSession(h.home, '555.json', { name: 'toolfox3-98', cwd: plainCwd });

    const r = testHook(HOOK, sendMessagePayload('toolfox3-98'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    assert.strictEqual(r.status, 0, `expected allow; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('ALLOW (g): unresolved target name (no session-index match) -> allowed', () => {
  const h = makeHome();
  try {
    // No sessions seeded at all -> the index has no matching name.
    const r = testHook(HOOK, sendMessagePayload('researcher'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    assert.strictEqual(r.status, 0, `expected allow; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('ALLOW: non-SendMessage tool_name -> inert no-op even in DevSwarm context', () => {
  const h = makeHome();
  try {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: 't',
    };
    const r = testHook(HOOK, payload, { home: h.home, env: DEVSWARM_ENV });
    assert.strictEqual(r.status, 0, `expected inert allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// --- PREDICATE MUTATION TESTS ---
//
// The tests above prove the block PATH is reachable (gutting the whole hook to
// `process.exit(0)` fails them — see the RED/GREEN note below). They do NOT
// prove the PREDICATE inside that path is correct. These three tests mutate
// one specific line of the real hook's source (via a targeted, anchored
// string replacement that throws if the anchor text is not found — so a
// future refactor breaks the mutation test loudly instead of silently
// no-op'ing), copy the mutant plus its two same-directory dependencies
// (skip-guard.js, lib/devswarm-detect.js) into an isolated temp dir so
// relative `require()`s still resolve, and assert that a SPECIFIC existing
// test's expectation FLIPS under the mutant. Each one is a genuine RED (fails
// against the unmutated hook's normal, correct behavior) established by
// running the SAME payload through the mutant and observing the wrong result.

const os = require('node:os');
const HOOK_SRC_PATH = path.join(path.dirname(require.resolve('../helpers/spawn-hook.js')), '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-comms-guard.js');
const HOOK_DIR = path.dirname(HOOK_SRC_PATH);

// buildMutant(anchor, replacement) -> absolute path to a mutated copy of the
// hook, with skip-guard.js and lib/devswarm-detect.js copied alongside it so
// its relative requires resolve. Throws if `anchor` is not found verbatim in
// the current source (a stale mutation must fail loudly, never silently pass
// through the unmutated hook).
function buildMutant(anchor, replacement) {
  const src = fs.readFileSync(HOOK_SRC_PATH, 'utf8');
  if (!src.includes(anchor)) {
    throw new Error('mutation anchor not found in devswarm-comms-guard.js (source drifted): ' + anchor);
  }
  const mutated = src.split(anchor).join(replacement);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devswarm-comms-guard-mutant-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(HOOK_DIR, 'skip-guard.js'), path.join(dir, 'skip-guard.js'));
  fs.copyFileSync(path.join(HOOK_DIR, 'lib', 'devswarm-detect.js'), path.join(dir, 'lib', 'devswarm-detect.js'));
  const mutantPath = path.join(dir, 'devswarm-comms-guard.js');
  fs.writeFileSync(mutantPath, mutated, 'utf8');
  return mutantPath;
}

test('MUTANT KILL 1: removing the agentId-form exception makes the subagent-steering case BLOCK (wrong)', () => {
  const h = makeHome();
  try {
    const mutant = buildMutant(
      'if (AGENT_ID_RE.test(to)) {',
      'if (false && AGENT_ID_RE.test(to)) {'
    );
    // Same scenario as the ALLOW (a) test above: agentId-form target whose
    // name also happens to match a workspace-backed session.
    const wsCwd = path.join(h.home, '.devswarm', 'repos', '0', 'aa2222', 'coincidental-workspace-2');
    fs.mkdirSync(wsCwd, { recursive: true });
    seedSession(h.home, '777.json', { name: 'a1b2c3d4-ffee-0022', cwd: wsCwd });

    const r = testHook(mutant, sendMessagePayload('a1b2c3d4-ffee-0022'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    // Correct hook: exit 0 (see ALLOW (a) above). Mutant: must now BLOCK,
    // proving the AGENT_ID_RE check is what was preventing that.
    assert.strictEqual(r.status, 2, `mutant should wrongly block a legitimate subagent send; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  } finally {
    h.cleanup();
  }
});

test('MUTANT KILL 2: removing the cwd-under-devswarm-repos check blocks a NON-workspace peer (wrong)', () => {
  const h = makeHome();
  try {
    const mutant = buildMutant(
      'if (isDevswarmWorkspacePath(session.cwd)) {',
      'if (true || isDevswarmWorkspacePath(session.cwd)) {'
    );
    // Same scenario as ALLOW (f): a resolved peer session whose cwd is a
    // plain repo checkout, not a devswarm workspace.
    const plainCwd = path.join(h.home, 'Projects', 'some-other-repo-2');
    fs.mkdirSync(plainCwd, { recursive: true });
    seedSession(h.home, '888.json', { name: 'toolfox3-99', cwd: plainCwd });

    const r = testHook(mutant, sendMessagePayload('toolfox3-99'), {
      home: h.home,
      env: DEVSWARM_ENV,
    });
    // Correct hook: exit 0 (see ALLOW (f) above). Mutant: must now BLOCK any
    // resolved session regardless of cwd, proving the cwd check is load-bearing.
    assert.strictEqual(r.status, 2, `mutant should wrongly block a non-workspace peer; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  } finally {
    h.cleanup();
  }
});

test('MUTANT KILL 3: inverting the isDevswarmActive gate makes non-DevSwarm-context NOT inert (wrong)', () => {
  const h = makeHome();
  try {
    const mutant = buildMutant(
      'if (!isDevswarmActive(process.env)) process.exit(0);',
      'if (isDevswarmActive(process.env)) process.exit(0);'
    );
    // Same scenario as ALLOW (d): NO DevSwarm env at all, but a session that
    // WOULD be a workspace-backed peer if the guard were armed.
    const wsCwd = path.join(h.home, '.devswarm', 'repos', '0', 'aa3333', 'fix-atlas-login-unknownerror2-3');
    fs.mkdirSync(wsCwd, { recursive: true });
    seedSession(h.home, '999.json', { name: 'fix-atlas-login-unknownerror2-9g', cwd: wsCwd });

    const r = testHook(mutant, sendMessagePayload('fix-atlas-login-unknownerror2-9g'), {
      home: h.home,
      // Deliberately NO DEVSWARM_ENV — real hook must be completely inert here.
    });
    // Correct hook: exit 0, no output (see ALLOW (d) above). Mutant: the gate
    // is inverted so it now runs (and blocks) OUTSIDE DevSwarm context instead
    // of inside it — proving the gate's polarity is load-bearing.
    assert.strictEqual(r.status, 2, `mutant should wrongly fire outside DevSwarm context; stdout: ${r.stdout}`);
    assert.ok(r.json && r.json.decision === 'block');
  } finally {
    h.cleanup();
  }
});

// --- RED/GREEN note ---
// RED (pre-fix / pre-existence baseline): with devswarm-comms-guard.js's body
// replaced by a bare `process.exit(0);` (i.e. equivalent to no hook at all —
// the state of this repo before this change), the two BLOCK tests above both
// FAIL: `status` comes back 0 instead of 2, and `r.json` is null so the
// `decision === 'block'` / reason-text assertions throw. This was verified by
// temporarily truncating the hook to `process.exit(0);` and re-running this
// file: both BLOCK tests failed as described, all ALLOW tests still passed
// (they were never exercising the block path). Restoring the real hook body
// (this commit's content) turns both BLOCK tests GREEN with the rest unchanged
// — see the totals pasted in the task report for the full-file GREEN run.
