#!/usr/bin/env node
// anti-hall :: devswarm-parent-gate (Stop hook, Primary only, loop-safe)
//
// Workaround for claude-code#39755 — the failure mode where a DevSwarm Primary
// orchestrator ENDS ITS TURN while a child workspace still has an unread inbox
// backlog past its cursor, or while the liveness supervisor has already judged a
// child STALE/ESCALATED. This gate fires on Stop and, for the PRIMARY session
// only, forces a bounded acknowledgement so the neglected child is attended to
// rather than silently abandoned off the Primary's task list.
//
// WHAT IT READS (audit P1-C — the Stop path has a ~30s budget and MUST stay
// cheap): it NEVER re-runs computeLiveness() and NEVER shells out to git, and
// NEVER opens the store DB. Signals come from files the supervisor / consumer /
// ingest daemon already wrote:
//   - CHILD unread backlog: the durable NDJSON inbox + its cursor, via the
//     read/ack primitive (companion/lib/devswarm-inbox-cursor.js readUnread) —
//     pure fs, the SAME projection the staleness detector consumes, no git.
//   - STALE / ESCALATED: the supervisor's already-written per-workspace verdict
//     file (companion/lib/liveness.js livenessPathFor -> ~/.anti-hall/devswarm/
//     liveness/<id>.json). Read-only. `escalated` is terminal/sticky (per
//     recovery.js) and counts as BLOCKING — same severity class as `stale`,
//     because escalation means the automatic poke already failed and a human
//     must look (P1-C default: yes, an escalated child also blocks the gate).
//   - PRIMARY's OWN unread (#34): unlike a child, the Primary has no descriptor
//     with its own inboxPath/cursorPath — its inbound is ingested by the daemon
//     directly into the store under workspaceId primary-<worktreeHash> and
//     exposed ONLY via the per-project summary projection (readOwnUnread reads
//     summaries/<worktreeHash>.json -> workspaces[primary-<hash>].unread), the
//     SAME projection devswarm-parent-inbox.js already reads for status/gates. A
//     single small fs read; still no git, no computeLiveness, no store DB open.
//
// INERTNESS (audit P1-D): this hook is a NO-OP until EITHER (a) workspace
// descriptors exist (~/.anti-hall/devswarm/workspaces/*.json) with a populated
// durable inbox, OR (b) the Primary's own summary-projected unread is nonzero.
// A public/standalone anti-hall user with no descriptors, no inbox tooling
// running, and no own-unread gets zero output, exit 0 — byte-identical to
// today. It is not self-sufficient; it depends on Phase 2's ingest daemon (or a
// consumer's equivalent) to have anything to act on.
//
// CLEAR PATH (audit P1-A): the non-skip escape is a real inbox read/ack that
// advances the cursor — the primitive in companion/lib/devswarm-inbox-cursor.js
// (advanceCursor(inboxPath, cursorPath) marks all current messages read; ackTo
// for a partial ack). The block reason states this exact path. skip-guard's TTL
// (~/.anti-hall/skip.json, guard name "devswarm-parent-gate") is the last-resort
// user-consented escape hatch.
//
// LOOP-SAFETY: a bounded per-SET forced-ack cap. The blocking SET is signed
// (workspace id + unread count + verdict status). The cap counter RESETS when
// that signature changes (new unread arrived, a child newly went stale, a
// partial ack moved a count) so each distinct neglect state gets its own small
// budget; once the SAME set has been forced-acked CAP times we go quiet. This
// can never hard-loop even if the model ignores the block. Default cap 3
// (clamped 2..5 via ANTIHALL_DEVSWARM_PARENT_GATE_CAP).
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { session_id?, cwd?, ... } — cwd (when present) resolves the
//            CURRENT worktree's Primary-own-unread summary (#34); falls back to
//            process.cwd() when absent, same posture as other Stop hooks
//            (e.g. task-guard.js documents cwd? as optional on this event).
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : always — fail-open on any error so a bug never hard-loops Claude.
//
// Pure Node built-ins. Cross-platform. Fail-open on EVERY error.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { isSkipped } = require('./skip-guard.js');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
// REUSE (never reimplement): descriptor discovery, the read/ack primitive, and
// the verdict-file path helper all already exist.
const { readDescriptors } = require('../companion/devswarm-supervisor.js');
const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');
const { livenessPathFor, devswarmRoot } = require('../companion/lib/liveness.js');
// primaryWorkspaceId/worktreeHash: the SAME per-worktree Primary-id convention
// devswarm-parent-inbox.js and the ingest daemon already use (#34 parity — the
// Primary's OWN unread, resolved below via readOwnUnread).
const installIngest = require('../companion/install-devswarm-ingest.js');

const GUARD_NAME = 'devswarm-parent-gate';
const DEFAULT_CAP = 3; // forced-acks per distinct blocking SET

// resolveCap(env) -> int in [2,5]. Absent / non-numeric / out-of-range falls
// back to the default (fail-open: a typo never disables or unbounds the gate).
function resolveCap(env) {
  const raw = (env || {}).ANTIHALL_DEVSWARM_PARENT_GATE_CAP;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n)) return Math.max(2, Math.min(5, n));
  }
  return DEFAULT_CAP;
}

// readVerdictStatus(id, home) -> string | null. Reads ONLY the supervisor's
// already-written per-workspace verdict file (no computeLiveness, no git).
// Absent / unreadable / malformed -> null (fail-safe: no verdict = not blocking
// on the liveness axis).
function readVerdictStatus(id, home) {
  try {
    const p = livenessPathFor(id, home); // throws on an unsafe id
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v.status === 'string' ? v.status : null;
  } catch (_) {
    return null;
  }
}

// stateFileFor(sessionId, home) — DISTINCT per-session loop-state, under
// ~/.anti-hall/devswarm/parent-gate/ (never the user's project tree; survives
// `cd`; keyed by session so dedupe is per-session).
function stateFileFor(sessionId, home) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(home, '.anti-hall', 'devswarm', 'parent-gate', safe + '.json');
}

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs walk-up
// looking for a `.git` entry — the same root `git rev-parse --show-toplevel`
// would report, WITHOUT spawning git (keeps this Stop hook's ~30s budget cheap).
// Mirrors devswarm-parent-inbox.js / devswarm-child-turn.js byte-for-byte (kept
// as a local copy rather than a shared require so this hook's dependency surface
// stays exactly what it already was — no new cross-file coupling for a few lines
// of pure fs walk).
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

// readOwnUnread(home, cwd) -> { unread, id }. The Primary's OWN inbound (#34) has
// no descriptor with an inboxPath/cursorPath to read via readUnread — it is
// ingested by the daemon directly into the store under workspaceId
// primary-<worktreeHash> and exposed ONLY via the per-project summary projection
// (summaries/<worktreeHash>.json -> workspaces[primary-<hash>].unread), the SAME
// projection devswarm-parent-inbox.js already reads for status/gates. A single
// small fs read — pure fs, no git spawn, no store DB open — stays within the
// Stop hook's cheap-read budget. Fail-open: ANY failure -> { unread: 0, id: null }
// (never blocks or throws on a missing/malformed summary).
function readOwnUnread(home, cwd) {
  try {
    const top = cwd ? findGitToplevel(cwd) : null;
    if (!top) return { unread: 0, id: null };
    const id = installIngest.primaryWorkspaceId(top);
    const hash = installIngest.worktreeHash(top);
    const p = path.join(devswarmRoot(home), 'summaries', String(hash) + '.json');
    const raw = String(fs.readFileSync(p, 'utf8')).trim();
    if (!raw) return { unread: 0, id };
    const summary = JSON.parse(raw);
    const entry = summary && summary.workspaces && summary.workspaces[id];
    const unread = entry && Number.isFinite(entry.unread) && entry.unread > 0 ? entry.unread : 0;
    return { unread, id };
  } catch (_) {
    return { unread: 0, id: null };
  }
}

function main() {
  // Read stdin (fd 0 — cross-platform; /dev/stdin is Windows-unsafe).
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return; }

  // Escape hatch: an explicit, user-consented skip outranks the guard.
  if (isSkipped(GUARD_NAME)) return;

  // Primary + DevSwarm-active only. A child workspace, a non-DevSwarm session, or
  // an inactive supervisor is a silent no-op.
  if (!isDevswarmActive(process.env)) return;
  if (isChildWorkspace(process.env)) return;

  let payload = {};
  try { payload = JSON.parse(raw); } catch (_) { return; }

  const home = os.homedir();

  // Primary's OWN inbound unread (#34 parity — the parent is gated on its OWN
  // unread too, not just children's). `cwd` falls back to process.cwd() when the
  // payload omits it, same fallback posture other Stop hooks use (e.g.
  // task-guard.js documents `cwd?` as optional on this event).
  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd) ? payload.cwd : process.cwd();
  const own = readOwnUnread(home, cwd);

  // INERT until descriptors exist (P1-D) OR the Primary itself has unread. No
  // descriptors and no own-unread -> nothing to gate.
  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }
  if (descriptors.length === 0 && own.unread === 0) return;

  // Build the blocking SET: workspaces with unread backlog past their cursor OR a
  // stale/escalated verdict, PLUS the Primary's own unread. All reads are pure fs
  // (no git, no computeLiveness, no store DB open).
  const blocking = [];
  if (own.unread > 0 && own.id) {
    blocking.push({ id: own.id, unread: own.unread, status: '' });
  }
  // #36 cross-project-bleed fix: exclude a descriptor ONLY when BOTH this
  // session's and the descriptor's repoId are present and DIFFER — fail-open by
  // construction. An old descriptor with no repoId (pre-#36) or a session with
  // no DEVSWARM_REPO_ID (manual supervisor mode) disables the filter entirely,
  // so nothing that showed before this fix can vanish; it only stops a Primary
  // in project A from being gated on project B's workspaces.
  const currentRepoId = process.env.DEVSWARM_REPO_ID;
  for (const d of descriptors) {
    if (currentRepoId && d.repoId && d.repoId !== currentRepoId) continue;
    let unreadCount = 0;
    try {
      const u = readUnread(d.inboxPath, d.cursorPath);
      if (u && u.known && u.count > 0) unreadCount = u.count;
    } catch (_) { /* unreadable inbox -> fail-safe: no unread */ }

    const status = readVerdictStatus(d.id, home);
    const staleOrEscalated = status === 'stale' || status === 'escalated';

    if (unreadCount > 0 || staleOrEscalated) {
      blocking.push({ id: String(d.id), unread: unreadCount, status: staleOrEscalated ? status : '' });
    }
  }

  const stateFile = stateFileFor(payload.session_id, home);

  // Nothing neglected -> clear any prior loop-state and stay quiet.
  if (blocking.length === 0) {
    try { fs.unlinkSync(stateFile); } catch (_) {}
    return;
  }

  // Signature of the blocking SET. The cap RESETS whenever this changes (P1: cap
  // resets when the unread SET changes). Includes unread counts AND verdict
  // status so a new message, a fresh stale/escalation, or a partial ack all
  // re-open the small budget.
  const sig = crypto.createHash('sha1').update(
    blocking
      .map((b) => b.id + '\x00' + b.unread + '\x00' + b.status)
      .sort()
      .join('\x1f')
  ).digest('hex');

  // Load prior loop-state { sig, blocks }.
  let lastSig = '';
  let blocks = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      lastSig = typeof parsed.sig === 'string' ? parsed.sig : '';
      blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
    }
  } catch (_) { /* first time / cleared */ }

  // Per-SET cap: the counter is only meaningful while the set is unchanged.
  const effectiveBlocks = sig === lastSig ? blocks : 0;
  const cap = resolveCap(process.env);
  if (effectiveBlocks >= cap) return; // this exact set has been forced-acked enough — go quiet

  // Persist BEFORE blocking so the cap is honored even if the model re-stops with
  // the same set. Can't persist -> fail-open (skip the block to avoid any loop).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ sig, blocks: effectiveBlocks + 1 }), 'utf8');
  } catch (_) { return; }

  const reason = buildReason(blocking, own.id);
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
}

// buildReason(blocking, ownId) -> string. Names up to 5 neglected workspaces with
// their unread counts / verdict status, then states the EXACT non-skip clear path
// for each axis (the child read/ack primitive, plus the distinct Primary-own-
// inbound read-primary path when ownId is among the blocking set) plus the
// skip-guard escape. Workspace ids are already path-safe (readDescriptors filters
// via isSafeId: /^[A-Za-z0-9._-]+$/; ownId comes from primaryWorkspaceId, same
// charset), so they carry no control chars / injection surface.
function buildReason(blocking, ownId) {
  const shown = blocking.slice(0, 5).map((b) => {
    const bits = [];
    if (b.unread > 0) bits.push(b.unread + ' unread');
    if (b.status) bits.push(b.status);
    return b.id + (b.id === ownId ? ' (you)' : '') + ' (' + bits.join(', ') + ')';
  }).join('; ');
  const more = blocking.length > 5 ? ' (and ' + (blocking.length - 5) + ' more)' : '';

  const ownEntry = ownId ? blocking.find((b) => b.id === ownId && b.unread > 0) : null;
  const anyChildUnread = blocking.some((b) => b.unread > 0 && b.id !== ownId);
  const anyStale = blocking.some((b) => b.status === 'stale' || b.status === 'escalated');

  let body =
    'DEVSWARM NEGLECT: ' + blocking.length + ' workspace(s) still need attention ' +
    'before this Primary turn ends: ' + shown + more + '. ';
  if (ownEntry) {
    body +=
      'YOU (the Primary) have ' + ownEntry.unread + ' unread parent/peer message(s) — ' +
      'STOP and read them FIRST via `devswarm.js inbox read-primary ' + ownId + '`. ';
  }
  if (anyChildUnread) {
    body +=
      'CLEAR the unread backlog by READING each workspace\'s unread inbox message(s), ' +
      'ACTING on them, then ADVANCING its cursor with the read/ack primitive at ' +
      'plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js ' +
      '(advanceCursor(inboxPath, cursorPath) marks all current messages read; ' +
      'ackTo for a partial ack). ';
  }
  if (anyStale) {
    body +=
      'A stale child is wedged (claude-code#39755); an escalated one already ' +
      'exhausted the automatic poke and needs a human — attend to it (on-demand ' +
      'devswarm-recover for a confirmed wedge, or reassign/archive). ';
  }
  body +=
    'If this is intentional, say so explicitly. Escape hatch: the user may direct a ' +
    'skip via ~/.anti-hall/skip.json ("devswarm-parent-gate").';
  return body;
}

try {
  main();
} catch (_) {
  // Fail-open: a bug here must never block or hard-loop the session.
}
process.exit(0);
