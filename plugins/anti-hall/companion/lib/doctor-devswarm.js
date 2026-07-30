'use strict';
// anti-hall :: doctor-devswarm — the DevSwarm liveness section of doctor.js as a
// pure, testable check function (mirrors skills/flutter-debug/scripts/preflight.js
// -> doctor.js §6b). Workaround for claude-code#39755.
//
// runChecks({home, env, fsi}) -> { active, results: [{status, message}] }.
// Silent (active:false, no results) unless the supervisor is in play — either the
// session is DevSwarm-active OR the consumer has published workspace descriptors.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { isDevswarmActive } = require('../../hooks/lib/devswarm-detect.js');
const { computeLiveness, livenessPathFor, projectDirFor, devswarmRoot, isSafeId, unreadBacklog } = require('./liveness.js');
const { checkResults: descriptorChecks } = require('./doctor-descriptors.js');

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';
const SELFTEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LISTENER_IDLE_MS = 15 * 60 * 1000; // mirrors liveness.js's DEFAULT_IDLE_MS

function workspacesDir(home) { return path.join(devswarmRoot(home), 'workspaces'); }

function readDescriptors(home, F) {
  let names = [];
  try { names = F.readdirSync(workspacesDir(home)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    try {
      const d = JSON.parse(F.readFileSync(path.join(workspacesDir(home), n), 'utf8'));
      if (d && d.worktreePath && d.sessionId && isSafeId(d.id)) out.push(d);
    } catch (_) {}
  }
  return out;
}

// statusFor(verdictStatus) -> PASS | WARN | FAIL (base mapping).
function statusFor(s) {
  if (s === 'alive') return PASS;
  if (s === 'stale' || s === 'nudged') return WARN;
  return FAIL; // ambiguous | escalated | anything unexpected
}

// statusForVerdict(verdict) -> PASS | WARN | FAIL. No stuck-timer any more — the
// automatic path never kills, so there is no kill-then-resume window to watch
// for being "stuck"; a `nudged` verdict is just a soft WARN, and the
// poke/escalate machinery (liveness.js's nudge branch + recovery.js's
// pokeOrEscalate) already owns moving it to `escalated` once the nudge budget is
// exhausted.
function statusForVerdict(verdict) {
  const s = verdict && verdict.status;
  if (s === 'alive') return PASS;
  if (s === 'stale' || s === 'nudged') return WARN;
  return FAIL; // ambiguous | escalated | unexpected
}

// selfTest(home, F) -> [{status, message}]. Constructed-fixture behavioral test
// (doctor convention): a FRESH transcript classifies alive; a WEDGED one (idle +
// pending) classifies stale. Proves the live logic still fires. Liveness is
// uuid-SCOPED, so the fixture's transcript is named <SELFTEST_UUID>.jsonl and the
// descriptor carries that sessionId.
function selfTest(home, F) {
  const out = [];
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-selftest-'));
    try {
      const wt = path.join(base, 'wt');
      F.mkdirSync(wt, { recursive: true });
      const projectDir = projectDirFor(wt, base);
      F.mkdirSync(projectDir, { recursive: true });
      const tp = path.join(projectDir, SELFTEST_UUID + '.jsonl');
      F.writeFileSync(tp, '{}\n');
      const inboxPath = path.join(wt, 'i'); const cursorPath = path.join(wt, 'c');
      F.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
      F.writeFileSync(cursorPath, '0');
      const descriptor = { id: 'selftest', worktreePath: wt, inboxPath, cursorPath, sessionId: SELFTEST_UUID };

      // Fresh: transcript mtime = now -> alive.
      const nowTs = Date.now();
      const alive = computeLiveness({ descriptor, home: base, now: nowTs, idleThresholdMs: 15 * 60 * 1000, runners: { fs: F, gitCommitTs: () => nowTs } });
      out.push({ status: alive.status === 'alive' ? PASS : FAIL, message: 'liveness self-test: fresh workspace classified ' + alive.status + ' (expected alive)' });

      // Wedged: both signals idle + pending -> stale.
      const old = nowTs - 30 * 60 * 1000;
      const t = old / 1000; F.utimesSync(tp, t, t);
      const wedged = computeLiveness({ descriptor, home: base, now: nowTs, idleThresholdMs: 15 * 60 * 1000, runners: { fs: F, gitCommitTs: () => old } });
      out.push({ status: wedged.status === 'stale' ? WARN : FAIL, message: 'liveness self-test: wedged workspace classified ' + wedged.status + ' (expected stale)' });
    } finally {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (e) {
    out.push({ status: WARN, message: 'liveness self-test raised (fail-open): ' + (e && e.message) });
  }
  return out;
}

// listenerPresenceFor(descriptor, now, F) -> {status, message}. A distinct
// signal from the combined liveness verdict above: is something actually
// CONSUMING the workspace's inbox, not just "is the target session alive".
// Derived ONLY from observable file state (cursor/inbox mtimes + the same
// unreadBacklog() cursor-vs-inbox math liveness.js already trusts) — there is
// no separate heartbeat file for this, so a case that can't be read cleanly
// reports WARN "state unknown" rather than guessing a PASS.
function listenerPresenceFor(d, now, F) {
  let cursorMtime = null;
  try { cursorMtime = F.statSync(d.cursorPath).mtimeMs; } catch (_) {}
  const backlog = unreadBacklog(d.inboxPath, d.cursorPath, F);
  if (cursorMtime === null || !backlog.known) {
    return { status: WARN, message: 'workspace ' + d.id + ' listener: state unknown (inbox/cursor unreadable)' };
  }
  // Caught up: an empty backlog is never evidence of a dead listener, whatever
  // the cursor's age — nothing pending means nothing to have missed.
  if (backlog.lines.length === 0) {
    return { status: PASS, message: 'workspace ' + d.id + ' listener: present (inbox caught up, no backlog)' };
  }
  const cursorAgeMs = now - cursorMtime;
  // Pending backlog + a recently-moved cursor = direct evidence something is
  // actively draining it.
  if (cursorAgeMs <= LISTENER_IDLE_MS) {
    return { status: PASS, message: 'workspace ' + d.id + ' listener: present (cursor advanced ' + Math.round(cursorAgeMs / 1000) + 's ago, draining ' + backlog.lines.length + ' pending)' };
  }
  // Pending backlog + a stale cursor: could be a dead listener OR just a slow
  // one — we cannot tell them apart from file state alone, so never claim PASS.
  return { status: WARN, message: 'workspace ' + d.id + ' listener: state unknown (' + backlog.lines.length + ' unread message(s), cursor last moved ' + Math.round(cursorAgeMs / 60000) + 'm ago)' };
}

// ---------------------------------------------------------------------------
// wake-monitor (Monitor-based idle-wake) — shipped / proven / live report.
// Companion to skills/update/scripts/update.js's wakeMonitorPostUpdate: THAT
// function runs post-update and can only verify/report (a plain Node process
// has no `Monitor` tool); THIS check runs on every `doctor` pass and reports
// the same three honest facts — shipped, proven (behavioral self-test), live
// (read-only lock inspection) — plus the exact manual arm command whenever no
// watcher is currently live. Neither path ever claims to have armed anything.
// ---------------------------------------------------------------------------
const PLUGIN_ROOT = path.join(__dirname, '..', '..');

// wakeMonitorShipped(pluginRoot) -> { shipped, watcherPath, watcherMod, reason }.
// shipped requires BOTH: the watcher script present + require()-loadable with
// its expected exports, AND hooks/lib/devswarm-wake.js's wakeDirective actually
// emitting Monitor-arm text when given a watcher path (proves the two halves
// are still wired together, not just independently present).
function wakeMonitorShipped(pluginRoot) {
  const watcherPath = path.join(pluginRoot, 'companion', 'lib', 'devswarm-wake-watch.js');
  try {
    if (!fs.existsSync(watcherPath)) return { shipped: false, watcherPath, reason: 'watcher script missing at ' + watcherPath };
    let watcherMod;
    try { watcherMod = require(watcherPath); } catch (e) { return { shipped: false, watcherPath, reason: 'watcher script failed to load: ' + (e && e.message ? e.message : String(e)) }; }
    if (typeof watcherMod.tick !== 'function' || typeof watcherMod.normalizeState !== 'function'
      || typeof watcherMod.resolveIdentity !== 'function' || typeof watcherMod.lockPathFor !== 'function') {
      return { shipped: false, watcherPath, reason: 'watcher script loaded but is missing expected exports (tick/normalizeState/resolveIdentity/lockPathFor)' };
    }
    const wakePath = path.join(pluginRoot, 'hooks', 'lib', 'devswarm-wake.js');
    if (!fs.existsSync(wakePath)) return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js missing at ' + wakePath };
    let wakeMod;
    try { wakeMod = require(wakePath); } catch (e) { return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js failed to load: ' + (e && e.message ? e.message : String(e)) }; }
    if (typeof wakeMod.wakeDirective !== 'function') return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js is missing wakeDirective' };
    const cli = path.join(pluginRoot, 'scripts', 'devswarm.js');
    let text = '';
    try { text = wakeMod.wakeDirective({ DEVSWARM_AI_AGENT: 'claude' }, false, cli, watcherPath) || ''; } catch (_) { text = ''; }
    if (typeof text !== 'string' || !text.includes('Monitor') || !text.includes(watcherPath)) {
      return { shipped: false, watcherPath, reason: 'hooks/lib/devswarm-wake.js did not emit Monitor-arm text for a watcher path — the two halves are no longer wired together' };
    }
    return { shipped: true, watcherPath, watcherMod };
  } catch (e) {
    return { shipped: false, watcherPath, reason: 'raised: ' + (e && e.message ? e.message : String(e)) };
  }
}

// wakeMonitorSelfTest(watcherMod) -> [{status, message}]. Behavioral proof the
// PURE tick() core still fires correctly — mirrors selfTest()'s constructed-
// fixture style above. Starts from an already-armed synthetic state so the
// arm-line's own one-time emission never muddies the silent/emits assertions:
// a no-change snapshot must stay silent, a new-total snapshot must emit
// exactly one wake line.
function wakeMonitorSelfTest(watcherMod) {
  const out = [];
  try {
    const { tick, normalizeState } = watcherMod;
    let st = normalizeState({ armed: true, lastTotal: 5 });
    const noChange = { ok: true, total: 5, role: 'primary', id: 'selftest', nowMs: Date.now() };
    const r1 = tick(st, noChange);
    const silentOk = Array.isArray(r1.lines) && r1.lines.length === 0;
    out.push({ status: silentOk ? PASS : FAIL, message: 'wake-monitor self-test: no-change snapshot stayed silent (' + (r1.lines ? r1.lines.length : '?') + ' line(s), expected 0)' });

    st = r1.state;
    const newTotal = { ok: true, total: 6, role: 'primary', id: 'selftest', nowMs: Date.now() };
    const r2 = tick(st, newTotal);
    const emitOk = Array.isArray(r2.lines) && r2.lines.length === 1 && /new mesh mail/.test(r2.lines[0]);
    out.push({ status: emitOk ? PASS : FAIL, message: 'wake-monitor self-test: new-total snapshot emitted a wake line (' + (r2.lines ? r2.lines.length : '?') + ' line(s), expected 1)' });
  } catch (e) {
    out.push({ status: WARN, message: 'wake-monitor self-test raised (fail-open): ' + (e && e.message) });
  }
  return out;
}

// wakeMonitorLiveCheck(watcherMod, watcherPath, home, env, cwd) -> {status, message}.
// READ-ONLY lock inspection — mirrors devswarm-pull.js's acquireExclLock
// holder/isAlive semantics exactly (same pid-liveness test), but NEVER
// acquires, steals, or deletes the lock; it only reads the file that is
// already there, if any.
function wakeMonitorLiveCheck(watcherMod, watcherPath, home, env, cwd) {
  const armCmd = 'call the `Monitor` tool with command `node ' + watcherPath + '`, `persistent: true`'
    + ' (or run that command yourself in a background terminal)';
  let identity = null;
  try { identity = watcherMod.resolveIdentity(env, cwd, {}); } catch (_) { identity = null; }
  if (!identity) {
    return { status: WARN, message: 'wake-monitor: could not resolve a DevSwarm identity for ' + cwd + ' — live-check skipped. Manual arm: ' + armCmd + '.' };
  }
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(watcherMod.lockPathFor(home, identity.id), 'utf8')); } catch (_) { holder = null; }
  const pid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
  let alive = false;
  if (pid !== null) {
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
  }
  if (alive) {
    return { status: PASS, message: 'wake-monitor: LIVE for ' + identity.role + ' ' + identity.id + ' (pid ' + pid + ')' };
  }
  return { status: WARN, message: 'wake-monitor: shipped but NOT live for ' + identity.role + ' ' + identity.id + ' — arm it: ' + armCmd + '.' };
}

// wakeMonitorChecks(home, env, cwd) -> [{status, message}]. shipped -> proven
// (self-test) -> live (read-only lock inspection), each gated on the previous
// step actually succeeding (no self-test against a watcher that failed to
// load; no live-check without a watcherMod to call resolveIdentity on).
function wakeMonitorChecks(home, env, cwd) {
  const out = [];
  const shipped = wakeMonitorShipped(PLUGIN_ROOT);
  if (!shipped.shipped) {
    out.push({ status: FAIL, message: 'wake-monitor: NOT shipped — ' + shipped.reason + ' (cron fallback is unaffected)' });
    return out;
  }
  out.push({ status: PASS, message: 'wake-monitor: shipped (watcher script + devswarm-wake.js Monitor-arm emission both present)' });
  out.push(...wakeMonitorSelfTest(shipped.watcherMod));
  out.push(wakeMonitorLiveCheck(shipped.watcherMod, shipped.watcherPath, home, env, cwd));
  return out;
}

function runChecks(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();

  const descriptors = readDescriptors(home, F);
  const active = isDevswarmActive(env) || descriptors.length > 0;
  if (!active) return { active: false, results: [] };

  const results = selfTest(home, F);
  results.push(...wakeMonitorChecks(home, env, cwd));

  // Descriptor-store integrity (companion/lib/doctor-descriptors.js): a
  // REPORT-ONLY scan for malformed ids and for archived ids that strict-prefix a
  // live one (the phantom-roster-row signature). It lives in its own module
  // because it reads descriptors RAW — including the malformed ones
  // readDescriptors() above deliberately filters out, which is precisely why
  // nothing caught this before. Fail-open: a raising scan never breaks doctor,
  // and it never mutates the store.
  try {
    for (const r of descriptorChecks({ home, fsi: F })) results.push(r);
  } catch (e) {
    results.push({ status: WARN, message: 'descriptor integrity scan unavailable: ' + (e && e.message) });
  }

  // Per-real-workspace readout from persisted verdicts, plus a distinct
  // listener-presence line (evidence something is consuming the inbox — see
  // listenerPresenceFor above) so a combined-verdict PASS can't hide a wedged
  // consumer that just hasn't been swept as stale yet.
  for (const d of descriptors) {
    let verdict = null;
    try { verdict = JSON.parse(F.readFileSync(livenessPathFor(d.id, home), 'utf8')); } catch (_) {}
    if (!verdict) {
      results.push({ status: WARN, message: 'workspace ' + d.id + ': no liveness verdict yet (sweep has not run)' });
    } else {
      const status = statusForVerdict(verdict);
      results.push({
        status,
        message: 'workspace ' + d.id + ': ' + verdict.status + ' (nudgeAttempts=' + (verdict.nudgeAttempts || 0) + ')',
      });
    }
    try {
      results.push(listenerPresenceFor(d, now, F));
    } catch (e) {
      results.push({ status: WARN, message: 'workspace ' + d.id + ' listener: state unknown (check raised: ' + (e && e.message) + ')' });
    }
  }
  return { active: true, results };
}

module.exports = {
  PASS, WARN, FAIL, statusFor, statusForVerdict, listenerPresenceFor, runChecks,
  // wake-monitor (Monitor-based idle-wake) — exported individually for tests.
  wakeMonitorShipped, wakeMonitorSelfTest, wakeMonitorLiveCheck, wakeMonitorChecks,
};
