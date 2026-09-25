'use strict';
// doctor-devswarm.js — item 4b (P0, field-proven): doctor now surfaces its own
// WARN line for a workspace whose recorded anti-hall build (item 4a's
// heartbeat `version` field) is older than the newest one known on this
// machine — "workspace <id>: stale anti-hall <v>: restart this session (or
// drain with `node <newest CLI path>`)". Distinct from classifyVersionDrift
// (the DevSwarm CLI's OWN version vs anti-hall's integration baseline) —
// unrelated axis, this compares anti-hall's OWN build across machines/sessions.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'doctor-devswarm.js',
));
const { projectDirFor, writeVerdict, heartbeatPathFor } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-ds-staleversion-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function writeDescriptor(home, d) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, d.id + '.json'), JSON.stringify(Object.assign({ sessionId: UUID }, d)));
}
function writeHeartbeatVersion(home, id, version) {
  const p = heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts: Date.now(), state_ts: Date.now(), version }));
}
// resolvePaths(env, homedir) takes `home` directly as its homedir param, so
// laying this out under the SAME fixture `home` D.runChecks receives is
// sufficient isolation — no ANTIHALL_MARKETPLACE_DIR override needed.
function layoutNewestVersion(home, version, opts) {
  const pluginsRoot = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(path.join(pluginsRoot, 'marketplaces', 'anti-hall'), { recursive: true });
  const versionDir = path.join(pluginsRoot, 'cache', 'anti-hall', 'anti-hall', version);
  fs.mkdirSync(versionDir, { recursive: true });
  // Real cache mirrors the WHOLE plugin tree atomically (dir exists -> the
  // file inside it exists too). Write the scripts/devswarm.js stub unless a
  // caller explicitly wants to simulate the version-known-but-not-yet-
  // mirrored case (skipCliFile: true) — see the dedicated test below.
  if (!(opts && opts.skipCliFile)) {
    const scriptsDir = path.join(versionDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'devswarm.js'), '// stub for tests\n', 'utf8');
  }
  fs.writeFileSync(path.join(pluginsRoot, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'user', version }] } }), 'utf8');
}
function makeDescriptorWorkspace(home, id) {
  const worktreePath = path.join(home, 'wt', id);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(projectDirFor(worktreePath, home), { recursive: true });
  writeDescriptor(home, { id, worktreePath, inboxPath: path.join(worktreePath, 'i'), cursorPath: path.join(worktreePath, 'c') });
}

test('a workspace on an older anti-hall build than the newest known -> WARN naming both versions + the restart/drain fix', () => {
  const { home, cleanup } = makeHome();
  try {
    layoutNewestVersion(home, '0.107.1');
    makeDescriptorWorkspace(home, 'a');
    writeVerdict('a', { status: 'stale', lastOutboundTs: 1 }, home);
    writeHeartbeatVersion(home, 'a', '0.105.3');

    const r = D.runChecks({ home, env: {} });
    assert.strictEqual(r.active, true);
    const line = r.results.find((x) => /workspace a: stale anti-hall/.test(x.message));
    assert.ok(line, 'a stale-anti-hall-build WARN line must be present: ' + JSON.stringify(r.results));
    assert.strictEqual(line.status, D.WARN);
    assert.match(line.message, /stale anti-hall 0\.105\.3: restart this session \(or drain with `node .*devswarm\.js`\)/);
  } finally { cleanup(); }
});

test('a workspace already at the newest known version -> no stale-build line', () => {
  const { home, cleanup } = makeHome();
  try {
    layoutNewestVersion(home, '0.107.1');
    makeDescriptorWorkspace(home, 'b');
    writeVerdict('b', { status: 'alive' }, home);
    writeHeartbeatVersion(home, 'b', '0.107.1');

    const r = D.runChecks({ home, env: {} });
    assert.ok(!r.results.some((x) => /stale anti-hall/.test(x.message)), JSON.stringify(r.results));
  } finally { cleanup(); }
});

test('a workspace with no heartbeat version at all (legacy, pre-item-4a) -> no false stale-build line', () => {
  const { home, cleanup } = makeHome();
  try {
    layoutNewestVersion(home, '0.107.1');
    makeDescriptorWorkspace(home, 'c');
    writeVerdict('c', { status: 'alive' }, home);
    // No heartbeat file written at all for 'c'.

    const r = D.runChecks({ home, env: {} });
    assert.ok(!r.results.some((x) => /stale anti-hall/.test(x.message)), JSON.stringify(r.results));
  } finally { cleanup(); }
});

test('newest version is known (installed_plugins.json) but its cache dir/CLI file does not exist yet -> WARN still fires, but with NO fabricated path (root-cause regression, field repro 2026-09-25)', () => {
  const { home, cleanup } = makeHome();
  try {
    layoutNewestVersion(home, '0.107.1', { skipCliFile: true });
    makeDescriptorWorkspace(home, 'e');
    writeVerdict('e', { status: 'stale', lastOutboundTs: 1 }, home);
    writeHeartbeatVersion(home, 'e', '0.105.3');

    const r = D.runChecks({ home, env: {} });
    const line = r.results.find((x) => /workspace e: stale anti-hall/.test(x.message));
    assert.ok(line, 'the WARN must still fire (the newer version IS known): ' + JSON.stringify(r.results));
    assert.strictEqual(line.status, D.WARN);
    // Must NEVER name a `node <path>` command pointing at a cache dir/file
    // that does not exist on disk (the live crash this test guards against).
    assert.doesNotMatch(line.message, /node .*0\.107\.1.*devswarm\.js/);
    assert.match(line.message, /stale anti-hall 0\.105\.3: restart this session \(or drain with `the newest anti-hall CLI`\)/);
  } finally { cleanup(); }
});

test('no resolvable newest version at all (nothing laid out) -> no stale-build line, never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    makeDescriptorWorkspace(home, 'd');
    writeVerdict('d', { status: 'alive' }, home);
    writeHeartbeatVersion(home, 'd', '0.105.3');

    const r = D.runChecks({ home, env: {} });
    assert.strictEqual(r.active, true);
    assert.ok(!r.results.some((x) => /stale anti-hall/.test(x.message)), JSON.stringify(r.results));
  } finally { cleanup(); }
});
