'use strict';
// plugin-icon: plugin.json declares `icon` as a path to an image inside the
// plugin folder; the file must exist and stay small (<= 256 KiB).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'plugins', 'anti-hall');
const MANIFEST = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
const MAX_BYTES = 262144;

test('plugin.json icon exists inside the plugin folder and is <= 256 KiB', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.strictEqual(typeof manifest.icon, 'string', 'plugin.json must declare icon');
  const resolved = path.resolve(PLUGIN_DIR, manifest.icon);
  const rel = path.relative(PLUGIN_DIR, resolved);
  assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), 'icon must stay inside the plugin folder');
  const st = fs.statSync(resolved);
  assert.ok(st.isFile(), 'icon path is not a file');
  assert.ok(st.size <= MAX_BYTES, `icon is ${st.size} bytes, max ${MAX_BYTES}`);
});
