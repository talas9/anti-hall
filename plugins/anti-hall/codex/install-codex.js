#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const HOOK_ROOT = path.join(ROOT, 'hooks');

const args = new Set(process.argv.slice(2));
const globalInstall = args.has('--global');
const dryRun = args.has('--dry-run');
const targetRoot = globalInstall ? path.join(os.homedir(), '.codex') : path.join(process.cwd(), '.codex');
const hooksPath = path.join(targetRoot, 'hooks.json');
const configPath = globalInstall ? path.join(os.homedir(), '.codex', 'config.toml') : path.join(targetRoot, 'config.toml');

function hook(file) {
  return `node ${JSON.stringify(path.join(HOOK_ROOT, file))}`;
}

function group(matcher, files, timeout) {
  const out = {
    hooks: files.map((file) => ({
      type: 'command',
      command: hook(file),
      timeout,
    })),
  };
  if (matcher) out.matcher = matcher;
  return out;
}

// Codex hook parity is intentionally explicit:
// - PreToolUse is registered only for Bash/shell command guards.
// - Edit-time Claude guards (api-guard, ship-it-guard) are not registered here
//   because current Codex hook runtime does not hard-run PreToolUse for edits.
// - fable-availability.js is deliberately omitted: it probes ~/.claude.json for a
//   Claude Fable model entitlement (Claude Reviewer-seat fallback only), which is
//   irrelevant to gpt-5.x Codex/OMX sessions.
// - The DevSwarm per-turn override/reassert hooks (SessionStart devswarm-child-
//   role.js; UserPromptSubmit devswarm-parent-inbox.js/devswarm-child-turn.js;
//   Stop devswarm-parent-gate.js/devswarm-child-gate.js) ARE mirrored here
//   (corrected — a prior version of this comment claimed the gating DEVSWARM_*
//   env vars were Claude-only; that was disproven: docs/KB-devswarm-hivecontrol.md
//   §6/§8.7, from a live-verified env fingerprint, states DEVSWARM_REPO_ID /
//   DEVSWARM_SOURCE_BRANCH / DEVSWARM_BUILDER_ID are set by hivecontrol
//   per-workspace regardless of which agent runs there — DEVSWARM_AI_AGENT is
//   the SEPARATE var naming claude vs codex. command-guard.js's own DevSwarm gate
//   already relies on this same env and is proven to fire identically on Codex.
//   These five files are registered VERBATIM, unmodified, from ${HOOK_ROOT} —
//   same shared-file reuse as every other hook here — because their
//   hookSpecificOutput.additionalContext (SessionStart/UserPromptSubmit) and
//   {decision:"block"} (Stop) contracts, and the payload fields they read
//   (session_id/cwd/transcript_path), already match what verify-first-full.js/
//   task-tracker.js/task-guard.js/tasklist-guard.js prove works on Codex today.
//   The liveness SUPERVISOR (companion/devswarm-supervisor.js) remains
//   Claude-only — unrelated to this hook set, it identity-binds to `claude
//   --resume` processes specifically (codex/README.md).
const ANTI_HALL_HOOKS = {
  SessionStart: [
    group(null, ['verify-first-full.js'], 10),
    group(null, ['graphify-session.js'], 10),
    group(null, ['devswarm-child-role.js'], 10),
    group(null, ['version-alert.js'], 10),
    group(null, ['codex-availability.js'], 10),
  ],
  UserPromptSubmit: [
    group(null, ['verify-first.js'], 10),
    group(null, ['task-tracker.js'], 10),
    group(null, ['limit-conserve-inject.js'], 10),
    group(null, ['devswarm-parent-inbox.js'], 10),
    group(null, ['devswarm-child-turn.js'], 10),
  ],
  PreToolUse: [
    group('Bash', ['git-guard.js'], 10),
    group('Bash', ['command-guard.js'], 10),
    group('Bash', ['graphify-guard.js'], 10),
    group('Bash', ['merge-gate.js'], 10),
  ],
  Stop: [
    group(null, ['task-guard.js'], 30),
    group(null, ['tasklist-guard.js'], 30),
    group(null, ['graphify-reminder.js'], 30),
    group(null, ['speculation-guard.js'], 30),
    group(null, ['speculation-judge.js'], 30),
    group(null, ['devswarm-parent-gate.js'], 30),
    group(null, ['devswarm-child-gate.js'], 30),
  ],
};

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

function isAntiHallGroup(g) {
  const hooks = Array.isArray(g && g.hooks) ? g.hooks : [];
  // hook() builds paths with path.join, which emits backslashes on Windows;
  // normalize separators before matching so a prior Windows-installed group
  // is still recognized as stale and deduped, not appended alongside a fresh one.
  return hooks.some((h) => h && typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes('/plugins/anti-hall/hooks/'));
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
  process.stdout.write('- note: edit-time api-guard/ship-it-guard and subagent lifecycle hooks are Codex skill/workflow protocols, not hard hooks.\n');
  process.stdout.write('- note: Codex/OMX status_line uses built-in IDs only; anti-hall does not inject an unsupported AH version footer item.\n');
}

main();
