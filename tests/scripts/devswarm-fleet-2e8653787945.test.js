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
    const ctx = { home, cwd: repoCwd, env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'on' }, now: Date.now() };

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
