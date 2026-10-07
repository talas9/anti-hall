'use strict';
// Owner rule: never pin a model version; route by alias (haiku/sonnet/opus/fable).
// Fails if a versioned Claude model ID appears in any .js/.json/.toml under plugins/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'plugins');
const PINNED = /claude-(haiku|sonnet|opus|fable)-\d/;
const EXT = new Set(['.js', '.json', '.toml']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (EXT.has(path.extname(e.name)) && !/CHANGELOG/i.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

test('no versioned Claude model IDs under plugins/ (.js/.json/.toml)', () => {
  const hits = [];
  for (const f of walk(ROOT, [])) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (PINNED.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, [], 'pinned model IDs found; use an alias:\n' + hits.join('\n'));
});
