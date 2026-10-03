'use strict';
// strict-frontmatter: SKILL.md, agent and command front matter must be strict
// YAML, not just whatever the lenient loader tolerates. An unquoted value
// containing ": " (or " #", a trailing colon, a leading indicator character)
// is rejected or mis-parsed by strict parsers, and the description is what
// decides when a skill is invoked. No YAML library here (Node built-ins
// only), so this is a small strict-enough checker for the shapes we use:
// single-line `key: value` at column 0, plain or double/single-quoted scalars.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');

function targets() {
  const out = execFileSync('git', ['ls-files', '-z', 'plugins/anti-hall'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\0').filter((f) => /\.md$/.test(f)
    && (/(^|\/)skills\/[^/]+\/SKILL\.md$/.test(f) || /(^|\/)(agents|commands)\/[^/]+\.md$/.test(f)));
}

// Returns a list of problems for one scalar value (empty = fine).
function scalarProblems(v) {
  if (v === '') return [];
  if (v[0] === '"') {
    // double-quoted: must close on the same line with only valid escapes inside
    const m = /^"((?:[^"\\]|\\["\\/bfnrt0aevN_LP xuU])*)"\s*$/.exec(v);
    return m ? [] : ['malformed double-quoted scalar'];
  }
  if (v[0] === "'") {
    return /^'(?:[^']|'')*'\s*$/.test(v) ? [] : ['malformed single-quoted scalar'];
  }
  const p = [];
  if (/^[[{*&!|>%@`]/.test(v)) p.push('plain scalar starts with an indicator character; quote it');
  if (v.includes(': ')) p.push('plain scalar contains ": "; quote it');
  if (/ #/.test(v)) p.push('plain scalar contains " #"; quote it');
  if (/:$/.test(v)) p.push('plain scalar ends with ":"; quote it');
  return p;
}

function frontMatterProblems(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return ['front matter must start with "---" on line 1'];
  const end = lines.indexOf('---', 1);
  if (end < 0) return ['front matter has no closing "---"'];
  const p = [];
  for (let i = 1; i < end; i++) {
    const l = lines[i];
    if (l.includes('\t')) p.push(`line ${i + 1}: tab character`);
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    const m = /^([A-Za-z0-9_-]+):(?: +(.*))?$/.exec(l);
    if (!m) { p.push(`line ${i + 1}: not a "key: value" line at column 0`); continue; }
    for (const e of scalarProblems((m[2] || '').trimEnd())) p.push(`line ${i + 1} (${m[1]}): ${e}`);
  }
  return p;
}

test('the checker rejects the known-bad shapes and accepts quoted ones', () => {
  assert.ok(scalarProblems('Use when: the user says x').length > 0);
  assert.ok(scalarProblems('a # b').length > 0);
  assert.ok(scalarProblems('ends:').length > 0);
  assert.ok(scalarProblems('[x]').length > 0);
  assert.ok(scalarProblems('"unclosed').length > 0);
  assert.ok(scalarProblems('"bad "inner" quote"').length > 0);
  assert.deepStrictEqual(scalarProblems('"Use when: \\"x\\" # ok:"'), []);
  assert.deepStrictEqual(scalarProblems('plain text, with - dashes'), []);
});

test('every SKILL.md / agent / command front matter is strict YAML', () => {
  const files = targets();
  assert.ok(files.length >= 30, `expected to find the skill/agent files, found ${files.length}`);
  const bad = [];
  for (const f of files) {
    for (const p of frontMatterProblems(fs.readFileSync(path.join(REPO, f), 'utf8'))) bad.push(`${f}: ${p}`);
  }
  assert.deepStrictEqual(bad, [], 'front matter problems:\n' + bad.join('\n'));
});
