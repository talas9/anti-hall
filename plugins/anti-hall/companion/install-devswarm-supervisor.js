#!/usr/bin/env node
'use strict';
// anti-hall :: install-devswarm-supervisor — installs the OPT-IN DevSwarm liveness
// supervisor as a background job. Workaround for claude-code#39755.
//
//   node install-devswarm-supervisor.js              install (90s sweep)
//   node install-devswarm-supervisor.js --uninstall  remove
//   node install-devswarm-supervisor.js --dry-run    print what it would do
//
//   ANTIHALL_DEVSWARM_INTERVAL=<sec>  override sweep interval (clamped 60..120)
//
// macOS  -> LaunchAgent (launchd), label com.anti-hall.devswarm-supervisor.
// Linux  -> systemd --user .service + .timer; cron fallback if systemctl absent.
// Windows-> unsupported for RECOVERY (documented no-op), exit 0. (A running
//           process's cwd is not obtainable in pure Node on Windows, so the cwd
//           confirm-gate that makes the kill safe cannot run.)
//
// Opt-in: a component that can KILL a process must never self-install — the user
// runs this explicitly. Agnostic: no hardcoded paths/users (os.homedir(),
// process.execPath, __dirname).

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'com.anti-hall.devswarm-supervisor';
const UNIT = 'anti-hall-devswarm-supervisor';
const SCRIPT = path.join(__dirname, 'devswarm-supervisor.js');
const EXEC = process.execPath;
const HOME = os.homedir();
const LOG = path.join(HOME, '.anti-hall', 'devswarm-supervisor.log');

const args = process.argv.slice(2);
const UNINSTALL = args.includes('--uninstall');
const DRYRUN = args.includes('--dry-run');

// clampInterval(v) -> seconds in [60, 120], default 90 for missing/garbage input.
function clampInterval(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 90;
  return Math.max(60, Math.min(120, n));
}
const INTERVAL = clampInterval(process.env.ANTIHALL_DEVSWARM_INTERVAL);

function say(msg) { process.stdout.write(msg + '\n'); }

function planWrite(file, contents) {
  if (DRYRUN) { say(`[dry-run] would write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
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

// ----- macOS -----
function macPlistPath() { return path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`); }

function buildPlist({ label = LABEL, exec = EXEC, script = SCRIPT, log = LOG, interval = INTERVAL } = {}) {
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
  <key>StartInterval</key>
  <integer>${clampInterval(interval)}</integer>
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

function macInstall() {
  const plist = macPlistPath();
  planWrite(plist, buildPlist());
  planRun('launchctl', ['unload', plist]); // ignore err
  planRun('launchctl', ['load', plist]);
  say(`installed LaunchAgent ${LABEL} (${INTERVAL}s interval). Logs: ${LOG}`);
}
function macUninstall() {
  const plist = macPlistPath();
  planRun('launchctl', ['unload', plist]); // ignore err
  planRm(plist);
  say(`uninstalled LaunchAgent ${LABEL}`);
}

// ----- Linux -----
function unitDir() { return path.join(HOME, '.config', 'systemd', 'user'); }

function buildService({ exec = EXEC, script = SCRIPT } = {}) {
  return `[Unit]
Description=anti-hall DevSwarm liveness supervisor (oneshot) [claude-code#39755 workaround]

[Service]
Type=oneshot
ExecStart="${exec}" "${script}"
`;
}
function buildTimer({ interval = INTERVAL } = {}) {
  const s = clampInterval(interval);
  return `[Unit]
Description=anti-hall DevSwarm liveness supervisor timer (${s}s)

[Timer]
OnBootSec=${s}
OnUnitActiveSec=${s}
Persistent=true

[Install]
WantedBy=timers.target
`;
}
function hasSystemctl() {
  const r = spawnSync('systemctl', ['--user', '--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
function buildCronLine({ exec = EXEC, script = SCRIPT } = {}) {
  return `* * * * * "${exec}" "${script}" >/dev/null 2>&1`;
}

function linuxInstall() {
  const dir = unitDir();
  planWrite(path.join(dir, `${UNIT}.service`), buildService());
  planWrite(path.join(dir, `${UNIT}.timer`), buildTimer());
  if (DRYRUN) {
    say(`[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.timer`);
    say(`[dry-run] if systemctl absent, cron fallback line (runs every minute; overlapping ticks are coalesced by the supervisor's single-flight sweep lock):`);
    say(`  ${buildCronLine()}`);
    return;
  }
  if (!hasSystemctl()) {
    say('systemctl not available. Add this cron line instead (crontab -e):');
    say(`  ${buildCronLine()}`);
    return;
  }
  planRun('systemctl', ['--user', 'daemon-reload']);
  planRun('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]);
  say(`installed systemd --user timer ${UNIT}.timer (${INTERVAL}s). Logs: ${LOG}`);
}
function linuxUninstall() {
  const dir = unitDir();
  if (!DRYRUN && !hasSystemctl()) {
    say('systemctl not available. If you used the cron fallback, remove this line (crontab -e):');
    say(`  ${buildCronLine()}`);
  } else {
    planRun('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]);
  }
  planRm(path.join(dir, `${UNIT}.timer`));
  planRm(path.join(dir, `${UNIT}.service`));
  if (!DRYRUN && hasSystemctl()) planRun('systemctl', ['--user', 'daemon-reload']);
  say(`uninstalled ${UNIT}`);
}

// ----- Windows -----
function windowsNoop() {
  say(
    'anti-hall devswarm-supervisor: Windows recovery is unsupported (documented no-op).\n' +
      "Reason: a running process's cwd is not obtainable in pure Node on Windows (no\n" +
      '/proc, no lsof equivalent), so the cwd confirm-gate that makes the kill safe\n' +
      'cannot run. Combined with PID recycling, external process targeting is unsafe.\n' +
      'Detection-only use is still possible from a session; no scheduler installed. Exit 0.'
  );
  process.exit(0);
}

function main() {
  try {
    if (process.platform === 'win32') return windowsNoop();
    if (!fs.existsSync(SCRIPT)) { say(`error: supervisor script not found at ${SCRIPT}`); process.exit(1); return; }
    if (process.platform === 'darwin') { if (UNINSTALL) macUninstall(); else macInstall(); }
    else { if (UNINSTALL) linuxUninstall(); else linuxInstall(); }
    process.exit(0);
  } catch (e) {
    say(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  LABEL, UNIT, clampInterval, xmlEscape, buildPlist, buildService, buildTimer, buildCronLine,
};
