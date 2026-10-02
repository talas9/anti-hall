'use strict';
// marketplace-description: the plugin page shows marketplace.json's
// plugins[0].description rather than plugin.json's, so the two must be the
// same string. A stale long description here once outlived several rewrites
// of plugin.json; this keeps them from drifting again.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const MARKETPLACE_JSON = path.join(REPO, '.claude-plugin', 'marketplace.json');
const PLUGIN_JSON = path.join(REPO, 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('marketplace plugins[0].description equals plugin.json description', () => {
  const market = readJson(MARKETPLACE_JSON);
  const plugin = readJson(PLUGIN_JSON);
  assert.strictEqual(typeof plugin.description, 'string');
  assert.ok(plugin.description.length > 0, 'plugin.json description is empty');
  assert.strictEqual(market.plugins[0].name, plugin.name);
  assert.strictEqual(market.plugins[0].description, plugin.description);
});

test('marketplace entry carries no version (plugin.json is the version authority)', () => {
  const market = readJson(MARKETPLACE_JSON);
  assert.ok(!('version' in market.plugins[0]));
  assert.ok(!('version' in market));
});
