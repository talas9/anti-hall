'use strict';
// companion/lib/codex-models.js — category-based Codex model resolution.
//
// WHY category, not a hardcoded slug map: anti-hall used to pin literal
// model names (gpt-5.6-sol, gpt-5.4-mini, ...) into workflow scripts and a
// SKILL.md policy table. OpenAI silently retired/renamed generations and
// every pinned reference went dead at once (400s: "not supported when using
// Codex with a ChatGPT account"). This resolver instead reads the CLI's own
// live model cache and picks a slug by CATEGORY (frontier/workhorse/fast),
// using the cache's own description text + priority ordering — never a
// hardcoded slug — so a brand-new generation (gpt-7-*, ...) is picked up
// automatically with zero code change.
//
// All fixtures below are synthetic. Never reads the user's real
// ~/.codex/models_cache.json.
//
// MUTATION CHECKS (each must turn a named test RED):
//   M1: drop the priority sort (return first match instead of newest) ->
//       "a synthetic newer generation is preferred with no code change".
//   M2: don't filter `visibility !== 'list'` -> "hidden models are excluded".
//   M3: don't check `upgrade.retirement_at` -> "a retiring model is skipped
//       when a live sibling exists in the same category".
//   M4: swap fail-open for a hardcoded fallback slug -> every one of the
//       "-> null" tests below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCodexModel } = require('../../plugins/anti-hall/companion/lib/codex-models.js');

function mkCache(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-'));
  const p = path.join(dir, 'models_cache.json');
  fs.writeFileSync(p, JSON.stringify({
    fetched_at: '2026-09-23T00:00:00Z',
    etag: 'W/"fixture"',
    client_version: '0.155.1',
    identity: 'fixture',
    models,
  }));
  return { path: p, dir, cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

// A trimmed, realistic slice of the live 2026-09-23 catalog (verified shape),
// used for the baseline "does category resolution even work" tests.
const REALISTIC_CATALOG = [
  { slug: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.', visibility: 'list', priority: 1 },
  { slug: 'gpt-6-sol', description: 'Workhorse model for coding and everyday work.', visibility: 'list', priority: 2 },
  { slug: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', visibility: 'list', priority: 3 },
  { slug: 'gpt-reserve', description: 'Fast and affordable agentic coding model.', visibility: 'hide', priority: 3 },
  { slug: 'gpt-5.6-sol', description: 'Older coding model for complex work.', visibility: 'list', priority: 4 },
  { slug: 'gpt-5.6-terra', description: 'Older balanced model for straightforward work.', visibility: 'list', priority: 7 },
  { slug: 'gpt-5.6-luna', description: 'Older fast and efficient model.', visibility: 'list', priority: 8 },
  {
    slug: 'gpt-5.5', description: 'Legacy coding model.', visibility: 'list', priority: 12,
    upgrade: { model: 'gpt-5.6-sol', retirement_at: '2026-10-14T19:00:00Z' },
  },
  { slug: 'codex-auto-review', description: 'Automatic approval review model for Codex.', visibility: 'hide', priority: 43 },
];

test('resolves frontier/workhorse/fast to the newest live generation on a realistic catalog', () => {
  const cache = mkCache(REALISTIC_CATALOG);
  try {
    assert.strictEqual(resolveCodexModel('frontier', { cachePath: cache.path }), 'gpt-6-astra');
    assert.strictEqual(resolveCodexModel('workhorse', { cachePath: cache.path }), 'gpt-6-sol');
    assert.strictEqual(resolveCodexModel('fast', { cachePath: cache.path }), 'gpt-6-luna');
  } finally {
    cache.cleanup();
  }
});

test('a synthetic newer generation (gpt-7-*) is preferred with NO code change', () => {
  // This is the test that proves the design: nothing in codex-models.js
  // names "gpt-6" or "gpt-7" anywhere. If resolution here still returns the
  // gpt-6 slug, the resolver is (or degraded into) a hardcoded map.
  const catalog = REALISTIC_CATALOG.concat([
    { slug: 'gpt-7-nova', description: 'Frontier intelligence, next generation.', visibility: 'list', priority: 0 },
    { slug: 'gpt-7-core', description: 'Workhorse model for coding, next generation.', visibility: 'list', priority: 0 },
    { slug: 'gpt-7-breeze', description: 'Fast and affordable model, next generation.', visibility: 'list', priority: 0 },
  ]);
  const cache = mkCache(catalog);
  try {
    assert.strictEqual(resolveCodexModel('frontier', { cachePath: cache.path }), 'gpt-7-nova');
    assert.strictEqual(resolveCodexModel('workhorse', { cachePath: cache.path }), 'gpt-7-core');
    assert.strictEqual(resolveCodexModel('fast', { cachePath: cache.path }), 'gpt-7-breeze');
  } finally {
    cache.cleanup();
  }
});

test('hide visibility is excluded even when it would otherwise win on priority', () => {
  const cache = mkCache([
    // Lowest (best) priority in the catalog, but hidden -> must lose to the
    // worse-priority visible entry.
    { slug: 'gpt-secret-fast', description: 'Fast and affordable internal model.', visibility: 'hide', priority: 0 },
    { slug: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', visibility: 'list', priority: 3 },
  ]);
  try {
    assert.strictEqual(resolveCodexModel('fast', { cachePath: cache.path }), 'gpt-6-luna');
  } finally {
    cache.cleanup();
  }
});

test('a retiring model is not returned when a live sibling exists in the same category', () => {
  const cache = mkCache([
    // Best priority (newest-looking) but flagged retiring.
    { slug: 'gpt-6-sol-preview', description: 'Workhorse model for coding preview.', visibility: 'list', priority: 1,
      upgrade: { model: 'gpt-6-sol', retirement_at: '2026-10-01T00:00:00Z' } },
    { slug: 'gpt-6-sol', description: 'Workhorse model for coding and everyday work.', visibility: 'list', priority: 2 },
  ]);
  try {
    assert.strictEqual(resolveCodexModel('workhorse', { cachePath: cache.path }), 'gpt-6-sol');
  } finally {
    cache.cleanup();
  }
});

test('a retiring model IS returned when it is the only candidate (no live alternative)', () => {
  const cache = mkCache([
    { slug: 'gpt-5.5', description: 'Legacy coding model, workhorse.', visibility: 'list', priority: 12,
      upgrade: { model: 'gpt-5.6-sol', retirement_at: '2026-10-14T19:00:00Z' } },
  ]);
  try {
    assert.strictEqual(resolveCodexModel('workhorse', { cachePath: cache.path }), 'gpt-5.5');
  } finally {
    cache.cleanup();
  }
});

test('missing cache file -> null (fail-open, never a hardcoded fallback)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-missing-'));
  const missingPath = path.join(dir, 'does_not_exist.json');
  try {
    assert.strictEqual(resolveCodexModel('frontier', { cachePath: missingPath }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSON -> null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-malformed-'));
  const p = path.join(dir, 'models_cache.json');
  fs.writeFileSync(p, '{ this is not valid json');
  try {
    assert.strictEqual(resolveCodexModel('frontier', { cachePath: p }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown category -> null', () => {
  const cache = mkCache(REALISTIC_CATALOG);
  try {
    assert.strictEqual(resolveCodexModel('ultra-mega-model', { cachePath: cache.path }), null);
    assert.strictEqual(resolveCodexModel('', { cachePath: cache.path }), null);
    assert.strictEqual(resolveCodexModel(undefined, { cachePath: cache.path }), null);
  } finally {
    cache.cleanup();
  }
});

test('no models array in the cache -> null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-noarr-'));
  const p = path.join(dir, 'models_cache.json');
  fs.writeFileSync(p, JSON.stringify({ fetched_at: 'x', etag: 'x' }));
  try {
    assert.strictEqual(resolveCodexModel('frontier', { cachePath: p }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no match for a category on this catalog -> null (never a substitute category)', () => {
  const cache = mkCache([
    { slug: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.', visibility: 'list', priority: 1 },
  ]);
  try {
    // Catalog has a frontier model but nothing matching "fast" -> must be null,
    // never silently substitute the frontier slug.
    assert.strictEqual(resolveCodexModel('fast', { cachePath: cache.path }), null);
  } finally {
    cache.cleanup();
  }
});
