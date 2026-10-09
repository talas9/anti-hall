'use strict';
// Every Jev integration id used at a call site must be registered in all three
// registries: jev-setup KNOWN_INTEGRATIONS (status/mode), the settings-schema
// jevIntegrations keys (/config + settings), and be resolvable by getMode.
// Regression: speculationFramed was called from speculation-guard.js but absent
// from KNOWN_INTEGRATIONS, so `jev status`/`mode` could not see or switch it.
// (jev-report enumerates ids from logged rows, so it has no registry to drift.)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'codex') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Call-site ids: an `id: '<name>'` literal followed (within 600 chars) by a Jev
// call-shape field (trust / question / outcome), plus `const ID = '<name>'` in
// files that call Jev.
function callSiteIds() {
  const ids = new Set();
  for (const d of ['hooks', 'scripts', 'companion']) {
    for (const f of walk(path.join(ROOT, d), [])) {
      const s = fs.readFileSync(f, 'utf8');
      if (!/jev-assist/.test(s)) continue;
      for (const m of s.matchAll(/\bid:\s*'([A-Za-z]+)'/g)) {
        if (/\b(trust|question|outcome):/.test(s.slice(m.index, m.index + 600))) ids.add(m[1]);
      }
      for (const m of s.matchAll(/\bconst ID = '([A-Za-z]+)'/g)) ids.add(m[1]);
    }
  }
  return ids;
}

test('call-site discovery is non-vacuous (finds the known framed + routing ids)', () => {
  const ids = callSiteIds();
  for (const id of ['speculation', 'speculationFramed', 'modelRouting', 'dispatchTier', 'devswarmStepMap']) {
    assert.ok(ids.has(id), `discovery missed ${id}`);
  }
  assert.ok(ids.size >= 15, `only ${ids.size} ids discovered`);
});

test('every Jev call-site id is in KNOWN_INTEGRATIONS and the settings schema', () => {
  const { KNOWN_INTEGRATIONS } = require(path.join(ROOT, 'scripts', 'jev-setup.js'));
  const { SECTIONS } = require(path.join(ROOT, 'hooks', 'lib', 'settings-schema.js'));
  const schemaKeys = new Set(SECTIONS.find((s) => s.key === 'jevIntegrations').settings.map((s) => s.key));
  const known = new Set(KNOWN_INTEGRATIONS);
  for (const id of callSiteIds()) {
    assert.ok(known.has(id), `${id} missing from jev-setup KNOWN_INTEGRATIONS`);
    assert.ok(schemaKeys.has(id), `${id} missing from settings-schema jevIntegrations`);
  }
});
