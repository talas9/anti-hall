'use strict';
// devswarm-child-gate (Stop hook). Forces a CHILD DevSwarm workspace to emit a
// heartbeat/self-report before stopping — a capped, self-resetting forced-ack.
// Primary sessions, non-DevSwarm sessions, and malformed stdin must all be silent
// no-ops (fail-open, exit 0). The cap must never hard-loop the child.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'devswarm-child-gate.js';

// NO_NATIVE_BIN_PATH — a directory that (deliberately) does not exist. The child-
// gate's STRICT-mode fallback (#29) spawns a bare `hivecontrol` off PATH; without
// pinning PATH here, tests would inherit the HOST machine's real PATH (isolatedEnv
// in spawn-hook.js defaults PATH to process.env.PATH) and — on any machine with a
// real hivecontrol installed (e.g. the DevSwarm app) — would silently spawn the
// REAL binary during a unit test. Every env below neutralizes PATH to this
// nonexistent dir by default so the probe deterministically resolves to "no
// binary" (spawnSync ENOENT -> null -> fail-open) regardless of the host. Tests
// that specifically exercise the native probe override PATH themselves (see the
// STRICT tests below, which point PATH at a fake hivecontrol script).
const NO_NATIVE_BIN_PATH = path.join(os.tmpdir(), 'antihall-child-gate-no-native-bin-default');

const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feat/x', PATH: NO_NATIVE_BIN_PATH };

// seedDurableUnread(home, id, lines, consumed) — register a child's own durable
// descriptor inbox (workspaces/<id>.json -> inboxPath/cursorPath) with `lines`
// total messages and `consumed` already acked, mirroring devswarm-child-turn.test.js's
// seedChildInbox fixture (same NDJSON + bare-int cursor contract readUnread expects).
function seedDurableUnread(home, id, lines, consumed) {
  const dsw = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(dsw, id + '.inbox.ndjson');
  const cursorPath = path.join(dsw, id + '.cursor.json');
  fs.mkdirSync(dsw, { recursive: true });
  fs.writeFileSync(inboxPath, lines.join('\n') + (lines.length ? '\n' : ''));
  fs.writeFileSync(cursorPath, String(consumed));
  const wdir = path.join(dsw, 'workspaces');
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, id + '.json'), JSON.stringify({ id, inboxPath, cursorPath }));
}

// writeFakeHivecontrol(dir, {count, sentinelFile}) -> path. A genuinely EXECUTABLE
// stand-in for the real `hivecontrol` binary (not just a PATH-existence stub): it
// appends to sentinelFile (proof it was actually invoked) and prints `count` to
// stdout, matching the plain-integer shape probeNativeMessageCount parses.
// Cross-platform: a POSIX shell script (chmod +x) on darwin/linux, a .cmd batch
// file (Windows PATHEXT resolution) on win32.
function writeFakeHivecontrol(dir, { count, sentinelFile }) {
  if (process.platform === 'win32') {
    const p = path.join(dir, 'hivecontrol.cmd');
    fs.writeFileSync(p, `@echo off\r\necho invoked>> "${sentinelFile}"\r\necho ${count}\r\n`);
    return p;
  }
  const p = path.join(dir, 'hivecontrol');
  fs.writeFileSync(p, `#!/bin/sh\necho invoked >> "${sentinelFile}"\necho ${count}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function stopPayload(extra) {
  return Object.assign({ hook_event_name: 'Stop', session_id: 's1' }, extra || {});
}

function stateFile(home, session) {
  return path.join(home, '.anti-hall', 'devswarm', 'child-gate', session + '.json');
}

// A branch that is isSafeId-clean, so the heartbeat file key == the branch verbatim
// (heartbeats/main.json) — no sanitize+hash needed in the test. PATH pinned to
// NO_NATIVE_BIN_PATH for the same host-hermeticity reason as CHILD_ENV above.
const SAFE_CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', PATH: NO_NATIVE_BIN_PATH };

function heartbeatFile(home, key) {
  return path.join(home, '.anti-hall', 'devswarm', 'heartbeats', key + '.json');
}
function writeHeartbeat(home, key, ts) {
  const p = heartbeatFile(home, key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, source: 'child-turn', branch: key }));
}

test('BLOCK: child workspace + supervisor active -> Stop is blocked with heartbeat forced-ack', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.decision, 'block');
    assert.ok(/devswarm\.js heartbeat/.test(r.json.reason), `reason must tell child to heartbeat via the mesh CLI; got=${r.json.reason}`);
    assert.ok(!/message-parent/.test(r.json.reason) && !/message-child/.test(r.json.reason),
      `reason must never emit the blocked native verbs; got=${r.json.reason}`);
    // Distinct state file was created under devswarm/child-gate/.
    assert.ok(fs.existsSync(stateFile(h.home, 's1')), 'own distinct state file must exist');
  } finally {
    h.cleanup();
  }
});

test('UNREPORTED: no heartbeat emitted yet -> Stop is blocked (child has not reported current state)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: SAFE_CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'no heartbeat -> must force a report');
  } finally {
    h.cleanup();
  }
});

test('REGRESSION (v0.54.1): a FRESH turn-start heartbeat must NOT false-silence the gate — an unreported child still blocks', () => {
  const h = makeHome();
  try {
    // devswarm-child-turn writes this heartbeat at TURN START — it means "a turn
    // began", NOT "the child pinged its parent". The v0.54.0 gate wrongly treated it
    // as satisfaction and silenced a child that never ran message-parent. The gate
    // must now block regardless of a fresh heartbeat.
    writeHeartbeat(h.home, 'main', Date.now());
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: SAFE_CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'a fresh heartbeat must not silence an unreported child');
    assert.ok(/devswarm\.js heartbeat/.test(r.json.reason), 'must still demand a real mesh heartbeat report');
  } finally {
    h.cleanup();
  }
});

test('NO-OP: Primary (DEVSWARM_SOURCE_BRANCH empty) -> no block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: no DevSwarm at all -> no block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: child branch set but supervisor NOT active -> no block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, env: { DEVSWARM_SOURCE_BRANCH: 'feat/x' } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('CAP: consecutive stops within the window block MAX_BLOCKS times then yield (no hard loop)', () => {
  const h = makeHome();
  try {
    // Two blocks, then the third consecutive Stop (same tight window) yields.
    const r1 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r1.json && r1.json.decision, 'block', 'first stop blocks');
    const r2 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r2.json && r2.json.decision, 'block', 'second stop blocks');
    const r3 = testHook(HOOK, stopPayload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', `third stop must yield (allow); got: ${r3.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('RESET: after the window elapses, the cap re-arms and forces a fresh heartbeat', () => {
  const h = makeHome();
  try {
    // Prime state as if the cap was already reached long ago (>5min).
    const p = stateFile(h.home, 's1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ blocks: 5, lastBlockAt: Date.now() - (6 * 60 * 1000) }));
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'stale cap must re-arm and block again');
  } finally {
    h.cleanup();
  }
});

test('SKIP: explicit user skip marker -> no block', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'devswarm-child-gate': Date.now() + 60000 });
    const r = testHook(HOOK, stopPayload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout under skip; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: cap state unwritable -> exit 0, does NOT block (never fail-closed)', () => {
  const h = makeHome();
  try {
    // Make the cap-state directory unwritable by planting a FILE where the
    // child-gate needs a directory (cross-platform: mkdirSync recursive then
    // rename will throw ENOTDIR/EEXIST). The state write must fail -> the gate
    // must FAIL OPEN (allow the stop), never emit a block it can't cap.
    const dsw = path.join(h.home, '.anti-hall', 'devswarm');
    fs.mkdirSync(path.dirname(dsw), { recursive: true });
    fs.writeFileSync(dsw, 'not-a-directory'); // child-gate/<session>.json lives under here
    const r = testHook(HOOK, stopPayload(), { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `unwritable cap state must NOT block; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON stdin -> exit 0, no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home, env: CHILD_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `malformed stdin must not block; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// ----- #29: inbound gate (unpulled/unread parent messages) -----

test('INBOUND: durable unread>0 -> reason adds the inbox-pull instruction alongside the outbound report demand', () => {
  const h = makeHome();
  try {
    seedDurableUnread(h.home, 'b-1', ['from parent: rebase now'], 0);
    const env = Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: 'b-1' });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.ok(/inbox pull/.test(r.json.reason), `reason must include the inbound inbox-pull instruction; got=${r.json.reason}`);
    assert.ok(/devswarm\.js heartbeat/.test(r.json.reason), 'the outbound report demand must still be present');
  } finally {
    h.cleanup();
  }
});

test('INBOUND CAUGHT UP: durable unread=0 -> no inbound instruction (outbound-only reason)', () => {
  const h = makeHome();
  try {
    seedDurableUnread(h.home, 'b-1', ['from parent: old'], 1);
    const env = Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: 'b-1' });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.ok(!/inbox pull/.test(r.json.reason), 'caught up (durable) + no native binary on PATH -> no inbound instruction');
  } finally {
    h.cleanup();
  }
});

test('INBOUND CAP: durable unread pending does NOT bypass the shared MAX_BLOCKS cap (no second budget)', () => {
  const h = makeHome();
  try {
    seedDurableUnread(h.home, 'b-1', ['from parent: x'], 0);
    const env = Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: 'b-1' });
    const r1 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r1.json && r1.json.decision, 'block', 'first stop blocks');
    const r2 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r2.json && r2.json.decision, 'block', 'second stop blocks');
    const r3 = testHook(HOOK, stopPayload(), { home: h.home, env });
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', 'third stop must yield even with unread pending — the cap is shared, never bypassed');
  } finally {
    h.cleanup();
  }
});

test('STRICT (default ON): no durable descriptor -> a bounded, non-destructive native message-count probe fires and its count drives the inbound reason', () => {
  const h = makeHome();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-childgate-strict-'));
  const sentinel = path.join(bin, 'sentinel.txt');
  try {
    writeFakeHivecontrol(bin, { count: 3, sentinelFile: sentinel });
    const env = Object.assign({}, CHILD_ENV, { PATH: bin });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.ok(fs.existsSync(sentinel), 'the native message-count probe must have been invoked (STRICT default ON)');
    assert.ok(/inbox pull/.test(r.json.reason), `native backlog must drive the inbound instruction; got=${r.json.reason}`);
  } finally {
    h.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('STRICT=0: the native message-count probe is SKIPPED — pure-fs durable-unread check only', () => {
  const h = makeHome();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-childgate-strict0-'));
  const sentinel = path.join(bin, 'sentinel.txt');
  try {
    writeFakeHivecontrol(bin, { count: 3, sentinelFile: sentinel });
    const env = Object.assign({}, CHILD_ENV, { PATH: bin, ANTIHALL_DEVSWARM_CHILD_GATE_STRICT: '0' });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.ok(!fs.existsSync(sentinel), 'STRICT=0 must NEVER spawn the native message-count probe');
    assert.ok(!/inbox pull/.test(r.json.reason), 'no durable unread + STRICT off -> no inbound instruction, despite a real native backlog');
  } finally {
    h.cleanup();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('FAIL-OPEN: native message-count probe has no binary on PATH -> exit 0, block still occurs (outbound reason only), never crashes', () => {
  const h = makeHome();
  try {
    const env = Object.assign({}, CHILD_ENV, {
      PATH: path.join(os.tmpdir(), 'antihall-child-gate-nonexistent-bin-dir-zzz'),
    });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.json && r.json.decision, 'block', 'the outbound forced-ack must still fire');
    assert.ok(!/inbox pull/.test(r.json.reason), 'an unknown native probe result must never be treated as unread');
  } finally {
    h.cleanup();
  }
});

// ----- v0.58 item 5: projection-only "already-reported" satisfaction -----
// Skip the block when summaries/<repoKey>.json shows an OUTBOUND row this child
// itself sent (recent[], sender === DEVSWARM_BUILDER_ID) THIS stop episode.

const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const meshStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

// GIT_ONLY_PATH — repoKeyForWorktree spawns a real `git` binary, but CHILD_ENV's
// PATH is deliberately pinned to NO_NATIVE_BIN_PATH (a nonexistent dir) so the
// STRICT-mode native `hivecontrol` probe elsewhere in this file never resolves a
// REAL system binary. Resolving `git` needs SOME real PATH entry, so for the
// already-reported tests below we build a PATH containing ONLY the directory
// that holds the real `git` executable (never the host's full PATH) — git
// resolves, while a real `hivecontrol` (installed elsewhere, e.g. via the
// DevSwarm app) stays unreachable.
function findGitDir() {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const p of String(process.env.PATH || '').split(path.delimiter)) {
    try { if (fs.existsSync(path.join(p, exe))) return p; } catch (_) {}
  }
  return '';
}
const GIT_ONLY_PATH = [findGitDir(), NO_NATIVE_BIN_PATH].filter(Boolean).join(path.delimiter);

// seedOutboundReport(home, id, ts) — writes a REAL mesh broadcast/heartbeat row
// (the SAME primitive `devswarm.js heartbeat --summary` uses) with `from: id`
// and the given `ts`, then re-derives summaries/<REPO_KEY>.json, so
// alreadyReportedThisEpisode's recent[] read finds it.
function seedOutboundReport(home, id, ts) {
  const s = meshStore.openStore({ home, workspaceId: id, hash: REPO_KEY });
  try {
    meshStore.appendMeshMessage(s, {
      from: id, type: 'broadcast', message: 'status update', timestamp: ts,
      isHeartbeat: true, hash: 'ar-' + id + '-' + ts,
    });
    meshStore.deriveSummary(s, { home });
  } finally { s.close(); }
}

const REPORTED_ENV = Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: 'child-ar', PATH: GIT_ONLY_PATH });

test('ALREADY-REPORTED: a fresh outbound row this stop episode -> Stop is NOT blocked (skip)', () => {
  const h = makeHome();
  try {
    seedOutboundReport(h.home, 'child-ar', Date.now());
    const r = testHook(HOOK, stopPayload({ cwd: REPO_CWD }), { home: h.home, env: REPORTED_ENV });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `already-reported child must not be blocked; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALREADY-REPORTED + KNOWN durable unread pending -> STILL blocks (inbound half of the gate is preserved)', () => {
  const h = makeHome();
  try {
    seedOutboundReport(h.home, 'child-ar', Date.now());
    seedDurableUnread(h.home, 'child-ar', ['from parent: rebase now'], 0);
    const r = testHook(HOOK, stopPayload({ cwd: REPO_CWD }), { home: h.home, expectJson: true, env: REPORTED_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'a reported-but-still-unread child must still be blocked');
    assert.ok(/inbox pull/.test(r.json.reason), `reason must still demand the inbound pull; got=${r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('ALREADY-REPORTED window: an outbound row OLDER than this stop episode does NOT satisfy -> normal capped forced-ack', () => {
  const h = makeHome();
  try {
    // RESET_MS is 5 minutes; a report from 10 minutes ago, with no prior
    // lastBlockAt, falls outside episodeSince = now - RESET_MS.
    seedOutboundReport(h.home, 'child-ar', Date.now() - 10 * 60 * 1000);
    const r = testHook(HOOK, stopPayload({ cwd: REPO_CWD }), { home: h.home, expectJson: true, env: REPORTED_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'a stale outbound row must not satisfy this episode');
  } finally {
    h.cleanup();
  }
});

test('ALREADY-REPORTED: an outbound row from a DIFFERENT sender does not satisfy -> still blocks', () => {
  const h = makeHome();
  try {
    seedOutboundReport(h.home, 'some-other-child', Date.now());
    const r = testHook(HOOK, stopPayload({ cwd: REPO_CWD }), { home: h.home, expectJson: true, env: REPORTED_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'a DIFFERENT sender\'s report must not satisfy this child\'s gate');
  } finally {
    h.cleanup();
  }
});

test('ALREADY-REPORTED: no cwd resolvable (falls back to process.cwd(), no summary seeded there) -> fail-open, normal forced-ack', () => {
  const h = makeHome();
  try {
    // No cwd in the payload and nothing seeded under this fake HOME for whatever
    // repoKey process.cwd() resolves to -> alreadyReportedThisEpisode fails open
    // (false), so behavior is byte-identical to pre-v0.58.
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: REPORTED_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'unresolvable/unseeded projection must fail open to the normal forced-ack');
  } finally {
    h.cleanup();
  }
});

test('HOOK-TEXT SWEEP: emitted child-gate block reason never contains the blocked native verbs', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.ok(!/message-parent/.test(r.json.reason), `reason must never emit message-parent; got=${r.json.reason}`);
    assert.ok(!/message-child/.test(r.json.reason), `reason must never emit message-child; got=${r.json.reason}`);
  } finally {
    h.cleanup();
  }
});
