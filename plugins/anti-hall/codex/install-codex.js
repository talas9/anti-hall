#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const globalInstall = args.has('--global');
const dryRun = args.has('--dry-run');
const targetRoot = globalInstall ? path.join(os.homedir(), '.codex') : path.join(process.cwd(), '.codex');
const hooksPath = path.join(targetRoot, 'hooks.json');
const configPath = globalInstall ? path.join(os.homedir(), '.codex', 'config.toml') : path.join(targetRoot, 'config.toml');

// The registration is GENERATED, not hand-listed: codex/hooks/hooks.json is one thin wrapper call per event, produced by
// `ah-gen-fallback-list` from plugins/anti-hall/engine/defaults/dispatch.toml (the table of record). Installing it means pointing
// ${PLUGIN_ROOT} at this checkout; the wrapper and the engine do the per-hook dispatch.
const THIN_HOOKS = path.join(ROOT, 'codex', 'hooks', 'hooks.json');

function loadAntiHallHooks() {
  const src = fs.readFileSync(THIN_HOOKS, 'utf8').split('${PLUGIN_ROOT}').join(ROOT.replace(/\\/g, '/'));
  return JSON.parse(src).hooks;
}

const ANTI_HALL_HOOKS = loadAntiHallHooks();

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Files a graphify-cleanup migration must strip from an EXISTING Codex hooks.json
// (project or global) — these three no longer ship, so a stale registration would
// point at a missing file. Matched on basename only (not by anti-hall path prefix
// like isAntiHallGroup below) so this survives even if the group's command string
// predates path normalization.
const REMOVED_GRAPHIFY_FILES = ['graphify-session.js', 'graphify-guard.js', 'graphify-reminder.js'];

function isGraphifyGroup(g) {
  const hooks = Array.isArray(g && g.hooks) ? g.hooks : [];
  return hooks.some((h) => h && typeof h.command === 'string'
    && REMOVED_GRAPHIFY_FILES.some((f) => h.command.replace(/\\/g, '/').includes('/' + f)));
}

/**
 * removeGraphifyGroups(hooksJson) → { hooks: <object>, removed: <number> }
 *
 * Forward migration for graphify's removal: strips ONLY groups that register
 * graphify-session.js/graphify-guard.js/graphify-reminder.js from an existing
 * Codex hooks.json shape, leaving every other event/group byte-identical
 * (including group order and unrelated matchers). Never touches anything else
 * in the file, never deletes the file, and is idempotent — a second pass over
 * already-cleaned hooks finds nothing to remove.
 */
function removeGraphifyGroups(hooksJson) {
  const src = hooksJson && typeof hooksJson === 'object' && hooksJson.hooks && typeof hooksJson.hooks === 'object'
    ? hooksJson.hooks
    : {};
  const out = {};
  let removed = 0;
  for (const event of Object.keys(src)) {
    const groups = Array.isArray(src[event]) ? src[event] : [];
    const kept = groups.filter((g) => {
      if (isGraphifyGroup(g)) { removed += 1; return false; }
      return true;
    });
    out[event] = kept;
  }
  return { hooks: out, removed };
}

function isAntiHallGroup(g) {
  const hooks = Array.isArray(g && g.hooks) ? g.hooks : [];
  // hook() builds paths with path.join, which emits backslashes on Windows;
  // normalize separators before matching so a prior Windows-installed group
  // is still recognized as stale and deduped, not appended alongside a fresh one.
  return hooks.some((h) => h && typeof h.command === 'string' && /\/plugins\/anti-hall\/hooks\/|\/hooks\/ah-hook\.sh"/.test(h.command.replace(/\\/g, '/')));
}

function mergeHooks(existing) {
  const next = { hooks: {} };
  const oldHooks = existing && typeof existing === 'object' && existing.hooks && typeof existing.hooks === 'object'
    ? existing.hooks
    : {};
  const events = new Set([...Object.keys(oldHooks), ...Object.keys(ANTI_HALL_HOOKS)]);
  for (const event of events) {
    const kept = Array.isArray(oldHooks[event]) ? oldHooks[event].filter((g) => !isAntiHallGroup(g)) : [];
    const additions = ANTI_HALL_HOOKS[event] || [];
    next.hooks[event] = [...kept, ...additions];
  }
  return next;
}

function ensureHooksFeatureToml(toml) {
  if (/\[features\][\s\S]*?^\s*hooks\s*=/m.test(toml)) return toml;
  if (/\[features\]/.test(toml)) return toml.replace(/\[features\]\n/, '[features]\nhooks = true\n');
  const prefix = toml.trim().length ? toml.replace(/\s*$/, '\n\n') : '';
  return `${prefix}[features]\nhooks = true\n`;
}

function writeFileChanged(file, content) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old === content) return false;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (old !== null) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, `${file}.bak-${stamp}`);
    }
    fs.writeFileSync(file, content);
  }
  return true;
}

function main() {
  // Test guard (0.108.0 launchd/config leak): under a test (NODE_TEST_CONTEXT or
  // ANTIHALL_TEST_ISOLATION) never write Codex config outside a temp dir.
  if (!dryRun && require('../companion/lib/test-home-guard.js').userConfigWriteRefused(targetRoot)) {
    process.stderr.write('⛔ anti-hall · install-codex: refused under a test: ' + targetRoot + ' is outside a temp dir.\nDo instead: isolate HOME/cwd.\n');
    return;
  }
  const existingHooks = readJSON(hooksPath);
  const merged = mergeHooks(existingHooks);
  const hooksChanged = writeFileChanged(hooksPath, JSON.stringify(merged, null, 2) + '\n');

  const oldToml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const newToml = ensureHooksFeatureToml(oldToml);
  const configChanged = writeFileChanged(configPath, newToml);

  const scope = globalInstall ? 'global' : 'project';
  const status = dryRun ? 'would update' : 'updated';
  process.stdout.write(`anti-hall Codex install (${scope}): ${status}\n`);
  process.stdout.write(`- hooks: ${hooksPath} ${hooksChanged ? 'changed' : 'unchanged'}\n`);
  process.stdout.write(`- config: ${configPath} ${configChanged ? 'changed' : 'unchanged'}\n`);
  process.stdout.write('- note: edit guards run on apply_patch only (Codex >= 0.134); shell writes bypass them, and subagent lifecycle hooks are Codex skill/workflow protocols, not hard hooks.\n');
  process.stdout.write('- note: Codex/OMX status_line uses built-in IDs only; anti-hall does not inject an unsupported AH version footer item.\n');
}

// Exported for doctor.js/doctor-repair.js so they can reuse the SAME canonical
// hook set + anti-hall-group detection this installer uses, instead of
// inventing a separate (and drift-prone) heuristic. require()-ing this module
// must NOT run main() / write files — only direct CLI invocation
// (`node install-codex.js`) does, hence the require.main guard below.
module.exports = { ANTI_HALL_HOOKS, isAntiHallGroup, mergeHooks, isGraphifyGroup, removeGraphifyGroups, REMOVED_GRAPHIFY_FILES };

if (require.main === module) {
  main();
}
