#!/usr/bin/env node
'use strict';
// anti-hall :: defect CLI — durable, file-based, two-way defect channel
// between agents running anti-hall in ANY repo and the anti-hall maintainer.
// See hooks/lib/defect-store.js for the full design rationale (file-based,
// derived-state-only, no index, write-verified).
//
// SUBCOMMANDS
//   report --class C --sev p0|p1|p2 --sym T [--repro T --claimed T --observed T
//          --proj P --sid S --v V]
//          Append a report line. Exits 0 ONLY on 'recorded' or
//          'occurrence-appended' — every other outcome (registry-full,
//          occurrence-capped, defect-full, too-large, write-unverified,
//          invalid-class, invalid-severity) exits non-zero. This is the
//          point of the feature: no silent success.
//   list [--mine|--open] [--json]
//          List open defects (derived state only).
//   show <fp> [--json]
//          Show every line of one defect (open or archived).
//   rule <fp> --status ack|fixed|wontfix|notabug|dup [--fixed-in V --commit SHA
//        --note T --superseded-by FP] [--json]
//          Maintainer-only: append a ruling line. Exits non-zero on anything
//          but 'ruled'.
//   archive [--json]
//          Rotation sweep: move ruled+stale (30d) defect files into
//          archive/<YYYY-MM>/. OPEN defects never move.
//
// Pure Node built-ins only, cross-platform.

const path = require('path');
const store = require(path.join(__dirname, '..', 'hooks', 'lib', 'defect-store.js'));

function readVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'));
    return pkg.version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function printResult(result, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

function cmdReport(args) {
  const f = args.flags;
  const input = {
    class: f.class,
    sev: f.sev,
    sym: f.sym || '',
    repro: f.repro || '',
    claimed: f.claimed || '',
    observed: f.observed || '',
    proj: f.proj || path.basename(process.cwd()),
    sid: f.sid || process.env.CLAUDE_SESSION_ID || process.env.ANTIHALL_SESSION_ID || 'unknown',
    v: f.v || readVersion(),
  };
  const result = store.report(input);
  printResult(result, !!f.json);
  return result.outcome === 'recorded' || result.outcome === 'occurrence-appended' ? 0 : 1;
}

function cmdList(args) {
  const f = args.flags;
  let defects = store.listDefects({});
  if (f.mine) {
    const proj = path.basename(process.cwd());
    defects = defects.filter((d) => d.proj === proj);
  }
  if (f.open) {
    defects = defects.filter((d) => d.status === 'open');
  }
  printResult(defects, !!f.json);
  return 0;
}

function cmdShow(args) {
  const fp = args._[0];
  if (!fp) {
    process.stderr.write('usage: defect.js show <fp>\n');
    return 1;
  }
  const result = store.showDefect(fp);
  if (!result) {
    printResult({ outcome: 'not-found', fp }, !!args.flags.json);
    return 1;
  }
  printResult(Object.assign({ outcome: 'found' }, result), !!args.flags.json);
  return 0;
}

function cmdRule(args) {
  const fp = args._[0];
  const f = args.flags;
  if (!fp) {
    process.stderr.write('usage: defect.js rule <fp> --status ...\n');
    return 1;
  }
  const input = {
    status: f.status,
    note: f.note || '',
    fixedIn: f['fixed-in'],
    commit: f.commit,
    supersededBy: f['superseded-by'],
  };
  const result = store.rule(fp, input);
  printResult(result, !!f.json);
  return result.outcome === 'ruled' ? 0 : 1;
}

function cmdArchive(args) {
  const results = store.archiveSweep(Date.now());
  printResult(results, !!args.flags.json);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  let code;
  switch (cmd) {
    case 'report': code = cmdReport(args); break;
    case 'list': code = cmdList(args); break;
    case 'show': code = cmdShow(args); break;
    case 'rule': code = cmdRule(args); break;
    case 'archive': code = cmdArchive(args); break;
    default:
      process.stderr.write(
        'usage: defect.js <report|list|show|rule|archive> [...flags]\n'
      );
      code = 1;
  }
  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, cmdReport, cmdList, cmdShow, cmdRule, cmdArchive };
