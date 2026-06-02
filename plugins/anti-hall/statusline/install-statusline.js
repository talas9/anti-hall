#!/usr/bin/env node
// install-statusline.js — Idempotent, precedence-aware installer for the anti-hall statusline.
//
// Wraps your EXISTING statusline as line 1 and adds the anti-hall phase bar
// as line 2.
//
// ── PRECEDENCE MODEL (Claude Code merges in this order, LAST WINS) ──────────
//
//   1. ~/.claude/settings.json          (user — global, lowest precedence)
//   2. ./.claude/settings.json          (project — version-controlled)
//   3. ./.claude/settings.local.json    (project-local — gitignored, HIGHEST)
//
// WHY THIS MATTERS FOR PER-PROJECT INSTALLS:
//   If a project's settings.json (often committed to git) defines a statusLine,
//   it SHADOWS any user-global install.  So to reliably show anti-hall inside a
//   specific project, you must install into settings.local.json (highest
//   precedence AND gitignored, so machine-absolute paths stay off-repo).
//
//   --project  →  ./.claude/settings.local.json   (highest precedence, gitignored)
//   --user     →  ~/.claude/settings.json          (global default)
//
// STABLE PATH RESOLUTION:
//   Prefers the marketplace-installed path:
//     ~/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/statusline/statusline.js
//   Falls back to __dirname (dev / repo run) if the stable path doesn't exist.
//   NEVER bakes a versioned cache path (.../cache/anti-hall/anti-hall/<version>/...)
//   because that path breaks silently on every plugin update.
//
// Usage:
//   node statusline/install-statusline.js [--user|--project]
//
// --user    (default) writes ~/.claude/settings.json  (every repo)
// --project           writes ./.claude/settings.local.json  (this repo only, gitignored)
//
// Idempotent: re-running detects already-installed and does nothing destructive.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Stable dispatcher path resolution
// ---------------------------------------------------------------------------
// Prefer the marketplace install location (stable across plugin version bumps).
// Fall back to __dirname for dev / direct repo runs.

const STABLE_DISPATCHER = path.join(
  os.homedir(),
  '.claude', 'plugins', 'marketplaces', 'anti-hall',
  'plugins', 'anti-hall', 'statusline', 'statusline.js'
);

const SCRIPT_DIR   = __dirname;
const DISPATCHER   = fs.existsSync(STABLE_DISPATCHER) ? STABLE_DISPATCHER
                                                       : path.join(SCRIPT_DIR, 'statusline.js');
const BASE_CFG_DIR = path.join(os.homedir(), '.anti-hall');
const BASE_CFG     = path.join(BASE_CFG_DIR, 'base-statusline.json');

// Verify the dispatcher exists (sanity check).
if (!fs.existsSync(DISPATCHER)) {
  console.error('ERROR: statusline.js not found at: ' + DISPATCHER);
  console.error('The installer must live in the same directory as statusline.js.');
  process.exit(1);
}

console.log('Dispatcher: ' + DISPATCHER +
  (DISPATCHER === STABLE_DISPATCHER ? '  (stable marketplace path)' : '  (dev/__dirname fallback)'));

// ---------------------------------------------------------------------------
// Scope / settings file selection
// ---------------------------------------------------------------------------

const args  = process.argv.slice(2);
const scope = args.includes('--project') ? 'project' : 'user';

let SETTINGS_PATH;
if (scope === 'user') {
  // Global: ~/.claude/settings.json
  SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
} else {
  // Per-project: .claude/settings.local.json  (highest precedence, gitignored)
  // Using settings.local.json (NOT settings.json) so anti-hall takes precedence
  // over any statusLine defined in the committed project settings.json.
  SETTINGS_PATH = path.join(process.cwd(), '.claude', 'settings.local.json');
}

const BACKUP_PATH = SETTINGS_PATH + '.bak-antihall';

console.log('Scope:    ' + scope);
console.log('Settings: ' + SETTINGS_PATH);
console.log('');

// ---------------------------------------------------------------------------
// PRECEDENCE CHECK: inspect statusLine across all scopes before writing
// ---------------------------------------------------------------------------

function readStatusLineFrom(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data.statusLine;
  } catch (_) {
    return undefined;
  }
}

const userSettingsPath    = path.join(os.homedir(), '.claude', 'settings.json');
const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
const localSettingsPath   = path.join(process.cwd(), '.claude', 'settings.local.json');

const slUser    = readStatusLineFrom(userSettingsPath);
const slProject = readStatusLineFrom(projectSettingsPath);
const slLocal   = readStatusLineFrom(localSettingsPath);

// Compute the effective statusLine (highest-precedence scope wins)
const effectiveSL = slLocal !== undefined ? slLocal
                  : slProject !== undefined ? slProject
                  : slUser;

const effectiveCmd = (effectiveSL && typeof effectiveSL.command === 'string')
  ? effectiveSL.command : null;

// Report any shadowing situations
if (scope === 'project') {
  if (slProject !== undefined) {
    const projCmd = (typeof slProject === 'object' && slProject !== null)
      ? slProject.command || JSON.stringify(slProject)
      : String(slProject);
    console.log('NOTE: .claude/settings.json (committed) defines a statusLine:');
    console.log('  ' + projCmd);
    console.log('  Installing into settings.local.json so anti-hall takes precedence (local > project).');
    console.log('');
  }
  if (slUser !== undefined && slProject === undefined && slLocal === undefined) {
    const userCmd = (typeof slUser === 'object' && slUser !== null)
      ? slUser.command || JSON.stringify(slUser)
      : String(slUser);
    console.log('NOTE: ~/.claude/settings.json (user/global) defines a statusLine:');
    console.log('  ' + userCmd);
    console.log('  Installing into settings.local.json will take precedence over it.');
    console.log('');
  }
}

// Already-installed check: is the effective statusLine already pointing at our dispatcher?
if (effectiveCmd && effectiveCmd.includes('statusline.js') &&
    (effectiveCmd.includes('/anti-hall/') || effectiveCmd.includes(SCRIPT_DIR))) {
  console.log('Already installed — the effective statusLine already points at anti-hall statusline.js.');
  console.log('  ' + effectiveCmd);
  // Check which file it came from
  if (slLocal !== undefined && slLocal.command && slLocal.command === effectiveCmd) {
    console.log('  Source: settings.local.json (project-local, highest precedence)');
  } else if (slProject !== undefined && slProject.command && slProject.command === effectiveCmd) {
    console.log('  Source: settings.json (project)');
  } else {
    console.log('  Source: ~/.claude/settings.json (user/global)');
  }
  console.log('No changes made.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Ensure settings file exists (create minimal one if absent)
// ---------------------------------------------------------------------------

if (!fs.existsSync(SETTINGS_PATH)) {
  if (scope === 'user') {
    console.error('ERROR: ' + SETTINGS_PATH + ' not found. Is Claude Code installed?');
    process.exit(1);
  }
  // project scope — create the directory + empty settings.local.json
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, '{}\n', 'utf8');
    console.log('Created: ' + SETTINGS_PATH);
  } catch (e) {
    console.error('ERROR: Could not create ' + SETTINGS_PATH + ': ' + e.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Read + parse settings (merge — never clobber other keys)
// ---------------------------------------------------------------------------

let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (e) {
  console.error('ERROR: Could not parse ' + SETTINGS_PATH + ': ' + e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Record existing statusLine as the base to wrap (if present and not ours)
// ---------------------------------------------------------------------------

const existing    = settings.statusLine;
const existingCmd = (existing && typeof existing.command === 'string') ? existing.command : null;

if (existingCmd && fs.existsSync(BASE_CFG)) {
  // base-statusline.json is GLOBAL (shared by every project whose statusLine points
  // at the dispatcher). NEVER clobber an existing one — doing so would change line 1
  // for OTHER projects that already rely on it. Leave it as-is.
  console.log('Existing base-statusline.json kept (global, shared) — not overwritten:');
  console.log('  ' + BASE_CFG);
  console.log('  Line 1 for repos without their own helper falls back to the rich renderer.');
  console.log('');
} else if (existingCmd) {
  // No global base yet — record this scope's existing statusLine as the line-1 base.
  try {
    fs.mkdirSync(BASE_CFG_DIR, { recursive: true });
    fs.writeFileSync(BASE_CFG, JSON.stringify({ command: existingCmd }, null, 2) + '\n', 'utf8');
    console.log('Saved existing statusLine as base (line 1 wrapper):');
    console.log('  ' + BASE_CFG);
    console.log('  command: ' + existingCmd);
    console.log('');
  } catch (e) {
    console.error('WARNING: Could not write ' + BASE_CFG + ': ' + e.message);
    console.error('The statusline will still work but your previous statusline will not be line 1.');
    console.log('');
  }
} else if (existing !== undefined) {
  console.log('Existing statusLine has no command string (type: ' +
    (typeof existing === 'object' ? JSON.stringify(existing) : existing) + ')');
  console.log('Nothing to wrap — line 1 will use own dispatch.');
  console.log('');
} else {
  console.log('No existing statusLine — line 1 will use own dispatch.');
  console.log('');
}

// ---------------------------------------------------------------------------
// GITIGNORE: ensure .claude/settings.local.json is gitignored
// ---------------------------------------------------------------------------

if (scope === 'project') {
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const localEntry    = '.claude/settings.local.json';

  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  }

  if (!gitignoreContent.split('\n').some(l => l.trim() === localEntry)) {
    try {
      const suffix = gitignoreContent.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitignorePath, suffix + localEntry + '\n', 'utf8');
      console.log('Updated .gitignore: added ' + localEntry);
    } catch (e) {
      console.error('WARNING: Could not update .gitignore: ' + e.message);
    }
  } else {
    console.log('.gitignore already ignores ' + localEntry);
  }

  // Warn if settings.local.json is git-tracked (would leak machine-absolute path)
  try {
    const { execFileSync } = require('child_process');
    const tracked = execFileSync(
      'git',
      ['ls-files', '--error-unmatch', '.claude/settings.local.json'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }
    ).trim();
    if (tracked) {
      console.log('');
      console.log('WARNING: .claude/settings.local.json is currently tracked by git.');
      console.log('  It contains a machine-absolute path and should NOT be committed.');
      console.log('  To untrack it:');
      console.log('    git rm --cached .claude/settings.local.json');
    }
  } catch (_) {
    // Not in a git repo or git not available — ignore silently
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Back up settings once (never overwrite existing backup)
// ---------------------------------------------------------------------------

if (!fs.existsSync(BACKUP_PATH)) {
  try {
    fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
    console.log('Backed up: ' + SETTINGS_PATH);
    console.log('       to: ' + BACKUP_PATH);
  } catch (e) {
    console.error('WARNING: Could not create backup: ' + e.message);
    console.error('Proceeding without backup.');
  }
} else {
  console.log('Backup already exists: ' + BACKUP_PATH + ' (not overwritten)');
}
console.log('');

// ---------------------------------------------------------------------------
// Show old value
// ---------------------------------------------------------------------------

if (existing !== undefined) {
  console.log('Old statusLine:');
  console.log(JSON.stringify(existing, null, 2));
} else {
  console.log('No existing statusLine.');
}
console.log('');

// ---------------------------------------------------------------------------
// Write new statusLine (merge into existing JSON — never clobber other keys)
// ---------------------------------------------------------------------------

const newCommand    = 'node "' + DISPATCHER + '"';
const newStatusLine = {
  type:            'command',
  command:         newCommand,
  padding:         0,
  refreshInterval: 1,
};

settings.statusLine = newStatusLine;
try {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error('ERROR: Could not write ' + SETTINGS_PATH + ': ' + e.message);
  console.error('Restore from backup:');
  console.error('  node "' + path.join(SCRIPT_DIR, 'uninstall-statusline.js') + '"');
  process.exit(1);
}

console.log('New statusLine:');
console.log(JSON.stringify(newStatusLine, null, 2));
console.log('');
console.log('Done. ' + SETTINGS_PATH + ' updated.');
console.log('');
console.log('IMPORTANT: Restart Claude Code (close and reopen) for the change to take effect.');
console.log('  statusLine is read only at startup — there is no hot-reload.');
console.log('');
if (scope === 'project') {
  console.log('Scope: project-local only (.claude/settings.local.json).');
  console.log('  This setting is gitignored and applies to this machine only.');
  console.log('  The phase bar (line 2) appears once an orchestration phase writes');
  console.log('  ~/.anti-hall/phase-state.json.');
} else {
  console.log('Scope: user/global (~/.claude/settings.json).');
  console.log('  The bar appears in every repo on this machine.');
  console.log('  The phase bar (line 2) appears once an orchestration phase writes');
  console.log('  ~/.anti-hall/phase-state.json.');
}
console.log('');
console.log('To uninstall:');
console.log('  node "' + path.join(SCRIPT_DIR, 'uninstall-statusline.js') + '"');
