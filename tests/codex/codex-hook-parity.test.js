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
const TEMPLATE_PATH = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'hooks', 'hooks.registry.json');
const INSTALLER_PATH = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'install-codex.js');

// Normalized full command of every hook a hooks-registry object (either the
// parsed hooks.json `.hooks` object, or install-codex.js's ANTI_HALL_HOOKS)
// registers for a given event, as a Set. The quoted script path is reduced to
// its basename (the template uses ${PLUGIN_ROOT}, the installer an absolute
// path); node flags and script arguments (e.g. `--audit`) are kept.
function hookFilesByEvent(hooksObj) {
  const out = {};
  for (const [event, groups] of Object.entries(hooksObj || {})) {
    const cmds = new Set();
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
        const command = (h && h.command) || '';
        cmds.add(command.replace(/"[^"]*[\\/]([A-Za-z0-9_.-]+\.js)"/, '$1').trim());
      }
    }
    out[event] = cmds;
  }
  return out;
}

const THIN_PATH = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'hooks', 'hooks.json');

// The installer no longer hand-lists hooks: it consumes the generated thin file (one wrapper call per event, produced by
// the Rust generator from dispatch.toml). The per-hook behaviour parity (old registry vs thin trigger) is gated in
// ah-engine/tests/it/flip_parity.rs; this test pins that the installer writes exactly the generated file.
test('codex hook parity: install-codex.js registers exactly the generated codex/hooks/hooks.json, per event', () => {
  delete require.cache[require.resolve(INSTALLER_PATH)];
  const { ANTI_HALL_HOOKS } = require(INSTALLER_PATH);
  const root = path.join(REPO, 'plugins', 'anti-hall');
  const thin = JSON.parse(fs.readFileSync(THIN_PATH, 'utf8').split('${PLUGIN_ROOT}').join(root)).hooks;
  assert.deepStrictEqual(ANTI_HALL_HOOKS, thin);
  // and the per-hook registry (what the Node readers use) covers the same events the thin file triggers, or fewer
  const reg = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')).hooks;
  for (const ev of Object.keys(reg)) assert.ok(thin[ev], 'registry event ' + ev + ' has a thin trigger');
  const sets = hookFilesByEvent(reg);
  assert.ok(sets.PreToolUse.size > 0);
});
