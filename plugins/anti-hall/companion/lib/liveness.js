'use strict';
// anti-hall :: liveness — outbound-staleness detector + atomic verdict writer.
// Workaround for claude-code#39755.
//
// STALE only when BOTH outbound signals (the target session's OWN transcript
// mtime AND git/worktree activity) are PRESENT and each idle past the threshold,
// AND the workspace has a pending unread backlog past its cursor. A workspace idle
// because it has nothing to do is NOT stale. Fail direction = NOT stale (never
// nominate a healthy workspace for a kill). Liveness is uuid-SCOPED: only
// <sessionId>.jsonl is stat'd, so a busy colliding sibling session in the shared
// encoded dir cannot mask staleness.
//
// HEARTBEAT = definitive proof-of-life (v0.62, owner-approved — supersedes the
// prior "inbound heartbeat deliberately NOT used" guard). A heartbeat is emitted
// ONLY by the workspace's OWN live session (scripts/devswarm.js cmdHeartbeat
// writes heartbeats/<id>.json); an archived/frozen/dead env emits NOTHING, so a
// FRESH heartbeat (within heartbeatFreshMs) is definitive proof the env is ALIVE.
// The two axes are DECOUPLED: "env alive" (a heartbeat proves it) vs "agent making
// progress" (the outbound-idle + backlog signal below). A fresh heartbeat CLEARS
// the stale/nudged/escalated verdict for coordination + archive purposes and
// short-circuits BEFORE any recompute (see computeLiveness). No-progress detection
// remains a SEPARATE, non-archiving signal — it is expressed ONLY as the `stale`
// verdict here and NEVER fires while a fresh heartbeat is present, so a heartbeating
// workspace can never be force-archived or nudged-as-gone. The old fear (a wedged
// agent emits heartbeats without real work) is handled by keeping no-progress a
// distinct, advisory signal, not by ignoring the heartbeat's liveness proof.
//
// `escalated` is terminal (short-circuited). `nudged` is a HOLD state entered by
// the automatic path's poke (recovery.js's pokeOrEscalate — never a kill): while
// nudgeWindowMs hasn't elapsed since nudgedAt, stay `nudged` unless the outbound
// signal has advanced past nudgedAt (the poke worked -> clear to `alive`); once
// the window elapses with no advance, stop holding and fall through to a fresh
// recompute so pokeOrEscalate can decide (another poke, or escalate). Verdict
// status enum: alive | stale | nudged | ambiguous | escalated.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectDirFor } = require('./target-session.js');

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_NUDGE_WINDOW_MS = 3 * 60 * 1000; // how long a poke stays "in effect" before falling through
// DEFAULT_HEARTBEAT_FRESH_MS — how recently a heartbeat must have been recorded to
// count as PROOF the env is alive. Matched to DEFAULT_IDLE_MS (15 min) so the
// "fresh heartbeat" window aligns with the same idle horizon the staleness detector
// uses: a session that heartbeats at least once per idle window is provably alive.
const DEFAULT_HEARTBEAT_FRESH_MS = DEFAULT_IDLE_MS;
const GIT_TIMEOUT_MS = 4000;

// DEFAULT_DORMANT_MS — the READ-SIDE liveness window: how long a workspace may go
// with NO activity signal at all before the roster/injection stops calling it
// active. 30 min = 2x DEFAULT_HEARTBEAT_FRESH_MS (15 min). The margin that makes
// this safe for a live-but-quiet child is NOT the mailbox-wake cron (that cron
// only fires while a session is IDLE between turns; it contributes nothing during
// a long autonomous turn and cannot be relied on to keep the heartbeat fresh). The
// real margin comes from the TRANSCRIPT signal in readActivityTs below: a live
// session appends to its transcript on EVERY tool call, not once per turn, so it
// keeps refreshing continuously even deep inside one long multi-round turn. 30
// minutes of total silence across BOTH heartbeat and transcript means the session
// is not running at all.
//
// WHY A READ-SIDE WINDOW AT ALL: a mesh/registry row OUTLIVES its workspace. When
// a workspace is closed in the DevSwarm app its registry row, its worktree, its
// workspaces/<id>.json descriptor and its `hivecontrol workspace list` entry ALL
// survive — closing is not deleting. Measured on four real workspaces (one live,
// three closed), every other candidate signal was identical across live and dead:
// descriptor presence, archived/<id>.json presence, registry updated_at (a
// reconcile sweep bumps every row), the persisted liveness verdict (all four read
// `alive`), and isLiveSessionId (a pure `unclaimed:` prefix test that is true for
// any surviving row). ONLY the heartbeat's own age separated them — because
// heartbeats/<id>.json is rewritten ONLY by that workspace's own live session.
//
// Override via ANTIHALL_DEVSWARM_DORMANT_MS (ms, not seconds).
const DEFAULT_DORMANT_MS = 30 * 60 * 1000;

// DEFAULT_ROSTER_IDLE_MS / idleThresholdMs — the WIDE read-side fallback window,
// moved here from hooks/lib/devswarm-freshness.js (that module requires this
// file, so this file cannot require it back without a cycle; devswarm-
// freshness.js now re-exports these two so its existing consumers are
// unaffected). This is the window isDormantRow falls back to when the
// transcript term did NOT contribute (see isDormantRow below): most workspace
// descriptors never record a real Claude sessionId (scripts/devswarm.js's
// cmdInboxPull resolves session as `--session || DEVSWARM_BUILDER_ID ||
// 'unclaimed:'+id` — none of those are a Claude session id; only
// hooks/devswarm-child-turn.js stamps a real one), so for most rows the ONLY
// surviving signal is the heartbeat, written once per USER TURN — a tight
// window there would misread a live child mid-long-turn as dead. 6 hours is a
// defensible wide default: long enough that a normal lull between turns/
// sessions never false-positives, short enough that a workspace idle since
// yesterday still reads as idle/dormant today. Override via
// ANTIHALL_DEVSWARM_IDLE_MS (ms, not seconds). NOT the same constant as this
// file's own DEFAULT_IDLE_MS (15 min, computeLiveness's outbound-staleness
// idle default, an unrelated axis) — kept under a distinct name to avoid
// silently colliding with it.
const DEFAULT_ROSTER_IDLE_MS = 6 * 60 * 60 * 1000;

// isSafeId(id) -> bool. A descriptor id must be a single safe path segment before
// it is ever path.join'd into locks/liveness/recovery paths (P1-7): no separators,
// no traversal, no control chars/whitespace, not empty, not '.'/'..'.
function isSafeId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

function devswarmRoot(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'devswarm');
}
function livenessPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'liveness', String(id) + '.json');
}
// heartbeatPathFor(id, home) — the durable heartbeat file scripts/devswarm.js
// cmdHeartbeat writes (heartbeats/<id>.json). SAME id-safety gate as
// livenessPathFor (never path.join an unsafe id).
function heartbeatPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'heartbeats', String(id) + '.json');
}
// heartbeatTs(id, home, fsi) -> ms | null. The recorded `ts` from
// heartbeats/<id>.json (cmdHeartbeat writes `ts: now`), falling back to the
// file's mtime if the JSON is torn/missing the field. null when absent /
// unreadable / unsafe id. Pure fs, never throws.
function heartbeatTs(id, home, fsi) {
  const F = fsi || fs;
  let p;
  try { p = heartbeatPathFor(id, home); } catch (_) { return null; }
  try {
    const beat = JSON.parse(F.readFileSync(p, 'utf8'));
    if (beat && Number.isFinite(beat.ts)) return beat.ts;
  } catch (_) { /* torn/absent JSON -> fall back to mtime */ }
  try { return F.statSync(p).mtimeMs; } catch (_) { return null; }
}
// isFreshBeat(ts, now, freshMs) -> bool. The ONE freshness rule, shared by
// hasFreshHeartbeat and computeLiveness's heartbeat short-circuit so both agree.
// P1-7: require `0 < ts <= now` BEFORE applying the window — a FUTURE ts (clock
// skew, a forged/typo'd beat) makes `now - ts` NEGATIVE, which trivially passes
// `<= freshMs` and would mark the workspace "provably alive" until that future
// time, indefinitely suppressing the stale gate + reaper. A future or non-positive
// ts is NOT fresh (treated as no proof-of-life at all).
function isFreshBeat(ts, now, freshMs) {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return false;
  if (ts > now) return false; // future ts is not proof of present life
  return (now - ts) <= freshMs;
}

// dormantThresholdMs(env) -> ms. ANTIHALL_DEVSWARM_DORMANT_MS off the given env
// (process.env when omitted); absent / non-numeric / non-positive ->
// DEFAULT_DORMANT_MS. Never throws.
//
// P2-a: uses Number(), NOT parseInt. parseInt STOPS at the first non-digit
// character instead of rejecting the whole value, so `"30min"` silently
// parsed as `30` (a 30-MILLISECOND threshold — every workspace instantly
// dormant) and `"1e6"` (a legitimate exponential form) parsed as `1`, not
// 1000000. Number() parses (or rejects) the WHOLE trimmed string.
function dormantThresholdMs(env) {
  const src = env || process.env;
  const raw = src && src.ANTIHALL_DEVSWARM_DORMANT_MS;
  const n = Number(String(raw == null ? '' : raw).trim());
  return (Number.isFinite(n) && n > 0) ? n : DEFAULT_DORMANT_MS;
}

// idleThresholdMs(env) -> ms. ANTIHALL_DEVSWARM_IDLE_MS off the given env
// (process.env when omitted); absent / non-numeric / non-positive ->
// DEFAULT_ROSTER_IDLE_MS. Moved here from devswarm-freshness.js (see
// DEFAULT_ROSTER_IDLE_MS above); same Number()-based parsing as
// dormantThresholdMs, for the same reason (P2-a applies identically here —
// this reader is now load-bearing as isDormantRow's fallback window, not
// merely a display-label threshold).
function idleThresholdMs(env) {
  const src = env || process.env;
  const raw = src && src.ANTIHALL_DEVSWARM_IDLE_MS;
  const n = Number(String(raw == null ? '' : raw).trim());
  return (Number.isFinite(n) && n > 0) ? n : DEFAULT_ROSTER_IDLE_MS;
}

// isDormantActivity(activityTs, now, env, opts) -> bool. TRUE only on POSITIVE
// evidence that a workspace's session has stopped transacting: a KNOWN
// activity timestamp that is at least the threshold old.
//
// opts.thresholdMs — when a FINITE value > 0 is supplied, it WINS over the env
// lookup (isDormantRow uses this to pick between the tight dormant window and
// the wide idle window per-row, without duplicating this comparison logic).
// Absent/non-finite/non-positive -> falls back to dormantThresholdMs(env), the
// original behaviour, unchanged.
//
// FAIL-OPEN BY CONSTRUCTION — every uncertain input returns FALSE (not dormant),
// so an unknown-liveness row is always still surfaced:
//   * activityTs null / non-finite (no heartbeat and no verdict ever written —
//     a brand-new or pre-upgrade workspace) -> false. ABSENCE OF A SIGNAL IS NOT
//     EVIDENCE OF DEATH; this is what keeps the filter from blinding a live row.
//   * a non-finite `now` -> false.
//   * activityTs <= 0 -> false (a zeroed/garbage stamp is not evidence).
//   * a FUTURE activityTs (clock skew) -> false, mirroring isFreshBeat's refusal
//     to trust a future stamp in either direction.
function isDormantActivity(activityTs, now, env, opts) {
  if (!Number.isFinite(activityTs) || activityTs <= 0) return false;
  if (!Number.isFinite(now)) return false;
  const age = now - activityTs;
  if (age < 0) return false; // future stamp -> not evidence of anything
  const o = opts || {};
  const threshold = (Number.isFinite(o.thresholdMs) && o.thresholdMs > 0) ? o.thresholdMs : dormantThresholdMs(env);
  return age >= threshold;
}

// readActivityTs(row, home, opts) -> { ts, sawTranscript }. The newest activity
// signal a READER can observe for a workspace, without git and without spawning
// anything:
//   1. heartbeats/<id>.json ts      — written once per USER TURN by the child's
//                                     UserPromptSubmit hook.
//   2. the session TRANSCRIPT mtime — <projectDir>/<sessionId>.jsonl, appended
//                                     continuously by a live session (every tool
//                                     call, not once per turn). This is what makes
//                                     a live child mid-long-turn observably alive:
//                                     turn-scoped heartbeats alone go quiet for the
//                                     whole of a long autonomous turn.
//   3. the liveness verdict's lastOutboundTs — only refreshed when the OPTIONAL
//                                     supervisor companion is installed, so it is a
//                                     bonus signal, never a dependency.
// `ts` is the NEWEST of whatever is available (ms, or null when nothing is
// available) — unchanged from before this shape change. Every input
// independently degrades to 0/null, so a missing one can only make the row
// look LESS alive than it is.
//
// `sawTranscript` is true ONLY when the transcript statSync above actually
// produced a finite mtime for THIS row's own <sessionId>.jsonl. WHY THE CALLER
// NEEDS THIS: measured on this machine, only ~7/26 workspace descriptors carry
// a real Claude sessionId at all (scripts/devswarm.js's cmdInboxPull resolves
// session as `--session || DEVSWARM_BUILDER_ID || 'unclaimed:'+id` — none of
// those are a Claude session id; only hooks/devswarm-child-turn.js stamps a
// real one), and only ~5/26 of those resolve to an on-disk transcript file.
// For the rest, the transcript term above NEVER contributes, and the only
// surviving signal is the heartbeat — written once per USER TURN. A tight
// dormancy window applied to a heartbeat-only signal would misread a live
// child deep in one long autonomous turn as dead, because nothing refreshes
// between heartbeats mid-turn. The caller (isDormantRow) uses `sawTranscript`
// to WIDEN its window whenever the transcript term did not contribute, rather
// than applying the same tight window uniformly regardless of which evidence
// is actually available.
//
// Pure fs reads (readFileSync + statSync). Never throws.
function readActivityTs(row, home, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  const id = row && row.id != null ? String(row.id) : null;
  if (!id) return { ts: null, sawTranscript: false };
  let best = 0;
  let sawTranscript = false;
  try {
    if (Number.isFinite(o.heartbeatTs)) {
      // P2-b: caller already read+parsed the heartbeat file (e.g.
      // devswarm-parent-inbox.js's freshness.readHeartbeat) — skip the
      // redundant internal re-read of the same file this turn.
      if (o.heartbeatTs > best) best = o.heartbeatTs;
    } else {
      const t = heartbeatTs(id, home, F);
      if (Number.isFinite(t) && t > best) best = t;
    }
  } catch (_) {}
  try {
    if (row.sessionId && row.worktreePath) {
      const t = transcriptMtime(projectDirFor(row.worktreePath, home), String(row.sessionId), F);
      if (Number.isFinite(t)) {
        sawTranscript = true;
        if (t > best) best = t;
      }
    }
  } catch (_) {}
  try {
    if (Number.isFinite(o.lastOutboundTs) && o.lastOutboundTs > best) best = o.lastOutboundTs;
  } catch (_) {}
  return { ts: best > 0 ? best : null, sawTranscript };
}

// isDormantRow(row, home, opts) -> bool. THE ONE read-side dormancy rule —
// composes readActivityTs + isDormantActivity so the hook's per-turn table and
// scripts/devswarm.js's rosterHints can never drift apart on the same row.
//
// Picks the window from the EVIDENCE actually available (readActivityTs's
// `sawTranscript`):
//   * transcript term contributed -> the TIGHT dormantThresholdMs window. A
//     live session appends to its transcript on every tool call, so real
//     silence across BOTH heartbeat AND transcript is strong evidence the
//     session has ended.
//   * transcript did NOT resolve (no sessionId on the row, or no .jsonl on
//     disk — the common case, since most descriptors never record a Claude
//     session id) -> fall back to the WIDE idleThresholdMs window. The only
//     surviving signal is the heartbeat, written once per USER TURN, so a
//     tight window there would misread a live child in one long autonomous
//     turn as dead.
// Fail-open in both directions: no signal at all -> never dormant (isDormantActivity's own guarantee).
//
// opts: { now, env, fs, lastOutboundTs, heartbeatTs } — all forwarded to
// readActivityTs / isDormantActivity as appropriate. `now` defaults to
// Date.now(); `env` defaults to process.env.
function isDormantRow(row, home, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const env = o.env || process.env;
  const readOpts = {};
  if (o.fs) readOpts.fs = o.fs;
  if (Number.isFinite(o.lastOutboundTs)) readOpts.lastOutboundTs = o.lastOutboundTs;
  if (Number.isFinite(o.heartbeatTs)) readOpts.heartbeatTs = o.heartbeatTs;
  let ts = null;
  let sawTranscript = false;
  try {
    const r = readActivityTs(row, home, readOpts);
    ts = r && Number.isFinite(r.ts) ? r.ts : null;
    sawTranscript = !!(r && r.sawTranscript);
  } catch (_) { ts = null; sawTranscript = false; }
  const thresholdMs = sawTranscript ? dormantThresholdMs(env) : idleThresholdMs(env);
  return isDormantActivity(ts, now, env, { thresholdMs });
}

// hasFreshHeartbeat(id, home, opts) -> bool. True iff a heartbeat for `id` was
// recorded within `freshMs` of `now`. Definitive proof-of-life: a heartbeat is
// emitted ONLY by the workspace's own live session, so a fresh one means the env
// is ALIVE (see the header's HEARTBEAT decouple note). opts: { now, freshMs, fs }.
function hasFreshHeartbeat(id, home, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const freshMs = Number.isFinite(o.freshMs) ? o.freshMs : DEFAULT_HEARTBEAT_FRESH_MS;
  const ts = heartbeatTs(id, home, o.fs);
  return isFreshBeat(ts, now, freshMs);
}

// transcriptMtime(projectDir, sessionId, fsi) -> ms | null. uuid-SCOPED: stats
// ONLY the target session's own <sessionId>.jsonl (P1-6). A colliding sibling's
// fresh transcript in the same dir must NOT mask this session's staleness.
function transcriptMtime(projectDir, sessionId, fsi) {
  const F = fsi || fs;
  if (!sessionId) return null;
  try {
    return F.statSync(path.join(projectDir, sessionId + '.jsonl')).mtimeMs;
  } catch (_) {
    return null;
  }
}

// worktreeActivityMtime(worktreePath, runners) -> ms | null. The git-commit time
// (git log -1 --format=%ct, seconds->ms), or null (UNKNOWN) when there is no
// reliable git signal — no commits yet (plausible right when a task starts) or git
// unavailable / detached .git. It NEVER falls back to a worktree DIRECTORY mtime
// (P1-15): editing a file NESTED under the worktree does NOT bump the dir mtime, so
// a dir-mtime reading is near-permanently 'idle' and would collapse the two-signal
// anti-false-positive safeguard to transcript-only. A null activity signal makes
// computeLiveness treat the workspace as NOT conclusively stale (fail-safe toward
// alive), which is the correct direction — better to miss a wedge than to
// manufacture a false idle reading and wrong-kill.
function worktreeActivityMtime(worktreePath, runners) {
  const R = runners || {};
  try {
    const ct = R.gitCommitTs ? R.gitCommitTs(worktreePath) : defaultGitCommitTs(worktreePath);
    if (Number.isFinite(ct) && ct > 0) return ct;
  } catch (_) {}
  return null; // no reliable git activity signal -> UNKNOWN (never a dir-mtime fallback)
}

function defaultGitCommitTs(worktreePath) {
  const r = spawnSync('git', ['-C', worktreePath, 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0 || r.signal) return null; // r.signal set when killed on timeout
  const secs = parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

// unreadBacklog(inboxPath, cursorPath, fsi) -> { lines: string[], known: boolean }.
// inboxPath = NDJSON append-only (one message/line). cursorPath = a bare integer
// OR JSON {line:<int>} = count of consumed lines. Unparseable/absent cursor =>
// known:false (treated as NOT pending — fail-safe: never nominate an unreadable
// workspace for a kill).
function unreadBacklog(inboxPath, cursorPath, fsi) {
  const F = fsi || fs;
  let all;
  try {
    all = String(F.readFileSync(inboxPath, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch (_) {
    return { lines: [], known: false };
  }
  let cursor;
  try {
    const raw = String(F.readFileSync(cursorPath, 'utf8')).trim();
    if (/^\d+$/.test(raw)) cursor = parseInt(raw, 10);
    else cursor = Number(JSON.parse(raw).line);
  } catch (_) {
    return { lines: [], known: false };
  }
  if (!Number.isFinite(cursor) || cursor < 0) return { lines: [], known: false };
  return { lines: all.slice(cursor), known: true };
}

// computeLiveness(opts) ->
//   { status, lastOutboundTs, staleSince, nudgeAttempts, nudgedAt, pending }.
function computeLiveness(opts) {
  const descriptor = opts.descriptor;
  const now = opts.now || Date.now();
  const idle = Number.isFinite(opts.idleThresholdMs) ? opts.idleThresholdMs : DEFAULT_IDLE_MS;
  const nudgeWindowMs = Number.isFinite(opts.nudgeWindowMs) ? opts.nudgeWindowMs : DEFAULT_NUDGE_WINDOW_MS;
  const heartbeatFreshMs = Number.isFinite(opts.heartbeatFreshMs) ? opts.heartbeatFreshMs : DEFAULT_HEARTBEAT_FRESH_MS;
  const home = opts.home || os.homedir();
  const runners = opts.runners || {};
  const fsi = runners.fs || fs;

  // Prior verdict (persisted across sweeps) — read FIRST so the terminal + nudge
  // short-circuits can skip all recomputation.
  let prev = null;
  try { prev = JSON.parse(fsi.readFileSync(livenessPathFor(descriptor.id, home), 'utf8')); } catch (_) {}
  const nudgeAttempts = (prev && Number.isFinite(prev.nudgeAttempts)) ? prev.nudgeAttempts : 0;
  const nudgedAt = (prev && Number.isFinite(prev.nudgedAt)) ? prev.nudgedAt : null;
  const priorStaleSince = (prev && Number.isFinite(prev.staleSince)) ? prev.staleSince : null;
  const priorOutbound = (prev && Number.isFinite(prev.lastOutboundTs)) ? prev.lastOutboundTs : null;

  // HEARTBEAT proof-of-life short-circuit (v0.62 decouple — see header). A FRESH
  // heartbeat is definitive proof the env is ALIVE, so it CLEARS the verdict to
  // `alive` and resets the nudge/stale state — even a sticky `escalated`, because a
  // heartbeating env is by definition not the abandoned/wedged case escalation
  // exists for. This is checked BEFORE the escalated short-circuit so a heartbeat
  // that arrives after escalation still recovers the workspace. lastOutboundTs is
  // set to the heartbeat ts (the session's own emission IS outbound activity), so
  // no git spawn is needed on this path. `pending` is the cheap fs backlog read
  // (no git) — a heartbeating workspace with real unread is still alive, and the
  // unread is surfaced (coordination axis) without ever being nudged-as-gone.
  const beatTs = heartbeatTs(descriptor.id, home, fsi);
  if (isFreshBeat(beatTs, now, heartbeatFreshMs)) { // P1-7: a future/non-positive ts is NOT fresh
    const hbBacklog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, fsi);
    return {
      status: 'alive',
      lastOutboundTs: Math.max(beatTs, priorOutbound || 0) || beatTs,
      staleSince: null,
      nudgeAttempts: 0,
      nudgedAt: null,
      pending: hbBacklog.known && hbBacklog.lines.length > 0,
    };
  }

  // P2-13 TERMINAL short-circuit: `escalated` is sticky — return it unchanged,
  // never re-stat, so the sweep stops re-targeting a workspace a human must handle.
  if (prev && prev.status === 'escalated') {
    return { status: 'escalated', lastOutboundTs: priorOutbound, staleSince: priorStaleSince, nudgeAttempts, nudgedAt, pending: false };
  }

  const projectDir = projectDirFor(descriptor.worktreePath, home);
  const tMtime = transcriptMtime(projectDir, descriptor.sessionId, fsi);
  const wMtime = worktreeActivityMtime(descriptor.worktreePath, runners);
  const lastOutboundTs = Math.max(tMtime || 0, wMtime || 0) || null;

  const backlog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, fsi);
  const pending = backlog.known && backlog.lines.length > 0;

  // NUDGE hold: a poke is outstanding. Stay `nudged` unless the fresh outbound
  // signal has advanced past nudgedAt (proof the poke woke the session up ->
  // clear to alive). Once nudgeWindowMs elapses with no advance, stop holding —
  // fall through to the normal recompute below so pokeOrEscalate (called by the
  // sweep on a `stale` verdict) can decide: another poke, or escalate once the
  // attempt budget is exhausted. NEVER a kill from this branch.
  if (prev && prev.status === 'nudged') {
    const advanced = nudgedAt !== null && lastOutboundTs !== null && lastOutboundTs > nudgedAt;
    if (advanced) {
      return { status: 'alive', lastOutboundTs, staleSince: null, nudgeAttempts, nudgedAt, pending };
    }
    const withinWindow = nudgedAt !== null && (now - nudgedAt) < nudgeWindowMs;
    if (withinWindow) {
      return { status: 'nudged', lastOutboundTs: priorOutbound, staleSince: priorStaleSince, nudgeAttempts, nudgedAt, pending };
    }
    // window elapsed, no advance -> fall through to the normal recompute.
  }

  // BOTH signals must be present AND idle. A missing signal -> not conclusively
  // stale (fail-safe). max() being idle is equivalent to "both idle".
  const haveBoth = tMtime !== null && wMtime !== null;
  const bothIdle = haveBoth && (now - tMtime) > idle && (now - wMtime) > idle;
  const stale = bothIdle && pending;

  return {
    status: stale ? 'stale' : 'alive',
    lastOutboundTs,
    staleSince: stale ? (priorStaleSince || now) : null,
    nudgeAttempts,
    nudgedAt,
    pending,
  };
}

// writeVerdict(id, verdict, home, fsi) — atomic tmp+rename write.
function writeVerdict(id, verdict, home, fsi) {
  const F = fsi || fs;
  const p = livenessPathFor(id, home); // throws on an unsafe id (caller fails open)
  F.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  F.writeFileSync(tmp, JSON.stringify(verdict));
  F.renameSync(tmp, p);
  return p;
}

module.exports = {
  DEFAULT_IDLE_MS, DEFAULT_COOLDOWN_MS, DEFAULT_NUDGE_WINDOW_MS, DEFAULT_HEARTBEAT_FRESH_MS, DEFAULT_DORMANT_MS,
  DEFAULT_ROSTER_IDLE_MS,
  isSafeId, devswarmRoot, livenessPathFor, heartbeatPathFor, projectDirFor,
  transcriptMtime, worktreeActivityMtime, unreadBacklog, computeLiveness, writeVerdict,
  heartbeatTs, hasFreshHeartbeat, isFreshBeat, dormantThresholdMs, isDormantActivity,
  idleThresholdMs, readActivityTs, isDormantRow,
};
