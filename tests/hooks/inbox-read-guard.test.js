'use strict';
// inbox-read-guard (PreToolUse Read, CLAUDE-only) + the shared devswarm-inbox-paths
// classifier. The guard blocks a raw Read-tool read of ~/.anti-hall/devswarm/inbox/**
// or the store (db + sidecars, journal NDJSON); it fires in ALL contexts (parent +
// child, coordinator + subagent) because sanctioned consumers read via Node fs, not
// the Read tool. Fail-open on every ambiguity. Store deny is self-healing: it only
// arms when the Primary read-CLI (devswarm-store.js listMessages) is present.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const {
  classifyDevswarmPath,
  storeReadCliPresent,
  isStoreDenyTarget,
} = require('../../plugins/anti-hall/hooks/lib/devswarm-inbox-paths.js');

const HOOK = 'inbox-read-guard.js';
const DEVSWARM = { DEVSWARM_REPO_ID: 'repo-x' }; // isDevswarmActive auto-true

// Build a PreToolUse Read payload. agentId (when set) lands in the payload as the
// subagent discriminator; tool overrides the tool_name for the non-Read test.
function readPayload(filePath, opts = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: opts.tool || 'Read',
    tool_input: { file_path: filePath },
    session_id: 't',
    cwd: opts.cwd || process.cwd(),
    ...(opts.agentId ? { agent_id: opts.agentId, agent_type: 'general-purpose' } : {}),
  };
}

// ===========================================================================
// UNIT: classifyDevswarmPath / storeReadCliPresent (deterministic, in-process —
// store-CLI presence is STUBBED here, no dependency on the parallel #13 landing).
// ===========================================================================
const HOME = path.sep === '\\' ? 'C:\\home\\u' : '/home/u';
const ROOT = path.join(HOME, '.anti-hall', 'devswarm');
const CLI_ON = { storeCliPresent: true };
const CLI_OFF = { storeCliPresent: false };

test('UNIT classify: inbox file -> deny-inbox (NOT gated)', () => {
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'inbox', 'x.ndjson'), HOME), 'deny-inbox');
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'inbox', 'sub', 'y.ndjson'), HOME), 'deny-inbox');
});

test('UNIT classify: store db + sidecars + journal ndjson -> deny-store when CLI present', () => {
  for (const rest of ['devswarm.db', 'devswarm.db-wal', 'devswarm.db-shm', 'devswarm.db-journal']) {
    assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', rest), HOME, undefined, CLI_ON), 'deny-store', rest);
  }
  for (const j of ['messages.ndjson', 'registry.ndjson', 'cursors.ndjson', 'gates.ndjson']) {
    assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', 'journal', j), HOME, undefined, CLI_ON), 'deny-store', j);
  }
});

test('UNIT classify: PER-PROJECT store db + journal (store/<hash>/...) -> deny-store when CLI present', () => {
  const hash = 'aaaaaaaa';
  for (const rest of ['devswarm.db', 'devswarm.db-wal', 'devswarm.db-shm', 'devswarm.db-journal']) {
    assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', hash, rest), HOME, undefined, CLI_ON), 'deny-store', rest);
  }
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', hash, 'journal', 'messages.ndjson'), HOME, undefined, CLI_ON), 'deny-store');
});

test('UNIT classify: PER-PROJECT summaries/<hash>.json is ALLOW (read-guard never blocks the projection)', () => {
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'summaries', 'aaaaaaaa.json'), HOME, undefined, CLI_ON), 'allow');
});

test('UNIT classify: store deny targets FAIL OPEN (allow) when CLI absent (never brick)', () => {
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', 'devswarm.db'), HOME, undefined, CLI_OFF), 'allow');
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', 'journal', 'messages.ndjson'), HOME, undefined, CLI_OFF), 'allow');
});

test('UNIT classify: non-deny store file -> allow even with CLI present', () => {
  assert.strictEqual(classifyDevswarmPath(path.join(ROOT, 'store', 'notes.txt'), HOME, undefined, CLI_ON), 'allow');
});

test('UNIT classify: ALLOW-taxonomy surfaces -> allow', () => {
  const allow = [
    'summary.json',
    path.join('cursors', 'x.cursor'),
    path.join('workspaces', 'x.json'),
    path.join('liveness', 'x.json'),
    path.join('heartbeats', 'x'),
    path.join('locks', 'x.lock'),
    'archive-2026.json',
  ];
  for (const rel of allow) {
    assert.strictEqual(classifyDevswarmPath(path.join(ROOT, rel), HOME, undefined, CLI_ON), 'allow', rel);
  }
});

test('UNIT classify: outside root / empty / non-string / root itself -> allow', () => {
  assert.strictEqual(classifyDevswarmPath(path.join(HOME, 'other', 'inbox', 'x.ndjson'), HOME), 'allow');
  assert.strictEqual(classifyDevswarmPath(path.sep === '\\' ? 'C:\\etc\\passwd' : '/etc/passwd', HOME), 'allow');
  assert.strictEqual(classifyDevswarmPath('', HOME), 'allow');
  assert.strictEqual(classifyDevswarmPath(null, HOME), 'allow');
  assert.strictEqual(classifyDevswarmPath(ROOT, HOME), 'allow');
});

test('UNIT classify: relative path resolves against cwd (payload cwd)', () => {
  // cwd inside the devswarm root -> a relative inbox path resolves under root -> deny.
  assert.strictEqual(classifyDevswarmPath('inbox/x.ndjson', HOME, ROOT), 'deny-inbox');
  // cwd elsewhere -> the same relative path is NOT under root -> allow (fail-open).
  assert.strictEqual(classifyDevswarmPath('inbox/x.ndjson', HOME, path.join(HOME, 'repo')), 'allow');
});

test('UNIT isStoreDenyTarget: exact db + sidecars + journal ndjson only (legacy + per-project)', () => {
  assert.ok(isStoreDenyTarget('devswarm.db'));
  assert.ok(isStoreDenyTarget('devswarm.db-wal'));
  assert.ok(isStoreDenyTarget('journal/messages.ndjson'));
  // per-project layout: store/<hash>/devswarm.db + <hash>/journal/*.ndjson
  assert.ok(isStoreDenyTarget('aaaaaaaa/devswarm.db'));
  assert.ok(isStoreDenyTarget('aaaaaaaa/devswarm.db-wal'));
  assert.ok(isStoreDenyTarget('aaaaaaaa/journal/messages.ndjson'));
  assert.ok(!isStoreDenyTarget('aaaaaaaa/journal/nested/x.ndjson'));
  assert.ok(!isStoreDenyTarget('aaaaaaaa/notes.txt'));
  assert.ok(!isStoreDenyTarget('journal/nested/x.ndjson'));
  assert.ok(!isStoreDenyTarget('devswarm.sqlite'));
  assert.ok(!isStoreDenyTarget('notes.txt'));
});

test('UNIT storeReadCliPresent: detects listMessages (module export OR handle method); else false', () => {
  assert.strictEqual(storeReadCliPresent(HOME, { storeModule: { listMessages() {} } }), true);
  assert.strictEqual(storeReadCliPresent(HOME, {
    storeModule: { openStore: () => ({ listMessages() {}, close() {} }) },
  }), true);
  assert.strictEqual(storeReadCliPresent(HOME, {
    storeModule: { openStore: () => ({ close() {} }) },
  }), false);
  assert.strictEqual(storeReadCliPresent(HOME, { storeModule: {} }), false);
  // Real module probe (no injection) returns a boolean — value tracks whether the
  // #13 read-CLI has landed; either way it must never throw.
  assert.strictEqual(typeof storeReadCliPresent(HOME), 'boolean');
});

// ===========================================================================
// SPAWN: the hook end-to-end.
// ===========================================================================
function runRead(filePath, opts = {}) {
  const h = makeHome();
  try {
    if (opts.skip) h.writeSkip(opts.skip);
    const p = filePath(h);
    return testHook(HOOK, readPayload(p, { agentId: opts.agentId, tool: opts.tool }), {
      home: h.home,
      env: Object.assign({}, opts.env || DEVSWARM),
    });
  } finally {
    h.cleanup();
  }
}
function inboxPath(h) { return path.join(h.antiHall, 'devswarm', 'inbox', 'x.ndjson'); }
function storeDbPath(h) { return path.join(h.antiHall, 'devswarm', 'store', 'devswarm.db'); }

test('SPAWN BLOCK: Read of the raw inbox ndjson (coordinator context)', () => {
  const r = runRead(inboxPath);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(r.json && r.json.decision === 'block', 'decision:block expected');
});

test('SPAWN BLOCK: Read of the raw inbox in SUBAGENT context too (all-contexts)', () => {
  const r = runRead(inboxPath, { agentId: 'sub' });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('SPAWN reason: names `inbox pull` + kill-switch, and does NOT echo the path', () => {
  const r = runRead(inboxPath);
  assert.strictEqual(r.status, 2);
  assert.ok(/inbox pull/.test(r.json.reason), 'reason redirects to `devswarm.js inbox pull`');
  assert.ok(/DISABLE_ANTIHALL_DEVSWARM=1/.test(r.json.reason), 'reason names the kill-switch');
  assert.ok(/CURSOR DESYNC/.test(r.json.reason) && /does NOT drain the queue/.test(r.json.reason),
    'reason uses the accurate cursor-desync harm model');
  assert.ok(!r.stdout.includes('x.ndjson'), 'reason must not echo the read path');
});

// Store deny is self-healing: it arms the moment devswarm-store.js exposes the
// read-CLI (listMessages). That has landed, so a raw store Read now BLOCKS. The
// fail-OPEN-when-absent direction is covered deterministically by the UNIT test
// above (CLI_OFF) — it cannot be spawn-tested here without un-adding listMessages.
test('SPAWN BLOCK: Read of the store db (read-CLI present -> store gate armed)', () => {
  const r = runRead(storeDbPath);
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
  assert.ok(/STORE READ-GUARD/.test(r.json.reason), 'store block reason expected');
  assert.ok(/inbox read/.test(r.json.reason) && /DISABLE_ANTIHALL_DEVSWARM=1/.test(r.json.reason),
    'store reason redirects to the wrapper + names the kill-switch');
});

const ALLOW_SURFACES = {
  'summary.json': (h) => path.join(h.antiHall, 'devswarm', 'summary.json'),
  'cursors/x.cursor': (h) => path.join(h.antiHall, 'devswarm', 'cursors', 'x.cursor'),
  'workspaces/x.json': (h) => path.join(h.antiHall, 'devswarm', 'workspaces', 'x.json'),
  'outside-root': (h) => path.join(h.antiHall, 'devswarm-notes', 'x.txt'),
};
for (const [name, fp] of Object.entries(ALLOW_SURFACES)) {
  test(`SPAWN ALLOW: Read of ${name}`, () => {
    const r = runRead(fp);
    assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
  });
}

test('SPAWN ALLOW: non-Read tool passes through', () => {
  const r = runRead(inboxPath, { tool: 'Bash' });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('SPAWN ALLOW: DevSwarm inactive (no DEVSWARM_REPO_ID) -> dormant', () => {
  const r = runRead(inboxPath, { env: {} });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('SPAWN ALLOW: DISABLE_ANTIHALL_DEVSWARM=1 kill-switch -> dormant', () => {
  const r = runRead(inboxPath, { env: { DEVSWARM_REPO_ID: 'repo-x', DISABLE_ANTIHALL_DEVSWARM: '1' } });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('SPAWN ALLOW: explicit devswarm-read-guard skip -> inbox read allowed', () => {
  const r = runRead(inboxPath, { skip: { 'devswarm-read-guard': Date.now() + 60 * 60 * 1000 } });
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}`);
});

test('SPAWN BLOCK: blanket {all} skip does NOT cover devswarm-read-guard -> still blocks', () => {
  const r = runRead(inboxPath, { skip: { all: Date.now() + 60 * 60 * 1000 } });
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout}`);
});

test('SPAWN FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home, env: DEVSWARM }).status, 0);
  } finally { h.cleanup(); }
});

test('SPAWN FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home, env: DEVSWARM }).status, 0);
  } finally { h.cleanup(); }
});
