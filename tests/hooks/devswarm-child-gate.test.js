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

// ---------------------------------------------------------------------------
// P1 fix: a DevSwarm child's cwd is its PROJECT WORKTREE, not the plugin root,
// so a RELATIVE `scripts/devswarm.js` in the emitted Stop-block reason is
// unrunnable there. Every `node <cli>` instruction in the reason must carry an
// ABSOLUTE path that actually exists on disk.

function assertAbsoluteExistingCliPaths(reason, { min } = {}) {
  const matches = [...reason.matchAll(/`node ([^`]*?devswarm\.js)\b/g)];
  assert.ok(matches.length >= (min || 1), `expected node devswarm.js instruction(s); reason=${reason}`);
  for (const m of matches) {
    const cliPath = m[1];
    assert.ok(path.isAbsolute(cliPath), `emitted CLI path must be absolute, not relative: ${cliPath}`);
    assert.ok(fs.existsSync(cliPath), `emitted CLI path must exist on disk: ${cliPath}`);
    assert.ok(cliPath.endsWith(path.join('scripts', 'devswarm.js')), `must resolve to scripts/devswarm.js: ${cliPath}`);
  }
}

test('P1 FIX: outbound-only block reason carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block');
    assertAbsoluteExistingCliPaths(r.json.reason);
  } finally {
    h.cleanup();
  }
});

test('P1 FIX: inbound (unpulled/unread) block reason carries ABSOLUTE, existing devswarm.js paths (both the pull AND heartbeat instructions)', () => {
  const h = makeHome();
  try {
    seedDurableUnread(h.home, 'b-1', ['from parent: rebase now'], 0);
    const env = Object.assign({}, CHILD_ENV, { DEVSWARM_BUILDER_ID: 'b-1' });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r.json && r.json.decision, 'block');
    assertAbsoluteExistingCliPaths(r.json.reason, { min: 2 });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Text/mechanism mismatch (documents the mechanism the child-turn.js REMINDER
// fix relies on): alreadyReportedThisEpisode() reads ONLY the shared summary's
// `recent[]` projection, which deriveSummary populates EXCLUSIVELY from the
// broadcast partition (a `heartbeat --summary` / `send --broadcast` call) — a
// `send --to-primary` DIRECT message lands in the RECIPIENT's own partition and
// is invisible to this check. So a child that direct-messages its parent but
// never heartbeats is STILL blocked here, confirming REMINDER must not (and,
// post-fix, no longer does) imply the two are interchangeable.
test('MISMATCH: a DIRECT send (not broadcast/heartbeat) from this child does NOT satisfy the gate -> still blocks', () => {
  const h = makeHome();
  try {
    const s = meshStore.openStore({ home: h.home, workspaceId: 'child-ar', hash: REPO_KEY });
    try {
      meshStore.appendMeshMessage(s, {
        from: 'child-ar', to: 'some-primary-id', type: 'direct',
        message: 'status update via direct send', timestamp: Date.now(),
        hash: 'direct-child-ar-1',
      });
      meshStore.deriveSummary(s, { home: h.home });
    } finally { s.close(); }
    const r = testHook(HOOK, stopPayload({ cwd: REPO_CWD }), { home: h.home, expectJson: true, env: REPORTED_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block',
      'a direct send (never written to recent[]) must not satisfy alreadyReportedThisEpisode');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// v0.59 "self-wake" — TEXT-ONLY re-assertion. Whenever this gate is ALREADY
// forcing a heartbeat block (below), the reason also re-asserts the MAILBOX WAKE
// directive. No new state, no new cap: it rides the SAME MAX_BLOCKS-bounded
// forced-ack this file already has. Claude-only (CronCreate is a Claude tool).
// ---------------------------------------------------------------------------

const CLAUDE_CHILD_ENV = Object.assign({}, CHILD_ENV, { DEVSWARM_AI_AGENT: 'claude' });

test('WAKE RE-ASSERT: Claude child -> the forced-ack reason also carries the CronCreate wake directive', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CLAUDE_CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block');
    const reason = r.json.reason;
    assert.ok(/MAILBOX WAKE/.test(reason), `reason must re-assert the wake directive; reason=${reason}`);
    assert.ok(/`CronCreate`/.test(reason), `must name the CronCreate tool; reason=${reason}`);
    assert.ok(reason.includes('`*/5 * * * *`'), `must carry the default schedule; reason=${reason}`);
    for (const m of [...reason.matchAll(/`node ([^`]*?devswarm\.js)\b/g)]) {
      assert.ok(path.isAbsolute(m[1]), `emitted CLI path must be absolute: ${m[1]}`);
      assert.ok(fs.existsSync(m[1]), `emitted CLI path must exist: ${m[1]}`);
    }
  } finally {
    h.cleanup();
  }
});

test('WAKE INTERVAL: ANTIHALL_DEVSWARM_WAKE_CRON is honored in the Stop re-assertion too', () => {
  const h = makeHome();
  try {
    const env = Object.assign({}, CLAUDE_CHILD_ENV, { ANTIHALL_DEVSWARM_WAKE_CRON: '*/1 * * * *' });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.ok(r.json.reason.includes('`*/1 * * * *`'), `override must be honored; reason=${r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('WAKE BOUND: rides the SAME MAX_BLOCKS cap as the heartbeat forced-ack — no extra block, never wedged', () => {
  const h = makeHome();
  try {
    // Stops 1-2: heartbeat forced-ack (MAX_BLOCKS=2), each also carrying the wake line.
    const r1 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CLAUDE_CHILD_ENV });
    assert.ok(/MAILBOX WAKE/.test(r1.json.reason), 'stop 1: wake line present');
    const r2 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CLAUDE_CHILD_ENV });
    assert.ok(/MAILBOX WAKE/.test(r2.json.reason), 'stop 2: wake line present');
    // Stop 3: the SAME cap that already governs the heartbeat forced-ack is
    // exhausted -> full silence. No separate wake-only block exists.
    const r3 = testHook(HOOK, stopPayload(), { home: h.home, env: CLAUDE_CHILD_ENV });
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', `stop 3 must yield exactly like the pre-wake gate; got: ${r3.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('WAKE RE-ARM: once RESET_MS elapses and the heartbeat cap re-arms, the wake line rides along again', () => {
  const h = makeHome();
  try {
    const p = stateFile(h.home, 's1');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ blocks: 5, lastBlockAt: Date.now() - (6 * 60 * 1000) }));
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CLAUDE_CHILD_ENV });
    assert.strictEqual(r.json && r.json.decision, 'block', 'the heartbeat gate re-arms');
    assert.ok(/MAILBOX WAKE/.test(r.json.reason), `wake line rides the re-armed block; reason=${r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

test('CODEX PARITY: a Codex child is NEVER told to call CronCreate; its heartbeat cap is unaffected', () => {
  const h = makeHome();
  try {
    const env = Object.assign({}, CHILD_ENV, { DEVSWARM_AI_AGENT: 'codex' });
    const r1 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.ok(!/CronCreate|MAILBOX WAKE/.test(r1.json.reason), `Codex must get no wake nag; reason=${r1.json.reason}`);
    const r2 = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r2.json && r2.json.decision, 'block', 'second stop still blocks (heartbeat cap)');
    // Third stop: heartbeat cap exhausted -> silent yield, byte-identical to the
    // pre-v0.59 behavior (Codex never had a wake mechanism to begin with).
    const r3 = testHook(HOOK, stopPayload(), { home: h.home, env });
    assert.strictEqual(r3.stdout, '', `Codex third stop must yield exactly as before; got: ${r3.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('KILL SWITCH: DISABLE_ANTIHALL_DEVSWARM=1 -> no block at all, even for a Claude child', () => {
  const h = makeHome();
  try {
    const env = Object.assign({}, CLAUDE_CHILD_ENV, { DISABLE_ANTIHALL_DEVSWARM: '1' });
    const r = testHook(HOOK, stopPayload(), { home: h.home, env });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `kill switch must silence the hook entirely; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

// 7-DAY EXPIRY (scheduled-tasks contract): a recurring cron task self-deletes 7 days
// after creation, so a long-lived workspace silently loses its wake job. The Stop
// re-assertion is therefore a CronList RE-VERIFY (re-create if gone) — that check IS
// the renewal path, which is why anti-hall needs no 7-day timer or state of its own.
test('WAKE RENEWAL: the Stop re-assertion instructs a CronList RE-VERIFY (re-create if expired), not merely a create', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env: CLAUDE_CHILD_ENV });
    const reason = r.json.reason;
    assert.ok(/`CronList`/.test(reason), `must instruct a CronList verify; reason=${reason}`);
    assert.ok(/VERIFY|verify/.test(reason), `must be worded as a verify; reason=${reason}`);
    assert.ok(/RE-CREATE|re-create/i.test(reason), `must instruct re-creation when gone; reason=${reason}`);
    assert.ok(/expire/i.test(reason) && /7 days/.test(reason), `must state the 7-day auto-expiry; reason=${reason}`);
    assert.ok(reason.indexOf('`CronList`') < reason.indexOf('`CronCreate`'),
      `CronList must come before CronCreate; reason=${reason}`);
  } finally {
    h.cleanup();
  }
});

// FAIL-OPEN INVARIANT: lib/devswarm-wake.js is loaded LAZILY inside a try/catch. A
// TOP-LEVEL require would sit OUTSIDE main()'s try/catch, so a lib missing from a
// package (or throwing on load) would CRASH this Stop hook instead of degrading —
// verified: pre-fix it exited 1 with an uncaught throw, which on a Stop hook
// degrades or wedges the user's session. Preload fixture: helpers/break-devswarm-wake.js.
const BREAK_WAKE = path.join(__dirname, '..', 'helpers', 'break-devswarm-wake.js');

test('FAIL-OPEN: an UNLOADABLE devswarm-wake lib -> the gate still blocks with its PRE-WAKE reason, never crashes', () => {
  const h = makeHome();
  try {
    const env = Object.assign({}, CLAUDE_CHILD_ENV, { NODE_OPTIONS: `--require "${BREAK_WAKE}"` });
    const r = testHook(HOOK, stopPayload(), { home: h.home, expectJson: true, env });
    assert.strictEqual(r.status, 0, `must fail OPEN, not crash; stderr=${r.stderr}`);
    assert.strictEqual(r.json && r.json.decision, 'block', 'the heartbeat forced-ack itself must survive');
    assert.ok(!/MAILBOX WAKE/.test(r.json.reason), `the wake line must be dropped, not half-emitted; reason=${r.json.reason}`);
  } finally {
    h.cleanup();
  }
});
