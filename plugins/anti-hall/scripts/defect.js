#!/usr/bin/env node
'use strict';
// anti-hall :: defect CLI — durable, file-based, two-way defect channel
// between agents running anti-hall in ANY repo and the anti-hall maintainer.
// See hooks/lib/defect-store.js for the full design rationale (file-based,
// derived-state-only, no index, write-verified).
//
// SUBCOMMANDS
//   report --class C --sev p0|p1|p2 --sym T [--repro T --sym-file F --repro-file F
//          --claimed T --observed T --proj P --sid S --v V]
//          Append a report line. --sym-file/--repro-file read the field's body
//          from a file (byte-exact — no shell interpolation of the body) and
//          are overridden by --sym/--repro when both are given. `proj`
//          defaults via reporterIdentity(): --proj -> ANTIHALL_DEFECT_PROJ ->
//          repoKeyForWorktree(cwd) -> 'no-repo'. Exits 0 ONLY on 'recorded' or
//          'occurrence-appended' — every other outcome (registry-full,
//          occurrence-capped, defect-full, too-large, write-unverified,
//          invalid-class, invalid-severity) exits non-zero. This is the
//          point of the feature: no silent success. On success the printed
//          result also carries the freshly re-derived `status`/`staleBuild`.
//   list [--mine|--open] [--json]
//          List open defects (derived state only). --mine matches a UNION of
//          identities (repoKeyForWorktree(cwd), basename(cwd), --proj/
//          ANTIHALL_DEFECT_PROJ if given) so already-filed reports (proj =
//          old cwd basename) keep matching alongside new reports.
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

const fs = require('fs');
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

// readFileField(filePath) -> file contents (utf8, unmodified — no trim, no
// clamp; clamping happens once, downstream, in defect-store's clampField) or
// null if unreadable/absent. Backing for --sym-file/--repro-file: reading a
// file's bytes directly (never interpolating them into a shell string) is
// what makes backticks/`$(`/newlines in a report body byte-exact-safe.
function readFileField(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function clampIdentity(s) {
  return String(s == null ? '' : s).slice(0, 64);
}

// reporterIdentity(flags, env, cwd) -> the `proj` value a report is filed
// under. First hit wins:
//   1. --proj <s>                          (clamped to 64 chars)
//   2. ANTIHALL_DEFECT_PROJ env var         (clamped to 64 chars)
//   3. repokey.repoKeyForWorktree(cwd)      (fails open to null outside git)
//   4. literal 'no-repo'
// This is intentionally NOT a cutover from the old cwd-basename identity —
// existing report lines already on disk keep matching by basename (see
// mineIdentities' union below); nothing here is rewritten or migrated.
function reporterIdentity(flags, env, cwd) {
  if (flags && typeof flags.proj === 'string' && flags.proj) {
    return clampIdentity(flags.proj);
  }
  if (env && typeof env.ANTIHALL_DEFECT_PROJ === 'string' && env.ANTIHALL_DEFECT_PROJ) {
    return clampIdentity(env.ANTIHALL_DEFECT_PROJ);
  }
  try {
    const repokey = require(path.join(__dirname, '..', 'companion', 'lib', 'devswarm-repokey.js'));
    const key = repokey.repoKeyForWorktree(cwd);
    if (key) return key;
  } catch (_) { /* repokey unavailable -> fall through */ }
  return 'no-repo';
}

// mineIdentities(flags, env, cwd) -> Set of identities `--mine` should match
// a report's `proj` against — a UNION, not a single value, so already-filed
// reports (proj = old cwd basename) keep matching alongside new reports
// (proj = repoKey / --proj / env override).
function mineIdentities(flags, env, cwd) {
  const ids = new Set();
  ids.add(path.basename(cwd));
  try {
    const repokey = require(path.join(__dirname, '..', 'companion', 'lib', 'devswarm-repokey.js'));
    const key = repokey.repoKeyForWorktree(cwd);
    if (key) ids.add(key);
  } catch (_) { /* repokey unavailable -> basename-only */ }
  if (flags && typeof flags.proj === 'string' && flags.proj) ids.add(clampIdentity(flags.proj));
  if (env && typeof env.ANTIHALL_DEFECT_PROJ === 'string' && env.ANTIHALL_DEFECT_PROJ) {
    ids.add(clampIdentity(env.ANTIHALL_DEFECT_PROJ));
  }
  return ids;
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
  const cwd = process.cwd();
  const input = {
    class: f.class,
    sev: f.sev,
    sym: f.sym || readFileField(f['sym-file']) || '',
    repro: f.repro || readFileField(f['repro-file']) || '',
    claimed: f.claimed || '',
    observed: f.observed || '',
    proj: reporterIdentity(f, process.env, cwd),
    sid: f.sid || process.env.CLAUDE_SESSION_ID || process.env.ANTIHALL_SESSION_ID || 'unknown',
    v: f.v || readVersion(),
  };
  const result = store.report(input);
  // Re-derive after the verified write so a caller can see the CURRENT
  // (possibly regressed) status and staleBuild flag for the fp it just
  // wrote to, not just the raw write outcome.
  if (result.outcome === 'recorded' || result.outcome === 'occurrence-appended') {
    const shown = store.showDefect(result.fp);
    if (shown) {
      result.status = shown.status;
      result.staleBuild = !!shown.staleBuild;
    }
  }
  printResult(result, !!f.json);
  return result.outcome === 'recorded' || result.outcome === 'occurrence-appended' ? 0 : 1;
}

function cmdList(args) {
  const f = args.flags;
  let defects = store.listDefects({});
  if (f.mine) {
    const ids = mineIdentities(f, process.env, process.cwd());
    defects = defects.filter((d) => ids.has(d.proj));
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

module.exports = {
  parseArgs, cmdReport, cmdList, cmdShow, cmdRule, cmdArchive,
  reporterIdentity, mineIdentities, readFileField,
};
