'use strict';
// cost-trim D5: skill descriptions are the always-on listing cost. Every Claude and Codex
// skill description (+ when_to_use, counting rule shared with evals/anti-hall/injection-profile.js)
// stays <= 200 chars; the long guidance lives in a "## When to use" section of the body.
// No skill carries disable-model-invocation (it cannot be configured).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..', 'plugins', 'anti-hall');
const CAP = 200;

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return JSON.parse(v);
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
function parse(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(t);
  assert.ok(m, `${file}: front matter`);
  const fm = {};
  for (const l of m[1].split('\n')) { const k = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l); if (k) fm[k[1]] = k[2]; }
  return { fm, body: m[2] };
}
function all() {
  const out = [];
  for (const [dir, label] of [['skills', 'claude'], [path.join('codex', 'skills'), 'codex']]) {
    const base = path.join(PLUGIN, dir);
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      const f = path.join(base, d.name, 'SKILL.md');
      if (d.isDirectory() && fs.existsSync(f)) out.push({ label, name: d.name, file: f });
    }
  }
  return out;
}

test('59 skills found (28 Claude + 31 Codex)', () => {
  const s = all();
  assert.strictEqual(s.filter((x) => x.label === 'claude').length, 28);
  assert.strictEqual(s.filter((x) => x.label === 'codex').length, 31);
});

test('every description (+ when_to_use) is <= 200 chars and every body has "## When to use"', () => {
  for (const s of all()) {
    const { fm, body } = parse(s.file);
    const len = unquote(fm.description || '').length + unquote(fm.when_to_use || '').length;
    assert.ok(len > 0 && len <= CAP, `${s.label}/${s.name}: description length ${len}`);
    // the engine skills are generated from the engine registry (small trigger-first main skill + one per area), no long body
    if (!/^(anti-hall-)?engine(-|$)/.test(s.name)) assert.match(body, /^## When to use$/m, `${s.label}/${s.name}: missing "## When to use"`);
  }
});

test('no skill is hidden from model invocation (owner rule: no unconfigurable behaviour)', () => {
  for (const s of all()) {
    assert.strictEqual(parse(s.file).fm['disable-model-invocation'], undefined, `${s.label}/${s.name}`);
  }
});
