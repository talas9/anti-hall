// deadly-loop.workflow.js — COPYABLE TEMPLATE for a saved deadly-swarm Dynamic Workflow.
//
// WHY THIS IS A TEMPLATE, NOT A BUNDLED COMMAND:
//   Claude Code plugins CANNOT ship a workflow command. Per the official docs
//   (https://code.claude.com/docs/en/workflows), a workflow becomes a /command
//   ONLY by saving a *live run's* script via `/workflows` -> select run -> press `s`,
//   which writes it to `.claude/workflows/` (project) or `~/.claude/workflows/`
//   (user). There is no `workflows` field in plugin.json and no plugin save path.
//   (Same install pattern as ship-it.workflow.js in this repo.)
//
// HOW TO INSTALL THIS AS /deadly-loop-round:
//   Save this file to ONE of:
//     - <repo>/.claude/workflows/deadly-loop-round.js   (shared with clones)
//     - ~/.claude/workflows/deadly-loop-round.js        (personal, all projects)
//   Then invoke it via `/deadly-loop-round`. Pass input via the `args` global.
//   Requires Dynamic Workflows enabled (Claude Code v2.1.154+, /config on Pro).
//
// SCOPE: ONE workflow run = ONE round (Phase 1 Context -> Phase 2a Investigate ->
//   optional Phase 2b Argue -> Phase 3 Converge) PLUS its in-round drift respawns.
//   It does NOT loop and does NOT run the fix wave: the COORDINATOR (the main thread)
//   reads the returned verdict, updates the DURABLE handoff doc (state lives there,
//   NOT in workflow memory), dispatches any fix wave itself, then invokes the next
//   round as a FRESH workflow run with round+1. Soft-cap-10 (AskUserQuestion) and
//   hard-15 are owned by the coordinator BETWEEN runs; the hard-15 backstop below is
//   a double-guard, not the primary cap. See Workstream E / E.1 in
//   docs/2026-06-10-v0.32.0-fable5-model-routing-plan.md.
//
// COMMITS: this script NEVER commits and never touches git. Agents RETURN findings;
//   the coordinator owns all git + fix dispatch on the main thread.
//
// MODEL INVARIANT: select models LATEST-AT-CALL-TIME — use ONLY tier tokens in agent()
//   options (model:'fable'/'opus'/'sonnet'/'haiku', agentType:'codex:codex-rescue').
//   NEVER hardcode a versioned/dated model id anywhere (script, briefs, or schemas).
//   The host resolves each tier token to today's flagship build at call time.
//
// DETERMINISM: no Date.now() / Math.random() / argless new Date(). All run-varying
//   inputs (round number, target SHA, branch, scope, prior pack, findings) come from
//   `args`. No fs / node APIs — scripts have no filesystem; the context pack is
//   RETURNED AS TEXT (packText) and embedded into seat briefs, not written to disk.
//
// INPUT (`args`): an object describing this round, e.g.
//   {
//     round: 1,                         // 1-based round counter (coordinator-owned cap)
//     multiplier: 1,                    // 1=trio, 2=double(6), 3=triple(9), 4=quadruple(12)
//     targetSHA: "<full HEAD sha>",     // seats verify they audited this exact SHA
//     branch: "<branch name>",          // seats verify they are on this branch
//     scope: "<what to audit: files / diff / whole repo>",
//     handoffPath: ".anti-hall-deadly/handoff-round-N.md", // durable state (coordinator I/O)
//     prevPackPath: "<path>",           // round>1: prior context pack file (coordinator-written)
//     findings: [ ... ],                // round>1: prior round's confirmed/contested findings
//     fixesApplied: [ ... ],            // round>1: what the coordinator's fix wave changed
//     contextMode: "initial" | "incremental", // round 1 = initial; round>1 = incremental
//     argue: true,                      // run Phase 2b structured argument (default true)
//     respawnQuota: 1,                  // drift respawns allowed PER SEAT this round
//     seats: [ ... ],                   // OPTIONAL formation override (verbatim); else derived
//     codexAvailable: true,             // false => Codex critic becomes Opus adversarial persona
//   }
//   If `args` is undefined the workflow exits with a usage note (no guessing).

export const meta = {
  name: 'deadly-loop-round',
  description: 'One deadly-swarm round: context pack feeds a parallel trio (Reviewer/Auditor/Critic, multiplier-duplicated, diversified lenses) that investigates, argues, and converges to a deduped verdict. Coordinator loops rounds; never commits.',
  phases: [
    { title: 'Context', detail: 'sonnet agent builds the round context pack' },
    { title: 'Investigate', detail: 'multiplier x trio independent audit' },
    { title: 'Argue', detail: 'seats refute/corroborate/escalate peer findings' },
    { title: 'Converge', detail: 'deterministic dedup + verdict' },
  ],
};

// args may arrive as an OBJECT or as a JSON STRING depending on harness build
// (probe P8, 2026-06-10: a real JSON object in the tool call landed here as a
// string). Accept both; malformed string -> null -> usage error (no guessing).
const input = (typeof args === 'object' && args) ? args
  : (typeof args === 'string'
    ? (() => { try { const v = JSON.parse(args); return (v && typeof v === 'object') ? v : null; } catch (_) { return null; } })()
    : null);

// Structured-output schema for each debate seat (Phase 2a + drift detection).
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['GO', 'HOLD'] },
    checkedSHA: { type: 'string' }, // seat ECHOES the SHA it actually audited (drift check)
    checkedBranch: { type: 'string' }, // seat echoes the branch it audited (drift check)
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          file: { type: 'string' },
          line: { type: 'number' },
          category: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' }, // file:line or command output (required for non-drift)
          suggestedChange: { type: 'string' },
        },
        required: ['id', 'severity', 'file', 'category', 'claim', 'evidence'],
      },
    },
  },
  required: ['verdict', 'checkedSHA', 'findings'],
};

// Phase 2b structured-argument schema: a seat responds to peer findings.
const ARGUE_SCHEMA = {
  type: 'object',
  properties: {
    responses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string' },
          stance: { type: 'string', enum: ['refute', 'corroborate', 'escalate'] },
          evidence: { type: 'string' }, // refute REQUIRES file:line counter-evidence
        },
        required: ['findingId', 'stance', 'evidence'],
      },
    },
  },
  required: ['responses'],
};

// Phase 1 context-pack schema: returns the pack AS TEXT (no fs available).
const PACK_SCHEMA = {
  type: 'object',
  properties: {
    packSummary: { type: 'string' }, // one-paragraph summary for the verdict report
    packText: { type: 'string' },    // full pack — embedded verbatim into seat briefs
  },
  required: ['packSummary', 'packText'],
};

// Diversified lenses, indexed per duplicated seat (multiplier > 1). Seat 0 of each
// role gets lens[0]; the Kth duplicate gets lens[K % lenses.length]. Keeps duplicated
// seats from collapsing onto the same blindspot (Rounds 4-5 P0s came from divergence).
const LENSES = [
  'primary lens: correctness vs intent + full blast radius',
  'divergent lens: regression & cross-file coupling',
  'adversarial lens: failure modes, race conditions, partial-failure states',
  'security lens: auth/signing/redaction/injection/secret handling',
];

function lensFor(index) {
  return LENSES[index % LENSES.length];
}

// ---- Phase 1: CONTEXT brief (sonnet) ---------------------------------------
function contextBrief(a) {
  const lines = [
    'You are the deadly-loop CONTEXT agent. Build the shared context pack the debate',
    'seats will all read. Return the pack schema {packSummary, packText}. The pack is',
    'RETURNED AS TEXT (scripts have no filesystem) — make packText self-contained.',
    'TARGET: branch ' + a.branch + ' @ SHA ' + a.targetSHA + '. SCOPE: ' + a.scope + '.',
  ];
  if (a.contextMode === 'initial') {
    lines.push(
      'ROUND 1 (initial, comprehensive): enumerate the target files with line anchors,',
      'summarize prior history from the handoff (' + (a.handoffPath || '(none)') + '),',
      'declare the exact audit scope, and include the relevant code excerpts seats need.',
      'Run the graphify freshness check HERE ONLY (update if stale) — never per round.',
    );
  } else {
    lines.push(
      'ROUND ' + a.round + ' (incremental): start from the PRIOR pack',
      '(' + (a.prevPackPath || '(prevPackPath missing)') + '), then fold in the prior',
      'round findings and the fixes the coordinator applied since. Do NOT re-read every',
      'target in full — focus the pack on what changed + the open/contested findings.',
      'PRIOR FINDINGS: ' + JSON.stringify(a.findings || []),
      'FIXES APPLIED SINCE LAST ROUND: ' + JSON.stringify(a.fixesApplied || []),
      'Output a FRESH pack (the prior pack is input, not a cache).',
    );
  }
  return lines.join('\n');
}

// ---- Formation: build the trio (x multiplier) ------------------------------
// Role models per Workstream C + A1 canon:
//   Reviewer = Fable (correctness/architecture), Auditor = Opus (regression/coupling),
//   Critic = Codex (codex:codex-rescue, adversarial). If codexAvailable === false the
//   Critic degrades to an Opus adversarial persona. If args.seats is given, use it
//   verbatim (caller-controlled formation override).
function buildFormation(a) {
  if (Array.isArray(a.seats) && a.seats.length > 0) return a.seats;

  const mult = (typeof a.multiplier === 'number' && a.multiplier >= 1)
    ? Math.floor(a.multiplier) : 1;
  const codexUp = a.codexAvailable !== false;
  const roles = [
    // TEMP(fable-disabled 2026-06-29): Anthropic disabled Fable; Reviewer runs on Opus until re-enabled — revert this 'opus' back to 'fable' then.
    { role: 'reviewer', opts: { model: 'opus' } },
    { role: 'auditor', opts: { model: 'opus' } },
    {
      role: 'critic',
      opts: codexUp ? { agentType: 'codex:codex-rescue' } : { model: 'opus' },
      adversarialPersona: !codexUp, // Opus stand-in must carry the break-it persona
    },
  ];

  const seats = [];
  for (const r of roles) {
    for (let k = 0; k < mult; k++) {
      seats.push({
        role: r.role,
        // role-word label so the model-routing-guard debate-role exemption matches
        label: 'round-' + a.round + ':' + r.role + '-' + (k + 1),
        opts: r.opts,
        lensIndex: k,
        adversarialPersona: !!r.adversarialPersona,
      });
    }
  }
  return seats;
}

// ---- Phase 2a: INVESTIGATE brief -------------------------------------------
function investigateBrief(seat, a, packText, driftReason) {
  const lines = [
    'You are deadly-loop ' + seat.role.toUpperCase() + ' (' + seat.label + ').',
    // Guard-interplay: "review audit critique validate" are standalone complex tokens
    // that ensure the model-routing-guard complex-anywhere veto fires — preventing
    // a flagship seat (fable/opus) from being blocked when the caller's scope/pack
    // wording is mechanical-only and the seat label alone does not carry a complex token.
    'Role duties: review, audit, critique; validate every claim with file:line evidence.',
    'VERIFY-FIRST PREAMBLE: confirm you are on branch "' + a.branch + '" and that HEAD',
    'is exactly ' + a.targetSHA + ' BEFORE auditing. Echo both back in checkedBranch /',
    'checkedSHA. If they do not match, say so in checkedSHA and stop — do not invent findings.',
    'YOUR LENS — ' + lensFor(seat.lensIndex) + '.',
  ];
  if (seat.adversarialPersona) {
    lines.push('PERSONA: you are the adversarial break-it critic (Codex stand-in). Hunt the',
      'failure mode the other seats will rationalize away.');
  }
  lines.push(
    'SCOPE: ' + a.scope + '.',
    'CONTEXT PACK (shared, authoritative — work from this, do not re-derive it):',
    packText,
    'Every finding MUST cite file + evidence (file:line or command output). A finding',
    'with no file evidence will be rejected as drift.',
    'Return the verdict schema {verdict, checkedSHA, checkedBranch, findings:[...]}.',
  );
  if (driftReason) {
    // Respawn brief: corrected pack + drift reason ONLY. Never peer findings (contamination).
    lines.push(
      'RESPAWN — your prior result was discarded for DRIFT (' + driftReason + ').',
      'Re-audit the CORRECT branch/SHA/scope against the pack above. Do NOT be shown',
      'peer findings; reach your own verdict independently.',
    );
  }
  return lines.join('\n');
}

// ---- Phase 2b: ARGUE brief -------------------------------------------------
function argueBrief(seat, a, packText, peerFindings) {
  return [
    'You are deadly-loop ' + seat.role.toUpperCase() + ' (' + seat.label + ') in the',
    // Guard-interplay: standalone complex tokens keep flagship seats unblocked (see investigateBrief).
    'Role duties: review, audit, critique; validate every claim with file:line evidence.',
    'STRUCTURED ARGUMENT phase. Below are the OTHER seats\' findings. For EACH, respond',
    'with a stance: refute (cite file:line counter-evidence), corroborate, or escalate.',
    'Be honest — corroborate real bugs, refute only with evidence. Return the argue schema.',
    'CONTEXT PACK (same as investigation):',
    packText,
    'PEER FINDINGS TO ADJUDICATE:',
    JSON.stringify(peerFindings),
  ].join('\n');
}

// ---- Phase 3 helpers: dedup + converge -------------------------------------
function lineBucket(line) {
  if (typeof line !== 'number' || !isFinite(line)) return null;
  return Math.floor(line / 20);
}

function dedupKey(f) {
  const lb = lineBucket(f.line);
  return JSON.stringify({
    file: typeof f.file === 'string' ? f.file : '',
    category: typeof f.category === 'string' ? f.category : '',
    lineBucket: lb,
  });
}

// Objective drift criteria (E.1 Phase-3). A seat report drifts if it audited the wrong
// SHA/branch, or carries a finding with no file evidence. Schema-parse failures and
// wrong-scope are surfaced by the schema mechanism / wrong checkedSHA respectively.
// Returns a drift-reason string, or null if the report is clean. A null `report`
// (dead/skipped seat) is NOT drift — it is DEGRADED, handled separately.
function driftReasonFor(report, a) {
  if (report == null) return null; // dead seat -> DEGRADED, not drift
  if (typeof report !== 'object') return 'malformed-report';
  if (report.checkedSHA && report.checkedSHA !== a.targetSHA) {
    return 'sha-mismatch (audited ' + report.checkedSHA + ', expected ' + a.targetSHA + ')';
  }
  if (report.checkedBranch && a.branch && report.checkedBranch !== a.branch) {
    return 'branch-mismatch (audited ' + report.checkedBranch + ', expected ' + a.branch + ')';
  }
  // C1-5: a report whose findings is not an Array is malformed — flag it as drift
  // (a "GO" with no findings array gives the converge phase nothing to adjudicate
  // and must not silently count as a clean seat).
  if (!Array.isArray(report.findings)) return 'missing-findings-array';
  const findings = report.findings;
  for (const f of findings) {
    if (!f || typeof f.file !== 'string' || !f.file ||
        typeof f.evidence !== 'string' || !f.evidence) {
      return 'missing-file-evidence';
    }
  }
  return null;
}

async function main() {
  if (!input) {
    return {
      error: 'deadly-loop.workflow: no `args`. Invoke with args = { round, targetSHA, ' +
        'branch, scope, contextMode, ... } — the coordinator owns the round loop.',
    };
  }

  const a = input;
  const round = (typeof a.round === 'number') ? a.round : 1;

  // Hard-15 BACKSTOP (double-guard; coordinator owns the primary cap). Refuse to spawn.
  if (round > 15) {
    log('deadly-loop: round ' + round + ' exceeds hard-15 cap — refusing to spawn.');
    return { error: 'hard-cap-exceeded', round };
  }

  // ---- Phase 1: CONTEXT ----------------------------------------------------
  phase('Context: build round-' + round + ' pack (' + (a.contextMode || 'initial') + ')');
  log('round ' + round + ': context agent (sonnet) — ' + (a.contextMode || 'initial') + ' pack');
  const packResult = await agent(contextBrief(a), {
    model: 'sonnet', label: 'round-' + round + ':context-pack', schema: PACK_SCHEMA,
  });
  const packText = (packResult && typeof packResult.packText === 'string')
    ? packResult.packText
    : '(context pack unavailable — seats must verify scope independently)';
  const packSummary = (packResult && typeof packResult.packSummary === 'string')
    ? packResult.packSummary : '(no pack summary)';

  // ---- Formation -----------------------------------------------------------
  const seats = buildFormation(a);
  log('round ' + round + ': formation = ' + seats.length + ' seat(s) [' +
    seats.map((s) => s.label).join(', ') + ']');

  // ---- Phase 2a: INVESTIGATE (parallel) ------------------------------------
  phase('Investigate: ' + seats.length + ' seat(s) in parallel (round ' + round + ')');
  let reports = await parallel(seats.map((seat) => () =>
    agent(investigateBrief(seat, a, packText, null), {
      ...seat.opts, label: seat.label, schema: VERDICT_SCHEMA,
    })));

  // ---- Drift check + respawn-once ------------------------------------------
  const respawnQuota = (typeof a.respawnQuota === 'number') ? a.respawnQuota : 1;
  for (let i = 0; i < seats.length; i++) {
    const reason = driftReasonFor(reports[i], a);
    if (reason && respawnQuota > 0) {
      log('round ' + round + ': seat ' + seats[i].label + ' DRIFTED (' + reason +
        ') — respawning once with corrected brief.');
      reports[i] = await agent(investigateBrief(seats[i], a, packText, reason), {
        ...seats[i].opts, label: seats[i].label + ':respawn', schema: VERDICT_SCHEMA,
      });
    } else if (reason) {
      log('round ' + round + ': seat ' + seats[i].label + ' DRIFTED (' + reason +
        ') and respawn quota exhausted — counting as DEGRADED.');
      reports[i] = null;
    }
  }

  // Classify live vs dead seats. A null report (skipped/dead) => DEGRADED round.
  const liveIdx = [];
  const deadSeats = [];
  for (let i = 0; i < seats.length; i++) {
    if (reports[i] == null) deadSeats.push(seats[i].label);
    else liveIdx.push(i);
  }
  for (const dead of deadSeats) log('round ' + round + ': DEAD/DEGRADED seat — ' + dead);
  const anySeatDead = deadSeats.length > 0;

  // ---- Phase 2b: ARGUE (optional, live seats only) -------------------------
  let argueResults = {};
  if (a.argue !== false) {
    phase('Argue: cross-examination over peer findings (round ' + round + ')');
    const argueTasks = liveIdx.map((i) => () => {
      // Give seat i the OTHER live seats' findings only.
      const peerFindings = [];
      for (const j of liveIdx) {
        if (j === i) continue;
        const fs2 = Array.isArray(reports[j].findings) ? reports[j].findings : [];
        for (const f of fs2) peerFindings.push(f);
      }
      return agent(argueBrief(seats[i], a, packText, peerFindings), {
        ...seats[i].opts, label: seats[i].label + ':argue', schema: ARGUE_SCHEMA,
      });
    });
    const argued = await parallel(argueTasks);
    liveIdx.forEach((i, k) => { argueResults[seats[i].label] = argued[k]; });
  } else {
    log('round ' + round + ': Argue phase skipped (args.argue === false).');
  }

  // ---- Phase 3: CONVERGE & CONFIRM -----------------------------------------
  phase('Converge: dedup + adjudicate (round ' + round + ')');

  // Collect every finding tagged with its source seat label.
  const tagged = [];
  for (const i of liveIdx) {
    const fs2 = Array.isArray(reports[i].findings) ? reports[i].findings : [];
    for (const f of fs2) tagged.push({ seat: seats[i].label, finding: f });
  }

  // Merge-preserving dedup: same {file, category, lineBucket} key => one group,
  // findings kept in an array (never collapsed). Adjacent cross-bucket near-dupes
  // remain separate by design (no semantic dedup promised).
  const groups = new Map();
  for (const t of tagged) {
    const key = dedupKey(t.finding);
    if (!groups.has(key)) groups.set(key, { key, members: [], seats: new Set() });
    const g = groups.get(key);
    g.members.push(t.finding);
    g.seats.add(t.seat);
  }

  // Fold Phase 2b stances per finding id.
  const stanceByFindingId = new Map(); // id -> {refute, corroborate, escalate}
  for (const label of Object.keys(argueResults)) {
    const resp = argueResults[label];
    const responses = (resp && Array.isArray(resp.responses)) ? resp.responses : [];
    for (const r of responses) {
      if (!r || typeof r.findingId !== 'string') continue;
      if (!stanceByFindingId.has(r.findingId)) {
        stanceByFindingId.set(r.findingId, { refute: 0, corroborate: 0, escalate: 0 });
      }
      const s = stanceByFindingId.get(r.findingId);
      if (r.stance === 'refute') s.refute++;
      else if (r.stance === 'corroborate') s.corroborate++;
      else if (r.stance === 'escalate') s.escalate++;
    }
  }

  // Confirmed = flagged by >= 2 distinct seats, OR corroborated in 2b and not
  // successfully refuted. Contested = refuted or escalated groups. Residue = the rest.
  //
  // C1-3 corroboration threshold: at multiplier 1 (trio) there are only 2 peers, so a
  // single corroboration is meaningful evidence; at multiplier > 1 duplicated same-role
  // seats share lenses and a lone corroboration is too cheap — require 2 to confirm.
  const mult = (typeof a.multiplier === 'number' && a.multiplier >= 1)
    ? Math.floor(a.multiplier) : 1;
  const corroborationThreshold = mult > 1 ? 2 : 1;
  const confirmed = [];
  const contested = [];
  const residue = [];
  for (const g of groups.values()) {
    let refuted = 0;
    let corroborated = 0;
    let escalated = 0;
    for (const f of g.members) {
      const st = (f && typeof f.id === 'string') ? stanceByFindingId.get(f.id) : null;
      if (!st) continue;
      refuted += st.refute;
      corroborated += st.corroborate;
      escalated += st.escalate;
    }
    const multiSeat = g.seats.size >= 2;
    const out = {
      key: g.key,
      seats: Array.from(g.seats),
      members: g.members,
      stances: { refuted, corroborated, escalated },
    };
    if (escalated > 0 || (refuted > 0 && !multiSeat && corroborated === 0)) {
      contested.push(out);
    } else if (multiSeat || (corroborated >= corroborationThreshold && refuted === 0)) {
      confirmed.push(out);
    } else {
      residue.push(out);
    }
  }

  // Verdict: GO only if EVERY live seat returned GO AND no unresolved blockers
  // (any confirmed P0 OR any contested-escalated group is an unresolved blocker).
  // A DEGRADED round (a seat dead after retry) can never be a clean final GO — the
  // coordinator must run a full follow-up round; we mark degraded so it propagates.
  const liveVerdicts = liveIdx.map((i) => reports[i].verdict);
  const allLiveGO = liveVerdicts.length > 0 && liveVerdicts.every((v) => v === 'GO');
  const hasConfirmedP0 = confirmed.some((g) => g.members.some((f) => f && f.severity === 'P0'));
  const hasEscalated = contested.some((g) => g.stances.escalated > 0);
  const noUnresolvedBlockers = !hasConfirmedP0 && !hasEscalated;

  const verdictSummary = {
    go: allLiveGO && noUnresolvedBlockers && !anySeatDead,
    degraded: anySeatDead,
    roundsUsed: round,
    liveSeats: liveIdx.length,
    deadSeats,
  };

  log('round ' + round + ': verdict go=' + verdictSummary.go + ' degraded=' +
    verdictSummary.degraded + ' confirmed=' + confirmed.length + ' contested=' +
    contested.length + ' residue=' + residue.length);

  const seatReports = seats.map((seat, i) => {
    if (reports[i] == null) return seat.label + ': DEAD/DEGRADED';
    const n = Array.isArray(reports[i].findings) ? reports[i].findings.length : 0;
    return seat.label + ': ' + reports[i].verdict + ' (' + n + ' finding(s))';
  });

  return {
    verdictSummary,
    confirmed,
    contested,
    residue,
    packSummary,
    seatReports,
  };
}

return main();
