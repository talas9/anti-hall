#!/usr/bin/env node
// uninstall-statusline.js — Remove the anti-hall statusline from settings.json.
//
// Restore strategy (in order):
//   1. If ~/.anti-hall/base-statusline.json exists, restore THAT command as
//      statusLine.command in the settings file (original statusline is back).
//   2. Else if the backup (settings.json.bak-antihall) exists, restore it entirely.
//   3. Else remove the statusLine key from the current settings.json.
//
// IMPORTANT — the shared global base is NOT deleted by default:
//   ~/.anti-hall/base-statusline.json is GLOBAL: every project whose statusLine
//   points at the dispatcher wraps it as line 1. Deleting it during a single
//   project's uninstall would silently break line 1 for EVERY other project that
//   still relies on it. We cannot reference-count (no way to enumerate all
//   projects' settings files), so the safe default is to leave it in place. An
//   orphaned JSON is harmless; a deleted shared one is not.
//   Pass --purge-base to explicitly remove it ("I'm done with anti-hall on this
//   whole machine"). Only do that after uninstalling from every project.
//
// Idempotent: safe to run multiple times.
//
// Scope:
//   --user        (default)  ~/.claude/settings.json
//   --project                ./.claude/settings.local.json (falls back to
//                            ./.claude/settings.json only if the local file
//                            doesn't exist) — MUST match install-statusline.js,
//                            which writes --project installs to settings.local.json.
//   --purge-base             also delete the shared global base-statusline.json

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const args      = process.argv.slice(2);
const scope     = args.includes('--project') ? 'project' : 'user';
const purgeBase = args.includes('--purge-base');

let SETTINGS_PATH;
if (scope === 'user') {
  SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
} else {
  // install-statusline.js --project always writes settings.local.json (highest
  // precedence, gitignored). Target that same file so uninstall actually finds
  // and removes what install put there. Fall back to settings.json only when
  // the local file is absent (e.g. a pre-local-first install, or it was already
  // removed) — never the reverse, or we'd mutate a file install never touched.
  const localPath   = path.join(process.cwd(), '.claude', 'settings.local.json');
  const projectPath = path.join(process.cwd(), '.claude', 'settings.json');
  SETTINGS_PATH = fs.existsSync(localPath) ? localPath : projectPath;
}

const BACKUP_PATH  = SETTINGS_PATH + '.bak-antihall';
const BASE_CFG_DIR = path.join(os.homedir(), '.anti-hall');
const BASE_CFG     = path.join(BASE_CFG_DIR, 'base-statusline.json');

// looksLikeAntiHallStatusLine(cmd) — true if cmd points at the anti-hall
// dispatcher (statusline.js somewhere under an "anti-hall" directory). Mirrors
// install-statusline.js's own already-installed check, so uninstall never
// overwrites or removes a statusLine that belongs to something else.
function looksLikeAntiHallStatusLine(cmd) {
  if (typeof cmd !== 'string') return false;
  const norm = cmd.replace(/\\/g, '/');
  return norm.includes('statusline.js') && norm.includes('anti-hall/');
}

// ensureBackup() — back up SETTINGS_PATH once before the first mutation this
// run, mirroring install-statusline.js's own backup-once behavior. Never
// overwrites an existing backup (it may hold the real pre-install state).
function ensureBackup() {
  if (fs.existsSync(BACKUP_PATH)) return;
  try {
    fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
    console.log('Backed up: ' + SETTINGS_PATH);
    console.log('       to: ' + BACKUP_PATH);
    console.log('');
  } catch (e) {
    console.error('WARNING: Could not create backup: ' + e.message);
  }
}

console.log('Scope:    ' + scope);
console.log('Settings: ' + SETTINGS_PATH);
console.log('');

// Delete the shared global base ONLY when --purge-base is given. Used by the
// fall-through strategies (B/C) where the base wasn't consumed for a restore
// (e.g. missing or corrupt). Strategy A handles its own purge messaging inline.
function purgeBaseIfRequested() {
  if (!purgeBase) return;
  if (!fs.existsSync(BASE_CFG)) return;
  try {
    fs.unlinkSync(BASE_CFG);
    console.log('Purged shared base config (--purge-base): ' + BASE_CFG);
    console.log('');
  } catch (e) { /* already gone */ }
}

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

    const currentCmd = (settings.statusLine && typeof settings.statusLine.command === 'string')
      ? settings.statusLine.command : null;

    if (!looksLikeAntiHallStatusLine(currentCmd)) {
      // The statusLine actually present in SETTINGS_PATH doesn't point at the
      // anti-hall dispatcher (e.g. an unrelated statusLine, or anti-hall was
      // already removed). Restoring the base command here would clobber
      // something this uninstall doesn't own — fall through to strategy B/C.
      console.log('NOTE: the statusLine in ' + SETTINGS_PATH + ' does not point at the');
      console.log('anti-hall dispatcher — leaving it untouched, skipping the base-config restore.');
      console.log('  current statusLine: ' + (currentCmd || '(none)'));
      console.log('');
    } else {
      const restoredCmd = baseObj.command.trim();
      ensureBackup();
      settings.statusLine = { type: 'command', command: restoredCmd };

      try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      } catch (e) {
        console.error('ERROR: Could not write ' + SETTINGS_PATH + ': ' + e.message);
        process.exit(1);
      }

      console.log('Restored original statusLine from: ' + BASE_CFG);
      console.log('  command: ' + restoredCmd);
      console.log('');

      // The base config is GLOBAL/shared — other projects wrap it as line 1.
      // Only delete it when the user explicitly opts in via --purge-base.
      if (purgeBase) {
        try {
          fs.unlinkSync(BASE_CFG);
          console.log('Purged shared base config (--purge-base): ' + BASE_CFG);
          console.log('  NOTE: any OTHER project still pointing at the anti-hall dispatcher');
          console.log('  will lose its line-1 wrapper and fall back to the rich renderer.');
        } catch (e) { /* already gone */ }
      } else {
        console.log('Kept shared base config (global, used by other projects): ' + BASE_CFG);
        console.log('  Pass --purge-base to remove it once anti-hall is uninstalled everywhere.');
      }
      console.log('');
      console.log('Restart Claude Code (close and reopen) for the change to take effect.');
      process.exit(0);
    }
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
    purgeBaseIfRequested();
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
ensureBackup();
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
purgeBaseIfRequested();
console.log('Restart Claude Code (close and reopen) for the change to take effect.');
