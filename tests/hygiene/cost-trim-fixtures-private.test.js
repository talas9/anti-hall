'use strict';
// Privacy gate for tests/fixtures/cost-trim/: fixtures and goldens are SYNTHETIC
// or normalised only. Raw captures from real sessions belong in gitignored
// .anti-hall/. Fails on a real-looking user home path, a real-looking session id,
// or a real transcript entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'fixtures', 'cost-trim');
const PLACEHOLDER_SID = '00000000-0000-0000-0000-000000000000';
const ALLOWED_NAMES = new Set(['user', 'someone']);

function walk(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// findViolations(text) -> string[] of human-readable problems.
function findViolations(text) {
  const bad = [];
  for (const m of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
    if (!ALLOWED_NAMES.has(m[1])) bad.push('home path with a real-looking name: ' + m[0]);
  }
  for (const m of text.matchAll(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g)) {
    if (m[0] !== PLACEHOLDER_SID) bad.push('UUID-shaped id other than the placeholder: ' + m[0]);
  }
  if (/"type"\s*:\s*"(?:assistant|user)"[^\n]*"message"\s*:|"message"\s*:[^\n]*"type"\s*:\s*"(?:assistant|user)"/.test(text)) {
    bad.push('transcript-entry JSON (type assistant/user with message)');
  }
  return bad;
}

test('fixture tree exists', () => {
  assert.ok(fs.existsSync(ROOT), 'tests/fixtures/cost-trim/ must exist');
});

test('every file under tests/fixtures/cost-trim/ is private-clean', () => {
  const files = walk(ROOT);
  assert.ok(files.length > 0, 'no fixtures found');
  const problems = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const v of findViolations(text)) problems.push(path.relative(ROOT, f) + ': ' + v);
  }
  assert.deepEqual(problems, []);
});

test('detector self-check: flags what it must, passes what it must', () => {
  assert.ok(findViolations('/Users/jane/Projects/x').length === 1);
  assert.ok(findViolations('/home/bob/.claude').length === 1);
  assert.deepEqual(findViolations('/home/user/.claude and /Users/someone/x'), []);
  assert.ok(findViolations('id 123e4567-e89b-12d3-a456-426614174000').length === 1);
  assert.deepEqual(findViolations('id ' + PLACEHOLDER_SID), []);
  assert.ok(findViolations('{"type":"assistant","message":{"content":[]}}').length === 1);
  assert.ok(findViolations('{"type":"user","message":{"content":"x"}}').length === 1);
  assert.deepEqual(findViolations('{"hook_event_name":"Stop"}'), []);
});
