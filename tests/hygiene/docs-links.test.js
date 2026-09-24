'use strict';
// Hygiene: every relative Markdown link to a .md file in README.md,
// plugins/anti-hall/README.md, and docs/**/*.md must resolve to a file that
// exists on disk, and every docs/*.md (top-level KB/guide docs) must be
// reachable from docs/README.md (the full doc index) or the root README.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function extractMdLinks(text) {
  const links = [];
  let m;
  while ((m = LINK_RE.exec(text))) {
    let target = m[1].trim();
    // strip markdown title syntax: (path "title")
    target = target.split(/\s+"/)[0];
    if (!target.endsWith('.md') && !target.includes('.md#')) continue;
    if (/^https?:\/\//.test(target)) continue; // external, not our concern here
    if (target.includes('<') || target.includes('>')) continue; // template placeholder, e.g. <date>/<session-id>.md
    target = target.split('#')[0];
    if (!target) continue;
    links.push(target);
  }
  return links;
}

function checkFile(relFile) {
  const abs = path.join(REPO, relFile);
  const text = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(abs);
  const violations = [];
  for (const target of extractMdLinks(text)) {
    const resolved = path.resolve(dir, target);
    if (!fs.existsSync(resolved)) {
      violations.push(`${relFile}: link "${target}" -> ${path.relative(REPO, resolved)} does not exist`);
    }
  }
  return violations;
}

test('README.md relative .md links resolve', () => {
  const violations = checkFile('README.md');
  assert.deepStrictEqual(violations, []);
});

test('plugins/anti-hall/README.md relative .md links resolve', () => {
  const violations = checkFile('plugins/anti-hall/README.md');
  assert.deepStrictEqual(violations, []);
});

test('plugins/anti-hall/codex/README.md relative .md links resolve', () => {
  const violations = checkFile('plugins/anti-hall/codex/README.md');
  assert.deepStrictEqual(violations, []);
});

test('docs/**/*.md relative .md links resolve', () => {
  const violations = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        violations.push(...checkFile(path.relative(REPO, full)));
      }
    }
  }
  walk(path.join(REPO, 'docs'));
  assert.deepStrictEqual(violations, []);
});

test('every docs/*.md is linked from docs/README.md or the root README', () => {
  const docsDir = path.join(REPO, 'docs');
  const topLevelDocs = fs
    .readdirSync(docsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map((e) => e.name);

  const indexText = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');
  const rootReadmeText = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const combined = indexText + '\n' + rootReadmeText;

  const missing = topLevelDocs.filter((name) => !combined.includes(name));
  assert.deepStrictEqual(missing, [], `docs not linked from docs/README.md or README.md: ${missing.join(', ')}`);
});
