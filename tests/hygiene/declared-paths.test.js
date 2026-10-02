'use strict';
// declared-paths: every path the plugin declares or implies must exist, so a
// directory scan can read what the plugin runs. Covers hooks.json and
// monitors.json commands, ${CLAUDE_PLUGIN_ROOT} references in skill/agent text,
// and the rule that each skills/<dir> holds a SKILL.md.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..', 'plugins', 'anti-hall');
// Loose (non-skill) files allowed directly under skills/.
const LOOSE_SKILLS_FILES = new Set(['MODEL-POLICY.md']);
const ROOT_REF = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g;

function rootRefs(text) {
  return [...text.matchAll(ROOT_REF)].map((m) => m[1].replace(/[.,:;]+$/, '')).filter((p) => !p.includes('*'));
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('hooks.json is valid, typed, and every command target exists', () => {
  const h = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const bad = [];
  for (const [ev, groups] of Object.entries(h.hooks)) {
    assert.ok(Array.isArray(groups), `${ev} must be an array`);
    for (const g of groups) {
      if ('matcher' in g && typeof g.matcher !== 'string') bad.push(`${ev}: matcher must be a string`);
      assert.ok(Array.isArray(g.hooks), `${ev} group needs hooks[]`);
      for (const x of g.hooks) {
        if (x.type !== 'command' || typeof x.command !== 'string') bad.push(`${ev}: non-command hook`);
        if ('timeout' in x && typeof x.timeout !== 'number') bad.push(`${ev}: timeout must be a number`);
        const refs = rootRefs(x.command || '');
        if (refs.length === 0) bad.push(`${ev}: command has no CLAUDE_PLUGIN_ROOT path: ${x.command}`);
        for (const r of refs) if (!fs.existsSync(path.join(PLUGIN, r))) bad.push(`${ev}: missing ${r}`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('monitors.json entries are well-formed and their command targets exist', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'monitors', 'monitors.json'), 'utf8'));
  assert.ok(Array.isArray(m) && m.length > 0);
  for (const e of m) {
    for (const k of ['name', 'command', 'description']) assert.strictEqual(typeof e[k], 'string', `monitor ${k}`);
    const refs = rootRefs(e.command);
    assert.ok(refs.length > 0, 'monitor command must use CLAUDE_PLUGIN_ROOT');
    for (const r of refs) assert.ok(fs.existsSync(path.join(PLUGIN, r)), `missing ${r}`);
  }
});

test('every skills/<dir> has a SKILL.md and only allow-listed loose files sit beside them', () => {
  const dir = path.join(PLUGIN, 'skills');
  const bad = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) bad.push(`${e.name}/ has no SKILL.md`); }
    else if (!LOOSE_SKILLS_FILES.has(e.name)) bad.push(`unexpected loose file skills/${e.name}`);
  }
  assert.deepStrictEqual(bad, []);
});

test('${CLAUDE_PLUGIN_ROOT} paths named in skill and agent text exist', () => {
  const bad = [];
  for (const base of ['skills', 'agents']) {
    for (const f of walk(path.join(PLUGIN, base)).filter((p) => p.endsWith('.md'))) {
      for (const r of rootRefs(fs.readFileSync(f, 'utf8'))) {
        if (!fs.existsSync(path.join(PLUGIN, r))) bad.push(`${path.relative(PLUGIN, f)}: ${r}`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});
