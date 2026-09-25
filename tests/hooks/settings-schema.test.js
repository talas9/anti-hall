'use strict';
// settings-schema.js — validity checks for the declarative settings registry
// (v0.108.0). No behavior here, just shape: every entry must be internally
// consistent so settings.js can trust it without re-validating at runtime.

const { test } = require('node:test');
const assert = require('node:assert');

const SCHEMA = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');

const VALID_TYPES = new Set(['boolean', 'number', 'string', 'enum', 'csv', 'object']);

test('every section has a unique key, label, and at least one setting', () => {
  const seen = new Set();
  for (const s of SCHEMA.SECTIONS) {
    assert.ok(s.key && typeof s.key === 'string', 'section key');
    assert.ok(!seen.has(s.key), 'duplicate section key: ' + s.key);
    seen.add(s.key);
    assert.ok(s.label && typeof s.label === 'string', s.key + ' needs a label');
    assert.ok(Array.isArray(s.settings) && s.settings.length > 0, s.key + ' needs settings');
  }
});

test('every setting has a valid type, a unique key within its section, and a default matching its own validation rules', () => {
  for (const sec of SCHEMA.SECTIONS) {
    const seen = new Set();
    for (const st of sec.settings) {
      const id = sec.key + '.' + st.key;
      assert.ok(!seen.has(st.key), 'duplicate key: ' + id);
      seen.add(st.key);
      assert.ok(VALID_TYPES.has(st.type), id + ' has an unknown type: ' + st.type);
      assert.ok(st.description && typeof st.description === 'string', id + ' needs a description');
      assert.notStrictEqual(st.default, undefined, id + ' needs a default');

      if (st.type === 'enum') {
        assert.ok(Array.isArray(st.values) && st.values.length > 0, id + ' enum needs values');
        assert.ok(st.values.includes(st.default), id + " default must be one of its own enum's values");
      }
      if (st.type === 'number') {
        if (st.computed) {
          // No single real-world default exists (it's derived at call time from
          // other, themselves-overridable settings) — default MUST be null, not
          // a made-up literal, and the description must say so explicitly.
          assert.strictEqual(st.default, null, id + ' computed numeric setting must declare default: null, not a guessed literal');
          assert.match(st.description, /^computed:/, id + ' computed setting description must start with "computed:"');
        } else if (st.optional) {
          // Genuinely has no default (only meaningful when another setting
          // enables it) — default MUST be null, and the description must say so.
          assert.strictEqual(st.default, null, id + ' optional numeric setting must declare default: null, not a guessed literal');
          assert.match(st.description, /^optional:/, id + ' optional setting description must start with "optional:"');
        } else {
          assert.strictEqual(typeof st.default, 'number', id + ' number default must be a number');
          if (Number.isFinite(st.min)) assert.ok(st.default >= st.min, id + ' default below its own min');
          if (Number.isFinite(st.max)) assert.ok(st.default <= st.max, id + ' default above its own max');
          if (Number.isFinite(st.exclusiveMin)) assert.ok(st.default > st.exclusiveMin, id + ' default not above its own exclusiveMin');
        }
      }
      if (st.type === 'boolean') {
        assert.strictEqual(typeof st.default, 'boolean', id + ' boolean default must be a boolean');
      }
    }
  }
});

test('every legacy source has both file and key', () => {
  for (const sec of SCHEMA.SECTIONS) {
    for (const st of sec.settings) {
      if (!st.legacy) continue;
      assert.ok(st.legacy.file && st.legacy.key, sec.key + '.' + st.key + ' legacy needs {file, key}');
    }
  }
});

test('pluginOption keys are unique across the whole schema (they map 1:1 to plugin.json userConfig keys)', () => {
  const opts = SCHEMA.pluginOptionEntries();
  const keys = opts.map((o) => o.pluginOption);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate pluginOption keys: ' + JSON.stringify(keys));
});

test('every plugin.json userConfig key maps to a schema entry\'s pluginOption', () => {
  const pluginJson = require('../../plugins/anti-hall/.claude-plugin/plugin.json');
  const userConfigKeys = Object.keys(pluginJson.userConfig || {});
  assert.ok(userConfigKeys.length > 0, 'plugin.json should declare at least one userConfig entry');
  const schemaKeys = new Set(SCHEMA.pluginOptionEntries().map((o) => o.pluginOption));
  for (const k of userConfigKeys) {
    assert.ok(schemaKeys.has(k), 'plugin.json userConfig key "' + k + '" has no matching settings-schema.js pluginOption');
  }
  // and the reverse: every schema pluginOption is actually declared in plugin.json
  for (const k of schemaKeys) {
    assert.ok(userConfigKeys.includes(k), 'settings-schema.js pluginOption "' + k + '" is missing from plugin.json userConfig');
  }
});

// DRIFT GUARD: every non-advanced setting is exposed in Claude Code's native
// /config panel via plugin.json userConfig, and each userConfig entry's shape
// is derived from its schema entry (type, options, default, min/max, a
// section-prefixed title). Adding a headline setting without its userConfig
// row, or letting the two drift, fails here.
test('every non-advanced setting has a pluginOption (exposed in /config)', () => {
  for (const sec of SCHEMA.SECTIONS) {
    for (const e of sec.settings) {
      if (e.advanced || e.type === 'object') continue;
      assert.ok(e.pluginOption, sec.key + '.' + e.key + ' is non-advanced but has no pluginOption/userConfig row');
    }
  }
});

test('plugin.json userConfig entries match their schema entries (type/options/default/min/max/title)', () => {
  const uc = require('../../plugins/anti-hall/.claude-plugin/plugin.json').userConfig;
  for (const sec of SCHEMA.SECTIONS) {
    const prefix = sec.label.replace(/\s*\(.*\)$/, '') + ' · ';
    for (const e of sec.settings) {
      if (!e.pluginOption) continue;
      const u = uc[e.pluginOption];
      const id = e.pluginOption + ' (' + sec.key + '.' + e.key + ')';
      assert.ok(u, id + ' missing from userConfig');
      assert.strictEqual(u.type, { enum: 'string', csv: 'string' }[e.type] || e.type, id + ' type');
      assert.ok(u.title.startsWith(prefix) && u.title.length > prefix.length, id + ' title must start with "' + prefix + '": ' + u.title);
      assert.ok(typeof u.description === 'string' && u.description.length > 0, id + ' description');
      assert.ok(!/\[(verified|read by)/.test(u.description), id + ' description carries a source citation');
      if (e.type === 'enum') {
        assert.deepStrictEqual(u.options, e.values, id + ' options');
        for (const o of u.options) assert.ok(o.length >= 1 && o.length <= 64, id + ' option label length');
      } else {
        assert.strictEqual(u.options, undefined, id + ' options only for enums');
      }
      if (e.default === null || e.default === undefined) assert.strictEqual(u.default, undefined, id + ' default');
      else assert.deepStrictEqual(u.default, e.default, id + ' default');
      assert.strictEqual(u.min, e.type === 'number' ? e.min : undefined, id + ' min');
      assert.strictEqual(u.max, e.type === 'number' ? e.max : undefined, id + ' max');
    }
  }
});

test('findSection/findSetting/allSettings are consistent with SECTIONS', () => {
  const all = SCHEMA.allSettings();
  let count = 0;
  for (const sec of SCHEMA.SECTIONS) count += sec.settings.length;
  assert.strictEqual(all.length, count);
  for (const s of SCHEMA.SECTIONS) {
    assert.strictEqual(SCHEMA.findSection(s.key), s);
    for (const st of s.settings) {
      assert.strictEqual(SCHEMA.findSetting(s.key, st.key), st);
    }
  }
  assert.strictEqual(SCHEMA.findSection('does-not-exist'), null);
  assert.strictEqual(SCHEMA.findSetting('autoHandover', 'does-not-exist'), null);
});

test('autoHandover section carries exactly the contracted keys (enabled/pct/maxTokens/nag/nagStepPct/nagQuietMin)', () => {
  const sec = SCHEMA.findSection('autoHandover');
  assert.deepStrictEqual(sec.settings.map((s) => s.key).sort(),
    ['enabled', 'maxTokens', 'nag', 'nagQuietMin', 'nagStepPct', 'pct'].sort());
  const mt = SCHEMA.findSetting('autoHandover', 'maxTokens');
  assert.deepStrictEqual([mt.type, mt.min, mt.default, mt.env], ['number', 0, 0, 'ANTIHALL_AUTO_HANDOVER_MAX_TOKENS']);
  assert.strictEqual(SCHEMA.findSetting('autoHandover', 'enabled').default, true);
  assert.strictEqual(SCHEMA.findSetting('autoHandover', 'pct').default, 85);
  assert.strictEqual(SCHEMA.findSetting('autoHandover', 'nag').default, true);
  assert.strictEqual(SCHEMA.findSetting('autoHandover', 'nagStepPct').default, 5);
  assert.strictEqual(SCHEMA.findSetting('autoHandover', 'nagQuietMin').default, 15);
});
