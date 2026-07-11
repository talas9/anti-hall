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
//     COOLDOWN'd nudge telling the Primary to INFORM THE USER to archive it in the
//     DevSwarm app. Teardown is GUI-only; this hook NEVER auto-archives and NEVER
//     removes a descriptor — recommend only. A workspace with an archive-ignore mark
//     is skipped (still tracked, just not surfaced). Once the user archives it the
//     descriptor disappears from readDescriptors() and the nudge stops on its own.
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

// A workspace whose supervisor verdict is one of these is idle/stuck (a wedged or
// escalated child), independent of whether it still has unread backlog.
const STUCK_STATUSES = new Set(['stale', 'nudged', 'escalated']);
// How long a per-workspace archive recommendation stays silent before it repeats.
// Reuses the proven liveness cooldown value (poke-cooldown pattern, P1-E) so the
// reminder is PERSISTENT but not literally every-turn.
const ARCHIVE_NUDGE_COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
const MAX_LISTED = 6; // cap workspaces named inline to keep additionalContext short

function summaryPath(home) {
  return path.join(devswarmRoot(home), 'summary.json');
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
function readSummary(home) {
  try {
    const raw = String(fs.readFileSync(summaryPath(home), 'utf8')).trim();
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

// verdictStatus(home, id) -> status string | null. Reads the supervisor's already-
// written fs verdict for a workspace (zero git, no computeLiveness). Prefers the
// derived summary.json entry (the designated hook read-surface, P1-C), then falls
// back to the persisted liveness verdict file so "idle" is meaningful even before
// Phase 2 derives summary.json.
function verdictStatus(home, id, summary) {
  const entry = summaryEntry(summary, id);
  if (entry && typeof entry.status === 'string') return entry.status;
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    if (v && typeof v.status === 'string') return v.status;
  } catch (_) {}
  return null;
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
function buildUnreadSegment(list) {
  const shown = list.slice(0, MAX_LISTED).map((w) => {
    const parts = [];
    if (w.unread > 0) parts.push(w.unread + ' unread');
    if (w.status && STUCK_STATUSES.has(w.status)) parts.push(w.status);
    return w.id + (parts.length ? ' (' + parts.join(', ') + ')' : '');
  });
  const extra = list.length > MAX_LISTED ? ' +' + (list.length - MAX_LISTED) + ' more' : '';
  return (
    'DEVSWARM PARENT INBOX: ' + list.length + ' active workspace(s) need attention — '
    + shown.join('; ') + extra + '. '
    + 'Read/ack each workspace inbox (or reassign/archive it) so it does not sit '
    + 'unnoticed off your task list; a workspace flagged stale/escalated has a '
    + 'wedged child — check on it.'
  );
}

// buildArchiveSegment(ids) -> string. Recommendation, NOT a block: teardown is
// GUI-only, so the Primary must inform the USER — it must never auto-archive.
function buildArchiveSegment(ids) {
  const shown = ids.slice(0, MAX_LISTED).join(', ');
  const extra = ids.length > MAX_LISTED ? ' (+' + (ids.length - MAX_LISTED) + ' more)' : '';
  return (
    'DEVSWARM ARCHIVE-READY: workspace(s) ' + shown + extra + ' are complete '
    + '(all required gates met). Teardown is GUI-only — INFORM THE USER to archive '
    + 'them in the DevSwarm app. NEVER auto-archive or remove a descriptor; recommend only.'
  );
}

function main() {
  // Read stdin for contract consistency; the payload carries nothing this hook
  // needs (role/liveness come from env + fs).
  try { fs.readFileSync(0, 'utf8'); } catch (_) { /* empty/absent stdin is fine */ }

  // Gate: PRIMARY DevSwarm sessions only. Anything else -> silent no-op.
  if (!isDevswarmActive(process.env)) return;
  if (isChildWorkspace(process.env)) return;

  const home = os.homedir();
  const now = Date.now();
  const summary = readSummary(home);

  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }

  const attention = []; // { id, unread, cursor, total, status }
  const archiveList = [];

  for (const d of descriptors) {
    if (!d || !isSafeId(d.id)) continue;
    // --- unread / idle ---
    let unread = 0, cursor = 0, total = 0;
    try {
      const u = readUnread(d.inboxPath, d.cursorPath);
      unread = u.known ? u.count : 0;
      cursor = u.cursor;
      total = u.total;
    } catch (_) {}
    const status = verdictStatus(home, d.id, summary);
    const stuck = status !== null && STUCK_STATUSES.has(status);
    if (unread > 0 || stuck) {
      attention.push({ id: d.id, unread, cursor, total, status });
    }

    // --- archive-ready recommendation (P1-E) ---
    try {
      if (isArchiveReady(d.id, summary) && !isArchiveIgnored(home, d.id)
          && archiveCooldownElapsed(home, d.id, now)) {
        archiveList.push(d.id);
      }
    } catch (_) {}
  }

  const segments = [];
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
