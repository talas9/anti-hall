#!/usr/bin/env node
// anti-hall :: devswarm-parent-inbox (UserPromptSubmit, PRIMARY only)
//
// Workaround for claude-code#39755 — the Primary orchestrator silently neglects
// DevSwarm child workspaces (they fall off its task list, sit with unread backlog,
// or wedge unnoticed). This hook is the MECHANICAL trigger (Phase 1): on every
// user turn it surfaces the REAL unread/idle state of the active workspaces so the
// Primary is nudged to actually engage them, and — separately — recommends that the
// user archive any workspace the store has derived as complete (archive_ready).
//
// Scope (Phase 1, corrected):
//   - Fires ONLY for a Primary DevSwarm session:
//       isDevswarmActive(env) && !isChildWorkspace(env).
//     Non-DevSwarm or child sessions -> silent no-op (no stdout, exit 0), byte-
//     identical to today.
//   - Data is read from the durable inbox files (via unreadBacklog, reused through
//     the inbox-cursor primitive's readUnread) plus the supervisor's already-written
//     fs verdicts and the derived summary.json. NEVER runs computeLiveness / git on
//     this hot path (no per-child `git` spawnSync) and NEVER opens the store DB — it
//     reads only fs-backed projections (P1-B / P1-C).
//   - EMPTY additionalContext (no stdout) when nothing is unread/idle AND nothing is
//     archive_ready — zero per-turn overhead.
//   - Append-only: it only ADDS context; it never suppresses or clobbers another
//     hook's output (each hook returns its own additionalContext; the harness
//     concatenates).
//   - Acceptance telemetry: when unread>0 it appends one NDJSON line (with each
//     workspace's cursor/total) to devswarm/parent-inbox.log, so a later pass can
//     tell whether the Primary actually acted (cursor advanced) next turn.
//   - Archive-ready recommendation (P1-E): for each ACTIVE workspace (descriptor
//     present) the store marked archive_ready, surface a PERSISTENT, per-workspace-
//     COOLDOWN'd nudge URGING the Primary to verify the workspace is merged, tested,
//     and deployed per the PARENT REPO'S OWN policy (this hook never checks that —
//     it stays pure fs, no git/test/gh spawn), then run `devswarm.js archive-request
//     <id>` to ASK THE CHILD to archive. This hook NEVER auto-archives, NEVER
//     removes a descriptor, and NEVER archives mechanically — the child asks its own
//     user. A workspace with an archive-ignore mark is skipped (still tracked, just
//     not surfaced). Once the workspace is archived the descriptor disappears from
//     readDescriptors() and the nudge stops on its own.
//
// INERTNESS (P1-D): with no workspace descriptors and no populated durable inbox,
// every read returns empty and this hook is a pure no-op. It is NOT self-sufficient
// — it depends on Phase 2's ingest daemon (or a consumer's equivalent) to feed the
// inbox and derive summary.json before it has anything to surface.
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }  (unused fields)
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always — fail-open on ANY error, never wedge a turn.
// stdout is written with fs.writeSync(1, ...) — synchronous, avoids the async
// flush race on macOS Node 18/20 (mirrors limit-conserve-inject.js / task-tracker.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
const {
  devswarmRoot,
  livenessPathFor,
  isSafeId,
  DEFAULT_COOLDOWN_MS,
} = require('../companion/lib/liveness.js');
// worktreeHash: the SAME per-worktree identity install-devswarm-ingest.js baked
// into the daemon's unit (and devswarm-ingest.js keys its heartbeat file by).
// ingestHeartbeatPath: the per-worktree daemon LIVENESS file (rewritten every
// sweep, even a 0-insert one) — see the staleness banner below.
const installIngest = require('../companion/install-devswarm-ingest.js');
const devswarmIngest = require('../companion/devswarm-ingest.js');

// A workspace whose supervisor verdict is one of these is idle/stuck (a wedged or
// escalated child), independent of whether it still has unread backlog.
const STUCK_STATUSES = new Set(['stale', 'nudged', 'escalated']);
// How long a per-workspace archive recommendation stays silent before it repeats.
// Reuses the proven liveness cooldown value (poke-cooldown pattern, P1-E) so the
// reminder is PERSISTENT but not literally every-turn.
const ARCHIVE_NUDGE_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
const MAX_LISTED = 6; // cap workspaces named inline to keep additionalContext short
// The live workspace table is injected EVERY turn, so it is capped harder than the
// inline lists. Rows past this cap are folded into a "+N more" note and the cap is
// logged (never silently truncated).
const MAX_TABLE_ROWS = 12;
// How long the daemon LIVENESS HEARTBEAT (heartbeats/ingest-<hash>.json, written by
// writeIngestHeartbeat in devswarm-ingest.js) may sit un-refreshed before the
// staleness banner fires. Unlike summary.json's generatedAt (only advances on
// inserted>0), the heartbeat is rewritten EVERY sweep cycle regardless of whether
// anything was ingested — a live-but-QUIET daemon (backlog present, no new
// messages) still refreshes it. DEFAULT_MONITOR_INTERVAL_SEC (devswarm-ingest.js)
// is 3s; 3 minutes is a generous multiple of that sweep cadence — large enough to
// absorb a slow monitor poll / restart backoff, small enough to still catch a
// genuinely stopped daemon promptly. (Same value + rationale as the generatedAt-
// based banner this replaces.)
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

// summaryPath(home, hash) -> a PER-PROJECT summary file (summaries/<hash>.json).
// v0.57 mesh (D1/D24/Phase 8 step 1): the store now writes ONE shared summary
// PER PROJECT, keyed by repoKeyForWorktree(cwd) — NOT per-descriptor
// hashFromWorkspaceId(d.id) as it was pre-mesh. main() reads this file ONCE
// (keyed by THIS session's own repoKey) and iterates summary.workspaces for
// every workspace that project's store knows about. `hash` null -> null
// (readSummary then fails open to "no data").
function summaryPath(home, hash) {
  if (!hash) return null;
  return path.join(devswarmRoot(home), 'summaries', String(hash) + '.json');
}
function parentInboxLogPath(home) {
  return path.join(devswarmRoot(home), 'parent-inbox.log');
}
function archiveIgnorePath(home, id) {
  return path.join(devswarmRoot(home), 'archive-ignore', String(id) + '.json');
}
function archiveNudgePath(home, id) {
  return path.join(devswarmRoot(home), 'archive-nudges', String(id) + '.json');
}
function heartbeatPathFor(home, id) {
  return path.join(devswarmRoot(home), 'heartbeats', String(id) + '.json');
}

// readSummary(home) -> parsed object | null. summary.json is the derived hook
// read-surface (written atomically by the Phase 2 store). Tolerant of a missing,
// empty, zero-byte, or partially-written file (P2-9): any failure -> null ("no
// data yet"), never throws.
function readSummary(home, hash) {
  const p = summaryPath(home, hash);
  if (!p) return null;
  try {
    const raw = String(fs.readFileSync(p, 'utf8')).trim();
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

// summaryEntry(summary, id) -> object | null. Tolerates both a { workspaces: {id:
// {...}} } shape and a flat { id: {...} } top-level map.
function summaryEntry(summary, id) {
  if (!summary) return null;
  const fromNested = summary.workspaces && summary.workspaces[id];
  const entry = fromNested || summary[id];
  return entry && typeof entry === 'object' ? entry : null;
}

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs walk-up
// looking for a `.git` entry (a directory for a normal checkout, a FILE for a
// linked worktree/submodule) — the same root `git rev-parse --show-toplevel`
// would report for that cwd, WITHOUT spawning git (this hook's hot path spawns no
// subprocess at all — install-devswarm-ingest.js's own worktreeHash() then
// fs.realpathSync()'s this path, so it agrees byte-for-byte with what the
// installer baked into the daemon's unit at install time, as long as this walk
// lands on the same toplevel git itself would have found).
function findGitToplevel(startDir) {
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir;
      } catch (_) { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root, no .git found
      dir = parent;
    }
  } catch (_) {
    return null;
  }
}

// readVerdictFile(home, id) -> parsed liveness verdict | null. Reads the
// supervisor's already-written fs verdict (zero git, no computeLiveness). Tolerant
// of a missing / empty / partially-written file.
function readVerdictFile(home, id) {
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch (_) {
    return null;
  }
}

// verdictStatus(summary, id, verdict) -> status string | null. Prefers the derived
// summary.json entry (the designated hook read-surface, P1-C), then falls back to
// the persisted liveness verdict so "idle" is meaningful even before Phase 2
// derives summary.json. `verdict` is passed in so the file is read at most once.
function verdictStatus(summary, id, verdict) {
  const entry = summaryEntry(summary, id);
  if (entry && typeof entry.status === 'string') return entry.status;
  if (verdict && typeof verdict.status === 'string') return verdict.status;
  return null;
}

// readHeartbeat(home, id) -> parsed heartbeat | null. The turn-authored heartbeat
// (heartbeats/<id>.json) carries progress_pct + ts. Read-only fs; tolerant of a
// missing / malformed file (fail toward "no heartbeat").
function readHeartbeat(home, id) {
  try {
    const b = JSON.parse(fs.readFileSync(heartbeatPathFor(home, id), 'utf8'));
    return b && typeof b === 'object' ? b : null;
  } catch (_) {
    return null;
  }
}

// lastActivityTs(verdict, heartbeat) -> ms | null. The most recent activity signal
// already persisted for the workspace: the liveness verdict's lastOutboundTs
// (transcript/git activity) and the heartbeat's ts, whichever is newer. Never
// spawns git — reads only what the supervisor / a heartbeat already wrote.
function lastActivityTs(verdict, heartbeat) {
  const a = verdict && Number.isFinite(verdict.lastOutboundTs) ? verdict.lastOutboundTs : 0;
  const b = heartbeat && Number.isFinite(heartbeat.ts) ? heartbeat.ts : 0;
  const best = Math.max(a, b);
  return best > 0 ? best : null;
}

// formatRelative(ts, now) -> compact relative age ("18m", "2h", "3d", "5s") or "—"
// when the signal is unknown. Clamps a future ts to 0 (never a negative age).
function formatRelative(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  let delta = now - ts;
  if (delta < 0) delta = 0;
  const s = Math.floor(delta / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// finishingRate(summary, id, heartbeat) -> string. Required completion gates met /
// total, from summary.requiredGates + the workspace's gate map (e.g. "2/3"). When
// no required gates are declared (or no summary entry yet) the gate ratio is
// unknown ("—"); a heartbeat progress_pct, when present, is appended (or shown
// alone if it is the only signal). Decision: gates are the authoritative finishing
// signal; progress_pct is an advisory secondary shown only when it exists.
function finishingRate(summary, id, heartbeat) {
  const entry = summaryEntry(summary, id);
  const required = summary && Array.isArray(summary.requiredGates) ? summary.requiredGates : [];
  let gatesStr = null;
  if (entry && required.length > 0) {
    const gates = entry.gates && typeof entry.gates === 'object' ? entry.gates : {};
    const met = required.filter((g) => gates[g] === true).length;
    gatesStr = met + '/' + required.length;
  }
  const pct = heartbeat && Number.isFinite(heartbeat.progress_pct) ? heartbeat.progress_pct : null;
  if (gatesStr && pct !== null) return gatesStr + ' (' + pct + '%)';
  if (gatesStr) return gatesStr;
  if (pct !== null) return pct + '%';
  return '—';
}

// displayStatus(archiveReady, status) -> { label, rank }. Collapses the raw verdict
// enum into the four surfaced states and assigns a sort rank so attention-needed
// workspaces sort first: escalated (0) > stale (1, incl. nudged) > archive-ready
// (2) > active (3). escalated outranks archive-ready: a wedged child needing a
// human beats a tidy teardown recommendation.
function displayStatus(archiveReady, status) {
  if (status === 'escalated') return { label: 'escalated', rank: 0 };
  if (status === 'stale' || status === 'nudged') return { label: 'stale', rank: 1 };
  if (archiveReady) return { label: 'archive-ready', rank: 2 };
  return { label: 'active', rank: 3 };
}

// buildWorkspaceTable(rows, now, capped, hidden) -> string. Compact markdown table
// of the ACTIVE workspaces (one row each): workspace, status, finishing rate,
// unread, last-activity. Rows are pre-sorted + already capped by the caller.
function buildWorkspaceTable(rows, now, capped, hidden) {
  const lines = [
    'DEVSWARM WORKSPACES (live — refreshed every turn):',
    '| workspace | status | finish | unread | last |',
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      '| ' + r.id + ' | ' + r.label + ' | ' + r.finish + ' | ' + r.unread
      + ' | ' + formatRelative(r.lastActivityTs, now) + ' |'
    );
  }
  if (capped) lines.push('+' + hidden + ' more (capped at ' + MAX_TABLE_ROWS + ')');
  return lines.join('\n');
}

// logTableCap(home, total, shown) — record that the live table was truncated, so a
// silent-truncation regression is visible in telemetry. Best-effort; never throws.
function logTableCap(home, total, shown) {
  try {
    const p = parentInboxLogPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), event: 'table-cap', total, shown, hidden: total - shown });
    fs.appendFileSync(p, line + '\n');
  } catch (_) {}
}

// isArchiveReady(home, id, summary) -> bool. The store derives archive_ready:true
// into summary.json once every required completion gate is met for an ACTIVE
// workspace. Read-only fs; false when summary.json is absent (inert until Phase 2).
function isArchiveReady(id, summary) {
  const entry = summaryEntry(summary, id);
  return !!(entry && entry.archive_ready === true);
}

// isArchiveIgnored(home, id) -> bool. A per-workspace ignore mark silences the
// archive reminder for THAT workspace only (it stays tracked). Existence check.
function isArchiveIgnored(home, id) {
  try {
    fs.statSync(archiveIgnorePath(home, id));
    return true;
  } catch (_) {
    return false;
  }
}

// archiveCooldownElapsed(home, id, now) -> bool. True when no prior nudge, or the
// cooldown window since the last nudge has elapsed (fail toward reminding).
function archiveCooldownElapsed(home, id, now) {
  try {
    const st = JSON.parse(fs.readFileSync(archiveNudgePath(home, id), 'utf8'));
    const last = st && Number.isFinite(st.lastNudgedAt) ? st.lastNudgedAt : null;
    if (last === null) return true;
    return (now - last) >= ARCHIVE_NUDGE_COOLDOWN_MS;
  } catch (_) {
    return true; // no/unreadable state -> treat as elapsed (remind now)
  }
}

// markArchiveNudged(home, id, now) — record this turn's archive nudge (atomic
// tmp+rename). Best-effort: a failed write just means we may re-remind next turn.
function markArchiveNudged(home, id, now) {
  try {
    const p = archiveNudgePath(home, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastNudgedAt: now }));
    fs.renameSync(tmp, p);
  } catch (_) {}
}

// logInjection(home, workspaces) — acceptance telemetry: one NDJSON line carrying
// each surfaced workspace's cursor/total so a later pass can prove whether the
// Primary acted (cursor advanced) on the next turn. Best-effort; never throws.
function logInjection(home, workspaces) {
  try {
    const p = parentInboxLogPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({
      ts: Date.now(),
      event: 'inject',
      workspaces: workspaces.map((w) => ({
        id: w.id, unread: w.unread, cursor: w.cursor, total: w.total, status: w.status || null,
      })),
    });
    fs.appendFileSync(p, line + '\n');
  } catch (_) {}
}

// buildUnreadSegment(list) -> string. SHORT summary of the unread/idle workspaces.
// IMPERATIVE wording for the unread case (was advisory "need attention" — #34
// parity pass): a Primary must not treat a child's unread backlog as optional
// background noise, same posture as the child's own imperative nudge below.
function buildUnreadSegment(list) {
  const shown = list.slice(0, MAX_LISTED).map((w) => {
    const parts = [];
    if (w.unread > 0) parts.push(w.unread + ' unread');
    if (w.status && STUCK_STATUSES.has(w.status)) parts.push(w.status);
    return w.id + (parts.length ? ' (' + parts.join(', ') + ')' : '');
  });
  const extra = list.length > MAX_LISTED ? ' +' + (list.length - MAX_LISTED) + ' more' : '';
  const anyUnread = list.some((w) => w.unread > 0);
  let body = (
    'DEVSWARM PARENT INBOX: ' + list.length + ' active workspace(s) need attention — '
    + shown.join('; ') + extra + '. '
  );
  body += anyUnread
    ? ('STOP and read each unread workspace\'s inbox message(s) FIRST via '
      + '`devswarm.js inbox read <id>` before continuing (or reassign/archive it). ')
    : ('Read/ack each workspace inbox (or reassign/archive it) so it does not sit '
      + 'unnoticed off your task list. ');
  body += 'A workspace flagged stale/escalated has a wedged child — check on it.';
  return body;
}

// isHighUrgency(u) -> bool. 'urgent'/'high' both map to the LOUD, imperative
// tier (D4 — urgency drives visibility, not gating: a mesh DIRECT's urgency
// selects wording ONLY; it never affects whether the Stop-gate fires).
function isHighUrgency(u) {
  return u === 'urgent' || u === 'high';
}

// tierOf(w) -> 'urgent' | 'low' | 'normal'. Per-workspace attention-item tier
// (D4, Phase 8 step 2). A stuck-only item (unread<=0, e.g. escalated with an
// empty inbox) always stays 'normal' — urgency is a property of a pending
// unread DIRECT message, not of a liveness verdict. A STUCK workspace (Opus-
// auditor P2) is never demoted to 'low' by its message urgency alone — a
// wedged/escalated child's liveness escalation must not be dropped from the
// imperative segment just because its queued message happens to be low-
// urgency; it still loses to an urgent message (checked first, unaffected).
function tierOf(w) {
  if (!(w.unread > 0)) return 'normal';
  if (isHighUrgency(w.urgencyMax)) return 'urgent';
  if (w.status && STUCK_STATUSES.has(w.status)) return 'normal';
  if (w.urgencyMax === 'low') return 'low';
  return 'normal';
}

// buildUrgentUnreadSegment(list) -> string. v0.57 mesh (D4, Phase 8 step 2): the
// LOUDEST tier — workspaces whose unread carries an urgent/high urgencyMax get a
// DISTINCT, more prominent segment than the standard buildUnreadSegment below
// (same imperative "STOP and read FIRST" posture as buildOwnUnreadSegment).
function buildUrgentUnreadSegment(list) {
  const shown = list.slice(0, MAX_LISTED).map((w) => {
    const parts = [w.unread + ' unread'];
    if (w.status && STUCK_STATUSES.has(w.status)) parts.push(w.status);
    return w.id + ' (' + parts.join(', ') + ')';
  });
  const extra = list.length > MAX_LISTED ? ' +' + (list.length - MAX_LISTED) + ' more' : '';
  return (
    'DEVSWARM URGENT INBOX: ' + list.length + ' workspace(s) sent an URGENT/HIGH-priority '
    + 'direct message — ' + shown.join('; ') + extra + '. STOP and read each unread '
    + 'workspace\'s inbox message(s) FIRST via `devswarm.js inbox read <id>` before '
    + 'continuing.'
  );
}

// buildOwnUnreadSegment(count, id, urgencyMax) -> string. IMPERATIVE PRIORITY
// wording for the Primary's OWN inbound unread (#34 fix — the Primary previously
// had no visibility into its own unread parent/peer backlog, only children's).
// Parity with the child's own imperative nudge (devswarm-child-turn.js
// buildUnreadSegment:167-176, #29): the Primary must not treat its own unread
// messages as optional either. v0.57 mesh (D4, Phase 8 step 4): `urgencyMax`
// (the highest urgency among the Primary's own pending directs, from the
// summary projection) is HONORED in the wording — urgent/high gets an explicit
// "URGENT" prefix — but NEVER changes whether this is surfaced; a DIRECT always
// gates/surfaces regardless of urgency (D4's type-vs-urgency separation —
// urgency governs tier/loudness only).
function buildOwnUnreadSegment(count, id, urgencyMax) {
  const prefix = isHighUrgency(urgencyMax) ? 'DEVSWARM OWN INBOX — URGENT PRIORITY: ' : 'DEVSWARM OWN INBOX — PRIORITY: ';
  return (
    prefix + 'you have ' + count + ' unread parent/peer '
    + 'message(s) addressed to YOU (the Primary). STOP and read your unread '
    + 'parent/peer message(s) FIRST before continuing. Read them the SAFE, '
    + 'NON-DRAINING way — `devswarm.js inbox read-primary ' + id + '` (anti-hall '
    + 'devswarm CLI). Do NOT run `hivecontrol workspace read-messages` or '
    + '`monitor` — those DESTRUCTIVELY drain the native queue.'
  );
}

// buildBroadcastSegment(rows) -> string. v0.57 mesh (D3/D4/D22/D23/D27, Phase 8
// step 2): the top-level `recent[]` broadcast/heartbeat feed, rendered ADVISORY
// ONLY — this is roster/FYI context, NEVER a Stop-gate trigger and NEVER
// mechanically dispatched ("react only if concerned" is agent judgement, D27 —
// no concerned-classifier is invented here). A `recent[]` row carries no
// direct/broadcast discriminator of its own (it is ALWAYS a broadcast-axis row —
// plain broadcast or heartbeat, D22) so every row renders identically; urgency
// (urgent/high) only makes a row visually LOUDER via an `[URGENT]` tag — it does
// not change the advisory framing or gate anything.
function buildBroadcastSegment(rows) {
  const shown = rows.slice(-MAX_LISTED).map((r) => {
    const tag = isHighUrgency(r.urgency) ? '[URGENT] ' : '';
    const who = r.from != null ? r.from : '?';
    const body = r.summary != null && r.summary !== '' ? r.summary : '(no summary)';
    return '- ' + tag + who + ': ' + body;
  });
  return (
    'DEVSWARM BROADCAST (advisory roster/FYI feed — react ONLY if you judge it '
    + 'relevant; NEVER blocks your turn, regardless of urgency):\n' + shown.join('\n')
  );
}

// buildArchiveSegment(ids) -> string. Recommendation, NOT a command: this hook
// stays pure-fs (no git/test/gh spawn) and cannot verify merge/test/deploy status
// itself, so it URGES the Primary to check per the parent repo's OWN policy, then
// ask the child to archive via the CLI. NEVER archives mechanically or directly.
function buildArchiveSegment(ids) {
  const shown = ids.slice(0, MAX_LISTED).join(', ');
  const extra = ids.length > MAX_LISTED ? ' (+' + (ids.length - MAX_LISTED) + ' more)' : '';
  return (
    'DEVSWARM ARCHIVE-READY: workspace(s) ' + shown + extra + ' are complete '
    + '(all required gates met). VERIFY this workspace is MERGED + TESTED + DEPLOYED '
    + 'per YOUR repo\'s policy (using your own tooling; anti-hall does not check this), '
    + 'then run `devswarm.js archive-request <id>` to ask the child to archive. '
    + 'NEVER archive mechanically; the child asks its user.'
  );
}

// buildStaleBanner(beatTs, now) -> string. VISIBLE daemon-LIVENESS warning,
// injected ABOVE the live workspace table: the ingest daemon's own heartbeat
// (rewritten every sweep, independent of inserts) is missing or hasn't been
// refreshed in HEARTBEAT_STALE_MS, i.e. the daemon has very likely stopped and the
// table below may be FROZEN. beatTs null (no heartbeat file at all) renders via
// formatRelative's "—" (unknown-age) fallback. Uses the same compact relative-age
// idiom as the table's "last" column.
function buildStaleBanner(beatTs, now) {
  return (
    '⚠ DEVSWARM STALE DATA: ingest daemon last alive ' + formatRelative(beatTs, now)
    + ' ago — data may be stale (the daemon may have stopped or never started for '
    + 'this worktree). Run /anti-hall:doctor to check the DevSwarm ingest daemon.'
  );
}

function main() {
  // Parse stdin for `cwd` — the ONE field this hook needs from the payload (to
  // resolve the CURRENT worktree's daemon heartbeat below); every other field is
  // unused (role/liveness come from env + fs). Malformed/absent stdin -> payload
  // stays null, and the heartbeat lookup below fails open (no banner).
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = null; }

  // Gate: PRIMARY DevSwarm sessions only. Anything else -> silent no-op.
  if (!isDevswarmActive(process.env)) return;
  if (isChildWorkspace(process.env)) return;

  const home = os.homedir();
  const now = Date.now();
  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd) ? payload.cwd : null;
  // Resolve the CURRENT worktree's identity ONCE. `gitTop`/`worktreeHash`/
  // `primaryId` are a PURE fs walk + hash (no git spawn) — the legacy identity
  // AND (#34) the Primary's OWN workspace id (primary-<hash>, the SAME
  // convention install-devswarm-ingest.js's primaryWorkspaceId + the ingest
  // daemon already use). `repoKey` (D1/D2, ONE git spawn, lazy-required module
  // per D27 so a missing/corrupt module fails this open) is the v0.57 mesh
  // per-PROJECT key that now selects which shared summaries/<repoKey>.json this
  // hook reads (Phase 8 step 1 — replaces the pre-mesh per-descriptor
  // hashFromWorkspaceId(d.id) read). Fail-open throughout: any failure -> null
  // -> no summary data, no banner, no own-unread segment.
  let worktreeHash = null;
  let primaryId = null;
  let gitTop = null;
  try {
    gitTop = cwd ? findGitToplevel(cwd) : null;
    worktreeHash = gitTop ? installIngest.worktreeHash(gitTop) : null;
    primaryId = gitTop ? installIngest.primaryWorkspaceId(gitTop) : null;
  } catch (_) { worktreeHash = null; primaryId = null; gitTop = null; }

  let repokeyMod = null;
  try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; }
  let repoKey = null;
  try { repoKey = (repokeyMod && gitTop) ? repokeyMod.repoKeyForWorktree(gitTop) : null; } catch (_) { repoKey = null; }

  // ONE shared per-project summary read (D1/D24, Phase 8 step 1) — the store
  // now enumerates ALL of this project's workspaces into summaries/<repoKey>.json;
  // iterate summary.workspaces below instead of re-reading a summary PER
  // descriptor (the pre-mesh code double-read/mis-keyed under mesh, since every
  // caller now shares hash=repoKey — Opus-auditor P1).
  let summary = null;
  try { summary = repoKey ? readSummary(home, repoKey) : null; } catch (_) { summary = null; }
  const summaryWorkspaces = (summary && summary.workspaces && typeof summary.workspaces === 'object')
    ? summary.workspaces : {};

  const attention = []; // { id, unread, cursor, total, status, urgencyMax }
  const archiveList = [];
  const rows = []; // live-table row per ACTIVE workspace: { id, label, rank, finish, unread, lastActivityTs }

  // #36 STRUCTURAL cross-project filter (D29 — REPLACES the spoofable v0.56 env
  // filter `d.repoId !== currentRepoId`; env DEVSWARM_REPO_ID is in the SAME
  // trust class as the #39 ack-guard spoof). DEFENSE-IN-DEPTH: step 1's
  // restructure already scopes enumeration to THIS project's OWN
  // summaries/<repoKey>.json — a foreign project's workspace cannot land there
  // via the normal write path — but this explicit per-entry check guards
  // migration artifacts / future write-path drift the same way the parent-
  // gate's raw-descriptor loop needs it structurally (that loop is NOT
  // summary-driven at all). Keep an entry ONLY when its worktreePath resolves
  // to THIS SAME repoKey, or when EITHER side is unresolvable (fail-open —
  // nothing that surfaced pre-#36 can vanish). repoKeyForWorktree is memoized
  // by worktreePath so N workspaces sharing one worktree (siblings of one repo)
  // never re-spawn git more than once each.
  const repoKeyCache = new Map(); // worktreePath -> repoKey | null
  // Seed the cache with the already-resolved repoKey for THIS worktree (P2 —
  // Codex/Reviewer: most entries share `gitTop` as their worktreePath, so
  // pre-seeding avoids re-spawning git for the common case; entries on a
  // different worktree still resolve their own key on first lookup below).
  if (gitTop) repoKeyCache.set(gitTop, repoKey);
  function repoKeyOfWorktree(wt) {
    if (!wt) return null;
    if (repoKeyCache.has(wt)) return repoKeyCache.get(wt);
    let k = null;
    try { k = repokeyMod ? repokeyMod.repoKeyForWorktree(wt) : null; } catch (_) { k = null; }
    repoKeyCache.set(wt, k);
    return k;
  }

  for (const id of Object.keys(summaryWorkspaces)) {
    if (!isSafeId(id)) continue;
    // #34/Reviewer P1: the Primary's OWN self-registered entry (primary-<hash>,
    // written by devswarm-ingest.js's self-registration) lives in this SAME
    // shared summary alongside real children. It must be surfaced ONLY via the
    // dedicated ownUnread/buildOwnUnreadSegment path below (which also reads
    // this same summary), never as a fake "child" in the table/attention/
    // archive lists — the generic child CLI hints (`inbox read <id>`,
    // `archive-request <id>`) call readDescriptorFile, which has no entry for
    // a primary id and fails.
    if (id === primaryId) continue;
    const entry = summaryWorkspaces[id];
    if (!entry || typeof entry !== 'object') continue;

    const dKey = repoKeyOfWorktree(entry.worktreePath);
    if (repoKey && dKey && dKey !== repoKey) continue; // #36 structural filter

    // --- unread / idle (v0.57 mesh: sourced from the summary projection's own
    // directUnread/total/cursor — the mesh store's tracked cursor is now
    // authoritative for direct-message unread, D24; an old-shape entry missing
    // directUnread falls back to its `unread` alias, same value, edge_cases) ---
    const unread = Number.isFinite(entry.directUnread) ? entry.directUnread
      : (Number.isFinite(entry.unread) ? entry.unread : 0);
    const total = Number.isFinite(entry.total) ? entry.total : 0;
    const cursor = Number.isFinite(entry.cursor) ? entry.cursor : 0;
    const urgencyMax = entry.urgencyMax || null;

    const verdict = readVerdictFile(home, id); // still builder-id-keyed (D19)
    const status = verdictStatus(summary, id, verdict);
    const stuck = status !== null && STUCK_STATUSES.has(status);
    if (unread > 0 || stuck) {
      attention.push({ id, unread, cursor, total, status, urgencyMax });
    }

    // --- archive-ready recommendation (P1-E) ---
    const archiveReady = isArchiveReady(id, summary);
    try {
      if (archiveReady && !isArchiveIgnored(home, id)
          && archiveCooldownElapsed(home, id, now)) {
        archiveList.push(id);
      }
    } catch (_) {}

    // --- live-table row (every ACTIVE workspace, every turn) ---
    try {
      const heartbeat = readHeartbeat(home, id);
      const ds = displayStatus(archiveReady, status);
      rows.push({
        id,
        label: ds.label,
        rank: ds.rank,
        finish: finishingRate(summary, id, heartbeat),
        unread,
        lastActivityTs: lastActivityTs(verdict, heartbeat),
      });
    } catch (_) {}
  }

  // --- Primary's OWN inbound unread (#34) ---
  // The Primary's inbound is ingested by the daemon directly into the store
  // under workspaceId primary-<worktreeHash> and exposed via the SAME shared
  // summary already read above (the daemon self-registers its own id into
  // THIS project's repoKey-keyed store, D24) — no extra fs read needed.
  // Fail-open: any failure -> 0.
  let ownUnread = 0;
  let ownUrgencyMax = null;
  try {
    if (primaryId) {
      const ownEntry = summaryEntry(summary, primaryId);
      if (ownEntry && Number.isFinite(ownEntry.unread) && ownEntry.unread > 0) {
        ownUnread = ownEntry.unread;
        ownUrgencyMax = ownEntry.urgencyMax || null;
      }
    }
  } catch (_) { ownUnread = 0; ownUrgencyMax = null; }

  // Daemon-LIVENESS staleness banner (fail-open). Gated on `rows.length>0` (an
  // active workspace exists, i.e. a daemon is EXPECTED to be running) OR
  // `gitTop && !repoKey` (the mesh repoKey is unresolvable but this IS a git
  // worktree — the ONLY scenario the legacy-worktreeHash fallback branch below
  // is reachable in, since rows can no longer populate without a resolvable
  // repoKey under the Phase 8 restructure) — so an idle system with no
  // workspaces AND a resolvable repoKey never false-alarms, while the pre-mesh
  // legacy-heartbeat back-compat path stays exercised.
  //
  // RELEASE-GATE #23 (v0.57 mesh): the per-project ingest daemon now writes its
  // liveness heartbeat + O_EXCL lock keyed by repoKey (heartbeats/ingest-
  // <repoKey>.json / locks/ingest-project-<repoKey>.lock — devswarm-ingest.js's
  // hbHash = repoKey || worktreeHash, PLAN-v0.57-mesh.md D1/D8/D21), NOT the
  // legacy worktreeHash this banner read pre-mesh. When repoKey resolves, use
  // the FULL running+healthy check (daemonHealth, D25 — fresh heartbeat AND a
  // live-pid lock holder, not freshness alone). Only when repoKey itself is
  // UNRESOLVABLE (non-git cwd already excluded by gitTop above; this covers
  // git-unavailable / a corrupt .git / a load failure) does this fall BACK to
  // the legacy freshness-only worktreeHash-keyed read — pre-mesh back-compat
  // for a heartbeat file an OLDER per-worktree daemon may have left, which
  // never had a project-shaped lock to check. Any failure anywhere in this
  // block -> no banner, hook proceeds byte-identical.
  let staleBanner = null;
  try {
    if (rows.length > 0 || (gitTop && !repoKey)) {
      let ingestHealthMod = null;
      try { ingestHealthMod = require('../companion/lib/ingest-health.js'); } catch (_) { ingestHealthMod = null; }

      if (ingestHealthMod && repoKey) {
        let beatTs = null;
        try {
          const beat = JSON.parse(fs.readFileSync(ingestHealthMod.ingestHeartbeatPath(home, repoKey), 'utf8'));
          beatTs = beat && Number.isFinite(beat.ts) ? beat.ts : null;
        } catch (_) { beatTs = null; } // missing/unreadable/malformed heartbeat -> unknown age
        const health = ingestHealthMod.daemonHealth(home, repoKey, { now });
        if (health.status === 'stale') staleBanner = buildStaleBanner(beatTs, now);
      } else if (typeof devswarmIngest.ingestHeartbeatPath === 'function' && worktreeHash) {
        let beatTs = null;
        try {
          const beat = JSON.parse(fs.readFileSync(devswarmIngest.ingestHeartbeatPath(home, worktreeHash), 'utf8'));
          beatTs = beat && Number.isFinite(beat.ts) ? beat.ts : null;
        } catch (_) { beatTs = null; }
        if (beatTs === null || (now - beatTs) > HEARTBEAT_STALE_MS) {
          staleBanner = buildStaleBanner(beatTs, now);
        }
      }
    }
  } catch (_) { staleBanner = null; }

  const segments = [];

  // Daemon-freshness staleness banner, when present, is injected FIRST — above
  // the table AND independent of rows.length (the legacy-fallback back-compat
  // path can fire the banner even with zero active workspaces, since repoKey —
  // and therefore the shared summary rows — may be unresolvable in exactly the
  // scenario that path exists for).
  if (staleBanner) segments.push(staleBanner);

  // Live workspace table — the always-on status overview the Primary reads
  // every turn. Attention-needed rows (escalated/stale) sort to the top; ties by
  // unread desc, then id. Capped at MAX_TABLE_ROWS with a logged "+N more".
  if (rows.length) {
    rows.sort((a, b) => (a.rank - b.rank) || (b.unread - a.unread) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const capped = rows.length > MAX_TABLE_ROWS;
    const shown = capped ? rows.slice(0, MAX_TABLE_ROWS) : rows;
    if (capped) logTableCap(home, rows.length, shown.length);
    segments.push(buildWorkspaceTable(shown, now, capped, rows.length - shown.length));
  }

  // Broadcast/roster feed (D3/D4/D22/D23/D27, Phase 8 step 2) — the shared
  // summary's top-level `recent[]` (plain broadcasts + heartbeats alike, D22),
  // rendered ADVISORY ONLY: this is roster/FYI context, NEVER a Stop-gate
  // trigger and NEVER mechanically dispatched — "react only if concerned" is
  // left to the model's own judgement (D27, no concerned-classifier invented).
  if (summary && Array.isArray(summary.recent) && summary.recent.length) {
    segments.push(buildBroadcastSegment(summary.recent));
  }

  // The Primary's OWN unread is its own top-priority item — surfaced ahead of
  // the children's unread/idle summary.
  if (ownUnread > 0 && primaryId) {
    segments.push(buildOwnUnreadSegment(ownUnread, primaryId, ownUrgencyMax));
  }

  // v0.57 mesh (D4, Phase 8 step 2): tier the child-unread attention list by
  // urgencyMax — urgent/high gets the LOUDEST buildUrgentUnreadSegment; low is
  // TABLE-ROW-ONLY (already shown in the live table above, deliberately
  // excluded from every textual segment); everything else (null/'normal'/
  // unrecognized, incl. stuck-only entries carrying no urgency at all) keeps
  // the EXISTING buildUnreadSegment wording byte-for-byte — the back-compat
  // default (edge_cases: "unknown urgency -> treat as normal").
  if (attention.length) {
    const urgentList = attention.filter((w) => tierOf(w) === 'urgent');
    const normalList = attention.filter((w) => tierOf(w) === 'normal');
    if (urgentList.length) segments.push(buildUrgentUnreadSegment(urgentList));
    if (normalList.length) segments.push(buildUnreadSegment(normalList));
    // Acceptance telemetry only when there is genuine unread backlog (not merely a
    // sticky escalated verdict with an empty inbox).
    const totalUnread = attention.reduce((s, w) => s + w.unread, 0);
    if (totalUnread > 0) logInjection(home, attention.filter((w) => w.unread > 0));
  }
  if (archiveList.length) {
    segments.push(buildArchiveSegment(archiveList));
    // Record the nudge only once it is actually being surfaced this turn.
    for (const id of archiveList) markArchiveNudged(home, id, now);
  }

  const additionalContext = segments.join('\n\n');
  if (!additionalContext) return; // EMPTY -> no stdout (zero-cost)

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: any error -> no output, exit 0.
}
process.exit(0);
