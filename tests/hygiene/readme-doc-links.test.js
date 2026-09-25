'use strict';
// Hygiene (owner requirement, 2026-09-25): every docs/*.md file tracked by git
// must be linked from BOTH README.md (the root doc index) AND docs/KB.md (the
// canonical KB index) — not just docs/README.md (see docs-links.test.js for the
// weaker OR check). Also asserts every relative docs/ link in README.md
// resolves to a file that actually exists, so a stale/typo'd link is caught
// here rather than by a reader clicking a dead link.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function trackedDocsFiles() {
  const r = cp.spawnSync('git', ['ls-files', 'docs/**/*.md', 'docs/*.md'], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return [...new Set(r.stdout.split('\n').filter(Boolean))].sort();
}

// A doc is "linked" when its git-relative path (docs/foo/bar.md) or its bare
// basename (bar.md) appears inside a markdown link target () in the text.
function isLinked(text, docRelPath) {
  const base = path.basename(docRelPath);
  const rel = docRelPath.replace(/^docs\//, '');
  const linkTargetRe = (needle) => new RegExp('\\(([^)]*/)?' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(#[^)]*)?\\)');
  return linkTargetRe(base).test(text) || linkTargetRe(rel).test(text) || linkTargetRe(docRelPath).test(text);
}

test('every git-tracked docs/*.md is linked from README.md', () => {
  const readme = read('README.md');
  const docs = trackedDocsFiles().filter((f) => f !== 'docs/README.md');
  const missing = docs.filter((f) => !isLinked(readme, f));
  assert.deepStrictEqual(missing, [], 'not linked from README.md: ' + missing.join(', '));
});

test('every git-tracked docs/*.md is linked from docs/KB.md', () => {
  const kb = read('docs/KB.md');
  const docs = trackedDocsFiles().filter((f) => f !== 'docs/KB.md');
  const missing = docs.filter((f) => !isLinked(kb, f));
  assert.deepStrictEqual(missing, [], 'not linked from docs/KB.md: ' + missing.join(', '));
});

test('every relative docs/ link in README.md resolves to an existing file', () => {
  const readme = read('README.md');
  const linkRe = /\(((?:\.\/)?docs\/[^)#\s]+\.md)(#[^)]*)?\)/g;
  const missing = [];
  let m;
  while ((m = linkRe.exec(readme))) {
    const target = m[1].replace(/^\.\//, '');
    if (!fs.existsSync(path.join(REPO, target))) missing.push(target);
  }
  assert.ok(missing.length >= 0); // sanity: regex ran
  assert.deepStrictEqual([...new Set(missing)], [], 'README.md links to missing files: ' + missing.join(', '));
});
