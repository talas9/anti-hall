'use strict';
// checkOrphanedMcpUnderBroker (report-only, defensive; defect bfa063ab8e3f).
//
// Detects MCP-signature child processes parented to a LIVE (non-PID-1) broker
// process — the class of leak a PPID==1 orphan reaper structurally cannot see
// (its children never reparent to init while the broker itself stays alive).
// Report-only: this suite never spawns a real process and never asserts any
// kill/signal behavior — the production function itself is read-only `ps`
// enumeration plus pure string/array analysis.
//
// All `ps` output here is a FAKE fixture injected via the `psExec` override —
// no real process is ever spawned or inspected by this file.
//
// --- Mutation coverage (documented + proven below the tests) ---------------
// M1: `n >= THRESHOLD` -> `n > THRESHOLD` (off-by-one). Caught by the exact-
//     boundary test (exactly 30 MCP children under one broker must still fire).
// M2: `const THRESHOLD = 30;` -> `const THRESHOLD = 3000;` (threshold raised
//     so nothing realistic ever fires). Caught by the main above-threshold test.
// M3: `if (!p.ppid || p.ppid === 1) continue;` deleted (orphan/PID-1-parented
//     MCP children no longer excluded). Caught by the PID-1-parent test, which
//     includes a real `pid 1` line in the fixture so the parent lookup
//     succeeds and the mutant's miscount becomes observable.
// RED/GREEN evidence for each mutant is pasted in the PR/task report, not
// re-derived here — this header exists so a future reader can re-run the same
// three mutations against this exact file without re-deriving the design.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const repair = require(REPAIR_JS);

// Build a fake `ps -axo pid=,ppid=,command=` line.
function psLine(pid, ppid, cmd) {
  return `  ${pid}  ${ppid}  ${cmd}`;
}

// A real MCP-signature child command line (matches mcp-reaper.js's matchesMcp:
// runtime argv0 `node` + an `mcp-server`-style token).
function mcpChildCmd(name) {
  return `node /Users/example/.codex/mcp-servers/${name}/dist/index.js --stdio`;
}

function fakePsExec(stdout) {
  return () => ({ error: null, status: 0, signal: null, stdout });
}

test('checkOrphanedMcpUnderBroker: 35 MCP children under one live broker (pid 500) -> fires, reports count + broker pid', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(500, 1, '/usr/local/bin/app-server-broker')];
  for (let i = 0; i < 35; i++) lines.push(psLine(600 + i, 500, mcpChildCmd('server-' + i)));
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec(lines.join('\n')) });
  assert.ok(r, 'must fire well above threshold');
  assert.strictEqual(r.atRisk, true);
  assert.strictEqual(r.count, 35);
  assert.strictEqual(r.brokerCount, 1);
  assert.match(r.message, /pid 500/);
  assert.match(r.message, /35 MCP-signature/);
});

test('checkOrphanedMcpUnderBroker: exactly 30 MCP children under one broker -> still fires (boundary, catches off-by-one)', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(500, 1, '/usr/local/bin/app-server-broker')];
  for (let i = 0; i < 30; i++) lines.push(psLine(600 + i, 500, mcpChildCmd('server-' + i)));
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec(lines.join('\n')) });
  assert.ok(r, 'exactly THRESHOLD children must still fire (>=, not >)');
  assert.strictEqual(r.count, 30);
});

test('checkOrphanedMcpUnderBroker: 5 MCP children under one broker (below threshold) -> silent (null)', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(500, 1, '/usr/local/bin/app-server-broker')];
  for (let i = 0; i < 5; i++) lines.push(psLine(600 + i, 500, mcpChildCmd('server-' + i)));
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec(lines.join('\n')) });
  assert.strictEqual(r, null, 'a couple of MCP children under a live broker is normal operation');
});

test('checkOrphanedMcpUnderBroker: 40 MCP children directly parented to PID 1 (real orphans) -> silent (that is the OTHER reaper\'s job)', () => {
  const lines = [psLine(1, 0, '/sbin/launchd')];
  for (let i = 0; i < 40; i++) lines.push(psLine(600 + i, 1, mcpChildCmd('server-' + i)));
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec(lines.join('\n')) });
  assert.strictEqual(r, null, 'PID-1-parented MCP children are real orphans, not broker-leaked children — out of this check\'s scope');
});

test('checkOrphanedMcpUnderBroker: garbage/unparseable ps output -> silent (null), never throws', () => {
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec('not even close to ps output\nlol\n\t\t garbage###') });
  assert.strictEqual(r, null);
});

test('checkOrphanedMcpUnderBroker: empty ps output -> silent (null)', () => {
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec('') });
  assert.strictEqual(r, null);
});

test('checkOrphanedMcpUnderBroker: ps command missing (error) -> silent (null), never throws', () => {
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: () => ({ error: new Error('ENOENT: ps not found') }) });
  assert.strictEqual(r, null);
});

test('checkOrphanedMcpUnderBroker: ps exits non-zero -> silent (null)', () => {
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: () => ({ error: null, status: 1, stdout: '' }) });
  assert.strictEqual(r, null);
});

test('checkOrphanedMcpUnderBroker: ps output truncated (signal set, e.g. maxBuffer exceeded) -> silent (null)', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(500, 1, '/usr/local/bin/app-server-broker')];
  for (let i = 0; i < 40; i++) lines.push(psLine(600 + i, 500, mcpChildCmd('server-' + i)));
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: () => ({ error: null, status: 0, signal: 'SIGTERM', stdout: lines.join('\n') }) });
  assert.strictEqual(r, null, 'a truncated/unreliable scan must never be trusted for a report');
});

test('checkOrphanedMcpUnderBroker: psExec throws -> fail-open null, never propagates', () => {
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: () => { throw new Error('boom'); } });
  assert.strictEqual(r, null);
});

test('checkOrphanedMcpUnderBroker: mcpReaperModPath unrequireable -> null, never throws', () => {
  const r = repair.checkOrphanedMcpUnderBroker({ mcpReaperModPath: '/no/such/module-xyz.js' });
  assert.strictEqual(r, null);
});

test('checkOrphanedMcpUnderBroker: 40 non-MCP children under a busy live process -> silent (only real MCP-signature commands count)', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(500, 1, '/usr/local/bin/some-busy-process')];
  for (let i = 0; i < 40; i++) lines.push(psLine(600 + i, 500, `node /Users/example/app/worker-${i}.js --task run`));
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec(lines.join('\n')) });
  assert.strictEqual(r, null, 'ordinary node worker children must never be mistaken for MCP leaks');
});

test('checkOrphanedMcpUnderBroker: two brokers over threshold -> both reported, capped list, total count sums both', () => {
  const lines = [psLine(1, 0, '/sbin/launchd'), psLine(500, 1, '/usr/local/bin/broker-a'), psLine(501, 1, '/usr/local/bin/broker-b')];
  for (let i = 0; i < 32; i++) lines.push(psLine(700 + i, 500, mcpChildCmd('a-' + i)));
  for (let i = 0; i < 31; i++) lines.push(psLine(800 + i, 501, mcpChildCmd('b-' + i)));
  const r = repair.checkOrphanedMcpUnderBroker({ psExec: fakePsExec(lines.join('\n')) });
  assert.ok(r);
  assert.strictEqual(r.brokerCount, 2);
  assert.strictEqual(r.count, 63);
});
