'use strict';
// settings-home-injection — hygiene lint + live behavioral proof that NO
// settings-reading code path falls back to os.homedir() when it was handed
// an env object that carries a HOME (or USERPROFILE). This is the guard
// against the exact class of bug flagged during v0.108.0 review: a resolver
// that takes an explicit `env` parameter but still derives its home via
// os.homedir() internally would silently read the REAL developer machine's
// ~/.anti-hall/settings.json from a unit test that passes a synthetic env.
//
// METHOD: monkey-patch os.homedir() to THROW for the duration of each case,
// then call the function with a fake env whose HOME points at an isolated
// tmp dir. If the function still reaches os.homedir() internally, the throw
// propagates and the test fails loudly — there is no way to silently pass.
//
// SCOPE: only modules that export their resolver as a library function are
// require()'d here. hooks/command-guard.js, hooks/devswarm-parent-gate.js,
// hooks/devswarm-child-gate.js and hooks/devswarm-parent-reply-tracker.js are
// standalone hook SCRIPTS with no `module.exports` — requiring them directly
// runs the hook's own top-level dispatch (reads stdin, may process.exit()),
// which is not safe to trigger from a unit test. Their home-injection safety
// is covered instead by their own existing hook-level test suites (which
// already spawn them as subprocesses with an isolated HOME env).

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..', '..');
const P = (...parts) => path.join(REPO, 'plugins', 'anti-hall', ...parts);

function withPoisonedHomedir(fn) {
  const real = os.homedir;
  os.homedir = () => { throw new Error('os.homedir() called despite an env with HOME being passed — home-injection leak'); };
  try {
    fn();
  } finally {
    os.homedir = real;
  }
}

function isolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-home-inj-'));
}

test('settings.js getWithEnv/get never call os.homedir() when opts.home or an env.HOME is supplied', () => {
  const settings = require(P('hooks', 'lib', 'settings.js'));
  const home = isolatedHome();
  try {
    withPoisonedHomedir(() => {
      assert.doesNotThrow(() => settings.get('autoHandover', 'pct', undefined, { home }));
      assert.doesNotThrow(() => settings.getWithEnv('autoHandover', 'pct', undefined, { HOME: home }));
      assert.doesNotThrow(() => settings.getWithEnv('jev', 'enabled', undefined, { HOME: home }));
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Each entry: [module path parts, export name, args-builder(homeEnv) -> args array]
// Library modules ONLY — see file header for why hook scripts are excluded.
const DEVSWARM_CONSUMERS = [
  [['companion', 'lib', 'devswarm-archived-cache.js'], 'resolveActiveFloorPct', (e) => [e]],
  [['companion', 'lib', 'devswarm-archived-cache.js'], 'resolveArchivedGraceMs', (e) => [e]],
  [['companion', 'lib', 'liveness.js'], 'dormantThresholdMs', (e) => [e]],
  [['companion', 'lib', 'devswarm-drain-marker.js'], 'ttlMs', (e) => [e]],
  [['companion', 'devswarm-recover.js'], 'resolveCliThresholds', (e) => [e]],
  [['companion', 'devswarm-ingest.js'], 'resolveMonitorTimeoutSec', (e) => [undefined, e]],
  [['companion', 'lib', 'devswarm-row-select.js'], 'resolveRowStaleMs', (e) => [e]],
  [['companion', 'lib', 'devswarm-store.js'], 'requiredGatesFrom', (e) => [e]],
  [['hooks', 'lib', 'devswarm-wake.js'], 'wakeCron', (e) => [e]],
  [['hooks', 'lib', 'devswarm-detect.js'], 'isDevswarmActive', (e) => [e]],
  [['companion', 'devswarm-migrate.js'], 'resolveMarkRead', (e) => [{ env: e }]],
  [['companion', 'lib', 'devswarm-wake-watch.js'], 'pollMsFromEnv', (e) => [e]],
];

for (const [parts, exportName, buildArgs] of DEVSWARM_CONSUMERS) {
  test('home-injection: ' + parts.join('/') + '#' + exportName + '(env with HOME) never calls os.homedir()', () => {
    const mod = require(P(...parts));
    const fn = mod[exportName];
    assert.ok(typeof fn === 'function', exportName + ' must be exported from ' + parts.join('/'));
    const home = isolatedHome();
    try {
      withPoisonedHomedir(() => {
        assert.doesNotThrow(() => fn(...buildArgs({ HOME: home })));
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('home-injection: companion/devswarm-supervisor.js resolvers(env with HOME) never call os.homedir()', () => {
  const mod = require(P('companion', 'devswarm-supervisor.js'));
  const home = isolatedHome();
  const fns = ['resolveThresholdsFromEnv', 'resolvePostSpawnGraceMs', 'reconcileSweepEnabled', 'resolveReconcileCooldownMs', 'resolveSupervisorSweepBudgetMs'];
  try {
    withPoisonedHomedir(() => {
      for (const name of fns) {
        if (typeof mod[name] !== 'function') continue;
        assert.doesNotThrow(() => mod[name]({ HOME: home }), name);
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
