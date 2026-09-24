'use strict';
// fakeHivecontrol(dir, opts) — writes an executable `hivecontrol` into `dir`
// (PATH-inject it; never the real binary). It answers ONLY:
//   --version                    -> opts.version (or exits 1 when null)
//   workspace --help             -> contents of opts.workspaceHelp (a file)
//   workspace <verb> --help      -> opts.verbHelp[verb] (a file) or exit 1
//   workspace archive|delete ... -> records argv to <dir>/calls.ndjson, prints
//                                   {"ok":true}; exits opts.mutateExit (0)
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
    + 'if (a[0] === "workspace" && (a[1] === "archive" || a[1] === "delete")) { console.log(JSON.stringify({ ok: cfg.mutateExit === 0 })); process.exit(cfg.mutateExit); }\n'
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
