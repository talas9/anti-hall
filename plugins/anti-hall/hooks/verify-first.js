#!/usr/bin/env node
// anti-hall :: verify-first SHORT nudge (UserPromptSubmit)
//
// The FULL protocol lives in verify-first-full.js (SessionStart primacy slot +
// SessionStart source="compact" re-injection via the no-matcher SessionStart registration). This per-turn hook injects only a
// SHORT, 1-line reminder so the per-turn slot stays high-salience instead of
// being habituated and tuned out.
//
// Why short + VARYING (KB-claude-codex.md):
//   - §6.2 recency bias + Design-implications "GETS IGNORED: Rules buried in the
//     middle / repeated identical reminders get habituated." Adherence is a
//     function of placement and NOVELTY, not repetition. A byte-identical wall of
//     text every turn is exactly what the model learns to skip.
//   - We rotate among 12 one-liners chosen DETERMINISTICALLY from a crypto hash of
//     the ENTIRE raw stdin envelope (not just payload.prompt — see below), so the
//     nudge varies turn to turn. It is reproducible for a given full envelope; it
//     varies by the whole UserPromptSubmit payload (which includes session_id,
//     transcript_path, cwd alongside the prompt), so the SAME prompt text in a
//     different session/cwd intentionally yields a different facet — extra novelty
//     that fights habituation. No randomness, no external deps, no shelling out to
//     cksum (OS-agnostic).
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext } added to the turn
//   exit 0 : always - allow prompt, inject context
//
// stdin is read ONLY to derive a stable index from its bytes; nothing from the
// input is echoed back into the injected text (no injection surface). Fail-open
// on any error: a bug here must never wedge a turn.

'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Short nudges. Each is a different facet of the always-on disciplines (root-cause +
// orchestration + anti-sycophancy) so novelty fights habituation without diluting the
// message.
const NUDGES = [
  "Verify before you claim: evidence from a tool, or say 'I haven't checked'. No guessed facts.",
  "NO SPECULATION: an inference - a cause, an attribution, a metric reading, a tidy 'because X' story - is a CLAIM. Verify it with data before stating it. Plausible is not verified.",
  "'likely' / 'plausibly' / 'I suspect' / 'I think' / 'it must be' = a guess in disguise. Hedging doesn't make it safe. Pull the data, or say 'I don't know - here's what I'd check'.",
  "Root cause before fix. The error you see is a symptom; trace it before you change anything.",
  "'Probably' / 'should work' / 'seems to' = STOP and verify. Show the output, don't assume.",
  "Done/fixed/passing only if you ran the check THIS turn and can paste the result.",
  "User agreement is not correctness. Challenge a wrong premise with evidence, not agreement.",
  "COMMAND DELEGATION: never run build/test/deploy/push/pull/install inline in the coordinator - delegate to a cheap subagent; never fill main context with raw command output.",
  "Bias toward delegation: default to a subagent for any file/tool/command/build/test work; inline only genuinely atomic things. If it balloons, delegate.",
  "Run builds/tests/deploys via a Haiku subagent; never dump raw command output into the main thread.",
  "Capture every request and interruption in a priority-sorted task list before acting; run independent work as parallel agents (up to concurrency cap ~min(16, cores-2)); actively drain the list - no neglected tasks.",
  "Communicate concisely: enough to convey meaning, not pages; offer to expand if the user wants more detail.",
  "SCOPE & FIDELITY: solve the ACTUAL ask with the SIMPLEST sufficient solution - add no scope/platform/abstraction/dependency the user didn't request. Confirm before expanding scope.",
  "Intent over letter: don't take wording hyper-literally or inflate a small ask into a big build. Match rigor to blast radius - heavy process is for risky/large work, not a reflex.",
  "VERIFY DELEGATED WORK: a subagent's 'done / tests pass' is an UNVERIFIED CLAIM. Re-run the authoritative check yourself before marking a delegated task complete; reconcile multiple workers against ground truth, not against each other.",
  "Default delegated heavy/long/parallel work to the BACKGROUND yourself (pass run_in_background) so the main thread stays free and the user never has to background it manually; then drain each on its completion notification and verify it - never fire-and-forget.",
  "SYNTHESIZE, NEVER RELAY: never paste a subagent's raw return into the user thread - that relay is the #1 cause of message-context bloat. Subagents return TIGHT summaries under an output budget; the coordinator reports findings in its own words.",
];

function main() {
  let input = '';
  try {
    // fd 0 is stdin on every platform; '/dev/stdin' does not exist on Windows.
    input = fs.readFileSync(0);
  } catch (_) {
    input = Buffer.alloc(0);
  }

  // Deterministic index 0..NUDGES.length-1 from a SHA-1 of the raw stdin envelope
  // bytes (the whole UserPromptSubmit payload, not just .prompt). crypto is a Node
  // built-in, present on every OS. Same full envelope -> same nudge (reproducible);
  // different envelopes (including the same prompt in a different session/cwd) spread
  // across all facets.
  let idx = 0;
  try {
    const digest = crypto.createHash('sha1').update(input).digest();
    // Use the first 4 bytes as an unsigned int, mod NUDGES.length.
    const n = digest.readUInt32BE(0);
    idx = n % NUDGES.length;
  } catch (_) {
    idx = 0;
  }

  const nudge = NUDGES[idx] || NUDGES[0];

  // Official schema: `hookEventName` is NESTED in `hookSpecificOutput` (a sibling
  // of `additionalContext`), not a top-level field. KB §1.4 documents
  // `hookSpecificOutput.additionalContext` for UserPromptSubmit context injection;
  // nesting `hookEventName` here matches the harness contract.
  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'VERIFY-FIRST: ' + nudge,
    },
  };

  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never wedge the turn.
}
process.exit(0);
