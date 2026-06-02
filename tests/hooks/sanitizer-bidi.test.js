'use strict';
// Sanitizer hygiene: Unicode bidi overrides (U+202A–U+202E) and isolates
// (U+2066–U+2069) survive the C0/C1 strip but visually reorder terminal/model
// output, so every sanitizer must remove them. We exercise statusline-rich's
// safeLabel (the one sanitizer that is exported) as the representative; the same
// bidi strip is applied verbatim across phase-bar, graphify-guard,
// graphify-session, and speculation-judge.

const { test } = require('node:test');
const assert = require('node:assert');
const { safeLabel } = require('../../plugins/anti-hall/statusline/statusline-rich.js');

const RLO = '‮'; // RIGHT-TO-LEFT OVERRIDE — the classic filename-spoof char

test('bidi: U+202E (RLO) is stripped — "abc\\u202Ecod.exe" -> "abccod.exe"', () => {
  assert.strictEqual(safeLabel('abc' + RLO + 'cod.exe'), 'abccod.exe');
});

test('bidi: all overrides + isolates (U+202A–U+202E, U+2066–U+2069) stripped', () => {
  for (const cp of [0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
                    0x2066, 0x2067, 0x2068, 0x2069]) {
    const ch = String.fromCodePoint(cp);
    assert.strictEqual(safeLabel('x' + ch + 'y'), 'xy',
      `U+${cp.toString(16)} not stripped`);
  }
});

test('bidi strip preserves legit UTF-8 and branch chars', () => {
  assert.strictEqual(safeLabel('café'), 'café');
  assert.strictEqual(safeLabel('日本語'), '日本語');
  assert.strictEqual(safeLabel('🌳'), '🌳');
  assert.strictEqual(safeLabel('feature/fix-thing.v2'), 'feature/fix-thing.v2');
});
