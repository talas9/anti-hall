#!/usr/bin/env node
'use strict';
// anti-hall :: dispatch report — read-only effectiveness metrics for the
// parallel-dispatch demand (hooks/lib/dispatch-demand.js).
//
// USAGE
//   node plugins/anti-hall/scripts/dispatch-report.js [--json]
//
// METRICS (~/.anti-hall/dispatch-demand-metrics.json)
//   demandsShown       per-turn "DISPATCH NOW in parallel" lines emitted
//   demandsFollowed    turns where an Agent/Task/Workflow spawn followed the
//                      demand within the same turn
//   demandsIgnored     turns that ended with no spawn after the demand
//   complianceRate     demandsFollowed / (demandsFollowed + demandsIgnored)
//   idleNeglectBlocks  task-guard IDLE NEGLECT Stop blocks
//
// JEV dispatchTier (hooks/lib/dispatch-tier.js; same file, "tier" block)
//   verdicts.{workspace,workflow,subagent}  distinct task texts classified
//   followed / overridden / followRate      actual dispatch (Agent / Workflow /
//                                           devswarm spawn) vs the recommendation
//   subagentOneLane / subagentEscalated     accuracy proxy for subagent-tier
//   workflowFannedOut / workflowNoFanout    accuracy proxy for workflow-tier
// Per-decision rows + outcome labels: node scripts/jev-report.js (id dispatchTier).

const os = require('os');
const path = require('path');

function build(home) {
  const dd = require(path.join(__dirname, '..', 'hooks', 'lib', 'dispatch-demand.js'));
  const dt = require(path.join(__dirname, '..', 'hooks', 'lib', 'dispatch-tier.js'));
  return { dispatchDemand: dd.summary(home), dispatchTier: dt.summary(home) };
}

function pct(x) { return x == null ? 'n/a' : (Math.round(x * 1000) / 10) + '%'; }

function render(r) {
  const d = r.dispatchDemand;
  const t = r.dispatchTier;
  return [
    'anti-hall dispatch report',
    '  dispatch demand: shown ' + d.demandsShown + ' · followed ' + d.demandsFollowed +
      ' · ignored ' + d.demandsIgnored + ' · compliance ' + pct(d.complianceRate),
    '  idle-neglect blocks: ' + d.idleNeglectBlocks,
    '  jev dispatchTier: verdicts workspace ' + t.verdicts.workspace + ' · workflow ' + t.verdicts.workflow +
      ' · subagent ' + t.verdicts.subagent,
    '    followed ' + t.followed + ' · overridden ' + t.overridden + ' (follow rate ' + pct(t.followRate) + ')' +
      ' · subagent one-lane ' + t.subagentOneLane + ' / escalated ' + t.subagentEscalated +
      ' · workflow fanned-out ' + t.workflowFannedOut + ' / no-fanout ' + t.workflowNoFanout,
  ].join('\n');
}

if (require.main === module) {
  const home = require('../companion/lib/test-home-guard.js').resolveHome(process.env.HOME, process.env);
  const r = build(home);
  process.stdout.write((process.argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r)) + '\n');
}

module.exports = { build, render };
