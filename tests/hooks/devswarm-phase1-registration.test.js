'use strict';
// Phase-1 wiring: the four mechanical DevSwarm hooks must be REGISTERED in the
// Claude hooks.json under the correct events, coexisting with (not replacing)
// the pre-existing hooks. The Codex port intentionally does NOT mirror them —
// DevSwarm is Claude-side (its DEVSWARM_* env vars are only set for the `claude`
// child sessions hivecontrol spawns), matching the existing devswarm-child-role
// omission and the liveness supervisor's documented Claude-only status.

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

test('Codex port does NOT mirror the Phase-1 DevSwarm hooks (Claude-side, not applicable)', () => {
  const cfg = JSON.parse(fs.readFileSync(CODEX_HOOKS_JSON, 'utf8'));
  const all = [
    ...commandsFor(cfg, 'UserPromptSubmit'),
    ...commandsFor(cfg, 'Stop'),
    ...commandsFor(cfg, 'SessionStart'),
    ...commandsFor(cfg, 'PreToolUse'),
  ].join('\n');
  // Same treatment as the existing devswarm-child-role omission: no DevSwarm
  // parent/child hook is wired into the Codex port.
  assert.doesNotMatch(all, /devswarm-parent-inbox\.js/);
  assert.doesNotMatch(all, /devswarm-child-turn\.js/);
  assert.doesNotMatch(all, /devswarm-parent-gate\.js/);
  assert.doesNotMatch(all, /devswarm-child-gate\.js/);
  assert.doesNotMatch(all, /devswarm-child-role\.js/);
});
