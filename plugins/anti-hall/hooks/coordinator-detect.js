'use strict';
// coordinator-detect.js — shared coordinator-vs-subagent detection, extracted
// from command-guard.js so other PreToolUse guards (e.g. edit-guard.js) can
// reuse the exact same detection logic without duplicating it.
//
// COORDINATOR vs SUBAGENT DETECTION
//   PRIMARY signal (works across environments — including cmux and other wrappers
//   where a subagent inherits the parent's exact env): Claude Code injects `agent_id`
//   and `agent_type` into the PreToolUse hook PAYLOAD for Task-tool subagents. The
//   top-level coordinator's payload has NEITHER. This is the reliable discriminator.
//   SECONDARY signal: CLAUDE_CODE_ENTRYPOINT === "agent_tool" — set on the subagent
//   PROCESS in a vanilla `claude` CLI, but NOT reliable under cmux (stays "cli"), so
//   it is only a fallback.
//   A command is treated as SUBAGENT (allow) if EITHER signal indicates a subagent.
//
//   FAIL-OPEN POLICY: if context is ambiguous (no agent markers in the payload AND an
//   absent/unrecognized entrypoint), we DO NOT block — unknown contexts are treated as
//   subagent (allow). This prevents deadlock in non-standard or future environments.

// A Task-tool subagent is identified by agent markers in the hook payload
// (reliable everywhere, incl. cmux) OR by the agent_tool entrypoint (vanilla CLI).
function isSubagent(payload) {
  if (payload && (payload.agent_id || payload.agent_type)) return true;
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'agent_tool') return true;
  return false;
}

// isSubagentByPayload(payload) -> bool. PAYLOAD-ONLY subagent signal — no
// CLAUDE_CODE_ENTRYPOINT env fallback (Wave R3 review, defect f0958b13fe2b).
// Use this instead of isSubagent() for any gate whose FALSE-POSITIVE cost is
// high (i.e. it BLOCKS rather than allows on a subagent match): a DevSwarm
// child workspace's env is inherited by its ENTIRE process tree, including a
// possibly-leaked CLAUDE_CODE_ENTRYPOINT=agent_tool if the child session was
// itself originally spawned as a subagent — that leaked var would then
// persist across every later process in the SAME session, including the
// child's own MAIN-THREAD cron tick / Monitor wake, and isSubagent()'s env
// fallback would misclassify those as a subagent forever, blocking a
// workspace's own main thread from its own mailbox. The payload-only signal
// (agent_id/agent_type) has no such leak: Claude Code injects it fresh, per
// Task-tool call, only into that subagent's OWN payload — it is never
// present on a main-thread turn's payload regardless of env history.
//
// KEY-PRESENCE, not truthiness (Wave R3 P2 hardening): checks `'agent_id' in
// payload` / `'agent_type' in payload` rather than `payload.agent_id` — a
// truthy check would treat `agent_id: ""` or `agent_id: 0` as "not a
// subagent" (falsy), which is the WRONG direction for a signal this
// conservative: the harness having stamped the KEY onto the payload at all
// is itself the subagent marker; an unusual falsy-but-present value should
// still count. `undefined`/`null` values are still excluded (the harness
// omitting the key entirely and the harness setting it to null are treated
// the same — neither is evidence of subagent context). Claude Code is not
// observed to ever emit an empty/falsy `agent_id`/`agent_type` in practice —
// this hardening covers a shape that has not been seen, not a fixed bug.
function isSubagentByPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const idPresent = 'agent_id' in payload && payload.agent_id != null;
  const typePresent = 'agent_type' in payload && payload.agent_type != null;
  return idPresent || typePresent;
}

// Coordinator = NOT a subagent, running under a recognized interactive entrypoint.
// Takes the parsed hook payload so it can use the payload's agent markers.
function isCoordinator(payload) {
  // Subagents are never the coordinator — allow them (the whole point of the guard
  // is to keep the MAIN thread clean by pushing heavy work down to subagents).
  if (isSubagent(payload)) return false;

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  // Fail-open: if absent or unknown, allow (treat as subagent)
  if (!entrypoint || typeof entrypoint !== 'string') return false;
  // cli, vscode, jetbrains, vim, emacs, terminal_ide_* = coordinator
  if (entrypoint === 'cli') return true;
  if (entrypoint.startsWith('terminal_ide_')) return true;
  if (['vscode', 'jetbrains', 'vim', 'emacs'].includes(entrypoint)) return true;
  // Unknown/future values: fail-open (allow)
  return false;
}

module.exports = { isSubagent, isSubagentByPayload, isCoordinator };
