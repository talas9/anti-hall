#!/usr/bin/env node
// anti-hall :: devswarm-child-drain (PostToolUse, matcher Bash, CHILD-ONLY)
//
// THE OPERATIVE FIX (SkyCrew field incident): a DevSwarm child has NO mid-turn
// re-entry point. devswarm-child-turn.js fires on UserPromptSubmit — once per
// USER PROMPT, never during a long autonomous task. Field evidence: a child's
// mesh-direct unread rose 14 -> 15 WHILE the child was actively committing —
// a poke does not create a new UserPromptSubmit, so nothing re-surfaced the
// backlog until the child happened to stop and wait for another prompt.
// Children have NO OTHER per-tool-call re-entry: devswarm-parent-reply-
// tracker.js (this file's structural twin) is Primary-only (returns early for
// a child). This hook is the mirror image — CHILD-only, same PostToolUse/Bash
// registration shape — so a child now gets a re-entry point on EVERY tool
// call, not just once per prompt.
//
// SIGNAL: the shared union unread primitive (companion/lib/devswarm-unread.js
// — NDJSON durable inbox ∪ store-only mesh-direct backlog, hash-deduped; see
// that module's header for the root cause this closes: a `send --to` direct
// is STORE-ONLY and invisible to an NDJSON-only reader). Read against the
// child's OWN descriptor (workspaces/<DEVSWARM_BUILDER_ID>.json), the SAME
// descriptor devswarm-child-turn.js / devswarm-child-gate.js already resolve.
//
// THROTTLE (context-bloat guard — MANDATORY, not optional): this hook fires
// on EVERY Bash call. Injecting the same nudge every single call would drown
// the child's context in repeated noise — the exact failure mode anti-hall
// exists to prevent. A tiny persisted throttle state (child-drain/<id>.json)
// suppresses re-injection UNLESS the unread count has CHANGED since the last
// injection, or THROTTLE_MS has elapsed — so a growing/shrinking backlog is
// always re-surfaced promptly, but a static one is nudged at most once per
// window.
//
// Fail-open throughout: any error (malformed stdin, missing descriptor,
// unresolvable repoKey, a store-open failure, an unwritable throttle state)
// degrades to silent no-op — NEVER blocks, NEVER crashes, NEVER throws past
// main()'s own try/catch.
//
// Contract (Claude Code PostToolUse hook):
//   stdin  : JSON { hook_event_name?, tool_name, cwd?, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//            ONLY when injecting; nothing otherwise (empty-when-quiet, same
//            discipline as devswarm-child-turn.js's per-segment nudges).
//   exit 0 : always.
//
// stdout uses fs.writeSync(1, ...) — synchronous, avoids the macOS Node 18/20
// async-flush race (project convention, see devswarm-child-turn.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
const { devswarmRoot, isSafeId } = require('../companion/lib/liveness.js');
const devswarmUnread = require('../companion/lib/devswarm-unread.js');

const CLI = path.join(__dirname, '..', 'scripts', 'devswarm.js');

// THROTTLE_MS — re-injection cadence when the unread count has NOT changed.
// 10 minutes: long enough that a busy child mid-task isn't nagged on every
// one of dozens of tool calls, short enough that a genuinely stuck backlog is
// re-surfaced well within one work session.
const THROTTLE_MS = 10 * 60 * 1000;

function throttleStatePath(home, id) {
  return path.join(devswarmRoot(home), 'child-drain', String(id) + '.json');
}

// shouldInject(home, id, count, now) -> bool. Persists the decision's own
// state atomically. Fail-open TOWARD injecting: an unreadable/corrupt
// throttle file is treated as "never injected before" (inject now) rather
// than silently suppressing a real backlog forever.
function shouldInject(home, id, count, now) {
  const p = throttleStatePath(home, id);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { prev = null; }
  const lastCount = prev && Number.isFinite(prev.lastCount) ? prev.lastCount : null;
  const lastInjectedAt = prev && Number.isFinite(prev.lastInjectedAt) ? prev.lastInjectedAt : null;
  const changed = lastCount === null || lastCount !== count;
  const elapsed = lastInjectedAt === null || (now - lastInjectedAt) >= THROTTLE_MS;
  if (!changed && !elapsed) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastCount: count, lastInjectedAt: now }));
    fs.renameSync(tmp, p);
  } catch (_) { /* best-effort: a failed persist still lets this ONE injection through */ }
  return true;
}

// ageMinutes(ms) -> a compact "Xm" string, or "unknown age" when the age is
// not a known/finite non-negative number.
function ageMinutes(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  return Math.floor(ms / 60000) + 'm';
}

function buildMessage(count, id, oldestMs) {
  const age = ageMinutes(oldestMs);
  return (
    'DEVSWARM INBOX: ' + count + ' unread message(s) addressed to YOU (oldest ' + age
    + '). Drain NOW via `node ' + CLI + ' inbox pull ' + id + ' && node ' + CLI
    + ' inbox ack ' + id + '` before continuing; a parent ruling may change what you are building.'
  );
}

function main() {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch (_) { payload = {}; }

  const env = process.env;
  if (!isDevswarmActive(env)) return; // no-op for non-DevSwarm sessions
  if (!isChildWorkspace(env)) return; // CHILD-ONLY (inverse of the Primary-only reply-tracker)

  // Defensive: never assume the hooks.json matcher was honored.
  if (payload && payload.tool_name !== undefined && payload.tool_name !== 'Bash') return;

  const id = env.DEVSWARM_BUILDER_ID;
  if (typeof id !== 'string' || !isSafeId(id)) return;

  const home = os.homedir();
  let desc = null;
  try { desc = JSON.parse(fs.readFileSync(path.join(devswarmRoot(home), 'workspaces', id + '.json'), 'utf8')); } catch (_) { desc = null; }
  if (!desc || typeof desc !== 'object' || !desc.inboxPath) return;

  let union = null;
  try {
    const storeHandle = devswarmUnread.openStoreForUnread({ worktreePath: desc.worktreePath, id, home, env });
    if (storeHandle) {
      try {
        union = devswarmUnread.unionUnread({ inboxPath: desc.inboxPath, cursorPath: desc.cursorPath, id, storeHandle });
      } finally {
        try { storeHandle.close(); } catch (_) {}
      }
    } else {
      // Fall back to the NDJSON-only cursor primitive (no store resolvable) —
      // same fail-open posture as devswarm-child-gate.js's readDurableUnread.
      const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');
      const u = readUnread(desc.inboxPath, desc.cursorPath);
      union = { unread: u.known ? u.count : 0, oldestUnreadAgeMs: null };
    }
  } catch (_) { return; } // fail-open: never block/crash a tool call over this

  if (!union || !(union.unread > 0)) return; // empty-when-zero

  const now = Date.now();
  if (!shouldInject(home, id, union.unread, now)) return;

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: buildMessage(union.unread, id, union.oldestUnreadAgeMs),
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: any error -> no output, no crash.
}
process.exit(0);
