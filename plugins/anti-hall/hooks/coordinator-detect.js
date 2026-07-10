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

module.exports = { isSubagent, isCoordinator };
