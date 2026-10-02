'use strict';
// Permanent guard: with an empty home and an empty env every setting resolves
// to its schema default, and every plugin.json userConfig row declares the same
// default as its schema entry. Together they make "remove a row from the
// manifest" a no-op for behaviour. Isolated tmp HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeHome } = require('../helpers/fixtures.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
const SCHEMA = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');
const manifest = require('../../plugins/anti-hall/.claude-plugin/plugin.json');

test('empty home + empty env: every schema setting resolves to its schema default', () => {
  const home = makeHome();
  try {
    const all = SCHEMA.allSettings();
    assert.ok(all.length > 200);
    for (const e of all) {
      const got = settings.get(e.section, e.key, undefined, { home: home.home, env: {} });
      assert.deepStrictEqual(got, e.default, e.section + '.' + e.key);
    }
  } finally { home.cleanup(); }
});

test('every manifest userConfig row default equals its schema default (no default row <-> null/undefined schema default)', () => {
  const byOption = new Map(SCHEMA.pluginOptionEntries().map((e) => [e.pluginOption, e]));
  let checked = 0;
  for (const [k, row] of Object.entries(manifest.userConfig)) {
    if (row.sensitive === true) continue; // credentials: not in the schema
    const e = byOption.get(k);
    assert.ok(e, k + ' has no schema entry');
    if (row.default === undefined) assert.ok(e.default === null || e.default === undefined, k + ': row has no default, schema default must be null');
    else assert.deepStrictEqual(row.default, e.default, k);
    checked++;
  }
  assert.strictEqual(checked, 10, 'the 10 headline rows');
});
