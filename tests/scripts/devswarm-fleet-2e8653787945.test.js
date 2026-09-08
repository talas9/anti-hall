'use strict';
// defect 2e8653787945 (P2, 2 occurrences): `send --to-primary`/`send --to` blame
// the recipient address (`primary-unregistered`/`unregistered-recipient`) when
// the real cause can be a stale ingest daemon (`daemonWarning:stale`) — the
// registry this resolution consults can lag a real registration until the
// (confirmed-stale) daemon drains it. Fix: `withSelfHeal` additively marks
// `possiblyStaleRegistry:true` on such a refusal (never overwriting `reason`/
// `error`) and `selfHeal`'s cooldown branch reports `retryAfterMs`.
//
// MODULE_UNDER_TEST selects HEAD vs the patched copy. Isolates HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MODULE_PATH = process.env.MODULE_UNDER_TEST
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
const REPOKEY_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js');

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

function mkGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-2e8-repo-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'a@b.c'], root);
  git(['config', 'user.name', 'a'], root);
  fs.writeFileSync(path.join(root, 'f.txt'), 'x');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'init'], root);
  return root;
}

test('withSelfHeal marks possiblyStaleRegistry:true on an address refusal while the daemon is stale (2e8653787945)', () => {
  const dev = require(MODULE_PATH);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-2e8-home-'));
  const repoCwd = mkGitRepo();
  try {
    // ANTIHALL_DEVSWARM_SUPERVISOR=on forces isDevswarmActive(env) true; no
    // heartbeat/lock file exists under `home` for this repoKey, so
    // ingestHealth.daemonHealth naturally reports non-healthy (stale/missing)
    // — a real, unmocked daemon-staleness signal, not a stubbed one.
    // io.spawnInstaller is mocked so selfHeal's stale-daemon branch never
    // shells out to the REAL installer (defaultSpawnInstaller) — without this,
    // withSelfHeal -> selfHeal -> defaultSpawnInstaller (devswarm.js) runs the
    // real `install-devswarm-ingest.js` under this temp HOME, which registers
    // a real LaunchAgent that outlives the deleted HOME and retries forever
    // (leaked-launchd defect ec33954162ef).
    let spawned = 0;
    const ctx = {
      home, cwd: repoCwd,
      env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'on', ANTIHALL_INGEST_DRY_RUN: '1' }, now: Date.now(),
      io: { spawnInstaller: () => { spawned++; return { status: 0 }; } },
    };

    // The wrapped action simulates cmdSend's own genuine address-resolution
    // refusal — withSelfHeal must never alter `reason`/`error`, only ADD
    // possiblyStaleRegistry additively.
    const fakeSend = () => ({
      ok: false, reason: 'unregistered-recipient',
      error: 'send --to "some-id" is not a registered mesh workspace',
    });

    const r = dev.withSelfHeal(fakeSend, ctx);

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unregistered-recipient', 'the original reason must be preserved verbatim');
    assert.equal(r.daemonWarning, 'stale', 'precondition: the daemon must be observed stale for this test to be meaningful');
    assert.equal(r.possiblyStaleRegistry, true,
      'an address-resolution refusal alongside a stale daemon must be flagged possiblyStaleRegistry');
    assert.equal(spawned, 1, 'precondition: the mocked installer must have been invoked (proves the mock, not the real spawn, was reached)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repoCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('selfHeal reports retryAfterMs during the self-heal cooldown window (2e8653787945)', () => {
  const dev = require(MODULE_PATH);
  const repokey = require(REPOKEY_PATH);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-2e8-home2-'));
  const repoCwd = mkGitRepo();
  try {
    const repoKey = repokey.repoKeyForWorktree(repoCwd);
    assert.ok(repoKey, 'test repo must resolve a repoKey');

    const now = Date.now();
    // Pre-seed a self-heal attempt 10s ago -> still inside the 60s cooldown.
    const cdPath = dev.selfHealCooldownPath(home, repoKey);
    fs.mkdirSync(path.dirname(cdPath), { recursive: true });
    fs.writeFileSync(cdPath, JSON.stringify({ lastAttemptAt: now - 10000 }));

    const ctx = { home, cwd: repoCwd, env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'on' }, now };
    const heal = dev.selfHeal(ctx);

    assert.equal(heal.daemonWarning, 'stale');
    assert.equal(heal.daemonHealCooldown, true, 'precondition: must be inside the cooldown window');
    assert.ok(Number.isFinite(heal.retryAfterMs), 'retryAfterMs must be a finite number during cooldown');
    // 60s window - 10s elapsed = ~50s remaining; allow generous slack for test runtime.
    assert.ok(heal.retryAfterMs > 40000 && heal.retryAfterMs <= 50000,
      'retryAfterMs must reflect the remaining cooldown (~50000ms), got ' + heal.retryAfterMs);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repoCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// Belt-and-braces regression (ec33954162ef): with NO ctx.io.spawnInstaller
// mock at all, selfHeal's stale branch falls through to the REAL
// defaultSpawnInstaller, which really spawns install-devswarm-ingest.js as a
// subprocess. Without ANTIHALL_INGEST_DRY_RUN=1 in ctx.env that subprocess
// would register a genuine LaunchAgent/systemd unit under this temp HOME —
// this test proves the installer's own documented dry-run seam (top-of-file
// comment in install-devswarm-ingest.js) makes that a no-op: the subprocess
// runs for real, but plants nothing under home/Library/LaunchAgents (darwin)
// or ~/.config/systemd/user (linux).
test('selfHeal with ANTIHALL_INGEST_DRY_RUN=1 and no io mock never registers a real unit under a temp HOME (ec33954162ef belt-and-braces)', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return; // no daemon on win32
  const dev = require(MODULE_PATH);
  const installer = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-2e8-home3-'));
  const repoCwd = mkGitRepo();
  try {
    const ctx = {
      home, cwd: repoCwd,
      env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'on', ANTIHALL_INGEST_DRY_RUN: '1' },
      now: Date.now(),
    };
    const r = dev.selfHeal(ctx);
    assert.equal(r.daemonWarning, 'stale', 'precondition: daemon must be observed stale to reach the spawn branch');
    assert.equal(r.daemonHealAttempted, true, 'precondition: a spawn must actually have been attempted (real defaultSpawnInstaller path, no io mock)');
    const units = installer.listInstalledIngestUnits({ home, platform: process.platform });
    assert.deepStrictEqual(units, [], 'ANTIHALL_INGEST_DRY_RUN=1 must prevent the spawned installer from registering any real unit');
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repoCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
