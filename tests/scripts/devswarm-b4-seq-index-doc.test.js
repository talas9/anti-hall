'use strict';
// B4 fix: `seq` (durable, store-wide physical id — unified across `send` and
// `inbox count/read/ack/messages`, see devswarm-store.js:737-751/:1300-1313)
// vs `index` (a page-local positional ordinal, and the unit the ack cursor
// advances in) was already correctly unified IN CODE — this fix is doc-only,
// clarifying the distinction in the places an agent actually reads before
// calling the CLI. No field was renamed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
const SKILL_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'skills', 'devswarm', 'SKILL.md');
const CODEX_SKILL_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'codex', 'skills', 'anti-hall-devswarm', 'SKILL.md');

// B4 MUTATION-CHECK (killed):
//   1. Delete the doc addition from a target file entirely -> that file's
//      test fails on the bare seq/index mention assertions. This is also the
//      RED baseline verified against the pre-fix docs (all 3 doc tests failed).
//   2. Keep "seq"/"index"/"PAGE-LOCAL" but delete the actual "never compare
//      `index` across calls" warning sentence -> the tightened
//      /never compare .index. across calls/i assertion fails (an earlier,
//      looser regex accepting a bare "page-local" mention did NOT catch this
//      mutation — caught in review, tightened before finalizing).
function assertDistinguishes(text, label) {
  assert.ok(/\bseq\b/.test(text), `${label} must mention seq`);
  assert.ok(/\bindex\b/.test(text), `${label} must mention index`);
  // The distinction itself (mutation-tested): a bare mention of "page-local"
  // is not enough on its own — require the actual never-compare warning.
  assert.ok(
    /never compare .index. across calls/i.test(text),
    `${label} must state "never compare index across calls"`,
  );
}

test('B4: devswarm.js usage banner (inbox count/read/ack + send) documents seq vs index', () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  const bannerEnd = src.indexOf('function ');
  const banner = src.slice(0, bannerEnd === -1 ? 6000 : bannerEnd);
  assertDistinguishes(banner, 'devswarm.js usage banner');
});

test('B4: skills/devswarm/SKILL.md documents seq vs index', () => {
  const text = fs.readFileSync(SKILL_PATH, 'utf8');
  assertDistinguishes(text, 'skills/devswarm/SKILL.md');
});

test('B4: codex/skills/anti-hall-devswarm/SKILL.md documents seq vs index (dual-platform parity)', () => {
  const text = fs.readFileSync(CODEX_SKILL_PATH, 'utf8');
  assertDistinguishes(text, 'codex/skills/anti-hall-devswarm/SKILL.md');
});

test('B4: no field was renamed — devswarm-store.js still emits BOTH seq and index on every message row', () => {
  const storePath = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js');
  const src = fs.readFileSync(storePath, 'utf8');
  const matches = src.match(/index: i \+ 1,\s*\n\s*seq: physicalSeq,/g) || [];
  assert.ok(matches.length >= 2, `expected both listMessages implementations to emit index+seq together; found ${matches.length}`);
});
