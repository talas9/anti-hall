#!/usr/bin/env node
// uninstall-statusline.js — Remove the anti-hall statusline from settings.json.
//
// If settings.json.bak-antihall-statusline exists, restores it in full.
// Otherwise removes the statusLine key from the current settings.json.
// Idempotent: if statusLine is already absent, reports and exits cleanly.
//
// Usage: node statusline/uninstall-statusline.js

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_PATH   = SETTINGS_PATH + '.bak-antihall-statusline';

// Settings file must exist.
if (!fs.existsSync(SETTINGS_PATH)) {
  console.error('ERROR: ' + SETTINGS_PATH + ' not found. Is Claude Code installed?');
  process.exit(1);
}

// --- Option A: backup exists — restore it entirely ---
if (fs.existsSync(BACKUP_PATH)) {
  let backupSettings;
  try {
    backupSettings = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  } catch (e) {
    console.error('ERROR: Could not parse backup ' + BACKUP_PATH + ': ' + e.message);
    console.error('Falling through to manual key removal.');
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

// --- Option B: no backup — remove the statusLine key if present ---
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
console.log('(No backup was available; key deleted directly.)');
console.log('');
console.log('Restart Claude Code (close and reopen) for the change to take effect.');
