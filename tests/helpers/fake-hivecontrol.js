'use strict';
// fakeHivecontrol(dir, opts) — writes an executable `hivecontrol` into `dir`
// (PATH-inject it; never the real binary). It answers ONLY:
//   --version                    -> opts.version (or exits 1 when null)
//   workspace --help             -> contents of opts.workspaceHelp (a file)
//   workspace <verb> --help      -> opts.verbHelp[verb] (a file) or exit 1
//   workspace archive|delete ... -> records argv to <dir>/calls.ndjson, prints
//                                   {"ok":true}; exits opts.mutateExit (0).
//                                   opts.effectDb (a fixture app-DB path): a SUCCESSFUL
//                                   archive also flips the matching builder (id OR
//                                   branchName == argv[2]) to isActive=0/isHidden=1 like
//                                   the real app; without it the call is a NO-OP that
//                                   still exits 0 (the field-report shape).
//                                   opts.effectBranchOnly: the flip happens ONLY when argv[2]
//                                   is the builder's branchName (an id call is a no-op).
//                                   opts.archiveBody: stdout body instead of {"ok":true}.
//                                   opts.listAll: JSON array printed for `workspace list all`.
// Every invocation is appended to <dir>/calls.ndjson so tests can assert
// exactly what was (and was not) spawned.
const fs = require('node:fs');
const path = require('node:path');

function fakeHivecontrol(dir, opts) {
  const o = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  const cfg = {
    version: o.version === undefined ? '2.5.2' : o.version,
    workspaceHelp: o.workspaceHelp || null,
    verbHelp: o.verbHelp || {},
    mutateExit: Number.isFinite(o.mutateExit) ? o.mutateExit : 0,
    effectDb: o.effectDb || null,
    effectBranchOnly: !!o.effectBranchOnly,
    archiveBody: o.archiveBody === undefined ? null : o.archiveBody,
    listAll: o.listAll === undefined ? null : o.listAll,
    calls: path.join(dir, 'calls.ndjson'),
  };
  const bin = path.join(dir, 'hivecontrol');
  const src = '#!' + process.execPath + '\n'
    + "'use strict';\n"
    + 'const fs = require("fs");\n'
    + 'const cfg = ' + JSON.stringify(cfg) + ';\n'
    + 'const a = process.argv.slice(2);\n'
    + 'fs.appendFileSync(cfg.calls, JSON.stringify({ argv: a, cwd: process.cwd() }) + "\\n");\n'
    + 'if (a[0] === "--version") { if (cfg.version == null) process.exit(1); console.log(cfg.version); process.exit(0); }\n'
    + 'if (a[0] === "workspace" && a[1] === "--help") { if (cfg.workspaceHelp) process.stdout.write(fs.readFileSync(cfg.workspaceHelp, "utf8")); process.exit(0); }\n'
    + 'if (a[0] === "workspace" && a[2] === "--help") { const f = cfg.verbHelp[a[1]]; if (!f) process.exit(1); process.stdout.write(fs.readFileSync(f, "utf8")); process.exit(0); }\n'
    + 'if (a[0] === "workspace" && a[1] === "list" && a[2] === "all" && cfg.listAll != null) { console.log(JSON.stringify(cfg.listAll)); process.exit(0); }\n'
    + 'if (a[0] === "workspace" && a[1] === "archive" && cfg.mutateExit === 0 && cfg.effectDb) { try { const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(cfg.effectDb); db.prepare("UPDATE builders SET isActive = 0, isHidden = 1 WHERE " + (cfg.effectBranchOnly ? "" : "id = ? OR ") + "branchName = ?").run(...(cfg.effectBranchOnly ? [a[2]] : [a[2], a[2]])); db.close(); } catch (_) {} }\n'
    + 'if (a[0] === "workspace" && (a[1] === "archive" || a[1] === "delete")) { if (cfg.mutateExit === 0 && cfg.archiveBody != null) { process.stdout.write(cfg.archiveBody); } else { console.log(JSON.stringify({ ok: cfg.mutateExit === 0 })); } process.exit(cfg.mutateExit); }\n'
    + 'process.exit(2);\n';
  fs.writeFileSync(bin, src, { mode: 0o755 });
  return { bin, dir, callsFile: cfg.calls };
}

function readCalls(callsFile) {
  try {
    return fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) { return []; }
}

module.exports = { fakeHivecontrol, readCalls };
