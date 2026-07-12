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

const HOOK = 'devswarm-child-turn.js';
const REMINDER_PHRASE = 'message-parent';

function promptPayload(sessionId) {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId || 't', prompt: 'go', cwd: '/tmp' };
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

test('CHILD: DevSwarm active + branch set -> reminder injected AND heartbeat written', () => {
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

    const beat = readBeat(h.home, 'main');
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
