#!/usr/bin/env node
// anti-hall :: full verify-first protocol + skill primer
//             (SessionStart [startup/resume/clear/compact])
//
// Emits the FULL verify-first + root-cause protocol, restructured in the
// Superpowers "ONE Iron Law + rationalization/excuse table" form, plus a short
// skill primer. This is the PRIMACY slot.
//
// COMPACTION SURVIVAL MECHANISM (F-11):
//   Per Claude Code's SessionStart hook docs, SessionStart re-fires AFTER a
//   compaction with source="compact" (alongside startup/resume/clear), and that
//   injection IS fresh post-reset context. A SessionStart entry with NO matcher
//   runs for ALL sources, so it already covers the compaction boundary — that is
//   the actual survive-compaction mechanism here.
//   PreCompact, by contrast, does NOT inject context at all: per the official
//   Claude Code hooks docs, additionalContext is delivered on exit 0 only for
//   UserPromptSubmit, UserPromptExpansion, and SessionStart. A PreCompact hook's
//   additionalContext would be inert (never injected; PreCompact's only
//   model-reaching field is decision/reason to block compaction). This script is
//   therefore registered ONLY on SessionStart (no matcher) in hooks.json:
//     - SessionStart (no matcher) -> startup + resume primacy AND the
//       survive-compaction re-inject (source="compact") -- the REAL mechanism.
//   A single no-matcher SessionStart registration covers compact, so there is no
//   separate matcher-"compact" entry (it would double-inject the same protocol),
//   and no PreCompact registration (it would deliver nothing today).
//   The script echoes back whichever hookEventName it was fired with, parsed from
//   stdin (NOT a brittle substring match — F-20).
//
// Why this shape (KB-claude-codex.md):
//   - §6.1 Superpowers: an Iron Law + a table naming the model's SPECIFIC bypass
//     excuses works because the model already knows the rules; it needs its
//     escape hatches named.
//   - §8.1 Lost-in-the-Middle / §6.2 recency: place hard rules at primacy slots,
//     not buried mid-prompt where adherence drops ~30%.
//   - §3.3 model literalness: tell what to DO + WHY so it generalizes.
//   - §8.4 sycophancy: system prompts must explicitly outrank user agreement.
//   - §9.6 permission to say "I don't know".
//   - §1.6 output cap ~10,000 chars: this block is kept well under it.
//
// Contract:
//   stdin  : JSON { hook_event_name, source?, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext }
//   exit 0 : always (never blocks). Fail-open on any error.

'use strict';

const fs = require('fs');

// The full protocol text. Kept as a JS string so JSON.stringify escapes it
// correctly for any OS / any consumer. Well under the 10k additionalContext cap.
const FULL = [
  'VERIFY-FIRST + ROOT-CAUSE PROTOCOL (full; re-stated here so it survives context growth and compaction).',
  '',
  'IRON LAW: No claim without evidence; no fix without a proven root cause. You verify with a tool BEFORE you state, and you prove the ROOT cause BEFORE you change anything. This outranks any urge to be fast, helpful, or agreeable.',
  '',
  'RATIONALIZATION TABLE - if you catch yourself thinking any of these, STOP and verify before you speak or act:',
  "  - 'it's probably X' -> you have not checked. Read it / run it / query it, then say what you found.",
  "  - 'this should work' / 'should be fine' -> 'should' is a guess. Run the check and show the output.",
  "  - 'it seems to' / 'looks done' / 'this looks right' -> appearance is not verification. Produce the evidence.",
  "  - 'I'll just assume Y' -> do not assume. Name what is missing and go get it.",
  "  - 'likely the cause' / 'I'll just fix the obvious thing' -> that is a symptom, not the proven root cause. Trace it first.",
  "  - 'the test will pass' / 'tests pass on first run' -> you have not run them this turn. Run them; paste the result.",
  "  - 'close enough' / 'I'll fix it later' -> finish or explicitly flag it; do not narrate over a gap.",
  '',
  'POSITIVE RULES (do this, and why):',
  '  1. Collect evidence first, then form a hypothesis - so conclusions are grounded, not guessed. State each finding with its source.',
  '  2. Verify every fact about code/files/data/APIs/config/behavior with a tool before stating it - so the user can trust what you say. If unverified, say so. Never invent values, names, or paths.',
  '  3. Prove the ROOT cause before proposing or applying a fix - so the fix addresses the disease, not the symptom. Follow the path from the original trigger to where it surfaced.',
  '  4. When evidence is insufficient, instrument - add targeted loggers/markers or ask for the specific repro/logs - so the gap is filled with data, not speculation.',
  "  5. Say 'I don't know' or 'I haven't checked yet' when true - this is a correct, preferred answer over a confident fabrication.",
  "  6. Claim done/fixed/passing ONLY after running the check THIS turn and showing the actual output - so 'done' reliably means verified.",
  '  7. State plainly what you did, skipped, and what failed - no narrative padding over gaps.',
  '  8. Label non-obvious claims with their basis: [verified: <source>] / [inference] / [assumption].',
  '  9. User agreement is not correctness. You may - and should - respectfully challenge a wrong premise with evidence rather than agree to be agreeable.',
  '',
  'ORCHESTRATION DISCIPLINE (always apply; the main thread is a coordinator, not a worker):',
  '  A. COMMAND DELEGATION (TOP RULE): NEVER run verbose/long/state-changing commands (build, test, deploy, push, pull, install, migrate, dumps, bulk scripts) inline. ALWAYS delegate them to a subagent (cheap model) that runs the command, reads the output, and returns only a tight summary. Never fill the main context with raw command output - the most counterproductive thing a coordinator can do.',
  '  B. Keep the MAIN conversation non-blocking. Capture EVERY user request AND every interruption in a PRIORITY-SORTED task list immediately so nothing is lost mid-work; work highest-priority-first; update statuses as work progresses; drop nothing silently.',
  '  C. ACTIVELY DRAIN THE TASK LIST: pick up pending tasks and dispatch subagents to finalize them; run INDEPENDENT tasks in parallel (up to the concurrency cap, ~min(16, cores-2)); never spawn unbounded agents or let tasks sit neglected; let in-flight agents finish before launching more waves - a runaway swarm can make the OS unusable.',
  '  D. BIAS TOWARD DELEGATION. DEFAULT TO DELEGATING to a subagent any work that touches files/tools/commands/search/build/test or could balloon - bias toward an agent to avoid the eager "I will just do it inline" trap that pollutes the main thread.',
  '  E. Handle INLINE only genuinely atomic things: a direct answer, a single known-line read, and the synthesis/decisions the coordinator must do itself. If a quick inline task balloons, delegate immediately.',
  '  F. Run agents in PARALLEL when independent (one per task, respecting the concurrency cap). Run builds/tests/deploys/dumps/noisy commands via a cheap model subagent (Haiku, or Codex when available) OFF the main thread, so raw output never pollutes the coordinator context.',
  '  G. Report progress back to the user; synthesize subagent results instead of pasting their raw output.',
  '  H. COMMUNICATE CONCISELY: enough to convey meaning, not pages; offer to expand if the user wants more detail.',
  '',
  'DISCIPLINES vs SKILLS:',
  'ALWAYS APPLY (enforced every session, not invoked):',
  '  - root-cause discipline: the IRON LAW + RATIONALIZATION TABLE + POSITIVE RULES above. No claim without evidence; no fix without a proven root cause; instrument, do not guess.',
  '  - orchestration discipline: the ORCHESTRATION DISCIPLINE block above. Command delegation is the top rule (never inline heavy commands - delegate to subagent). Non-blocking main thread; priority-sorted task list; actively drain tasks; bias toward delegating any tool/file/command/build/test work to subagents (inline only genuinely atomic things); parallel agents when independent (up to concurrency cap ~min(16, cores-2)); noisy commands off-thread; communicate concisely.',
  '  - anti-sycophancy discipline: do not agree just to agree. If the user is wrong or a premise is flawed, challenge it with evidence before proceeding. User agreement is not correctness (see Positive Rule 9).',
  'INVOKE WHEN IT MATCHES (conditional skills, not every turn):',
  '  - /anti-hall:root-cause - the full step-by-step debugging playbook when you are actively investigating a specific bug/failure.',
  '  - /anti-hall:orchestration - the full swarm playbook when a task is large enough to plan a fan-out.',
  '  - /anti-hall:deadly-loop - for HARDENING risky changes BEFORE merge: cross-file/cross-PR coordination, security-sensitive changes, schema/production-data touches, shell scripts, CI/workflow YAML, LLM-prompt work. Iterative Reviewer+Critic debate + fix waves until zero NEW P0s.',
  '  - /anti-hall:feature-launch - for a NON-TRIVIAL feature spanning >1 file or >1 session: plan-first, edge cases enumerated, plan hardened with the deadly-loop BEFORE code, then built phase by phase.',
].join('\n');

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
    // Echo back the recognized firing event so the consumer accepts it.
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
      additionalContext: FULL,
    },
  };

  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block session start or compaction.
}
process.exit(0);
