#!/usr/bin/env node
'use strict';
// anti-hall :: install-devswarm-ingest — installs the DevSwarm ingest daemon as a
// supervised background job. The daemon (devswarm-ingest.js) is the ONE native
// consumer that wraps `hivecontrol workspace monitor` and folds drained messages
// into the store; nothing auto-starts it, so this helper schedules it to run
// continuously (and re-exec on exit).
//
//   node install-devswarm-ingest.js              install (continuous daemon)
//   node install-devswarm-ingest.js --uninstall  remove
//   node install-devswarm-ingest.js --dry-run    print what it would do
//
// CONTINUOUS DAEMON (not a periodic sweep): unlike the supervisor, the ingest
// process's main() runs unbounded until killed. So the scheduler must RE-EXEC it
// on exit rather than run it on an interval:
//   macOS  -> LaunchAgent with KeepAlive (relaunch on exit), label
//             com.anti-hall.devswarm-ingest.
//   Linux  -> systemd --user .service, Type=simple, Restart=always; cron fallback
//             (every minute, restart-if-dead) when systemctl is absent.
//   Windows-> no pure-Node user-level long-running scheduler in built-ins
//             (no launchd/systemd/cron), documented no-op, exit 0. The daemon can
//             still be launched manually. (Note: unlike the supervisor's Windows
//             no-op, the reason here is NOT kill-safety — the ingest daemon never
//             kills anything — it is simply the absence of a built-in scheduler.)
//
// SCOPE = per-machine (per-home): the daemon's single-consumer lock lives at
// ~/.anti-hall/devswarm/locks/ingest.lock, keyed on $HOME, exactly matching the
// supervisor's per-machine scope. ONE unit per machine. A redundant install is
// SAFE — the daemon takes an O_EXCL lock and only one instance ever wins; extra
// launches refuse-and-exit (KeepAlive/cron then throttle-retries harmlessly).
//
// Idempotent refresh: reinstalling rewrites the unit and relaunches so the running
// daemon picks up this build's code (launchctl unload+load on macOS / systemd
// daemon-reload + restart on Linux).
//
// Distinct label + log from the supervisor. Agnostic: no hardcoded paths/users
// (os.homedir(), process.execPath, __dirname). Fail-open: an install failure is
// reported (exit 1) but never corrupts state; callers treat it as non-fatal.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'com.anti-hall.devswarm-ingest';
const UNIT = 'anti-hall-devswarm-ingest';
const SCRIPT = path.join(__dirname, 'devswarm-ingest.js');
const EXEC = process.execPath;
const HOME = os.homedir();
const LOG = path.join(HOME, '.anti-hall', 'devswarm-ingest.log');
const RESTART_SEC = 5; // gap before systemd relaunches the daemon after it exits

const args = process.argv.slice(2);
const UNINSTALL = args.includes('--uninstall');
const DRYRUN = args.includes('--dry-run');

function say(msg) { process.stdout.write(msg + '\n'); }

let _tmpCounter = 0;
// Atomic unit write: NEVER truncate a live plist/service in place. Write the new
// content to a unique same-directory temp file, then rename(2) over the target —
// atomic on POSIX, so an ENOSPC/interruption can never leave a partial/corrupt
// unit. On any error the temp file is unlinked and the original is left intact.
function planWrite(file, contents) {
  if (DRYRUN) { say(`[dry-run] would write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${_tmpCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  say(`wrote ${file}`);
}
function planRm(file) {
  if (DRYRUN) { say(`[dry-run] would remove ${file}`); return; }
  try { fs.unlinkSync(file); say(`removed ${file}`); } catch (_e) { say(`(not present) ${file}`); }
}
function planRun(cmd, argv, opts) {
  if (DRYRUN) { say(`[dry-run] would run: ${cmd} ${argv.join(' ')}`); return { status: 0, dry: true }; }
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...(opts || {}) });
  if (r.error) say(`(warn) ${cmd} failed: ${r.error.message}`);
  else say(`ran: ${cmd} ${argv.join(' ')} (exit ${r.status})`);
  return r;
}

// XML-escape for plist <string> bodies. Order matters: & first, then < > " '.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// POSIX shell single-quote (for the cron/shell line): wrap in '...' and rewrite
// each embedded ' as '\'' — everything else inside single quotes is literal, so a
// path with spaces/&/</>/;/#/$/backticks/quotes can NEVER break out of the token.
function shSingleQuote(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

// systemd Exec quoting (for ExecStart): systemd does NOT run a shell for Exec, but
// it DOES do its own tokenizing plus $VAR / ${VAR} expansion. Double-quote and
// escape \  "  and $ per systemd.service(5) ($$ = a literal $), so a path with
// quotes/backslashes/dollars cannot break the token or trigger variable expansion.
function sdQuote(s) {
  return `"` + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '$$$$') + `"`;
}

// Belt-and-suspenders on top of per-target escaping: refuse to emit a unit for a
// resolved node/script path that carries control characters or quote characters.
// Returns false for such a path so the installer can fail-open (log + skip).
function pathIsEmittable(p) {
  return !/[\u0000-\u001f\u007f"']/.test(String(p));
}

// Resolve the git worktree the daemon must be launched FROM. `hivecontrol
// workspace <cmd>` resolves its workspace by walking up from the process's cwd to
// an enclosing git worktree (NOT from DEVSWARM_* env). launchd/systemd/cron default
// a unit's cwd to $HOME, which is not a git repo — so a daemon with no baked cwd can
// never resolve a workspace and drains nothing. We resolve the install-time worktree
// here and bake it into the unit's working directory. Returns the absolute toplevel
// path, or null when `cwd` is not inside a git worktree (installer then fails open).
function resolveWorktree(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    const top = String(r.stdout || '').trim();
    return top || null;
  } catch (_) {
    return null;
  }
}

// ----- macOS -----
function macPlistPath() { return path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`); }

// KeepAlive (not StartInterval): the ingest daemon runs continuously, so launchd
// must relaunch it whenever it exits — the "re-exec on exit" contract the daemon
// expects. RunAtLoad starts it at load/login.
function buildPlist({ label = LABEL, exec = EXEC, script = SCRIPT, log = LOG, workdir } = {}) {
  // WorkingDirectory: launchd otherwise defaults the daemon's cwd to $HOME (not a
  // git repo) and `hivecontrol workspace monitor` fails "Not in a git repository",
  // draining nothing. Baking the install-time worktree lets the daemon resolve it.
  const workdirKey = workdir
    ? `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(workdir)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exec)}</string>
    <string>${xmlEscape(script)}</string>
  </array>
${workdirKey}  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function macInstall(workdir) {
  const plist = macPlistPath();
  planWrite(plist, buildPlist({ workdir }));
  planRun('launchctl', ['unload', plist]); // ignore err
  planRun('launchctl', ['load', plist]);
  say(`installed LaunchAgent ${LABEL} (continuous, KeepAlive). Logs: ${LOG}`);
}
function macUninstall() {
  const plist = macPlistPath();
  planRun('launchctl', ['unload', plist]); // ignore err
  planRm(plist);
  say(`uninstalled LaunchAgent ${LABEL}`);
}

// ----- Linux -----
function unitDir() { return path.join(HOME, '.config', 'systemd', 'user'); }

// Type=simple + Restart=always: a long-running daemon that systemd relaunches on
// exit (the daemon's re-exec-on-exit contract). No .timer — this is a continuous
// service, not a periodic sweep.
function buildService({ exec = EXEC, script = SCRIPT, restartSec = RESTART_SEC, workdir } = {}) {
  // WorkingDirectory: systemd otherwise defaults the daemon's cwd to $HOME (not a
  // git repo), so `hivecontrol workspace monitor` can never resolve a workspace.
  // systemd-escaped like ExecStart (systemd tokenizes + does $VAR expansion).
  const workdirLine = workdir ? `WorkingDirectory=${sdQuote(workdir)}\n` : '';
  return `[Unit]
Description=anti-hall DevSwarm ingest daemon (native monitor -> store)

[Service]
Type=simple
${workdirLine}ExecStart=${sdQuote(exec)} ${sdQuote(script)}
Restart=always
RestartSec=${restartSec}

[Install]
WantedBy=default.target
`;
}
function hasSystemctl() {
  const r = spawnSync('systemctl', ['--user', '--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
// cron fallback: every minute, restart-if-dead. A live daemon holds the ingest
// lock, so a duplicate launch refuses-and-exits immediately (single-consumer);
// when the daemon is dead, the next tick takes over. Each path is POSIX
// single-quoted so no path can inject shell (P0-2).
function buildCronLine({ exec = EXEC, script = SCRIPT, workdir } = {}) {
  // cd into the install-time worktree first: cron runs from $HOME (not a git repo),
  // so without this the daemon can never resolve a workspace. The worktree path is
  // POSIX single-quoted like exec/script (no injection hole reintroduced).
  const cd = workdir ? `cd ${shSingleQuote(workdir)} && ` : '';
  return `* * * * * ${cd}${shSingleQuote(exec)} ${shSingleQuote(script)} >/dev/null 2>&1`;
}

// The managed cron marker comment. It is BOTH the idempotence key (a second install
// finds it and leaves the crontab untouched) AND the real "scheduled" signal that
// capability-scan reads on Linux — a bare .service file is NOT proof of scheduling
// (P1-2). Equal to `# <UNIT>` so capability-scan can derive it from the installer.
const CRON_MARKER = `# ${UNIT}`;

// buildCronEntry -> the managed 2-line block written to the crontab: the marker
// comment followed by the (escaped) restart-if-dead line.
function buildCronEntry({ exec = EXEC, script = SCRIPT, workdir } = {}) {
  return `${CRON_MARKER}\n${buildCronLine({ exec, script, workdir })}`;
}

// mergeCrontab(current, entry, marker) -> { next, changed }. Idempotent: if the
// managed marker line is already present, the crontab is returned unchanged;
// otherwise the managed entry is appended, preserving all existing entries.
function mergeCrontab(current, entry, marker) {
  const cur = typeof current === 'string' ? current : '';
  if (cur.split('\n').some((l) => l.trim() === marker)) return { next: cur, changed: false };
  const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
  return { next: cur + sep + entry + '\n', changed: true };
}

// removeCronEntry(current, marker) -> { next, changed }. Strips the managed marker
// line AND the command line immediately after it (the pair this installer wrote).
function removeCronEntry(current, marker) {
  const cur = typeof current === 'string' ? current : '';
  const lines = cur.split('\n');
  const out = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === marker) {
      changed = true;
      if (i + 1 < lines.length) i++; // also drop the command line following the marker
      continue;
    }
    out.push(lines[i]);
  }
  return { next: out.join('\n'), changed };
}

// readCrontab() -> current crontab text ('' if none/unreadable). Fail-open.
function readCrontab() {
  try {
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (!r.error && typeof r.stdout === 'string') return r.stdout;
  } catch (_) { /* no crontab / not installed -> empty */ }
  return '';
}

// installCron(): idempotently add the managed cron fallback entry to the user's
// crontab so the ingest daemon is ACTUALLY scheduled when systemctl is absent
// (previously the installer only PRINTED the line and installed no scheduler —
// yet capability-scan reported active; P1-2).
function installCron(workdir) {
  const { next, changed } = mergeCrontab(readCrontab(), buildCronEntry({ workdir }), CRON_MARKER);
  if (!changed) { say(`cron entry already present (marker ${CRON_MARKER}); crontab left as-is`); return; }
  const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    say('(warn) could not install cron entry via `crontab -`; add it manually (crontab -e):');
    say(`  ${CRON_MARKER}`);
    say(`  ${buildCronLine({ workdir })}`);
    return;
  }
  say(`installed cron fallback (managed marker ${CRON_MARKER}, every minute restart-if-dead). Logs: ${LOG}`);
}

// uninstallCron(): remove the managed cron fallback entry (marker + its line).
function uninstallCron() {
  const { next, changed } = removeCronEntry(readCrontab(), CRON_MARKER);
  if (!changed) return;
  const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (!r.error && r.status === 0) say(`removed cron fallback (managed marker ${CRON_MARKER})`);
}

function linuxInstall(workdir) {
  const dir = unitDir();
  planWrite(path.join(dir, `${UNIT}.service`), buildService({ workdir }));
  if (DRYRUN) {
    say(`[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.service && systemctl --user restart ${UNIT}.service`);
    say(`[dry-run] if systemctl absent, would install this managed cron fallback (marker ${CRON_MARKER}; every minute, restart-if-dead; the daemon's single-consumer lock makes redundant launches a no-op):`);
    say(`  ${CRON_MARKER}`);
    say(`  ${buildCronLine({ workdir })}`);
    return;
  }
  if (!hasSystemctl()) {
    say('systemctl not available; installing a managed cron fallback (every minute, restart-if-dead).');
    installCron(workdir);
    return;
  }
  planRun('systemctl', ['--user', 'daemon-reload']);
  planRun('systemctl', ['--user', 'enable', '--now', `${UNIT}.service`]);
  planRun('systemctl', ['--user', 'restart', `${UNIT}.service`]); // refresh a running daemon to this build's code
  say(`installed systemd --user service ${UNIT}.service (continuous, Restart=always). Logs: ${LOG}`);
}
function linuxUninstall() {
  const dir = unitDir();
  if (!DRYRUN && !hasSystemctl()) {
    say('systemctl not available; removing the managed cron fallback if present.');
    uninstallCron();
  } else {
    planRun('systemctl', ['--user', 'disable', '--now', `${UNIT}.service`]);
  }
  planRm(path.join(dir, `${UNIT}.service`));
  if (!DRYRUN && hasSystemctl()) planRun('systemctl', ['--user', 'daemon-reload']);
  say(`uninstalled ${UNIT}`);
}

// ----- Windows -----
function windowsNoop() {
  say(
    'anti-hall devswarm-ingest: Windows has no pure-Node user-level long-running\n' +
      'scheduler in built-ins (no launchd/systemd/cron), so no background unit is\n' +
      'installed (documented no-op). The ingest daemon does NOT kill anything, so\n' +
      'this is not the supervisor\'s kill-safety limitation — it is simply the\n' +
      'absence of a built-in scheduler. Run node companion/devswarm-ingest.js\n' +
      'manually if you need ingest on Windows. Exit 0.'
  );
  process.exit(0);
}

function main() {
  try {
    if (process.platform === 'win32') return windowsNoop();
    if (!fs.existsSync(SCRIPT)) { say(`error: ingest daemon script not found at ${SCRIPT}`); process.exit(1); return; }
    // Resolve the worktree the daemon must run FROM (see resolveWorktree). Only for
    // install — uninstall must still tear the unit down regardless of cwd. If cwd is
    // not inside a git worktree, do NOT install a non-draining daemon: fail open —
    // log + skip, exit 0 (non-fatal). Better no daemon than one that drains nothing.
    let workdir = null;
    if (!UNINSTALL) {
      workdir = resolveWorktree(process.cwd());
      if (!workdir) {
        say('ingest daemon not installed: no git worktree resolved from cwd; the daemon must run from a workspace worktree to drain its queue. Skipping install (no-op, exit 0).');
        process.exit(0);
        return;
      }
    }
    // Belt-and-suspenders (defense in depth on top of per-target escaping): refuse
    // to emit a unit/plist/cron entry for a node/script/worktree path carrying
    // control chars or quote characters. Fail-open — log + skip install, exit 0
    // (non-fatal), so a hostile path never yields an unsafe unit and never aborts hard.
    if (!UNINSTALL && (!pathIsEmittable(EXEC) || !pathIsEmittable(SCRIPT) || !pathIsEmittable(workdir))) {
      say('error: node/script/worktree path contains control or quote characters; refusing to emit an unsafe unit. Skipping install (no-op, exit 0).');
      process.exit(0);
      return;
    }
    if (process.platform === 'darwin') { if (UNINSTALL) macUninstall(); else macInstall(workdir); }
    else { if (UNINSTALL) linuxUninstall(); else linuxInstall(workdir); }
    process.exit(0);
  } catch (e) {
    say(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  LABEL, UNIT, SCRIPT, RESTART_SEC, CRON_MARKER,
  xmlEscape, shSingleQuote, sdQuote, pathIsEmittable, resolveWorktree,
  buildPlist, buildService, buildCronLine, buildCronEntry, mergeCrontab, removeCronEntry,
};
