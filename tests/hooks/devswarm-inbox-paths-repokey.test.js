'use strict';
// devswarm-inbox-paths — v0.57 MESH repoKey-shape extension (PLAN-v0.57-mesh.md
// Phase 2, D20). Additive to tests/hooks/inbox-read-guard.test.js: this file
// exercises ONLY the NEW repoKey classification behavior (a legacy 8-hex hash was
// already covered there) — a repoKey-shaped store path -> deny-store,
// summaries/<repoKey>.json -> allow, and a re-assertion that the v0.55 quoted-path
// regression fix still fails closed for the repoKey shape specifically (the
// isStoreDenyTarget regex edit must not reopen it).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const {
  classifyDevswarmPath,
  isStoreDenyTarget,
} = require('../../plugins/anti-hall/hooks/lib/devswarm-inbox-paths.js');

const HOOK = 'command-guard.js';
const DEVSWARM_COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'repo-x' };

const HOME = path.sep === '\\' ? 'C:\\home\\u' : '/home/u';
const ROOT = path.join(HOME, '.anti-hall', 'devswarm');
const CLI_ON = { storeCliPresent: true };
const CLI_OFF = { storeCliPresent: false };

// A realistic repoKey (D1: sanitized-repo-basename + '-' + 6-hex realpath suffix).
const REPOKEY = 'anti-hall-a1b2c3';

// ===========================================================================
// UNIT: isStoreDenyTarget — the repoKey shape.
// ===========================================================================
test('UNIT isStoreDenyTarget: repoKey-shaped store db + sidecars + journal ndjson are DENY targets', () => {
  assert.ok(isStoreDenyTarget(REPOKEY + '/devswarm.db'));
  assert.ok(isStoreDenyTarget(REPOKEY + '/devswarm.db-wal'));
  assert.ok(isStoreDenyTarget(REPOKEY + '/devswarm.db-shm'));
  assert.ok(isStoreDenyTarget(REPOKEY + '/devswarm.db-journal'));
  assert.ok(isStoreDenyTarget(REPOKEY + '/journal/messages.ndjson'));
  // a single-char repo basename ('a-1a2b3c') still matches (D1: 1-40 char base).
  assert.ok(isStoreDenyTarget('a-1a2b3c/devswarm.db'));
  // a repo name that itself contains dashes still resolves correctly (base is
  // GREEDY-but-anchored: only the FINAL '-<6hex>' is the disambiguator).
  assert.ok(isStoreDenyTarget('my-repo-name-abcdef/devswarm.db'));
});

test('UNIT isStoreDenyTarget: repoKey shape is NOT satisfied by a bare 8-hex legacy hash, and vice versa (disjoint, D28)', () => {
  // A legacy hash has no dash -> never matches the repoKey regex path, but IS
  // still matched by the separate legacy-shape check (both stay guarded).
  assert.ok(isStoreDenyTarget('aaaaaaaa/devswarm.db'), 'legacy 8-hex still guarded');
  assert.ok(!/^[a-z0-9-]{1,40}-[0-9a-f]{6}$/.test('aaaaaaaa'), 'a legacy hash never SHAPES like a repoKey (sanity)');
});

test('UNIT isStoreDenyTarget: repoKey non-store files stay ALLOW (fail-open for unknown files)', () => {
  assert.ok(!isStoreDenyTarget(REPOKEY + '/notes.txt'));
  assert.ok(!isStoreDenyTarget(REPOKEY + '/journal/nested/x.ndjson')); // nested journal dir not matched (parity with legacy)
});

// ===========================================================================
// UNIT: classifyDevswarmPath — repoKey store path -> deny-store (CLI present);
// summaries/<repoKey>.json -> allow (never gated, the projection hooks read).
// ===========================================================================
test('UNIT classify: repoKey-shaped store db -> deny-store when CLI present', () => {
  assert.strictEqual(
    classifyDevswarmPath(path.join(ROOT, 'store', REPOKEY, 'devswarm.db'), HOME, undefined, CLI_ON),
    'deny-store'
  );
  assert.strictEqual(
    classifyDevswarmPath(path.join(ROOT, 'store', REPOKEY, 'journal', 'messages.ndjson'), HOME, undefined, CLI_ON),
    'deny-store'
  );
});

test('UNIT classify: repoKey store DENY fails OPEN (allow) when the read-CLI is absent (never brick a pre-CLI Primary)', () => {
  assert.strictEqual(
    classifyDevswarmPath(path.join(ROOT, 'store', REPOKEY, 'devswarm.db'), HOME, undefined, CLI_OFF),
    'allow'
  );
});

test('UNIT classify: summaries/<repoKey>.json is ALLOW (the read-guard never blocks the projection)', () => {
  assert.strictEqual(
    classifyDevswarmPath(path.join(ROOT, 'summaries', REPOKEY + '.json'), HOME, undefined, CLI_ON),
    'allow'
  );
});

test('UNIT classify: BOTH a legacy hash store AND a repoKey store are guarded simultaneously (D9 migration-window overlap)', () => {
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', 'aaaaaaaa', 'devswarm.db'), HOME, undefined, CLI_ON), 'deny-store');
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', REPOKEY, 'devswarm.db'), HOME, undefined, CLI_ON), 'deny-store');
});

// ===========================================================================
// SPAWN: command-guard end-to-end — the v0.55 quoted-path regression re-asserted
// for the repoKey shape specifically (D20: extending isStoreDenyTarget's regex
// must not regress the arg-normalization fix, which lives in classifyDevswarmPath,
// NOT in isStoreDenyTarget).
// ===========================================================================
function runDevswarmFileRead(mkCommand) {
  const h = makeHome();
  try {
    const dsRoot = path.join(h.antiHall, 'devswarm');
    return testHook(HOOK, bashPayload(mkCommand(dsRoot)), { home: h.home, env: DEVSWARM_COORD });
  } finally {
    h.cleanup();
  }
}

const QUOTE_FORMS = [
  ['unquoted', (p) => p],
  ['double-quoted', (p) => `"${p}"`],
  ['single-quoted', (p) => `'${p}'`],
];
for (const verb of ['cat', 'head', 'tail']) {
  for (const [label, quote] of QUOTE_FORMS) {
    test(`SPAWN BLOCK (regression, repoKey shape): ${verb} of ${label} raw repoKey store db`, () => {
      const r = runDevswarmFileRead((root) => `${verb} ${quote(path.join(root, 'store', REPOKEY, 'devswarm.db'))}`);
      assert.strictEqual(r.status, 2, `expected block for ${label} ${verb}\nstdout: ${r.stdout}`);
      assert.ok(r.json && /STORE READ-GUARD/.test(r.json.reason), 'store block reason expected');
    });
  }
}

test('SPAWN ALLOW (repoKey shape): cat of summaries/<repoKey>.json (the projection, never gated)', () => {
  const r = runDevswarmFileRead((root) => `cat ${path.join(root, 'summaries', REPOKEY + '.json')}`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('SPAWN ALLOW (repoKey shape): cat of a non-protected file under the repoKey store dir', () => {
  const r = runDevswarmFileRead((root) => `cat ${path.join(root, 'store', REPOKEY, 'notes.txt')}`);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});
