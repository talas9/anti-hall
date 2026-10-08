'use strict';
// anti-hall :: stable-launcher — a version-INDEPENDENT entry point for the
// two scripts anti-hall's own injected directive text (mailbox wake cron
// prompt, Monitor re-arm command, DevSwarm comms override, Stop-gate
// handover/drain text) names as a literal `node <path>` command:
// scripts/devswarm.js and companion/lib/devswarm-wake-watch.js.
//
// ROOT PROBLEM (peer report, downstream-project Primary, 2026-09-26): every one of those
// paths was previously baked from the CURRENTLY RUNNING hook's own __dirname
// — the version-pinned plugin-cache dir (e.g.
// .../cache/anti-hall/anti-hall/0.109.1/scripts/devswarm.js). That path is
// correct the instant it's printed, but crons, Monitors, and handover docs
// keep the LITERAL text around across releases — so after the NEXT anti-hall
// update the printed command still points at the OLD version's directory
// (which may no longer even exist) and shows a stale version number in the
// text itself, forcing a manual recreate of every cron/Monitor/handover.
//
// FIX: install/refresh two tiny, self-contained launcher scripts under
// ~/.anti-hall/bin/ that resolve the CURRENTLY REGISTERED anti-hall version
// EVERY TIME THEY RUN (not baked at generation time) and delegate to it with
// full argv/exit-code passthrough. Injected directive text then names the
// launcher path (`node ~/.anti-hall/bin/devswarm.js ...`), which never goes
// stale.
//
// This module only handles GENERATING/INSTALLING the launcher files
// (idempotent — only writes when content actually differs) and resolving the
// two stable paths for a caller to embed in directive text. The GENERATED
// launcher's OWN runtime resolution logic is necessarily inlined as plain
// text (it must run as a totally standalone script with no `require` back
// into any specific anti-hall version's module tree — that version is
// exactly what it's trying to find each time it runs), but it is a
// different, simpler read (installed_plugins.json's own `installPath` field,
// then the marketplace clone) than the semver-comparison "newest known
// version" resolver in companion/lib/devswarm-version-check.js (which
// devswarm-wake-watch.js's checkStaleVersion / doctor-devswarm.js already
// share) — this is not a second copy of that resolver, and callers that need
// the "is X stale relative to newest" question keep using that one.
//
// Fail-open throughout: any install/write failure returns null and the
// caller MUST fall back to the raw __dirname-derived path it already had —
// a launcher-install failure must never leave a hook without a runnable
// path in its directive text.

const fs = require('fs');
const path = require('path');
const os = require('os');

const BIN_DIR_SEGMENTS = ['.anti-hall', 'bin'];

// TARGETS — the two scripts anti-hall's injected text ever names literally.
// `name` is the launcher's own filename under ~/.anti-hall/bin/; `segments`
// is the real script's path relative to the plugin root (plugins/anti-hall/).
const TARGETS = {
  devswarm: { name: 'devswarm.js', segments: ['scripts', 'devswarm.js'] },
  wakeWatch: { name: 'wake-watch.js', segments: ['companion', 'lib', 'devswarm-wake-watch.js'] },
};

function binDir(home) {
  return path.join(require('../../companion/lib/test-home-guard.js').resolveHome(home), ...BIN_DIR_SEGMENTS);
}

function launcherPath(kind, home) {
  const t = TARGETS[kind];
  if (!t) return null;
  return path.join(binDir(home), t.name);
}

// meshRoute(argv, segments) -> a thin routing shim EMBEDDED in the devswarm
// launcher (via Function#toString, so it must stay self-contained). For exactly
// the ported verbs (`send`, `mesh read`, `inbox ack-primary`), when settings.json `mesh.engine_writes`
// is "on" and the engine binary exists, it runs `ah-engine mesh <argv>` with a time
// limit and returns {done: exitCode}; otherwise {input} (stdin already consumed
// for --message-stdin, to be replayed) and the caller runs the Node script.
// Falls back to Node on: engine missing, spawn error, timeout, killed by signal,
// exit 127 or 75 (the engine deferred and could not run Node itself: 75 means
// "deferred, NOTHING written" everywhere in the engine). A failure AFTER the engine
// wrote exits 70 (mesh_write.exit_committed_failure): passed through, never rerun
// in Node, as is every other code (the verb's own result).
// Every other exit code is the verb's own result (Node parity) and passes through.
function meshRoute(argv, segments) {
  var out = { input: undefined };
  try {
    if (!segments || segments[1] !== 'devswarm.js') return out;
    if (!(argv[0] === 'send' || (argv[0] === 'mesh' && argv[1] === 'read') || (argv[0] === 'inbox' && argv[1] === 'ack-primary'))) return out;
    var fs = require('fs'), path = require('path'), os = require('os');
    var dir = path.join(os.homedir(), '.anti-hall');
    var m = null;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).mesh; } catch (_) {}
    if (!m || String(m.engine_writes).trim().toLowerCase() !== 'on') return out;
    var bin = path.join(dir, 'ah-engine', 'bin', 'ah-engine');
    try { fs.accessSync(bin, fs.constants.X_OK); } catch (_) { return out; }
    var ms = Number(m.engine_timeout_ms);
    if (!(ms > 0)) ms = 15000;
    var piped = argv.indexOf('--message-stdin') >= 0;
    var input;
    if (piped) { try { input = fs.readFileSync(0); } catch (_) { input = Buffer.alloc(0); } out.input = input; }
    var r = require('child_process').spawnSync(bin, ['mesh'].concat(argv), {
      stdio: [piped ? 'pipe' : 'inherit', 'inherit', 'inherit'], input: input, timeout: ms, killSignal: 'SIGKILL',
    });
    var why = r.error ? String(r.error.code || r.error.message) : r.signal ? 'signal ' + r.signal : r.status === 127 ? 'exit 127' : r.status === 75 ? 'exit 75' : '';
    if (!why) return { done: r.status === null ? 1 : r.status };
    try {
      fs.mkdirSync(path.join(dir, 'ah-engine'), { recursive: true });
      fs.appendFileSync(path.join(dir, 'ah-engine', 'mesh-route.log'),
        JSON.stringify({ ts: Date.now(), verb: argv.slice(0, 2).join(' '), fallback: 'node', why: why }) + '\n');
    } catch (_) {}
  } catch (_) {}
  return out;
}

// buildLauncherSource(segments, fallbackAbsPath) -> the generated launcher's
// full source text. Pure Node built-ins only; no external requires; safe to
// run from ANY cwd on macOS or Linux. `segments`/`fallbackAbsPath` are baked
// in as JSON literals (never string-concatenated unescaped) so an unusual
// install path (spaces, quotes) can never break the generated source.
function buildLauncherSource(segments, fallbackAbsPath) {
  const segLit = JSON.stringify(segments || []);
  const fallbackLit = JSON.stringify(fallbackAbsPath || null);
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    '// AUTO-GENERATED by anti-hall (hooks/lib/stable-launcher.js) — do not edit by hand,',
    '// it is overwritten (idempotently — only when content actually changes) at',
    '// SessionStart/Stop. Resolves the CURRENTLY REGISTERED anti-hall install',
    '// (installed_plugins.json -> marketplace clone -> the path baked in at',
    '// generation time) EVERY TIME THIS RUNS, and delegates to its real script',
    '// with full argv/exit-code passthrough — so a `node` command naming THIS',
    '// file never goes stale across an anti-hall update.',
    'const fs = require("fs");',
    'const path = require("path");',
    'const os = require("os");',
    'const SEGMENTS = ' + segLit + ';',
    'const FALLBACK = ' + fallbackLit + ';',
    '',
    'function fileExists(p) {',
    '  try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; }',
    '}',
    '',
    'function fromInstalledJson() {',
    '  try {',
    '    const home = os.homedir();',
    '    const p = path.join(home, ".claude", "plugins", "installed_plugins.json");',
    '    const data = JSON.parse(fs.readFileSync(p, "utf8"));',
    '    const reg = (data && typeof data === "object" && data.plugins && typeof data.plugins === "object")',
    '      ? data.plugins : data;',
    '    const entry = reg && reg["anti-hall@anti-hall"];',
    '    let pick = null;',
    '    if (Array.isArray(entry)) {',
    '      pick = entry.find(function (e) { return e && e.scope === "user" && typeof e.installPath === "string"; })',
    '        || entry.find(function (e) { return e && e.scope === "project" && typeof e.installPath === "string"; })',
    '        || entry.find(function (e) { return e && typeof e.installPath === "string"; });',
    '    } else if (entry && typeof entry === "object" && typeof entry.installPath === "string") {',
    '      pick = entry;',
    '    }',
    '    if (pick) {',
    '      const target = path.join.apply(path, [pick.installPath].concat(SEGMENTS));',
    '      if (fileExists(target)) return target;',
    '    }',
    '  } catch (_) { /* fall through */ }',
    '  return null;',
    '}',
    '',
    'function fromMarketplace() {',
    '  try {',
    '    const home = os.homedir();',
    '    const target = path.join.apply(path,',
    '      [home, ".claude", "plugins", "marketplaces", "anti-hall", "plugins", "anti-hall"].concat(SEGMENTS));',
    '    if (fileExists(target)) return target;',
    '  } catch (_) { /* fall through */ }',
    '  return null;',
    '}',
    '',
    'function resolveTarget() {',
    '  return fromInstalledJson() || fromMarketplace() || FALLBACK;',
    '}',
    '',
    '// ASYNC spawn + signal forwarding (not spawnSync) — field incident',
    '// 2026-09-26: a watcher spawned via a spawnSync-blocked launcher outlived',
    '// the launcher when the launcher itself was killed (SIGKILL cannot be',
    '// caught/forwarded either way, so the spawned target is ALSO expected to',
    '// self-detect its own orphaning — see devswarm-wake-watch.js\'s own',
    '// parentGone() check, which is the fix of record for that case). This',
    '// async form adds the belt-and-suspenders half: a GRACEFUL SIGTERM/SIGINT',
    '// to this launcher (not a SIGKILL) is now forwarded to the still-running',
    '// child instead of leaving it running while this wrapper exits.',
    'function main() {',
    '  const target = resolveTarget();',
    '  if (!target) {',
    '    process.stderr.write(',
    '      "anti-hall stable launcher: could not resolve an anti-hall install ' +
      '(checked installed_plugins.json, the marketplace clone, and the baked fallback)\\n");',
    '    process.exit(1);',
    '  }',
    meshRoute.toString(),
    '  const routed = meshRoute(process.argv.slice(2), SEGMENTS);',
    '  if (routed.done !== undefined) { process.exit(routed.done); return; }',
    '  const { spawn } = require("child_process");',
    '  let child;',
    '  try {',
    '    child = spawn(process.execPath, [target].concat(process.argv.slice(2)), { stdio: [routed.input === undefined ? "inherit" : "pipe", "inherit", "inherit"] });',
    '    if (routed.input !== undefined) child.stdin.end(routed.input);',
    '  } catch (e) {',
    '    process.stderr.write("anti-hall stable launcher: failed to run " + target + ": " + (e && e.message) + "\\n");',
    '    process.exit(1);',
    '    return;',
    '  }',
    '  child.on("error", (e) => {',
    '    process.stderr.write("anti-hall stable launcher: failed to run " + target + ": " + (e && e.message) + "\\n");',
    '    process.exit(1);',
    '  });',
    '  const forward = (sig) => { try { child.kill(sig); } catch (_) {} };',
    '  process.on("SIGTERM", () => forward("SIGTERM"));',
    '  process.on("SIGINT", () => forward("SIGINT"));',
    '  process.on("SIGHUP", () => forward("SIGHUP"));',
    '  child.on("exit", (code, signal) => {',
    '    if (signal) { process.exit(1); return; }',
    '    process.exit(code === null ? 0 : code);',
    '  });',
    '}',
    '',
    'main();',
    '',
  ].join('\n');
}

// writeIfDifferent(filePath, content) -> boolean written. Idempotent: reads
// existing content first, writes only when it actually differs (no mtime/
// perms churn across identical redeploys). Atomic tmp+rename; sets 0o755
// (executable) on write.
function writeIfDifferent(filePath, content) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing === content) return false;
  } catch (_) {
    // absent/unreadable -> write
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o755); } catch (_) { /* best-effort on fs without chmod (rare) */ }
    return true;
  } catch (_) {
    return false; // fail-open: caller falls back to the direct __dirname path
  }
}

// installLauncher(kind, fallbackAbsPath, home) -> the stable launcher's
// absolute path on successful install/refresh (already-current counts as
// success), or null on any failure — callers MUST fall back to
// `fallbackAbsPath` itself when null (fail-open; see header).
function installLauncher(kind, fallbackAbsPath, home) {
  const t = TARGETS[kind];
  if (!t) return null;
  try {
    const dest = launcherPath(kind, home);
    const source = buildLauncherSource(t.segments, fallbackAbsPath);
    writeIfDifferent(dest, source);
    // Verify the file actually exists & is readable post-write before
    // handing it back — never claim success on an unverified write.
    fs.accessSync(dest, fs.constants.R_OK);
    return dest;
  } catch (_) {
    return null;
  }
}

// preferStableLauncher(kind, rawPath, home) -> the version-independent
// stable launcher path (under the anti-hall bin dir) when devswarm.stableLauncher
// is on AND the launcher already EXISTS on disk (check-only, never installs),
// else `rawPath`. For read-path hooks that print a CLI path into model-visible
// text but must not write to the anti-hall home themselves: a version-pinned
// plugin-cache path goes stale after /reload-plugins or an update prunes that
// version dir. Fail-open to `rawPath`.
function preferStableLauncher(kind, rawPath, home) {
  try {
    if (require('./settings.js').enabled('devswarm', 'stableLauncher') === false) return rawPath;
    const p = launcherPath(kind, home);
    if (p && fs.statSync(p).isFile()) return p;
  } catch (_) { /* fall through */ }
  return rawPath;
}

// installLaunchers({ cliFallback, watcherFallback, home }) -> { cli, watcher }
// — each field is the stable launcher path on success, or the corresponding
// fallback path when install failed. A caller can always use the returned
// value directly with no further null-check (fail-open).
function installLaunchers(opts) {
  const o = opts || {};
  const home = o.home;
  const cli = installLauncher('devswarm', o.cliFallback, home) || o.cliFallback;
  const watcher = installLauncher('wakeWatch', o.watcherFallback, home) || o.watcherFallback;
  return { cli, watcher };
}

// anchoredAntiHallStableLauncher(scriptFile) -> RegExp for one of the two
// version-independent ~/.anti-hall/bin/ stable launchers (devswarm.js,
// wake-watch.js — see TARGETS above). Shared by hooks/git-guard.js and
// hooks/command-guard.js (was a byte-for-byte duplicate in each, since
// command-guard.js has no module.exports of its own — its main() runs
// unconditionally at require-time, so neither guard could `require()` the
// other; this file already sits below both and has none of that problem).
//
// A `node` invocation of the launcher must be exempted from the heavy-
// command gate with the SAME whole-invocation scope regardless of which
// guard checks it, but anchored to the user's home directory so a
// look-alike prefix is never exempt (`evil/.anti-hall/bin/...`,
// `/tmp/x/.anti-hall/bin/...`). Four home-anchor forms are accepted, since
// installLaunchers() bakes the OS-resolved absolute home path into directive
// text (an os.homedir call, resolved), while a human typing the command at a
// shell commonly uses `~` or `$HOME`:
//   - literal `~`
//   - `$HOME` / `${HOME}` (optionally wrapped in one pair of double quotes,
//     e.g. `"${HOME}"/.anti-hall/bin/devswarm.js`)
//   - the actual resolved absolute home directory: test-home-guard.js's
//     resolveHome() (the HOME-env-aware value this module's own binDir()
//     resolves to in production, and the exact string real directive text
//     embeds) plus os.userInfo().homedir() (the OS passwd-DB value, immune
//     to a HOME override) when it differs
// immediately followed by `/.anti-hall/bin/<scriptFile>` with NOTHING else
// between the home anchor and `.anti-hall` (so `~/evil/.anti-hall/bin/...`
// or `~x/.anti-hall/bin/...` do NOT match) — anchored at segment start
// (optional leading env assignments only), so a heavy command merely
// carrying the launcher path as trailing args is never exempted, and
// chaining (`node ~/.anti-hall/bin/devswarm.js x && npm test`) still blocks
// on the npm segment exactly as it does for the plugin-relative form.
function anchoredAntiHallStableLauncher(scriptFile) {
  const scriptSrc = scriptFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rawHomes = [];
  try {
    const homedir = require('../../companion/lib/test-home-guard.js').resolveHome();
    if (typeof homedir === 'string' && homedir) rawHomes.push(homedir);
  } catch (_) { /* fail-open: home-anchor alternation just skips this form */ }
  try {
    const passwdHome = os.userInfo().homedir;
    if (typeof passwdHome === 'string' && passwdHome && !rawHomes.includes(passwdHome)) {
      rawHomes.push(passwdHome);
    }
  } catch (_) { /* fail-open: home-anchor alternation just skips this form */ }
  const homeAbsSrcs = rawHomes.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const homeAlt = '(?:~|"?\\$\\{HOME\\}"?|\\$HOME'
    + (homeAbsSrcs.length ? '|' + homeAbsSrcs.join('|') : '') + ')';
  return new RegExp(
    '^\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*node\\s+' +
      homeAlt + '[\\\\/]\\.anti-hall[\\\\/]bin[\\\\/]' + scriptSrc + '(?=\\s|$)', // name must end exactly at the script file (not .js.evil / .jsx)
    'i'
  );
}

module.exports = {
  BIN_DIR_SEGMENTS,
  TARGETS,
  binDir,
  launcherPath,
  buildLauncherSource,
  writeIfDifferent,
  installLauncher,
  installLaunchers,
  preferStableLauncher,
  anchoredAntiHallStableLauncher,
};
