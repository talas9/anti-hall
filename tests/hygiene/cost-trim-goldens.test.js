'use strict';
// Frozen, normalised hook-output goldens for the cost-trim plan (Phase 0). Re-runs each
// scenario against this checkout (fresh temp HOME, env allowlist) and requires the
// normalised output to equal the golden byte for byte. Regenerate deliberately with
//   node evals/anti-hall/injection-profile.js --before plugins/anti-hall --after plugins/anti-hall \
//     --no-determinism --write-goldens tests/fixtures/cost-trim/goldens
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../evals/anti-hall/injection-profile.js');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'anti-hall');
const GOLDENS = path.join(ROOT, 'tests', 'fixtures', 'cost-trim', 'goldens');

// The streams Phase 0 freezes (+ task-guard nag and the two Codex-shaped SessionStart streams).
const REQUIRED = [
  'core-claude', 'orch-claude', 'orch-primary', 'subagent-normal', 'subagent-child',
  'task-tracker', 'tasklist-guard-nag', 'task-guard-nag', 'core-codex', 'orch-codex',
];

test('every required golden exists and is non-empty', () => {
  for (const id of REQUIRED) {
    const f = path.join(GOLDENS, id + '.json');
    assert.ok(fs.existsSync(f), 'missing golden ' + id);
    const g = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(g.scenario, id);
    assert.ok(g.outputs.length > 0 && g.outputs.every((o) => !o.skipped && o.status === 0 && o.text.length > 0), id + ' has an empty/skipped output');
  }
});

test('no extra, unlisted golden files', () => {
  const have = fs.readdirSync(GOLDENS).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
  assert.deepEqual(have, [...REQUIRED].sort());
});

test('goldens are normalised (placeholders, no temp paths)', () => {
  for (const id of REQUIRED) {
    const raw = fs.readFileSync(path.join(GOLDENS, id + '.json'), 'utf8');
    assert.ok(!/\/(?:private\/)?var\/folders|antihall-profile-|\/Users\/[a-z]/.test(raw), id + ' has an unnormalised path');
    assert.ok(!/\b1[0-9]{12}\b/.test(raw), id + ' has a raw epoch-ms');
  }
});

test('protocolLevel=full byte-equals every golden (the rollback reproduces the "before")', () => {
  // The default level is now `compact`; the goldens are today's text, i.e. protocolLevel=full (the rollback, D4).
  const cur = P.profileCheckout(PLUGIN, { env: { ANTIHALL_PROTOCOL_LEVEL: 'full' } });
  for (const id of REQUIRED) {
    const g = JSON.parse(fs.readFileSync(path.join(GOLDENS, id + '.json'), 'utf8'));
    const sc = cur.scenarios[id];
    assert.ok(sc, 'no scenario ' + id);
    assert.equal(sc.outputs.length, g.outputs.length, id + ' step count');
    g.outputs.forEach((go, i) => {
      assert.equal(sc.outputs[i].label, go.label);
      assert.equal(sc.outputs[i].text, go.text, id + '/' + go.label + ' drifted from golden');
    });
  }
});
