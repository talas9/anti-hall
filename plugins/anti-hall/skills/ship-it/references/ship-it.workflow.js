// ship-it.workflow.js — COPYABLE TEMPLATE for a saved /ship-it Dynamic Workflow.
//
// WHY THIS IS A TEMPLATE, NOT A BUNDLED COMMAND:
//   Claude Code plugins CANNOT ship a workflow command. Per the official docs
//   (https://code.claude.com/docs/en/workflows), a workflow becomes a /command
//   ONLY by saving a *live run's* script via `/workflows` → select run → press `s`,
//   which writes it to `.claude/workflows/` (project) or `~/.claude/workflows/`
//   (user). There is no `workflows` field in plugin.json and no plugin save path.
//
// HOW TO INSTALL THIS AS /ship-it:
//   Save this file to ONE of:
//     - <repo>/.claude/workflows/ship-it.js     (shared with everyone who clones)
//     - ~/.claude/workflows/ship-it.js          (personal, all projects)
//   Then invoke it as `/ship-it` (project copy wins if both exist). Pass input
//   via the `args` global (see below). Requires Dynamic Workflows enabled
//   (Claude Code v2.1.154+, toggle in /config on Pro).
//
// SCOPE: this template automates ONLY the L-tier mechanical fan-out — the Step-4
//   parallel build over disjoint phases and the Step-5 per-phase deadly-loop
//   (Reviewer + Codex Critic). It does NOT replace plan mode (Steps 1-3): author
//   and harden PLAN.md interactively FIRST, then run /ship-it to execute it. S/M
//   tiers do not use this — they build inline.
//
// DETERMINISM: no Date.now() / Math.random() / argless new Date(). All run-varying
//   inputs (the plan, phase definitions, seeds) come from `args`.
//
// INPUT (`args`): an object describing the approved plan, e.g.
//   {
//     parallelGroups: [
//       // each group is a list of DISJOINT phases that run as one parallel barrier
//       [ { label: "phase1", prompt: "<full task + file excerpts>", diff: "<paths>" },
//         { label: "phase2", prompt: "...", diff: "..." } ],
//       // later groups depend on earlier ones (run sequentially)
//       [ { label: "phase3", prompt: "...", diff: "..." } ],
//     ],
//   }
//   If `args` is undefined the workflow exits with a usage note (no guessing).

const plan = (typeof args === 'object' && args) ? args : null;

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    status: { type: 'string', enum: ['pass', 'needs_rework', 'blocked'] },
    evidence: { type: 'string' }, // fresh acceptance-command output / file:line cited
    blockers: { type: 'string' },
  },
  required: ['label', 'status'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['converged', 'fix_needed'] },
    newP0: { type: 'number' }, // count of NEW P0 blockers this round (must reach 0)
    summary: { type: 'string' },
  },
  required: ['verdict', 'newP0'],
};

// Build-agent brief: inject FULL context, never "read the plan". The agent runs the
// deadly-loop A3 branch/SHA preamble, edits ONLY its disjoint files, then proves the
// phase with FRESH acceptance output (Iron Law) + the D1.5 vacuous-test cycle.
function buildBrief(phase) {
  return [
    'You are a ship-it build agent for phase: ' + phase.label + '.',
    'A3 PREAMBLE: verify you are on the right branch + HEAD before editing; cite file:line you change.',
    'TASK (self-contained — do not read PLAN.md; everything you need is here):',
    phase.prompt,
    'IRON LAW: do NOT claim done without fresh acceptance-command output in your result.',
    'D1.5 VACUOUS-TEST GUARD: revert fix -> run -> confirm RED -> restore -> run -> confirm GREEN.',
    'Return the result schema: {label, status, evidence, blockers}.',
  ].join('\n\n');
}

// deadly-loop per-phase gate: Reviewer (Opus) + Critic (Codex) in a BARRIER parallel.
function reviewerBrief(phase) {
  return [
    'You are the deadly-loop REVIEWER (latest Opus, max thinking) for phase ' + phase.label + '.',
    'Audit this phase diff for: correctness vs the plan, edge cases actually handled,',
    'regressions, security on security-relevant phases, full blast radius.',
    'Phase diff paths: ' + (phase.diff || '(unspecified)') + '.',
    'Count only NEW P0 blockers (not rediscovered ones). Return the verdict schema.',
  ].join('\n');
}
function criticBrief(phase) {
  return [
    'You are the deadly-loop CRITIC (Codex, max reasoning) for phase ' + phase.label + '.',
    'Same lenses as the Reviewer but a DIFFERENT mental model — find blindspots the',
    'Reviewer would miss. Phase diff paths: ' + (phase.diff || '(unspecified)') + '.',
    'Count only NEW P0 blockers. Return the verdict schema.',
  ].join('\n');
}

async function main() {
  if (!plan || !Array.isArray(plan.parallelGroups) || plan.parallelGroups.length === 0) {
    return {
      error: 'ship-it workflow: no plan in `args`. Author + harden PLAN.md in plan mode first, ' +
        'then invoke with args = { parallelGroups: [[{label,prompt,diff}, ...], ...] }.',
    };
  }

  const results = {}; // intermediate state — NOT relayed mid-run (coordinator synthesizes)

  for (let g = 0; g < plan.parallelGroups.length; g++) {
    const group = plan.parallelGroups[g];
    phase('build: parallel group ' + (g + 1) + ' (' + group.length + ' disjoint phase(s))');

    // A group of 1 is a plain inline build (no parallel wrapper, no swarm overhead).
    let built;
    if (group.length === 1) {
      built = [await agent(buildBrief(group[0]), {
        schema: RESULT_SCHEMA, run_in_background: true, label: group[0].label,
      })];
    } else {
      // BARRIER fan-out: all disjoint phases finish before we proceed.
      built = await parallel(group.map((p) => () => agent(buildBrief(p), {
        schema: RESULT_SCHEMA, run_in_background: true, label: p.label,
      })));
    }
    group.forEach((p, i) => { results[p.label] = { build: built[i] }; });

    // Step 5: per-phase deadly-loop gate, ONE phase at a time (do NOT nest concurrent
    // deadly-loops past depth-1). Each gate is its own Reviewer+Critic BARRIER.
    for (const p of group) {
      phase('deadly-loop gate: ' + p.label);
      const audit = await parallel([
        () => agent(reviewerBrief(p), { schema: VERDICT_SCHEMA, run_in_background: true, label: p.label + ':reviewer' }),
        () => agent(criticBrief(p),   { schema: VERDICT_SCHEMA, run_in_background: true, label: p.label + ':critic', agentType: 'codex:codex-rescue' }),
      ]);
      results[p.label].review = { reviewer: audit[0], critic: audit[1] };
    }
  }

  // Coordinator (the main thread) reads `results`, commits passing phases serially,
  // and loops fix-waves on any phase with newP0 > 0 until zero NEW P0s. Only the
  // synthesized verdict is returned here.
  return { phases: results };
}

return main();
