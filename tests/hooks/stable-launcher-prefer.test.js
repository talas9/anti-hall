'use strict';
// preferStableLauncher + every model-visible site that prints a devswarm CLI path:
// the stable launcher is named when it exists (and the setting is on), else the
// version-pinned path. Sites: devswarm-child-turn, devswarm-parent-inbox.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const sl = require('../../plugins/anti-hall/hooks/lib/stable-launcher.js');

const PINNED = path.join('scripts', 'devswarm.js');

function plant(home) {
  const p = path.join(home, '.anti-hall', 'bin', 'devswarm.js');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '// stub\n');
  return p;
}

test('preferStableLauncher: present -> launcher; absent -> raw; setting off -> raw', () => {
  const h = makeHome();
  const prev = process.env.ANTIHALL_DEVSWARM_STABLE_LAUNCHER;
  try {
    assert.strictEqual(sl.preferStableLauncher('devswarm', '/raw/x.js', h.home), '/raw/x.js');
    const p = plant(h.home);
    assert.strictEqual(sl.preferStableLauncher('devswarm', '/raw/x.js', h.home), p);
    process.env.ANTIHALL_DEVSWARM_STABLE_LAUNCHER = 'false';
    assert.strictEqual(sl.preferStableLauncher('devswarm', '/raw/x.js', h.home), '/raw/x.js');
  } finally {
    if (prev === undefined) delete process.env.ANTIHALL_DEVSWARM_STABLE_LAUNCHER; else process.env.ANTIHALL_DEVSWARM_STABLE_LAUNCHER = prev;
    h.cleanup();
  }
});

test('devswarm-child-turn: injected CLI hints name the stable launcher when present, pinned path otherwise', () => {
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'go', cwd: '/tmp' };
  const env = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'b-1', DEVSWARM_BUILDER_NAME: 'main-repo1' };
  const h = makeHome();
  try {
    const before = testHook('devswarm-child-turn.js', payload, { home: h.home, env }).json.hookSpecificOutput.additionalContext;
    assert.ok(before.includes(PINNED), `no launcher -> pinned path; ctx=${before}`);
    const p = plant(h.home);
    const after = testHook('devswarm-child-turn.js', payload, { home: h.home, env }).json.hookSpecificOutput.additionalContext;
    assert.ok(after.includes('node ' + p), `launcher present -> must be named; ctx=${after}`);
    assert.ok(!after.includes(PINNED), `pinned path must not appear; ctx=${after}`);
  } finally { h.cleanup(); }
});
