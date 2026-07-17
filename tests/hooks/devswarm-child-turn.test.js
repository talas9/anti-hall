'use strict';
// devswarm-child-turn (UserPromptSubmit hook). For a DevSwarm CHILD workspace
// (liveness supervisor active AND DEVSWARM_SOURCE_BRANCH non-empty) it (1) writes
// a turn-authored heartbeat under ~/.anti-hall/devswarm/heartbeats/<branch>.json
// and (2) injects a short report-progress/listen-to-parent reminder. Primary,
// non-DevSwarm sessions, and malformed stdin are silent no-ops (no output, exit 0).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { readDescriptors } = require('../../plugins/anti-hall/companion/devswarm-supervisor.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const HOOK = 'devswarm-child-turn.js';
// Stable substring surviving the v0.58 hook-text sweep (the OLD marker,
// 'message-parent', is now a BLOCKED native verb and must never appear).
const REMINDER_PHRASE = 'stay visible on the parent';

// This test process's own cwd (the anti-hall repo, a real git worktree) —
// findGitToplevel resolves it with NO git spawn, exactly like devswarm-parent-
// inbox.test.js's REPO_CWD pattern. '/tmp' (the default promptPayload cwd) has no
// enclosing .git, so registerChildDescriptor stays a no-op unless a test opts in
// by passing REPO_CWD explicitly — existing tests above are unaffected.
const REPO_CWD = process.cwd();

function promptPayload(sessionId, cwd) {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId || 't', prompt: 'go', cwd: cwd || '/tmp' };
}

function workspaceDescPath(home, id) {
  return path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json');
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

function heartbeatDir(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'heartbeats');
}
function readBeat(home, key) {
  return JSON.parse(fs.readFileSync(path.join(heartbeatDir(home), key + '.json'), 'utf8'));
}

// Register a child's own durable descriptor (workspaces/<id>.json) plus its NDJSON
// inbox + cursor, so the hook's NON-DESTRUCTIVE unread check has something to read.
function seedChildInbox(home, id, lines, consumed) {
  const dsw = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(dsw, id + '.inbox.ndjson');
  const cursorPath = path.join(dsw, id + '.cursor.json');
  fs.mkdirSync(dsw, { recursive: true });
  fs.writeFileSync(inboxPath, lines.map((l) => l).join('\n') + (lines.length ? '\n' : ''));
  fs.writeFileSync(cursorPath, String(consumed));
  const wdir = path.join(dsw, 'workspaces');
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify({ id, inboxPath, cursorPath }));
  return { inboxPath, cursorPath };
}

test('CHILD: DevSwarm active + branch set -> reminder injected AND heartbeat written, keyed by builderId', () => {
  const h = makeHome();
  try {
    const before = Date.now();
    const r = testHook(HOOK, promptPayload('sess-abc'), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'b-1', DEVSWARM_BUILDER_NAME: 'main-repo1' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be valid JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), `reminder must mention ${REMINDER_PHRASE}; ctx=${ctx(r)}`);

    // Heartbeat is keyed by the child's OWN builderId (b-1), NOT the shared
    // parent branch (main) — this is what the parent-inbox hook's
    // readHeartbeat(home, d.id) looks up.
    const beat = readBeat(h.home, 'b-1');
    assert.strictEqual(beat.source, 'child-turn', 'heartbeat must be marked turn-authored');
    assert.strictEqual(beat.branch, 'main');
    assert.strictEqual(beat.builderId, 'b-1');
    assert.strictEqual(beat.builderName, 'main-repo1');
    assert.strictEqual(beat.repoId, 'repo-1');
    assert.strictEqual(beat.sessionId, 'sess-abc');
    assert.ok(Number.isFinite(beat.ts) && beat.ts >= before, 'ts must be a fresh timestamp from this turn');
    // Must NOT fabricate progress the child never reported.
    assert.ok(!('progress_pct' in beat), 'must not fabricate progress_pct');
    assert.ok(!('phase' in beat), 'must not fabricate phase');
    // No branch-keyed file must be written when builderId is present.
    assert.ok(!fs.existsSync(path.join(heartbeatDir(h.home), 'main.json')), 'must not also write a branch-keyed heartbeat');
  } finally {
    h.cleanup();
  }
});

test('CHILD SIBLINGS: same parent branch, different builderId -> distinct heartbeat files, no collision', () => {
  const h = makeHome();
  try {
    const rA = testHook(HOOK, promptPayload('sess-a'), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-a' },
    });
    const rB = testHook(HOOK, promptPayload('sess-b'), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-b' },
    });
    assert.strictEqual(rA.status, 0);
    assert.strictEqual(rB.status, 0);

    const beatA = readBeat(h.home, 'child-a');
    const beatB = readBeat(h.home, 'child-b');
    assert.strictEqual(beatA.sessionId, 'sess-a', 'sibling A heartbeat must carry its OWN session');
    assert.strictEqual(beatB.sessionId, 'sess-b', 'sibling B heartbeat must carry its OWN session');
    assert.strictEqual(beatA.branch, 'main');
    assert.strictEqual(beatB.branch, 'main');

    // No single shared main.json cross-contaminating both siblings' liveness.
    assert.ok(!fs.existsSync(path.join(heartbeatDir(h.home), 'main.json')), 'siblings must not collapse onto one branch-keyed file');
  } finally {
    h.cleanup();
  }
});

test('PARENT JOIN: parent-side heartbeats/<builderId>.json read resolves the child\'s heartbeat', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-join'), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feature/x', DEVSWARM_BUILDER_ID: 'join-child' },
    });
    assert.strictEqual(r.status, 0);

    // Mirrors devswarm-parent-inbox.js's heartbeatPathFor(home, d.id) where
    // d.id === DEVSWARM_BUILDER_ID (readDescriptors' descriptor id).
    const parentReadPath = path.join(heartbeatDir(h.home), 'join-child.json');
    assert.ok(fs.existsSync(parentReadPath), 'the parent\'s heartbeats/<builderId>.json lookup must find a file');
    const beat = JSON.parse(fs.readFileSync(parentReadPath, 'utf8'));
    assert.strictEqual(beat.builderId, 'join-child');
    assert.strictEqual(beat.sessionId, 'sess-join');
  } finally {
    h.cleanup();
  }
});

test('FALLBACK: no builderId -> heartbeat still keyed by (sanitized) branch', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-fb'), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assert.strictEqual(r.status, 0);
    const beat = readBeat(h.home, 'main');
    assert.strictEqual(beat.sessionId, 'sess-fb');
    assert.strictEqual(beat.builderId, null, 'builderId absent -> null, never fabricated');
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: heartbeats dir unwritable -> exit 0, no crash, reminder still emitted', () => {
  const h = makeHome();
  try {
    const dsw = path.join(h.home, '.anti-hall', 'devswarm');
    fs.mkdirSync(dsw, { recursive: true });
    // Plant a FILE where the heartbeat write needs a directory -> mkdirSync throws.
    fs.writeFileSync(path.join(dsw, 'heartbeats'), 'not-a-directory');

    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'b-1' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), 'reminder must still be emitted despite a heartbeat-write failure');
  } finally {
    h.cleanup();
  }
});

test('CHILD: unsafe branch name is sanitized + hashed into a safe heartbeat filename', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feature/new-thing' },
    });
    assert.strictEqual(r.status, 0);
    const files = fs.readdirSync(heartbeatDir(h.home)).filter((f) => f.endsWith('.json'));
    assert.strictEqual(files.length, 1, `exactly one heartbeat file; got ${JSON.stringify(files)}`);
    const name = files[0];
    assert.ok(!name.includes('/') && !name.includes('\\'), 'filename must contain no path separators');
    assert.ok(/^feature-new-thing-[0-9a-f]{8}\.json$/.test(name), `expected sanitized+hashed name; got ${name}`);
    const beat = JSON.parse(fs.readFileSync(path.join(heartbeatDir(h.home), name), 'utf8'));
    assert.strictEqual(beat.branch, 'feature/new-thing', 'raw branch preserved inside the file');
  } finally {
    h.cleanup();
  }
});

test('UNREAD: durable child inbox with unread parent messages -> count + safe read path surfaced', () => {
  const h = makeHome();
  try {
    // 2 messages, cursor at 0 -> 2 unread.
    seedChildInbox(h.home, 'child-1', ['from parent: rebase now', 'from parent: status?'], 0);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(/2 unread parent message/.test(c), `must surface the unread count; ctx=${c}`);
    assert.ok(/inbox read child-1/.test(c), `must name the safe durable read path; ctx=${c}`);
    assert.ok(/read-messages|monitor/.test(c), `must warn off the destructive drains; ctx=${c}`);
    assert.ok(c.includes(REMINDER_PHRASE), 'the base reminder must still be present');
  } finally {
    h.cleanup();
  }
});

test('UNREAD NONE: cursor caught up -> no unread segment, reminder only (empty-when-zero)', () => {
  const h = makeHome();
  try {
    // 1 message, cursor at 1 -> 0 unread.
    seedChildInbox(h.home, 'child-1', ['from parent: old'], 1);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!/unread parent message/.test(ctx(r)), 'no unread -> no unread segment');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), 'reminder still present');
  } finally {
    h.cleanup();
  }
});

test('UNREAD NO-DESCRIPTOR: child without a durable inbox descriptor -> reminder only, no crash', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!/unread parent message/.test(ctx(r)), 'absent descriptor -> no unread segment');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), 'reminder still present');
  } finally {
    h.cleanup();
  }
});

test('NO-OP: DevSwarm active but branch empty (Primary) -> no output, no heartbeat', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
    assert.ok(!fs.existsSync(heartbeatDir(h.home)), 'no heartbeat dir must be created for Primary');
  } finally {
    h.cleanup();
  }
});

test('NO-OP: no DevSwarm at all (no env) -> no output, no heartbeat', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
    assert.ok(!fs.existsSync(heartbeatDir(h.home)), 'no heartbeat dir must be created');
  } finally {
    h.cleanup();
  }
});

test('NO-OP: branch set but DevSwarm not active -> no output, no heartbeat', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      env: { DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
    assert.ok(!fs.existsSync(heartbeatDir(h.home)), 'no heartbeat dir must be created when dormant');
  } finally {
    h.cleanup();
  }
});

test('KILL-SWITCH: DISABLE_ANTIHALL_DEVSWARM=1 -> dormant even for a child', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DISABLE_ANTIHALL_DEVSWARM: '1' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
    assert.ok(!fs.existsSync(heartbeatDir(h.home)), 'kill-switch must suppress the heartbeat too');
  } finally {
    h.cleanup();
  }
});

test('FRESH: a second turn refreshes ts (turn-authored, not a stuck ticker)', () => {
  const h = makeHome();
  try {
    const env = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' };
    testHook(HOOK, promptPayload(), { home: h.home, env });
    const t1 = readBeat(h.home, 'main').ts;
    // small spin so wall-clock advances at least 1ms
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) { /* noop */ }
    testHook(HOOK, promptPayload(), { home: h.home, env });
    const t2 = readBeat(h.home, 'main').ts;
    assert.ok(t2 >= t1, `second turn must not go backwards; t1=${t1} t2=${t2}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' } });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home, env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' } });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

// ----- #31 HOTFIX: mechanical descriptor registration -----

test('REGISTER: a child turn writes a descriptor readDescriptors accepts, and the parent sees it', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-reg', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'reg-child' },
    });
    assert.strictEqual(r.status, 0);

    const descPath = workspaceDescPath(h.home, 'reg-child');
    assert.ok(fs.existsSync(descPath), 'descriptor file must be written');
    const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'));
    assert.strictEqual(desc.id, 'reg-child');
    assert.strictEqual(desc.sessionId, 'sess-reg');
    assert.strictEqual(desc.worktreePath, path.resolve(REPO_CWD), 'worktreePath must resolve to the git toplevel');

    // The EXACT gate readDescriptors applies (companion/devswarm-supervisor.js):
    // d.worktreePath && d.sessionId && isSafeId(d.id).
    const seen = readDescriptors(h.home);
    const match = seen.find((d) => d.id === 'reg-child');
    assert.ok(match, 'parent readDescriptors must see the newly registered child');
    assert.strictEqual(match.worktreePath, desc.worktreePath);
    assert.strictEqual(match.sessionId, 'sess-reg');
  } finally {
    h.cleanup();
  }
});

test('REGISTER: repoId is populated from DEVSWARM_REPO_ID (#36 cross-project-bleed fix)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-repo', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'repo-child' },
    });
    assert.strictEqual(r.status, 0);
    const desc = JSON.parse(fs.readFileSync(workspaceDescPath(h.home, 'repo-child'), 'utf8'));
    assert.strictEqual(desc.repoId, 'repo-x', 'descriptor must carry the child\'s DEVSWARM_REPO_ID');
  } finally {
    h.cleanup();
  }
});

test('REGISTER: Primary session (branch empty) does NOT get a child descriptor written', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-p', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '', DEVSWARM_BUILDER_ID: 'would-be-child' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(workspaceDescPath(h.home, 'would-be-child')), 'Primary must never register a child descriptor');
  } finally {
    h.cleanup();
  }
});

test('REGISTER MERGE: an existing inboxPath/cursorPath (e.g. from a prior `inbox pull`) is preserved, never clobbered', () => {
  const h = makeHome();
  try {
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    const customInbox = path.join(h.home, '.anti-hall', 'devswarm', 'custom.inbox.ndjson');
    const customCursor = path.join(h.home, '.anti-hall', 'devswarm', 'custom.cursor.json');
    fs.writeFileSync(path.join(wdir, 'reg-child.json'), JSON.stringify({
      id: 'reg-child', worktreePath: '/stale/path', sessionId: 'stale-sess',
      inboxPath: customInbox, cursorPath: customCursor,
    }));

    const r = testHook(HOOK, promptPayload('sess-new', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'reg-child' },
    });
    assert.strictEqual(r.status, 0);

    const desc = JSON.parse(fs.readFileSync(path.join(wdir, 'reg-child.json'), 'utf8'));
    assert.strictEqual(desc.sessionId, 'sess-new', 'sessionId must refresh to this turn\'s truthful value');
    assert.strictEqual(desc.worktreePath, path.resolve(REPO_CWD), 'worktreePath must refresh to the resolved toplevel');
    assert.strictEqual(desc.inboxPath, customInbox, 'existing inboxPath must be preserved, not clobbered');
    assert.strictEqual(desc.cursorPath, customCursor, 'existing cursorPath must be preserved, not clobbered');
  } finally {
    h.cleanup();
  }
});

// ---- P1 TRUNCATION-PROOF PRECREATE (hardened): register's inbox precreate --
// used to use `wx` (exclusive create, fails closed on EEXIST). O_EXCL
// exclusivity is documented as unreliable over some network filesystems, so
// the precreate now uses append mode (`a`) instead: it creates the file if
// absent, and appending '' can never truncate existing content on ANY
// filesystem, with no reliance on O_EXCL at all.
test('REGISTER re-run: a PRE-EXISTING durable inbox with real content survives re-registration (append-create never truncates)', () => {
  const h = makeHome();
  try {
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    const customInbox = path.join(h.home, '.anti-hall', 'devswarm', 'durable.inbox.ndjson');
    const customCursor = path.join(h.home, '.anti-hall', 'devswarm', 'durable.cursor.json');
    fs.mkdirSync(path.dirname(customInbox), { recursive: true });
    fs.writeFileSync(customInbox, JSON.stringify({ _h: 'native:d1', message: 'do not lose me' }) + '\n');
    fs.writeFileSync(path.join(wdir, 'reg-child2.json'), JSON.stringify({
      id: 'reg-child2', worktreePath: '/stale/path', sessionId: 'stale-sess',
      inboxPath: customInbox, cursorPath: customCursor,
    }));

    const r = testHook(HOOK, promptPayload('sess-new2', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'reg-child2' },
    });
    assert.strictEqual(r.status, 0);
    const finalContent = fs.readFileSync(customInbox, 'utf8');
    assert.ok(finalContent.includes('do not lose me'),
      `durable inbox content must survive re-registration; got: ${finalContent}`);
  } finally {
    h.cleanup();
  }
});

test('REGISTER fresh: a genuinely-absent inbox is still created, empty, at the default path', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-fresh', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'reg-fresh' },
    });
    assert.strictEqual(r.status, 0);
    const inboxPath = path.join(h.home, '.anti-hall', 'devswarm', 'inbox', 'reg-fresh.ndjson');
    assert.ok(fs.existsSync(inboxPath), 'a genuinely absent inbox must be created on register');
    assert.strictEqual(fs.readFileSync(inboxPath, 'utf8'), '', 'a freshly-created inbox must be empty');
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: workspaces dir unwritable -> exit 0, no crash, reminder still emitted', () => {
  const h = makeHome();
  try {
    const dsw = path.join(h.home, '.anti-hall', 'devswarm');
    fs.mkdirSync(dsw, { recursive: true });
    // Plant a FILE where the descriptor write needs a directory -> mkdirSync throws.
    fs.writeFileSync(path.join(dsw, 'workspaces'), 'not-a-directory');

    const r = testHook(HOOK, promptPayload('sess-x', REPO_CWD), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'reg-child' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), 'reminder must still be emitted despite a descriptor-write failure');
  } finally {
    h.cleanup();
  }
});

// ----- #29: priority wording + archive-request marker -----

test('PRIORITY WORDING: the unread segment uses IMPERATIVE stop-and-address wording', () => {
  const h = makeHome();
  try {
    seedChildInbox(h.home, 'child-1', ['from parent: rebase now'], 0);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    const c = ctx(r);
    assert.ok(/STOP and address these parent message\(s\) FIRST/.test(c), `must use imperative priority wording; ctx=${c}`);
  } finally {
    h.cleanup();
  }
});

test('ARCHIVE REQUEST: marker in an unread message -> a DISTINCT archive-request segment is surfaced', () => {
  const h = makeHome();
  try {
    seedChildInbox(h.home, 'child-1', ['from parent: please [[ANTIHALL_ARCHIVE_REQUEST]] this workspace'], 0);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    const c = ctx(r);
    assert.ok(/DEVSWARM ARCHIVE REQUEST/.test(c), `must surface a distinct archive-request segment; ctx=${c}`);
    assert.ok(/archive child-1/.test(c), `must name the archive command with this workspace's id; ctx=${c}`);
    assert.ok(/Confirm with YOUR user/.test(c), 'must require the child\'s own user to confirm, never auto-archive');
    assert.ok(/NEVER\s+auto-archive/.test(c), 'must explicitly forbid auto-archiving');
  } finally {
    h.cleanup();
  }
});

test('ARCHIVE REQUEST ABSENT: unread messages with no marker -> no archive-request segment', () => {
  const h = makeHome();
  try {
    seedChildInbox(h.home, 'child-1', ['from parent: status?'], 0);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    const c = ctx(r);
    assert.ok(!/DEVSWARM ARCHIVE REQUEST/.test(c), 'no marker present -> no archive-request segment');
  } finally {
    h.cleanup();
  }
});

// ----- Phase 7 (PLAN-v0.57-mesh.md D25/D26): daemon-liveness STALE banner —
// the SAME warning devswarm-parent-inbox.js renders to the Primary, surfaced to
// a CHILD too (children depend on their project's per-project ingest daemon —
// it drains their native parent->child queue via `inbox pull`). Requires a
// resolvable git worktree (REPO_CWD), same precondition as the descriptor-
// registration tests above. -----
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-stale' };

function lockDir(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'locks');
}
function writeDaemonHeartbeat(home, repoKey, ts) {
  const p = path.join(heartbeatDir(home), 'ingest-' + repoKey + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts }));
}
function writeDaemonLock(home, repoKey, pid) {
  const p = path.join(lockDir(home), 'ingest-project-' + repoKey + '.lock');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid, ts: Date.now(), token: 'test' }));
}
function staleBanner(c) {
  return c.split('\n\n').find((s) => s.includes('DEVSWARM STALE DATA')) || '';
}

test('CHILD STALE: healthy daemon (fresh heartbeat + live lock) -> NO banner', () => {
  const h = makeHome();
  try {
    writeDaemonHeartbeat(h.home, REPO_KEY, Date.now() - 5000);
    writeDaemonLock(h.home, REPO_KEY, process.pid);
    const r = testHook(HOOK, promptPayload('sess-stale', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(staleBanner(ctx(r)), '', `healthy daemon must not warn; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('CHILD STALE: missing heartbeat entirely -> banner surfaced FIRST, above the REMINDER', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-stale', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const banner = staleBanner(c);
    assert.ok(banner, `missing heartbeat must warn; ctx=${c}`);
    assert.ok(/ingest daemon last alive/.test(banner), `banner text; banner=${banner}`);
    const iBanner = c.indexOf('DEVSWARM STALE DATA');
    const iReminder = c.indexOf(REMINDER_PHRASE);
    assert.ok(iBanner >= 0 && iReminder >= 0 && iBanner < iReminder, `banner must sit above the reminder; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('CHILD D25: DEAD process with a still-fresh heartbeat file -> reported NOT-healthy -> banner shown', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeDaemonHeartbeat(h.home, REPO_KEY, Date.now() - 5000); // fresh
    writeDaemonLock(h.home, REPO_KEY, 999999); // implausible/dead pid
    const r = testHook(HOOK, promptPayload('sess-stale', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.ok(staleBanner(ctx(r)), `a dead-process lock must still warn despite a fresh heartbeat; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('CHILD D25: LIVE process holding the lock but a MISSING heartbeat -> reported NOT-fresh -> banner shown', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeDaemonLock(h.home, REPO_KEY, process.pid); // live, but no heartbeat file
    const r = testHook(HOOK, promptPayload('sess-stale', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.ok(staleBanner(ctx(r)), `a live lock alone (no heartbeat) must still warn; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('CHILD STALE: cwd not a git worktree -> NO banner, no throw (fail-open)', () => {
  const h = makeHome();
  try {
    // Default promptPayload cwd ('/tmp') has no enclosing .git.
    const r = testHook(HOOK, promptPayload('sess-stale'), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(staleBanner(ctx(r)), '', `no worktree -> no banner, no throw; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

// ----- D26 (PLAN-v0.57-mesh.md, Phase 8 step 3): mesh DIRECT surfacing. A mesh
// direct addressed to this child's meshId lands, via the addressing join, in
// the child's OWN builder-id partition inside the shared store — this hook
// additionally reads the SAME shared summaries/<repoKey>.json projection the
// Primary reads, for THIS child's OWN entry's directUnread/urgencyMax, and
// renders the SAME urgency-tiered nudge (D4). Distinct from the OLD durable-
// NDJSON-based unreadInfo/buildUnreadSegment reception path above (both can
// coexist). -----

const meshStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

// seedMeshDirect(home, id, count, urgency) — inserts `count` REAL mesh-direct
// rows addressed to `id` into the shared store (the SAME production
// appendMeshMessage primitive `mesh send` uses), then re-derives the
// projection. A DIRECT summary write would be silently overwritten by the
// hook's OWN registerStoreDescriptor->deriveSummary call (D24 gap-close,
// which now runs on every child turn BEFORE this block), so the store is the
// only durable way to seed this scenario.
function seedMeshDirect(home, id, count, urgency) {
  const s = meshStore.openStore({ home, workspaceId: id, hash: REPO_KEY });
  try {
    for (let i = 0; i < count; i++) {
      meshStore.appendMeshMessage(s, {
        from: 'primary-seed', to: id, type: 'direct',
        message: 'seed message ' + i, urgency: urgency || 'normal',
        hash: 'seed-' + id + '-' + i,
      });
    }
    meshStore.deriveSummary(s, { home });
  } finally { s.close(); }
}
function meshDirectSegment(c) {
  return c.split('\n\n').find((s) => s.startsWith('DEVSWARM MESH DIRECT')) || '';
}

test('D26 MESH DIRECT: this child\'s own directUnread>0 in the shared summary -> surfaced with the standard nudge', () => {
  const h = makeHome();
  try {
    seedMeshDirect(h.home, 'child-stale', 2, 'normal');
    const r = testHook(HOOK, promptPayload('sess-mesh', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    const seg = meshDirectSegment(ctx(r));
    assert.ok(seg, `mesh-direct segment expected; ctx=${ctx(r)}`);
    assert.ok(seg.includes('2 unread mesh direct'), `must report the count; seg=${seg}`);
    assert.ok(seg.includes('child-stale'), 'must name this child\'s own id for the read-primary CLI command');
    assert.ok(seg.includes('inbox read-primary'), `must state the read-primary clear path; seg=${seg}`);
    assert.ok(!seg.includes('URGENT'), 'a null-urgency mesh direct must not use the URGENT wording');
  } finally { h.cleanup(); }
});

test('D26 MESH DIRECT URGENT: urgencyMax urgent/high -> the LOUD URGENT wording (D4)', () => {
  const h = makeHome();
  try {
    seedMeshDirect(h.home, 'child-stale', 1, 'urgent');
    const r = testHook(HOOK, promptPayload('sess-mesh', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    const seg = meshDirectSegment(ctx(r));
    assert.match(seg, /DEVSWARM MESH DIRECT — URGENT/, `seg=${seg}`);
    assert.match(seg, /STOP and read them FIRST/);
  } finally { h.cleanup(); }
});

test('D26 MESH DIRECT ABSENT: no mesh directs at all -> no mesh-direct segment', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('sess-mesh', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(meshDirectSegment(ctx(r)), '', `no mesh directs -> no segment; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('D26 MESH DIRECT ABSENT: another workspace\'s directUnread in the shared summary does not leak onto this child', () => {
  const h = makeHome();
  try {
    seedMeshDirect(h.home, 'some-other-child', 5, 'urgent');
    const r = testHook(HOOK, promptPayload('sess-mesh', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(meshDirectSegment(ctx(r)), '', `a DIFFERENT workspace's unread must not surface here; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('D26 MESH DIRECT: coexists with the OLD durable-inbox unread segment (both surfaced, no clobber)', () => {
  const h = makeHome();
  try {
    seedMeshDirect(h.home, 'child-1', 1, 'normal');
    seedChildInbox(h.home, 'child-1', ['from parent: rebase now'], 0);
    const r = testHook(HOOK, promptPayload('sess-mesh', REPO_CWD), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    const c = ctx(r);
    assert.ok(meshDirectSegment(c), `mesh-direct segment present; ctx=${c}`);
    assert.ok(/DEVSWARM CHILD INBOX — PRIORITY/.test(c), `durable-inbox segment also present; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('D26 MESH DIRECT: cwd not a git worktree -> no segment, no throw (fail-open)', () => {
  const h = makeHome();
  try {
    // Default promptPayload cwd ('/tmp') has no enclosing .git -> repoKey never
    // resolves, so there is nothing to seed (registerStoreDescriptor is ALSO a
    // no-op for the same reason) — this proves the fully-inert path directly.
    const r = testHook(HOOK, promptPayload('sess-mesh'), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(meshDirectSegment(ctx(r)), '', `unresolvable worktree -> no mesh-direct segment; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

// A raw pre-seeded corrupt summaries/<repoKey>.json is NOT a reachable D26
// fail-open scenario here: registerStoreDescriptor (D24 gap-close, above)
// unconditionally re-derives + atomically overwrites that SAME file on every
// child turn BEFORE the mesh-direct block reads it, healing any pre-existing
// corruption first. The lazy/guarded-require fail-open contract (D27) IS
// exercised directly — via an isolated plugin-tree copy, never mutating the
// shared repo-tree module — in tests/hooks/devswarm-mesh-projection.test.js's
// "8b" test, which covers BOTH devswarm-parent-inbox.js and
// devswarm-parent-gate.js; devswarm-child-turn.js's OWN lazy-required
// ingest-health.js/devswarm-repokey.js block already has direct unit coverage
// in tests/companion/ingest-health.test.js's "D27 contract" test (same
// require-fails-safely pattern, asserted without any shared-file mutation).

// ---------------------------------------------------------------------------
// v0.58 "mesh-only messaging": terse per-turn OVERRIDE_REASSERT + hook-text sweep.

test('OVERRIDE: terse per-turn COMMS OVERRIDE re-assertion is present, unconditionally, for a child', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(/DEVSWARM COMMS OVERRIDE/.test(ctx(r)), `override must be present; ctx=${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('HOOK-TEXT SWEEP: emitted child-turn text never contains the blocked native verbs', () => {
  const h = makeHome();
  try {
    seedChildInbox(h.home, 'child-1', ['from parent: rebase now'], 0);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    const c = ctx(r);
    assert.ok(!/message-parent/.test(c), `must never emit message-parent; ctx=${c}`);
    assert.ok(!/message-child/.test(c), `must never emit message-child; ctx=${c}`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// v0.58 item 6: child-turn surfaces summary.archive_requested (a field Lane B
// adds to deriveSummary; read here defensively — undefined = falsy = no
// surface). devswarm-store.js's deriveSummary does NOT yet compute this field
// (a separate lane), and this hook's OWN registerStoreDescriptor unconditionally
// re-derives + overwrites summaries/<repoKey>.json from the store BEFORE this
// block reads it (the SAME caveat the D26 tests document above) — so these
// tests pass an EMPTY session_id, the one input that makes registerChildDescriptor
// (and therefore registerStoreDescriptor) a no-op, letting a hand-seeded summary
// file survive untouched for this block to read.

function archiveRequestPromptPayload(cwd) {
  return { hook_event_name: 'UserPromptSubmit', session_id: '', prompt: 'go', cwd: cwd || '/tmp' };
}
function writeRawSummary(home, repoKey, workspaces) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, repoKey + '.json'), JSON.stringify({ workspaces }));
}

test('ITEM 6: summary.archive_requested:true surfaces the archive-request segment', () => {
  const h = makeHome();
  try {
    writeRawSummary(h.home, REPO_KEY, {
      'child-ar': { directUnread: 0, unread: 0, archive_requested: true },
    });
    const r = testHook(HOOK, archiveRequestPromptPayload(REPO_CWD), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-ar' },
    });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(/DEVSWARM ARCHIVE REQUEST/.test(c), `must surface the archive-request segment; ctx=${c}`);
    assert.ok(/archive child-ar/.test(c), `must name this workspace's archive command; ctx=${c}`);
  } finally {
    h.cleanup();
  }
});

test('ITEM 6: summary.archive_requested absent/undefined -> no surface (defensive read, back-compat)', () => {
  const h = makeHome();
  try {
    writeRawSummary(h.home, REPO_KEY, {
      'child-ar': { directUnread: 0, unread: 0 }, // no archive_requested field at all
    });
    const r = testHook(HOOK, archiveRequestPromptPayload(REPO_CWD), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-ar' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!/DEVSWARM ARCHIVE REQUEST/.test(ctx(r)), `undefined field must not surface; ctx=${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('ITEM 6: another workspace\'s archive_requested does not leak onto this child', () => {
  const h = makeHome();
  try {
    writeRawSummary(h.home, REPO_KEY, {
      'other-child': { directUnread: 0, unread: 0, archive_requested: true },
      'child-ar': { directUnread: 0, unread: 0 },
    });
    const r = testHook(HOOK, archiveRequestPromptPayload(REPO_CWD), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-ar' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!/DEVSWARM ARCHIVE REQUEST/.test(ctx(r)), `a DIFFERENT workspace's flag must not surface here; ctx=${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('ITEM 6: dedupe — NDJSON marker path and summary.archive_requested both true in the same turn -> segment appears once', () => {
  const h = makeHome();
  try {
    writeRawSummary(h.home, REPO_KEY, {
      'child-ar': { directUnread: 0, unread: 0, archive_requested: true },
    });
    seedChildInbox(h.home, 'child-ar', ['from parent: please [[ANTIHALL_ARCHIVE_REQUEST]] this workspace'], 0);
    const r = testHook(HOOK, archiveRequestPromptPayload(REPO_CWD), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-ar' },
    });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const count = (c.match(/DEVSWARM ARCHIVE REQUEST/g) || []).length;
    assert.strictEqual(count, 1, `segment must appear exactly once, not double-pushed; ctx=${c}`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1 fix: a DevSwarm child's cwd is its PROJECT WORKTREE, not the plugin root,
// so a RELATIVE `scripts/devswarm.js` (or a bare `devswarm.js` with no
// interpreter/path at all) in emitted text is unrunnable there. Every `node
// <cli>` instruction this hook emits — REMINDER/RECEIVE_NUDGE (unconditional)
// plus the unread/mesh-direct/archive-request segments — must carry an
// ABSOLUTE path that actually exists on disk.

function assertAbsoluteExistingCliPaths(c, { min } = {}) {
  const matches = [...c.matchAll(/`node ([^`]*?devswarm\.js)\b/g)];
  assert.ok(matches.length >= (min || 1), `expected node devswarm.js instruction(s); ctx=${c}`);
  for (const m of matches) {
    const cliPath = m[1];
    assert.ok(path.isAbsolute(cliPath), `emitted CLI path must be absolute, not relative: ${cliPath}`);
    assert.ok(fs.existsSync(cliPath), `emitted CLI path must exist on disk: ${cliPath}`);
    assert.ok(cliPath.endsWith(path.join('scripts', 'devswarm.js')), `must resolve to scripts/devswarm.js: ${cliPath}`);
  }
  // No bare `devswarm.js` reference should survive without a preceding `node <abs-path>`.
  assert.ok(!/[^/]\bdevswarm\.js\b/.test(c.replace(/`node [^`]*?devswarm\.js\b/g, '')),
    `a bare/relative devswarm.js reference leaked through unconverted; ctx=${c}`);
}

test('P1 FIX: unconditional REMINDER + RECEIVE_NUDGE carry an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assertAbsoluteExistingCliPaths(ctx(r), { min: 3 }); // heartbeat + inbox pull + inbox read
  } finally {
    h.cleanup();
  }
});

test('P1 FIX: durable-unread PRIORITY segment carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    seedChildInbox(h.home, 'child-1', ['from parent: rebase now'], 0);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    assertAbsoluteExistingCliPaths(ctx(r));
  } finally {
    h.cleanup();
  }
});

test('P1 FIX: mesh-direct segment carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    seedMeshDirect(h.home, 'child-stale', 1, 'urgent');
    const r = testHook(HOOK, promptPayload('sess-mesh', REPO_CWD), { home: h.home, expectJson: true, env: CHILD_ENV });
    assertAbsoluteExistingCliPaths(ctx(r));
  } finally {
    h.cleanup();
  }
});

test('P1 FIX: archive-request segment carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    seedChildInbox(h.home, 'child-1', ['from parent: please [[ANTIHALL_ARCHIVE_REQUEST]] this workspace'], 0);
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-1' },
    });
    assertAbsoluteExistingCliPaths(ctx(r));
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Text/mechanism mismatch (P1 follow-up, option (a)): REMINDER previously
// implied a direct `send --to-primary` was an equivalent alternative to
// `heartbeat --summary` for "keeping the parent updated" — but
// devswarm-child-gate.js's alreadyReportedThisEpisode() only recognizes an
// OUTBOUND row in the shared summary's `recent[]`, which is populated ONLY by
// a broadcast/heartbeat --summary call (deriveSummary reads it from the
// broadcast partition) — a direct send lands in the RECIPIENT's own partition
// and never touches `recent[]`. REMINDER now explicitly names `heartbeat
// --summary` as what satisfies the Stop-gate and calls out `send --to-primary`
// as a separate, non-substitute channel.

test('MISMATCH FIX: REMINDER names heartbeat --summary as satisfying the Stop-gate, and send --to-primary as a non-substitute', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    const c = ctx(r);
    assert.ok(/heartbeat <DEVSWARM_BUILDER_ID> --summary[\s\S]*?satisfies your Stop-gate report/.test(c),
      `must name heartbeat --summary as satisfying the Stop-gate; ctx=${c}`);
    assert.ok(/send --to-primary[\s\S]*?SEPARATE direct[\s\S]*?not a substitute/.test(c),
      `must call out send --to-primary as a separate, non-substitute channel; ctx=${c}`);
  } finally {
    h.cleanup();
  }
});

// ----- P0 (money path): SessionStart phantom-rescue. cmdSpawn registers a spawn
// phantom ({id:meshId, sessionId:null}); a Primary `send --to <meshId>` issued
// BEFORE the child exists lands in that dead phantom partition. The child reads mesh
// directs by its DEVSWARM_BUILDER_ID, so it never sees them until a fold runs. Pre-fix
// the fold ran ONLY via a later CLI `inbox pull` (cmdRegister) — NOT guaranteed on the
// child's first turn. This wires the identical retireWorktreeDuplicates fold into the
// mechanical SessionStart store-register path, so the phantom's real directs are
// forwarded into the child's builder-id partition and the phantom is tombstoned on the
// child's FIRST self-register. -----
const instP0 = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

test('P0 phantom-rescue: the SessionStart store-register FOLDS a same-worktree spawn phantom — forwards its real directs into the child\'s builder-id partition and tombstones the phantom, deterministically (not only on a later inbox pull)', () => {
  const h = makeHome();
  const BUILDER = 'child-p0-rescue-builder';
  try {
    const mesh = instP0.primaryWorkspaceId(instP0.resolveWorktree(REPO_CWD)); // the spawn phantom's id
    // Seed the phantom row (exactly what cmdSpawn's best-effort auto-register writes:
    // store-only, NO on-disk descriptor, sessionId null) PLUS a real mesh direct that a
    // Primary `send --to <mesh>` landed in the phantom partition before the child existed.
    {
      const s = meshStore.openStore({ home: h.home, workspaceId: mesh, hash: REPO_KEY });
      try {
        s.upsertRegistry({ id: mesh, worktreePath: REPO_CWD, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
        const fields = { from: 'primary-sender', to: mesh, type: 'direct', message: 'landed-in-phantom', urgency: 'normal', hash: 'p0-phantom-direct' };
        meshStore.appendMeshMessage(s, fields);
        meshStore.deriveSummary(s, { home: h.home });
      } finally { s.close(); }
    }

    const r = testHook(HOOK, promptPayload('sess-p0', REPO_CWD), {
      home: h.home, expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: BUILDER },
    });
    assert.strictEqual(r.status, 0);

    const s = meshStore.openStore({ home: h.home, workspaceId: BUILDER, hash: REPO_KEY });
    try {
      // (a) FORWARDED: the phantom's real direct now sits in the child's OWN partition.
      const childBodies = s.listMessages(BUILDER, {}).map((m) => m.body);
      assert.ok(childBodies.includes('landed-in-phantom'),
        'the phantom\'s real direct must be forwarded into the child\'s builder-id partition on first self-register; got ' + JSON.stringify(childBodies));
      // (b) TOMBSTONED: the store-only phantom row is gone from the registry.
      const stillPhantom = s.listRegistry().some((d) => String(d.id) === String(mesh));
      assert.ok(!stillPhantom, 'the spawn phantom row must be tombstoned after the fold');
      // (c) NON-DESTRUCTIVE: the phantom partition's original message rows are preserved.
      assert.deepStrictEqual(s.listMessages(mesh, {}).map((m) => m.body), ['landed-in-phantom'],
        'the retired partition\'s message rows are preserved (forwarded, never deleted)');
    } finally { s.close(); }
  } finally {
    h.cleanup();
  }
});

// ----- F1 (P1, v0.62.2 lock hardening): registerStoreDescriptor is a THIRD writer
// of the shared registry row for an id (alongside cmdRegister and
// rekeySubdirRegistryRows, both of which take the per-id lock) — it must ALSO run
// its upsertRegistry write under withIdLock(id), never unlocked, mirroring G1/G5. -----
const recoveryP1c = require('../../plugins/anti-hall/companion/lib/recovery.js');

test('F1: registerStoreDescriptor does NOT write the shared registry while the id\'s lock is held, and writes it once released', () => {
  const h = makeHome();
  const BUILDER = 'child-f1-lock';
  try {
    const readRow = () => {
      const s = meshStore.openStore({ home: h.home, workspaceId: BUILDER, hash: REPO_KEY });
      try { return s.listRegistry().find((r) => String(r.id) === BUILDER) || null; } finally { s.close(); }
    };
    assert.strictEqual(readRow(), null, 'precondition: no row for this id yet');

    // (a) lock HELD by another op -> the hook's mechanical self-register must skip
    // the store-registry write entirely (fail-closed, not an unlocked write).
    const release = recoveryP1c.acquireLock(BUILDER, h.home);
    assert.equal(typeof release, 'function', 'precondition: the per-id lock is held');
    try {
      const r = testHook(HOOK, promptPayload('sess-f1', REPO_CWD), {
        home: h.home, expectJson: true,
        env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: BUILDER },
      });
      assert.strictEqual(r.status, 0, 'a lock-busy registration must never crash/block the turn');
      assert.strictEqual(readRow(), null,
        'no registry row may be written while the id\'s lock is held by another operation');
    } finally { release(); }

    // (b) lock RELEASED -> the identical turn now writes the row normally.
    const r2 = testHook(HOOK, promptPayload('sess-f1', REPO_CWD), {
      home: h.home, expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: BUILDER },
    });
    assert.strictEqual(r2.status, 0);
    const row = readRow();
    assert.ok(row, 'once unlocked, the mechanical self-register writes the row');
    assert.strictEqual(row.worktreePath, REPO_CWD);
  } finally {
    h.cleanup();
  }
});

// ----- F3 (defensive hardening): a live incident showed hivecontrol's
// DEVSWARM_BUILDER_ID (a UUID) arriving TRUNCATED by a couple of trailing hex
// chars. registerChildDescriptor used to trust it as a filename with zero shape
// validation, writing a phantom descriptor (dead inbox/cursor paths) under the
// short id every turn. Two hardenings: (1) a UUID-shaped-but-short id is either
// corrected to the full id (recovered from this turn's OWN sessionId, when it
// proves the truncation) or skipped outright — never written verbatim; (2) any
// OTHER same-worktree descriptor file whose OWN id is itself truncated
// (TRUNCATED_UUID_RE and not FULL_UUID_RE) is retired via the sanctioned
// archive path on the next real registration. (P1 fix: retirement used to
// ALSO fire on id !== sessionId alone — ground-truth audit showed 100% of
// real descriptors have id !== sessionId by design, so that trigger falsely
// retired healthy same-worktree workspaces. Truncation-shape is now the ONLY
// signal.) -----

const TRUNCATED_ID = 'aaaaaaaa-bbbb-cccc-dddd-c45c1d4196'; // 10 hex in last group (2 short)
const FULL_ID = 'aaaaaaaa-bbbb-cccc-dddd-c45c1d4196ac'; // the real, untruncated UUID

test('F3 VALIDATE: a truncated UUID-shaped DEVSWARM_BUILDER_ID is corrected to the full id recovered from this turn\'s own sessionId, never written verbatim', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload(FULL_ID, REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: TRUNCATED_ID },
    });
    assert.strictEqual(r.status, 0, 'must exit 0 (fail-open)');

    assert.ok(!fs.existsSync(workspaceDescPath(h.home, TRUNCATED_ID)),
      'the truncated id must NEVER get its own phantom descriptor file');
    const descPath = workspaceDescPath(h.home, FULL_ID);
    assert.ok(fs.existsSync(descPath), 'the recovered full id must get the real descriptor');
    const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'));
    assert.strictEqual(desc.id, FULL_ID);
    assert.strictEqual(desc.sessionId, FULL_ID);

    const seen = readDescriptors(h.home);
    assert.ok(!seen.some((d) => d.id === TRUNCATED_ID), 'the parent-facing view must never see the truncated id');
    assert.ok(seen.some((d) => d.id === FULL_ID), 'the parent-facing view must see the recovered full id');
  } finally {
    h.cleanup();
  }
});

test('F3 VALIDATE: a truncated UUID-shaped DEVSWARM_BUILDER_ID with NO recoverable full id is skipped, not written under the bad id', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, promptPayload('unrelated-session-does-not-extend-it', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: TRUNCATED_ID },
    });
    assert.strictEqual(r.status, 0, 'must exit 0 (fail-open)');
    assert.ok(!fs.existsSync(workspaceDescPath(h.home, TRUNCATED_ID)),
      'with no safe recovery available, no phantom descriptor may be written under the truncated id');
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    const names = fs.existsSync(wdir) ? fs.readdirSync(wdir) : [];
    assert.deepStrictEqual(names, [], 'nothing at all should be written this turn when recovery is impossible');
  } finally {
    h.cleanup();
  }
});

test('F3 RETIRE: registering a real child auto-retires a PROVEN same-worktree phantom descriptor (id is itself TRUNCATED-UUID-shaped), non-destructively', () => {
  const h = makeHome();
  try {
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    // Seed the phantom exactly as the incident produced it: a real fs descriptor
    // (so it passes readDescriptors' filter and looks live-ish) whose OWN id is
    // itself UUID-shaped-but-short — the truncation signature, and the ONLY
    // retirement signal after the P1 fix.
    const phantomId = TRUNCATED_ID;
    fs.writeFileSync(path.join(wdir, phantomId + '.json'), JSON.stringify({
      id: phantomId, worktreePath: path.resolve(REPO_CWD), sessionId: 'phantom-dup-1-full-session-id',
      inboxPath: path.join(h.home, '.anti-hall', 'devswarm', 'inbox', phantomId + '.ndjson'),
      cursorPath: path.join(h.home, '.anti-hall', 'devswarm', 'cursors', phantomId + '.cursor'),
    }));
    assert.ok(fs.existsSync(path.join(wdir, phantomId + '.json')), 'precondition: phantom descriptor seeded');

    const r = testHook(HOOK, promptPayload('real-child-99', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'real-child-99' },
    });
    assert.strictEqual(r.status, 0);

    // The REAL child's own descriptor is untouched.
    const realDesc = JSON.parse(fs.readFileSync(workspaceDescPath(h.home, 'real-child-99'), 'utf8'));
    assert.strictEqual(realDesc.id, 'real-child-99');
    assert.strictEqual(realDesc.sessionId, 'real-child-99');

    // The phantom's ACTIVE descriptor is gone (retired), never raw-deleted: it
    // must have been moved into archived/ (cmdArchive's sanctioned path), not
    // simply unlinked with no trace.
    assert.ok(!fs.existsSync(path.join(wdir, phantomId + '.json')),
      'the proven phantom\'s active descriptor must be retired');
    const archivedPath = path.join(h.home, '.anti-hall', 'devswarm', 'archived', phantomId + '.json');
    assert.ok(fs.existsSync(archivedPath),
      'retirement must be a non-destructive archive (hardlink into archived/), not a raw unlink');

    const seen = readDescriptors(h.home);
    assert.ok(!seen.some((d) => d.id === phantomId), 'the retired phantom must no longer surface to the parent');
    assert.ok(seen.some((d) => d.id === 'real-child-99'), 'the real child must still surface to the parent');
  } finally {
    h.cleanup();
  }
});

test('F3 RETIRE P1 FIX: a HEALTHY same-worktree descriptor with id !== sessionId (both full UUIDs, distinct namespaces — the NORMAL shape for every real descriptor) is NOT retired', () => {
  const h = makeHome();
  try {
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    // This is the shape of essentially every live descriptor in production:
    // `id` is the workspace/builder id, `sessionId` is a DIFFERENT Claude
    // session UUID (or null) — a different namespace entirely, per
    // docs/KB-devswarm-hivecontrol.md. It must never be treated as a phantom
    // signal on its own.
    const otherId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const otherSessionId = 'cccccccc-5555-6666-7777-888888888888';
    fs.writeFileSync(path.join(wdir, otherId + '.json'), JSON.stringify({
      id: otherId, worktreePath: path.resolve(REPO_CWD), sessionId: otherSessionId,
      inboxPath: path.join(h.home, '.anti-hall', 'devswarm', 'inbox', otherId + '.ndjson'),
      cursorPath: path.join(h.home, '.anti-hall', 'devswarm', 'cursors', otherId + '.cursor'),
    }));

    const r = testHook(HOOK, promptPayload('real-child-101', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'real-child-101' },
    });
    assert.strictEqual(r.status, 0);

    assert.ok(fs.existsSync(path.join(wdir, otherId + '.json')),
      'a healthy descriptor with id !== sessionId must never be retired merely for sharing a worktree');
    const archivedPath = path.join(h.home, '.anti-hall', 'devswarm', 'archived', otherId + '.json');
    assert.ok(!fs.existsSync(archivedPath), 'must not have been archived either');
    const seen = readDescriptors(h.home);
    assert.ok(seen.some((d) => d.id === otherId), 'the untouched descriptor must still surface to the parent');
    assert.ok(seen.some((d) => d.id === 'real-child-101'), 'the real child must still surface to the parent');
  } finally {
    h.cleanup();
  }
});

test('F3 RETIRE: a same-worktree descriptor whose id === its own sessionId (could be a distinct live child) is LEFT untouched', () => {
  const h = makeHome();
  try {
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    const otherId = 'other-live-child-1';
    fs.writeFileSync(path.join(wdir, otherId + '.json'), JSON.stringify({
      id: otherId, worktreePath: path.resolve(REPO_CWD), sessionId: otherId,
    }));

    const r = testHook(HOOK, promptPayload('real-child-100', REPO_CWD), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'real-child-100' },
    });
    assert.strictEqual(r.status, 0);

    assert.ok(fs.existsSync(path.join(wdir, otherId + '.json')),
      'a descriptor whose id === its own sessionId must never be retired, even if it shares a worktree');
    const seen = readDescriptors(h.home);
    assert.ok(seen.some((d) => d.id === otherId), 'the untouched descriptor must still surface to the parent');
  } finally {
    h.cleanup();
  }
});

// F-A regression (v0.61.2): retirePhantomWorktreeDuplicates used to call
// cmdArchive DIRECTLY, which (unlike foldGroupIntoSurvivor, used by
// retireWorktreeDuplicates/foldMeshDuplicates) does NOT forward unread direct
// messages before tombstoning the registry row. A truncated-id phantom CAN
// still hold an unread direct (mesh routes via registry/worktree, not the
// phantom's dead inboxPath), so retiring it via the old path silently dropped
// that message. The fix forwards via the SAME shared foldGroupIntoSurvivor
// primitive before archiving.
test('F-A RETIRE: a truncated-id phantom holding an unread direct is retired WITHOUT losing the message (forwarded into the survivor)', () => {
  const h = makeHome();
  try {
    const wdir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    const phantomId = TRUNCATED_ID;
    fs.writeFileSync(path.join(wdir, phantomId + '.json'), JSON.stringify({
      id: phantomId, worktreePath: path.resolve(REPO_CWD), sessionId: 'phantom-dup-1-full-session-id',
      inboxPath: path.join(h.home, '.anti-hall', 'devswarm', 'inbox', phantomId + '.ndjson'),
      cursorPath: path.join(h.home, '.anti-hall', 'devswarm', 'cursors', phantomId + '.cursor'),
    }));
    assert.ok(fs.existsSync(path.join(wdir, phantomId + '.json')), 'precondition: phantom descriptor seeded');

    // Seed an UNREAD direct addressed to the phantom's own partition — mesh
    // routes via the registry/worktree, not the phantom's dead inboxPath, so
    // this is reachable even though nothing ever reads the phantom's descriptor
    // inbox. Seeded into the SAME store partition (hash=repoKey for REPO_CWD)
    // production code opens.
    const repoKey = repokey.repoKeyForWorktree(path.resolve(REPO_CWD));
    assert.ok(repoKey, 'precondition: REPO_CWD must resolve a repoKey');
    const seedStore = storeLib.openStore({ home: h.home, workspaceId: phantomId, hash: repoKey, backend: 'journal' });
    try {
      const fields = { from: 'someone', to: phantomId, type: 'direct', message: 'unread-for-phantom', timestamp: Date.now() };
      storeLib.appendMeshMessage(seedStore, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
    } finally { seedStore.close(); }

    // Force the SAME backend the seed store used (journal) for the hook
    // subprocess too — production auto-selects sqlite-when-available, which
    // would otherwise silently diverge from a hand-forced 'journal' seed
    // depending on the Node version running the suite (18/20 lack node:sqlite,
    // 22/24 have it), making the message land in a store the hook never reads.
    const r = testHook(HOOK, promptPayload('real-child-fa', REPO_CWD), {
      home: h.home,
      env: {
        DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'real-child-fa',
        ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal',
      },
    });
    assert.strictEqual(r.status, 0);

    // Phantom retired (same sanctioned archive path as F3).
    assert.ok(!fs.existsSync(path.join(wdir, phantomId + '.json')), 'the proven phantom must still be retired');
    const archivedPath = path.join(h.home, '.anti-hall', 'devswarm', 'archived', phantomId + '.json');
    assert.ok(fs.existsSync(archivedPath), 'retirement must remain a non-destructive archive');

    // The unread message must have been FORWARDED into the real child's own
    // partition — not lost.
    const readStore = storeLib.openStore({ home: h.home, workspaceId: 'real-child-fa', hash: repoKey, backend: 'journal' });
    let bodies;
    try { bodies = readStore.listMessages('real-child-fa', {}).map((m) => m.body); }
    finally { readStore.close(); }
    assert.ok(bodies.includes('unread-for-phantom'), 'the phantom\'s unread direct must be forwarded into the survivor, not dropped: ' + JSON.stringify(bodies));
  } finally {
    h.cleanup();
  }
});
