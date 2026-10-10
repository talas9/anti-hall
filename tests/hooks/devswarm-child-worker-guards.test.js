'use strict';
// A DevSwarm CHILD workspace is a worker: edit-guard (and Bash edit parity) do not
// apply, and its own git commit/push/fetch runs inline. The Primary and a
// non-corroborated env stay gated. (peer report, SkyCrew child, 2026-10-09)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, editPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const CHILD = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'r1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'kid1' };
const PRIMARY = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'r1' };

function withHome(env, descriptor, fn) {
  const h = makeHome();
  try {
    if (descriptor) {
      const d = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'kid1.json'), '{}');
    }
    return fn(h.home, env);
  } finally { h.cleanup(); }
}
const edit = (home, env) => testHook('edit-guard.js', editPayload('Edit', { filePath: 'src/app.js' }), { home, env });
const bash = (command) => (home, env) => testHook('command-guard.js', {
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't', cwd: process.cwd(),
}, { home, env });

test('A: edit-guard allows a corroborated DevSwarm child workspace', () => {
  assert.strictEqual(withHome(CHILD, true, edit).status, 0);
});
test('A: edit-guard still blocks the Primary and an uncorroborated child env', () => {
  assert.strictEqual(withHome(PRIMARY, true, edit).status, 2);
  assert.strictEqual(withHome(CHILD, false, edit).status, 2);
});
test('A: Bash edit parity does not apply to a corroborated child, still does to the Primary', () => {
  const cmd = bash('sed -i s/a/b/ src/app.js');
  assert.strictEqual(withHome(CHILD, true, cmd).status, 0);
  assert.strictEqual(withHome(PRIMARY, true, cmd).status, 2);
});
test('B: child runs git commit + push of its own branch/submodule inline; Primary is gated', () => {
  const cmd = bash('git -C sub add -A && git -C sub commit -m "x" && git -C sub push origin HEAD');
  assert.strictEqual(withHome(CHILD, true, cmd).status, 0);
  assert.strictEqual(withHome(PRIMARY, true, cmd).status, 2);
});
test('B: a child still may not run builds or smuggle a heavy command into a git chain', () => {
  assert.strictEqual(withHome(CHILD, true, bash('npm run build')).status, 2);
  assert.strictEqual(withHome(CHILD, true, bash('git push origin HEAD && npm run build')).status, 2);
});
