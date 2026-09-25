'use strict';
// anti-hall :: primary-seat — who holds this worktree's Primary seat (v0.108.0).
//
// The Primary seat is the anchor row `primary-<sha256(worktree)[0:8]>` plus the
// sessionId it records. A /clear or an app restart replaces the session; the
// seat must follow it without ever minting a second identity, and two live
// sessions must never both send as the Primary.
//
// seatVerdict() is READ-ONLY. State:
//   'n/a'      not the Primary checkout (child worktree, non-git) — nothing to do
//   'none'     Primary checkout, but no anchor registered yet
//   'own'      the anchor already records this session
//   'adopt'    the recorded session is CLOSED -> this session may adopt the seat
//   'conflict' the recorded session is LIVE -> warn; mesh send/ack/spawn refused
//              until `devswarm.js primary takeover`
//   'unknown'  liveness cannot be established -> warn, never adopt
//
// Liveness of the recorded session, strongest evidence first:
//   1. the harness session file (<home>/.claude/sessions/*.json) naming it with a
//      LIVE pid -> live; naming it with a dead pid -> closed;
//   2. no file names it while the sessions dir is readable -> closed (the harness
//      removes a session's file when its process exits; stale leftovers are
//      caught by the pid check above);
//   3. sessions dir unreadable: the DevSwarm app's active terminal for the
//      Primary builder is THIS session -> closed; else the anchor's heartbeat
//      is older than SEAT_HEARTBEAT_STALE_MS -> closed; else unknown.
// Never throws. Pure Node built-ins.

const fs = require('fs');
const path = require('path');

const SEAT_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const HANDOVER_FILE_RE = /^HANDOVER(?:-(\d+))?\.md$/;

function realOr(p) { try { return fs.realpathSync(p); } catch (_) { return p; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function devswarmRoot(home) { return path.join(String(home), '.anti-hall', 'devswarm'); }

// primaryCheckout({ home, env, cwd }) -> { worktree, id, builderId } | null.
function primaryCheckout(o) {
  const identity = require('./identity.js');
  const ctx = identity.resolveContext(o.cwd || process.cwd(), { memo: false, missingPath: 'ancestor' });
  if (!ctx.worktreeRoot) return null;
  let b = null;
  try { b = require('./devswarm-app-db.js').builderForWorktree({ home: o.home, env: o.env, worktreePath: ctx.worktreeRoot }); } catch (_) { b = null; }
  const bt = b && b.builderType ? String(b.builderType).trim() : ''; // whitespace-only = unknown -> main-checkout rule
  const isPrimary = bt ? bt === 'primary' : realOr(ctx.mainWorktree) === ctx.worktreeRoot;
  if (!isPrimary) return null;
  return { worktree: ctx.worktreeRoot, id: identity.meshIdForRealPath(ctx.worktreeRoot), builderId: b ? b.id : null };
}

// holderLiveness(sessionId, { home, env, builderId, currentSessionId, id, now }) -> { live: true|false|null, evidence }
function holderLiveness(sid, o) {
  const liveness = require('./liveness.js');
  const evidence = {};
  const pid = liveness.sessionPidAlive(sid, o.home);
  evidence.sessionFile = pid;
  if (pid === true) return { live: true, evidence };
  if (pid === false) return { live: false, evidence };
  let dirReadable = false;
  try { fs.readdirSync(liveness.sessionsDirFor(o.home)); dirReadable = true; } catch (_) { dirReadable = false; }
  evidence.sessionsDir = dirReadable;
  if (dirReadable) return { live: false, evidence };
  let terms = null;
  try { terms = o.builderId ? require('./devswarm-app-db.js').activeTerminalSessions({ home: o.home, env: o.env, builderId: o.builderId }) : null; } catch (_) { terms = null; }
  evidence.appTerminals = terms;
  if (terms && o.currentSessionId && terms.includes(String(o.currentSessionId)) && !terms.includes(String(sid))) return { live: false, evidence };
  const hb = readJson(path.join(devswarmRoot(o.home), 'heartbeats', o.id + '.json'));
  const age = hb && Number.isFinite(hb.ts) ? (o.now - hb.ts) : null;
  evidence.heartbeatAgeMs = age;
  if (age != null && age > SEAT_HEARTBEAT_STALE_MS) return { live: false, evidence };
  return { live: null, evidence };
}

// newestWorktreeHandover(worktree) -> { path, sessionId, mtimeMs } | null — the
// newest HANDOVER*.md under <worktree>/.anti-hall/handovers/<date>/<session>/,
// ACROSS sessions (not only the current one).
function newestWorktreeHandover(worktree) {
  const root = path.join(String(worktree), '.anti-hall', 'handovers');
  let best = null;
  const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) { return []; } };
  for (const date of dirs(root)) {
    for (const sid of dirs(path.join(root, date))) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, date, sid)); } catch (_) { files = []; }
      for (const f of files) {
        if (!HANDOVER_FILE_RE.test(f)) continue;
        const p = path.join(root, date, sid, f);
        let st;
        try { st = fs.statSync(p); } catch (_) { continue; }
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, sessionId: sid, mtimeMs: st.mtimeMs };
      }
    }
  }
  return best;
}

// staleResume({ worktree, home, currentSessionId, handover }) -> { sessionId, activeUntilMs } | null.
// The current session was RESUMED stale when another session on this worktree
// started after it (its /clear successor, say) or wrote a newer handover.
function staleResume(o) {
  const cur = o.currentSessionId ? String(o.currentSessionId) : '';
  if (!cur) return null;
  const drift = require('./primary-session-drift.js');
  const list = drift.sessionsForWorktree(o.worktree, { home: o.home });
  const mine = list.find((x) => x.sessionId === cur);
  let best = null;
  for (const x of list) {
    if (x.sessionId === cur || !mine || !(x.startMs > mine.startMs)) continue;
    let until = x.startMs;
    try { until = fs.statSync(path.join(drift.projectDirFor(o.worktree, o.home), x.sessionId + '.jsonl')).mtimeMs; } catch (_) { /* start */ }
    if (!best || until > best.activeUntilMs) best = { sessionId: x.sessionId, activeUntilMs: until };
  }
  const h = o.handover;
  if (h && h.sessionId !== cur && (!best || h.mtimeMs > best.activeUntilMs)) {
    const myStart = mine ? mine.startMs : null;
    if (myStart == null || h.mtimeMs > myStart) best = { sessionId: h.sessionId, activeUntilMs: h.mtimeMs };
  }
  return best;
}

// seatVerdict({ home, env, cwd, sessionId, now, light }) -> verdict (see header).
function seatVerdict(opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  try {
    if (!o.home) return { state: 'n/a' };
    const pc = primaryCheckout(o);
    if (!pc) return { state: 'n/a' };
    const cur = o.sessionId ? String(o.sessionId) : '';
    const desc = readJson(path.join(devswarmRoot(o.home), 'workspaces', pc.id + '.json'));
    const holder = desc && desc.sessionId && !String(desc.sessionId).startsWith('unclaimed:') ? String(desc.sessionId) : '';
    // light: the per-verb guard needs only the holder verdict — skip the
    // handover and transcript scans (SessionStart pays for those once).
    const handover = o.light ? null : newestWorktreeHandover(pc.worktree);
    const stale = o.light ? null : staleResume({ worktree: pc.worktree, home: o.home, currentSessionId: cur, handover });
    const base = { id: pc.id, worktree: pc.worktree, holder: holder || null, handover, stale };
    if (!desc) return Object.assign({ state: 'none' }, base);
    if (!cur) return Object.assign({ state: 'unknown', reason: 'no-current-session' }, base);
    if (!holder || holder === cur) return Object.assign({ state: holder ? 'own' : 'adopt' }, base);
    const lv = holderLiveness(holder, { home: o.home, env: o.env, builderId: pc.builderId, currentSessionId: cur, id: pc.id, now });
    const state = lv.live === true ? 'conflict' : (lv.live === false ? 'adopt' : 'unknown');
    return Object.assign({ state, evidence: lv.evidence }, base);
  } catch (_) { return { state: 'n/a' }; }
}

function iso(ms) { try { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch (_) { return String(ms); } }

function conflictText(v, cli) {
  return '⚠ DEVSWARM PRIMARY SEAT CONFLICT: Another live Primary session ' + v.holder + ' owns this worktree'
    + ' — continue here (it will be demoted) or switch to it? (Primary id ' + v.id + '.) To continue here run `node ' + cli
    + ' primary takeover`; to switch, close this session and use ' + v.holder + '. Until you choose, mesh '
    + 'send/ack/spawn from this session are refused. Never two sessions sending as the same Primary.';
}

// seatNotices(v, { cli, adopted }) -> string[] (the injected lines).
function seatNotices(v, o) {
  const out = [];
  const cli = (o && o.cli) || 'scripts/devswarm.js';
  if (!v || v.state === 'n/a') return out;
  if (o && o.adopted) {
    out.push('DEVSWARM PRIMARY SEAT: adopted Primary ' + v.id + ' from ' + (v.holder || 'an unclaimed anchor')
      + ' (closed) — same identity, partitions and cursors; handover ' + (v.handover ? v.handover.path : '(none found for this worktree)')
      + (v.handover ? ' — read it first.' : '.'));
  } else if (v.state === 'conflict') {
    out.push(conflictText(v, cli));
  } else if (v.state === 'unknown') {
    out.push('⚠ DEVSWARM PRIMARY SEAT: could not verify whether session ' + (v.holder || '?') + ' (the recorded Primary) '
      + 'is still running — NOT adopting. If it is closed, run `node ' + cli + ' primary takeover`.');
  }
  if (v.stale) {
    out.push('DEVSWARM PRIMARY SEAT: you resumed ' + (o && o.currentSessionId ? o.currentSessionId : 'this session') + ' but '
      + v.stale.sessionId + ' was active until ' + iso(v.stale.activeUntilMs)
      + (v.handover ? '; newest handover for this worktree: ' + v.handover.path : '')
      + '. A `primary-<hash>` sender label is a worktree id, not proof of another Primary — never stand down on a label alone.');
  }
  return out;
}

module.exports = { seatVerdict, seatNotices, conflictText, newestWorktreeHandover, staleResume, holderLiveness, primaryCheckout, SEAT_HEARTBEAT_STALE_MS };
