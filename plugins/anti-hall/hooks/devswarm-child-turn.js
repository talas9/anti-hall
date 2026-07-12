#!/usr/bin/env node
// anti-hall :: devswarm-child-turn (UserPromptSubmit)
//
// Layer 1 of the DevSwarm layered recovery model, per-turn complement to the
// SessionStart devswarm-child-role hook. Fires ONLY for a DevSwarm CHILD
// workspace sub-orchestrator (liveness supervisor active AND
// DEVSWARM_SOURCE_BRANCH non-empty). Does two things, both cheap:
//
//   1. HEARTBEAT (mechanical). Writes a durable, turn-authored heartbeat at
//      ~/.anti-hall/devswarm/heartbeats/<branch>.json carrying `ts` = now. This
//      is authored by THIS turn — proof the child session actually processed a
//      prompt — and NEVER by a background ticker (PLAN.md "Heartbeat authorship
//      rule": a daemon-written heartbeat stays "fresh" even while the session it
//      represents is wedged, producing a false-active read). We assert ONLY what
//      this turn can truthfully assert (a fresh `ts` plus the env correlators);
//      progress_pct/phase/wip/blockers are the child's to report and are NOT
//      fabricated here (absent = unknown).
//
//   2. REMINDER (advisory). Injects a short per-turn nudge to keep the parent
//      updated (`hivecontrol workspace message-parent`) and to stay responsive
//      to parent messages, so a child stays visible on the parent's task list.
//
//   3. UNREAD-INBOX SURFACING (advisory, reception gap). A child cannot run
//      `hivecontrol workspace monitor` / `read-messages` (command-guard blocks them
//      as destructive queue drains), so a parent->child message can sit unseen. This
//      hook does a NON-DESTRUCTIVE unread check on the child's OWN durable descriptor
//      inbox (workspaces/<DEVSWARM_BUILDER_ID>.json -> inboxPath/cursorPath, via the
//      inbox-cursor primitive — pure fs, no native-queue drain, no hivecontrol spawn)
//      and, when unread>0, tells the child it has N unread parent message(s) and the
//      SAFE (non-draining) way to read them. Empty-when-zero: with no durable inbox
//      populated it is a pure no-op. KNOWN GAP (v0.54.2): nothing shipped drains the
//      child's NATIVE parent->child queue into this durable inbox, so this fires only
//      once a child-side ingest/drain populates it — see the report/PLAN follow-up.
//
// Primary / non-DevSwarm sessions and malformed stdin are silent no-ops (no
// output, exit 0) — byte-identical to dormant. Fail-open on ANY error. Pure
// Node built-ins only.
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { hook_event_name, session_id, prompt, cwd, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//            (only when this session is a child; nothing otherwise)
//   exit 0 : always.
//
// stdout uses fs.writeSync(1, ...) — synchronous, avoids the macOS Node 18/20
// async-flush race (mirrors limit-conserve-inject.js / devswarm-child-role.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
const { devswarmRoot, isSafeId } = require('../companion/lib/liveness.js');
const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');

const REMINDER =
  'DEVSWARM CHILD WORKSPACE (per turn): keep the parent orchestrator updated — ' +
  'run `hivecontrol workspace message-parent` to report progress/blockers as you ' +
  'make them, and check for + act on any parent messages before continuing, so ' +
  'you stay visible on the parent\'s task list instead of drifting off it.';

// heartbeatKey(branch) -> a safe single path segment for the heartbeat filename.
// PLAN.md keys the heartbeat as heartbeats/<branch>.json; a plain branch like
// `main` stays clean, but a branch can carry `/` or other chars unsafe as a file
// name. When the branch is already a safe id we use it verbatim; otherwise we
// sanitize AND append a short deterministic hash of the RAW branch so two
// distinct branches that sanitize to the same string (e.g. `a/b` vs `a-b`) can
// never collide onto one heartbeat file (which would cross-contaminate liveness).
function heartbeatKey(branch) {
  if (isSafeId(branch)) return branch;
  const safe = String(branch).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '_').slice(0, 80) || 'branch';
  const hash = crypto.createHash('sha1').update(String(branch)).digest('hex').slice(0, 8);
  return safe + '-' + hash;
}

// writeHeartbeat(env, sessionId, home) — atomic tmp+rename write of the
// turn-authored heartbeat. Best-effort: any fs error is swallowed by the caller
// (a heartbeat-write failure must NEVER block a turn).
function writeHeartbeat(env, sessionId, home) {
  const branch = env.DEVSWARM_SOURCE_BRANCH;
  const key = heartbeatKey(branch);
  const dir = path.join(devswarmRoot(home), 'heartbeats');
  const target = path.join(dir, key + '.json');
  // Only what this turn can truthfully assert. `source` marks it turn-authored
  // (not a ticker); env correlators are copied verbatim (each is a real env
  // value), never relabeled into an unverified workspace-id claim.
  const beat = {
    ts: Date.now(),
    source: 'child-turn',
    branch: branch,
    repoId: env.DEVSWARM_REPO_ID || null,
    builderId: env.DEVSWARM_BUILDER_ID || null,
    builderName: env.DEVSWARM_BUILDER_NAME || null,
    sessionId: sessionId || null,
  };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(beat));
  fs.renameSync(tmp, target);
}

// unreadParentSegment(env, home) -> string | null. NON-DESTRUCTIVE unread check on
// the child's OWN durable descriptor inbox (workspaces/<DEVSWARM_BUILDER_ID>.json).
// Uses the inbox-cursor primitive (pure fs; never drains the native queue, never
// spawns hivecontrol). Returns a SHORT nudge naming the unread count + the SAFE
// (non-draining) read path when the durable child inbox has unread message(s);
// returns null otherwise (empty-when-zero: a child with no populated durable inbox
// stays a pure no-op). Fail-safe: ANY error -> null (never blocks or crashes a turn).
function unreadParentSegment(env, home) {
  try {
    const id = env.DEVSWARM_BUILDER_ID;
    if (typeof id !== 'string' || !isSafeId(id)) return null;
    const descPath = path.join(devswarmRoot(home), 'workspaces', id + '.json');
    let desc;
    try { desc = JSON.parse(fs.readFileSync(descPath, 'utf8')); } catch (_) { return null; }
    if (!desc || typeof desc !== 'object' || !desc.inboxPath) return null;
    const u = readUnread(desc.inboxPath, desc.cursorPath);
    if (!u.known || u.count <= 0) return null;
    return (
      'DEVSWARM CHILD INBOX: you have ' + u.count + ' unread parent message(s). Read '
      + 'them the SAFE, NON-DRAINING way via the durable inbox cursor — '
      + '`devswarm.js inbox read ' + id + '` (anti-hall devswarm CLI). Do NOT run '
      + '`hivecontrol workspace read-messages` or `monitor` — those DESTRUCTIVELY '
      + 'drain the native queue.'
    );
  } catch (_) {
    return null;
  }
}

function main() {
  // Read stdin for contract completeness; the only field we use is session_id
  // (a heartbeat correlator). Absent/malformed stdin is fine — fail-open.
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch (_) { payload = {}; }

  const env = process.env;
  // No-op for Primary / non-DevSwarm sessions: emit NOTHING (zero per-turn
  // overhead), byte-identical to dormant.
  if (!isDevswarmActive(env)) return;
  if (!isChildWorkspace(env)) return;

  // Heartbeat first, isolated so a write failure still lets the reminder through.
  try {
    writeHeartbeat(env, payload.session_id, os.homedir());
  } catch (_) { /* fail-open: never block a turn on a heartbeat write */ }

  // REMINDER is always present; append the unread-inbox nudge only when the child's
  // durable descriptor inbox actually has unread parent message(s) (empty-when-zero).
  const segments = [REMINDER];
  const unreadSeg = unreadParentSegment(env, os.homedir());
  if (unreadSeg) segments.push(unreadSeg);

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: segments.join('\n\n'),
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: any error -> no block, no crash.
}
process.exit(0);
