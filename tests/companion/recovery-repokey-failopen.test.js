'use strict';
// D27: recovery.js requires lib/devswarm-repokey.js at its OWN top level, GUARDED
// (recovery.js:52-59) precisely because recovery.js is itself required TOP-LEVEL by
// devswarm-supervisor.js:41 (the sweep loop) and scripts/devswarm.js:129 — neither
// of whose own fail-open guarantees wrap their own top-level requires. An UNGUARDED
// require of a corrupt/deleted devswarm-repokey.js would crash both consumers
// before fail-open ever engaged. This proves the guard actually holds: preloading a
// fixture that makes devswarm-repokey.js unloadable (mirrors break-devswarm-wake.js's
// approach for lib/devswarm-wake.js, see tests/hooks/devswarm-child-gate.test.js),
// requiring recovery.js still succeeds and notifyParentEscalation still runs to
// completion without throwing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Forward-slash the path: Node's NODE_OPTIONS parser eats backslashes (escape
// char), so a raw Windows path is mangled before --require resolves it. Forward
// slashes are backslash-free and Node accepts them for require on Windows; a no-op
// on POSIX. Mirrors tests/hooks/devswarm-child-gate.test.js:657.
const BREAK_REPOKEY = path.join(__dirname, '..', 'helpers', 'break-devswarm-repokey.js').replace(/\\/g, '/');
const RECOVERY_JS = path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'recovery.js',
).replace(/\\/g, '/');

test('D27 fail-open: an UNLOADABLE devswarm-repokey.js -> requiring recovery.js still succeeds, notifyParentEscalation still does not throw', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-recovery-d27-'));
  try {
    const script = `
      const M = require(${JSON.stringify(RECOVERY_JS)});
      const worktreePath = ${JSON.stringify(path.join(home, 'wt'))};
      require('fs').mkdirSync(worktreePath, { recursive: true });
      const descriptor = { id: 'child-d27', worktreePath, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
      const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: Date.now() - 60000, nudgeAttempts: 0, nudgedAt: null, pending: true };
      // Must not throw even though the D27-guarded repokey require failed at
      // recovery.js's own top level.
      M.notifyParentEscalation(descriptor, verdict, { home: ${JSON.stringify(home)}, now: Date.now() }, undefined);
      process.stdout.write('OK');
    `;
    const env = Object.assign({}, process.env, { NODE_OPTIONS: `--require "${BREAK_REPOKEY}"` });
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env, timeout: 10000 });
    assert.strictEqual(res.status, 0, `must exit 0 (require + call must not throw); stderr=${res.stderr}`);
    assert.ok(res.stdout.includes('OK'), `notifyParentEscalation must complete; stdout=${res.stdout} stderr=${res.stderr}`);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});
