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
// SCOPE: this template is a SINGLE-PASS SCAFFOLD that shows the L-tier fan-out SHAPE —
//   the Step-4 parallel build over disjoint phases and ONE Step-5 per-phase audit pass
//   (Reviewer + Codex Critic). It does NOT itself converge to zero P0s: the full
//   fix-wave -> re-converge LOOP (soft-10 / hard-15 caps, the D1.5 fresh-evidence gate)
//   is run by invoking the `deadly-loop` skill itself — this script only demonstrates the
//   barrier/fan-out structure each round uses. It also does NOT replace plan mode
//   (Steps 1-3): author and harden PLAN.md interactively FIRST, then run /ship-it to
//   execute it. S/M tiers do not use this — they build inline.
//
// COMMITS: this script NEVER commits. Agents RETURN results; the COORDINATOR (the main
//   thread) commits passing phases serially and drives the fix-wave loop. No git writes
//   happen inside the workflow.
//
// DETERMINISM: no Date.now() / Math.random() / argless new Date(). All run-varying
//   inputs (the plan, phase definitions, seeds) come from `args`.
//
// INPUT (`args`): an object describing the approved plan, e.g.
//   {
//     fableAvailable: true, // true => Reviewer tries Fable before Sonnet 5
//     parallelGroups: [
//       // each group is a list of DISJOINT phases that run as one parallel barrier.
//       // `files` is the EXACT list of paths the phase touches (used to PROVE the
//       // group is conflict-free before any parallel fan-out — see validateGroup).
//       [ { label: "phase1", prompt: "<full task + file excerpts>", files: ["a.js"] },
//         { label: "phase2", prompt: "...", files: ["b.js"] } ],
//       // later groups depend on earlier ones (run sequentially)
//       [ { label: "phase3", prompt: "...", files: ["c.js"] } ],
//     ],
//   }
//   If `args` is undefined the workflow exits with a usage note (no guessing).

// args may arrive as an OBJECT or a JSON STRING depending on harness build
// (live-verified 2026-06-10 — see tests/fixtures/step0-probe-record.md P8).
const plan = (typeof args === 'object' && args) ? args
  : (typeof args === 'string'
    ? (() => { try { const v = JSON.parse(args); return (v && typeof v === 'object') ? v : null; } catch (_) { return null; } })()
    : null);

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

// deadly-loop per-phase gate: Reviewer (Sonnet 5, or Fable when args.fableAvailable
// is true) + Auditor (Opus) + Critic (Codex) in a BARRIER parallel. The roster,
// availability fallback matrix, and canonical Codex spawn
// form live in deadly-loop/references/MODEL-POLICY.md. Model tokens are tier tokens
// (fable/opus) resolved to the latest of that tier at call time — never versioned ids.
function reviewerBrief(phase) {
  return [
    'You are the deadly-loop REVIEWER (Sonnet 5, effort xhigh — never max in loops) for phase ' + phase.label + '.',
    'Audit this phase diff for: correctness vs the plan, edge cases actually handled,',
    'regressions, security on security-relevant phases, full blast radius.',
    'Phase files: ' + ((phase.files || []).join(', ') || '(unspecified)') + '.',
    'Count only NEW P0 blockers (not rediscovered ones). Return the verdict schema.',
  ].join('\n');
}
function auditorBrief(phase) {
  return [
    'You are the deadly-loop AUDITOR (latest Opus, max thinking) for phase ' + phase.label + '.',
    'DIVERGENT lens — regression & coupling hunter; do NOT duplicate the Reviewer. Trace',
    'OUTWARD: regressions in unchanged dependent code, wrong cross-module/cross-PR coupling,',
    'fixes that undid earlier fixes, merge-order cross-reference breaks.',
    'Phase files: ' + ((phase.files || []).join(', ') || '(unspecified)') + '.',
    'Count only NEW P0 blockers. Return the verdict schema.',
  ].join('\n');
}
function criticBrief(phase) {
  return [
    'You are the deadly-loop CRITIC (Codex, max reasoning) for phase ' + phase.label + '.',
    'Adversarial lens — DIFFERENT mental model; find blindspots the Reviewer and Auditor',
    'would miss; try to BREAK the change. Phase files: ' + ((phase.files || []).join(', ') || '(unspecified)') + '.',
    'Count only NEW P0 blockers. Return the verdict schema.',
  ].join('\n');
}

// REVIEWER SEAT with AVAILABILITY FALLBACK (MODEL-POLICY.md "Availability fallback
// matrix"). Default behavior is unchanged: Sonnet 5 -> Opus. When the SessionStart
// fable-availability hook tells the coordinator to pass args.fableAvailable === true,
// this seat tries Fable first, then falls back through the normal chain.
async function reviewerAgent(p) {
  // Fable routing is policy-disabled (owner call, 2026-07-02): negative community feedback
  // reports it as over-restrictive/refusal-prone, and a refusal would pass StructuredOutput
  // validation as a "successful" verdict rather than triggering fallback. Sonnet 5 is the
  // primary Reviewer until Fable's track record improves. The availability flag/hook stays
  // wired for visibility; only the routing decision is disabled here.
  const tryFable = false && typeof args === 'object' && args !== null && args.fableAvailable === true;
  if (tryFable) {
    const fable = await agent(reviewerBrief(p), {
      schema: VERDICT_SCHEMA, run_in_background: true,
      label: p.label + ':reviewer', model: 'fable', effort: 'xhigh',
    });
    if (fable) return fable;
    log('ship-it: Fable Reviewer unavailable for "' + p.label + '" — falling back to Sonnet 5 Reviewer (MODEL-POLICY matrix).');
  }

  const sonnet = await agent(reviewerBrief(p), {
    schema: VERDICT_SCHEMA, run_in_background: true,
    label: p.label + ':reviewer' + (tryFable ? '(sonnet-fallback)' : ''),
    model: 'sonnet', effort: 'xhigh',
  });
  if (sonnet) return sonnet;

  log('ship-it: Reviewer unavailable for "' + p.label + '" — falling back to Opus Reviewer (MODEL-POLICY matrix).');
  return agent(reviewerBrief(p), {
    schema: VERDICT_SCHEMA, run_in_background: true,
    label: p.label + ':reviewer(opus-fallback)', model: 'opus',
  });
}

async function criticAgent(p) {
  const r = await agent(criticBrief(p), {
    schema: VERDICT_SCHEMA, run_in_background: true,
    label: p.label + ':critic', agentType: 'codex:codex-rescue',
  });
  if (r) return r; // Codex critic succeeded
  log('ship-it: Critic unavailable for "' + p.label + '" — falling back to Opus Critic (MODEL-POLICY matrix).');
  return agent(criticBrief(p), {
    schema: VERDICT_SCHEMA, run_in_background: true,
    label: p.label + ':critic(opus-fallback)', model: 'opus',
  });
}

// FAIL-CLOSED safety check: a parallel group must be conflict-free before fan-out.
// Phases run concurrently and commit serially, so within a group they must have
// UNIQUE labels, DISJOINT files (no two phases touch the same path), and NO declared
// intra-group dependency. Any violation throws — we never fan out an unsafe group.
function validateGroup(group, g) {
  const where = 'parallel group ' + (g + 1);
  if (!Array.isArray(group) || group.length === 0) {
    throw new Error('ship-it: ' + where + ' is empty or not an array.');
  }
  const seenLabels = new Set();
  const seenFiles = new Map(); // path -> first label that claimed it
  for (const p of group) {
    if (!p || typeof p.label !== 'string' || !p.label) {
      throw new Error('ship-it: ' + where + ' has a phase with no label.');
    }
    if (seenLabels.has(p.label)) {
      throw new Error('ship-it: ' + where + ' has duplicate label "' + p.label + '".');
    }
    seenLabels.add(p.label);
    if (!Array.isArray(p.files) || p.files.length === 0) {
      throw new Error('ship-it: phase "' + p.label + '" in ' + where + ' must declare a non-empty files[].');
    }
    // No intra-group dependency allowed (group members run concurrently).
    if (p.depends_on != null && (!Array.isArray(p.depends_on) || p.depends_on.length > 0)) {
      throw new Error('ship-it: phase "' + p.label + '" declares depends_on inside a parallel group; ' +
        'dependent phases must go in a LATER group.');
    }
    for (const f of p.files) {
      if (seenFiles.has(f)) {
        throw new Error('ship-it: file "' + f + '" is touched by both "' + seenFiles.get(f) +
          '" and "' + p.label + '" in ' + where + ' — parallel phases must have DISJOINT files.');
      }
      seenFiles.set(f, p.label);
    }
  }
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
    validateGroup(group, g); // FAIL CLOSED before any fan-out (disjoint files, unique labels, no intra-dep)
    phase('build: parallel group ' + (g + 1) + ' (' + group.length + ' disjoint phase(s))');

    // A group of 1 is a plain inline build (no parallel wrapper, no swarm overhead).
    let built;
    // Implementation seats run on Sonnet EXPLICITLY (not the inherited flagship):
    //   (1) per the everyday-routing policy, code implementation from a ready plan is a
    //       Sonnet-shaped task — convention-aware, far cheaper than Opus at scale;
    //   (2) an OMITTED model inherits the orchestrator (a flagship) AND, under strict
    //       model-routing (default since 0.35.0), a mechanical omitted-model spawn is
    //       BLOCKED — so an explicit model is required to avoid self-blocking the build.
    // Override per phase by setting phase.model in the plan if a seat needs Opus/Codex.
    if (group.length === 1) {
      built = [await agent(buildBrief(group[0]), {
        schema: RESULT_SCHEMA, run_in_background: true, label: group[0].label,
        model: group[0].model || 'sonnet',
      })];
    } else {
      // BARRIER fan-out: all disjoint phases finish before we proceed.
      built = await parallel(group.map((p) => () => agent(buildBrief(p), {
        schema: RESULT_SCHEMA, run_in_background: true, label: p.label,
        model: p.model || 'sonnet',
      })));
    }
    group.forEach((p, i) => { results[p.label] = { build: built[i] }; });

    // Step 5: per-phase audit pass, ONE phase at a time (do NOT nest concurrent
    // deadly-loops past depth-1). Each gate is its own Reviewer+Auditor+Critic TRIO BARRIER.
    // Models are set EXPLICITLY per seat (an omitted model inherits the orchestrator's model;
    // on a flagship orchestrator that would silently produce an all-flagship swarm). Tier
    // tokens only — resolved to the latest of that tier at call time, never versioned ids.
    // This is a SINGLE pass that shows the fan-out shape; if it returns newP0 > 0 the
    // COORDINATOR runs the real deadly-loop skill fix-wave -> re-converge loop (not this script).
    for (const p of group) {
      phase('deadly-loop gate: ' + p.label);
      const audit = await parallel([
        () => reviewerAgent(p), // Sonnet 5 with documented Opus fallback (see reviewerAgent)
        () => agent(auditorBrief(p),  { schema: VERDICT_SCHEMA, run_in_background: true, label: p.label + ':auditor', model: 'opus', effort: 'high' }),
        () => criticAgent(p), // Codex with documented Opus fallback (see criticAgent)
      ]);
      results[p.label].review = { reviewer: audit[0], auditor: audit[1], critic: audit[2] };
    }
  }

  // This script does NOT commit and does NOT loop. It returns the single-pass results;
  // the COORDINATOR (main thread) reads `results`, commits passing phases serially
  // (manual git on the main thread — never the script), and runs the deadly-loop skill's
  // fix-wave -> re-converge loop on any phase with newP0 > 0 until zero NEW P0s.
  return { phases: results };
}

return main();
