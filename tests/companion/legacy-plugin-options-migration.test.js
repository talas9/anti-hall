'use strict';
// migrateLegacyPluginOptions + the schema-default "equals default means unset"
// guard for advanced settings whose /config row left plugin.json
// (pluginOptionLegacy). Isolated tmp HOME throughout — never the real machine.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeHome } = require('../helpers/fixtures.js');
const M = require('../../plugins/anti-hall/companion/lib/migrations.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
const SCHEMA = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');
const manifest = require('../../plugins/anti-hall/.claude-plugin/plugin.json');

function claudeSettings(home) { return path.join(home, '.claude', 'settings.json'); }
// shape: 'nested' = pluginConfigs[key].options (earlier anti-hall code),
// 'flat' = pluginConfigs[key] is the answers object (settings reference).
function seed(home, options, key, shape) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const entry = shape === 'flat' ? options : { options };
  fs.writeFileSync(claudeSettings(home), JSON.stringify({ theme: 'x', pluginConfigs: { [key || 'anti-hall']: entry } }));
}
const HEADLINE = ['safety.gitGuard', 'safety.commandGuard', 'safety.editGuard', 'safety.swarmGuard', 'autoHandover.enabled',
  'autoHandover.pct', 'jev.enabled', 'devswarm.supervisorMode', 'guards.modelRouting', 'limitConserve.mode'];
const LOCKED_KEYS = ['devswarm.maintainerNotice.post', 'guards.allowAnthropicEnvKey', 'guards.allowSubagentMailbox', 'guards.editGuardAllow',
  'guards.stashGuard', 'jev.allowLegacyKeyRead', 'jev.genericKeyVendor', 'safety.commandGuard', 'safety.editGuard', 'safety.gitGuard', 'safety.swarmGuard'];
const eligible = () => SCHEMA.allSettings().filter((e) => e.pluginOption && !e.headline && !e.locked && !e.homeOnly);
// n-th distinct valid non-default value for a setting (undefined when the type has no such value).
function alt(e, n) {
  const cands = e.type === 'boolean' ? [!e.default]
    : e.type === 'enum' ? e.values.filter((v) => v !== e.default)
    : e.type === 'number' ? [7, 3, 11, 5000, 1, 2].map((d) => (Number.isFinite(e.min) ? Math.max(d, e.min) : d)).map((d) => (Number.isFinite(e.max) ? Math.min(d, e.max) : d)).filter((v) => v !== e.default).filter((v, i, a) => a.indexOf(v) === i)
    : ['a/*', 'b/*'];
  return cands[n];
}
const envName = (e) => 'CLAUDE_PLUGIN_OPTION_' + e.pluginOption.toUpperCase();
const effective = (home, env) => Object.fromEntries(SCHEMA.allSettings().filter((e) => e.pluginOption)
  .map((e) => [e.section + '.' + e.key, settings.get(e.section, e.key, undefined, { home, env })]));
function allStored(n) {
  const o = {};
  for (const e of SCHEMA.allSettings()) if (e.pluginOption && alt(e, n) !== undefined) o[e.pluginOption] = alt(e, n);
  return o;
}

test('every non-headline pluginOption setting is flagged pluginOptionLegacy and none of them is in the manifest', () => {
  const legacy = SCHEMA.allSettings().filter((e) => e.pluginOptionLegacy);
  assert.strictEqual(legacy.length, 140);
  assert.deepStrictEqual(legacy.map((e) => e.pluginOption).sort(), SCHEMA.allSettings().filter((e) => e.pluginOption && !e.headline).map((e) => e.pluginOption).sort());
  for (const e of legacy) assert.strictEqual(manifest.userConfig[e.pluginOption], undefined, e.pluginOption);
});

test('old value keeps working with NO migration: stored option is still read (source plugin-option)', () => {
  const home = makeHome();
  try {
    seed(home.home, { guards_silent_agent_nudge_min: 45, devswarm_stray_warn_max: 9 });
    const o = { home: home.home, env: {} };
    assert.strictEqual(settings.get('guards', 'silentAgentNudgeMin', undefined, o), 45);
    assert.strictEqual(settings.source('guards', 'silentAgentNudgeMin', o), 'plugin-option');
    assert.strictEqual(settings.get('devswarm', 'strayWarnMax', undefined, o), 9);
    // a still-exported env var is honoured too
    const e = { home: home.home, env: { CLAUDE_PLUGIN_OPTION_DEVSWARM_STEP_STALL_MIN: '77' } };
    assert.strictEqual(settings.get('devswarm', 'stepStallMin', undefined, e), 77);
  } finally { home.cleanup(); }
});

test('default guard uses the SCHEMA default for removed keys: a stored default-equal option is unset', () => {
  const home = makeHome();
  try {
    // silentAgentNudgeMin default 20; settings.json holds a higher-tier-masked case: env var equal to the default
    seed(home.home, { guards_silent_agent_nudge_min: 20, devswarm_rearm_on_tick_only: true });
    const o = { home: home.home, env: { CLAUDE_PLUGIN_OPTION_DEVSWARM_STEP_STALL_MIN: '30' } };
    assert.strictEqual(settings.source('guards', 'silentAgentNudgeMin', o), 'default');
    assert.strictEqual(settings.source('devswarm', 'rearmOnTickOnly', o), 'default');
    assert.strictEqual(settings.source('devswarm', 'stepStallMin', o), 'default');
    assert.strictEqual(settings.get('devswarm', 'stepStallMin', undefined, o), 30);
    // and a legacy jev-style lower tier is not masked: a differing value still wins
    const d = { home: home.home, env: { CLAUDE_PLUGIN_OPTION_DEVSWARM_STEP_STALL_MIN: '31' } };
    assert.strictEqual(settings.source('devswarm', 'stepStallMin', d), 'plugin-option');
  } finally { home.cleanup(); }
});


test('headline: exactly the 10 headline keys are flagged, each keeps its manifest row; none is pluginOptionLegacy', () => {
  const flagged = SCHEMA.allSettings().filter((e) => e.headline).map((e) => e.section + '.' + e.key).sort();
  assert.deepStrictEqual(flagged, HEADLINE.slice().sort());
  for (const e of SCHEMA.allSettings().filter((x) => x.headline)) {
    assert.ok(manifest.userConfig[e.pluginOption], e.pluginOption + ' must stay a manifest row');
    assert.ok(!e.pluginOptionLegacy, e.key);
  }
});

test('migration scope: every pluginOption key except headline, locked, homeOnly', () => {
  const keys = eligible();
  assert.ok(keys.length >= 100, 'eligible count ' + keys.length);
  for (const e of keys) assert.ok(!HEADLINE.includes(e.section + '.' + e.key) && !e.locked && !e.homeOnly);
});

test('migrateLegacyPluginOptions: copies non-default values, skips defaults/already-set/invalid/locked/headline, never touches ~/.claude/settings.json', () => {
  const home = makeHome();
  try {
    seed(home.home, {
      guards_silent_agent_nudge_min: 45,        // non-default -> copied
      devswarm_stray_warn_max: 2,               // == schema default -> skipped
      devswarm_step_stall_min: 99,              // already set in settings.json -> kept
      devswarm_burn_cache_read_pct: 'banana',   // invalid -> skipped, not an error
      guards_edit_guard_allow: 'docs/**',       // locked -> never migrated
      guards_stash_guard: true,                 // locked -> never migrated
      guards_allow_plain_push: false,           // non-advanced, still a row: migrated now
      auto_handover_pct: 60,                    // headline -> never migrated
    });
    settings.set('devswarm', 'stepStallMin', 12, { home: home.home });
    const before = fs.readFileSync(claudeSettings(home.home), 'utf8');
    const r = M.migrateLegacyPluginOptions(home.home, { env: {} });
    assert.deepStrictEqual(r, { migrated: 2, skipped: 1, errors: 0 });
    const store = settings.load({ home: home.home });
    assert.strictEqual(store.guards.silentAgentNudgeMin, 45);
    assert.strictEqual(store.guards.allowPlainPush, false);
    assert.strictEqual(store.guards.editGuardAllow, undefined);
    assert.strictEqual(store.guards.stashGuard, undefined);
    assert.strictEqual(store.autoHandover, undefined);
    assert.strictEqual(store.devswarm.stepStallMin, 12);
    assert.strictEqual(store.devswarm.strayWarnMax, undefined);
    assert.strictEqual(store.devswarm.burnCacheReadPct, undefined);
    assert.strictEqual(fs.readFileSync(claudeSettings(home.home), 'utf8'), before, 'Claude settings must be byte-identical (no write, no delete)');
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home, { env: {} }), { migrated: 0, skipped: 3, errors: 0 }, 'idempotent');
    assert.strictEqual(settings.source('guards', 'silentAgentNudgeMin', { home: home.home, env: {} }), 'file');
    // locked/headline values keep resolving through the legacy read tier
    assert.strictEqual(settings.get('guards', 'editGuardAllow', undefined, { home: home.home, env: {} }), 'docs/**');
    assert.strictEqual(settings.get('autoHandover', 'pct', undefined, { home: home.home, env: {} }), 60);
  } finally { home.cleanup(); }
});

for (const key of ['anti-hall', 'anti-hall@anti-hall']) {
  for (const shape of ['nested', 'flat']) {
    test('stored options under pluginConfigs[' + key + '] (' + shape + '): resolver reads them and the migration copies them', () => {
      const home = makeHome();
      try {
        seed(home.home, { guards_silent_agent_nudge_min: 45, jev_budget_usd_per_day: 3 }, key, shape);
        const o = { home: home.home, env: {} };
        assert.strictEqual(settings.get('guards', 'silentAgentNudgeMin', undefined, o), 45);
        assert.strictEqual(settings.source('guards', 'silentAgentNudgeMin', o), 'plugin-option');
        const r = M.migrateLegacyPluginOptions(home.home, { env: {} });
        assert.strictEqual(r.errors, 0);
        assert.ok(r.migrated >= 1);
        assert.strictEqual(settings.load({ home: home.home }).guards.silentAgentNudgeMin, 45);
        assert.strictEqual(settings.source('guards', 'silentAgentNudgeMin', o), 'file');
      } finally { home.cleanup(); }
    });
  }
}

test('pluginConfigs: plugin-ID key outranks the bare name; flat outranks nested; other plugins ignored', () => {
  const home = makeHome();
  try {
    fs.mkdirSync(path.join(home.home, '.claude'), { recursive: true });
    fs.writeFileSync(claudeSettings(home.home), JSON.stringify({ pluginConfigs: {
      'other@x': { guards_silent_agent_nudge_min: 1 },
      'anti-hall': { options: { guards_silent_agent_nudge_min: 30, devswarm_stray_warn_max: 5 } },
      'anti-hall@anti-hall': { guards_silent_agent_nudge_min: 40, options: { guards_silent_agent_nudge_min: 35 } },
    } }));
    const o = { home: home.home, env: {} };
    assert.strictEqual(settings.get('guards', 'silentAgentNudgeMin', undefined, o), 40);
    assert.strictEqual(settings.get('devswarm', 'strayWarnMax', undefined, o), 5, 'bare-name keys the ID entry lacks still apply');
  } finally { home.cleanup(); }
});

test('REPRODUCED REVIEW BUG: env narrow + stored wide must not flip to wide (locked key is never migrated; non-locked skipped on conflict)', () => {
  const home = makeHome();
  try {
    seed(home.home, { guards_edit_guard_allow: 'wide/*', guards_silent_agent_nudge_min: 45 });
    const env = { CLAUDE_PLUGIN_OPTION_GUARDS_EDIT_GUARD_ALLOW: 'narrow/*', CLAUDE_PLUGIN_OPTION_GUARDS_SILENT_AGENT_NUDGE_MIN: '60' };
    const b = effective(home.home, env);
    const r = M.migrateLegacyPluginOptions(home.home, { env });
    assert.strictEqual(r.migrated, 0);
    assert.strictEqual(r.skipped, 1, 'the non-locked conflicting key is skipped');
    assert.strictEqual(b['guards.editGuardAllow'], 'narrow/*');
    assert.deepStrictEqual(effective(home.home, env), b);
    assert.strictEqual(settings.load({ home: home.home }).guards, undefined);
  } finally { home.cleanup(); }
});

// before == after for EVERY plugin-option setting, in every scenario.
function matrix(name, build, expect) {
  test('effective value unchanged by the migration: ' + name, () => {
    const home = makeHome();
    try {
      const { stored, env, prep } = build();
      seed(home.home, stored);
      if (prep) prep(home.home);
      const b = effective(home.home, env);
      const r = M.migrateLegacyPluginOptions(home.home, { env });
      assert.strictEqual(r.errors, 0);
      assert.deepStrictEqual(effective(home.home, env), b);
      expect(r, home.home);
    } finally { home.cleanup(); }
  });
}
matrix('env unset', () => ({ stored: allStored(0), env: {} }), (r, home) => {
  assert.ok(r.migrated >= 100, 'migrated ' + r.migrated);
  const store = settings.load({ home });
  for (const e of eligible()) assert.strictEqual(settings.lookup(store[e.section], e.key), alt(e, 0), e.section + '.' + e.key);
});
matrix('env set to a different value (CLAUDE_PLUGIN_OPTION_*)', () => {
  const env = {};
  for (const e of eligible()) env[envName(e)] = String(alt(e, 1) !== undefined ? alt(e, 1) : e.default);
  return { stored: allStored(0), env };
}, (r, home) => {
  assert.ok(r.skipped > 0);
  const store = settings.load({ home });
  for (const e of eligible()) {
    const conflicts = (alt(e, 1) !== undefined ? alt(e, 1) : e.default) !== alt(e, 0);
    if (conflicts) assert.strictEqual(settings.lookup(store[e.section], e.key), undefined, e.section + '.' + e.key + ' must not be migrated');
  }
});
matrix('env set to the same value', () => {
  const env = {};
  for (const e of eligible()) env[envName(e)] = String(alt(e, 0));
  return { stored: allStored(0), env };
}, (r) => assert.ok(r.migrated > 100));
matrix('ANTIHALL_* env tier set to a different value', () => {
  const env = {};
  for (const e of eligible()) if (e.env && alt(e, 1) !== undefined) env[e.env] = String(alt(e, 1));
  return { stored: allStored(0), env };
}, (r) => assert.ok(r.skipped > 0));
matrix('settings.json already holds a different value', () => ({
  stored: allStored(0), env: {},
  prep: (home) => { for (const e of eligible()) if (alt(e, 1) !== undefined) assert.ok(settings.set(e.section, e.key, alt(e, 1), { home, confirmed: true }).ok); },
}), (r) => assert.ok(r.migrated > 0, 'keys with no second value (booleans) still migrate'));

test('null-default budget keys: any valid stored value is "non-default"; invalid and env-conflicting are not migrated', () => {
  const home = makeHome();
  try {
    seed(home.home, { jev_budget_usd_per_day: 3, jev_budget_usd_per_week: 'lots', jev_budget_min_credit_usd: 4 });
    const o = { home: home.home, env: { CLAUDE_PLUGIN_OPTION_JEV_BUDGET_MIN_CREDIT_USD: '9' } };
    const b = effective(home.home, o.env);
    const r = M.migrateLegacyPluginOptions(home.home, { env: o.env });
    assert.deepStrictEqual(r, { migrated: 1, skipped: 1, errors: 0 });
    const store = settings.load({ home: home.home });
    assert.strictEqual(store.jev['budget.usdPerDay'], 3);
    assert.strictEqual(store.jev['budget.usdPerWeek'], undefined);
    assert.strictEqual(store.jev['budget.minCreditUsd'], undefined);
    assert.deepStrictEqual(effective(home.home, o.env), b);
  } finally { home.cleanup(); }
});

test('set(): opts.guard runs under the lock and false writes nothing', () => {
  const home = makeHome();
  try {
    const r = settings.set('guards', 'silentAgentNudgeMin', 45, { home: home.home, guard: () => false });
    assert.deepStrictEqual(r, { ok: true, skipped: true });
    assert.strictEqual(settings.load({ home: home.home }).guards, undefined);
  } finally { home.cleanup(); }
});

test('concurrent human set between the stored-options read and the write is never overwritten (re-check under the lock)', () => {
  const home = makeHome();
  const real = settings.readStoredPluginOptions;
  try {
    seed(home.home, { guards_silent_agent_nudge_min: 45 });
    settings.readStoredPluginOptions = (o) => {
      const out = real(o);
      assert.ok(settings.set('guards', 'silentAgentNudgeMin', 25, { home: home.home }).ok); // the human wins the race
      return out;
    };
    const r = M.migrateLegacyPluginOptions(home.home, { env: {} });
    assert.deepStrictEqual(r, { migrated: 0, skipped: 1, errors: 0 });
    assert.strictEqual(settings.load({ home: home.home }).guards.silentAgentNudgeMin, 25);
  } finally { settings.readStoredPluginOptions = real; home.cleanup(); }
});

test('migrateLegacyPluginOptions: fail-open on missing, corrupt, or wrong-shaped Claude settings', () => {
  const home = makeHome();
  const z = { migrated: 0, skipped: 0, errors: 0 };
  try {
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home, { env: {} }), z);
    fs.mkdirSync(path.join(home.home, '.claude'), { recursive: true });
    fs.writeFileSync(claudeSettings(home.home), '{ not json');
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home, { env: {} }), z);
    fs.writeFileSync(claudeSettings(home.home), JSON.stringify({ pluginConfigs: { 'anti-hall': { options: [1, 2] } } }));
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home, { env: {} }), z);
  } finally { home.cleanup(); }
});

test('wired: runSettingsMigration (update.js / doctor --repair path) performs it and stamps once', () => {
  const home = makeHome();
  try {
    seed(home.home, { guards_silent_agent_nudge_min: 45 });
    const r = M.runSettingsMigration(home.home, { version: '9.9.9', env: {} });
    assert.strictEqual(r.status, 'fixed');
    assert.strictEqual(settings.load({ home: home.home }).guards.silentAgentNudgeMin, 45);
    assert.strictEqual(M.runSettingsMigration(home.home, { version: '9.9.9', env: {} }).status, 'skipped');
  } finally { home.cleanup(); }
});

// PRECEDENCE for a setting whose manifest row was removed (a non-advanced one, guards.outputVerifyGuard):
// env > ~/.anti-hall/settings.json > stored old plugin option (both key forms) > legacy > default;
// a stored value equal to the schema default counts as unset.
test('removed-row precedence: env > settings.json > stored option (flat/nested, both key forms) > default; default-equal stored = unset', () => {
  const e = SCHEMA.findSetting('guards', 'outputVerifyGuard');
  assert.ok(!e.advanced && e.pluginOptionLegacy && e.env);
  const ho = () => makeHome();
  for (const [key, shape] of [['anti-hall', 'nested'], ['anti-hall', 'flat'], ['anti-hall@anti-hall', 'nested'], ['anti-hall@anti-hall', 'flat']]) {
    const home = ho();
    try {
      seed(home.home, { guards_output_verify_guard: false }, key, shape);
      assert.strictEqual(settings.get('guards', 'outputVerifyGuard', undefined, { home: home.home, env: {} }), false, key + '/' + shape);
      assert.strictEqual(settings.source('guards', 'outputVerifyGuard', { home: home.home, env: {} }), 'plugin-option');
      settings.set('guards', 'outputVerifyGuard', true, { home: home.home, env: {} });
      assert.strictEqual(settings.get('guards', 'outputVerifyGuard', undefined, { home: home.home, env: {} }), true, 'settings.json beats stored option');
      assert.strictEqual(settings.get('guards', 'outputVerifyGuard', undefined, { home: home.home, env: { [e.env]: 'off' } }), false, 'env beats settings.json');
    } finally { home.cleanup(); }
  }
  const home = ho();
  try {
    seed(home.home, { guards_output_verify_guard: true });
    assert.strictEqual(settings.source('guards', 'outputVerifyGuard', { home: home.home, env: {} }), 'default');
  } finally { home.cleanup(); }
});

test('removed-row null-default budget keys keep working: a stored value is real; absent resolves to null', () => {
  for (const k of ['usdPerDay', 'usdPerWeek', 'minCreditUsd']) {
    const e = SCHEMA.findSetting('jev', 'budget.' + k);
    assert.ok(e.pluginOption && e.pluginOptionLegacy && e.default === null, k);
    const home = makeHome();
    try {
      assert.strictEqual(settings.get('jev', 'budget.' + k, undefined, { home: home.home, env: {} }), null);
      seed(home.home, { [e.pluginOption]: 5 });
      assert.strictEqual(settings.get('jev', 'budget.' + k, undefined, { home: home.home, env: {} }), 5);
    } finally { home.cleanup(); }
  }
});

test('safety: locked set unchanged; homeOnly keys ignore stored options and env', () => {
  const locked = SCHEMA.allSettings().filter((e) => e.locked).map((e) => e.section + '.' + e.key).sort();
  assert.deepStrictEqual(locked, LOCKED_KEYS);
  for (const e of SCHEMA.allSettings().filter((x) => x.homeOnly)) {
    const home = makeHome();
    try {
      const env = {};
      if (e.env) env[e.env] = e.type === 'boolean' ? String(!e.default) : 'x';
      if (e.pluginOption) env['CLAUDE_PLUGIN_OPTION_' + e.pluginOption.toUpperCase()] = e.type === 'boolean' ? String(!e.default) : 'x';
      if (e.pluginOption) seed(home.home, { [e.pluginOption]: e.type === 'boolean' ? !e.default : 'x' });
      assert.deepStrictEqual(settings.get(e.section, e.key, undefined, { home: home.home, env }), e.default, e.section + '.' + e.key);
    } finally { home.cleanup(); }
  }
});

// DOWNGRADE: after migrateLegacyPluginOptions the value lives in settings.json, which outranks the stored plugin option,
// so an older plugin version (that still has the row and reads settings.json first) resolves the same effective value.
test('downgrade: after migration the settings-file value wins over the stored option', () => {
  const home = makeHome();
  try {
    seed(home.home, { guards_silent_agent_nudge_min: 45 });
    const o = { home: home.home, env: {} };
    assert.strictEqual(settings.get('guards', 'silentAgentNudgeMin', undefined, o), 45);
    M.migrateLegacyPluginOptions(home.home, { env: {} });
    assert.strictEqual(settings.source('guards', 'silentAgentNudgeMin', o), 'file');
    assert.strictEqual(settings.get('guards', 'silentAgentNudgeMin', undefined, o), 45);
  } finally { home.cleanup(); }
});
