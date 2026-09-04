#!/usr/bin/env node
// anti-hall :: devswarm-comms-guard (PreToolUse SendMessage — DevSwarm mesh-only comms)
//
// Owner's rule (2026-09-04, defect 1c74863863e5): "the parent [DevSwarm Primary]
// uses Claude remote-agent messaging (the `SendMessage` tool) between parent and
// workspaces, which is prohibited — it should always channel comms through our
// mesh messaging." `ListAgents` lists a DevSwarm workspace's backing Claude session
// as an ordinary addressable peer, so `SendMessage` CAN reach a workspace directly
// (confirmed from both sides; a downstream fleet's 2026-09-02 stall came through
// exactly that path). This guard closes that one path — nothing wider.
//
// LAYERING (implemented exactly this, no wider — per the owner's brief):
//   1. Do NOT block in-process subagent steering. `SendMessage` to a background
//      subagent (agentId form `a<hex>-...`, or any target name this guard's own
//      session-index lookup CANNOT resolve to a live Claude session) is a
//      different address space and is how stalled workers get recovered without
//      losing context. Blocking it would be a regression worse than the drift.
//   2. Gate ONLY a `SendMessage` whose target resolves to a PEER SESSION whose
//      cwd is a REGISTERED DevSwarm workspace path (under ~/.devswarm/repos/),
//      while the current session is in DevSwarm Primary or child context
//      (`isDevswarmActive`).
//   3. The anti-hall maintainer peer session (the documented bug-report
//      exception) is never gated — carried SOLELY by the cwd predicate in (2):
//      that session's cwd is a plain repo checkout, not a devswarm workspace
//      path, so it never matches. There is deliberately NO name-based
//      exception on top of this. An earlier draft added one (matching
//      "anti-hall" in the target name) as a "belt-and-braces backstop"; it was
//      removed because it is a bypass, not a safety net — ANY DevSwarm
//      workspace whose session title happens to contain "anti-hall" (e.g. a
//      child spawned to test anti-hall itself, which this repo does for
//      substrate testing) would escape the block purely on its title. That is
//      exactly the "pattern-match the session title to decide" hazard Step 1
//      prohibited; being on the allow side instead of the block side makes it
//      a loophole rather than a false positive, but it is equally wrong. The
//      cwd check is the only exception mechanism.
//   4. Every SendMessage call while DevSwarm is active gets its target class
//      labeled via `additionalContext` (in-process subagent / peer session /
//      workspace-backed peer), whether allowed or blocked, so an owner can tell
//      at a glance what kind of send just happened.
//
// FEASIBILITY (answered — see task Step 1): CAN this hook resolve a `to` target
// to a WORKTREE? YES. Claude Code maintains a local per-process session index at
// ~/.claude/sessions/<pid>.json — one file per live/recent session, each
// carrying a `name` and a `cwd` field. A SendMessage `to` value (stripped of an
// optional trailing " [ref]" bracket, e.g. "fix-atlas-login-unknownerror2-9f
// [9b8fa3]" -> "fix-atlas-login-unknownerror2-9f") is matched against every
// session file's `name`; on a match, that session's `cwd` is checked against the
// DevSwarm workspace-registry path shape (~/.devswarm/repos/<repoId>/<hash>/
// <workspaceName>/...). This was verified empirically on this machine against
// live sessions — e.g. a session literally named "fix-atlas-login-
// unknownerror2-9f" with cwd ".../.devswarm/repos/0/32ac85da/fix-atlas-login-
// unknownerror2", exactly the shape of the owner's own example target. Because
// exact resolution IS possible, this guard BLOCKS the confirmed case rather than
// only warning (per the Step 1 instruction: "If exact resolution IS possible,
// implement the block on that").
//
// RELIABILITY LIMITATION (documented, not hidden): the session index can be
// stale — a session file may lag a just-spawned or just-exited process, or be
// momentarily unreadable under a concurrent write. On NO MATCH, or ANY
// read/parse error against the index, this guard does NOT block — it fails open
// toward allow, and only ever blocks a POSITIVELY CONFIRMED workspace-backed
// peer target. An unresolved target is labeled and allowed through. A known
// residual edge case: an in-process subagent/teammate NAME that happens to
// collide exactly with a live DevSwarm workspace session's name would be
// misclassified as that workspace peer — accepted as out of scope; DevSwarm
// workspace names (task-slug + short suffix) are not the kind of name a
// subagent/teammate is normally given.
//
// SCOPE LIMITATION (documented, not fixed here): the workspace check is "cwd
// resolves under ~/.devswarm/repos/" — i.e. ANY DevSwarm workspace anywhere on
// this machine, not narrowed to a registered workspace of THIS repo. Arguably
// correct under the owner's rule (the prohibition is "Primary/child <->
// workspace via SendMessage", not "own-repo workspace only"), but stated
// explicitly rather than left implicit. This also assumes the DevSwarm repos
// root is at its default location (~/.devswarm/repos); if DevSwarm ever
// supports relocating that root (e.g. via an env var), a relocated install
// would silently disarm this guard — known gap, not chased here.
//
// ARMING LIMITATION (documented, not fixed here): this guard only arms when
// `isDevswarmActive(process.env)` is true (DEVSWARM_REPO_ID set, or
// ANTIHALL_DEVSWARM_SUPERVISOR=on). This is the SAME latent env gap already
// known from devswarm-parent-reply-tracker.js: a Primary launched without that
// var set gets no guard at all, silently. Not fixed here — same limitation,
// same non-fix, tracked wherever the reply-tracker's is tracked.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { to, message, ... }, ... }
//   block  : fs.writeSync(1, JSON { decision: "block", reason }) + exit 2
//   allow  : fs.writeSync(1, JSON { hookSpecificOutput: {...} }) + exit 0 (labeled)
//   Fail-open on ANY error (exit 0). Honors the shared skip hatch
//   (`~/.anti-hall/skip.json`, key "devswarm-comms-guard").

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const DEVSWARM_REPOS_ROOT = path.join(os.homedir(), '.devswarm', 'repos');

// SendMessage's own tool docs: a background agent's raw agentId is format
// `a<hex>-<hex>...`. Matching this form is an immediate, unambiguous
// in-process-subagent signal — no session-index lookup needed.
const AGENT_ID_RE = /^a[0-9a-f]{4,}-[0-9a-f-]+$/i;

// stripRef("name [3fa9c1]") -> "name"; bare "name" is returned unchanged.
function stripRef(to) {
  const m = /^(.*?)\s*\[[0-9a-f]{4,16}\]\s*$/i.exec(to);
  return (m ? m[1] : to).trim();
}

// findSessionByName(name) -> { name, cwd } | null. Read-only scan of the local
// session index. Best-effort: a torn/unreadable/concurrently-written file is
// skipped, never fatal to the scan. Returns null (unresolved) if the index
// directory itself can't be read, or no session's `name` matches exactly.
function findSessionByName(name) {
  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch (_) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, entry), 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.name === 'string' && data.name === name) {
        return { name: data.name, cwd: typeof data.cwd === 'string' ? data.cwd : '' };
      }
    } catch (_) {
      // Skip this one file; keep scanning the rest of the index.
    }
  }
  return null;
}

// isDevswarmWorkspacePath(cwd) -> true iff cwd resolves under
// ~/.devswarm/repos/ (the DevSwarm workspace registry root).
function isDevswarmWorkspacePath(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  let resolved;
  try { resolved = path.resolve(cwd); } catch (_) { return false; }
  const rootWithSep = DEVSWARM_REPOS_ROOT + path.sep;
  return resolved === DEVSWARM_REPOS_ROOT || resolved.startsWith(rootWithSep);
}

// allow(): exit 0, optionally labeling the target class via additionalContext.
function allow(additionalContext) {
  if (additionalContext) {
    const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
    try { fs.writeSync(1, JSON.stringify(out) + '\n'); } catch (_) {}
  }
  process.exit(0);
}

// block(): top-level {decision:"block", reason} + exit 2 (matches swarm-guard's
// / model-routing-guard's shared block pattern).
function block(reason) {
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
  process.exit(2);
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }

  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('devswarm-comms-guard')) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); }
  if (!payload || typeof payload !== 'object') process.exit(0);

  // Defensive: the hooks.json matcher already scopes this to SendMessage, but
  // don't assume — a mismatched tool_name is a silent no-op, never a block.
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (toolName && toolName !== 'SendMessage') process.exit(0);

  // Only active in DevSwarm context (Primary or child) — inert otherwise.
  const { isDevswarmActive } = require('./lib/devswarm-detect.js');
  if (!isDevswarmActive(process.env)) process.exit(0);

  const input = (payload.tool_input && typeof payload.tool_input === 'object')
    ? payload.tool_input
    : {};
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  if (!to) process.exit(0);

  // "main": this session's own background-subagent-to-coordinator address, not
  // a cross-session peer at all.
  if (to.toLowerCase() === 'main') {
    allow(
      'DEVSWARM-COMMS (in-process): SendMessage target "main" is this session\'s own ' +
      'coordinator address, not a cross-session peer.'
    );
  }

  // Immediate in-process-subagent signal: the raw agentId form.
  if (AGENT_ID_RE.test(to)) {
    allow(
      'DEVSWARM-COMMS (in-process subagent): target "' + to + '" matches the ' +
      'background-agentId form (a<hex>-...) — a different address space from ' +
      'cross-session peers; allowed, never gated.'
    );
  }

  const bareName = stripRef(to);

  const session = findSessionByName(bareName);

  // No match in the local session index: cannot positively confirm this is a
  // workspace-backed peer. Fail-open toward allow (documented reliability
  // limitation above) — treat as in-process/unknown.
  if (!session) {
    allow(
      'DEVSWARM-COMMS (unresolved): target "' + to + '" did not match any live ' +
      'session in the local session index — treated as in-process/unknown and ' +
      'allowed. (The session index can lag a just-spawned or just-exited process.)'
    );
  }

  if (isDevswarmWorkspacePath(session.cwd)) {
    block(
      'anti-hall devswarm-comms-guard: SendMessage target "' + to + '" resolves to a ' +
      'DevSwarm WORKSPACE-BACKED PEER SESSION (cwd: ' + session.cwd + '). Direct ' +
      'Claude remote-agent messaging (SendMessage) between a DevSwarm Primary/child ' +
      'and a workspace is prohibited (owner rule 2026-09-04, defect 1c74863863e5) — ' +
      'channel this through the DevSwarm mesh instead: ' +
      'node plugins/anti-hall/scripts/devswarm.js send --to <meshId> --message "..." ' +
      '(resolve <meshId> from the DevSwarm workspace registry, not this session name).'
    );
  }

  // Matched a live session, but its cwd is NOT a DevSwarm workspace path — an
  // ordinary cross-session peer (e.g. another project's Claude session), not
  // the thing this rule targets.
  allow(
    'DEVSWARM-COMMS (peer session, non-workspace): target "' + to + '" resolves to a ' +
    'live session (cwd: ' + session.cwd + ') that is not a DevSwarm workspace path — allowed.'
  );
}

try {
  main();
} catch (_) {
  // Fail-open on ANY error.
}
process.exit(0);
