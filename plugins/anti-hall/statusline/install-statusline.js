#!/usr/bin/env node
// install-statusline.js — Cross-platform installer for the anti-hall statusline.
//
// Sets statusLine in ~/.claude/settings.json to invoke statusline.js via node.
// Backs up settings.json before writing. Prints before/after and revert steps.
// Never clobbers an existing statusLine without showing it first.
//
// Usage: node install-statusline.js
//   (run from the directory where statusline.js lives, or from anywhere —
//    the installer resolves the absolute path to statusline.js automatically)

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SCRIPT_DIR    = __dirname;
const DISPATCHER    = path.join(SCRIPT_DIR, 'statusline.js');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_PATH   = SETTINGS_PATH + '.bak-anti-hall';

// Verify the dispatcher exists next to this script.
if (!fs.existsSync(DISPATCHER)) {
  console.error(`ERROR: statusline.js not found at: ${DISPATCHER}`);
  console.error('Run this installer from the directory that contains statusline.js.');
  process.exit(1);
}

// Settings file must exist.
if (!fs.existsSync(SETTINGS_PATH)) {
  console.error(`ERROR: ${SETTINGS_PATH} not found. Is Claude Code installed?`);
  process.exit(1);
}

// Back up before touching.
fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
console.log(`Backed up: ${SETTINGS_PATH}`);
console.log(`       to: ${BACKUP_PATH}`);
console.log('');

// Read + parse.
let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (e) {
  console.error(`ERROR: Could not parse ${SETTINGS_PATH}: ${e.message}`);
  console.error('Backup left intact. No changes made.');
  process.exit(1);
}

// Show existing statusLine if present.
const existing = settings.statusLine;
if (existing !== undefined) {
  console.log('Existing statusLine:');
  console.log(JSON.stringify(existing, null, 2));
  console.log('');
} else {
  console.log('No existing statusLine found.');
  console.log('');
}

// Quote the dispatcher path so spaces in the install path are safe (F-09).
// On Windows, path.join produces backslashes; JSON.stringify handles quoting.
const newStatusLine = {
  type: 'command',
  command: `node "${DISPATCHER}"`,
  padding: 0,
};

settings.statusLine = newStatusLine;

// Write back with consistent formatting.
try {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error(`ERROR: Could not write ${SETTINGS_PATH}: ${e.message}`);
  console.error(`Restore from backup: cp "${BACKUP_PATH}" "${SETTINGS_PATH}"`);
  process.exit(1);
}

console.log('New statusLine:');
console.log(JSON.stringify(newStatusLine, null, 2));
console.log('');
console.log(`Done. ${SETTINGS_PATH} updated.`);
console.log('');
console.log('To revert:');
console.log(`  cp "${BACKUP_PATH}" "${SETTINGS_PATH}"`);
console.log('Or remove the "statusLine" key from settings.json manually.');
