'use strict';
// devswarm-child-drain (PostToolUse hook, matcher Bash, CHILD-ONLY). The
// operative mid-turn re-entry fix: a store-only mesh-direct backlog (`send
// --to`, invisible to an NDJSON-only reader) must surface on a Bash tool
// call, not just once per UserPromptSubmit.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, postToolUseBashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const HOOK = 'devswarm-child-drain.js';
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' };
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

function payload(env) {
  const p = postToolUseBashPayload('git status', {});
  p.cwd = REPO_CWD;
  return p;
}

function seedDescriptor(home, id, overrides) {
  const dsw = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(dsw, id + '.inbox.ndjson');
  const cursorPath = path.join(dsw, id + '.cursor');
  fs.mkdirSync(dsw, { recursive: true });
  fs.writeFileSync(inboxPath, ''); // empty durable NDJSON — no native-drained backlog
  fs.writeFileSync(cursorPath, '0');
  const wdir = path.join(dsw, 'workspaces');
  fs.mkdirSync(wdir, { recursive: true });
  const desc = Object.assign({ id, inboxPath, cursorPath, worktreePath: REPO_CWD }, overrides || {});
  fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify(desc));
  return desc;
}

function seedStoreOnlyDirect(home, id, message) {
  const s = store.openStore({ home, workspaceId: id, hash: REPO_KEY });
  try {
    const fields = { from: 'primary-abc', to: id, type: 'direct', message: message || 'hi', timestamp: Date.now() };
    store.appendMeshMessage(s, Object.assign({}, fields, { hash: store.meshMessageHash(fields) }));
  } finally { s.close(); }
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('CHILD, store-only mesh-direct unread (NDJSON empty) -> injects DEVSWARM INBOX nudge', () => {
  const h = makeHome();
  try {
    seedDescriptor(h.home, 'child-1');
    seedStoreOnlyDirect(h.home, 'child-1', 'parent ruling: use approach B');
    const r = testHook(HOOK, payload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `must emit JSON on inject; stdout=${r.stdout}`);
    assert.ok(ctx(r).includes('DEVSWARM INBOX'), `must carry the DEVSWARM INBOX banner; ctx=${ctx(r)}`);
    assert.ok(ctx(r).includes('1 unread'), `must report the store-only unread count; ctx=${ctx(r)}`);
    assert.ok(ctx(r).includes('inbox ack child-1'), `must prescribe the cursor-advancing ack command; ctx=${ctx(r)}`);
    assert.ok(!ctx(r).includes('inbox read child-1`'), 'must NOT prescribe the non-mutating `inbox read` as the remedy');
  } finally { h.cleanup(); }
});

test('PRIMARY payload (same env otherwise) -> silent no-op even with store-only unread', () => {
  const h = makeHome();
  try {
    seedDescriptor(h.home, 'child-1');
    seedStoreOnlyDirect(h.home, 'child-1', 'hello');
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'Primary payload must produce zero output');
  } finally { h.cleanup(); }
});

test('CHILD with zero unread (no descriptor, no store row) -> silent no-op', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'zero unread must produce zero output');
  } finally { h.cleanup(); }
});

test('THROTTLE: same unread count within the window -> second call is suppressed', () => {
  const h = makeHome();
  try {
    seedDescriptor(h.home, 'child-1');
    seedStoreOnlyDirect(h.home, 'child-1', 'first');
    const r1 = testHook(HOOK, payload(), { home: h.home, env: CHILD_ENV });
    assert.ok(ctx(r1).includes('DEVSWARM INBOX'), 'first call must inject');
    const r2 = testHook(HOOK, payload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r2.stdout.trim(), '', 'second call with an UNCHANGED count within the throttle window must be suppressed');
  } finally { h.cleanup(); }
});

test('THROTTLE: unread count CHANGES -> re-injects even within the window', () => {
  const h = makeHome();
  try {
    seedDescriptor(h.home, 'child-1');
    seedStoreOnlyDirect(h.home, 'child-1', 'first');
    const r1 = testHook(HOOK, payload(), { home: h.home, env: CHILD_ENV });
    assert.ok(ctx(r1).includes('1 unread'));
    seedStoreOnlyDirect(h.home, 'child-1', 'second, distinct body so it is not deduped');
    const r2 = testHook(HOOK, payload(), { home: h.home, env: CHILD_ENV });
    assert.ok(ctx(r2).includes('2 unread'), `count change must re-inject with the new count; ctx=${ctx(r2)}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed stdin -> exit 0, no crash', () => {
  const { testHookRaw } = require('../helpers/spawn-hook.js');
  const r = testHookRaw(HOOK, '{bad json', { env: CHILD_ENV });
  assert.strictEqual(r.status, 0);
});

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const { testHookRaw } = require('../helpers/spawn-hook.js');
  const r = testHookRaw(HOOK, '', { env: CHILD_ENV });
  assert.strictEqual(r.status, 0);
});

test('NO-OP: DevSwarm not active at all -> silent no-op', () => {
  const h = makeHome();
  try {
    seedDescriptor(h.home, 'child-1');
    seedStoreOnlyDirect(h.home, 'child-1', 'hello');
    const r = testHook(HOOK, payload(), { home: h.home, env: { DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' } });
    assert.strictEqual(r.stdout.trim(), '', 'inactive supervisor must produce zero output regardless of backlog');
  } finally { h.cleanup(); }
});
