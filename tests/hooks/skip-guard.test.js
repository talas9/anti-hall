'use strict';
// skip-guard — the shared escape hatch. Unit-tests the isSkipped() module against
// a fake HOME's skip.json, plus an end-to-end check through command-guard.
//
// skip-guard reads os.homedir() at CALL TIME. On POSIX os.homedir() honors $HOME,
// but on Windows it reads USERPROFILE (then HOMEDRIVE+HOMEPATH) and IGNORES $HOME.
// So we set BOTH process.env.HOME and process.env.USERPROFILE to the fake home
// around each unit assertion, and restore BOTH after, to isolate cross-platform.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');

const SKIP_GUARD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'skip-guard.js');

// Evaluate isSkipped(name) with the home dir pointed at a fake home holding
// skipObj. os.homedir() reads $HOME on POSIX but USERPROFILE on Windows, so we
// set/restore BOTH per call. Fresh require each time (the module reads homedir
// live, so re-pointing the env per call is enough).
function withSkip(skipObj, fn) {
  const h = makeHome();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  try {
    if (skipObj !== null) h.writeSkip(skipObj);
    process.env.HOME = h.home;
    process.env.USERPROFILE = h.home; // Windows: os.homedir() reads this, not HOME
    // Force os.homedir() to honor the env (it caches nothing, reads env each call).
    delete require.cache[require.resolve(SKIP_GUARD)];
    const { isSkipped } = require(SKIP_GUARD);
    return fn(isSkipped);
  } finally {
    process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    h.cleanup();
  }
}

const future = () => Date.now() + 600000;
const past = () => Date.now() - 1000;

test('per-guard skip: command-guard skipped, git-guard not', () => {
  withSkip({ 'command-guard': future() }, (isSkipped) => {
    assert.strictEqual(isSkipped('command-guard'), true);
    assert.strictEqual(isSkipped('git-guard'), false);
  });
});

test('"all" covers noisy guards but NOT destructive git-guard', () => {
  withSkip({ all: future() }, (isSkipped) => {
    assert.strictEqual(isSkipped('command-guard'), true);
    assert.strictEqual(isSkipped('git-guard'), false, 'git-guard is destructive; "all" must not cover it');
  });
});

test('git-guard skipped only when named explicitly', () => {
  withSkip({ 'git-guard': future() }, (isSkipped) => {
    assert.strictEqual(isSkipped('git-guard'), true);
  });
});

test('expired skip -> false', () => {
  withSkip({ 'command-guard': past() }, (isSkipped) => {
    assert.strictEqual(isSkipped('command-guard'), false);
  });
});

test('missing skip file -> false', () => {
  withSkip(null, (isSkipped) => {
    assert.strictEqual(isSkipped('command-guard'), false);
  });
});

test('E2E: skip.json {command-guard: future} -> command-guard ALLOWS npm run build (coordinator)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'command-guard': future() });
    const r = testHook('command-guard.js', bashPayload('npm run build'), {
      home: h.home,
      env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    assert.strictEqual(r.status, 0, `expected allow under skip; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});
