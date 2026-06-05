#!/usr/bin/env node
'use strict';
// anti-hall :: install-reaper — installs the OPT-IN mcp-reaper as a 60s background job.
//
//   node install-reaper.js            install
//   node install-reaper.js --uninstall  remove
//   node install-reaper.js --dry-run    print what it would do, change nothing
//
// macOS  -> LaunchAgent (launchd), label com.anti-hall.mcp-reaper, StartInterval 60.
// Linux  -> systemd --user .service + .timer (60s); cron fallback if systemctl absent.
// Windows-> unsupported (prints why), exit 0.
//
// Agnostic: no hardcoded paths/users. Uses os.homedir(), process.execPath, __dirname.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'com.anti-hall.mcp-reaper';
const UNIT = 'anti-hall-mcp-reaper';
const SCRIPT = path.join(__dirname, 'mcp-reaper.js');
const EXEC = process.execPath;
const HOME = os.homedir();
const LOG = path.join(HOME, '.anti-hall', 'mcp-reaper.log');

const args = process.argv.slice(2);
const UNINSTALL = args.includes('--uninstall');
const DRYRUN = args.includes('--dry-run');

function say(msg) {
  process.stdout.write(msg + '\n');
}

function planWrite(file, contents) {
  if (DRYRUN) {
    say(`[dry-run] would write ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  say(`wrote ${file}`);
}

function planRm(file) {
  if (DRYRUN) {
    say(`[dry-run] would remove ${file}`);
    return;
  }
  try {
    fs.unlinkSync(file);
    say(`removed ${file}`);
  } catch (_e) {
    say(`(not present) ${file}`);
  }
}

function planRun(cmd, argv, opts) {
  if (DRYRUN) {
    say(`[dry-run] would run: ${cmd} ${argv.join(' ')}`);
    return { status: 0, dry: true };
  }
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...(opts || {}) });
  if (r.error) say(`(warn) ${cmd} failed: ${r.error.message}`);
  else say(`ran: ${cmd} ${argv.join(' ')} (exit ${r.status})`);
  return r;
}

// XML-escape a string for safe embedding inside a plist <string>...</string>.
// Order matters: & first, then < > " '.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ----- macOS -----
function macPlistPath() {
  return path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

// Pure builder — parameterized so it's testable with paths containing spaces / & / etc.
function buildPlist({ label = LABEL, exec = EXEC, script = SCRIPT, log = LOG } = {}) {
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
  <integer>60</integer>
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

function macPlistContents() {
  return buildPlist();
}

function macInstall() {
  const plist = macPlistPath();
  planWrite(plist, macPlistContents());
  planRun('launchctl', ['unload', plist]); // ignore err
  planRun('launchctl', ['load', plist]);
  say(`installed LaunchAgent ${LABEL} (60s interval). Logs: ${LOG}`);
}

function macUninstall() {
  const plist = macPlistPath();
  planRun('launchctl', ['unload', plist]); // ignore err
  planRm(plist);
  say(`uninstalled LaunchAgent ${LABEL}`);
}

// ----- Linux -----
function unitDir() {
  return path.join(HOME, '.config', 'systemd', 'user');
}

// Pure builder — double-quote each path so a home dir with a space works.
function buildService({ exec = EXEC, script = SCRIPT } = {}) {
  return `[Unit]
Description=anti-hall MCP orphan reaper (oneshot)

[Service]
Type=oneshot
ExecStart="${exec}" "${script}"
`;
}

function serviceContents() {
  return buildService();
}

function timerContents() {
  return `[Unit]
Description=anti-hall MCP orphan reaper timer (60s)

[Timer]
OnBootSec=60
OnUnitActiveSec=60
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function hasSystemctl() {
  const r = spawnSync('systemctl', ['--user', '--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

// Pure builder — double-quote each path so a home dir with a space works.
function buildCronLine({ exec = EXEC, script = SCRIPT } = {}) {
  return `* * * * * "${exec}" "${script}" >/dev/null 2>&1`;
}

function cronLine() {
  return buildCronLine();
}

function linuxInstall() {
  const dir = unitDir();
  planWrite(path.join(dir, `${UNIT}.service`), serviceContents());
  planWrite(path.join(dir, `${UNIT}.timer`), timerContents());

  if (DRYRUN) {
    say(`[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.timer`);
    say(`[dry-run] if systemctl absent, cron fallback line:`);
    say(`  ${cronLine()}`);
    return;
  }

  if (!hasSystemctl()) {
    say('systemctl not available. Add this cron line instead (crontab -e):');
    say(`  ${cronLine()}`);
    return;
  }
  planRun('systemctl', ['--user', 'daemon-reload']);
  planRun('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]);
  say(`installed systemd --user timer ${UNIT}.timer (60s). Logs: ${LOG}`);
}

function linuxUninstall() {
  const dir = unitDir();
  if (!DRYRUN && !hasSystemctl()) {
    say('systemctl not available. If you used the cron fallback, remove this line (crontab -e):');
    say(`  ${cronLine()}`);
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
    'anti-hall mcp-reaper: Windows is unsupported.\n' +
      'Reason: Windows has no parent-death reparenting (an exited spawner does NOT\n' +
      'reparent its MCP children to a known reaper/init), and PID recycling means a\n' +
      'dead PID can be reused by an unrelated process. External orphan detection is\n' +
      'therefore unsafe — it could kill the wrong process. The correct fix on Windows\n' +
      'is for the SPAWNER to assign MCP children to a Job Object (kill-on-close), which\n' +
      'a companion process cannot do. No scheduler installed. Exit 0.'
  );
  process.exit(0);
}

function main() {
  try {
    if (process.platform === 'win32') return windowsNoop();

    if (!fs.existsSync(SCRIPT)) {
      say(`error: reaper script not found at ${SCRIPT}`);
      process.exit(1);
      return;
    }

    if (process.platform === 'darwin') {
      if (UNINSTALL) macUninstall();
      else macInstall();
    } else {
      if (UNINSTALL) linuxUninstall();
      else linuxInstall();
    }
    process.exit(0);
  } catch (e) {
    say(`error: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  LABEL,
  UNIT,
  SCRIPT,
  macPlistContents,
  serviceContents,
  timerContents,
  cronLine,
  xmlEscape,
  buildPlist,
  buildService,
  buildCronLine,
};
