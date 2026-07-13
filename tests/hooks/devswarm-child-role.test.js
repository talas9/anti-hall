'use strict';
// devswarm-child-role (SessionStart hook). v0.58 "mesh-only messaging": injects
// the FULL DEVSWARM COMMUNICATION OVERRIDE directive for BOTH DevSwarm roles
// (Primary AND child workspace) whenever the liveness supervisor is active
// (devswarm-detect). A child additionally gets an idle-self-report nudge. Only a
// non-DevSwarm session or malformed stdin is a silent no-op (fail-open, exit 0).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'devswarm-child-role.js';
// Stable substring surviving the v0.58 hook-text sweep (the OLD marker,
// 'message-parent', is now a BLOCKED native verb and must never appear).
const REMINDER_PHRASE = 'COMMUNICATION OVERRIDE';

function sessionPayload() {
  return { hook_event_name: 'SessionStart', source: 'startup', session_id: 't' };
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('INJECT: DevSwarm active + DEVSWARM_SOURCE_BRANCH set (child) -> override present + idle nudge', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be valid JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), `override must mention ${REMINDER_PHRASE}; ctx=${ctx(r)}`);
    assert.ok(/idle — reassign me a task or archive me/.test(ctx(r)), `child must get the idle nudge; ctx=${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('INJECT: DevSwarm active but DEVSWARM_SOURCE_BRANCH empty (Primary) -> override present, NO child idle nudge', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), `Primary must also get the override (both roles); ctx=${ctx(r)}`);
    assert.ok(!/idle — reassign me a task or archive me/.test(ctx(r)), `Primary must NOT get the child idle nudge; ctx=${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('HOOK-TEXT SWEEP: emitted override never contains the blocked native verbs (either role)', () => {
  const h = makeHome();
  try {
    const rChild = testHook(HOOK, sessionPayload(), {
      home: h.home, expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    const rPrimary = testHook(HOOK, sessionPayload(), {
      home: h.home, expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' },
    });
    for (const c of [ctx(rChild), ctx(rPrimary)]) {
      assert.ok(!/message-parent/.test(c), `must never emit message-parent; ctx=${c}`);
      assert.ok(!/message-child/.test(c), `must never emit message-child; ctx=${c}`);
    }
  } finally {
    h.cleanup();
  }
});

test('NO-OP: no DevSwarm at all (no env) -> no injection', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: DEVSWARM_SOURCE_BRANCH set but DevSwarm not active -> no injection', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), {
      home: h.home,
      env: { DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

// P1 fix: a DevSwarm child's cwd is its PROJECT WORKTREE, not the plugin root,
// so a RELATIVE `scripts/devswarm.js` in emitted text only resolves when cwd
// happens to be the plugin root — everywhere else it is MODULE_NOT_FOUND. Every
// `node <cli>` instruction this hook emits must now carry an ABSOLUTE path that
// actually exists on disk, regardless of the spawning process's own cwd.
test('P1 FIX: every emitted `node <cli>` instruction carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    const rChild = testHook(HOOK, sessionPayload(), {
      home: h.home, expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    const rPrimary = testHook(HOOK, sessionPayload(), {
      home: h.home, expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' },
    });
    for (const c of [ctx(rChild), ctx(rPrimary)]) {
      const matches = [...c.matchAll(/`node ([^`]*?devswarm\.js)\b/g)];
      assert.ok(matches.length >= 2, `expected multiple node devswarm.js instructions; ctx=${c}`);
      for (const m of matches) {
        const cliPath = m[1];
        assert.ok(path.isAbsolute(cliPath), `emitted CLI path must be absolute, not relative: ${cliPath}`);
        assert.ok(fs.existsSync(cliPath), `emitted CLI path must exist on disk: ${cliPath}`);
        assert.ok(cliPath.endsWith(path.join('scripts', 'devswarm.js')), `must resolve to scripts/devswarm.js: ${cliPath}`);
      }
    }
  } finally {
    h.cleanup();
  }
});
