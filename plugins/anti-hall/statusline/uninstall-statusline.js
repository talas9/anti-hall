#!/usr/bin/env node
// uninstall-statusline.js — Remove the anti-hall statusline from settings.json.
//
// Restore strategy (in order):
//   1. If ~/.anti-hall/base-statusline.json exists, restore THAT command as
//      statusLine.command in the settings file (original statusline is back).
//   2. Else if the backup (settings.json.bak-antihall) exists, restore it entirely.
//   3. Else remove the statusLine key from the current settings.json.
//
// Also removes ~/.anti-hall/base-statusline.json once the original is restored.
// Idempotent: safe to run multiple times.
//
// Scope:
//   --user    (default)  ~/.claude/settings.json
//   --project            ./.claude/settings.json

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const args  = process.argv.slice(2);
const scope = args.includes('--project') ? 'project' : 'user';

let SETTINGS_PATH;
if (scope === 'user') {
  SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
} else {
  SETTINGS_PATH = path.join(process.cwd(), '.claude', 'settings.json');
}

const BACKUP_PATH  = SETTINGS_PATH + '.bak-antihall';
const BASE_CFG_DIR = path.join(os.homedir(), '.anti-hall');
const BASE_CFG     = path.join(BASE_CFG_DIR, 'base-statusline.json');

console.log('Scope:    ' + scope);
console.log('Settings: ' + SETTINGS_PATH);
console.log('');

// Settings file must exist.
if (!fs.existsSync(SETTINGS_PATH)) {
  console.error('ERROR: ' + SETTINGS_PATH + ' not found.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Strategy A: base-statusline.json exists — restore original command
// ---------------------------------------------------------------------------

if (fs.existsSync(BASE_CFG)) {
  let baseObj;
  try {
    baseObj = JSON.parse(fs.readFileSync(BASE_CFG, 'utf8'));
  } catch (e) {
    console.error('ERROR: Could not parse ' + BASE_CFG + ': ' + e.message);
    console.error('Falling through to backup / key-removal strategy.');
    baseObj = null;
  }

  if (baseObj && typeof baseObj.command === 'string' && baseObj.command.trim()) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (e) {
      console.error('ERROR: Could not parse ' + SETTINGS_PATH + ': ' + e.message);
      process.exit(1);
    }

    const restoredCmd = baseObj.command.trim();
    settings.statusLine = { type: 'command', command: restoredCmd };

    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    } catch (e) {
      console.error('ERROR: Could not write ' + SETTINGS_PATH + ': ' + e.message);
      process.exit(1);
    }

    // Remove the base config now that it has been restored.
    try { fs.unlinkSync(BASE_CFG); } catch (e) { /* already gone */ }

    console.log('Restored original statusLine from: ' + BASE_CFG);
    console.log('  command: ' + restoredCmd);
    console.log('');
    console.log('Removed base config: ' + BASE_CFG);
    console.log('');
    console.log('Restart Claude Code (close and reopen) for the change to take effect.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Strategy B: settings backup exists — restore entire file
// ---------------------------------------------------------------------------

if (fs.existsSync(BACKUP_PATH)) {
  let backupSettings;
  try {
    backupSettings = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  } catch (e) {
    console.error('ERROR: Could not parse backup ' + BACKUP_PATH + ': ' + e.message);
    console.error('Falling through to key-removal strategy.');
    backupSettings = null;
  }

  if (backupSettings !== null) {
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(backupSettings, null, 2) + '\n', 'utf8');
    } catch (e) {
      console.error('ERROR: Could not restore ' + SETTINGS_PATH + ': ' + e.message);
      process.exit(1);
    }

    console.log('Restored ' + SETTINGS_PATH + ' from backup:');
    console.log('  ' + BACKUP_PATH);
    const restored = backupSettings.statusLine;
    if (restored !== undefined) {
      console.log('Restored statusLine: ' + JSON.stringify(restored));
    } else {
      console.log('Backup had no statusLine key — statusLine removed.');
    }
    console.log('');
    console.log('Restart Claude Code (close and reopen) for the change to take effect.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Strategy C: no backup, no base config — remove the statusLine key directly
// ---------------------------------------------------------------------------

let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (e) {
  console.error('ERROR: Could not parse ' + SETTINGS_PATH + ': ' + e.message);
  process.exit(1);
}

if (!('statusLine' in settings)) {
  console.log('Nothing to uninstall — statusLine key is already absent from ' + SETTINGS_PATH);
  process.exit(0);
}

const removed = settings.statusLine;
delete settings.statusLine;

try {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error('ERROR: Could not write ' + SETTINGS_PATH + ': ' + e.message);
  process.exit(1);
}

console.log('Removed statusLine from ' + SETTINGS_PATH + ':');
console.log(JSON.stringify(removed, null, 2));
console.log('');
console.log('(No backup or base config was available; key deleted directly.)');
console.log('');
console.log('Restart Claude Code (close and reopen) for the change to take effect.');
