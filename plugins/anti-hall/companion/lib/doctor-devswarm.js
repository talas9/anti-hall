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

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';
const SELFTEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DEFAULT_STUCK_MS = 30 * 60 * 1000; // recovering longer than this = stuck -> FAIL (needs a human)
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

// statusFor(verdictStatus) -> PASS | WARN | FAIL (base mapping, no stuck logic).
function statusFor(s) {
  if (s === 'alive') return PASS;
  if (s === 'stale' || s === 'recovering') return WARN;
  return FAIL; // ambiguous | escalated | anything unexpected
}

// statusForVerdict(verdict, now, stuckMs) -> PASS | WARN | FAIL. Adds the P0-3
// stuck-recovering escalation: a `recovering` verdict that has not cleared within
// stuckMs (or has no recoveredAt at all) FAILs so a human is told, rather than
// sitting as a soft WARN forever.
function statusForVerdict(verdict, now, stuckMs) {
  const s = verdict && verdict.status;
  if (s === 'alive') return PASS;
  if (s === 'stale') return WARN;
  if (s === 'recovering') {
    const recoveredAt = verdict && Number.isFinite(verdict.recoveredAt) ? verdict.recoveredAt : null;
    if (recoveredAt === null) return FAIL;                 // recovering with no recovery ts = stuck
    return (now - recoveredAt) > stuckMs ? FAIL : WARN;    // stuck past the window -> FAIL
  }
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

function runChecks(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const stuckMs = Number.isFinite(o.stuckMs) ? o.stuckMs : DEFAULT_STUCK_MS;

  const descriptors = readDescriptors(home, F);
  const active = isDevswarmActive(env) || descriptors.length > 0;
  if (!active) return { active: false, results: [] };

  const results = selfTest(home, F);

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
      const status = statusForVerdict(verdict, now, stuckMs);
      const stuckNote = (status === FAIL && verdict.status === 'recovering') ? ' [STUCK — needs a human]' : '';
      results.push({
        status,
        message: 'workspace ' + d.id + ': ' + verdict.status + ' (recoveries=' + (verdict.recoveries || 0) + ')' + stuckNote,
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

module.exports = { PASS, WARN, FAIL, DEFAULT_STUCK_MS, statusFor, statusForVerdict, listenerPresenceFor, runChecks };
