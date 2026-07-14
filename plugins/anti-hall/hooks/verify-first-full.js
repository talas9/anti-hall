#!/usr/bin/env node
// anti-hall :: verify-first FOUNDATION + discipline/skill index
//             (SessionStart [startup/resume/clear/compact])
//
// Emits the verify-first + root-cause CORE (Iron Law + rationalization/excuse
// table + Positive Rules + Scope & Fidelity) followed by the DISCIPLINES-vs-SKILLS
// index. This is the PRIMACY slot — the foundation every session needs first.
//
// SPLIT (the ~10,000-char per-hook injection cap — see below):
//   The ORCHESTRATION DISCIPLINE ruleset (rules A-N + DevSwarm rule W) lives in a
//   SEPARATE SessionStart hook, verify-first-orch.js. The single combined payload
//   was ~15.3k chars; Claude Code caps a hook's additionalContext at ~10,000 chars
//   and SPILLS the overflow to a file (only ~2k reaches the model inline), so the
//   orchestration doctrine never landed inline. The cap is PER HOOK COMMAND, so
//   splitting the doctrine across two SessionStart hooks — this foundation hook and
//   verify-first-orch.js — makes BOTH land 100% inline with ZERO content deleted.
//   Measured: this hook ~7.6k chars, verify-first-orch.js ~7.7k (see docs/KB.md).
//   The DISCIPLINE/SKILL INDEX stays HERE (with the foundation) rather than with
//   the orchestration rules purely so each half clears the cap with headroom
//   (foundation + rules would be ~12.9k; rules + index would be ~10.1k — over).
//
// COMPACTION SURVIVAL MECHANISM (F-11):
//   SessionStart re-fires AFTER compaction with source="compact" (alongside
//   startup/resume/clear), and that injection IS fresh post-reset context. A
//   no-matcher SessionStart entry runs for ALL sources, so it covers the
//   compaction boundary — the real survive-compaction mechanism.
//   PreCompact, by contrast, injects nothing: additionalContext reaches the model
//   on exit 0 only for UserPromptSubmit, UserPromptExpansion, and SessionStart;
//   PreCompact's only model-reaching field is decision/reason. So this script is
//   registered ONLY on SessionStart (no matcher) in hooks.json — one entry covers
//   startup/resume primacy AND compact re-inject; no separate "compact" matcher
//   (double-inject) and no PreCompact entry (inert). It echoes back the parsed
//   hookEventName (not a brittle substring match — F-20).
//
// Why this shape (KB-claude-codex.md):
//   - §6.1: Iron Law + table naming the model's SPECIFIC bypass excuses.
//   - §8.1/§6.2: hard rules at primacy slots (mid-prompt adherence drops ~30%).
//   - §3.3: state DO + WHY so it generalizes.
//   - §8.4: system prompt outranks user agreement.
//   - §9.6: permission to say "I don't know".
//
// Contract:
//   stdin  : JSON { hook_event_name, source?, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext }
//   exit 0 : always (never blocks). Fail-open on any error.

'use strict';

const fs = require('fs');

// Core Iron Law + Rationalization + Positive Rules + Scope & Fidelity lives in
// verify-first-core.js (shared with verify-first-subagent.js).
const { CORE_LINES } = require('./verify-first-core');

// DISCIPLINES-vs-SKILLS index: the "what always applies + what to invoke" map.
// The two ORCHESTRATION-flavored entries (orchestration, model-routing) summarize
// disciplines whose FULL ruleset (rules A-N) is delivered by the companion
// verify-first-orch.js injection — the pointer says "companion injection" rather
// than "the block above" because that block is no longer in THIS hook's payload.
const DISCIPLINES_INDEX = [
  'DISCIPLINES vs SKILLS:',
  'ALWAYS APPLY (enforced every session, not invoked):',
  "  - root-cause: the IRON LAW + RATIONALIZATION TABLE + POSITIVE RULES above. No claim without evidence; no fix without a proven root cause; instrument, don't guess.",
  '  - orchestration: command delegation is the top rule (never inline heavy commands, broad reads, or code-nav searches - bloated context induces hallucination). Non-blocking main thread; priority-sorted task list; drain tasks; bias toward delegating any tool/file/command/build/test/search work; parallel agents when independent; graphify-first when a graph exists; VERIFY delegated work - a subagent\'s "done/passing" is an unverified claim, re-check it against ground truth before marking complete. Full rules A-N in the companion ORCHESTRATION DISCIPLINE injection (verify-first-orch).',
  '  - anti-sycophancy: do not agree just to agree. If the user or a premise is wrong, challenge it with evidence. User agreement is not correctness (Positive Rule 9).',
  '  - scope-fidelity: the SCOPE & FIDELITY block. Simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish asked work and drop nothing.',
  '  - model-routing: orchestration rules M+N. Shallow+wide over deep nesting; lift 3+ parallel/nested spawns into a deterministic Workflow; set model EXPLICITLY per seat (implementation->sonnet, correctness/verify review->Codex, planning/architecture->opus) - never an all-Opus fan-out (it inherits the flagship and burns the limit). Codex is the always-on second-opinion correctness reviewer (it does not consume the Claude limit); Opus keeps the architecture/design lens.',
  'INVOKE WHEN IT MATCHES (conditional skills, not every turn):',
  '  - /anti-hall:root-cause - full debugging playbook when investigating a specific bug/failure.',
  '  - /anti-hall:orchestration - full swarm playbook when a task is large enough to plan a fan-out.',
  '  - /anti-hall:deadly-loop - HARDEN risky changes BEFORE merge: cross-file/cross-PR coordination, security-sensitive changes, schema/production-data touches, shell scripts, CI/workflow YAML, LLM-prompt work. Iterative Reviewer+Critic debate + fix waves until zero NEW P0s.',
  '  - /anti-hall:ship-it - ship any change correctly, S/M/L scaled to blast radius: brainstorm + plan IN PLAN MODE (ExitPlanMode is the gate), harden the plan with the deadly-loop BEFORE code, fan large work out as a Workflow swarm, verify each phase with fresh evidence + a vacuous-test guard until zero NEW P0s.',
];

// Foundation payload: the core protocol + the discipline/skill index. Identical in
// every session (DevSwarm or not) — the DevSwarm-Primary-specific rule W lives in
// verify-first-orch.js, so nothing here is env-gated.
const FOUNDATION = [...CORE_LINES, ...DISCIPLINES_INDEX].join('\n');

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }

  // Determine the firing event by PARSING the payload (F-20: no brittle
  // whitespace-sensitive substring match). This script is registered ONLY on
  // SessionStart, so SessionStart is both the expected and the safe default for
  // any unrecognized / missing value or parse failure.
  let event = 'SessionStart';
  try {
    const payload = JSON.parse(raw);
    const name = payload && typeof payload.hook_event_name === 'string'
      ? payload.hook_event_name
      : '';
    if (name === 'SessionStart') {
      event = 'SessionStart';
    }
    // Any other / missing value falls through to the SessionStart default.
  } catch (_) {
    event = 'SessionStart';
  }

  // Official Claude Code schema: `hookEventName` is NESTED inside
  // `hookSpecificOutput` (alongside `additionalContext`), not a top-level sibling.
  // KB §1.4 confirms `hookSpecificOutput.additionalContext` for SessionStart and
  // never names `hookEventName` as a peer; moving it to top level would break
  // context injection. Nesting is intentional and correct.
  const out = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: FOUNDATION,
    },
  };

  // SYNCHRONOUS write to fd 1. Why not process.stdout.write: when stdout is a
  // pipe (Claude Code, and spawnSync in the tests both capture it) and the payload
  // exceeds the OS pipe buffer, process.stdout.write becomes ASYNC — it buffers the
  // tail and returns false. The trailing process.exit(0) then tears the process
  // down BEFORE that buffer flushes, so the consumer reads EMPTY or PARTIAL stdout
  // with exit 0. This is the macOS node 18/20 truncation that made verify-first-full
  // subtests flake (node 22/24 changed exit-flush timing, hence they passed).
  // fs.writeSync blocks until every byte is handed to the pipe, so the full JSON is
  // guaranteed delivered regardless of node version / load.
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block session start or compaction.
}
process.exit(0);
