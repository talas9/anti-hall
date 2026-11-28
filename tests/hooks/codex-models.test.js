'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCodexModel } = require('../../plugins/anti-hall-node/companion/lib/codex-models.js');

function cache(models) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const f = path.join(d, 'models_cache.json');
  fs.writeFileSync(f, JSON.stringify({ models }));
  return f;
}
const m = (slug, priority, description, visibility = 'list') => ({ slug, priority, description, visibility });

test('0.171-style catalog wording resolves all three roles', () => {
  const cachePath = cache([
    m('s2', 1, 'Fast, go-to model for coding and everyday work.'),
    m('a2', 2, 'Our most capable model for complex coding and professional work.'),
    m('hid', 4, 'Fast and affordable agentic coding model.', 'hide'),
    m('s1', 5, 'Previous generation model for coding and everyday work.'),
    m('lu', 8, 'Fast and affordable model for easier tasks.'),
    m('lu5', 11, 'Legacy fast model for simpler tasks.'),
  ]);
  assert.strictEqual(resolveCodexModel('frontier', { cachePath }), 'a2');
  assert.strictEqual(resolveCodexModel('workhorse', { cachePath }), 's2');
  assert.strictEqual(resolveCodexModel('fast', { cachePath }), 'lu');
});

test('0.166-style wording still resolves', () => {
  const cachePath = cache([
    m('w', 1, 'latest workhorse model for coding and everyday work'),
    m('f', 2, 'frontier intelligence for the most demanding work'),
  ]);
  assert.strictEqual(resolveCodexModel('critic', { cachePath }), 'f');
  assert.strictEqual(resolveCodexModel('implement', { cachePath }), 'w');
});

test('fail-open: unknown role, no match, missing cache -> null', () => {
  const cachePath = cache([m('x', 1, 'something else')]);
  assert.strictEqual(resolveCodexModel('frontier', { cachePath }), null);
  assert.strictEqual(resolveCodexModel('nope', { cachePath }), null);
  assert.strictEqual(resolveCodexModel('frontier', { cachePath: '/nonexistent/x.json' }), null);
});
