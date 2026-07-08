#!/usr/bin/env node
'use strict';
// anti-hall :: capability-scan — read-only gap report for the update flow.
//
// Answers "what's missing on THIS machine?": for each opt-in capability, is it
// SHIPPED in this plugin build, is it ACTIVE (installed/scheduled) here, and
// if not, exactly HOW to enable it.
//
//   node capability-scan.js            human report
//   node capability-scan.js --json     machine-readable report only
//
// Read-only: never installs, writes, or deletes anything. Fail-open: any probe
// error is reported as 'unknown', never thrown. Pure Node >= 18, cross-platform.
//
// Dynamic by construction:
//  - Companions are DISCOVERED from companion/install-*.js on disk (not a
//    hardcoded list), so a future companion is picked up automatically. Each
//    installer's own LABEL/UNIT constants are read via require() — the
//    naming scheme is never re-derived or guessed.
//  - Pending state migrations are DETECTED via migrate-state.js's own dryRun
//    mode (added alongside this file) — never reimplemented here.

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { migrateLegacyState, migrateGsdPlanning } = require('./migrate-state.js');

const ROOT = path.resolve(__dirname, '..'); // plugin root (plugins/anti-hall)

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

// discoverCompanions(root) -> [{ name, file, installScript }]
// Reads companion/install-*.js off disk. No hardcoded companion list — a new
// install-foo.js dropped in that directory is picked up on the next scan.
function discoverCompanions(root) {
  const dir = path.join(root, 'companion');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of entries) {
    if (!/^install-.+\.js$/.test(f)) continue;
    out.push({
      name: f.replace(/^install-/, '').replace(/\.js$/, ''),
      file: f,
      installScript: path.join(dir, f),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// companionActive({ installScript, home, platform }) -> true | false | 'unknown'
// Checks the REAL artifact each installer writes — never re-derives the
// naming scheme; LABEL/UNIT come from require()-ing the installer itself.
function companionActive({ installScript, home, platform }) {
  let mod;
  try {
    mod = require(installScript);
  } catch (_) {
    return 'unknown';
  }
  const label = mod && mod.LABEL;
  const unit = mod && mod.UNIT;
  const script = mod && mod.SCRIPT; // optional — not every installer exports it
  const plat = platform || process.platform;

  try {
    if (plat === 'darwin') {
      if (!label) return 'unknown';
      return safeExists(path.join(home, 'Library', 'LaunchAgents', `${label}.plist`));
    }
    if (plat === 'win32') {
      // Detection-only: every companion documents Windows as unsupported for
      // scheduling (no parent-death reparenting / no cwd introspection), so
      // there is no scheduler artifact to check here.
      return 'unknown';
    }
    // Linux: the installer writes the .service/.timer pair to this path
    // whether or not systemctl actually enabled it (cron-fallback case still
    // writes the unit files) — so the timer file's presence is the artifact.
    if (!unit) return 'unknown';
    if (safeExists(path.join(home, '.config', 'systemd', 'user', `${unit}.timer`))) return true;
    // Best-effort cron fallback check (only when the installer exports SCRIPT).
    if (script) {
      try {
        const r = cp.spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 5000 });
        if (!r.error && typeof r.stdout === 'string' && r.stdout.includes(path.basename(script))) {
          return true;
        }
      } catch (_) {
        // best-effort only — fall through to false
      }
    }
    return false;
  } catch (_) {
    return 'unknown';
  }
}

const STATUSLINE_HOW = 'node "${CLAUDE_PLUGIN_ROOT}/statusline/install-statusline.js" --user';

// statuslineCapability({ cwd, home }) -> capability entry.
// Mirrors doctor.js's scope-precedence read (project-local > project > user);
// the first scope with a statusLine.command wins (that is the EFFECTIVE one).
function statuslineCapability({ cwd, home }) {
  function readJSON(p) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      return null;
    }
  }
  const scopes = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.json'),
  ];
  try {
    let active = false;
    for (const p of scopes) {
      const s = readJSON(p);
      const cmd = s && s.statusLine && s.statusLine.command;
      if (cmd) {
        active = /statusline\.js/.test(cmd);
        break;
      }
    }
    return { name: 'statusline', available: true, active, how: STATUSLINE_HOW };
  } catch (_) {
    return { name: 'statusline', available: true, active: 'unknown', how: STATUSLINE_HOW };
  }
}

const MIGRATIONS_HOW = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-state.js"';

// migrationsCapability({ dir }) -> capability entry.
// Detection ONLY — delegates to migrate-state.js's own dryRun mode rather than
// reimplementing what "pending" means. Never writes or deletes.
function migrationsCapability({ dir }) {
  let legacyPending = null;
  let gsdPending = null;
  try {
    legacyPending = migrateLegacyState({ dir, dryRun: true }).some((r) => r.action === 'pending');
  } catch (_) {
    legacyPending = null;
  }
  try {
    gsdPending = migrateGsdPlanning({ dir, dryRun: true }).some((r) => r.action === 'pending');
  } catch (_) {
    gsdPending = null;
  }

  const unknown = legacyPending === null && gsdPending === null;
  const active = unknown ? 'unknown' : !(legacyPending || gsdPending);
  return { name: 'state-migrations', available: true, active, how: MIGRATIONS_HOW };
}

/**
 * scanCapabilities({ home, cwd, root, platform }) -> { capabilities: Array<{name, available, active, how}> }
 *
 * Read-only. Fail-open: a probe error never throws — the affected capability
 * reports active: 'unknown' instead.
 */
function scanCapabilities(opts) {
  const home = (opts && opts.home) || os.homedir();
  const cwd = (opts && opts.cwd) || process.cwd();
  const root = (opts && opts.root) || ROOT;
  const platform = (opts && opts.platform) || process.platform;

  const capabilities = [];

  let companions = [];
  try {
    companions = discoverCompanions(root);
  } catch (_) {
    companions = [];
  }
  for (const c of companions) {
    let active;
    try {
      active = companionActive({ installScript: c.installScript, home, platform });
    } catch (_) {
      active = 'unknown';
    }
    capabilities.push({
      name: c.name,
      available: true,
      active,
      how: `node "\${CLAUDE_PLUGIN_ROOT}/companion/${c.file}"`,
    });
  }

  try {
    capabilities.push(statuslineCapability({ cwd, home }));
  } catch (_) {
    capabilities.push({ name: 'statusline', available: true, active: 'unknown', how: STATUSLINE_HOW });
  }

  try {
    capabilities.push(migrationsCapability({ dir: cwd }));
  } catch (_) {
    capabilities.push({ name: 'state-migrations', available: true, active: 'unknown', how: MIGRATIONS_HOW });
  }

  return { capabilities };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const report = scanCapabilities({});
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    process.stdout.write(JSON.stringify(report) + '\n');
    for (const c of report.capabilities) {
      const state = c.active === true ? 'active' : c.active === false ? 'available, not active' : 'unknown';
      process.stdout.write(`${c.name}: ${state}${c.active === false ? `  -> ${c.how}` : ''}\n`);
    }
  }
}

module.exports = {
  scanCapabilities,
  discoverCompanions,
  companionActive,
  statuslineCapability,
  migrationsCapability,
};
