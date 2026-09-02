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
//   list [--mine|--open|--unfinished] [--json]
//          List defects (derived state only; open ones by default when no
//          filter is given — the JSON payload also includes fixed/wontfix/
//          notabug/dup/regressed entries when unfiltered). --mine matches a
//          UNION of identities (repoKeyForWorktree(cwd), basename(cwd),
//          --proj/ANTIHALL_DEFECT_PROJ if given) so already-filed reports
//          (proj = old cwd basename) keep matching alongside new reports.
//          --open is the narrow, literal filter: status === 'open' only
//          (untriaged — nobody has ruled on it yet); 'ack'/'partial'/
//          'regressed' are all EXCLUDED, same as 'regressed' always was
//          (this is an established, documented contract — do not widen it).
//          --unfinished is the wider "still needs attention" filter: every
//          status EXCEPT the closed set (fixed/wontfix/notabug/dup) — i.e.
//          open + ack + partial + regressed. Use --unfinished for an
//          accurate "how many defects are outstanding" count; --open when
//          you specifically want only the untriaged ones.
//   show <fp> [--json]
//          Show every line of one defect (open or archived).
//   rule <fp> --status ack|fixed|wontfix|notabug|dup|partial [--fixed-in V
//        --commit SHA --note T --superseded-by FP] [--json]
//          Maintainer-only: append a ruling line. 'partial' means only part
//          of the defect is fixed — use --fixed-in for the part that
//          shipped and --note for what's still open; it never derives as
//          'fixed'. Exits non-zero on anything but 'ruled'.
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

// clampIdentity(s) -> s bounded to 64 chars. The CLI's own identity clamp,
// applied BEFORE the store sees the value, so the store's `truncated` map
// cannot observe it. Truncation here is announced by warnIdentityTruncated()
// rather than marked in-value: `proj` is a match key (`list --mine`), and a
// marker inside it would break the very matching it identifies.
const IDENTITY_CAP = 64;
function clampIdentity(s) {
  return String(s == null ? '' : s).slice(0, IDENTITY_CAP);
}

// warnIdentityTruncated(raw, label) -> stderr warning if `raw` exceeds the
// identity cap. Same rule as the store's: never fail, never stay silent.
function warnIdentityTruncated(raw, label) {
  const s = String(raw == null ? '' : raw);
  if (s.length <= IDENTITY_CAP) return;
  process.stderr.write(
    `warning: ${label} truncated to fit the identity cap: ${s.length} chars -> cap ${IDENTITY_CAP}\n`
  );
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
    warnIdentityTruncated(flags.proj, '--proj');
    return clampIdentity(flags.proj);
  }
  if (env && typeof env.ANTIHALL_DEFECT_PROJ === 'string' && env.ANTIHALL_DEFECT_PROJ) {
    warnIdentityTruncated(env.ANTIHALL_DEFECT_PROJ, 'ANTIHALL_DEFECT_PROJ');
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

// VALID_FLAGS: the closed set of flags each subcommand accepts. Anything
// else in argv is an unknown flag and must be REJECTED (see checkFlags) —
// silently accepting an unknown flag and dropping its value caused real
// data loss (defect 479f604daa9c: --observed-file/--note-file were typed
// as though they existed, silently wrote empty fields, and exited 0).
const VALID_FLAGS = {
  report: ['class', 'sev', 'sym', 'repro', 'sym-file', 'repro-file', 'claimed', 'observed', 'proj', 'sid', 'v', 'json'],
  list: ['mine', 'open', 'unfinished', 'json'],
  show: ['json'],
  rule: ['status', 'fixed-in', 'commit', 'note', 'superseded-by', 'json'],
  archive: ['json'],
};

// checkFlags(cmd, flags) -> array of human-readable error strings, or null
// if every flag in `flags` is valid for `cmd`. When an unknown flag IS valid
// for a *different* subcommand, the error names that subcommand explicitly
// (e.g. "--fixed-in is valid for `rule`, not `report`") rather than a bare
// "unknown flag" — the whole point is to catch a flag typed against the
// wrong verb, not just a typo.
function checkFlags(cmd, flags) {
  const valid = VALID_FLAGS[cmd] || [];
  const unknown = Object.keys(flags || {}).filter((k) => !valid.includes(k));
  if (unknown.length === 0) return null;
  return unknown.map((k) => {
    const others = Object.keys(VALID_FLAGS).filter((c) => c !== cmd && VALID_FLAGS[c].includes(k));
    if (others.length) {
      return `--${k} is valid for \`${others.join('`, `')}\`, not \`${cmd}\``;
    }
    return `--${k} is not a valid flag for \`${cmd}\``;
  });
}

// printFlagError(cmd, errors) -> writes each error plus the full valid-flag
// list for `cmd` to stderr. Called BEFORE any store write, so nothing is
// ever written when an unknown flag is present.
function printFlagError(cmd, errors) {
  for (const e of errors) process.stderr.write('error: ' + e + '\n');
  process.stderr.write(`valid flags for \`${cmd}\`: ${(VALID_FLAGS[cmd] || []).map((f) => '--' + f).join(', ')}\n`);
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

// warnTruncated(result) -> writes a stderr line naming every field the store
// had to cut, with its original length and the cap it hit. The `truncated`
// map is already in the printed JSON result; this makes it impossible to
// miss in a plain terminal too. Never changes the exit code: a truncated
// write is a SUCCESSFUL write that lost some text, not a failure.
function warnTruncated(result) {
  const t = result && result.truncated;
  if (!t) return;
  const parts = Object.keys(t).map((k) => {
    const info = t[k];
    return `${k} (${info.originalLength} chars -> cap ${info.cap}${info.marked ? ', marker written' : ''})`;
  });
  process.stderr.write(
    'warning: content was truncated to fit the defect schema: ' + parts.join(', ') + '\n'
  );
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
  warnTruncated(result);
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
  if (f.unfinished) {
    defects = defects.filter((d) => store.isUnfinished(d.status));
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
  warnTruncated(result);
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
  if (VALID_FLAGS[cmd]) {
    const errors = checkFlags(cmd, args.flags);
    if (errors) {
      printFlagError(cmd, errors);
      process.exit(1);
    }
  }
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
  VALID_FLAGS, checkFlags,
};
