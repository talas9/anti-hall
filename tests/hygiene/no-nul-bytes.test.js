'use strict';
// no-nul-bytes: a literal NUL inside a source file makes git and strict
// text-only scanners treat the whole file as binary (no diffs, held on
// upload). Write the escape (`\0` / `\x00`) instead. Only real images may
// contain NUL bytes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const IMAGE = /\.(png|jpe?g|gif|webp|ico)$/i;

test('no tracked non-image file under plugins/anti-hall contains a NUL byte', () => {
  const out = execFileSync('git', ['ls-files', '-z', 'plugins/anti-hall'], { cwd: REPO, encoding: 'utf8' });
  const files = out.split('\0').filter((f) => f && !IMAGE.test(f));
  assert.ok(files.length > 100, `expected to scan the plugin tree, found ${files.length}`);
  const bad = [];
  for (const f of files) {
    const p = path.join(REPO, f);
    if (!fs.existsSync(p)) continue;
    if (fs.readFileSync(p).includes(0)) bad.push(f);
  }
  assert.deepStrictEqual(bad, [], 'files with a literal NUL byte (use \\0 or \\x00):\n' + bad.join('\n'));
});
