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
//   - v0.58 "mesh-only messaging": additionalContext is NO LONGER empty on a quiet
//     turn — OVERRIDE_REASSERT (a terse, <=160-char per-turn re-assertion of the
//     SessionStart COMMUNICATION OVERRIDE, devswarm-child-role.js) is now injected
//     UNCONDITIONALLY on every Primary DevSwarm turn, ahead of every other segment.
//     This is a deliberate, small, fixed per-turn cost (one short line) traded for
//     resistance to model habituation/drift back toward native messaging across
//     many quiet turns. Every OTHER segment below still follows the original
//     empty-when-nothing-to-report discipline.
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
const livenessLib = require('../companion/lib/liveness.js');
// worktreeHash: the SAME per-worktree identity install-devswarm-ingest.js baked
// into the daemon's unit (and devswarm-ingest.js keys its heartbeat file by).
// ingestHeartbeatPath: the per-worktree daemon LIVENESS file (rewritten every
// sweep, even a 0-insert one) — see the staleness banner below.
const installIngest = require('../companion/install-devswarm-ingest.js');
const devswarmIngest = require('../companion/devswarm-ingest.js');
// idleThresholdMs / lastActivityTs / readHeartbeat: this view's own "is this
// workspace idle" signal, consumed ONLY here (see that module's header) — NOT
// shared with devswarm-parent-gate.js's Stop-hook neglect gate, which was
// deliberately kept OFF freshness/age (a freshness-based exclusion was tried
// there and rejected on review; the gate classifies unread CONTENT instead,
// via companion/lib/devswarm-noise.js).
const freshness = require('./lib/devswarm-freshness.js');
// devswarm-names.js (task #6): READ-ONLY on this hot path — readName() is a
// pure fs projection read (never a hivecontrol spawn), matching this file's
// own "fs-backed projections only" contract for a UserPromptSubmit hook that
// fires every turn. Writers (spawn seed + reconcile backfill) live in
// scripts/devswarm.js, off this hot path.
const names = require('../companion/lib/devswarm-names.js');

// B1 self-heal hardening (H4): structured logging via the shared C0 logger
// when present, falling back to a console.error-only shim so this hook never
// depends on that module existing — this hook's own fail-open contract
// (Contract block above: "exit 0: always") must never regress on a missing
// logger.
let alog;
try { alog = require('../companion/lib/anti-hall-log.js'); } catch (_) {
  alog = {
    logError: function () { try { console.error.apply(console, arguments); } catch (_e) {} },
    logEvent: function () {},
  };
}

// CLI — the ABSOLUTE path to anti-hall's DevSwarm CLI wrapper, resolved ONCE
// from this hook's own on-disk location. The Primary's cwd is its own project
// worktree, not the plugin root, so a bare/relative "devswarm.js" reference in
// emitted text is unrunnable there — every emitted instruction below embeds
// this absolute path instead (P1 fix).
const CLI = path.join(__dirname, '..', 'scripts', 'devswarm.js');

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
// Cap for the orphan/stale-registry mesh-issue lines below (LEAN surfacing —
// this cap is the ONLY anti-spam; no persisted first-seen/cooldown state).
const MAX_MESH_ISSUES = 5;
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

// How long a row may sit with no fresh activity signal (lastActivityTs — the
// SAME per-row freshness value already computed for the table's "last" column,
// reused here rather than re-derived) before this VIEW demotes its default
// "active" label to "idle". This is a display-only demotion (registry-staleness
// fix): nothing here archives, deletes, or touches gates — a workspace stuck in
// the default "active" label forever (because gates are only ever set by the
// manual `devswarm.js gate` verb and rows are only ever removed by manual
// `archive`) was misleading the Primary into treating a long-dormant workspace
// as current. 6 hours is a defensible default: long enough that a normal lull
// between turns/sessions never false-positives, short enough that a workspace
// idle since yesterday reads as "idle", not "active", on today's first turn.
// Override via ANTIHALL_DEVSWARM_IDLE_MS (ms, not seconds — this file already
// keeps every other threshold in raw ms, e.g. HEARTBEAT_STALE_MS above; distinct
// from the unrelated ANTIHALL_DEVSWARM_IDLE_SEC read by devswarm-supervisor.js,
// which governs the liveness supervisor's nudge/escalate cadence, not this
// view's label). The threshold + activity-signal math now live in the
// freshness module (see the `freshness` require above); this display-only
// "idle" label is NOT consumed by devswarm-parent-gate.js's Stop-hook neglect
// gate — see that require's own comment.

// OVERRIDE_REASSERT — terse (<=160 char) per-turn re-assertion of the SessionStart
// COMMUNICATION OVERRIDE (devswarm-child-role.js, both roles): DevSwarm's own
// `--system-prompt-file` REPLACES the system prompt at every child spawn, and a
// quiet Primary session can drift back toward native messaging over many turns
// with nothing else to report — exactly when this re-assertion matters most.
// v0.58: injected UNCONDITIONALLY whenever this session is an active DevSwarm
// Primary (the ONE deliberate departure from this hook's prior "EMPTY when
// nothing to report" zero-cost contract — see main()). Avoids the literal
// `message-child`/`message-parent` strings (uses the `message-*` wildcard form)
// so it never re-introduces the blocked native verbs into emitted hook text.
const OVERRIDE_REASSERT =
  'DEVSWARM COMMS OVERRIDE: mesh only — native hivecontrol messaging blocked. ' +
  'Check: `roster` / `mesh read`. Direct: `send --to <meshId>`.';

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

// readHeartbeat / lastActivityTs now live in the SHARED freshness module (see
// the `freshness` require above) — called at their use sites below as
// `freshness.readHeartbeat` / `freshness.lastActivityTs`.

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

// displayStatus(archiveReady, status, activityTs, now, dormant) -> { label, rank }.
// Collapses the raw verdict enum into the five surfaced states and assigns a
// sort rank so attention-needed workspaces sort first: escalated (0) > stale
// (1, incl. nudged) > archive-ready (2) > idle (3) > active (4). escalated
// outranks archive-ready: a wedged child needing a human beats a tidy teardown
// recommendation. `idle` (registry-staleness fix) is a VIEW-ONLY demotion of the
// "active" default for a row whose lastActivityTs is older than
// idleThresholdMs() — it never overrides escalated/stale (a wedged/stuck child
// is never "merely idle") or archive-ready (a done workspace should read as
// archive-ready, not idle, even though it is typically also long-idle).
// activityTs null/non-finite (no activity signal yet) -> stays "active", same
// as before this change (fail toward the prior default, not a guess).
//
// `dormant` (param, rank 5, sorts LAST — below even `active`) is a caller-
// SUPPLIED boolean: the read-side liveness demotion decided by
// companion/lib/liveness.js's isDormantRow (the ONE read-side dormancy rule —
// see that function's own doc for why the window it picks depends on whether
// this row's transcript term actually resolved). displayStatus itself stays a
// PURE, easily-unit-tested function that only collapses an already-decided
// verdict into a label/rank — it does not re-derive dormancy from activityTs
// (P1 fix: doing so here could only ever apply ONE fixed window uniformly,
// which is exactly the bug — a tight window misreads a live child mid-long-
// turn as dead whenever the transcript term didn't contribute for that row).
//
// IT DEMOTES, IT DOES NOT HIDE. A dormant row still renders in the table, still
// carries its unread count, and is only pushed to the bottom of the sort. That is
// deliberate and is what makes the anti-blinding guarantee STRUCTURAL rather than
// threshold-dependent: even if the threshold is one day mistuned tight enough to
// demote a genuinely-live-but-quiet child, that child is still visible — it is
// merely ranked below the demonstrably-active ones. Nothing here can make a live
// workspace disappear.
//
// It is checked BELOW escalated / stale / archive-ready so a wedged child needing
// a human, or a finished one ready to archive, keeps its louder label regardless of
// heartbeat age. It is checked ABOVE `idle` because dormancy is the stronger claim
// about the same axis; with the default windows (30 min dormant vs 6 h idle) `idle`
// is consequently reached only when ANTIHALL_DEVSWARM_DORMANT_MS is configured
// WIDER than ANTIHALL_DEVSWARM_IDLE_MS, which is why that branch is kept.
function displayStatus(archiveReady, status, activityTs, now, dormant, notDraining) {
  if (status === 'escalated') return { label: 'escalated', rank: 0 };
  if (status === 'stale' || status === 'nudged') return { label: 'stale', rank: 1 };
  // not-draining (liveness.js unionPendingFor's `notDraining`, item 3): a live/
  // alive workspace whose union-unread backlog has sat past NOT_DRAINING_AGE_MS
  // regardless of activity — distinct from `stale`/`escalated` (those are
  // ACTIVITY axis; this is the COORDINATION axis) so it must not be folded into
  // either label. REPORT/ESCALATE ONLY (never gates a kill); sorts just behind
  // stale/escalated since it names a real, aging neglect signal.
  if (notDraining) return { label: 'not-draining', rank: 1.5 };
  if (archiveReady) return { label: 'archive-ready', rank: 2 };
  if (dormant) {
    return { label: 'dormant', rank: 5 };
  }
  if (Number.isFinite(activityTs) && Number.isFinite(now) && (now - activityTs) >= freshness.idleThresholdMs(process.env)) {
    return { label: 'idle', rank: 3 };
  }
  return { label: 'active', rank: 4 };
}

// riskMarker(r) -> string (possibly empty). REPORT-ONLY git ground-truth
// marker appended to a row's workspace TITLE cell (never a new column — using
// the existing title convention keeps this additive to the table's fixed
// column set). noUpstream takes priority over a bare unpushed count (a
// no-upstream branch's unpushed count is meaningless — there is nothing to
// diff against @{u}); a separate `merged (unverified)` marker is appended for
// an archive-ready row whose merged gate was self-declared but never proven
// by git ancestry (mergedVerified !== true covers both `false` and
// unset/undefined — "lacking verification" either way). Never blocks or
// implies anything beyond "look before archiving".
function riskMarker(r) {
  const parts = [];
  if (r.noUpstream) parts.push('⚠ no upstream');
  else if (Number.isFinite(r.unpushed) && r.unpushed > 0) parts.push('⚠ ' + r.unpushed + ' unpushed');
  if (r.label === 'archive-ready' && r.mergedVerified !== true) parts.push('merged (unverified)');
  return parts.length ? ' ' + parts.join(', ') : '';
}

// buildWorkspaceTable(rows, now, capped, hidden, hiddenRows) -> string. Compact
// markdown table of the ACTIVE workspaces (one row each): workspace, status,
// finishing rate, unread, last-activity. Rows are pre-sorted + already capped by
// the caller. `hiddenRows` (optional) is the EVICTED slice (dormant rows sort
// last, so they are evicted first) — named in the overflow line so a capped-out
// row never silently vanishes behind a bare count.
function buildWorkspaceTable(rows, now, capped, hidden, hiddenRows) {
  const lines = [
    'DEVSWARM WORKSPACES (refreshed every turn):',
    '| workspace | status | finish | unread | last |',
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    // Task #6: "name (shortid)" when a name is cached, else the bare UUID
    // (names.displayName's own fallback). Escape a literal `|` in the name
    // (free-text from a brief/hivecontrol title) so it can never break this
    // markdown table's column structure.
    const workspaceCol = names.displayName(r.id, r.wsName).replace(/\|/g, '\\|') + riskMarker(r);
    lines.push(
      '| ' + workspaceCol + ' | ' + r.label + ' | ' + r.finish + ' | ' + r.unread
      + ' | ' + formatRelative(r.lastActivityTs, now) + ' |'
    );
  }
  // One-line legend, emitted ONLY when a dormant row is actually shown: the
  // Primary must not read a dormant row as a workspace still worth chasing or
  // nagging the owner to close. Costs nothing when every row is live.
  if (rows.some((r) => r.label === 'dormant')) {
    lines.push('dormant = no recent activity signal; often a workspace already CLOSED in the app — verify before nagging to close. If it has unread or a pending question, still answer it.');
  }
  if (rows.some((r) => r.label === 'not-draining')) {
    lines.push('not-draining = a union-unread backlog has sat undrained >20m — a coordination signal independent of activity/liveness; poke or escalate, report/escalate only, never auto-killed.');
  }
  if (capped) {
    // Name the hidden rows (capped at 8 ids + ellipsis, so a huge overflow
    // cannot bloat the injection) instead of a bare count — dormant rows sort
    // last and are evicted first, so without this a demoted-but-live workspace
    // could vanish behind "+N more" with no way to even know its id.
    let overflow = '+' + hidden + ' more (capped at ' + MAX_TABLE_ROWS + ')';
    if (Array.isArray(hiddenRows) && hiddenRows.length) {
      const ids = hiddenRows.slice(0, 8).map((r) => names.shortId(r.id));
      overflow += ': ' + ids.join(', ') + (hiddenRows.length > 8 ? ', …' : '');
    }
    lines.push(overflow);
  }
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

// MAX_TREND_LOG_BYTES — item 6 ("trend vs the last persisted logInjection
// entry"): parent-inbox.log has no rotation, so it can grow unbounded over a
// long session. Bound the read rather than parse an ever-growing file every
// turn — beyond this cap, trend is silently omitted (fail-open, per item 6's
// own "fail-open to omitting trend" clause), never a thrown error.
const MAX_TREND_LOG_BYTES = 2 * 1024 * 1024;

// lastInjectedUnread(home, id) -> number | null. The `unread` count this
// workspace carried in the MOST RECENT prior 'inject' telemetry line (read
// BEFORE this turn's own logInjection() call, so it is always a strictly
// earlier turn's snapshot — never this turn's). Read-only, fail-open: a
// missing/oversized/corrupt log, or no prior entry for this id, is `null`
// (never fabricated, never thrown).
function lastInjectedUnread(home, id) {
  try {
    const p = parentInboxLogPath(home);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0 || st.size > MAX_TREND_LOG_BYTES) return null;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      if (!rec || rec.event !== 'inject' || !Array.isArray(rec.workspaces)) continue;
      const w = rec.workspaces.find((x) => x && x.id === id);
      if (w && Number.isFinite(w.unread)) return w.unread;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// trendLabel(home, id, currUnread) -> 'rising' | 'flat' | 'falling' | null
// (null when no prior snapshot exists — fail-open to omitting trend, item 6).
function trendLabel(home, id, currUnread) {
  const prev = lastInjectedUnread(home, id);
  if (!Number.isFinite(prev)) return null;
  if (currUnread > prev) return 'rising';
  if (currUnread < prev) return 'falling';
  return 'flat';
}

// truncateTitle(s, max) -> `s` capped at ~48 chars (item 5: "Workspace TITLE
// (truncate ~48 chars) in human-facing text; mesh id ONLY inside command
// strings") — a workspace's cached free-text name/title (companion/lib/
// devswarm-names.js) is operator-authored and unbounded; this keeps a long
// title from bloating the per-turn injection.
function truncateTitle(s, max) {
  const str = String(s == null ? '' : s);
  const limit = max || 48;
  return str.length > limit ? str.slice(0, limit) + '…' : str;
}

// buildUnreadSegment(list) -> string. SHORT summary of the unread/idle workspaces.
// ADVISORY wording for the unread case (softened from a per-turn "STOP ...
// before continuing" imperative — urgent/high items never reach this function:
// the call site filters tierOf(w) === 'normal' here and routes tierOf(w) ===
// 'urgent' to buildUrgentUnreadSegment below, which stays loud. This is the
// normal tier by construction, so a hard interrupt every turn is unwarranted.
//
// CHILD NOT DRAINING (item 5, root cause b fix): this list names workspaces
// the PRIMARY sent messages to that the CHILD has not yet drained — it used
// to prescribe `inbox read <id>` as the "fix", but that command NEVER
// advances any cursor (root cause b — see companion/lib/devswarm-unread.js's
// header). The actual remedy for an unresponsive child is poke/escalate
// guidance, not a re-read; this segment now says so instead. Workspace TITLE
// (companion/lib/devswarm-names.js's displayName, truncated) is used in the
// human-facing list — the raw mesh id stays reserved for command strings.
// `oldest Xm` (item 6, when known) is the AGE of that workspace's oldest
// still-undrained message (companion/lib/devswarm-store.js computeSummary's
// oldestDirectUnreadTs, a zero-extra-read projection field).
function buildUnreadSegment(list, home) {
  const now = Date.now();
  const shown = list.slice(0, MAX_LISTED).map((w) => {
    const title = truncateTitle(names.displayName(w.id, w.wsName));
    const parts = [];
    if (w.unread > 0) parts.push(w.unread + ' unread');
    if (w.status && STUCK_STATUSES.has(w.status)) parts.push(w.status);
    if (w.notDraining) parts.push('NOT DRAINING >20m'); // item 3: distinct from stale/escalated
    if (Number.isFinite(w.oldestUnreadTs)) parts.push('oldest ' + formatRelative(w.oldestUnreadTs, now));
    // item 6 (trend, vs the last persisted logInjection entry): fail-open to
    // omitting when unknown (no prior snapshot / log too large / read error).
    const trend = home ? trendLabel(home, w.id, w.unread) : null;
    if (trend) parts.push(trend);
    return title + (parts.length ? ' (' + parts.join(', ') + ')' : '');
  });
  const extra = list.length > MAX_LISTED ? ' +' + (list.length - MAX_LISTED) + ' more' : '';
  const anyUnread = list.some((w) => w.unread > 0);
  let body = (
    'DEVSWARM PARENT INBOX: ' + list.length + ' active workspace(s) need attention — '
    + shown.join('; ') + extra + '. '
  );
  body += anyUnread
    ? ('CHILD NOT DRAINING: these are message(s) YOU sent that the child has NOT yet '
      + 'drained. Poke it (`node ' + CLI + ' send --to <id> --message "..."`) or '
      + 'escalate/reassign it — do not assume it has seen the backlog just because '
      + 'time has passed. ')
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
function buildUrgentUnreadSegment(list, home) {
  const shown = list.slice(0, MAX_LISTED).map((w) => {
    const parts = [w.unread + ' unread'];
    if (w.status && STUCK_STATUSES.has(w.status)) parts.push(w.status);
    if (w.notDraining) parts.push('NOT DRAINING >20m');
    const trend = home ? trendLabel(home, w.id, w.unread) : null; // item 6, fail-open
    if (trend) parts.push(trend);
    return w.id + ' (' + parts.join(', ') + ')';
  });
  const extra = list.length > MAX_LISTED ? ' +' + (list.length - MAX_LISTED) + ' more' : '';
  // Root cause b fix (same as buildUnreadSegment above): `inbox read <id>`
  // never advances any cursor — it is not a remedy. STOP and poke/escalate
  // the unresponsive child instead.
  return (
    'DEVSWARM URGENT INBOX: ' + list.length + ' workspace(s) have an URGENT/HIGH-priority '
    + 'direct message waiting, unread — ' + shown.join('; ') + extra + '. CHILD NOT DRAINING: '
    + 'STOP and poke it NOW (`node ' + CLI + ' send --to <id> --message "..."`) or escalate — '
    + 'do not wait to see if it drains on its own — before continuing.'
  );
}

// buildOwnUnreadSegment(count, id, urgencyMax, unanswered) -> string. IMPERATIVE
// PRIORITY wording for the Primary's OWN inbound unread (#34 fix — the Primary
// previously had no visibility into its own unread parent/peer backlog, only
// children's). Parity with the child's own imperative nudge (devswarm-child-
// turn.js buildUnreadSegment:167-176, #29): the Primary must not treat its own
// unread messages as optional either. v0.57 mesh (D4, Phase 8 step 4):
// `urgencyMax` (the highest urgency among the Primary's own pending directs,
// from the summary projection) is HONORED in the wording — urgent/high gets an
// explicit "URGENT" prefix — but NEVER changes whether this is surfaced; a
// DIRECT always gates/surfaces regardless of urgency (D4's type-vs-urgency
// separation — urgency governs tier/loudness only).
//
// `unanswered` (decide+reply gate, §4.5): the subset of this same summary
// entry's pendingQuestions (companion/lib/devswarm-store.js's computeSummary)
// that unansweredQuestions() (companion/lib/devswarm-reply-state.js, §4.3)
// judged still unanswered for THIS session. This is the CORE fix for claim 1 —
// this hook fires on EVERY UserPromptSubmit turn (unlike the SessionStart-only
// devswarm-child-role.js injection), so once wired here the decide+reply
// instruction survives context compaction. Strictly additive when count > 0:
// when `unanswered` is empty (plain unread, no flagged question, or the
// question(s) were already replied to), the base paragraph below is UNCHANGED
// from before this fix — only a non-empty `unanswered` appends the extra
// DECIDE+REPLY paragraph, naming each asker's id (capped at MAX_LISTED,
// same convention as buildUnreadSegment/buildArchiveSegment above). `q.from`
// is now a REGISTRY ROW id (resolveSenderRegistryId in devswarm-store.js
// normalizes it), not necessarily the sender's raw meshId, though both work
// as a `send --to` target (resolveSendTarget) — the wording below says
// `<id>`, not `<meshId>`, to avoid implying it must be a meshId specifically.
//
// count === 0 branch (regression fix): under the mesh semantics
// (companion/lib/devswarm-store.js's computeSummary) pendingQuestions is no
// longer cursor/unread-scoped — reading/acking a message no longer clears it,
// only a matching reply-state entry does (companion/lib/devswarm-reply-
// state.js's unansweredQuestions). That makes "fully read, unread === 0, but
// a question is still unanswered" a REAL and REACHABLE state, so the call
// site below now invokes this function whenever EITHER count > 0 OR
// unanswered is non-empty — this branch supplies wording for the
// unread-already-drained-to-0 case, since the normal "STOP and read your
// unread message(s)" phrasing would be nonsensical with nothing unread.
function buildOwnUnreadSegment(count, id, urgencyMax, unanswered) {
  const unansweredList = Array.isArray(unanswered) ? unanswered : [];
  const prefix = isHighUrgency(urgencyMax) ? 'DEVSWARM OWN INBOX — URGENT PRIORITY: ' : 'DEVSWARM OWN INBOX — PRIORITY: ';

  if (count > 0) {
    let body = (
      prefix + 'you have ' + count + ' unread parent/peer '
      + 'message(s) addressed to YOU (the Primary). STOP and read your unread '
      + 'parent/peer message(s) FIRST before continuing. Read them the SAFE, '
      + 'NON-DRAINING way — `node ' + CLI + ' inbox read-primary ' + id + '` (anti-hall '
      + 'devswarm CLI). Do NOT run `hivecontrol workspace read-messages` or '
      + '`monitor` — those DESTRUCTIVELY drain the native queue.'
    );
    if (unansweredList.length > 0) {
      const askers = unansweredList.slice(0, MAX_LISTED).map(
        (q) => (q && q.from != null) ? String(q.from) : '?'
      );
      const extra = unansweredList.length > MAX_LISTED
        ? ' +' + (unansweredList.length - MAX_LISTED) + ' more' : '';
      // unansweredList is deliberately NOT cursor/unread-scoped (see the
      // comment above this function), while `count` IS the unread total —
      // unansweredList.length can legitimately exceed count. When it does,
      // "N of these" would wrongly claim the unanswered questions are a
      // subset of the just-announced unread set, so that phrasing is only
      // used when the subset claim actually holds; otherwise the sentence
      // stands on its own (still fully plural/singular-correct).
      const questionClause = unansweredList.length <= count
        ? (unansweredList.length === 1
            ? '1 of these is an unanswered QUESTION'
            : unansweredList.length + ' of these are unanswered QUESTIONS')
        : (unansweredList.length === 1
            ? '1 unanswered QUESTION remains (not necessarily among the unread above)'
            : unansweredList.length + ' unanswered QUESTIONS remain (not necessarily among the unread above)');
      body += (
        ' READING IS NOT SUFFICIENT: ' + questionClause
        + ' from ' + askers.join(', ') + extra + ' — you must DECIDE from context and '
        + 'REPLY, not merely read, via `node ' + CLI + ' send --to <id> --message "..."` '
        + '(use the asker\'s id above as <id>).'
      );
    }
    return body;
  }

  // count === 0 but unansweredList.length > 0 (the only other case the call
  // site now invokes this function for): a fully read/acked backlog that
  // still holds a genuinely unanswered question. There is nothing left to
  // "read", so this wording skips the read-primary instruction entirely and
  // goes straight to the decide+reply nag.
  const askers = unansweredList.slice(0, MAX_LISTED).map(
    (q) => (q && q.from != null) ? String(q.from) : '?'
  );
  const extra = unansweredList.length > MAX_LISTED
    ? ' +' + (unansweredList.length - MAX_LISTED) + ' more' : '';
  return (
    prefix + 'you have already read your parent/peer messages, but '
    + unansweredList.length + ' remain UNANSWERED — from ' + askers.join(', ') + extra
    + '. READING IS NOT SUFFICIENT: you must DECIDE from context and REPLY, not merely '
    + 'read/ack, via `node ' + CLI + ' send --to <id> --message "..."` (use the '
    + 'asker\'s id above as <id>).'
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
    + 'then run `node ' + CLI + ' archive-request <id>` to ask the child to archive. '
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

// buildOrphansSegment(list) -> string | null. list = summary.orphans[] (Phase A
// computeSummary's A2 detection): mesh partitions with REAL unread but no live
// registry row to read them — a stranded message a Primary would otherwise never
// see, one root cause of "children waiting, Primary does nothing". Read-only
// surface: never auto-forwarded/deleted/routed. Sorted by unread desc, capped at
// MAX_MESH_ISSUES with a "+K more" suffix (the only anti-spam — no persisted
// cooldown state). Returns null if nothing survives id-safety filtering.
function buildOrphansSegment(list) {
  const safe = list.filter((o) => o && o.id != null && isSafeId(String(o.id)));
  if (!safe.length) return null;
  safe.sort((a, b) => (Number(b.unread) || 0) - (Number(a.unread) || 0));
  const shown = safe.slice(0, MAX_MESH_ISSUES).map(
    (o) => o.id + ' (' + (Number.isFinite(o.unread) ? o.unread : 0) + ' unread)'
  );
  const extra = safe.length > MAX_MESH_ISSUES ? ' +' + (safe.length - MAX_MESH_ISSUES) + ' more' : '';
  return (
    '⚠ DEVSWARM ORPHANED MESH: ' + safe.length + ' partition(s) with unread but no live workspace '
    + 'to read them — ' + shown.join(', ') + extra + '. Investigate/re-address; nothing is currently '
    + 'watching this inbox.'
  );
}

// buildStaleRegistrySegment(list) -> string | null. list =
// summary.staleRegistryPartitions[] (Phase A computeSummary's A3 detection):
// registry rows whose worktreePath no longer exists on disk but still hold
// unread — a dead-but-unread partition invisible without this line. Read-only
// surface: never auto-forwarded/deleted/removed from the registry. Sorted by
// unread desc, capped at MAX_MESH_ISSUES.
function buildStaleRegistrySegment(list) {
  const safe = list.filter((s) => s && s.id != null && isSafeId(String(s.id)));
  if (!safe.length) return null;
  safe.sort((a, b) => (Number(b.unread) || 0) - (Number(a.unread) || 0));
  const shown = safe.slice(0, MAX_MESH_ISSUES).map(
    (s) => s.id + ' (' + (Number.isFinite(s.unread) ? s.unread : 0) + ' unread)'
  );
  const extra = safe.length > MAX_MESH_ISSUES ? ' +' + (safe.length - MAX_MESH_ISSUES) + ' more' : '';
  return (
    '⚠ DEVSWARM STALE WORKSPACE(S): ' + safe.length + ' workspace(s) whose worktree is gone but '
    + 'still hold unread — ' + shown.join(', ') + extra + '. Investigate or clean up the registry '
    + 'entry.'
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

  // H4 fallback (daemon-down parent-inbox freeze): readSummary() below only
  // reads the store's MATERIALIZED cache (summaries/<repoKey>.json). That cache
  // is normally kept fresh by the ingest daemon's own deriveSummary call after
  // each drained batch (devswarm-ingest.js's runIngestLoop, `ing.inserted > 0`
  // branch) — but when the daemon itself is down, NOTHING refreshes it anymore
  // and this view freezes on whatever the daemon last wrote before it died
  // (the roster looks frozen even though the underlying store rows may have
  // moved via some other writer, e.g. devswarm-pull.js/devswarm-migrate.js).
  // Before reading, check daemonHealth() (Phase 7, D25 — fresh heartbeat AND a
  // live-pid lock holder) and, if NOT healthy, refresh the projection ourselves
  // via the SAME store.deriveSummary(s, {home}) call devswarm-child-turn.js's
  // registerStoreDescriptor already makes (mirrors devswarm-pull.js's own
  // direct, unlocked deriveSummary call — no locking needed for this
  // read+atomic-write projection refresh, see devswarm-pull.js's comment).
  // This refreshes ONLY the derived summary.json PROJECTION from whatever rows
  // already sit in the store — it does NOT touch the native hivecontrol queue,
  // so it cannot un-freeze a roster whose staleness is caused by a dead
  // NATIVE-QUEUE reader (that still requires the daemon/monitor to drain it);
  // it only heals staleness caused by a dead PROJECTION writer. Best-effort +
  // fully fail-open: any failure here must never block a turn or crash this
  // hook — readSummary() below still runs regardless and returns whatever is
  // on disk (possibly still stale, possibly null).
  if (repoKey) {
    try {
      let ingestHealthMod = null;
      try { ingestHealthMod = require('../companion/lib/ingest-health.js'); } catch (_) { ingestHealthMod = null; }
      if (ingestHealthMod) {
        const health = ingestHealthMod.daemonHealth(home, repoKey, { now });
        if (health.status !== 'healthy') {
          let storeMod = null;
          try { storeMod = require('../companion/lib/devswarm-store.js'); } catch (_) { storeMod = null; }
          if (storeMod) {
            const s = storeMod.openStore({ home, workspaceId: primaryId || repoKey, hash: repoKey });
            try {
              // NON-DESTRUCTIVE GUARD: deriveSummary computes its projection
              // PURELY from this store's own registry/message rows (devswarm-
              // store.js's computeSummary) — it has no knowledge of, and cannot
              // merge with, whatever is already on disk at summaries/<repoKey>.json.
              // If this store handle is backed by a genuinely EMPTY store (no
              // registry rows, no message/cursor/gate rows for ANY workspace —
              // e.g. this project's store file was never created, or was reset,
              // while an out-of-band writer still populated summary.json), a
              // blind deriveSummary call would silently OVERWRITE a possibly
              // richer existing cache with an empty one — net data LOSS for a
              // read-only hook whose whole contract is fail-open/additive. Only
              // refresh when the store demonstrably has SOMETHING to derive
              // FROM (skip is the fail-safe default — readSummary() below still
              // returns whatever was already cached).
              let hasRows = false;
              try {
                const reg = typeof s.listRegistry === 'function' ? s.listRegistry() : [];
                hasRows = Array.isArray(reg) && reg.length > 0;
              } catch (_) { hasRows = false; }
              if (!hasRows) {
                try {
                  const ids = typeof s.listWorkspaceIds === 'function' ? s.listWorkspaceIds() : [];
                  hasRows = Array.isArray(ids) && ids.length > 0;
                } catch (_) { /* hasRows stays whatever it already was */ }
              }
              if (hasRows) storeMod.deriveSummary(s, { home });
            } finally {
              try { s.close(); } catch (_) {}
            }
          }
        }
      }
    } catch (e) {
      alog.logError('parent-inbox', 'derive-summary-fallback', e, { repoKey });
    }
  }

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
    // notDraining (item 3): the supervisor's persisted verdict field (companion/
    // lib/liveness.js unionPendingFor) — a union-unread backlog whose oldest row
    // has aged past NOT_DRAINING_AGE_MS, independent of `status`. Surfaced here
    // (not folded into `stuck`) so it stays a distinct signal downstream.
    const notDraining = !!(verdict && verdict.notDraining);
    if (unread > 0 || stuck || notDraining) {
      // wsName/oldestUnreadTs (item 5/6): human title + age for the reworded
      // "CHILD NOT DRAINING" segment below — read-only, zero extra store
      // reads (oldestDirectUnreadTs is already a zero-extra-read projection
      // field, see companion/lib/devswarm-store.js computeSummary).
      const wsName = names.readName(home, id);
      const oldestUnreadTs = Number.isFinite(entry.oldestDirectUnreadTs) ? entry.oldestDirectUnreadTs : null;
      attention.push({ id, unread, cursor, total, status, urgencyMax, wsName, oldestUnreadTs, notDraining });
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
      const heartbeat = freshness.readHeartbeat(home, id);
      // P2-b: pass the already-parsed heartbeat ts through to readActivityTs /
      // isDormantRow below so neither re-reads heartbeats/<id>.json a second
      // time this turn (freshness.readHeartbeat above already read it once).
      const heartbeatTsOpt = heartbeat && Number.isFinite(heartbeat.ts) ? heartbeat.ts : undefined;
      const row = { id, worktreePath: entry.worktreePath, sessionId: entry.sessionId };
      // Compose the widest activity signal available (companion/lib/liveness.js
      // readActivityTs): heartbeat OR live-session transcript mtime OR the
      // supervisor verdict. The transcript term is what keeps a child mid-long-turn
      // observably alive — heartbeats are turn-scoped and go quiet for the whole of
      // a long autonomous turn. Falls back to the previous two-input signal on any
      // failure, so this can only ever widen liveness, never narrow it.
      let activityTs = freshness.lastActivityTs(verdict, heartbeat);
      let dormant = false;
      try {
        const richer = livenessLib.readActivityTs(
          row, home,
          { lastOutboundTs: verdict && verdict.lastOutboundTs, heartbeatTs: heartbeatTsOpt }
        );
        if (richer && Number.isFinite(richer.ts) && (!Number.isFinite(activityTs) || richer.ts > activityTs)) {
          activityTs = richer.ts;
        }
      } catch (_) {}
      try {
        // isDormantRow (companion/lib/liveness.js) — THE ONE read-side
        // dormancy rule, shared with scripts/devswarm.js's rosterHints so the
        // per-turn table and the roster can never classify the same row
        // differently. Picks the tight or wide window per-row based on
        // whether the transcript term actually resolved for it (P1 fix).
        dormant = livenessLib.isDormantRow(
          row, home,
          { now, lastOutboundTs: verdict && verdict.lastOutboundTs, heartbeatTs: heartbeatTsOpt }
        );
      } catch (_) {}
      const ds = displayStatus(archiveReady, status, activityTs, now, dormant, !!(verdict && verdict.notDraining));
      rows.push({
        id,
        label: ds.label,
        rank: ds.rank,
        finish: finishingRate(summary, id, heartbeat),
        unread,
        lastActivityTs: activityTs,
        // wsName (task #6): cached human display name, read-only fs
        // projection lookup ONLY — never a hivecontrol spawn on this
        // every-turn hot path. null when not yet cached (buildWorkspaceTable
        // falls back to the bare id via names.displayName).
        wsName: names.readName(home, id),
        // unpushed/noUpstream/mergedVerified (git ground-truth report-only
        // markers, threaded from computeSummary — see devswarm-store.js /
        // devswarm-git-truth.js): absent-vs-present is significant, so these
        // are read straight from `entry`, never defaulted to a falsy-looking
        // value that could be mistaken for "checked and clean".
        unpushed: entry && Number.isFinite(entry.unpushed) ? entry.unpushed : null,
        noUpstream: !!(entry && entry.noUpstream === true),
        mergedVerified: entry ? entry.mergedVerified : undefined,
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
  // ownPendingQuestions (§4.5): the same summary entry's pendingQuestions[]
  // (companion/lib/devswarm-store.js's computeSummary — always present, `[]`
  // when none). Default `[]` on absence/malformed shape.
  let ownPendingQuestions = [];
  try {
    if (primaryId) {
      const ownEntry = summaryEntry(summary, primaryId);
      if (ownEntry && Number.isFinite(ownEntry.unread) && ownEntry.unread > 0) {
        ownUnread = ownEntry.unread;
        ownUrgencyMax = ownEntry.urgencyMax || null;
      }
      if (ownEntry && Array.isArray(ownEntry.pendingQuestions)) {
        ownPendingQuestions = ownEntry.pendingQuestions;
      }
    }
  } catch (_) { ownUnread = 0; ownUrgencyMax = null; ownPendingQuestions = []; }

  // ownUnanswered (§4.5, CORE fix for claim 1): cross-reference
  // ownPendingQuestions against this PROJECT's recorded reply-state
  // (companion/lib/devswarm-reply-state.js, §4.3) via the shared
  // unansweredQuestions() helper, so buildOwnUnreadSegment below can tell
  // "read" apart from "decided and replied". Reuses `repoKey` (already
  // resolved above for the shared summary read) rather than
  // `payload.session_id`: pendingQuestions is now PERMANENT (devswarm-store.js
  // computeSummary), so the reply record that clears it must share that same
  // durable per-project lifetime, not a short-lived Claude session_id — a
  // fresh session's empty session-keyed reply-state used to resurrect every
  // already-answered question (Bug 1a). This hook fires on EVERY
  // UserPromptSubmit turn (unlike the SessionStart-only devswarm-child-role.js
  // injection), so once wired the decide+reply instruction survives context
  // compaction. Fail-open TOWARD unanswered on ANY error here — never let a
  // read failure be silently read as "all answered" (the unsafe direction for
  // this feature); a require()/read failure falls back to treating every
  // pendingQuestions entry as still-unanswered.
  let ownUnanswered = [];
  try {
    const replyStateMod = require('../companion/lib/devswarm-reply-state.js');
    const replyState = replyStateMod.readReplyState(repoKey, home);
    ownUnanswered = replyStateMod.unansweredQuestions(ownPendingQuestions, replyState);
  } catch (_) {
    ownUnanswered = ownPendingQuestions.slice();
  }

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
        // v0.66: 'failed' (alive but ingesting nothing) is strictly MORE severe
        // than 'stale' (not alive) — daemonHealth's own status is a single
        // mutually-exclusive enum value (never both at once, see its own
        // comment), but the 'failed' check is still checked FIRST so precedence
        // is explicit and only ONE banner ever renders in this slot.
        if (health.status === 'failed') staleBanner = ingestHealthMod.buildMonitorFaultBanner(health.monitorFault);
        else if (health.status === 'stale') staleBanner = buildStaleBanner(beatTs, now);
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

  // v0.58: the terse COMMUNICATION OVERRIDE re-assertion is the ONLY segment
  // injected unconditionally (see OVERRIDE_REASSERT's own comment) — it goes in
  // FIRST, ahead of even the staleness banner, so it survives any future segment
  // reordering/truncation as the highest-priority line.
  const segments = [OVERRIDE_REASSERT];

  // Daemon-freshness staleness banner, when present, is injected next — above
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
    const evicted = capped ? rows.slice(MAX_TABLE_ROWS) : [];
    if (capped) logTableCap(home, rows.length, shown.length);
    segments.push(buildWorkspaceTable(shown, now, capped, rows.length - shown.length, evicted));
  }

  // Stuck-mesh surfacing (LEAN, read-only) — orphans[]/staleRegistryPartitions[]
  // are additive summary fields (Phase A) surfaced ONLY when non-empty, so an
  // older summary.json or a clean mesh renders NOTHING extra here (fail-open,
  // byte-identical for a non-DevSwarm session and a clean mesh). No writes, no
  // auto-forward, no delete — the MAX_MESH_ISSUES cap above is the only anti-spam.
  try {
    if (summary && Array.isArray(summary.orphans) && summary.orphans.length) {
      const seg = buildOrphansSegment(summary.orphans);
      if (seg) segments.push(seg);
    }
  } catch (_) {}
  try {
    if (summary && Array.isArray(summary.staleRegistryPartitions) && summary.staleRegistryPartitions.length) {
      const seg = buildStaleRegistrySegment(summary.staleRegistryPartitions);
      if (seg) segments.push(seg);
    }
  } catch (_) {}

  // Broadcast/roster feed (D3/D4/D22/D23/D27, Phase 8 step 2) — the shared
  // summary's top-level `recent[]` (plain broadcasts + heartbeats alike, D22),
  // rendered ADVISORY ONLY: this is roster/FYI context, NEVER a Stop-gate
  // trigger and NEVER mechanically dispatched — "react only if concerned" is
  // left to the model's own judgement (D27, no concerned-classifier invented).
  if (summary && Array.isArray(summary.recent) && summary.recent.length) {
    segments.push(buildBroadcastSegment(summary.recent));
  }

  // The Primary's OWN unread is its own top-priority item — surfaced ahead of
  // the children's unread/idle summary. Gated on EITHER ownUnread > 0 OR
  // ownUnanswered.length > 0 (not ownUnread alone — regression fix): under the
  // mesh semantics pendingQuestions no longer clears on read/ack, so a fully
  // read-and-acked backlog (ownUnread === 0) can still hold a genuinely
  // unanswered question, and that state must keep surfacing every turn just
  // as much as a plain unread backlog does.
  if ((ownUnread > 0 || ownUnanswered.length > 0) && primaryId) {
    segments.push(buildOwnUnreadSegment(ownUnread, primaryId, ownUrgencyMax, ownUnanswered));
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
    if (urgentList.length) segments.push(buildUrgentUnreadSegment(urgentList, home));
    if (normalList.length) segments.push(buildUnreadSegment(normalList, home));
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
  // Defensive only (v0.58): segments always carries at least OVERRIDE_REASSERT
  // once this line is reached (the role gate above already returned otherwise),
  // so this is never actually empty — kept as a fail-safe, not the primary gate.
  if (!additionalContext) return;

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

// require.main === module guard (same convention as scripts/devswarm.js): this
// hook runs its main() + process.exit(0) unconditionally when invoked as a CLI
// hook, but a test that `require()`s this file for its pure helpers (e.g.
// displayStatus) must not have the process exited out from under it.
if (require.main === module) {
  try {
    main();
  } catch (_) {
    // Fail-open: any error -> no output, exit 0.
  }
  process.exit(0);
}

module.exports = { displayStatus };
