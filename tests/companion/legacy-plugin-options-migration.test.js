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
function seed(home, options) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(claudeSettings(home), JSON.stringify({ theme: 'x', pluginConfigs: { 'anti-hall': { options } } }));
}

test('25 advanced settings carry pluginOptionLegacy and none of them is in the manifest', () => {
  const legacy = SCHEMA.allSettings().filter((e) => e.pluginOptionLegacy);
  assert.strictEqual(legacy.length, 25);
  for (const e of legacy) {
    assert.ok(e.advanced && e.pluginOption, e.key);
    assert.strictEqual(manifest.userConfig[e.pluginOption], undefined, e.pluginOption);
  }
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

test('migrateLegacyPluginOptions: copies non-default values to settings.json, skips defaults/already-set/invalid, never touches ~/.claude/settings.json', () => {
  const home = makeHome();
  try {
    seed(home.home, {
      guards_silent_agent_nudge_min: 45,        // non-default -> copied
      devswarm_stray_warn_max: 2,               // == schema default -> skipped
      devswarm_step_stall_min: 99,              // already set in settings.json -> kept
      devswarm_burn_cache_read_pct: 'banana',   // invalid -> skipped, not an error
      guards_edit_guard_allow: 'docs/**',       // locked safety key: carried over (already in force)
      guards_stash_guard: true,                 // NOT a legacy key (still a /config row) -> ignored
    });
    settings.set('devswarm', 'stepStallMin', 12, { home: home.home });
    const before = fs.readFileSync(claudeSettings(home.home), 'utf8');
    const r = M.migrateLegacyPluginOptions(home.home);
    assert.deepStrictEqual(r, { migrated: 2, errors: 0 });
    const store = settings.load({ home: home.home });
    assert.strictEqual(store.guards.silentAgentNudgeMin, 45);
    assert.strictEqual(store.guards.editGuardAllow, 'docs/**');
    assert.strictEqual(store.devswarm.stepStallMin, 12);
    assert.strictEqual(store.devswarm.strayWarnMax, undefined);
    assert.strictEqual(store.devswarm.burnCacheReadPct, undefined);
    assert.strictEqual(store.guards.stashGuard, undefined);
    assert.strictEqual(fs.readFileSync(claudeSettings(home.home), 'utf8'), before, 'Claude settings must be byte-identical (no write, no delete)');
    // idempotent
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home), { migrated: 0, errors: 0 });
    assert.strictEqual(settings.source('guards', 'silentAgentNudgeMin', { home: home.home, env: {} }), 'file');
  } finally { home.cleanup(); }
});

test('migrateLegacyPluginOptions: fail-open on missing, corrupt, or wrong-shaped Claude settings', () => {
  const home = makeHome();
  try {
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home), { migrated: 0, errors: 0 });
    fs.mkdirSync(path.join(home.home, '.claude'), { recursive: true });
    fs.writeFileSync(claudeSettings(home.home), '{ not json');
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home), { migrated: 0, errors: 0 });
    fs.writeFileSync(claudeSettings(home.home), JSON.stringify({ pluginConfigs: { 'anti-hall': { options: [1, 2] } } }));
    assert.deepStrictEqual(M.migrateLegacyPluginOptions(home.home), { migrated: 0, errors: 0 });
  } finally { home.cleanup(); }
});

test('wired: runSettingsMigration (update.js / doctor --repair path) performs it and stamps once', () => {
  const home = makeHome();
  try {
    seed(home.home, { guards_silent_agent_nudge_min: 45 });
    const r = M.runSettingsMigration(home.home, { version: '9.9.9' });
    assert.strictEqual(r.status, 'fixed');
    assert.strictEqual(settings.load({ home: home.home }).guards.silentAgentNudgeMin, 45);
    assert.strictEqual(M.runSettingsMigration(home.home, { version: '9.9.9' }).status, 'skipped');
  } finally { home.cleanup(); }
});
