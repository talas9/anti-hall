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
//
// COORDINATOR WORK (hooks/lib/coordinator-work.js; coordinator-work-metrics.json
// + live coordinator-work-session-*.json)
//   nudges / blocks              shown COORDINATOR DRIFT notes / Pre blocks
//   blocksPerSession             mean over all sessions, max
//   skippedWouldBlock            would-be blocks passed by an explicit skip
//                                (separate counter, not part of any share)
//   versions.<v>.postedShare     work / calls (successful main-thread Bash calls)
//   versions.<v>.attemptedShare  (work + blocks) / (calls + blocks)

const os = require('os');
const path = require('path');

function build(home) {
  const dd = require(path.join(__dirname, '..', 'hooks', 'lib', 'dispatch-demand.js'));
  const dt = require(path.join(__dirname, '..', 'hooks', 'lib', 'dispatch-tier.js'));
  const cw = require(path.join(__dirname, '..', 'hooks', 'lib', 'coordinator-work.js'));
  return { dispatchDemand: dd.summary(home), dispatchTier: dt.summary(home), coordinatorWork: cw.summary(home) };
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
  ].concat(renderCoordinatorWork(r.coordinatorWork)).join('\n');
}

function renderCoordinatorWork(c) {
  if (!c) return [];
  const bps = c.blocksPerSession || {};
  const mean = bps.mean == null ? 'n/a' : String(Math.round(bps.mean * 100) / 100);
  const lines = ['  coordinator work: nudges ' + c.nudges + ' · blocks ' + c.blocks + ' · blocks/session mean ' + mean +
    ' max ' + (bps.max || 0) + ' · skipped would-be blocks ' + c.skippedWouldBlock + ' (' + c.sessionsWithSkippedWouldBlock + ' sessions)'];
  for (const [v, e] of Object.entries(c.versions || {})) {
    lines.push('    ' + v + ': sessions ' + e.sessions + ' · work share ' + pct(e.postedShare) + ' (attempted ' + pct(e.attemptedShare) + ')');
  }
  lines.push('    baseline: node scripts/coordinator-work-baseline.js <transcript.jsonl>');
  lines.push('    known gaps: obfuscated inline bodies, loose inline count-only, session-compiled binaries, mtime back-dating, ' +
    'managed-location scripts, gitignored build launchers and submodule scripts count, just/task, stash pop/apply (see GUIDE)');
  return lines;
}

if (require.main === module) {
  const home = require('../companion/lib/test-home-guard.js').resolveHome(process.env.HOME, process.env);
  const r = build(home);
  process.stdout.write((process.argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r)) + '\n');
}

module.exports = { build, render };
