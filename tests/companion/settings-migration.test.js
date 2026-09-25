'use strict';
// migrateSettingsFromLegacy / runSettingsMigration — companion/lib/migrations.js
// v0.108.0 addition: forward-migrate legacy per-feature config (jev.json) into
// the unified ~/.anti-hall/settings.json. Idempotent, fail-open, NO-DELETE of
// the legacy file. Isolated tmp HOME throughout — never the real machine.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeHome } = require('../helpers/fixtures.js');
const M = require('../../plugins/anti-hall/companion/lib/migrations.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');

function jevPath(home) { return path.join(home, '.anti-hall', 'jev.json'); }

test('migrateSettingsFromLegacy: no legacy file -> nothing to migrate, no error', () => {
  const home = makeHome();
  try {
    const r = M.migrateSettingsFromLegacy(home.home);
    assert.deepStrictEqual(r, { ok: true, migrated: 0, errors: 0 });
    assert.deepStrictEqual(settings.load({ home: home.home }), {});
  } finally {
    home.cleanup();
  }
});

test('migrateSettingsFromLegacy: forwards every mapped jev.json field into settings.json, leaves jev.json untouched', () => {
  const home = makeHome();
  try {
    const legacy = {
      enabled: true, transport: 'typesafe', keyFile: '~/.config/x', timeoutMs: 2000,
      confidenceThreshold: 0.7, triage: false, triageUrgentThreshold: 0.5,
    };
    fs.writeFileSync(jevPath(home.home), JSON.stringify(legacy));

    const r = M.migrateSettingsFromLegacy(home.home);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.errors, 0);
    assert.strictEqual(r.migrated, 7, 'all 7 legacy-mapped jev fields migrated');

    for (const [k, v] of Object.entries(legacy)) {
      assert.strictEqual(settings.get('jev', k, undefined, { home: home.home }), v, k);
    }

    // legacy file is untouched (byte-identical), never deleted
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jevPath(home.home), 'utf8')), legacy);
  } finally {
    home.cleanup();
  }
});

test('migrateSettingsFromLegacy: idempotent — running twice does not change or duplicate anything', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(jevPath(home.home), JSON.stringify({ enabled: true, timeoutMs: 1800 }));
    M.migrateSettingsFromLegacy(home.home);
    const after1 = settings.load({ home: home.home });
    const r2 = M.migrateSettingsFromLegacy(home.home);
    assert.strictEqual(r2.migrated, 0, 'second run finds nothing new to migrate');
    assert.deepStrictEqual(settings.load({ home: home.home }), after1, 'store unchanged on re-run');
  } finally {
    home.cleanup();
  }
});

test('migrateSettingsFromLegacy: never overwrites a value the user (or a prior run) already set in settings.json', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(jevPath(home.home), JSON.stringify({ enabled: true }));
    settings.set('jev', 'enabled', false, { home: home.home }); // user's explicit choice, pre-dates migration
    const r = M.migrateSettingsFromLegacy(home.home);
    assert.strictEqual(r.migrated, 0, 'enabled already present -> not overwritten');
    assert.strictEqual(settings.get('jev', 'enabled', undefined, { home: home.home }), false, "user's value survives");
  } finally {
    home.cleanup();
  }
});

test('migrateSettingsFromLegacy: seeded-bad-state — corrupt jev.json fails open (counts as an error, migrates nothing, never throws)', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(jevPath(home.home), 'not json {{{');
    let r;
    assert.doesNotThrow(() => { r = M.migrateSettingsFromLegacy(home.home); });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors > 0);
    assert.strictEqual(r.migrated, 0);
    // corrupt legacy file is left exactly as found — no delete, no "fix"
    assert.strictEqual(fs.readFileSync(jevPath(home.home), 'utf8'), 'not json {{{');
  } finally {
    home.cleanup();
  }
});

test('runSettingsMigration: stamps a marker on a clean run; a second run for the same version is a no-op marker-skip', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(jevPath(home.home), JSON.stringify({ enabled: true }));
    const r1 = M.runSettingsMigration(home.home, { version: '0.108.0' });
    assert.strictEqual(r1.status, 'fixed');

    const before = settings.load({ home: home.home });
    const r2 = M.runSettingsMigration(home.home, { version: '0.108.0' });
    assert.strictEqual(r2.status, 'skipped');
    assert.match(r2.msg, /already applied/);
    assert.deepStrictEqual(settings.load({ home: home.home }), before, 'skip path touches nothing');
  } finally {
    home.cleanup();
  }
});

test('runSettingsMigration: a corrupt legacy file is reported failed and NOT stamped, so a later fix retries', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(jevPath(home.home), 'not json {{{');
    const r1 = M.runSettingsMigration(home.home, { version: '0.108.0' });
    assert.strictEqual(r1.status, 'failed');

    // fix the legacy file, re-run for the same version — must NOT be skipped by a stale marker
    fs.writeFileSync(jevPath(home.home), JSON.stringify({ enabled: true }));
    const r2 = M.runSettingsMigration(home.home, { version: '0.108.0' });
    assert.strictEqual(r2.status, 'fixed', 'a failed run must not stamp, so the retry actually runs');
    assert.strictEqual(settings.get('jev', 'enabled', undefined, { home: home.home }), true);
  } finally {
    home.cleanup();
  }
});

test('runSettingsMigration: nothing to migrate is reported skipped and still stamps (so future no-op calls are O(1))', () => {
  const home = makeHome();
  try {
    const r = M.runSettingsMigration(home.home, { version: '0.108.0' });
    assert.strictEqual(r.status, 'skipped');
    const state = M.readMarkers(home.home);
    assert.strictEqual(state.migrateSettingsFromLegacy.completedVersion, '0.108.0');
  } finally {
    home.cleanup();
  }
});

test('migrateSettingsFromLegacy: nested jev.json budget/audit keys forward-migrate; file-only prices stays legacy-read (no error)', () => {
  const home = makeHome();
  try {
    const legacy = {
      budget: { mode: 'watch', usdPerDay: 3, minCreditUsd: 10 },
      audit: { snippets: true },
      prices: { default: { inPerMTok: 1, outPerMTok: 4 } },
    };
    fs.writeFileSync(jevPath(home.home), JSON.stringify(legacy));
    const r = M.migrateSettingsFromLegacy(home.home);
    assert.deepStrictEqual(r, { ok: true, migrated: 4, errors: 0 });
    const store = settings.load({ home: home.home });
    assert.strictEqual(store.jev['budget.mode'], 'watch');
    assert.strictEqual(store.jev['budget.usdPerDay'], 3);
    assert.strictEqual(store.jev['budget.minCreditUsd'], 10);
    assert.strictEqual(store.jev['audit.snippets'], true);
    assert.ok(!('prices' in store.jev), 'object settings are file-only: never written by the migration');
    assert.deepStrictEqual(settings.get('jev', 'prices', null, { home: home.home }), legacy.prices, 'still read from jev.json');
    // idempotent
    assert.deepStrictEqual(M.migrateSettingsFromLegacy(home.home), { ok: true, migrated: 0, errors: 0 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jevPath(home.home), 'utf8')), legacy);
  } finally {
    home.cleanup();
  }
});

// ---------------------------------------------------------------------------
// jevIntegrations settings.json section migration (v0.108.4) — copies OLD
// settings.json storage (section 'jev', dotted key 'integrations.<id>') into
// the NEW canonical location (section 'jevIntegrations', key '<id>'). This
// is separate from the jev.json legacy-file forward-migration above: it
// migrates settings.json -> settings.json, one section to another.
// ---------------------------------------------------------------------------

function writeSettingsJson(home, obj) {
  const file = settings.path({ home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

test('migrateJevIntegrationsSection: forwards an old settings.json jev["integrations.<id>"] value into jevIntegrations.<id>, never deletes the old key', () => {
  const home = makeHome();
  try {
    // Simulate a pre-0.108.4 settings.json: the OLD schema entry this used to
    // validate against (section 'jev', key 'integrations.<id>') no longer
    // exists post-0.108.4, so settings.set() would (correctly) reject it now
    // -- write the raw file directly, the way an upgrading user's real
    // pre-existing settings.json looks.
    writeSettingsJson(home.home, { jev: { 'integrations.gitGuardSelfCredit': 'on' } });

    const r = M.migrateJevIntegrationsSection(home.home);
    assert.deepStrictEqual(r, { migrated: 1, errors: 0 });

    // new canonical key now holds the value
    assert.strictEqual(settings.get('jevIntegrations', 'gitGuardSelfCredit', undefined, { home: home.home }), 'on');
    // old key is left in place, byte-for-byte, never deleted
    const store = settings.load({ home: home.home });
    assert.strictEqual(store.jev['integrations.gitGuardSelfCredit'], 'on');
  } finally {
    home.cleanup();
  }
});

test('migrateJevIntegrationsSection: idempotent — running twice does not change or duplicate anything, and a value already set at the new key is NEVER overwritten', () => {
  const home = makeHome();
  try {
    writeSettingsJson(home.home, { jev: { 'integrations.modelRouting': 'shadow' } });
    // owner already explicitly promoted the NEW key to "on" before the migration ran
    settings.set('jevIntegrations', 'modelRouting', 'on', { home: home.home });

    const r1 = M.migrateJevIntegrationsSection(home.home);
    assert.deepStrictEqual(r1, { migrated: 0, errors: 0 }, 'new key already set -> old value never overwrites it');
    assert.strictEqual(settings.get('jevIntegrations', 'modelRouting', undefined, { home: home.home }), 'on');

    const r2 = M.migrateJevIntegrationsSection(home.home);
    assert.deepStrictEqual(r2, { migrated: 0, errors: 0 });
  } finally {
    home.cleanup();
  }
});

test('migrateJevIntegrationsSection: seeded-bad-state — a malformed old-key value (wrong enum) fails to validate and is counted as an error, never throws, never partially writes', () => {
  const home = makeHome();
  try {
    // Write directly (bypassing settings.set's own validation) to seed a
    // bad state the way a hand-edited or corrupted settings.json could.
    const file = settings.path({ home: home.home });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ jev: { 'integrations.claimLedger': 'not-a-real-mode' } }));

    const r = M.migrateJevIntegrationsSection(home.home);
    assert.deepStrictEqual(r, { migrated: 0, errors: 1 });
    assert.strictEqual(
      settings.get('jevIntegrations', 'claimLedger', undefined, { home: home.home }),
      'shadow',
      'invalid old value never wrote through -> the schema default still answers',
    );
    // the bad old value is left exactly as seeded, not deleted or "fixed"
    const store = settings.load({ home: home.home });
    assert.strictEqual(store.jev['integrations.claimLedger'], 'not-a-real-mode');
  } finally {
    home.cleanup();
  }
});

test('migrateJevIntegrationsSection: no old-style keys at all -> nothing migrated, no error', () => {
  const home = makeHome();
  try {
    const r = M.migrateJevIntegrationsSection(home.home);
    assert.deepStrictEqual(r, { migrated: 0, errors: 0 });
  } finally {
    home.cleanup();
  }
});

test('migrateSettingsFromLegacy: also runs the jevIntegrations section forward-migration as part of its own count/errors', () => {
  const home = makeHome();
  try {
    writeSettingsJson(home.home, {
      jev: { 'integrations.tasklistTrivial': 'on', 'integrations.supervisorBlockerLabel': 'off' },
    });

    const r = M.migrateSettingsFromLegacy(home.home);
    assert.strictEqual(r.ok, true);
    assert.ok(r.migrated >= 2, 'includes the 2 jevIntegrations rows on top of any jev.json legacy-file rows');

    assert.strictEqual(settings.get('jevIntegrations', 'tasklistTrivial', undefined, { home: home.home }), 'on');
    assert.strictEqual(settings.get('jevIntegrations', 'supervisorBlockerLabel', undefined, { home: home.home }), 'off');
  } finally {
    home.cleanup();
  }
});
