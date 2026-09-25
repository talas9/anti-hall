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
  const fns = ['resolveThresholdsFromEnv', 'resolvePostSpawnGraceMs', 'reconcileSweepEnabled', 'resolveReconcileCooldownMs', 'resolveSupervisorSweepBudgetMs', 'housekeepingSweepEnabled', 'resolveHousekeepingCooldownMs', 'resolveSupervisorLogRotateBytes'];
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

// v0.108.0 lifecycle / retention / Jev metrics consumers: each resolves its
// settings with an explicit home, never os.homedir().
test('home-injection: auto-archive, retention and Jev budget/audit/price readers never call os.homedir()', () => {
  const lifecycle = require(P('companion', 'lib', 'devswarm-lifecycle.js'));
  const retention = require(P('companion', 'lib', 'devswarm-retention.js'));
  const assist = require(P('hooks', 'lib', 'jev-assist.js'));
  const report = require(P('scripts', 'jev-report.js'));
  const home = isolatedHome();
  try {
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({
      devswarm: { 'autoArchive.mode': 'dry-run', retention: { days: 7 } },
      jev: { 'budget.mode': 'watch', 'budget.usdPerDay': 2, 'budget.minCreditUsd': 5, 'audit.snippets': true, prices: { default: { inPerMTok: 1, outPerMTok: 2 } } },
    }));
    withPoisonedHomedir(() => {
      assert.strictEqual(lifecycle.readSettings(home, null, { HOME: home }).mode, 'dry-run');
      assert.strictEqual(retention.resolveSettings({ home, env: { HOME: home } }).days, 7);
      assert.deepStrictEqual(assist.readBudgetConfig(home), { mode: 'watch', usdPerDay: 2, usdPerWeek: null });
      assert.deepStrictEqual(assist.readAuditConfig(home), { snippets: true });
      assert.strictEqual(assist.computeCostUsd({ r: { ok: true, tokensIn: 1e6, tokensOut: 1e6 }, cachedFlag: false, home }).costUsd, 3);
      assert.strictEqual(report.readBudgetConfig(home).minCreditUsd, 5);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('legacy jev.json nested keys still resolve when settings.json has none', () => {
  const assist = require(P('hooks', 'lib', 'jev-assist.js'));
  const home = isolatedHome();
  try {
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'jev.json'), JSON.stringify({ budget: { mode: 'watch', usdPerDay: 4 }, audit: { snippets: true } }));
    withPoisonedHomedir(() => {
      assert.deepStrictEqual(assist.readBudgetConfig(home), { mode: 'watch', usdPerDay: 4, usdPerWeek: null });
      assert.deepStrictEqual(assist.readAuditConfig(home), { snippets: true });
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// getMode(id, fileCfg, home) — regression guard for the class of bug fixed
// in jev-assist.test.js: for a schema-backed integration id (jev.integrations.<id>
// has a settings-schema entry), getMode() resolves via
// schemaIntegrationMode(id, home) -> settings.js get(..., { home }). Called
// without a home, that silently fell back to os.homedir() and read whatever
// real machine ~/.anti-hall/settings.json says -- a test that omitted the
// 3rd arg would pass on a clean machine and fail on one with a customized
// Jev mode for that id. Simulate exactly that: point HOME at a temp dir
// holding a POISONED settings.json (values that would flip every assertion
// below if read), then prove getMode(id, cfg, home) with an isolated,
// unpoisoned `home` never touches it, and — via the poisoned os.homedir()
// throw — never falls back to the process's real home either.
test('getMode: schema-backed integration ids never fall back to os.homedir() or a poisoned real-HOME settings.json', () => {
  const assist = require(P('hooks', 'lib', 'jev-assist.js'));
  const poisonedRealHome = isolatedHome();
  const home = isolatedHome();
  const savedHome = process.env.HOME;
  try {
    // Poison what os.homedir()/env.HOME would resolve to if the code under
    // test leaked past the explicit `home` argument.
    fs.mkdirSync(path.join(poisonedRealHome, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(poisonedRealHome, '.anti-hall', 'settings.json'), JSON.stringify({
      jev: { integrations: { codexNudgeSubstantial: 'on', tasklistTrivial: 'off', gitGuardSelfCredit: 'on' } },
    }));
    process.env.HOME = poisonedRealHome;

    withPoisonedHomedir(() => {
      // Isolated `home` is empty -> schema defaults (all "shadow") must win,
      // never the poisoned real-HOME values above.
      assert.strictEqual(assist.getMode('codexNudgeSubstantial', { enabled: true }, home), 'shadow');
      assert.strictEqual(assist.getMode('tasklistTrivial', { enabled: true }, home), 'shadow');
      assert.strictEqual(assist.getMode('gitGuardSelfCredit', { enabled: true }, home), 'shadow');
    });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    fs.rmSync(poisonedRealHome, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
