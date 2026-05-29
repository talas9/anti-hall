#!/usr/bin/env node
// install-statusline.js — Idempotent installer for the anti-hall statusline.
//
// Sets statusLine.command in ~/.claude/settings.json to invoke statusline.js.
// Backs up settings.json once (settings.json.bak-antihall-statusline) before
// first change. Never overwrites the backup if it already exists.
// DEDUP: if statusLine already points at this script, prints a notice and exits.
//
// Usage: node statusline/install-statusline.js
//   (can be run from any directory — resolves paths automatically)

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SCRIPT_DIR    = __dirname;
const DISPATCHER    = path.join(SCRIPT_DIR, 'statusline.js');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_PATH   = SETTINGS_PATH + '.bak-antihall-statusline';

// Verify the dispatcher exists next to this script.
if (!fs.existsSync(DISPATCHER)) {
  console.error('ERROR: statusline.js not found at: ' + DISPATCHER);
  console.error('Run this installer from the directory that contains statusline.js.');
  process.exit(1);
}

// Settings file must exist.
if (!fs.existsSync(SETTINGS_PATH)) {
  console.error('ERROR: ' + SETTINGS_PATH + ' not found. Is Claude Code installed?');
  process.exit(1);
}

// Read + parse settings.
let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (e) {
  console.error('ERROR: Could not parse ' + SETTINGS_PATH + ': ' + e.message);
  process.exit(1);
}

// Build the new command string.
const newCommand   = 'node "' + DISPATCHER + '"';
const newStatusLine = { type: 'command', command: newCommand };

// DEDUP: if already pointing at this script, do nothing.
const existing = settings.statusLine;
if (existing && typeof existing.command === 'string') {
  // Normalize: compare the quoted dispatcher path embedded in the command.
  if (existing.command.includes(DISPATCHER)) {
    console.log('already installed — statusLine already points at:');
    console.log('  ' + existing.command);
    console.log('No changes made.');
    process.exit(0);
  }
}

// Back up only once (don't overwrite an existing backup).
if (!fs.existsSync(BACKUP_PATH)) {
  fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
  console.log('Backed up: ' + SETTINGS_PATH);
  console.log('       to: ' + BACKUP_PATH);
} else {
  console.log('Backup already exists at: ' + BACKUP_PATH + ' (not overwritten)');
}
console.log('');

// Show what we are replacing.
if (existing !== undefined) {
  console.log('Old statusLine:');
  console.log(JSON.stringify(existing, null, 2));
} else {
  console.log('No existing statusLine found.');
}
console.log('');

// Apply.
settings.statusLine = newStatusLine;
try {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error('ERROR: Could not write ' + SETTINGS_PATH + ': ' + e.message);
  console.error('Restore from backup:');
  console.error('  node uninstall-statusline.js');
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
