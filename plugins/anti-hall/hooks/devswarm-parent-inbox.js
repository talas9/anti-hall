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
const versionCheck = require('../companion/lib/devswarm-version-check.js');
const { rowState } = require('../companion/lib/row-state.js');
// SHARED archive-resurrection gate (defect df54edf54804, item 3) — the SAME
// worktree-discriminated predicate companion/devswarm-migrate.js and
// scripts/devswarm.js's healOrphanPartitions use, reused here so this view's
// "superseded" label agrees with what they will actually do with the row.
const archiveGateLib = require('../companion/lib/devswarm-archive-gate.js');
// APP-SIDE archive detection — READ-ONLY, from the supervisor-written cache
// (never a hivecontrol spawn on this every-turn path). See that module's header.
const { readActiveCache } = require('../companion/lib/devswarm-archived-cache.js');
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
const { ownReaderUnread } = require('../companion/lib/devswarm-own-reader.js');
// devswarm-ignore.js: the user-editable ~/.anti-hall/devswarm/ignore.json
// {"ids":[...]} list — suppresses the urgent/not-draining nag for a listed
// id without hiding it from the roster/table. See that module's header.
const { isNagIgnored } = require('../companion/lib/devswarm-ignore.js');
// v0.108.0: the DevSwarm app DB snapshot (read-only, fail-open, 10 s cache) —
// UI title, pull-request finish signal, brief delivery, sidebar rank/pin, and
// the owner's on-screen workspace. Guarded: a load failure leaves every surface
// exactly as before.
let appDbLib = null;
try { appDbLib = require('../companion/lib/devswarm-app-db.js'); } catch (_) { appDbLib = null; }

// focusWindowMs(env) -> ms a UI selection counts as "the owner is looking at it"
// (ANTIHALL_DEVSWARM_FOCUS_MS, default 2 min; 0 disables focus suppression).
function focusWindowMs(env) {
  const raw = Number(env && env.ANTIHALL_DEVSWARM_FOCUS_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return appDbLib ? appDbLib.FOCUS_WINDOW_MS : 0;
}

// appRowMarkers(ws, brief) -> string: REPORT-ONLY title-cell markers from the app
// DB (pinned, owner on screen, brief not delivered / withheld).
function appRowMarkers(ws, brief, focused) {
  const parts = [];
  if (ws && ws.isPinned) parts.push('pinned');
  if (focused) parts.push('on screen');
  if (brief && brief.status === 'not-delivered') parts.push('⚠ brief not delivered');
  if (brief && brief.status === 'withheld') parts.push('⚠ brief withheld');
  return parts.length ? ' [' + parts.join(', ') + ']' : '';
}

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
// D1 fix (archived workspaces consuming table slots): an `archived` row (rank
// 6, the lowest — see displayStatus/the roster-build loop's label assignment)
// used to compete for MAX_TABLE_ROWS slots on equal footing with every live
// row, so a project with several archived workspaces could push genuinely
// live ones past the cap and into "+N more" — an archived-but-still-visible
// row is DONE and never needs re-surfacing every turn. DEFAULT ON: an
// archived row (one whose label is EXACTLY 'archived' — a real coordination
// backlog on an archived row already escapes that label via `not-draining`,
// rank 1.5, at the label-assignment site, so this filter can never hide a
// row that still needs attention — see "IT DEMOTES, IT DOES NOT HIDE",
// buildWorkspaceTable's own header, above) is dropped BEFORE sort/cap rather
// than after, so it can never consume a slot a live row needed. It is never
// silently vanished: the caller appends a "+N archived" note (see
// buildWorkspaceTable's `archivedHidden` param) naming exactly how many were
// omitted, and either env var restores the pre-fix behaviour.
function rosterHideArchived(env) {
  return String((env && env.ANTIHALL_ROSTER_HIDE_ARCHIVED) || '') !== '0';
}
function rosterMaxRows(env) {
  const n = Number(env && env.ANTIHALL_ROSTER_MAX_ROWS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_TABLE_ROWS;
}
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

// TITLE_INSTRUCTION (item 4b, residual of task #7): field evidence (v0.73.0 live
// session) showed Primaries still writing BARE mesh ids in their OWN prose replies
// to the human ("workspace 0fe62861...") even though the workspace table above
// already leads with each row's title (names.displayName). The table being
// title-first was not itself sufficient — nothing told the Primary the SAME rule
// applies to its own sentences, not just to what it reads. Emitted alongside the
// table (same rows.length gate) so it is present exactly when there is a
// workspace to mention.
const TITLE_INSTRUCTION =
  'When mentioning a workspace to the human, use its TITLE from the table above ' +
  '(truncate ~48 chars) — NEVER the bare mesh id. Mesh ids belong ONLY inside ' +
  'command strings (`send --to <meshId>`, etc).';

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
// uiSyncAskPath(home, sessionId, ids) — once-per-session-per-set throttle file for
// the "send a screenshot" ask (v0.108.0): sha1 of the session + sorted ids.
function uiSyncAskPath(home, sessionId, ids) {
  const h = require('crypto').createHash('sha1').update(String(sessionId || '') + '\u0000' + ids.slice().sort().join(',')).digest('hex').slice(0, 20);
  return path.join(devswarmRoot(home), 'ui-sync-asks', h + '.json');
}

// uiSyncAsk(home, sessionId, appDbState, rowIds, now) -> string | null. ONE line
// asking the owner for a screenshot of the DevSwarm sidebar, emitted at most once
// per session per set, and ONLY when the app DB cannot settle it — i.e. only
// when an app DB file exists but no snapshot could be read (v0.108.3: never
// while it is readable; a readable DB settles a conflict itself, because the
// app-DB sync retires the stale anti-hall marker). A conflict listed in
// app-state.json names the rows in the ask only in that unreadable case.
// The screenshot then goes through `devswarm.js sync-ui` (skills/devswarm).
function uiSyncAsk(home, sessionId, appDbState, rowIds, now) {
  try {
    let ids = [];
    let why = '';
    if (appDbState.unreadable && appDbState.conflicts && appDbState.conflicts.length) {
      ids = appDbState.conflicts.map((c) => String(c.id));
      why = 'The DevSwarm app shows ' + appDbState.conflicts.map((c) => "'" + (c.label || c.id) + "'").join(', ')
        + ' as open, but anti-hall has it archived. I can\'t tell which is right.';
    } else if (appDbState.unreadable && rowIds.length) {
      ids = rowIds.slice();
      why = 'I can\'t read the DevSwarm app database, so I can\'t confirm which workspaces are archived.';
    }
    if (!ids.length) return null;
    const p = uiSyncAskPath(home, sessionId, ids);
    if (fs.existsSync(p)) return null;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ at: now, ids }));
    return 'DEVSWARM SYNC: ' + why + ' Ask the owner (once) for a screenshot of the DevSwarm workspace list (left sidebar), then follow the devswarm skill\'s "screenshot sync" steps (`devswarm.js sync-ui`).';
  } catch (_) { return null; }
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
// defect bf965e5729c5: a cross-turn disk cache of the per-id liveness reads
// was tried here and REMOVED (R2 Critic P2-4/P2-5/P2-6): this hook fires on
// UserPromptSubmit only, and real prompts are seconds-to-minutes apart, so a
// 3s TTL missed in the normal case while adding a stat+read+mkdir+write+
// rename to EVERY turn — a net cost, not a saving, for the common case. It
// also had two correctness bugs (builtAt rewritten on every cache HIT, so a
// first-turn heartbeat could replay indefinitely once the TTL window kept
// re-arming itself; a shared `.tmp` write path across concurrent turns could
// race). The archived-row heartbeat-stat skip below is kept — it is a real,
// unconditional saving with no cache/staleness tradeoff. The field-reported
// 1.07s/turn-under-load-avg-516 latency this defect describes was NOT
// reproduced locally (see the defect's own ruling, `defect.js show
// bf965e5729c5`); it remains open pending a local repro or field
// instrumentation.

// readSummary(home) -> parsed object | null. summary.json is the derived hook
// read-surface (written atomically by the Phase 2 store). Tolerant of a missing,
// empty, zero-byte, or partially-written file (P2-9): any failure -> null ("no
// data yet"), never throws.
function readSummary(home, hash) {
  const p = summaryPath(home, hash);
  if (!p) return null;
  try {
    const raw = String(fs.readFileSync(p, 'utf8')).trim();
    if (!raw) { logSegmentError(home, 'summary-read', { code: 'EMPTY', message: 'summary.json empty' }); return null; }
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    // ENOENT is the normal inert state (no daemon yet) — not logged.
    if (!(e && e.code === 'ENOENT')) logSegmentError(home, 'summary-read', e);
    return null;
  }
}

// MAX_SEGMENT_ERROR_LOG_BYTES — bound for parent-inbox-segment-errors.ndjson.
const MAX_SEGMENT_ERROR_LOG_BYTES = 256 * 1024;

// logSegmentError(home, segment, err) — OBSERVABILITY ONLY for the fail-open
// catches on the summary-read / segment-building path (a WORKSPACES table or
// ORPHANED MESH banner was seen to vanish for one turn and return, cause
// unverified). Appends one NDJSON line {ts, segment, code, message} to
// <home>/.anti-hall/logs/parent-inbox-segment-errors.ndjson; stops appending
// once the file reaches the byte cap. Never throws, never changes behavior.
function logSegmentError(home, segment, err) {
  try {
    const p = path.join(home, '.anti-hall', 'logs', 'parent-inbox-segment-errors.ndjson');
    try { if (fs.statSync(p).size >= MAX_SEGMENT_ERROR_LOG_BYTES) return; } catch (_) {}
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({
      ts: Date.now(),
      segment,
      code: (err && err.code) || null,
      message: String((err && err.message) || err).slice(0, 300),
    }) + '\n');
  } catch (_) {}
}

// Volatile-age normalizer for the WORKSPACES table (lib/emit-dedupe.js on-change
// hash): blanks each row's last cell (the relative-age "last" column, e.g.
// "42s"/"3m"/"—") so a turn where only ages advanced hashes the same as the last
// emitted table. Status/unread/finish/risk changes still change the hash.
function normalizeTableAges(t) {
  return String(t).split('\n').map((l) => (/^\|.*\|\s*$/.test(l) ? l.replace(/\|[^|]*\|\s*$/, '| |') : l)).join('\n');
}

// Volatile-field normalizer for the PARENT INBOX nudge (burst-collapse only, rule a):
// drops the "oldest Xm" age and the rising/flat/falling trend (the trend flips to
// "flat" on the 2nd copy of a burst because the 1st copy just logged its
// snapshot). Unread counts and stuck statuses are kept, so a changed unread set
// is never suppressed.
function normalizeInboxVolatile(t) {
  return String(t).replace(/, oldest (?:—|\d+[smhd])/g, '').replace(/, (?:rising|flat|falling)\)/g, ')');
}

// dedupeEmit(home, sessionId, key, content, opts) -> bool — lib/emit-dedupe.js
// shouldEmit, lazily required, fail-open to true.
function dedupeEmit(home, sessionId, key, content, opts) {
  try {
    return require('./lib/emit-dedupe.js').shouldEmit(Object.assign({ home, sessionId, key, content }, opts || {}));
  } catch (_) {
    return true;
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

// findGitToplevel used to live here as a local pure-fs walk-up (byte-for-byte
// mirrored across 6 hook files — Phase 2 mesh redesign, B3). Retired: both
// `gitTop` below and the `resolveMeshId` fast path further down now go through
// companion/lib/identity.js's resolveContext, which is the SAME zero-spawn-
// first fs walk with submodule-hop fallback the two hand-rolled fast paths
// here approximated (and fixes D5 — the phantom-meshId shape inside a
// submodule — since resolveContext's `worktreeRoot`/`meshId` already fold onto
// the outermost superproject instead of stopping at a submodule's own toplevel).

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

// doneStateLabel(summary, id, heartbeat) -> string. PLAIN-WORDS projection of
// the same done-rule the supervisor's auto-archive sweep proves (gate (a)
// "done" + gate (b) "merged" in companion/lib/devswarm-lifecycle.js's
// planAutoArchive/doneFact/mergedFact — see that file's own header). The
// PRIOR "met/total" gate ratio (e.g. "1/3") was misleading under that rule: a
// child's structured done-report (`devswarm.js done`) sets ONLY the `done`
// gate row, never `merged`/`tests_passed` itself (auto-archive proves the
// merge separately, by git ancestry — see doneFact's own header), so a
// workspace that is fully done-and-merged under the real rule could still
// read "1/3" or even "—", looking barely started when it was actually about
// to be auto-archived.
//
// Three states, deliberately NOT a live re-check of gate (b) (this is a
// per-turn HOT PATH — "makes zero git calls" is this file's own standing
// contract, see the `Live active-workspace table` KB entry): a done report is
// `entry.gates.done === true` OR `entry.archive_ready === true` (the manual
// gate path); "merged" is proven ONLY by `entry.mergedVerified === true` — the
// CACHED, report-only projection of the SAME gitMergeProof `gate --set merged`
// already ran and recorded (companion/lib/devswarm-store.js), never a fresh
// git spawn here. An unset/false mergedVerified is honestly "not merged (yet
// proven)", not "not merged" — see riskMarker's identical "merged
// (unverified)" posture for the same field.
//   'done ✓ merged'    — done reported AND the merge is proven
//   'done, not merged' — done reported, merge not (yet) proven
//   'working' (+ %)    — no done report yet; an optional heartbeat
//                        progress_pct is appended when present, the only
//                        remaining advisory signal for an in-progress row
function doneStateLabel(summary, id, heartbeat) {
  const entry = summaryEntry(summary, id);
  const gates = entry && entry.gates && typeof entry.gates === 'object' ? entry.gates : {};
  const doneReported = !!(entry && (gates.done === true || entry.archive_ready === true));
  if (doneReported) {
    return (entry && entry.mergedVerified === true) ? 'done ✓ merged' : 'done, not merged';
  }
  const pct = heartbeat && Number.isFinite(heartbeat.progress_pct) ? heartbeat.progress_pct : null;
  return pct !== null ? 'working (' + pct + '%)' : 'working';
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
// `idleAlive` (defect 699a236129c5, optional — omitted by every pre-existing
// caller and defaulting to false, so their behaviour is byte-identical): the
// row's sessionId maps to a RUNNING harness process. It SUPPRESSES the three
// gone-looking labels that are built purely from activity timestamps
// (escalated/stale/dormant) — a process that is provably running is not gone,
// it is sitting at its prompt — and surfaces as its own `idle (alive)` label so
// the distinction is visible rather than silently folded into `idle`.
// notDraining and archive-ready are NOT suppressed: those are the COORDINATION
// axis (a real backlog aging on a live workspace is exactly what should still
// be reported) and the completion axis, neither of which claims the row is dead.
function displayStatus(archiveReady, status, activityTs, now, dormant, notDraining, idleAlive) {
  if (status === 'escalated' && !idleAlive) return { label: 'escalated', rank: 0 };
  if ((status === 'stale' || status === 'nudged') && !idleAlive) return { label: 'stale', rank: 1 };
  // not-draining (liveness.js unionPendingFor's `notDraining`, item 3): a live/
  // alive workspace whose union-unread backlog has sat past NOT_DRAINING_AGE_MS
  // regardless of activity — distinct from `stale`/`escalated` (those are
  // ACTIVITY axis; this is the COORDINATION axis) so it must not be folded into
  // either label. REPORT/ESCALATE ONLY (never gates a kill); sorts just behind
  // stale/escalated since it names a real, aging neglect signal.
  if (notDraining) return { label: 'not-draining', rank: 1.5 };
  if (archiveReady) return { label: 'archive-ready', rank: 2 };
  if (idleAlive) return { label: 'idle (alive)', rank: 3 };
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
function buildWorkspaceTable(rows, now, capped, hidden, hiddenRows, archivedHidden) {
  const lines = [
    'DEVSWARM WORKSPACES (re-sent on change, else every 10 turns):',
    '| workspace | status | finish | unread | last |',
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    // Task #6: "name (shortid)" when a name is cached, else the bare UUID
    // (names.displayName's own fallback). Escape a literal `|` in the name
    // (free-text from a brief/hivecontrol title) so it can never break this
    // markdown table's column structure.
    const workspaceCol = names.displayName(r.id, r.wsName).replace(/\|/g, '\\|') + riskMarker(r) + (r.appMarks || '');
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
  // D1 (archived rows never silently vanish, "IT DEMOTES, IT DOES NOT HIDE"):
  // named as a count, never folded into the "+N more" cap line above (that
  // line means "past MAX_TABLE_ROWS"; this means "excluded from the roster
  // entirely because it is archived" — two different reasons a row is absent,
  // so they get two different notes).
  if (Number.isFinite(archivedHidden) && archivedHidden > 0) {
    lines.push('+' + archivedHidden + ' archived (done; set ANTIHALL_ROSTER_HIDE_ARCHIVED=0 to show)');
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
function autoArchiveOwnsRow(home, id, now) {
  try { return require('../companion/lib/devswarm-lifecycle.js').autoArchiveOwns(home, id, { now }); } catch (_) { return false; }
}

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
    // item 4b: a stale-anti-hall-build row replaces the not-draining tag
    // entirely (w.notDraining is already false for such a row — see the
    // attention-push gate — so these two are mutually exclusive per row).
    if (w.staleAntiHallMessage) parts.push(w.staleAntiHallMessage);
    else if (w.notDraining) parts.push('NOT DRAINING >20m'); // item 3: distinct from stale/escalated
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
      + 'drained. Poke it (`node ' + CLI + ' send --to <id> --message-file <path>`) or '
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
    // item 4b: see buildUnreadSegment's matching comment — mutually exclusive.
    if (w.staleAntiHallMessage) parts.push(w.staleAntiHallMessage);
    else if (w.notDraining) parts.push('NOT DRAINING >20m');
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
    + 'STOP and poke it NOW (`node ' + CLI + ' send --to <id> --message-file <path>`) or escalate — '
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
// buildInformationalNote(informational) -> string (R17 item 3). Names each
// retired-sender question ONCE (deduped by sender id), suffixed onto whatever
// body this function already built. Never itself a reason this segment
// exists — the call site only invokes this function at all when count > 0 OR
// unansweredList.length > 0 OR informationalList.length > 0, so an
// informational-only pending question still gets a segment, just with the
// "already read" wording below and no unread/decide+reply nag.
function buildInformationalNote(informational) {
  const informationalList = Array.isArray(informational) ? informational : [];
  if (!informationalList.length) return '';
  // A question with a null `from` renders as the literal 'unknown sender'. That
  // string is fine in PROSE but must never reach the runnable command below —
  // `inbox ack unknown sender --ack-as-owner` is not a command, it is two bogus
  // arguments (defect 8b211241bbe9, R1 P2). Keep the prose list complete, and
  // build the command only from ids that are real.
  const ids = Array.from(new Set(informationalList.map(
    (q) => (q && q.from != null && String(q.from).trim() !== '') ? String(q.from) : 'unknown sender'
  )));
  const runnableIds = ids.filter((x) => x !== 'unknown sender');
  return (
    ' (INFORMATIONAL — question from retired sender ' + ids.join(', ') + ' — no repliable '
    // fl-wave4 fix (item 3): a RETIRED sender has no live owner to ack as —
    // `inbox ack <id>` alone fails ownership and never actually clears this.
    // `--ack-as-owner` is the sanctioned cross-workspace-ack override for
    // exactly this case (matches devswarm-parent-gate.js's own already-
    // correct ~line 1937 remediation text, and its buildInformationalSegment
    // sibling).
    // defect 8b211241bbe9 (§2e): the command used to carry a LITERAL `<id>`
    // placeholder while the prose named the retired sender(s) separately. An
    // agent filling that placeholder from the surrounding text could substitute
    // a LIVE child's id, and `--ack-as-owner` is exempt from every ownership
    // gate — so the instruction itself became a mail-eating path. Interpolate
    // the exact retired id (the first, when several are named) so there is
    // nothing left to substitute.
    + 'target'
    + (runnableIds.length
      ? ('; inspect with `node ' + CLI + ' inbox messages ' + runnableIds[0] + '`, ack with `node ' + CLI
        + ' inbox ack ' + runnableIds[0] + ' --ack-as-owner` after reading. Ack ONLY the retired id named here — '
        + 'never a live child id.')
      // No resolvable id: name the situation, offer no command at all rather
      // than one whose argument cannot be substituted correctly.
      : ' and no resolvable sender id, so no ack command is offered here.')
    + ' Not counted in the unanswered count above.)'
  );
}

function buildOwnUnreadSegment(count, id, urgencyMax, unanswered, informational) {
  const unansweredList = Array.isArray(unanswered) ? unanswered : [];
  const informationalList = Array.isArray(informational) ? informational : [];
  const prefix = isHighUrgency(urgencyMax) ? 'DEVSWARM OWN INBOX — URGENT PRIORITY: ' : 'DEVSWARM OWN INBOX — PRIORITY: ';

  if (count > 0) {
    let body = (
      prefix + 'you have ' + count + ' unread parent/peer '
      + 'message(s) addressed to YOU (the Primary). STOP and read your unread '
      + 'parent/peer message(s) FIRST before continuing. Read them via '
      + '`node ' + CLI + ' inbox read-primary ' + id + '` (anti-hall devswarm CLI — '
      + 'read-only: after handling them run the `ackCommand` it returns, which advances '
      + 'YOUR OWN read cursor; to check WITHOUT a receipt instead, '
      + 'use `inbox peek-primary ' + id + '`). Do NOT run `hivecontrol workspace '
      + 'read-messages` or `monitor` — those DESTRUCTIVELY drain the NATIVE queue '
      + '(a completely separate channel from your own cursor above).'
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
        + 'REPLY, not merely read, via `node ' + CLI + ' send --to <id> --message-file <path>` '
        + '(use the asker\'s id above as <id>).'
      );
    }
    return body + buildInformationalNote(informationalList);
  }

  // count === 0 but unansweredList.length > 0 (the only other case the call
  // site now invokes this function for): a fully read/acked backlog that
  // still holds a genuinely unanswered question. There is nothing left to
  // "read", so this wording skips the read-primary instruction entirely and
  // goes straight to the decide+reply nag.
  if (unansweredList.length > 0) {
    const askers = unansweredList.slice(0, MAX_LISTED).map(
      (q) => (q && q.from != null) ? String(q.from) : '?'
    );
    const extra = unansweredList.length > MAX_LISTED
      ? ' +' + (unansweredList.length - MAX_LISTED) + ' more' : '';
    return (
      prefix + 'you have already read your parent/peer messages, but '
      + unansweredList.length + ' remain UNANSWERED — from ' + askers.join(', ') + extra
      + '. READING IS NOT SUFFICIENT: you must DECIDE from context and REPLY, not merely '
      + 'read/ack, via `node ' + CLI + ' send --to <id> --message-file <path>` (use the '
      + 'asker\'s id above as <id>).'
    ) + buildInformationalNote(informationalList);
  }

  // count === 0, unansweredList EMPTY, but informationalList.length > 0 (R17
  // item 3): the ONLY thing pending is a retired-sender question. Nothing to
  // read, nothing genuinely unanswered to decide+reply on — just the
  // informational note.
  return (
    prefix + 'you have already read your parent/peer messages.'
    + buildInformationalNote(informationalList)
  );
}

// D2 fix (broadcast feed inflates the injection, repeats verbatim every turn).
// Two independent problems, both closed here:
//
//  (a) NO TRUNCATION. `r.summary` is the FULL message body (devswarm-store.js's
//      computeSummary, `const summary = r.body != null ? r.body : ''`) and was
//      rendered verbatim — the table above is bounded to ~1.3KB, but six full
//      bodies could inflate a single turn's injection by 5-10x. Capped to
//      MAX_BROADCAST_BODY_CHARS with an ellipsis — the single highest-value
//      byte reduction available here.
//  (b) NO DEDUP / NO AGE CAP. `summary.recent` (devswarm-store.js
//      DEFAULT_RECENT_CAP, marked "O-D8 ... UNRESOLVED" in that file's own
//      comment) is count-capped only, and this hook re-rendered
//      `rows.slice(-MAX_LISTED)` EVERY turn with no memory of what it already
//      showed — a broadcast sent once could repeat verbatim for the entire
//      rest of the session. Closed with (1) an age cap (a broadcast older than
//      BROADCAST_MAX_AGE_MS is dropped — it has had its chance to be seen) and
//      (2) per-SESSION suppression of a broadcast already injected once this
//      session (see broadcastSeenPath/visibleBroadcastRows below).
const MAX_BROADCAST_BODY_CHARS = 200;
function truncateBroadcastBody(body) {
  const s = String(body);
  return s.length > MAX_BROADCAST_BODY_CHARS ? s.slice(0, MAX_BROADCAST_BODY_CHARS) + '…' : s;
}
const DEFAULT_BROADCAST_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
function broadcastMaxAgeMs(env) {
  const n = Number(env && env.ANTIHALL_BROADCAST_MAX_AGE_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BROADCAST_MAX_AGE_MS;
}

// DEFAULT_ARCHIVE_REQUEST_RENAG_MS / resolveArchiveRequestRenagMs(env) —
// SkyCrew field report (399105fe, e75cade3): with an archive-request already
// pending (computeSummary's archive_request_only_unread — the ENTIRE current
// unread backlog for that workspace is the Primary's own not-yet-drained
// archive-request send), both the CHILD NOT DRAINING nag and the ARCHIVE-
// READY re-nudge kept re-instructing the Primary to poke/re-send the SAME
// request it had already sent — the child was simply waiting on its own
// user, not neglected. Both are suppressed while archiveRequestPending is
// true (see the two call sites below), UNTIL this interval elapses since the
// oldest still-unread row (== the archive-request send itself, since it is
// the only unread row) — at which point either counts as genuinely stale and
// resumes nagging. 24h default: long enough that a pending human decision on
// the child's end is not treated as neglect, short enough that a truly
// abandoned request does not go unnoticed forever. Same env-var-is-hours
// convention as the schema's own *_SEC/*_MIN vars scaled to this window's
// natural unit.
const DEFAULT_ARCHIVE_REQUEST_RENAG_MS = 24 * 60 * 60 * 1000; // 24h
function resolveArchiveRequestRenagMs(env) {
  try {
    const v = require('./lib/settings.js').getWithEnv(
      'devswarm', 'archiveRequestRenagHours', DEFAULT_ARCHIVE_REQUEST_RENAG_MS / 3600000, env || process.env
    );
    if (Number.isFinite(v) && v > 0) return v * 3600000;
  } catch (_) { /* fall through */ }
  const n = Number(env && env.ANTIHALL_DEVSWARM_ARCHIVE_REQUEST_RENAG_HOURS);
  return Number.isFinite(n) && n > 0 ? n * 3600000 : DEFAULT_ARCHIVE_REQUEST_RENAG_MS;
}

// DEFAULT_INBOX_GRACE_MS / resolveInboxGraceMs(env) — SkyCrew report fix: a
// direct send to a LIVE child lane was flagged "need attention" as little as
// 4s after sending, before the child's own Stop-hook loop could realistically
// have cycled once, let alone drained it. 120s default: generous enough to
// cover one real turn's worth of latency, tight enough that a genuinely
// neglected message still surfaces promptly. ANTIHALL_DEVSWARM_INBOX_GRACE_SEC-
// overridable (0 = grace disabled, flags immediately — same env-var-is-
// seconds convention as broadcastMaxAgeMs/every *_SEC var elsewhere in this
// codebase).
const DEFAULT_INBOX_GRACE_MS = 120 * 1000;
function resolveInboxGraceMs(env) {
  try {
    const v = require('./lib/settings.js').getWithEnv('devswarm', 'inboxGraceSec', DEFAULT_INBOX_GRACE_MS / 1000, env || process.env);
    if (Number.isFinite(v) && v >= 0) return v * 1000;
  } catch (_) { /* fall through */ }
  const n = Number(env && env.ANTIHALL_DEVSWARM_INBOX_GRACE_SEC);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : DEFAULT_INBOX_GRACE_MS;
}

// unreadIsGraced({unread, oldestUnreadTs, id, home, now, graceMs, heartbeatTsFn}) -> bool.
// PURE decision function (unit-testable without spawning this hook): true
// (suppress the unread-only nag trigger) ONLY while BOTH (a) the oldest
// still-unread message is younger than the grace window AND (b) the child has
// recorded NO heartbeat since that message was sent — a heartbeat after the
// send is proof the child's own loop already had a chance to notice/drain it,
// so grace no longer applies even inside the window. Fail-open TOWARD
// flagging: a missing/unreadable oldestUnreadTs or heartbeat never suppresses
// (returns false) — this only ever narrows the TIMING of an already-unread
// row, never hides a genuinely long-unread one.
function unreadIsGraced(opts) {
  const o = opts || {};
  if (!(o.unread > 0) || !Number.isFinite(o.oldestUnreadTs)) return false;
  const graceMs = Number.isFinite(o.graceMs) ? o.graceMs : DEFAULT_INBOX_GRACE_MS;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const ageMs = now - o.oldestUnreadTs;
  if (ageMs >= graceMs) return false;
  // heartbeatTs (production) already fails open to null on any read error —
  // it never throws. The try/catch here guards ONLY a pathological injected
  // heartbeatTsFn; on a genuine throw this fails open TOWARD flagging (assume
  // a heartbeat landed after the send), matching this codebase's consistent
  // "when in doubt, keep blocking/flagging" posture elsewhere (e.g.
  // devswarm-parent-gate.js's realUnread computation) — a null return (the
  // ordinary "no heartbeat recorded yet" case, ubiquitous right after a fresh
  // send) is NOT an error and keeps grace applying normally.
  let heartbeatAfterSend = false;
  try {
    const fn = o.heartbeatTsFn || livenessLib.heartbeatTs;
    const hbTs = fn(o.id, o.home);
    heartbeatAfterSend = Number.isFinite(hbTs) && hbTs > o.oldestUnreadTs;
  } catch (_) { heartbeatAfterSend = true; }
  return !heartbeatAfterSend;
}

// broadcastKey(r) -> a stable dedup identity for one recent[] row: sender +
// timestamp + body. `ts` alone is not unique (two distinct senders could
// broadcast in the same tick) and `summary` alone is not unique (a repeated
// phrase from a DIFFERENT sender/time is a genuinely new event) — all three
// together match exactly what a human reading the rendered line would judge
// "the same broadcast I already saw".
function broadcastKey(r) {
  // fromLabel (v0.108.0): an aliased entry keys on its ORIGINAL label so a
  // broadcast already seen before the alias existed is not re-shown.
  const who = r && r.fromLabel != null ? r.fromLabel : (r && r.from != null ? r.from : '?');
  return who + ' ' + (r && r.ts != null ? r.ts : '')
    + ' ' + (r && r.summary != null ? r.summary : '');
}

// broadcastSeenPath(home, sessionId) -> per-session dedup state file:
// ~/.anti-hall/devswarm/parent-inbox-broadcast-seen/<safe-session>.json.
// Session-scoped file-path IDIOM borrowed from
// companion/lib/devswarm-gate-state.js's stateFileFor (used by
// hooks/devswarm-parent-gate.js's Stop-loop state) — same sanitize-to-
// filename convention — but DELIBERATELY its own file/directory: a different
// shape (a bounded key list, not gate-loop state) and a different lifecycle
// would corrupt or be corrupted by the Stop-gate's own persisted file if the
// two ever shared one. `session_id` is read from stdin's payload (available,
// previously discarded by this hook).
function broadcastSeenDir(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'parent-inbox-broadcast-seen');
}
function broadcastSeenPath(home, sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(broadcastSeenDir(home), safe + '.json');
}
// Bounded — never an unbounded per-session log; a session that outlives this
// many distinct broadcasts simply starts re-showing the oldest ones again
// (fail-open toward SHOWING, never a growing file).
const MAX_BROADCAST_SEEN_KEYS = 200;
function readBroadcastSeenKeys(home, sessionId) {
  try {
    const raw = fs.readFileSync(broadcastSeenPath(home, sessionId), 'utf8');
    const j = JSON.parse(raw);
    return (j && Array.isArray(j.keys)) ? j.keys : [];
  } catch (_) { return []; } // absent/corrupt -> nothing seen yet (fail-open toward SHOWING)
}
function writeBroadcastSeenKeys(home, sessionId, keys) {
  try {
    const p = broadcastSeenPath(home, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const trimmed = keys.slice(-MAX_BROADCAST_SEEN_KEYS);
    const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify({ keys: trimmed }));
    fs.renameSync(tmp, p);
  } catch (_) { /* best-effort: a missed write just means a broadcast may repeat once more */ }
}

// visibleBroadcastRows(rows, home, sessionId, now, env) -> the rows to
// actually render this turn: age-capped, then per-session-deduped. Any
// failure in the DEDUP step alone falls back to the age-capped set (never a
// hard failure of this hook, and never a silent full suppression) — a
// missing session id or an unreadable/unwritable state file degrades to
// "nothing remembered yet", which just means this turn may repeat a
// broadcast rather than ever hide a genuinely new one.
function visibleBroadcastRows(rows, home, sessionId, now, env) {
  const maxAge = broadcastMaxAgeMs(env);
  let fresh = rows;
  try {
    fresh = rows.filter((r) => (
      !Number.isFinite(now) || !r || !Number.isFinite(r.ts) || (now - r.ts) <= maxAge
    ));
  } catch (_) { fresh = rows; }
  try {
    const seenKeys = new Set(readBroadcastSeenKeys(home, sessionId));
    const unseen = fresh.filter((r) => !seenKeys.has(broadcastKey(r)));
    if (unseen.length) {
      writeBroadcastSeenKeys(home, sessionId, Array.from(seenKeys).concat(unseen.map(broadcastKey)));
    }
    return unseen;
  } catch (_) {
    return fresh; // dedup machinery failed -> fail-open to the age-capped set, never crash the hook
  }
}

// buildBroadcastSegment(rows) -> string. v0.57 mesh (D3/D4/D22/D23/D27, Phase 8
// step 2): the top-level `recent[]` broadcast/heartbeat feed, rendered ADVISORY
// ONLY — this is roster/FYI context, NEVER a Stop-gate trigger and NEVER
// mechanically dispatched ("react only if concerned" is agent judgement, D27 —
// no concerned-classifier is invented here). A `recent[]` row carries no
// direct/broadcast discriminator of its own (it is ALWAYS a broadcast-axis row —
// plain broadcast or heartbeat, D22) so every row renders identically; urgency
// (urgent/high) only makes a row visually LOUDER via an `[URGENT]` tag — it does
// not change the advisory framing or gate anything. `rows` is assumed already
// filtered (age-capped + deduped, see visibleBroadcastRows) — this function
// only caps to MAX_LISTED and truncates each body (D2).
//
// Mesh message triage (Jev, part 2, ADVISORY ONLY): each shown row optionally
// gains a bracketed `[kind]`/`[URGENT]` tag ahead of the existing `[URGENT]`
// urgency tag — purely cosmetic prefix text, never a reorder/suppress/delay
// and never a second `[URGENT]` when Jev's own urgency label agrees with the
// pre-existing `isHighUrgency` axis. `home` is optional (tests omit it); any
// triage failure/timeout/disabled state leaves every row exactly as before
// this feature existed. See hooks/lib/jev-triage.js.
function buildBroadcastSegment(rows, home) {
  const capped = rows.slice(-MAX_LISTED);
  let labels = new Map();
  try {
    const { triageMessagesSync } = require('./lib/jev-triage.js');
    const items = capped.map((r, i) => ({ key: i, text: r && r.summary != null ? String(r.summary) : '' }));
    labels = triageMessagesSync(items, { home });
  } catch (_) {
    labels = new Map(); // advisory-only: any failure -> no tags, unchanged rendering
  }
  const shown = capped.map((r, i) => {
    const label = labels.get(i);
    const urgentTag = isHighUrgency(r.urgency) || (label && label.urgency === 'urgent') ? '[URGENT] ' : '';
    const kindTag = label && label.kind ? '[' + label.kind + '] ' : '';
    const who = r.from != null ? r.from : '?';
    const body = r.summary != null && r.summary !== '' ? truncateBroadcastBody(r.summary) : '(no summary)';
    return '- ' + urgentTag + kindTag + who + ': ' + body;
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
  // Settings switch devswarm.parentInbox (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('devswarm', 'parentInbox')) return; } catch (_) { /* run */ }
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
    gitTop = cwd ? require('../companion/lib/identity.js').resolveContext(cwd, { home, missingPath: 'ancestor' }).worktreeRoot : null;
    worktreeHash = gitTop ? installIngest.worktreeHash(gitTop) : null;
    primaryId = gitTop ? installIngest.primaryWorkspaceId(gitTop) : null;
  } catch (_) { worktreeHash = null; primaryId = null; gitTop = null; }

  let repokeyMod = null;
  try { repokeyMod = require('../companion/lib/devswarm-repokey.js'); } catch (_) { repokeyMod = null; }
  let repoKey = null;
  try { repoKey = (repokeyMod && gitTop) ? repokeyMod.repoKeyForWorktree(gitTop) : null; } catch (e) { logSegmentError(home, 'repokey', e); repoKey = null; }

  // appArchivedCache() — the supervisor-written ACTIVE-set snapshot, read ONCE
  // per invocation and reused for every table row. Freshness is enforced inside
  // readActiveCache (stale/missing/malformed -> empty), so absence can only ever
  // suppress on currently-valid evidence.
  let appArchivedCacheMemo;
  function appArchivedCache() {
    if (appArchivedCacheMemo === undefined) {
      try { appArchivedCacheMemo = readActiveCache({ home, env: process.env, now }); }
      catch (_) { appArchivedCacheMemo = null; }
    }
    return appArchivedCacheMemo;
  }
  // appSnap() / appWs() — ONE app-DB snapshot per invocation (v0.108.0).
  let appSnapMemo;
  function appSnap() {
    if (appSnapMemo === undefined) {
      try { appSnapMemo = appDbLib ? appDbLib.snapshot({ home, env: process.env, now }) : null; }
      catch (_) { appSnapMemo = null; }
    }
    return appSnapMemo;
  }
  function appWs(id, worktreePath) {
    try { return appDbLib ? appDbLib.workspaceFor(appSnap(), { id, worktreePath }) : null; } catch (_) { return null; }
  }
  // The builder the owner has on screen right now (UI focus within the window):
  // nags about THAT workspace are suppressed (it still shows in the table).
  let focusedId = null;
  try {
    const w = focusWindowMs(process.env);
    focusedId = (appDbLib && w > 0) ? appDbLib.focusedWorkspaceId(appSnap(), now, w) : null;
  } catch (_) { focusedId = null; }

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
            // readOnly (Phase 4, #12): this refresh only READS the store (the
            // write is summaries/<repoKey>.json), so a project with no store yet
            // must not get an empty store dir provisioned by looking at it —
            // openStore returns null instead, and there is nothing to derive.
            const s = storeMod.openStore({ home, workspaceId: primaryId || repoKey, hash: repoKey, readOnly: true });
            if (s) try {
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
  try { summary = repoKey ? readSummary(home, repoKey) : null; } catch (e) { logSegmentError(home, 'summary-read', e); summary = null; }
  const summaryWorkspaces = (summary && summary.workspaces && typeof summary.workspaces === 'object')
    ? summary.workspaces : {};

  // item 4b (P0, field-proven): resolved ONCE per hook invocation (pure fs
  // reads, no git spawn — see devswarm-version-check.js's own header), not
  // per workspace. A child heartbeating an OLDER anti-hall build than this
  // machine's newest known one gets a distinct "stale anti-hall <v>" label
  // INSTEAD of "not-draining" below — the real cause (an un-restarted build
  // that literally cannot see store-side mesh mail on 0.105.3) is a build
  // problem, not a coordination-neglect one, and the two need different
  // remedies (restart, not poke/escalate).
  const newestAntiHallVersion = versionCheck.newestKnownAntiHallVersion({ env: process.env, home });

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
    // Fast, zero-spawn resolution (devswarm-repokey.js's repoKeyForWorktreeFast)
    // — this loop runs once per summary row, every prompt, so a per-row `git`
    // spawn here is exactly the P0 defect (measured: 74% of this hook's wall
    // time, up to ~2.6s/row under load). repoKeyForWorktreeFast reads git's
    // own on-disk worktree metadata (.git file/dir + commondir) directly and
    // only falls back to a git spawn for the rare shapes fs alone can't
    // resolve (a submodule remap) or that repoKeyForWorktree already handles
    // (a malformed .git); a worktree path that no longer exists on disk
    // short-circuits to null with ZERO spawns. Verified byte-identical output
    // to repoKeyForWorktree for main-checkout, linked-worktree, and submodule
    // shapes against real repos on this machine.
    try { k = repokeyMod ? repokeyMod.repoKeyForWorktreeFast(wt) : null; } catch (_) { k = null; }
    repoKeyCache.set(wt, k);
    return k;
  }

  // OWN-CHECKOUT ROW FOLD (P0 field bug): the DevSwarm app can self-register
  // its OWN "primary builder" row under an id other than anti-hall's own
  // `primaryId` (e.g. an app builder id like `76cf862f…`, label "SkyCrew",
  // worktree === the Primary's own checkout) — owner-verified on the live
  // app DB: `builders.builderType === 'primary'` for exactly that row (5
  // primary vs 209 standard rows). Before this fix such a row fell through
  // to the generic child path, producing a false "SkyCrew (76cf862f) N
  // unread" nag with child-shaped wording ("messages YOU sent") for what is
  // actually the Primary's own inbound mail.
  //
  // PROVEN SIGNAL, gated on BOTH conjuncts: worktree match is necessary but
  // NOT sufficient — this test suite's own fixtures widely reuse `gitTop`
  // (the test's own repo cwd) as an ordinary CHILD's worktreePath for
  // convenience, so worktree-match ALONE mis-folded 59 genuine child-row
  // tests (reverted P0 attempt #1). `builderTypeFor(id)` is the app DB's
  // OWN answer for whether id is genuinely the app's primary/self row —
  // when the app DB is unavailable (no node:sqlite, no DB file, no matching
  // row, any error) it returns null, and null NEVER folds — fail-open to
  // the pre-existing (unchanged) child-path behavior, exactly why none of
  // the existing fixtures (none set an app DB) are affected.
  // builderTypeFor reads the ONE per-invocation app-DB snapshot (appSnap(),
  // companion/lib/devswarm-app-db.js — capability-gated on
  // appdb.builders.builderType). Exact id match only (no worktree fallback).
  function builderTypeFor(id) {
    try {
      const w = appDbLib ? appDbLib.workspaceFor(appSnap(), { id }) : null;
      if (!w || typeof w.builderType !== 'string') return null;
      return w.builderType === 'primary' ? 'primary' : 'standard';
    } catch (_) { return null; }
  }
  const ownCheckoutRootCache = new Map(); // worktreePath -> resolved worktreeRoot | null
  function worktreeRootOf(wt) {
    if (!wt) return null;
    if (ownCheckoutRootCache.has(wt)) return ownCheckoutRootCache.get(wt);
    let root = null;
    try { root = require('../companion/lib/identity.js').resolveContext(wt, { home, missingPath: 'ancestor' }).worktreeRoot; } catch (_) { root = null; }
    ownCheckoutRootCache.set(wt, root);
    return root;
  }
  let ownCheckoutExtraUnread = 0;
  let ownCheckoutExtraUrgency = null;

  const summaryIdSet = new Set(Object.keys(summaryWorkspaces));
  // 0.108.4 ghost row: a child's `primary-<hash>` label whose canonical row is
  // also in this summary (alias / retired redirect / the app's builder on that
  // worktree) is the SAME workspace — show it once, under the canonical row.
  // Resolved in a pre-pass so the ghost's unread directs are ADDED to the
  // canonical row's nag (whichever order the two ids iterate in), never lost.
  const ghostFoldTo = new Map(); // ghost id -> canonical id
  const foldedUnread = new Map(); // canonical id -> summed ghost unread
  for (const id of summaryIdSet) {
    if (!isSafeId(id) || id === primaryId || !/^primary-[0-9a-f]{8}$/.test(id)) continue;
    const entry = summaryWorkspaces[id];
    if (!entry || typeof entry !== 'object') continue;
    let foldTo = null;
    try {
      const w = entry.worktreePath ? appWs(null, entry.worktreePath) : null;
      const appBuilderId = w && w.builderType !== 'primary' ? w.id : null;
      foldTo = require('../companion/lib/devswarm-sender-alias.js').rosterFoldTarget(home, id, summaryIdSet, { appBuilderId });
    } catch (_) { foldTo = null; }
    if (!foldTo) continue;
    ghostFoldTo.set(id, foldTo);
    const ghostUnread = Number.isFinite(entry.directUnread) ? entry.directUnread
      : (Number.isFinite(entry.unread) ? entry.unread : 0);
    if (ghostUnread > 0) foldedUnread.set(foldTo, (foldedUnread.get(foldTo) || 0) + ghostUnread);
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
    // Folded ghost row: shown once, under its canonical row (pre-pass above).
    if (ghostFoldTo.has(id)) continue;

    if (gitTop && entry.worktreePath && worktreeRootOf(entry.worktreePath) === gitTop
        && builderTypeFor(id) === 'primary') {
      const rowUnread = Number.isFinite(entry.directUnread) ? entry.directUnread
        : (Number.isFinite(entry.unread) ? entry.unread : 0);
      ownCheckoutExtraUnread += rowUnread + (foldedUnread.get(id) || 0);
      if (!ownCheckoutExtraUrgency) ownCheckoutExtraUrgency = entry.urgencyMax || null;
      continue; // route to the own-unread path below, never the generic child path
    }

    const dKey = repoKeyOfWorktree(entry.worktreePath);
    if (repoKey && dKey && dKey !== repoKey) continue; // #36 structural filter

    // --- unread / idle (v0.57 mesh: sourced from the summary projection's own
    // directUnread/total/cursor — the mesh store's tracked cursor is now
    // authoritative for direct-message unread, D24; an old-shape entry missing
    // directUnread falls back to its `unread` alias, same value, edge_cases) ---
    // + any folded ghost row's unread directs (they belong to this workspace).
    const unread = (Number.isFinite(entry.directUnread) ? entry.directUnread
      : (Number.isFinite(entry.unread) ? entry.unread : 0)) + (foldedUnread.get(id) || 0);
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
    // item 4b (P0, field-proven): a notDraining workspace running a STALE
    // anti-hall build (item 4a's recorded heartbeat `version`, older than the
    // newest known on this machine) gets a distinct "stale anti-hall <v>"
    // label/message INSTEAD of "not-draining" everywhere below — see
    // devswarm-version-check.js's header for why (0.105.3 is NDJSON-only and
    // cannot see store-side mesh mail at all, so this "looks like" neglect
    // but the actual remedy is a restart, not a poke/escalate). Computed only
    // when notDraining is already true (the ONLY case this ever overrides) —
    // a normal/draining row pays no extra heartbeat read.
    let staleAntiHallVersion = null;
    let staleAntiHallMessage = null;
    if (notDraining && newestAntiHallVersion) {
      let hbVersion = null;
      try { hbVersion = livenessLib.heartbeatVersion(id, home); } catch (_) { hbVersion = null; }
      if (versionCheck.isVersionStale(hbVersion, newestAntiHallVersion)) {
        staleAntiHallVersion = hbVersion;
        const cliPath = versionCheck.newestCliPath({
          env: process.env, home, newestVersion: newestAntiHallVersion, segments: ['scripts', 'devswarm.js'],
        });
        staleAntiHallMessage = versionCheck.staleAntiHallMessage(hbVersion, newestAntiHallVersion, cliPath);
      }
    }
    // The boolean fed to every existing not-draining branch below — false
    // whenever staleAntiHallVersion applies, so this can only ever REPLACE
    // the not-draining label, never coexist with it for the same row.
    const notDrainingForLabel = notDraining && !staleAntiHallVersion;
    // --- archive-ready recommendation (P1-E) — computed BEFORE the attention
    // push below so the archive-ready-quiet check just below can use it.
    const archiveReady = isArchiveReady(id, summary);
    // ARCHIVE-READY-QUIET (fix: URGENT/"not draining" nag every turn for a
    // row with no live reader that can never clear it): an archive-ready
    // workspace whose ENTIRE unread backlog is the Primary's OWN
    // archive-request send (companion/lib/devswarm-store.js computeSummary's
    // archive_request_only_unread — zero extra store reads) and whose session
    // is not actually running is not a coordination failure, it is a child
    // that already finished and left; nobody is ever going to drain that
    // mailbox. Such a row is EXCLUDED from the urgent/attention nag below
    // (never Stop-blocking, never the loud per-turn paragraph) — it keeps
    // getting surfaced exactly once via the EXISTING, cooldown'd
    // archive-ready nudge (archiveList, just below) instead of every turn.
    // Liveness axis ONLY, same scoping discipline as every other suppressor
    // in this file/the parent gate: a row with real (non-self-sent) unread,
    // or one whose session IS still running, is untouched.
    let archiveReadyQuiet = false;
    if (archiveReady && unread > 0 && entry.archive_request_only_unread === true) {
      let liveSession = false;
      try {
        liveSession = entry.sessionId
          ? livenessLib.isSessionAliveRow({ sessionId: entry.sessionId }, home)
          : false;
      } catch (_) { liveSession = false; }
      archiveReadyQuiet = !liveSession;
    }
    // ARCHIVE-REQUEST-PENDING (fix: CHILD NOT DRAINING / ARCHIVE-READY nag
    // re-instructing the Primary to poke/re-send an archive-request it
    // already sent — SkyCrew field report 399105fe/e75cade3): unlike
    // archiveReadyQuiet above (dead session ONLY), this fires whenever the
    // workspace's ENTIRE currently-unread backlog is the Primary's own
    // archive-request send (archive_request_only_unread), regardless of
    // whether the child's session is still live — a live child that simply
    // has not yet drained/acted on the request is not a coordination
    // failure either; "poke it" would just resend the identical message.
    // Resumes automatically the moment either condition breaks: the child
    // reads the row (unread drops to 0 -> archive_request_only_unread's
    // `unreadRows.length > 0` guard goes false) or the child resumes other
    // work (a non-archive-request unread row arrives -> the `.every` guard
    // goes false) — "resolved" and "resumed work" respectively, no separate
    // bookkeeping needed. Also re-nags on its own after
    // ARCHIVE_REQUEST_RENAG_MS regardless (archiveRequestStale below) so a
    // genuinely abandoned request does not go silent forever.
    const archiveRequestPending = entry.archive_request_only_unread === true;
    const archiveRequestAgeMs = (archiveRequestPending && Number.isFinite(entry.oldestDirectUnreadTs))
      ? (now - entry.oldestDirectUnreadTs) : null;
    const archiveRequestStale = archiveRequestAgeMs !== null
      && archiveRequestAgeMs >= resolveArchiveRequestRenagMs(process.env);
    const archiveRequestQuiet = archiveRequestPending && !archiveRequestStale;
    // IGNORE LIST (~/.anti-hall/devswarm/ignore.json {"ids":[...]}, see
    // companion/lib/devswarm-ignore.js): a user-listed id is suppressed from
    // this same urgent/attention nag — still tracked/shown in the roster
    // table below, just never nagged about. Never applied to a message that
    // came FROM a child/peer by design of the ids the user lists here; this
    // hook has no way to tell provenance beyond the caller's own judgement,
    // so this is opt-in, per-id, user-controlled.
    const nagIgnored = isNagIgnored(home, id);
    // GRACE WINDOW (SkyCrew report fix, see unreadIsGraced's header): computed
    // BEFORE the attention-push gate below so a just-sent message to a live
    // child lane does not immediately count as "need attention" — stuck/
    // notDraining are independent liveness signals and are NEVER suppressed
    // by this, only the unread-ONLY trigger is.
    const oldestUnreadTsForGate = Number.isFinite(entry.oldestDirectUnreadTs) ? entry.oldestDirectUnreadTs : null;
    const unreadGraced = unreadIsGraced({
      unread, oldestUnreadTs: oldestUnreadTsForGate, id, home, now, graceMs: resolveInboxGraceMs(process.env),
    });
    const unreadForNag = unread > 0 && !unreadGraced;
    // v0.107.1: row state is resolved BEFORE the attention/archive-ready pushes.
    // A workspace archived in the DevSwarm app (its builders record — or a twin
    // row sharing that archived worktree) is put away for good: nobody will
    // ever drain its mailbox, so it never nags. Previously this was only used
    // to relabel the table row below, after both pushes had already happened.
    let archivedRow = false;
    let appArchivedRow = false;
    try {
      const st = rowState({
        home, id, worktreePath: entry.worktreePath, repoKey, env: process.env, now, cache: appArchivedCache(),
      });
      archivedRow = st.archived;
      appArchivedRow = st.appArchived;
    } catch (_) { archivedRow = false; appArchivedRow = false; }
    // (Still listed in the table below, labelled archived — just never nagged.)
    // v0.108.0: nor while the owner has this very workspace on screen in the app.
    const rowWs = appWs(id, entry.worktreePath);
    const ownerFocused = !!(focusedId && rowWs && rowWs.id === focusedId);
    // archiveRequestQuiet only ever suppresses the unread/notDraining
    // triggers — a genuinely `stuck` (escalated/wedged) status is a
    // DIFFERENT liveness signal (verdictStatus, independent of this
    // workspace's unread contents) and must still nag regardless of a
    // pending archive-request.
    if (((unreadForNag && !archiveRequestQuiet) || stuck || (notDraining && !archiveRequestQuiet))
        && !archiveReadyQuiet && !nagIgnored && !appArchivedRow && !ownerFocused) {
      // wsName/oldestUnreadTs (item 5/6): human title + age for the reworded
      // "CHILD NOT DRAINING" segment below — read-only, zero extra store
      // reads (oldestDirectUnreadTs is already a zero-extra-read projection
      // field, see companion/lib/devswarm-store.js computeSummary).
      const wsName = (rowWs && rowWs.label) || names.readName(home, id);
      const oldestUnreadTs = oldestUnreadTsForGate;
      attention.push({
        id, unread, cursor, total, status, urgencyMax, wsName, oldestUnreadTs,
        notDraining: notDrainingForLabel, staleAntiHallMessage,
      });
    }

    try {
      // v0.108.0: with auto-archive mode "on" (and the archive verb available)
      // the supervisor archives this workspace itself — no user nag for the
      // rows its last sweep owns (companion/lib/devswarm-lifecycle.js).
      // archiveRequestQuiet (see its own comment above) suppresses this nudge
      // ONLY for the still-live-session case (`!archiveReadyQuiet`) — re-
      // pushing it there would just re-instruct the Primary to send the SAME
      // request again every ARCHIVE_NUDGE_COOLDOWN_MS while a live child is
      // simply waiting on its own user. The dead-session (archiveReadyQuiet)
      // case is DELIBERATELY EXEMPT: cmdArchiveRequest itself auto-archives
      // a dead+archive-ready target the next time this exact command runs
      // (see its own header) — re-suggesting it there is not redundant, it
      // is the only path left to actually finish that workspace.
      if (archiveReady && !appArchivedRow && !ownerFocused && !isArchiveIgnored(home, id)
          && archiveCooldownElapsed(home, id, now) && !autoArchiveOwnsRow(home, id, now)
          && !(archiveRequestQuiet && !archiveReadyQuiet)) {
        archiveList.push(id);
      }
    } catch (_) {}

    // --- live-table row (every ACTIVE workspace, every turn) ---
    try {
      // defect bf965e5729c5 (skip heartbeat stat for archived rows): the
      // archived check is now resolved FIRST, before the heartbeat read and
      // the richer readActivityTs/rowLivenessState calls below — for an
      // archived row, `ds` (a few lines down) is built from the `archivedRow
      // ? ... : displayStatus(...)` branch, which NEVER consults
      // heartbeat/dormant/idleAlive at all, so reading/computing them for an
      // archived row was pure waste on every turn. A non-archived row is
      // unaffected — same reads, same order relative to each other, just
      // after this (cheap, already-memoized-per-turn for the app-side half)
      // check instead of before it.
      // THE one row-state derivation (companion/lib/row-state.js): anti-hall's
      // own archived marker, then the app-side archived-set cache (see the
      // APP-SIDE note below) — the same answer the roster/diagnose/routing and
      // the parent Stop gate use.
      // (archivedRow / appArchivedRow resolved above, before the attention push.)
      // ARCHIVED-BUT-SUPERSEDED (defect df54edf54804 hardening): isArchivedWorkspace
      // returning false does not always mean "never archived" — a marker can exist
      // for THIS id but be superseded by a genuinely different (later) sessionId,
      // the shape 7e1ae67 built the supersede rule for: a still-running child
      // re-registered this id after its Primary archived it (cmdArchive's warning
      // at the archive call site names this same scenario). Surfacing that row as
      // plain `dormant`/`escalated` hides the fact that it WAS put away and came
      // back on its own — label it distinctly so the operator can tell "never
      // archived" apart from "archived, then a live child brought it back".
      // WORKTREE-DISCRIMINATED (critic fix, item 3): a bare archived/<id>.json
      // existsSync — with no worktree check — mislabels a genuinely NEW
      // workspace that merely reuses an old, unrelated archived id at a
      // DIFFERENT worktree as "superseded". Reuse the SAME shared gate
      // migrate/doctor use (companion/lib/devswarm-archive-gate.js), which
      // discriminates by worktreePath exactly like archivedCounterpartInfo
      // (scripts/devswarm.js) does — `archived:true` only when the marker's
      // worktree matches this row's, or a worktree-group sibling match holds.
      // A gate hit that comes back `migrateAsLive:true` (positive, current
      // reuse proof) is NOT superseded — it is treated as genuinely live/new
      // and falls through to the normal displayStatus ladder below, same as
      // a row with no marker at all.
      let archivedSuperseded = false;
      if (!archivedRow && isSafeId(id)) {
        try {
          const gate = archiveGateLib.resolveArchiveGate(
            home, id, { worktreePath: entry.worktreePath, sessionId: entry.sessionId }, fs, { now }
          );
          archivedSuperseded = !!(gate && gate.archived && !gate.migrateAsLive);
        } catch (_) { archivedSuperseded = false; }
      }
      // APP-SIDE archive (field): the owner archived the child in the DevSwarm
      // app, which never writes anti-hall's own archived/<id>.json — so the
      // check above stays false and the row kept rendering escalated. Same
      // liveness-axis-ONLY scoping: `not-draining` still wins below, exactly as
      // it does for a locally-archived row. Derived by ABSENCE from the
      // supervisor-written ACTIVE-set cache (ONE fs read, memoized for the whole
      // table), under all four of that lib's conjuncts — fresh cache, worktree
      // under the DevSwarm repos root, absent by BOTH id and worktreePath, and
      // older than the snapshot by the grace. `worktreePath` is passed because
      // two of those conjuncts are defined on it.
      if (!archivedRow && appArchivedRow) archivedRow = true;

      const row = { id, worktreePath: entry.worktreePath, sessionId: entry.sessionId };
      // The heartbeat read itself stays UNCONDITIONAL (defect bf965e5729c5,
      // P2-8): it is one cheap fs.readFileSync and feeds `activityTs` (the
      // table's "last" column) and `finish` for EVERY row, archived
      // included — skipping it would let an archived row's "last" column go
      // silently stale forever. Only the EXPENSIVE, transcript-mtime-backed
      // richer liveness calls below (readActivityTs/rowLivenessState) are
      // skipped for an archived row — their result (dormant/idleAlive) is
      // never consulted by the `archivedRow` branch of `ds` a few lines down.
      const heartbeat = freshness.readHeartbeat(home, id);
      // P2-b: pass the already-parsed heartbeat ts through to readActivityTs /
      // isDormantRow below so neither re-reads heartbeats/<id>.json a second
      // time this turn (freshness.readHeartbeat above already read it once).
      const heartbeatTsOpt = heartbeat && Number.isFinite(heartbeat.ts) ? heartbeat.ts : undefined;
      // Compose the widest activity signal available (companion/lib/liveness.js
      // readActivityTs): heartbeat OR live-session transcript mtime OR the
      // supervisor verdict. The transcript term is what keeps a child mid-long-turn
      // observably alive — heartbeats are turn-scoped and go quiet for the whole of
      // a long autonomous turn. Falls back to the previous two-input signal on any
      // failure, so this can only ever widen liveness, never narrow it.
      let activityTs = freshness.lastActivityTs(verdict, heartbeat);
      let dormant = false;
      let idleAlive = false;
      if (!archivedRow) {
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
          // rowLivenessState adds the SESSION-SOURCED axis (defect 699a236129c5)
          // on top of the identical timestamp rule: a row whose sessionId maps to
          // a RUNNING harness process is `idle-alive`, surfaced with its own label
          // instead of being mislabelled `dormant` and nagged about.
          const state = livenessLib.rowLivenessState(
            row, home,
            { now, lastOutboundTs: verdict && verdict.lastOutboundTs, heartbeatTs: heartbeatTsOpt }
          );
          dormant = state === 'dormant';
          idleAlive = state === 'idle-alive';
        } catch (_) {}
      }
      // FIELD: an ARCHIVED workspace is done and put away — it is still listed,
      // but never as escalated/stale/dormant (see devswarm-archived.js). R15 P2
      // FIX: this used to also blanket-suppress `not-draining` — an archived row
      // with a REAL aging unread backlog silently lost that signal, exactly the
      // coordination-neglect axis `not-draining` exists to name (it is a
      // separate axis from the liveness one archiving legitimately suppresses;
      // see displayStatus's own header comment on that distinction). `archived`
      // now suppresses ONLY the liveness axis (escalated/stale/dormant), same
      // shape as `idleAlive` above — `not-draining` (rank 1.5) still wins over
      // it when present, exactly as it already wins over every other liveness
      // label in displayStatus's own rank order.
      // notDrainingFlag reuses the SAME per-iteration value computed above
      // (already accounts for the item 4b stale-build override) — never
      // re-derived from `verdict` independently, so this can never disagree
      // with the attention-push gate's own notDraining/staleAntiHallVersion
      // decision for the identical row.
      const notDrainingFlag = notDrainingForLabel;
      // item 4b: stale-anti-hall-build wins over EVERY branch below (archived/
      // archived-superseded/plain displayStatus) — same "wins over everything"
      // posture not-draining itself already has (see the comment above), for
      // the same reason: a stale build cannot self-clear by archiving or by
      // any liveness signal, and needs its own distinct, actionable label.
      // APP-ARCHIVED FIX (P0 field bug, follow-up to R15 P2 above): the "+N
      // archived" table-collapsing display elsewhere hides rows whose label
      // is exactly 'archived' — an app-archived row (archived via the
      // DevSwarm app UI, never anti-hall's own archived/<id>.json marker; see
      // appArchivedRow's own header) that ALSO carries a stored notDraining
      // verdict kept rendering 'not-draining' and so was NEVER collapsed,
      // sitting in the loud table forever for a workspace the owner already
      // put away through the app. A LOCALLY-archived row (archivedRow true,
      // appArchivedRow false) keeps R15 P2's behavior unchanged — its
      // not-draining backlog is real, actionable coordination-neglect signal
      // this hook must never hide. Only the app-archived case is forced
      // plain 'archived' regardless of notDrainingFlag.
      // Merge note (v0.108.0 integration): an APP-archived row stays plain
      // 'archived' even when stale — the owner already put it away in the app,
      // and a label that can never self-clear would keep it loud forever (the
      // exact bug the app-archived fix above closed).
      const ds = (staleAntiHallVersion && !appArchivedRow)
        ? { label: 'stale anti-hall ' + staleAntiHallVersion, rank: 1.5 }
        : archivedRow
          ? (appArchivedRow ? { label: 'archived', rank: 6 } : (notDrainingFlag ? { label: 'not-draining', rank: 1.5 } : { label: 'archived', rank: 6 }))
          : archivedSuperseded
            ? (notDrainingFlag ? { label: 'not-draining', rank: 1.5 } : { label: 'archived-superseded (live child)', rank: 5.5 })
            : displayStatus(archiveReady, status, activityTs, now, dormant, notDrainingFlag, idleAlive);
      // ARCHIVE-READY-QUIET override (see archiveReadyQuiet's own comment
      // above) — applied AFTER `ds` above rather than by touching the pinned
      // ternary itself (tests/hooks/devswarm-parent-inbox-archived-notdraining
      // .test.js pins that exact literal text, including its mutation guard).
      // A row whose `notDraining` verdict can NEVER clear on its own (nobody
      // is left to drain it) must not sit labeled `not-draining` forever —
      // recompute with notDraining forced off, which (since archiveReadyQuiet
      // implies archiveReady, and never applies to the archived/superseded
      // branches — a DIFFERENT axis) lands on the plain `archive-ready`
      // label, still shown every turn in the roster ("IT DEMOTES, IT DOES
      // NOT HIDE") — just not the loudest one.
      const dsFinal = (archiveReadyQuiet && !archivedRow && !archivedSuperseded && ds.label === 'not-draining')
        ? displayStatus(archiveReady, status, activityTs, now, dormant, false, idleAlive)
        : ds;
      // v0.108.0 app-DB extras (all report-only): the app's PR record as an
      // extra finish signal (never overrides the gates), the UI title, sidebar
      // rank as a tiebreak, and pinned / on-screen / brief-delivery markers.
      let finishCell = doneStateLabel(summary, id, heartbeat);
      let appMarks = '';
      try {
        const sig = appDbLib ? appDbLib.finishSignal(rowWs) : null;
        if (sig) finishCell = finishCell === '—' ? sig : finishCell + ' · ' + sig;
        const brief = appDbLib ? appDbLib.briefDelivery(appSnap(), rowWs, now) : null;
        appMarks = appRowMarkers(rowWs, brief, !!(focusedId && rowWs && rowWs.id === focusedId));
      } catch (_) { appMarks = ''; }
      rows.push({
        id,
        label: dsFinal.label,
        rank: dsFinal.rank,
        finish: finishCell,
        appRank: rowWs && Number.isFinite(rowWs.rank) ? rowWs.rank : null,
        appMarks,
        unread,
        lastActivityTs: activityTs,
        // wsName (task #6): cached human display name, read-only fs
        // projection lookup ONLY — never a hivecontrol spawn on this
        // every-turn hot path. null when not yet cached (buildWorkspaceTable
        // falls back to the bare id via names.displayName).
        wsName: (rowWs && rowWs.label) || names.readName(home, id),
        // unpushed/noUpstream/mergedVerified (git ground-truth report-only
        // markers, threaded from computeSummary — see devswarm-store.js /
        // devswarm-git-truth.js): absent-vs-present is significant, so these
        // are read straight from `entry`, never defaulted to a falsy-looking
        // value that could be mistaken for "checked and clean".
        unpushed: entry && Number.isFinite(entry.unpushed) ? entry.unpushed : null,
        noUpstream: !!(entry && entry.noUpstream === true),
        mergedVerified: entry ? entry.mergedVerified : undefined,
      });
    } catch (e) { logSegmentError(home, 'table-row', e); }
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
      const ownRawUnread = ownEntry && Number.isFinite(ownEntry.unread) && ownEntry.unread > 0 ? ownEntry.unread : 0;
      // OWN-INSTANCE PROJECTION (defect f061789267c1 / a77b85571dfa, P0) — same
      // min-floor phantom-unread fix as hooks/devswarm-parent-gate.js's own.unread;
      // see companion/lib/devswarm-own-reader.js for the shared implementation and
      // proof. `primaryId` here is ALWAYS this caller's own row, never a child's.
      if (ownRawUnread > 0) {
        const corrected = ownReaderUnread(home, cwd || gitTop, primaryId, ownEntry, ownRawUnread);
        // STALE-CACHE GUARD (P1, Critic NO-GO): `null` means this reader's
        // live position has caught up to or passed what the cached summary
        // ever knew `total` to be — the cache cannot vouch that 0 (or any
        // computed number) is correct, since mail may have landed after the
        // snapshot. This is a REPORT-ONLY nudge segment, not a hard gate, so
        // its safe fallback is the RAW pre-fix number (the same
        // conservative, never-hides-mail number this whole file showed
        // before the P0 fix) rather than silently displaying 0.
        ownUnread = corrected === null ? ownRawUnread : corrected;
        if (ownUnread > 0) ownUrgencyMax = ownEntry.urgencyMax || null;
      }
      if (ownEntry && Array.isArray(ownEntry.pendingQuestions)) {
        ownPendingQuestions = ownEntry.pendingQuestions;
      }
    }
  } catch (_) { ownUnread = 0; ownUrgencyMax = null; ownPendingQuestions = []; }

  // Fold in any app-DB-proven own-checkout row(s) found under a DIFFERENT id
  // in the main loop above (see ownCheckoutRootCache/builderTypeFor's own
  // header) — computed independently of the try/catch above so a failure
  // there can never silently drop it.
  if (ownCheckoutExtraUnread > 0) {
    ownUnread += ownCheckoutExtraUnread;
    if (!ownUrgencyMax) ownUrgencyMax = ownCheckoutExtraUrgency;
  }

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
  // ownUnansweredInformational (R17 item 3) — retired-sender questions, split
  // out of ownUnanswered below. Never counted toward the blocking figure;
  // rendered once, informationally, by buildOwnUnreadSegment.
  let ownUnansweredInformational = [];
  try {
    const replyStateMod = require('../companion/lib/devswarm-reply-state.js');
    const replyState = replyStateMod.readReplyState(repoKey, home);
    // IDENTITY-FAMILY CROSS-CHECK (defect f3b8f326bfc3): this notice used to
    // call the RAW comparison while hooks/devswarm-parent-gate.js ran the
    // family-aware one over the very same pendingQuestions and the very same
    // reply-state file. A reply whose `--to` resolved to a sibling registry row
    // of the SAME worktree therefore stopped the Stop gate blocking while THIS
    // every-turn notice kept reporting the question as unanswered forever —
    // reproduced end-to-end against both hooks with identical on-disk state.
    // Both surfaces now share ONE definition (see familyAwareUnanswered's header
    // for why the two id-spaces diverge, and for its fail-open contract: an
    // unknown sender, an empty descriptor set or any error returns the raw set
    // unchanged, so this can only ever drop a false positive).
    let descriptors = [];
    // LAZY require (this hook fires on EVERY UserPromptSubmit; the descriptor
    // read is only needed when there IS a question to cross-check).
    try { descriptors = require('../companion/devswarm-supervisor.js').readDescriptors(home) || []; }
    catch (_) { descriptors = []; }
    const meshIdCache = new Map();
    // Phase 2 mesh redesign, B3: this used to be a hand-rolled fast path
    // (pure-fs findGitToplevel + repoKeyForWorktreeFast's zero-spawn
    // submodule-shape detector, falling back to the full spawn-based
    // canonicalMeshId ONLY when the fs walk couldn't confirm a non-submodule
    // toplevel — the perf fix that made this hook's dominant CPU cost,
    // profiled 94% of sampled time, ToolFox3 2026-09-19). identity.js's
    // resolveContext IS that fast path (zero-spawn-first fs walk, submodule-
    // hop fallback only when genuinely needed) with correct submodule handling
    // built in rather than approximated, so both branches collapse to one call
    // — and it fixes D5 (this hook's own phantom-meshId-inside-a-submodule
    // defect) as a side effect, since resolveContext folds a submodule cwd
    // onto its outermost superproject instead of stopping at the submodule's
    // own toplevel.
    const resolveMeshId = (wt) => {
      if (meshIdCache.has(wt)) return meshIdCache.get(wt);
      let k = null;
      try {
        k = wt ? require('../companion/lib/identity.js').resolveContext(wt, { home, missingPath: 'ancestor' }).meshId : null;
      } catch (_) { k = null; }
      meshIdCache.set(wt, k);
      return k;
    };
    // registryRows — the STORE REGISTRY id space, projected verbatim into the
    // summary already parsed above (defect f3b8f326bfc3). A reply is recorded
    // under whichever registry row `send --to` resolved, and many of those rows
    // have no descriptor file, so the descriptor-only family map could never see
    // them. Free: same parsed object, no extra read.
    let registryRows = [];
    let archivedKnown = false;
    try {
      const ws = (summary && summary.workspaces) || {};
      // `sessionId` rides along so recipientFamilyIds can see this workspace's
      // own uuid/builder-id twin (the `twin.sessionId === anchor.id` cross-link)
      // — defect f3b8f326bfc3, same projection the Stop gate makes.
      registryRows = Object.keys(ws).map((wid) => ({
        id: wid,
        worktreePath: (ws[wid] && ws[wid].worktreePath) || null,
        sessionId: (ws[wid] && ws[wid].sessionId) || null,
      }));
      // archivedRegistryRows (R18 critic fix) — fold the archived half of the
      // registry in too, so partitionUnanswered never mistakes an
      // archived-but-still-live sender for fully retired. See its own header
      // (companion/lib/devswarm-reply-state.js) and devswarm-parent-gate.js's
      // matching fold for the full rationale.
      archivedKnown = Array.isArray(summary && summary.archivedRegistryRows);
      if (archivedKnown) {
        for (const r of summary.archivedRegistryRows) {
          if (!r || r.id == null) continue;
          registryRows.push({ id: r.id, worktreePath: r.worktreePath || null, sessionId: r.sessionId || null });
        }
      }
    } catch (_) { registryRows = []; archivedKnown = false; }
    ownUnanswered = replyStateMod.familyAwareUnanswered({
      pendingQuestions: ownPendingQuestions, replyState, descriptors, resolveMeshId, registryRows,
      // The recipient of these questions — its own row and its twins can never
      // answer them (defect f3b8f326bfc3). The Stop gate passes the same thing,
      // so the two surfaces stay one rule.
      selfId: primaryId || null,
    });
    // RETIRED-SENDER PARTITION (R17 item 3): a question whose `from` matches
    // NO row anywhere (descriptors nor registryRows, live or dead) has no
    // repliable target — `send --to` has nothing to resolve, and no reply
    // could ever clear it via familyAwareUnanswered above either. This used
    // to keep naming such a question in "N remain UNANSWERED" every turn
    // forever (no ceiling on this per-turn notice, unlike the Stop gate's
    // question-set escalation ceiling). Split it out: it renders once, below,
    // as an INFORMATIONAL line — never counted in `ownUnanswered.length` (the
    // blocking figure buildOwnUnreadSegment nags on) again.
    const partitioned = replyStateMod.partitionUnanswered(ownUnanswered, descriptors, registryRows, { archivedKnown });
    ownUnanswered = partitioned.blocking;
    ownUnansweredInformational = partitioned.informational;
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
  const sessionId = (payload && typeof payload.session_id === 'string' && payload.session_id) ? payload.session_id : null;
  const transcriptPath = (payload && typeof payload.transcript_path === 'string') ? payload.transcript_path : null;

  // Daemon-freshness staleness banner, when present, is injected next — above
  // the table AND independent of rows.length (the legacy-fallback back-compat
  // path can fire the banner even with zero active workspaces, since repoKey —
  // and therefore the shared summary rows — may be unresolvable in exactly the
  // scenario that path exists for).
  if (staleBanner) segments.push(staleBanner);

  // v0.108.0 PRIMARY SEAT CONFLICT: SessionStart (devswarm-child-role.js)
  // warned that another LIVE session holds this Primary seat; repeat it on the
  // first prompt while it still holds (then stop — the verbs keep refusing).
  try {
    if (sessionId) {
      const mp = path.join(home, '.anti-hall', 'devswarm', 'primary-seat', String(sessionId).replace(/[^A-Za-z0-9_-]/g, '') + '.json');
      const mark = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (mark && Number(mark.shown) < 2) {
        const seat = require('../companion/lib/primary-seat.js');
        const v = seat.seatVerdict({ home, env: Object.assign({}, process.env, { CLAUDE_CODE_SESSION_ID: sessionId }), cwd: cwd || process.cwd(), sessionId, light: true });
        if (v.state === 'conflict') segments.push(seat.conflictText(v, path.join(__dirname, '..', 'scripts', 'devswarm.js')));
        fs.writeFileSync(mp, JSON.stringify(Object.assign({}, mark, { shown: 2 })));
      }
    }
  } catch (_) { /* no marker: nothing to repeat */ }

  // v0.108.0 PRIMARY SESSION DRIFT (read-only): the anchor records a session
  // id; after a /clear the live session is a newer transcript, and a DevSwarm
  // restart resumes the anchor's OLD session. Name the newer one so the user
  // can /resume it. Deduped per session; no auto-action.
  try {
    if (primaryId && gitTop) {
      const desc = JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', primaryId + '.json'), 'utf8'));
      const drift = require('../companion/lib/primary-session-drift.js');
      const notice = drift.driftNotice(drift.anchorSessionDrift({ anchorSessionId: desc && desc.sessionId, worktree: gitTop, home, currentSessionId: sessionId }), sessionId);
      if (notice && dedupeEmit(home, sessionId, 'parent-inbox-session-drift', notice, { transcriptPath, keepaliveTurns: 20 })) segments.push(notice);
    }
  } catch (_) { /* no descriptor / unreadable: no notice */ }

  // Live workspace table — the always-on status overview the Primary reads
  // every turn. Attention-needed rows (escalated/stale) sort to the top; ties by
  // unread desc, then id. Capped at MAX_TABLE_ROWS with a logged "+N more".
  if (rows.length) {
    const appRankOf = (r) => (Number.isFinite(r.appRank) ? r.appRank : Infinity);
    rows.sort((a, b) => (a.rank - b.rank) || (b.unread - a.unread)
      || ((appRankOf(a) - appRankOf(b)) || 0) // v0.108.0: sidebar order breaks ties
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // D1 fix: drop archived rows BEFORE sort/cap so they can never consume a
    // MAX_TABLE_ROWS slot a live row needed (see rosterHideArchived's header).
    let archivedHidden = 0;
    const activeRows = rosterHideArchived(process.env)
      ? rows.filter((r) => {
        if (r.label === 'archived') { archivedHidden += 1; return false; }
        return true;
      })
      : rows;
    const maxRows = rosterMaxRows(process.env);
    const capped = activeRows.length > maxRows;
    const shown = capped ? activeRows.slice(0, maxRows) : activeRows;
    const evicted = capped ? activeRows.slice(maxRows) : [];
    if (capped) logTableCap(home, activeRows.length, shown.length);
    if (shown.length || archivedHidden) {
      // D3: on-change dedupe (lib/emit-dedupe.js rule b) — re-emitted only when
      // the table changed beyond relative ages, or as a keepalive every
      // 10 unchanged DELIVERED turns. Fail-open: emit.
      const table = buildWorkspaceTable(shown, now, capped, activeRows.length - shown.length, evicted, archivedHidden);
      if (dedupeEmit(home, sessionId, 'parent-inbox-table', table,
        { transcriptPath, keepaliveTurns: 10, normalize: normalizeTableAges })) {
        segments.push(table);
        segments.push(TITLE_INSTRUCTION);
      }
    }
    // v0.108.0: ask for a sidebar screenshot only when the app DB cannot settle
    // archive state (conflict or unreadable) — once per session per set.
    try {
      const st = { conflicts: [], unreadable: false };
      try {
        const as = JSON.parse(fs.readFileSync(path.join(devswarmRoot(home), 'app-state.json'), 'utf8'));
        if (as && Array.isArray(as.openButMarkedArchived)) {
          // P1 fix: app-state.json's openButMarkedArchived is HOME-GLOBAL (every
          // repo the app knows about), so it must be scoped to THIS session's
          // repo before it reaches uiSyncAsk — otherwise the owner gets asked
          // for a screenshot about workspaces in other repos entirely. Scoped
          // by REPO identity, the same way as the D29 filter on the summary
          // rows above: the repoKey of the entry's worktreePath (the
          // canonicalized realpath `scripts/devswarm.js` syncAppState stamps
          // on each entry) must equal this Primary's repoKey. A conflict is a
          // CHILD worktree, never the Primary's own checkout, so comparing
          // worktreePath to gitTop dropped every real conflict (0.108.3). Not
          // the app-DB repositoryId: this ask fires ONLY when the app DB is
          // unreadable (v0.108.3), so there is no live snapshot to resolve
          // one against. Fail CLOSED: an entry lacking worktreePath (written
          // by 0.108.0-0.108.2), a worktree whose repoKey no longer resolves,
          // or an unresolvable current repo never matches, so it is never
          // shown (better a missed ask than a cross-repo one). syncAppState
          // regenerates app-state.json every supervisor tick, so legacy
          // entries self-repair on the next sync — no migration needed.
          st.conflicts = repoKey
            ? as.openButMarkedArchived.filter((c) => c && c.worktreePath && repoKeyOfWorktree(String(c.worktreePath)) === repoKey)
            : [];
        }
      } catch (_) { /* no sync yet */ }
      if (appDbLib && !appSnap()) {
        const f = appDbLib.appDbPath({ home, env: process.env });
        try { st.unreadable = !!f && fs.statSync(f).isFile(); } catch (_) { st.unreadable = false; }
      }
      const ask = uiSyncAsk(home, sessionId, st, rows.map((r) => String(r.id)), now);
      if (ask) segments.push(ask);
    } catch (_) { /* fail-open */ }
  }

  // Stuck-mesh surfacing (LEAN, read-only) — orphans[]/staleRegistryPartitions[]
  // are additive summary fields (Phase A) surfaced ONLY when non-empty, so an
  // older summary.json or a clean mesh renders NOTHING extra here (fail-open,
  // byte-identical for a non-DevSwarm session and a clean mesh). No writes, no
  // auto-forward, no delete — the MAX_MESH_ISSUES cap above is the only anti-spam.
  try {
    if (summary && Array.isArray(summary.orphans) && summary.orphans.length) {
      const seg = buildOrphansSegment(summary.orphans);
      // D3: on-change dedupe (rule b) — the banner used to repeat unchanged
      // every turn (no persisted cooldown state).
      if (seg && dedupeEmit(home, sessionId, 'parent-inbox-orphans', seg, { transcriptPath, keepaliveTurns: 10 })) segments.push(seg);
    }
  } catch (e) { logSegmentError(home, 'orphans', e); }
  try {
    if (summary && Array.isArray(summary.staleRegistryPartitions) && summary.staleRegistryPartitions.length) {
      // FIX (defect a9ac2fc7e368): computeSummary's staleRegistryPartitions[]
      // only excludes anti-hall's OWN internal archive tombstone
      // (archivedOnlyIds — the `archived/<id>.json` anti-hall itself writes),
      // never the owner archiving the SAME workspace in the DevSwarm app —
      // that signal (isAppArchived, the absence-from-the-supervisor's
      // ACTIVE-set snapshot) is already consulted a few hundred lines above
      // for the live workspace table's own liveness label, but was never
      // applied here, so this table kept naming an app-archived-era
      // partition as "STALE WORKSPACE" forever. Each row here still carries
      // its own `worktreePath` (unlike an orphan[] row, which has none —
      // that surface needs its own, separate fix), so the same
      // appArchivedCache()/isAppArchived() this file already uses applies
      // directly. Fail-open: any isAppArchived error leaves the row exactly
      // as before (still shown) — this can only ever SUPPRESS on positive
      // evidence, never add a false suppression.
      const cache = appArchivedCache();
      const visible = summary.staleRegistryPartitions.filter((row) => {
        if (!row || row.id == null) return true;
        try {
          return !rowState({
            home, id: row.id, worktreePath: row.worktreePath, repoKey, env: process.env, now, cache,
          }).appArchived;
        } catch (_) { return true; }
      });
      if (visible.length) {
        const seg = buildStaleRegistrySegment(visible);
        // D3-style on-change dedupe (rule b): unlike orphans/table above, this
        // banner had no cooldown/dedupe of its own and repeated unchanged
        // every turn.
        if (seg && dedupeEmit(home, sessionId, 'parent-inbox-stale-registry', seg, { transcriptPath, keepaliveTurns: 10 })) {
          segments.push(seg);
        }
      }
    }
  } catch (e) { logSegmentError(home, 'stale-registry', e); }

  // Broadcast/roster feed (D3/D4/D22/D23/D27, Phase 8 step 2) — the shared
  // summary's top-level `recent[]` (plain broadcasts + heartbeats alike, D22),
  // rendered ADVISORY ONLY: this is roster/FYI context, NEVER a Stop-gate
  // trigger and NEVER mechanically dispatched — "react only if concerned" is
  // left to the model's own judgement (D27, no concerned-classifier invented).
  if (summary && Array.isArray(summary.recent) && summary.recent.length) {
    let toShow = summary.recent;
    try {
      const sessionId = payload && payload.session_id;
      toShow = visibleBroadcastRows(summary.recent, home, sessionId, now, process.env);
    } catch (_) { toShow = summary.recent; } // fail-open: never let this feed crash the hook
    if (toShow.length) segments.push(buildBroadcastSegment(toShow, home));
  }

  // The Primary's OWN unread is its own top-priority item — surfaced ahead of
  // the children's unread/idle summary. Gated on EITHER ownUnread > 0 OR
  // ownUnanswered.length > 0 (not ownUnread alone — regression fix): under the
  // mesh semantics pendingQuestions no longer clears on read/ack, so a fully
  // read-and-acked backlog (ownUnread === 0) can still hold a genuinely
  // unanswered question, and that state must keep surfacing every turn just
  // as much as a plain unread backlog does.
  if ((ownUnread > 0 || ownUnanswered.length > 0 || ownUnansweredInformational.length > 0) && primaryId) {
    segments.push(buildOwnUnreadSegment(ownUnread, primaryId, ownUrgencyMax, ownUnanswered, ownUnansweredInformational));
  }
  // Escalation notices the supervisor could NOT deliver to this Primary (not
  // registered in the mesh store, or its lock busy) are parked — surfaced here
  // every turn until delivered (same text as the Stop gate: recovery.js).
  try {
    const parked = require('../companion/lib/recovery.js').parkedEscalationSegment(home, primaryId, CLI);
    if (parked) segments.push(parked);
  } catch (e) { logSegmentError(home, 'parked-escalations', e); }

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
    if (urgentList.length) {
      // D3-style on-change dedupe (rule b): this segment used to repeat
      // unchanged on every turn (no cooldown/dedupe of its own, unlike the
      // archive-ready reminder below). A changed unread count/trend/status
      // still hashes differently and is emitted immediately.
      const urgentSeg = buildUrgentUnreadSegment(urgentList, home);
      if (dedupeEmit(home, sessionId, 'parent-inbox-urgent', urgentSeg, { transcriptPath, keepaliveTurns: 10 })) {
        segments.push(urgentSeg);
      }
    }
    if (normalList.length) {
      // Burst collapse only (rule a, no on-change): a changed unread set always
      // hashes differently and is emitted.
      const inboxSeg = buildUnreadSegment(normalList, home);
      if (dedupeEmit(home, sessionId, 'parent-inbox-nudge', inboxSeg, { transcriptPath, normalize: normalizeInboxVolatile })) {
        segments.push(inboxSeg);
      }
    }
    // Acceptance telemetry only when there is genuine unread backlog (not merely a
    // sticky escalated verdict with an empty inbox).
    const totalUnread = attention.reduce((s, w) => s + w.unread, 0);
    if (totalUnread > 0) logInjection(home, attention.filter((w) => w.unread > 0));
  }
  if (archiveList.length) {
    // NOT wrapped in dedupeEmit: the per-workspace ARCHIVE_NUDGE_COOLDOWN_MS
    // (10 min, above) is this reminder's OWN cooldown/dedupe — archiveList
    // already only contains workspaces whose cooldown has elapsed (isArchive-
    // NudgeDue, near line 593). Adding the generic on-change dedupe on top
    // suppressed it again for keepaliveTurns even after that cooldown legitimately
    // elapsed, since the re-emitted text hashes identically to the prior copy —
    // defeating the "persists once the cooldown elapses" contract this reminder
    // is designed to keep.
    const archiveSeg = buildArchiveSegment(archiveList);
    segments.push(archiveSeg);
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

module.exports = {
  displayStatus,
  // D1/D2 fixes — exported for direct unit testing, same convention as
  // displayStatus above:
  rosterHideArchived, rosterMaxRows, buildWorkspaceTable,
  truncateBroadcastBody, broadcastMaxAgeMs, broadcastKey,
  broadcastSeenPath, visibleBroadcastRows, buildBroadcastSegment,
  // emit-dedupe normalizers + segment builders (tests/hooks/emit-dedupe.test.js):
  normalizeTableAges, normalizeInboxVolatile, buildUnreadSegment, buildOrphansSegment, logSegmentError,
  buildUrgentUnreadSegment, buildArchiveSegment, buildStaleRegistrySegment,
  // inbox grace window (SkyCrew report fix) — exported for direct unit testing:
  unreadIsGraced, resolveInboxGraceMs, DEFAULT_INBOX_GRACE_MS,
  // finish column (task #36b) — exported for direct unit testing:
  doneStateLabel,
};
