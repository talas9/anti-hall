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

const os = require('os');
const path = require('path');

function build(home) {
  const dd = require(path.join(__dirname, '..', 'hooks', 'lib', 'dispatch-demand.js'));
  return { dispatchDemand: dd.summary(home) };
}

function pct(x) { return x == null ? 'n/a' : (Math.round(x * 1000) / 10) + '%'; }

function render(r) {
  const d = r.dispatchDemand;
  return [
    'anti-hall dispatch report',
    '  dispatch demand: shown ' + d.demandsShown + ' · followed ' + d.demandsFollowed +
      ' · ignored ' + d.demandsIgnored + ' · compliance ' + pct(d.complianceRate),
    '  idle-neglect blocks: ' + d.idleNeglectBlocks,
  ].join('\n');
}

if (require.main === module) {
  const home = process.env.HOME || os.homedir();
  const r = build(home);
  process.stdout.write((process.argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r)) + '\n');
}

module.exports = { build, render };
