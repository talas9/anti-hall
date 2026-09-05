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
// descriptorPathFor(id, home) — scripts/devswarm.js's own workspaces/<id>.json
// (workspacesDir(home) there == devswarmRoot(home)/workspaces here; duplicated,
// not required, matching this file's existing precedent of duplicating
// devswarm.js's path shape locally — see livenessPathFor/heartbeatPathFor).
// SAME id-safety gate as the others.
function descriptorPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'workspaces', String(id) + '.json');
}
// descriptorRegistrationTs(id, home, fsi) -> ms | null. NEVER-LAUNCHED gap
// fallback: a registry row with a REAL sessionId that never once produced a
// transcript has tMtime permanently null, so computeLiveness's `haveBoth` (and
// readActivityTs's combined `ts` below) can never resolve — the row is
// visible-but-never-consumable forever. Neither backend's registry row carries
// a durable registration timestamp: it exposes only `updated_at`/`updatedAt`,
// which is refreshed by activity UNRELATED to this specific row's own launch —
// verified: devswarm-ingest.js's self-registration upserts the daemon's OWN
// primary row on EVERY daemon startup, and `ensure`/auto-ensure re-upserts on
// EVERY child turn (companion/devswarm-ingest.js ~1361, scripts/devswarm.js
// cmdRegister's `requireNew && existing` branch). The descriptor FILE is NOT
// write-once — many paths rewrite it: `ensure` (scripts/devswarm.js:3404,
// unconditional, fires on every `inbox pull`), :3448, rehome/heal (:1149,
// :1256), archive backfill (:5568), unarchive (:5920), and migrateOwnerKeys
// (:6221, invoked by hooks/lib/doctor-repair.js:1166-1169 and by the
// updater). So this function measures time since the descriptor was last
// WRITTEN, not time since registration — and the mtime can be STALE as well
// as fresh: cmdArchive hardlinks the descriptor (devswarm.js:5596) and
// cmdUnarchive links it back (:5897), so an archive->unarchive round-trip
// restores an active descriptor still carrying its pre-archive mtime; an
// `rsync -a` / Time Machine restore preserves old mtimes too. This is safe
// despite the imprecision because the never-launched fallback only fires
// when heartbeat, transcript, and lastOutbound are ALL absent (`best === 0`),
// which a live session never satisfies (it always has a transcript `.jsonl`
// and heartbeats after its first prompt) — worst case is an early orphan
// drain to a mesh sibling (delivery, not loss), and `ensure` heals the
// timestamp on the next `inbox pull`. Fail-open to null on unsafe id /
// missing / unreadable descriptor (no signal, never fabricated).
function descriptorRegistrationTs(id, home, fsi) {
  const F = fsi || fs;
  let p;
  try { p = descriptorPathFor(id, home); } catch (_) { return null; }
  try {
    const st = F.statSync(p);
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch (_) { return null; }
}
// DEFAULT_NEVER_LAUNCHED_MS — the generous ABSOLUTE deadline for the
// never-launched fallback above: how long a row may sit registered with NO
// transcript at all (and, via readActivityTs, no heartbeat/verdict-outbound
// either) before it is treated as dead. This is a fallback for "never
// launched at all", NOT a liveness heartbeat — deliberately hours, not
// minutes, comfortably longer than any plausible register-to-first-turn gap
// (spawn scheduling, hivecontrol worktree creation, model cold-start). Kept
// the SAME 6h value as DEFAULT_ROSTER_IDLE_MS above (this file's existing
// "defensible wide default" for the sibling "no transcript signal" case) —
// distinct name so the two axes can be tuned independently later without
// silently colliding, matching this file's own stated practice.
const DEFAULT_NEVER_LAUNCHED_MS = 6 * 60 * 60 * 1000;
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
  // NEVER-LAUNCHED fallback (see descriptorRegistrationTs's header): reached
  // ONLY when heartbeat, transcript, AND lastOutboundTs are ALL absent (best
  // still 0) — i.e. every other activity signal this row could offer is
  // missing, not merely the transcript one. `sawTranscript` stays false, so
  // isDormantRow below applies its EXISTING "no transcript" window
  // (idleThresholdMs, the same 6h default DEFAULT_NEVER_LAUNCHED_MS mirrors)
  // to this registration timestamp exactly as it already does for a
  // heartbeat-only row — no new comparison logic needed here.
  if (best === 0) {
    try {
      const rt = descriptorRegistrationTs(id, home, F);
      if (Number.isFinite(rt) && rt > 0) best = rt;
    } catch (_) {}
  }
  return { ts: best > 0 ? best : null, sawTranscript };
}

// ---------------------------------------------------------------------------
// SESSION-SOURCED LIVENESS AXIS (defect 699a236129c5, P1) — `idle (alive)`.
//
// ROOT CAUSE: every axis isDormantRow composes (heartbeat mtime, transcript
// mtime, lastOutboundTs, descriptor registration ts) is an ACTIVITY timestamp.
// All four go quiet for an interactive session that is simply SITTING AT ITS
// PROMPT with nothing to do — which is the normal resting state of a Primary
// between turns, not death. Past the window (30 min tight / 6 h wide) such a
// session reads `dormant`, gets nagged in the injected roster, and can be
// escalated — while the operator is looking straight at it.
//
// THE DISCRIMINATOR IS NOT A TIMESTAMP. The Claude Code harness writes
// `<home>/.claude/sessions/<pid>.json` for each running session, carrying
// { pid, sessionId, cwd, status, ... }. MEASURED on this machine: a session
// file 95 minutes old (mtime is therefore USELESS as a freshness signal —
// deliberately not read here) still named a pid that `process.kill(pid, 0)`
// confirmed alive. So the file supplies the sessionId->pid MAPPING and the
// LIVE PID is the proof. That is a genuinely different axis: it answers "is
// the process running" rather than "did it do something recently".
//
// SCOPE — this NEVER widens dormancy, only narrows it. A row with a live pid
// is `idle-alive` (not dormant); a row whose session file names a DEAD pid, or
// that has no session file at all, keeps today's timestamp rule verbatim.
// FAIL-SOFT in full: an absent/unreadable sessions dir, an unparseable file, a
// non-numeric pid, or a throwing kill() all yield `null` (no opinion) and the
// caller behaves exactly as it does today.

const DEFAULT_SESSIONS_DIRNAME = '.claude';

// sessionsDirFor(home) -> <home>/.claude/sessions. `home` is the SAME home the
// rest of this module takes (the anti-hall root's parent), so a test can point
// the whole axis at a scratch dir by passing its own home — no env override and
// no process-global state.
function sessionsDirFor(home) {
  return path.join(home || os.homedir(), DEFAULT_SESSIONS_DIRNAME, 'sessions');
}

// pidIsAlive(pid, kill) -> bool. `process.kill(pid, 0)` sends no signal; it
// only probes existence+permission. ESRCH (no such process) is the ONE answer
// that means dead. EPERM means the process EXISTS but is owned by another user
// — still alive, so it must NOT be read as dead. Any other throw is treated as
// "no opinion" by the caller via the null it returns.
function pidIsAlive(pid, kill) {
  const k = typeof kill === 'function' ? kill : process.kill.bind(process);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { k(pid, 0); return true; } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true;
    return null;
  }
}

// sessionPidAlive(sessionId, home, opts) -> true | false | null
//   true  = a harness session file maps this sessionId to a LIVE pid
//   false = a session file names this sessionId but its pid is dead
//   null  = no session file for it / dir absent / unreadable — NO OPINION,
//           the caller keeps today's timestamp-only rule.
// opts: { fs, kill } (both injectable for tests).
function sessionPidAlive(sessionId, home, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  const sid = sessionId != null ? String(sessionId) : '';
  if (!sid) return null;
  const dir = sessionsDirFor(home);
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { return null; }
  let verdict = null;
  for (const n of names) {
    if (!/\.json$/.test(n)) continue; // the sibling `<pid>.<hash>.key` files are not session records
    let rec = null;
    try { rec = JSON.parse(F.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.sessionId == null || String(rec.sessionId) !== sid) continue;
    const alive = pidIsAlive(Number(rec.pid), o.kill);
    if (alive === true) return true; // one live pid is proof; stop looking
    if (alive === false) verdict = false; // remember death, but a later file may still prove life
  }
  return verdict;
}

// isSessionAliveRow(row, home, opts) -> bool. True ONLY on positive proof that
// this row's sessionId belongs to a running harness process.
function isSessionAliveRow(row, home, opts) {
  try { return sessionPidAlive(row && row.sessionId, home, opts) === true; } catch (_) { return false; }
}

// rowLivenessState(row, home, opts) -> 'active' | 'idle-alive' | 'dormant'.
// The DISTINCT surfacing the roster/injection need: `idle-alive` is a row the
// timestamp rule would have called dormant but whose session process is
// provably running. Callers that only need the boolean keep using isDormantRow
// (which is now defined in terms of this, so the two can never disagree).
function rowLivenessState(row, home, opts) {
  if (!isDormantByActivity(row, home, opts)) return 'active';
  return isSessionAliveRow(row, home, opts) ? 'idle-alive' : 'dormant';
}

// isDormantByActivity — the PRE-EXISTING timestamp-only rule, extracted
// verbatim so both isDormantRow and rowLivenessState read the identical
// computation instead of one of them re-deriving it.
function isDormantByActivity(row, home, opts) {
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
// SESSION-SOURCED OVERRIDE (defect 699a236129c5): a row whose sessionId maps to
// a RUNNING harness process is `idle (alive)`, never dormant — see the
// sessionPidAlive block above for why a live pid, not a timestamp, is the right
// discriminator for an interactive session sitting at its prompt. One-directional:
// it can only ever clear dormancy, never assert it, and with no session evidence
// (the common case) this line contributes nothing at all.
//
// opts: { now, env, fs, kill, lastOutboundTs, heartbeatTs } — all forwarded to
// readActivityTs / isDormantActivity / sessionPidAlive as appropriate. `now`
// defaults to Date.now(); `env` defaults to process.env.
function isDormantRow(row, home, opts) {
  if (!isDormantByActivity(row, home, opts)) return false;
  return !isSessionAliveRow(row, home, opts);
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

// isSiblingPartitionLive(row, home, opts) -> bool. Fix Wave 7 Item 2: the ONE
// positive-evidence liveness check for a MESH-SIBLING partition before any
// cursor-ack (shared by scripts/devswarm.js's cmdInboxMessages read-primary/
// peek-primary ack loop AND `inbox ack`'s own sibling-store-cursor loop, so
// the two verbs cannot silently diverge on what "safe to ack" means).
//
// ROOT CAUSE this replaces: the prior gate (`hasFreshHeartbeat` alone) treated
// ABSENCE of a recent heartbeat as evidence of death. Three ways that is
// wrong, all reproduced live:
//   - a child mid-long-turn: writeHeartbeat is called once per
//     UserPromptSubmit (once per PROMPT), not per tool-call round, so 40
//     minutes of autonomous work on one prompt reads as stale though the
//     session is very much alive.
//   - a genuinely live child that has not yet completed its first turn:
//     `register` writes no heartbeat file at all, so a brand-new live child
//     reads identically to a dead one.
//   - an unreadable heartbeat file (EACCES etc): `heartbeatTs` swallows the
//     error and returns null ("never throws"), which the old gate could not
//     distinguish from "no heartbeat ever recorded" (i.e. dead).
//
// FIX: compose the SAME three-branch rule already relied on for `diagnose`'s
// rows[].live (scripts/devswarm.js computeDiagnosis, ~line 7305) — reused,
// not reinvented:
//   1. a FRESH heartbeat -> definitive proof-of-life (see this file's header)
//      -> live. Kept as an ADDITIONAL/fast-path signal, never the sole
//      permission to ack (that was the bug).
//   2. else a REAL (non-synthetic, non-`unclaimed:`) sessionId whose OWN
//      activity is NOT positively stale (`isDormantRow` — false unless it has
//      POSITIVE evidence of prolonged silence) -> live. `isDormantRow`'s
//      transcript term refreshes on EVERY tool call, not once per turn, so a
//      child mid-long-turn keeps reading live even once its heartbeat alone
//      has gone stale; and `isDormantRow` is itself fail-open (no signal at
//      all -> not dormant), so a never-heartbeated child, or one whose
//      heartbeat file is transiently unreadable, ALSO reads live rather than
//      dead — closing both the never-heartbeated and the EACCES-fails-toward-
//      death holes as a byproduct of gating on evidence-of-death rather than
//      absence-of-evidence-of-life.
//   3. else (no fresh heartbeat AND either no real sessionId or positively
//      stale activity) -> NOT live. This IS positive evidence of death: the
//      row was either never claimed by a real session at all (the
//      register-only phantom — the legitimate cross-drain/orphan case this
//      gate exists to allow through) or its own evidence (heartbeat AND
//      transcript) is measurably stale past the dormancy window — never mere
//      absence of a signal.
// A durable "registry row removed/tombstoned" signal was evaluated and
// rejected as the primitive here: `meshSiblingPartitions` (the set this gate
// is ever consulted for) is built FROM `listRegistry()`, so every candidate
// row it contains structurally still HAS a registry row by construction — a
// tombstoned id is simply absent from that set already and never reaches this
// function. The `unclaimed:`/dormancy composition above is the one that
// actually discriminates live-vs-dead WITHIN that set.
//
// Fail-open on throw (malformed row / registry read failure): treat as LIVE
// (skip the ack) — the same asymmetry already documented at both call sites:
// a spurious skip only risks a harmless re-delivery next read, while a
// spurious ack risks PERMANENTLY losing a live sibling's own unread backlog.
// opts: { now, freshMs } — forwarded to hasFreshHeartbeat/isDormantRow.
function isSiblingPartitionLive(row, home, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  try {
    const id = row && row.id != null ? String(row.id) : null;
    if (!id) return true; // no id to check -> undetermined -> fail toward live
    if (hasFreshHeartbeat(id, home, { now, freshMs: o.freshMs })) return true;
    const sidRaw = row.sessionId;
    const sid = sidRaw == null ? '' : String(sidRaw);
    const isLiveSid = sid !== '' && !sid.startsWith('unclaimed:');
    if (!isLiveSid) return false; // register-only phantom -> positive evidence of the legitimate orphan case
    return !isDormantRow({ id, worktreePath: row.worktreePath, sessionId: sidRaw }, home, { now });
  } catch (_) {
    return true; // undetermined -> fail toward live, never ack
  }
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

// unreadBacklog(inboxPath, cursorPath, fsi) ->
//   { lines: string[], known: boolean, reason?, path?, errno? }.
// inboxPath = NDJSON append-only (one message/line). cursorPath = a bare integer
// OR JSON {line:<int>} = count of consumed lines. Unparseable/absent cursor =>
// known:false (treated as NOT pending — fail-safe: never nominate an unreadable
// workspace for a kill). NDJSON-ONLY — see unionPendingFor below for the
// mesh-aware (NDJSON ∪ store) signal computeLiveness actually gates on; this
// function is kept as-is (still used directly by callers that only have an
// inboxPath/cursorPath, no workspace id/worktreePath to resolve a store from).
//
// `reason`/`path`/`errno` (ADDITIVE — every prior caller reads only `.lines`/
// `.known` and is unaffected) distinguish WHY `known` came back false, so a
// caller reporting this to a human can name the actual cause instead of a
// single generic "unreadable" for every case. `reason` is one of:
//   'no-inbox-path'    — inboxPath itself is falsy (null/undefined/'') — a
//                         malformed/phantom descriptor, not a filesystem fault.
//   'inbox-missing'    — readFileSync(inboxPath) failed with ENOENT.
//   'inbox-unreadable' — readFileSync(inboxPath) failed with anything else
//                         (EACCES, EISDIR, ...) — the path exists/resolves but
//                         could not be read.
//   'no-cursor-path'   — cursorPath itself is falsy.
//   'cursor-missing'   — readFileSync(cursorPath) failed with ENOENT.
//   'cursor-unreadable'— readFileSync(cursorPath) failed with anything else,
//                         OR the content parsed but was not valid JSON/int.
//   'cursor-invalid'   — the cursor parsed but is non-finite or negative.
// A null path passed straight to fs.readFileSync throws a TypeError
// (ERR_INVALID_ARG_TYPE), NOT ENOENT — so falsy paths are checked explicitly
// BEFORE attempting the read, rather than folding into the generic catch,
// where they would otherwise misreport as 'inbox-unreadable'/'cursor-unreadable'.
function unreadBacklog(inboxPath, cursorPath, fsi) {
  const F = fsi || fs;
  if (!inboxPath) return { lines: [], known: false, reason: 'no-inbox-path', path: null, errno: null };
  let all;
  try {
    all = String(F.readFileSync(inboxPath, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch (e) {
    const reason = (e && e.code === 'ENOENT') ? 'inbox-missing' : 'inbox-unreadable';
    return { lines: [], known: false, reason, path: inboxPath, errno: (e && e.code) || null };
  }
  if (!cursorPath) return { lines: [], known: false, reason: 'no-cursor-path', path: null, errno: null };
  let cursor;
  try {
    const raw = String(F.readFileSync(cursorPath, 'utf8')).trim();
    if (/^\d+$/.test(raw)) cursor = parseInt(raw, 10);
    else cursor = Number(JSON.parse(raw).line);
  } catch (e) {
    const reason = (e && e.code === 'ENOENT') ? 'cursor-missing' : 'cursor-unreadable';
    return { lines: [], known: false, reason, path: cursorPath, errno: (e && e.code) || null };
  }
  if (!Number.isFinite(cursor) || cursor < 0) return { lines: [], known: false, reason: 'cursor-invalid', path: cursorPath, errno: null };
  return { lines: all.slice(cursor), known: true };
}

// NOT_DRAINING_AGE_MS — how old the OLDEST unread message must be before a
// nonzero union-unread backlog is additionally flagged `notDraining` (a
// distinct, REPORT/ESCALATE-ONLY stall signal — see computeLiveness below).
// 20 minutes: long enough that a child mid-turn (which drains reactively via
// hooks/devswarm-child-drain.js, not on a fixed clock) isn't flagged for an
// ordinary processing lag, short enough to catch the real failure mode this
// closes (a mesh-direct backlog sitting unseen for a full session).
const NOT_DRAINING_AGE_MS = 20 * 60 * 1000;

// resolveSelfId(worktreePath) -> primary workspace id | null. A3 fix: mirrors
// recovery.js's notifyParentEscalation ADDRESSEE FIX verbatim — primaryWorkspaceId()
// is a PURE HASH of the path it is handed, and `worktreePath` here is the TARGET's
// (often a linked worktree's) own root, whose `.git` is a FILE, not a dir, so
// naively hashing it yields THAT workspace's own id, never the real Primary's.
// resolveMainWorktree() resolves via git-common-dir (identical for every worktree
// of one project) to the actual main worktree first. LAZY + GUARDED (D27 idiom):
// install-devswarm-ingest.js itself `require`s this module at its top level, so a
// top-level require here would be circular — this lazy require resolves fine at
// call time either way. Any failure (missing module, non-git path, throwing
// resolver) yields null; callers must treat null as "no self id to filter by"
// (fail-open TOWARD counting the row, never toward hiding a real backlog).
function resolveSelfId(worktreePath) {
  if (!worktreePath) return null;
  try {
    const inst = require('../install-devswarm-ingest.js');
    const parentWorktree = inst.resolveMainWorktree(worktreePath) || worktreePath;
    const id = inst.primaryWorkspaceId(parentWorktree);
    return isSafeId(id) ? id : null;
  } catch (_) {
    return null;
  }
}

// unionPendingFor(descriptor, home, opts) -> { pending, pendingInbound, notDraining,
//   oldestUnreadAgeMs }.
// The mesh-aware (NDJSON durable inbox ∪ store-only mesh-direct backlog) unread
// signal — closes the root cause this file's header documents (a `send --to`
// direct is STORE-ONLY; unreadBacklog()/NDJSON-only reads it as empty). LAZY +
// GUARDED (D27 idiom, matching devswarm-child-turn.js's registerStoreDescriptor
// and every other hook in this plugin that opens the store): a missing/corrupt
// devswarm-unread.js, an unresolvable repoKey, or a store-open failure all
// degrade to the pre-fix unreadBacklog() NDJSON-only signal — NEVER throws,
// NEVER makes a previously-passing check newly fail closed.
//
// `pending` (UNCHANGED, A3): counts every undrained row with no sender
// attribution — the REPORTING view, still what a caller wants when it just needs
// "does this mailbox hold anything at all" (e.g. the heartbeat-alive surface).
//
// `pendingInbound` (NEW, A3 fix): the axis liveness's own `stale` decision must
// use — it excludes any STORE-ONLY row whose `sender` equals `opts.selfId` (a
// message the CALLER itself just sent, sitting in the target's mailbox awaiting
// THEIR read — not evidence the target is neglecting inbound work; mirrors
// hooks/devswarm-parent-gate.js's own `row.sender === own.id` skip, applied here
// so liveness.js's independent copy of this same union stops double-counting the
// caller's own outbound as the target's neglect). NDJSON rows carry NO sender
// field at all (devswarm-pull.js's `{_h, fromBranch, message, createdAt, status}`
// wire shape) so they ALWAYS count here — attributing them by e.g. `fromBranch`
// would be a heuristic, not a sender identity; failing open toward the alarm.
// A store-only row with an absent/unresolvable sender likewise always counts
// (fail-open). `selfId` absent (resolveSelfId couldn't resolve one) -> identical
// to `pending` (no filtering possible, matches pre-fix behavior exactly).
function unionPendingFor(descriptor, home, opts) {
  const o = opts || {};
  const fsi = o.fs || fs;
  const selfId = o.selfId != null ? String(o.selfId) : null;
  const fallback = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, fsi);
  try {
    const unreadLib = require('./devswarm-unread.js');
    const storeHandle = unreadLib.openStoreForUnread({
      worktreePath: descriptor.worktreePath, id: descriptor.id, home, env: o.env,
    });
    if (!storeHandle) {
      const p = fallback.known && fallback.lines.length > 0;
      return { pending: p, pendingInbound: p, notDraining: false, oldestUnreadAgeMs: null };
    }
    try {
      const union = unreadLib.unionUnread({
        inboxPath: descriptor.inboxPath, cursorPath: descriptor.cursorPath,
        id: descriptor.id, storeHandle, fsi, now: o.now,
      });
      const pending = union.unread > 0;
      const notDraining = pending && Number.isFinite(union.oldestUnreadAgeMs) && union.oldestUnreadAgeMs > NOT_DRAINING_AGE_MS;
      let pendingInboundCount = (union.ndjsonUnreadLines || []).length;
      for (const row of (union.storeOnlyUnreadRows || [])) {
        if (selfId && row && row.sender != null && String(row.sender) === selfId) continue;
        pendingInboundCount++;
      }
      return { pending, pendingInbound: pendingInboundCount > 0, notDraining, oldestUnreadAgeMs: union.oldestUnreadAgeMs };
    } finally {
      try { storeHandle.close(); } catch (_) {}
    }
  } catch (_) {
    const p = fallback.known && fallback.lines.length > 0;
    return { pending: p, pendingInbound: p, notDraining: false, oldestUnreadAgeMs: null };
  }
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
    const hbUnion = unionPendingFor(descriptor, home, { fs: fsi, now, env: opts.env });
    return {
      status: 'alive',
      lastOutboundTs: Math.max(beatTs, priorOutbound || 0) || beatTs,
      staleSince: null,
      nudgeAttempts: 0,
      nudgedAt: null,
      pending: hbUnion.pending,
      notDraining: hbUnion.notDraining,
      oldestUnreadAgeMs: hbUnion.oldestUnreadAgeMs,
    };
  }

  // P2-13 TERMINAL short-circuit: `escalated` is sticky — return it unchanged,
  // never re-stat, so the sweep stops re-targeting a workspace a human must handle.
  if (prev && prev.status === 'escalated') {
    return {
      status: 'escalated', lastOutboundTs: priorOutbound, staleSince: priorStaleSince,
      nudgeAttempts, nudgedAt, pending: false, notDraining: false, oldestUnreadAgeMs: null,
    };
  }

  const projectDir = projectDirFor(descriptor.worktreePath, home);
  const tMtime = transcriptMtime(projectDir, descriptor.sessionId, fsi);
  const wMtime = worktreeActivityMtime(descriptor.worktreePath, runners);
  const lastOutboundTs = Math.max(tMtime || 0, wMtime || 0) || null;

  // union-unread (NDJSON ∪ store) — see unionPendingFor's header. `pending` is
  // this file's ORIGINAL name for "known unread backlog"; `notDraining` (item 3,
  // REPORT/ESCALATE ONLY — never gates a kill) additionally flags a pending
  // backlog whose OLDEST row is older than NOT_DRAINING_AGE_MS, independent of
  // the alive/stale/nudged/escalated axis below. `selfId` (A3 fix) is resolved
  // from THIS descriptor's own worktreePath — see resolveSelfId's header — so
  // `unionInfo.pendingInbound` below excludes rows this same party (its own
  // Primary) just sent into this mailbox, which is never evidence THIS target is
  // neglecting inbound work.
  const selfId = resolveSelfId(descriptor.worktreePath);
  const unionInfo = unionPendingFor(descriptor, home, { fs: fsi, now, env: opts.env, selfId });
  const pending = unionInfo.pending;

  // NUDGE hold: a poke is outstanding. Stay `nudged` unless the fresh outbound
  // signal has advanced past nudgedAt (proof the poke woke the session up ->
  // clear to alive). Once nudgeWindowMs elapses with no advance, stop holding —
  // fall through to the normal recompute below so pokeOrEscalate (called by the
  // sweep on a `stale` verdict) can decide: another poke, or escalate once the
  // attempt budget is exhausted. NEVER a kill from this branch.
  if (prev && prev.status === 'nudged') {
    const advanced = nudgedAt !== null && lastOutboundTs !== null && lastOutboundTs > nudgedAt;
    if (advanced) {
      return {
        status: 'alive', lastOutboundTs, staleSince: null, nudgeAttempts, nudgedAt,
        pending, notDraining: unionInfo.notDraining, oldestUnreadAgeMs: unionInfo.oldestUnreadAgeMs,
      };
    }
    const withinWindow = nudgedAt !== null && (now - nudgedAt) < nudgeWindowMs;
    if (withinWindow) {
      return {
        status: 'nudged', lastOutboundTs: priorOutbound, staleSince: priorStaleSince, nudgeAttempts, nudgedAt,
        pending, notDraining: unionInfo.notDraining, oldestUnreadAgeMs: unionInfo.oldestUnreadAgeMs,
      };
    }
    // window elapsed, no advance -> fall through to the normal recompute.
  }

  // BOTH signals must be present AND idle. A missing signal -> not conclusively
  // stale (fail-safe). max() being idle is equivalent to "both idle".
  const haveBoth = tMtime !== null && wMtime !== null;
  const bothIdle = haveBoth && (now - tMtime) > idle && (now - wMtime) > idle;

  // NEVER-LAUNCHED fallback (see descriptorRegistrationTs's header): applies
  // ONLY when the transcript signal is ENTIRELY absent (tMtime === null) — a
  // row that ever produced a transcript keeps going through bothIdle above,
  // untouched. regTs must be a positive, non-future, finite timestamp, else
  // this stays false and the row falls through to the existing haveBoth-false
  // fail-safe (undetermined -> never dead, never ack, never reap).
  const neverLaunchedDeadlineMs = Number.isFinite(opts.neverLaunchedDeadlineMs)
    ? opts.neverLaunchedDeadlineMs : DEFAULT_NEVER_LAUNCHED_MS;
  const regTs = tMtime === null ? descriptorRegistrationTs(descriptor.id, home, fsi) : null;
  const regTsValid = tMtime === null && Number.isFinite(regTs) && regTs > 0 && regTs <= now;
  const neverLaunchedDead = regTsValid && (now - regTs) > neverLaunchedDeadlineMs;

  // A3 fix: `stale` gates on `pendingInbound`, NOT the raw `pending` reporting
  // value — see unionPendingFor's header. `pending` (reported below, unchanged)
  // still reflects the full mailbox depth for drain/ack accounting elsewhere.
  const stale = (bothIdle || neverLaunchedDead) && unionInfo.pendingInbound;

  return {
    status: stale ? 'stale' : 'alive',
    lastOutboundTs,
    staleSince: stale ? (priorStaleSince || now) : null,
    nudgeAttempts,
    nudgedAt,
    pending,
    notDraining: unionInfo.notDraining,
    oldestUnreadAgeMs: unionInfo.oldestUnreadAgeMs,
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
  DEFAULT_ROSTER_IDLE_MS, NOT_DRAINING_AGE_MS, DEFAULT_NEVER_LAUNCHED_MS,
  isSafeId, devswarmRoot, livenessPathFor, heartbeatPathFor, descriptorPathFor, descriptorRegistrationTs, projectDirFor,
  transcriptMtime, worktreeActivityMtime, unreadBacklog, unionPendingFor, resolveSelfId, computeLiveness, writeVerdict,
  heartbeatTs, hasFreshHeartbeat, isFreshBeat, dormantThresholdMs, isDormantActivity,
  idleThresholdMs, readActivityTs, isDormantRow, isSiblingPartitionLive,
  // session-sourced liveness axis (defect 699a236129c5)
  sessionsDirFor, pidIsAlive, sessionPidAlive, isSessionAliveRow, rowLivenessState,
  isDormantByActivity,
};
