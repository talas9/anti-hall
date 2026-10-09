'use strict';
// Owner rule: never pin a model version; route by alias/tier (haiku/sonnet/opus/fable,
// frontier/workhorse/fast). Codex slugs resolve dynamically via companion/lib/codex-models.js.
// Fails if a pinned model ID/slug appears in any .js/.json/.toml under plugins/:
//   - Claude versioned IDs (claude-sonnet-4-5, claude-fable-5-1) and legacy (claude-3-5-sonnet, claude-3-opus)
//   - dated IDs (-20250929)
//   - OpenAI/Codex slugs (gpt-5.6-luna, gpt-6-astra)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'plugins');
const PINNED = [
  /claude-(haiku|sonnet|opus|fable)-\d/,
  /claude-\d/,
  /(?<![\w-])(haiku|sonnet|opus|fable)-\d+(-\d+)*-20\d{6}/,
  /[a-z]-20(2\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/,
  /(?<![\w-])gpt-\d+(\.\d+)?(-\w+)?/,
];
const EXT = new Set(['.js', '.json', '.toml']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
// Narrow allowlist: relative path (under plugins/) -> reason. Whole-file, history text only.
const ALLOW = {
  'anti-hall/companion/lib/codex-models.js':
    'header comment records the retired pinned slugs that motivated dynamic resolution (history)',
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (EXT.has(path.extname(e.name)) && !/CHANGELOG/i.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

test('no pinned model IDs/slugs under plugins/ (.js/.json/.toml)', () => {
  const hits = [];
  for (const f of walk(ROOT, [])) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (ALLOW[rel]) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (PINNED.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepStrictEqual(hits, [], 'pinned model IDs found; use an alias/tier:\n' + hits.join('\n'));
});

test('allowlist entries still exist and still need allowing', () => {
  for (const rel of Object.keys(ALLOW)) {
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(txt.split('\n').some((l) => PINNED.some((re) => re.test(l))), `stale allowlist entry: ${rel}`);
  }
});
