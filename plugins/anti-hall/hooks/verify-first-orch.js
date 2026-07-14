#!/usr/bin/env node
// anti-hall :: ORCHESTRATION DISCIPLINE ruleset
//             (SessionStart [startup/resume/clear/compact])
//
// The companion to verify-first-full.js (the verify-first FOUNDATION). This hook
// carries the orchestration doctrine — rules A-N and, for a DevSwarm Primary only,
// rule W (the child-workspace tier). Together the two SessionStart hooks deliver
// the full protocol the single verify-first-full.js used to emit.
//
// WHY A SECOND HOOK (the ~10,000-char injection cap):
//   Claude Code caps a hook's additionalContext at ~10,000 chars and SPILLS the
//   overflow to a file (only ~2k reaches the model inline). The combined
//   foundation + orchestration payload was ~15.3k, so the orchestration rules
//   never landed inline. The cap is PER HOOK COMMAND — so the doctrine is split
//   across two SessionStart hooks, each well under the cap (this hook ~7.7k /
//   ~8.1k with rule W; see docs/KB.md). ZERO content was deleted by the split.
//
// COMPACTION SURVIVAL: registered ONLY on SessionStart (no matcher), which
// re-fires with source="compact" after compaction — same mechanism as
// verify-first-full.js. Echoes back the parsed hookEventName (F-20).
//
// Contract:
//   stdin  : JSON { hook_event_name, source?, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext }
//   exit 0 : always (never blocks). Fail-open on any error.

'use strict';

const fs = require('fs');

// Standalone framing so this injection reads coherently on its own (it is a peer
// SessionStart injection, delivered inline alongside the verify-first foundation).
const ORCH_HEADER =
  'ORCHESTRATION DISCIPLINE (always apply; the main thread is a coordinator, not a worker):';

// DevSwarm PRIMARY ONLY (rule W). Rules A/C/D/F name subagent / Explore / Workflow
// as the ONLY fan-out targets and put dispatch pressure on the coordinator ("IDLE
// NEGLECT"). Inside DevSwarm that doctrine is actively WRONG for a Primary: the top
// fan-out tier is a CHILD WORKSPACE, and nothing else in the session (DevSwarm's
// own stock prompt included) ever says so proactively — so a Primary drifts into
// doing feature-scale work through subagents instead of spinning workspaces. The
// choice heuristic itself is not new (docs/KB-devswarm-hivecontrol.md §8.1-8.2);
// this injects it where the pressure is applied. Emitted ONLY when the session is a
// DevSwarm Primary (DEVSWARM_REPO_ID set AND DEVSWARM_SOURCE_BRANCH empty — see
// lib/devswarm-detect.js + lib/devswarm-role.js). Outside DevSwarm, and in a CHILD
// workspace, the injected text is byte-for-byte the baseline (rules A-N, no W).
//
// W now lives in its OWN <10k hook, so the per-hook cap no longer forces the tiny
// 76-char form the combined payload required. It is right-sized to state the
// operative facts: the WORKSPACE is the top tier, the spawn command, the choice
// rule, and the failure mode — and nothing more (the full choice rule is also
// carried EVERY turn by verify-first.js + task-tracker.js, which pay no cap).
const ORCH_DEVSWARM_PRIMARY =
  '  W. DEVSWARM PRIMARY — WORKSPACE IS THE TOP FAN-OUT TIER: a feature/fix/deploy (workspace-scale: owns a branch, spans many files/commits, runs to done) = a CHILD WORKSPACE, NOT a subagent. Spawn it: `node scripts/devswarm.js spawn <branch> -p "<brief>"`. Bounded work inside your OWN branch -> subagent (rules A-N). Handing workspace-scale work to a subagent leaves it off the parent task list and unsupervised.';

// Rules A-N in ALPHABETICAL order. (Rule L used to be hoisted to just after A to
// survive the old ~10k truncation cap on the single combined payload; with the
// split that pressure is gone, so L is restored to its natural alphabetical slot
// between K and M.)
const ORCH_LINES = [
  '  A. COMMAND DELEGATION (TOP RULE): NEVER run verbose/long/state-changing commands (build, test, deploy, push, pull, install, migrate, dumps, bulk scripts) OR broad reads/Grep/Glob/code-nav searches (git grep, find, rg, ag, multi-file sweeps) inline. ALWAYS delegate to a subagent that returns a tight summary. Raw output bloats the orchestrator and INDUCES HALLUCINATION - the failure this plugin prevents.',
  '  B. Keep the MAIN thread non-blocking. Capture EVERY request AND interruption in a PRIORITY-SORTED task list immediately; work highest-first; update statuses; drop nothing silently. As each task COMPLETES, DELEGATE the write to a cheap model (Haiku) rather than composing it inline: hand it the cause/fix/verification facts and have it append the entry to .anti-hall/history/<today>/<session-id>.md (one entry per task: Cause / Fix / Verified) so the fix history persists for the knowledge layer without spending the coordinator\'s own tokens on a mechanical write.',
  '  C. ACTIVELY DRAIN THE LIST - DISPATCH PROACTIVELY, do NOT wait to be told: the MOMENT a task is pending, unblocked (no open blockedBy), and unassigned, fire a background agent for it WITHOUT being asked - never let it sit idle waiting for the user to say "spin agents". Run INDEPENDENT tasks in PARALLEL (one agent each, cap ~min(16, cores-2)); never spawn unbounded agents; let in-flight agents finish before the next wave - a runaway swarm can wedge the OS. Ending a turn with non-blocked, unassigned tasks and NO agents running is IDLE NEGLECT - the failure mode to avoid; only stop idle if a task genuinely needs the user, and then say which and why.',
  '  D. BIAS TOWARD DELEGATION: default to a subagent for any work touching files/tools/commands/search/build/test or that could balloon - avoid the "just do it inline" trap.',
  '  E. Handle INLINE only genuinely atomic things: a direct answer, one known-path file read, and the synthesis/decisions the coordinator must do. If an inline task balloons, delegate.',
  '  E2. GRAPHIFY-FIRST: when a graph exists (graphify-out/), refresh the code graph (graphify update .; use /graphify . --update --obsidian for docs/Obsidian semantic refreshes) then query it (/graphify query "...") BEFORE any Grep/Glob/raw code search and BEFORE ship-it analysis.',
  '  F. Run independent agents in PARALLEL (one per task, within the cap). Run builds/tests/deploys/dumps/noisy commands via a cheap subagent (Haiku, or Codex when available) OFF the main thread. DEFAULT delegated heavy/long/parallel work to the BACKGROUND yourself (pass run_in_background so the user never has to background it manually); the main thread stays free during execution, and you act on each completion notification - then VERIFY it (rule L). Never fire-and-forget: a backgrounded task must still be drained and checked. Do NOT background genuinely-atomic inline work (rule E) - match the mechanism to the weight.',
  '  G. SYNTHESIZE, NEVER RELAY (the #1 cause of message-context bloat): the coordinator reports progress in its OWN words and NEVER pastes a subagent\'s raw return into the user thread - relaying a worker\'s full output verbatim is what bloats the message context. Subagents must return TIGHT summaries under an explicit OUTPUT BUDGET: findings only, no transcript, no re-pasted file bodies. For a SUBSTANTIAL result (a review/audit/research dump, many claims), require a compact structured return - {claim, evidence:"file:line", verdict, blockers/uncertainty, next} - which MEASURED ~5x smaller than verbose prose with zero decision-relevant loss (judged on a claim/evidence/uncertainty/blockers/next rubric); for a SMALL result a single prose line is better (a schema is only ~1.4x denser there, and JSON overhead can make tiny outputs LARGER - do not impose it). To ENFORCE the format rather than just request it, pass a schema to the Agent/Task tool so the structured return is validated. The biggest levers are the output budget + no-raw-relay; the schema is the multiplier on large returns.',
  '  H. COMMUNICATE CONCISELY: enough to convey meaning, not pages; offer to expand if wanted.',
  '  I. WATCH/BABYSIT spawned agents: poll TaskOutput on an interval (ScheduleWakeup or loop); if an agent misses its heartbeat (~/.anti-hall/agents/<id>.json) for ~20 min, TaskStop and re-dispatch with tighter scope. Bounded time horizon in every brief - never wait forever.',
  '  J. UPDATE THE PHASE STATUSLINE as phases progress: call statusline/phase.js (set/advance/step/agents/clear) from the coordinator. Never from subagents - they report back; the coordinator writes phase state.',
  '  K. PRESENT FOR SCANNABILITY (do not overdo it): organize output with GitHub-flavored markdown - tables for comparisons/status, **bold** verdicts, *italic* caveats, `code` for flags/paths/commands, fenced blocks for commands/output, at most a leading status glyph (emoji = signal, not decoration). Styling organizes, never pads - rule H still rules. Avoid renderer-dropped syntax: strikethrough, [label](url) link labels (paste the bare URL), nested blockquotes, task-list checkboxes; underline and per-word color do not exist.',
  '  L. VERIFY DELEGATED WORK (Rule 6 applies to a subagent\'s report too): a subagent\'s "done / fixed / tests pass / N passing" is an UNVERIFIED CLAIM, never a fact. Before marking any delegated task complete, RE-RUN the authoritative check yourself (or dispatch a SEPARATE verifier) and read the REAL result - workers run in their own context and can be optimistic, wrong, or measuring stale/partial state. When multiple workers report, reconcile against GROUND TRUTH, not against each other. A self-reported completion is a hypothesis to confirm, not a result to accept.',
  '  M. PREFER SHALLOW+WIDE; LIFT DEEP NESTING INTO A WORKFLOW. Delegation rules are for the ORCHESTRATOR; a spawned subagent is a WORKER - it does the work itself and does NOT re-delegate unless its task says to (deep general-purpose->general-purpose chains cost ~7x tokens by depth 5, drift intent each hop, add no quality). Route read-only research to Explore (it has no Agent tool, cannot recurse). When a task is breadth-first/parallelizable and would otherwise need 3+ subagents or a nested chain, use a deterministic WORKFLOW (one flat script with parallel/pipeline) instead of ad-hoc nesting - it is repeatable, keeps intermediate output off the main context, and runs in the background. Trigger it deliberately on that SHAPE, never as a blanket rule for routine work.',
  '  N. DISTRIBUTE MODELS - NEVER ALL-OPUS (esp. in a Workflow). An OMITTED model inherits the orchestrator (a flagship), so a fan-out of omitted/Opus seats silently becomes an all-flagship swarm that torches the usage limit. Set model/effort EXPLICITLY per seat by task shape: implementation/mechanical -> sonnet (or haiku for trivial leaf/nav); correctness/verify/subtle-bug review -> CODEX (codex:codex-rescue when available - its strength); planning/architecture/design/ambiguous-reasoning + design-level review -> opus. The model-routing-guard hook does NOT police models INSIDE a workflow review fan-out (it exempts review tasks and workflow-spawn advisories are not surfaced), so distribution is YOUR authoring responsibility when you write the workflow script. ALWAYS use Codex for an independent SECOND OPINION on substantial code changes (correctness lens) - it is the deadly-loop/ship-it Critic seat and should be pulled for everyday code review too; keep the architecture/design lens on Opus. CODEX HAS ITS OWN LIMITS: if Codex is unavailable or rate-limited, fall back to a CHEAP Claude (Sonnet) for the review - NEVER retry-loop an unavailable Codex, and do not strand the main agent waiting on it.',
];

// Baseline (non-DevSwarm and DevSwarm CHILD): header + rules A-N, alphabetical.
const BASELINE = [ORCH_HEADER, ...ORCH_LINES].join('\n');
// DevSwarm PRIMARY: baseline plus rule W spliced in at the TOP of the block
// (before rule A), so the tier-choice rule leads the primacy content.
const DEVSWARM_PRIMARY = [ORCH_HEADER, ORCH_DEVSWARM_PRIMARY, ...ORCH_LINES].join('\n');

// isDevswarmPrimary(env) — DevSwarm active AND this session is the root/Primary
// (not a child workspace). Fail-open to FALSE => the baseline text, so any helper
// error can only ever emit the pre-existing doctrine, never a wrong one.
function isDevswarmPrimary(env) {
  try {
    const { isDevswarmActive } = require('./lib/devswarm-detect.js');
    const { isChildWorkspace } = require('./lib/devswarm-role.js');
    return isDevswarmActive(env) && !isChildWorkspace(env);
  } catch (_) {
    return false;
  }
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }

  // Parse the firing event (F-20: no brittle substring match). Registered ONLY on
  // SessionStart, so SessionStart is the expected value and the safe default.
  let event = 'SessionStart';
  try {
    const payload = JSON.parse(raw);
    const name = payload && typeof payload.hook_event_name === 'string'
      ? payload.hook_event_name
      : '';
    if (name === 'SessionStart') {
      event = 'SessionStart';
    }
  } catch (_) {
    event = 'SessionStart';
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: isDevswarmPrimary(process.env) ? DEVSWARM_PRIMARY : BASELINE,
    },
  };

  // SYNCHRONOUS write to fd 1 (same rationale as verify-first-full.js): avoids the
  // macOS node 18/20 async-pipe-flush truncation when process.exit(0) races a
  // buffered stdout write. fs.writeSync blocks until every byte is handed to the pipe.
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block session start or compaction.
}
process.exit(0);
