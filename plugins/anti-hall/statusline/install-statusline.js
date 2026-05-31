#!/usr/bin/env node
// install-statusline.js — Idempotent installer for the anti-hall statusline.
//
// Wraps your EXISTING statusline as line 1 and adds the anti-hall phase bar
// as line 2.  Resolves the installed plugin path via __dirname so it works
// regardless of where Claude Code installed the plugin (user/project/cache scope).
//
// Scope precedence (Claude Code merges settings in this order, last wins):
//   1. ~/.claude/settings.json        (user — global default)
//   2. ./.claude/settings.json        (project — version-controlled)
//   3. ./.claude/settings.local.json  (project-local — gitignored, highest)
//
// This installer writes to user scope by default.  Use --project to write
// to the project-level settings.json instead.
//
// Usage:
//   node statusline/install-statusline.js [--user|--project]
//
// --user    (default) writes ~/.claude/settings.json
// --project           writes ./.claude/settings.json  (created if absent)
//
// Idempotent: re-running detects already-installed and does nothing destructive.
// Never double-wraps: if statusLine already points at this statusline.js, exits.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR   = __dirname;
const DISPATCHER   = path.join(SCRIPT_DIR, 'statusline.js');
const BASE_CFG_DIR = path.join(os.homedir(), '.anti-hall');
const BASE_CFG     = path.join(BASE_CFG_DIR, 'base-statusline.json');

// Verify the dispatcher exists (sanity check).
if (!fs.existsSync(DISPATCHER)) {
  console.error('ERROR: statusline.js not found at: ' + DISPATCHER);
  console.error('The installer must live in the same directory as statusline.js.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scope / settings file selection
// ---------------------------------------------------------------------------

const args  = process.argv.slice(2);
const scope = args.includes('--project') ? 'project' : 'user';

let SETTINGS_PATH;
if (scope === 'user') {
  SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
} else {
  SETTINGS_PATH = path.join(process.cwd(), '.claude', 'settings.json');
}

const BACKUP_PATH = SETTINGS_PATH + '.bak-antihall';

console.log('Scope:    ' + scope);
console.log('Settings: ' + SETTINGS_PATH);
console.log('');

// ---------------------------------------------------------------------------
// Ensure settings file exists (create minimal one if absent)
// ---------------------------------------------------------------------------

if (!fs.existsSync(SETTINGS_PATH)) {
  if (scope === 'user') {
    console.error('ERROR: ' + SETTINGS_PATH + ' not found. Is Claude Code installed?');
    process.exit(1);
  }
  // project scope — create the directory + empty settings.json
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
// Read + parse settings
// ---------------------------------------------------------------------------

let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (e) {
  console.error('ERROR: Could not parse ' + SETTINGS_PATH + ': ' + e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DEDUP: already points at our dispatcher?
// ---------------------------------------------------------------------------

const existing = settings.statusLine;
const existingCmd = (existing && typeof existing.command === 'string')
  ? existing.command
  : null;

if (existingCmd && existingCmd.includes(DISPATCHER)) {
  console.log('Already installed — statusLine already points at this statusline.js.');
  console.log('  ' + existingCmd);
  console.log('No changes made.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Record existing statusLine as the base to wrap (if present and not ours)
// ---------------------------------------------------------------------------

if (existingCmd) {
  // Save existing command as base so statusline.js can delegate line 1 to it.
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
// Write new statusLine
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
console.log('Restart Claude Code (close and reopen) for the change to take effect.');
console.log('');
console.log('To uninstall:');
console.log('  node "' + path.join(SCRIPT_DIR, 'uninstall-statusline.js') + '"');
