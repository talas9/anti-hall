'use strict';
// ===========================================================================
// mcp-reaper END-TO-END test — exercises the REAL run-path of mcp-reaper.js:
// real `ps` enumeration, real SIGTERM/SIGKILL, real orphan reparenting to PID 1.
//
// ┌─────────────────────────── SAFETY (the core guarantee) ───────────────────┐
// │ This test can NEVER kill a real process. Every throwaway process we spawn  │
// │ carries a UNIQUE per-run marker string in its argv:                        │
// │     AHREAP_E2E_<this-test-pid>_<counter>                                   │
// │ We run the reaper with ANTIHALL_REAPER_MATCH=<marker>. That env makes the  │
// │ reaper's MCP matcher able to match ONLY commands containing OUR marker —   │
// │ the generic MCP signature still applies on top, but no real MCP server or  │
// │ any other process on the machine carries this pid-scoped marker, so the    │
// │ reaper's kill set is provably limited to processes WE created in this run. │
// │ A try/finally sweep then SIGKILLs any marker-bearing stray regardless of   │
// │ pass/fail, so nothing we spawn can survive the test.                       │
// └───────────────────────────────────────────────────────────────────────────┘
//
// Windows: the reaper is a documented no-op. We assert that (exit 0 + message),
// then skip the Unix body.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const MOD = path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'mcp-reaper.js'
);

// Unique, deterministic marker (no Math.random/Date.now): pid + incrementing int.
let MARKER_SEQ = 0;
function newMarker() {
  return `AHREAP_E2E_${process.pid}_${++MARKER_SEQ}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// pidAlive(pid) -> bool, via signal-0 probe (ESRCH => gone).
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // EPERM => exists but not ours; ESRCH => gone.
  }
}

// ppidOf(pid) -> number|null using a real one-shot `ps`.
function ppidOf(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

// Run the reaper binary directly with an env override. Returns {status, stdout, stderr}.
function runReaper(env) {
  return spawnSync(process.execPath, [MOD], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 12000,
  });
}

// Kill anything (orphan or live) whose `ps` command contains the marker. Best-effort.
function sweepMarker(marker) {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    if (m[2].includes(marker)) {
      try { process.kill(Number(m[1]), 'SIGKILL'); } catch (_e) { /* gone */ }
    }
  }
}

// --------------------------------------------------------------------------
// Windows: reaper must no-op. Assert and skip the Unix body.
// --------------------------------------------------------------------------
test('mcp-reaper e2e (Windows no-op path)', { skip: process.platform !== 'win32' }, () => {
  const r = runReaper({});
  assert.strictEqual(r.status, 0, 'reaper must exit 0 on Windows');
  assert.match(String(r.stdout), /Windows is unsupported/i, 'must print the Windows no-op message');
});

// --------------------------------------------------------------------------
// Unix: REAL orphan reap end-to-end.
// --------------------------------------------------------------------------
test('mcp-reaper e2e (Unix real reap)', { skip: process.platform === 'win32' }, async (t) => {
  const marker = newMarker();
  // The grandchild command. Marker is passed as an arg so it appears in `ps` command.
  // A long, idle interval keeps it alive but harmless until we (or the reaper) kill it.
  const childCode = "setInterval(()=>{},1e9)";

  let orphanPid = null;     // detached grandchild that should reparent to PID 1
  let controlChild = null;  // live-parented process with the SAME marker (must survive)

  try {
    // --- 1. Create a REAL orphan ---------------------------------------------------
    // Intermediate process spawns a DETACHED grandchild (its own session), then exits.
    // On exit, the grandchild reparents to PID 1 (init/launchd) — a genuine orphan.
    // We print the grandchild PID from the intermediate so we can track it.
    const intermediateCode = `
      const { spawn } = require('child_process');
      const gc = spawn(process.execPath,
        ['-e', ${JSON.stringify(childCode)}, ${JSON.stringify(marker)}],
        { detached: true, stdio: 'ignore' });
      gc.unref();
      process.stdout.write(String(gc.pid));
      process.exit(0);
    `;
    const inter = spawnSync(process.execPath, ['-e', intermediateCode], {
      encoding: 'utf8', timeout: 8000,
    });
    orphanPid = Number(String(inter.stdout).trim());
    assert.ok(Number.isFinite(orphanPid) && orphanPid > 0,
      `expected a grandchild pid, got: ${JSON.stringify(inter.stdout)} / ${inter.stderr}`);

    // Poll until the grandchild reparents to PID 1, hard 5s timeout. If it never
    // reparents (some sandboxed CI subreaper setups), SKIP — do not fail flakily.
    const deadline = Date.now() + 5000;
    let reparented = false;
    while (Date.now() < deadline) {
      if (!pidAlive(orphanPid)) break; // died unexpectedly; handled below
      if (ppidOf(orphanPid) === 1) { reparented = true; break; }
      await sleep(100);
    }
    if (!pidAlive(orphanPid)) {
      return t.skip('orphan grandchild exited before reparenting could be observed');
    }
    if (!reparented) {
      return t.skip('grandchild did not reparent to PID 1 within 5s (sandboxed subreaper?)');
    }

    // --- 2. CONTROL: live-parented process with the SAME marker --------------------
    // Parent is THIS node test runtime (alive). isReaperParent(node-runtime) is false,
    // so the reaper must NOT touch it even though it matches the marker.
    controlChild = spawn(process.execPath,
      ['-e', childCode, marker],
      { stdio: 'ignore' });
    // Give `ps` a moment to see it.
    await sleep(150);
    assert.ok(pidAlive(controlChild.pid), 'control must be alive before reap');
    assert.strictEqual(ppidOf(controlChild.pid), process.pid,
      'control parent must be this live test runtime');

    // --- 3. DRYRUN: orphan detected, control NOT ----------------------------------
    // Verify via the reaper's own findOrphans over a REAL ps capture (authoritative,
    // independent of log-file timing).
    const reaper = require(MOD);
    const psCap = spawnSync('ps', ['-axo', 'pid=,ppid=,command='],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const procs = reaper.parsePs(psCap.stdout);
    const extraRe = new RegExp(marker, 'i');
    const orphans = reaper.findOrphans(procs, extraRe);
    const orphanPids = new Set(orphans.map((o) => o.pid));
    assert.ok(orphanPids.has(orphanPid),
      `findOrphans must flag the reparented orphan pid ${orphanPid}`);
    assert.ok(!orphanPids.has(controlChild.pid),
      `findOrphans must NOT flag the live-parented control pid ${controlChild.pid}`);

    // Also run the real DRYRUN run-path (must exit 0, kill nothing).
    const dry = runReaper({ MCP_REAP_DRYRUN: '1', ANTIHALL_REAPER_MATCH: marker });
    assert.strictEqual(dry.status, 0, 'dryrun reaper must exit 0');
    assert.ok(pidAlive(orphanPid), 'dryrun must NOT kill the orphan');
    assert.ok(pidAlive(controlChild.pid), 'dryrun must NOT kill the control');

    // --- 4. REAL reap: orphan dies, control survives ------------------------------
    const real = runReaper({ MCP_REAP_GRACE: '1', ANTIHALL_REAPER_MATCH: marker });
    assert.strictEqual(real.status, 0, 'real reaper must exit 0');

    // Poll for the orphan to disappear (SIGTERM -> 1s grace -> SIGKILL inside reaper),
    // bounded ~5s.
    const killDeadline = Date.now() + 5000;
    while (Date.now() < killDeadline && pidAlive(orphanPid)) {
      await sleep(100);
    }
    assert.ok(!pidAlive(orphanPid), `orphan pid ${orphanPid} must be reaped`);
    assert.ok(pidAlive(controlChild.pid),
      `control pid ${controlChild.pid} (live parent) must SURVIVE the reap`);
  } finally {
    // --- 5. ABSOLUTE cleanup: nothing marker-bearing may survive, pass or fail ----
    if (controlChild && controlChild.pid) {
      try { process.kill(controlChild.pid, 'SIGKILL'); } catch (_e) { /* gone */ }
    }
    if (orphanPid) {
      try { process.kill(orphanPid, 'SIGKILL'); } catch (_e) { /* gone */ }
    }
    sweepMarker(marker);
  }
});

// --------------------------------------------------------------------------
// Helper: spawn a REAL orphan that reparents to PID 1, returning its pid, or
// null/skip-signal if the sandbox subreaper prevents reparenting. Caller owns
// cleanup via sweepMarker(marker).
// --------------------------------------------------------------------------
async function makeOrphan(marker, childCode) {
  const intermediateCode = `
    const { spawn } = require('child_process');
    const gc = spawn(process.execPath,
      ['-e', ${JSON.stringify(childCode)}, ${JSON.stringify(marker)}],
      { detached: true, stdio: 'ignore' });
    gc.unref();
    process.stdout.write(String(gc.pid));
    process.exit(0);
  `;
  const inter = spawnSync(process.execPath, ['-e', intermediateCode], {
    encoding: 'utf8', timeout: 8000,
  });
  const orphanPid = Number(String(inter.stdout).trim());
  if (!Number.isFinite(orphanPid) || orphanPid <= 0) return { skip: 'no grandchild pid' };

  const deadline = Date.now() + 5000;
  let reparented = false;
  while (Date.now() < deadline) {
    if (!pidAlive(orphanPid)) return { skip: 'grandchild exited before reparenting', orphanPid };
    if (ppidOf(orphanPid) === 1) { reparented = true; break; }
    await sleep(100);
  }
  if (!reparented) return { skip: 'grandchild did not reparent to PID 1 (sandboxed subreaper?)', orphanPid };
  return { orphanPid };
}

// --------------------------------------------------------------------------
// Unix: ANTIHALL_REAPER_EXCLUDE must protect an orphan end-to-end through the
// REAL kill path (SIGTERM + re-check SIGKILL). The excluded orphan must SURVIVE.
// Covers run-section gap: excludeRe applied in the SIGKILL re-check branch.
// --------------------------------------------------------------------------
test('mcp-reaper e2e: ANTIHALL_REAPER_EXCLUDE makes a real orphan SURVIVE the kill path',
  { skip: process.platform === 'win32' }, async (t) => {
    const marker = newMarker();
    const childCode = 'setInterval(()=>{},1e9)';
    let orphanPid = null;
    try {
      const made = await makeOrphan(marker, childCode);
      if (made.skip) return t.skip(made.skip);
      orphanPid = made.orphanPid;

      // Match ONLY our marker, but EXCLUDE that same marker. Net: the orphan qualifies
      // by match yet is opted out — it must be reaped by nothing. GRACE small to keep fast.
      const r = runReaper({
        MCP_REAP_GRACE: '1',
        ANTIHALL_REAPER_MATCH: marker,
        ANTIHALL_REAPER_EXCLUDE: marker,
      });
      assert.strictEqual(r.status, 0, 'reaper must exit 0');

      // Give the full SIGTERM->grace->SIGKILL window time to (not) act.
      await sleep(2500);
      assert.ok(pidAlive(orphanPid),
        `excluded orphan pid ${orphanPid} must SURVIVE (exclude honored through kill path)`);
    } finally {
      if (orphanPid) { try { process.kill(orphanPid, 'SIGKILL'); } catch (_e) { /* gone */ } }
      sweepMarker(marker);
    }
  });

// --------------------------------------------------------------------------
// Unix: MCP_REAP_GRACE=0 must be HONORED (not swallowed to the default 3s).
// We assert the run completes promptly (well under the 3s default grace) AND
// that the orphan is actually reaped — proving 0 was used as the grace.
// Covers run-section gap: grace `0` not coerced by `|| 3`.
// --------------------------------------------------------------------------
test('mcp-reaper e2e: MCP_REAP_GRACE=0 is honored (prompt completion, orphan reaped)',
  { skip: process.platform === 'win32' }, async (t) => {
    const marker = newMarker();
    const childCode = 'setInterval(()=>{},1e9)';
    let orphanPid = null;
    try {
      const made = await makeOrphan(marker, childCode);
      if (made.skip) return t.skip(made.skip);
      orphanPid = made.orphanPid;

      const t0 = Date.now();
      const r = runReaper({ MCP_REAP_GRACE: '0', ANTIHALL_REAPER_MATCH: marker });
      const elapsed = Date.now() - t0;
      assert.strictEqual(r.status, 0, 'reaper must exit 0');
      // With grace=0 the sleepSync is ~0ms; the whole run is dominated by two `ps`
      // scans (sub-second). If 0 were wrongly coerced to 3, this would exceed 3000ms.
      assert.ok(elapsed < 2500,
        `grace=0 must complete promptly; took ${elapsed}ms (default 3s grace not used)`);

      // And the orphan is genuinely reaped.
      const killDeadline = Date.now() + 5000;
      while (Date.now() < killDeadline && pidAlive(orphanPid)) await sleep(100);
      assert.ok(!pidAlive(orphanPid), `orphan pid ${orphanPid} must be reaped with grace=0`);
    } finally {
      if (orphanPid) { try { process.kill(orphanPid, 'SIGKILL'); } catch (_e) { /* gone */ } }
      sweepMarker(marker);
    }
  });
