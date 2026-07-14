'use strict';
// Phase-1 wiring: the four mechanical DevSwarm hooks (plus devswarm-parent-gate.js,
// the Primary-side Stop sibling of devswarm-child-gate.js) must be REGISTERED in
// the Claude hooks.json under the correct events, coexisting with (not replacing)
// the pre-existing hooks.
//
// The Codex port MIRRORS these same five files verbatim (corrected — a prior
// version of this suite asserted the Codex port does NOT mirror them, reasoning
// that DevSwarm's gating DEVSWARM_* env vars were set only for `claude` child
// sessions; that premise was disproven against docs/KB-devswarm-hivecontrol.md
// §6/§8.7's live-verified env fingerprint: DEVSWARM_REPO_ID/DEVSWARM_SOURCE_BRANCH/
// DEVSWARM_BUILDER_ID are set by hivecontrol per-workspace regardless of which
// agent runs there — DEVSWARM_AI_AGENT is the separate var naming claude vs codex.
// All five files (including the SessionStart devswarm-child-role.js) are now
// registered verbatim in codex/hooks/hooks.json. The liveness supervisor
// (companion/devswarm-supervisor.js) remains genuinely Claude-only — it
// identity-binds to `claude --resume` processes specifically — and is out of
// scope for this file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const CLAUDE_HOOKS_JSON = path.join(PLUGIN, 'hooks', 'hooks.json');
const CODEX_HOOKS_JSON = path.join(PLUGIN, 'codex', 'hooks', 'hooks.json');

// commandsFor(cfg, event) -> string[] of every hook command under an event.
function commandsFor(cfg, event) {
  const groups = (cfg.hooks && cfg.hooks[event]) || [];
  return groups.flatMap((g) => (g.hooks || []).map((h) => h.command || ''));
}

test('Claude hooks.json is valid JSON and registers the four Phase-1 hooks on the right events', () => {
  const cfg = JSON.parse(fs.readFileSync(CLAUDE_HOOKS_JSON, 'utf8'));

  const ups = commandsFor(cfg, 'UserPromptSubmit');
  const stop = commandsFor(cfg, 'Stop');

  // UserPromptSubmit: parent-inbox (Primary) + child-turn (child).
  assert.ok(ups.some((c) => /devswarm-parent-inbox\.js/.test(c)), 'parent-inbox not registered on UserPromptSubmit');
  assert.ok(ups.some((c) => /devswarm-child-turn\.js/.test(c)), 'child-turn not registered on UserPromptSubmit');

  // Stop: parent-gate (Primary) + child-gate (child).
  assert.ok(stop.some((c) => /devswarm-parent-gate\.js/.test(c)), 'parent-gate not registered on Stop');
  assert.ok(stop.some((c) => /devswarm-child-gate\.js/.test(c)), 'child-gate not registered on Stop');

  // Correct-event discipline: the Stop gates must NOT sit on UserPromptSubmit
  // and the turn/inbox hooks must NOT sit on Stop.
  assert.ok(!ups.some((c) => /devswarm-(parent|child)-gate\.js/.test(c)), 'a Stop-gate is wrongly on UserPromptSubmit');
  assert.ok(!stop.some((c) => /devswarm-(parent-inbox|child-turn)\.js/.test(c)), 'an UPS hook is wrongly on Stop');

  // Every command uses the ${CLAUDE_PLUGIN_ROOT} shape the other entries use.
  for (const c of [...ups, ...stop].filter((c) => /devswarm-(parent|child)-/.test(c))) {
    assert.match(c, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/devswarm-/, `Phase-1 hook not using CLAUDE_PLUGIN_ROOT: ${c}`);
  }
});

test('coexistence: the pre-existing UserPromptSubmit + Stop hooks are untouched by the Phase-1 additions', () => {
  const cfg = JSON.parse(fs.readFileSync(CLAUDE_HOOKS_JSON, 'utf8'));
  const ups = commandsFor(cfg, 'UserPromptSubmit');
  const stop = commandsFor(cfg, 'Stop');

  // The 3 original UserPromptSubmit hooks still present.
  for (const f of ['verify-first.js', 'task-tracker.js', 'limit-conserve-inject.js']) {
    assert.ok(ups.some((c) => c.includes(f)), `pre-existing UPS hook missing after wiring: ${f}`);
  }
  // The 6 original Stop hooks still present.
  for (const f of ['task-guard.js', 'tasklist-guard.js', 'graphify-reminder.js', 'speculation-guard.js', 'speculation-judge.js', 'codex-nudge.js']) {
    assert.ok(stop.some((c) => c.includes(f)), `pre-existing Stop hook missing after wiring: ${f}`);
  }

  // Each Phase-1 hook is its OWN group (no shared counter / merged group with an
  // existing hook) so their state files and outputs stay independent.
  assert.strictEqual(ups.filter((c) => /devswarm-parent-inbox\.js/.test(c)).length, 1);
  assert.strictEqual(ups.filter((c) => /devswarm-child-turn\.js/.test(c)).length, 1);
  assert.strictEqual(stop.filter((c) => /devswarm-parent-gate\.js/.test(c)).length, 1);
  assert.strictEqual(stop.filter((c) => /devswarm-child-gate\.js/.test(c)).length, 1);
});

test('Codex port mirrors the five Phase-1 DevSwarm hooks on the matching events', () => {
  const cfg = JSON.parse(fs.readFileSync(CODEX_HOOKS_JSON, 'utf8'));
  const sessionStart = commandsFor(cfg, 'SessionStart');
  const ups = commandsFor(cfg, 'UserPromptSubmit');
  const stop = commandsFor(cfg, 'Stop');

  assert.ok(sessionStart.some((c) => /devswarm-child-role\.js/.test(c)), 'child-role not registered on Codex SessionStart');
  assert.ok(ups.some((c) => /devswarm-parent-inbox\.js/.test(c)), 'parent-inbox not registered on Codex UserPromptSubmit');
  assert.ok(ups.some((c) => /devswarm-child-turn\.js/.test(c)), 'child-turn not registered on Codex UserPromptSubmit');
  assert.ok(stop.some((c) => /devswarm-parent-gate\.js/.test(c)), 'parent-gate not registered on Codex Stop');
  assert.ok(stop.some((c) => /devswarm-child-gate\.js/.test(c)), 'child-gate not registered on Codex Stop');

  // Correct-event discipline mirrors the Claude-side test above: the Stop gates
  // must not sit on UserPromptSubmit/SessionStart and vice versa.
  assert.ok(!ups.some((c) => /devswarm-(parent|child)-gate\.js/.test(c)), 'a Stop-gate is wrongly on Codex UserPromptSubmit');
  assert.ok(!stop.some((c) => /devswarm-(parent-inbox|child-turn|child-role)\.js/.test(c)), 'an UPS/SessionStart hook is wrongly on Codex Stop');
  assert.ok(!sessionStart.some((c) => /devswarm-(parent-inbox|child-turn|parent-gate|child-gate)\.js/.test(c)), 'a non-SessionStart hook is wrongly on Codex SessionStart');

  // Every command uses the ${PLUGIN_ROOT} shape the rest of the Codex file uses
  // (never ${CLAUDE_PLUGIN_ROOT}) — reuse of the SAME shared hook files, no fork.
  for (const c of [...sessionStart, ...ups, ...stop].filter((c) => /devswarm-(parent|child)-/.test(c))) {
    assert.match(c, /\$\{PLUGIN_ROOT\}\/hooks\/devswarm-/, `Codex Phase-1 hook not using PLUGIN_ROOT: ${c}`);
    assert.doesNotMatch(c, /CLAUDE_PLUGIN_ROOT/, `Codex Phase-1 hook wrongly using CLAUDE_PLUGIN_ROOT: ${c}`);
  }
});

test('install-codex.js generates the same five Phase-1 DevSwarm hook registrations', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const installer = path.join(PLUGIN, 'codex', 'install-codex.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-devswarm-codex-install-'));
  try {
    const r = spawnSync(process.execPath, [installer], { cwd: tmp, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.codex', 'hooks.json'), 'utf8'));
    const sessionStart = commandsFor(cfg, 'SessionStart');
    const ups = commandsFor(cfg, 'UserPromptSubmit');
    const stop = commandsFor(cfg, 'Stop');
    assert.ok(sessionStart.some((c) => /devswarm-child-role\.js/.test(c)));
    assert.ok(ups.some((c) => /devswarm-parent-inbox\.js/.test(c)));
    assert.ok(ups.some((c) => /devswarm-child-turn\.js/.test(c)));
    assert.ok(stop.some((c) => /devswarm-parent-gate\.js/.test(c)));
    assert.ok(stop.some((c) => /devswarm-child-gate\.js/.test(c)));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});
