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
const { readDescriptors } = require('../companion/devswarm-supervisor.js');
const {
  devswarmRoot,
  livenessPathFor,
  isSafeId,
  DEFAULT_COOLDOWN_MS,
} = require('../companion/lib/liveness.js');
const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');
// worktreeHash: the SAME per-worktree identity install-devswarm-ingest.js baked
// into the daemon's unit (and devswarm-ingest.js keys its heartbeat file by).
// ingestHeartbeatPath: the per-worktree daemon LIVENESS file (rewritten every
// sweep, even a 0-insert one) — see the staleness banner below.
const installIngest = require('../companion/install-devswarm-ingest.js');
const devswarmIngest = require('../companion/devswarm-ingest.js');
// hashFromWorkspaceId: the per-project store now keys summaries/<hash>.json by
// EACH descriptor's OWN id (not by the hook's cwd worktree hash) — see the
// per-descriptor summary resolution below. Same helper the store itself uses to
// derive/write a workspace's summary, so the hook agrees byte-for-byte on which
// file holds a given descriptor's data.
const { hashFromWorkspaceId } = require('../companion/lib/devswarm-store.js');

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
// The store writes one summary per project, keyed by hashFromWorkspaceId of the
// workspace id that project's data belongs to (see summaryForDescriptor in
// main() — each descriptor resolves its OWN hash, not the hook's cwd worktree
// hash). `hash` null -> null (readSummary then fails open to "no data").
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

// buildOwnUnreadSegment(count, id) -> string. IMPERATIVE PRIORITY wording for the
// Primary's OWN inbound unread (#34 fix — the Primary previously had no visibility
// into its own unread parent/peer backlog, only children's). Parity with the
// child's own imperative nudge (devswarm-child-turn.js buildUnreadSegment:167-176,
// #29): the Primary must not treat its own unread messages as optional either.
function buildOwnUnreadSegment(count, id) {
  return (
    'DEVSWARM OWN INBOX — PRIORITY: you have ' + count + ' unread parent/peer '
    + 'message(s) addressed to YOU (the Primary). STOP and read your unread '
    + 'parent/peer message(s) FIRST before continuing. Read them the SAFE, '
    + 'NON-DRAINING way — `devswarm.js inbox read-primary ' + id + '` (anti-hall '
    + 'devswarm CLI). Do NOT run `hivecontrol workspace read-messages` or '
    + '`monitor` — those DESTRUCTIVELY drain the native queue.'
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
  // Resolve the CURRENT worktree's hash ONCE (pure fs walk, no git spawn) — it
  // keys the per-project summary read, the daemon-heartbeat staleness banner
  // below, AND (#34) the Primary's OWN workspace id (primary-<hash>, the SAME
  // convention install-devswarm-ingest.js's primaryWorkspaceId + the ingest
  // daemon already use) so its own inbound unread can be resolved from the same
  // summary projection. Fail-open: any failure -> null -> no summary data, no
  // banner, no own-unread segment.
  let worktreeHash = null;
  let primaryId = null;
  try {
    const top = cwd ? findGitToplevel(cwd) : null;
    worktreeHash = top ? installIngest.worktreeHash(top) : null;
    primaryId = top ? installIngest.primaryWorkspaceId(top) : null;
  } catch (_) { worktreeHash = null; primaryId = null; }

  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }

  const attention = []; // { id, unread, cursor, total, status }
  const archiveList = [];
  const rows = []; // live-table row per ACTIVE workspace: { id, label, rank, finish, unread, lastActivityTs }

  // Per-descriptor summary cache: the store keys summaries/<hash>.json by EACH
  // descriptor's OWN id (hashFromWorkspaceId(d.id)), NOT by the hook's cwd
  // worktree hash — every descriptor other than the one matching cwd would
  // otherwise silently read the WRONG (cwd's) summary. Cache by hash so two
  // descriptors sharing a hash only trigger one fs read.
  const summaryCache = new Map(); // hash -> summary object | null
  function summaryForDescriptor(id) {
    const hash = hashFromWorkspaceId(id);
    if (summaryCache.has(hash)) return summaryCache.get(hash);
    let s = null;
    try { s = readSummary(home, hash); } catch (_) { s = null; }
    summaryCache.set(hash, s);
    return s;
  }

  // #36 cross-project-bleed fix: exclude a descriptor ONLY when BOTH this
  // session's and the descriptor's repoId are present and DIFFER — fail-open by
  // construction. An old descriptor with no repoId (pre-#36) or a session with
  // no DEVSWARM_REPO_ID (manual supervisor mode) disables the filter entirely,
  // so nothing that showed before this fix can vanish; it only stops a Primary
  // in project A from being surfaced project B's workspaces.
  const currentRepoId = process.env.DEVSWARM_REPO_ID;
  for (const d of descriptors) {
    if (!d || !isSafeId(d.id)) continue;
    if (currentRepoId && d.repoId && d.repoId !== currentRepoId) continue;
    const summary = summaryForDescriptor(d.id);
    // --- unread / idle ---
    let unread = 0, cursor = 0, total = 0;
    try {
      const u = readUnread(d.inboxPath, d.cursorPath);
      unread = u.known ? u.count : 0;
      cursor = u.cursor;
      total = u.total;
    } catch (_) {}
    const verdict = readVerdictFile(home, d.id);
    const status = verdictStatus(summary, d.id, verdict);
    const stuck = status !== null && STUCK_STATUSES.has(status);
    if (unread > 0 || stuck) {
      attention.push({ id: d.id, unread, cursor, total, status });
    }

    // --- archive-ready recommendation (P1-E) ---
    const archiveReady = isArchiveReady(d.id, summary);
    try {
      if (archiveReady && !isArchiveIgnored(home, d.id)
          && archiveCooldownElapsed(home, d.id, now)) {
        archiveList.push(d.id);
      }
    } catch (_) {}

    // --- live-table row (every ACTIVE workspace, every turn) ---
    try {
      const heartbeat = readHeartbeat(home, d.id);
      const ds = displayStatus(archiveReady, status);
      rows.push({
        id: d.id,
        label: ds.label,
        rank: ds.rank,
        finish: finishingRate(summary, d.id, heartbeat),
        unread,
        lastActivityTs: lastActivityTs(verdict, heartbeat),
      });
    } catch (_) {}
  }

  // --- Primary's OWN inbound unread (#34) ---
  // Unlike a child, the Primary has no descriptor with its own inboxPath/
  // cursorPath to read via readUnread — its inbound is ingested by the daemon
  // directly into the store under workspaceId primary-<worktreeHash> and exposed
  // ONLY via the summary projection (summaries/<worktreeHash>.json ->
  // workspaces[primary-<hash>].unread), the SAME projection already read above
  // for each child's status/gates. Reuses summaryForDescriptor so a primaryId
  // sharing worktreeHash costs no extra fs read. Fail-open: any failure -> 0.
  let ownUnread = 0;
  try {
    if (primaryId) {
      const ownSummary = summaryForDescriptor(primaryId);
      const ownEntry = summaryEntry(ownSummary, primaryId);
      if (ownEntry && Number.isFinite(ownEntry.unread) && ownEntry.unread > 0) {
        ownUnread = ownEntry.unread;
      }
    }
  } catch (_) { ownUnread = 0; }

  // Daemon-LIVENESS staleness banner (fail-open). Rewired (was: summary.json's
  // generatedAt, which only advances on inserted>0 and false-reads a live-but-
  // QUIET daemon as stale) to key off the daemon's own heartbeat instead
  // (heartbeats/ingest-<hash>.json, rewritten EVERY sweep regardless of inserts —
  // see writeIngestHeartbeat in devswarm-ingest.js). Gated on rows.length>0 (an
  // active workspace exists, i.e. a daemon is EXPECTED to be running) so an idle
  // system with no workspaces never false-alarms. The CURRENT worktree hash is
  // resolved the same way install-devswarm-ingest.js baked it into the daemon's
  // unit at install time (git-toplevel, hashed via its own worktreeHash) — via a
  // PURE fs walk (findGitToplevel), never a git spawn. Any failure anywhere in
  // this block (no cwd, no toplevel found, missing helper export, unreadable
  // heartbeat file) -> no banner, hook proceeds byte-identical.
  let staleBanner = null;
  try {
    if (rows.length > 0 && typeof devswarmIngest.ingestHeartbeatPath === 'function') {
      const hash = worktreeHash; // resolved once above (same per-project key as the summary read)
      if (hash) {
        let beatTs = null;
        try {
          const beat = JSON.parse(fs.readFileSync(devswarmIngest.ingestHeartbeatPath(home, hash), 'utf8'));
          beatTs = beat && Number.isFinite(beat.ts) ? beat.ts : null;
        } catch (_) { beatTs = null; } // missing/unreadable/malformed heartbeat -> unknown age
        if (beatTs === null || (now - beatTs) > HEARTBEAT_STALE_MS) {
          staleBanner = buildStaleBanner(beatTs, now);
        }
      }
    }
  } catch (_) { staleBanner = null; }

  const segments = [];

  // Live workspace table FIRST — the always-on status overview the Primary reads
  // every turn. Attention-needed rows (escalated/stale) sort to the top; ties by
  // unread desc, then id. Capped at MAX_TABLE_ROWS with a logged "+N more". A
  // daemon-freshness staleness banner, when present, is injected immediately ABOVE
  // the table so the Primary sees the data may be frozen before reading it.
  if (rows.length) {
    rows.sort((a, b) => (a.rank - b.rank) || (b.unread - a.unread) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const capped = rows.length > MAX_TABLE_ROWS;
    const shown = capped ? rows.slice(0, MAX_TABLE_ROWS) : rows;
    if (capped) logTableCap(home, rows.length, shown.length);
    if (staleBanner) segments.push(staleBanner);
    segments.push(buildWorkspaceTable(shown, now, capped, rows.length - shown.length));
  }

  // The Primary's OWN unread is its own top-priority item — surfaced ahead of
  // the children's unread/idle summary.
  if (ownUnread > 0 && primaryId) {
    segments.push(buildOwnUnreadSegment(ownUnread, primaryId));
  }

  if (attention.length) {
    segments.push(buildUnreadSegment(attention));
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
