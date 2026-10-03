'use strict';
// AH01 regression: plugins/anti-hall/codex/install-codex.js's ANTI_HALL_HOOKS
// registry must match the shipped Codex template at
// plugins/anti-hall/codex/hooks/hooks.json's hook-file set, event by event.
// The template is what ships in the .codex-plugin bundle; the installer is a
// separate hand-maintained code path (project-local / --global installs) that
// had silently drifted behind it (missing devswarm-version.js,
// claude-cli-version.js, repo-self-drift.js, defect-nudge.js on SessionStart,
// and devswarm-child-drain.js on PostToolUse).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'hooks', 'hooks.json');
const INSTALLER_PATH = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'install-codex.js');

// Extract the basename of every hook script a hooks-registry object (either
// the parsed hooks.json `.hooks` object, or install-codex.js's ANTI_HALL_HOOKS)
// registers for a given event, as a Set. Both shapes are the same
// `{ [event]: [ { matcher?, hooks: [ { command } ] } ] }` structure.
function hookFilesByEvent(hooksObj) {
  const out = {};
  for (const [event, groups] of Object.entries(hooksObj || {})) {
    const files = new Set();
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
        const command = (h && h.command) || '';
        // command looks like: node "/abs/path/to/hooks/some-hook.js"
        const match = command.match(/([A-Za-z0-9_.-]+\.js)"?\s*$/);
        if (match) files.add(match[1]);
      }
    }
    out[event] = files;
  }
  return out;
}

function readTemplateHookSets() {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return hookFilesByEvent(parsed.hooks);
}

function readInstallerHookSets() {
  // install-codex.js requires 'fs'/'path'/'os' at load time and computes
  // ANTI_HALL_HOOKS from repo-relative paths purely via require() — safe to
  // require directly for its exported registry without running the CLI.
  delete require.cache[require.resolve(INSTALLER_PATH)];
  const { ANTI_HALL_HOOKS } = require(INSTALLER_PATH);
  return hookFilesByEvent(ANTI_HALL_HOOKS);
}

test('codex hook parity: install-codex.js registers the same hook files as codex/hooks/hooks.json, per event', () => {
  const template = readTemplateHookSets();
  const installer = readInstallerHookSets();

  const events = new Set([...Object.keys(template), ...Object.keys(installer)]);
  const mismatches = [];
  for (const event of events) {
    const templateSet = template[event] || new Set();
    const installerSet = installer[event] || new Set();
    const missingFromInstaller = [...templateSet].filter((f) => !installerSet.has(f)).sort();
    const extraInInstaller = [...installerSet].filter((f) => !templateSet.has(f)).sort();
    if (missingFromInstaller.length || extraInInstaller.length) {
      mismatches.push({ event, missingFromInstaller, extraInInstaller });
    }
  }

  assert.deepStrictEqual(
    mismatches,
    [],
    'install-codex.js hook registry drifted from codex/hooks/hooks.json:\n' + JSON.stringify(mismatches, null, 2)
  );
});
