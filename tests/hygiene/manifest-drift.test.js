'use strict';
// manifest-drift: anti-hall = Claude plugin + Codex port (DUAL-PLATFORM
// PARITY, CLAUDE.md). Two recurring defect classes this closes:
//   1. The Codex plugin.json manifest froze for 10 releases while the Claude
//      one kept bumping (silent version drift).
//   2. plugins/anti-hall/codex/hooks/hooks.json is "a manually-maintained
//      list" (its own README wording) that can silently fall behind
//      plugins/anti-hall/hooks/hooks.json — e.g. progress-prune.js shipped
//      on the Claude side and was never mirrored to Codex (found by THIS
//      test; fixed alongside it — see codex/install-codex.js's matching fix).
//
// This file checks structure ONLY, not runtime hook behavior (the existing
// tests/codex/codex-hook-parity.test.js already proves install-codex.js's
// ANTI_HALL_HOOKS registry matches codex/hooks/hooks.json byte-for-byte; this
// file checks the OTHER side — codex/hooks/hooks.json against the Claude
// hooks.json it is meant to mirror).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const ANTI_HALL = path.join(REPO, 'plugins', 'anti-hall');
const CLAUDE_PLUGIN_JSON = path.join(ANTI_HALL, '.claude-plugin', 'plugin.json');
const CODEX_PLUGIN_JSON = path.join(ANTI_HALL, '.codex-plugin', 'plugin.json');
const CLAUDE_HOOKS_JSON = path.join(ANTI_HALL, 'hooks', 'hooks.json');
const CODEX_HOOKS_JSON = path.join(ANTI_HALL, 'codex', 'hooks', 'hooks.json');
const CLAUDE_HOOKS_DIR = path.join(ANTI_HALL, 'hooks');
// codex/hooks/hooks.json's `${PLUGIN_ROOT}/hooks/xxx.js` commands, and
// install-codex.js's own HOOK_ROOT (= path.resolve(__dirname, '..', 'hooks')
// from plugins/anti-hall/codex/install-codex.js), BOTH resolve to the SAME
// shared plugins/anti-hall/hooks/ directory — codex/hooks/ itself holds only
// hooks.json, no .js files of its own (verified: `ls plugins/anti-hall/codex/
// hooks/` lists only hooks.json). Codex hooks are the shared Claude hook
// files, referenced from a separate manifest, not a separate copy.
const CODEX_HOOKS_DIR = CLAUDE_HOOKS_DIR;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// hookFilesByEvent(hooksObj) -> { [event]: Set<basename.js> } — mirrors
// tests/codex/codex-hook-parity.test.js's own helper.
function hookFilesByEvent(hooksObj) {
  const out = {};
  for (const [event, groups] of Object.entries(hooksObj || {})) {
    const files = new Set();
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
        const command = (h && h.command) || '';
        const m = command.match(/([A-Za-z0-9_.-]+\.js)"?\s*$/);
        if (m) files.add(m[1]);
      }
    }
    out[event] = files;
  }
  return out;
}

// ALLOWLIST: hooks legitimately present ONLY on the Claude side, with the
// reason they do not (or cannot yet) apply to Codex. Every entry here is a
// { event, file, reason } triple. Update this list (with a real reason) when
// a genuinely Claude-only hook ships — do NOT add an entry to silence a real
// drift; that is what this test exists to catch.
const CLAUDE_ONLY_ALLOWLIST = [
  // Task-tool / subagent lifecycle events. Codex's harness has no
  // TaskCreated/TaskCompleted/SubagentStart event hooks at all (codex/hooks/
  // hooks.json registers neither event) — these are Claude Code Task-tool
  // concepts with no Codex equivalent today.
  { event: 'TaskCreated', file: 'task-lifecycle-log.js', reason: 'Claude Code Task-tool event; no Codex equivalent event exists' },
  { event: 'TaskCompleted', file: 'task-lifecycle-log.js', reason: 'Claude Code Task-tool event; no Codex equivalent event exists' },
  { event: 'SubagentStart', file: 'verify-first-subagent.js', reason: 'Claude Code Task-tool event; no Codex equivalent event exists' },
  // SessionStart: Fable model-cache probe is Claude-specific by design.
  { event: 'SessionStart', file: 'fable-availability.js', reason: "probes Claude Code's own ~/.claude.json model cache; irrelevant to gpt-5.x Codex sessions (install-codex.js's own header)" },
  // Stop: codex-nudge tells a CLAUDE session to get a Codex second opinion —
  // meaningless inside a Codex session itself.
  { event: 'Stop', file: 'codex-nudge.js', reason: 'nudges a Claude session to seek an independent Codex review; a no-op/self-referential inside a Codex session' },
  // PreToolUse Bash: scan-throttle guards a Claude-Code-specific heavy-scan
  // pattern (graphify) invoked from Claude sessions; not yet ported.
  { event: 'PreToolUse', file: 'scan-throttle.js', reason: 'throttles a Claude-session-invoked scan pattern; not yet ported to the Codex tool surface' },
  // PreToolUse edit-family matchers (Write/Edit/MultiEdit/NotebookEdit):
  // install-codex.js's own header states the current Codex hook runtime does
  // not hard-run PreToolUse for edit-family tools at all.
  { event: 'PreToolUse', file: 'api-guard.js', reason: 'Write/Edit/MultiEdit matcher — Codex hook runtime does not hard-run PreToolUse for edits (install-codex.js header)' },
  { event: 'PreToolUse', file: 'ship-it-guard.js', reason: 'Write/Edit/MultiEdit matcher — Codex hook runtime does not hard-run PreToolUse for edits (install-codex.js header)' },
  { event: 'PreToolUse', file: 'edit-guard.js', reason: 'Write/Edit/MultiEdit/NotebookEdit matcher — Codex hook runtime does not hard-run PreToolUse for edits (install-codex.js header)' },
  // PreToolUse Read: Read is a Claude Code tool name; Codex has no equivalent
  // matcher wired.
  { event: 'PreToolUse', file: 'inbox-read-guard.js', reason: 'Read-tool matcher — no Codex Read-tool PreToolUse matcher exists today' },
  // PreToolUse Agent/Task matchers: Claude Code subagent-dispatch tool names,
  // not present in the Codex tool surface.
  { event: 'PreToolUse', file: 'model-routing-guard.js', reason: 'Agent/Task-tool matcher — Claude Code subagent dispatch; no Codex equivalent tool matcher' },
  { event: 'PreToolUse', file: 'swarm-guard.js', reason: 'Agent/Task-tool matcher — Claude Code subagent dispatch; no Codex equivalent tool matcher' },
  { event: 'PreToolUse', file: 'phase-tracker.js', reason: 'Agent/Task-tool matcher — Claude Code subagent dispatch; no Codex equivalent tool matcher' },
  // PreToolUse SendMessage: DevSwarm mesh tool name specific to the Claude
  // Task-tool ecosystem.
  { event: 'PreToolUse', file: 'devswarm-comms-guard.js', reason: 'SendMessage-tool matcher — Claude-side DevSwarm mesh tool; no Codex equivalent tool matcher' },
  // PostToolUse Bash: verifies Claude Code's own Bash tool_response shape.
  { event: 'PostToolUse', file: 'output-verify-guard.js', reason: "inspects the Claude Code Bash tool's tool_response shape specifically" },
  // PostToolUseFailure: event not registered anywhere in codex/hooks/hooks.json.
  { event: 'PostToolUseFailure', file: 'failure-root-cause-nudge.js', reason: 'PostToolUseFailure event is not registered in codex/hooks/hooks.json at all (no Codex equivalent event)' },
  // SessionEnd: event not registered anywhere in codex/hooks/hooks.json.
  { event: 'SessionEnd', file: 'session-end-mcp-reaper.js', reason: 'SessionEnd event is not registered in codex/hooks/hooks.json at all; reaper targets Claude-Code-spawned MCP server processes' },
];

test('manifest-drift: Claude and Codex plugin.json versions match (CLAUDE.md version authority)', () => {
  const claudeVersion = readJson(CLAUDE_PLUGIN_JSON).version;
  const codexVersion = readJson(CODEX_PLUGIN_JSON).version;
  assert.ok(claudeVersion, 'Claude plugin.json must declare a version');
  assert.strictEqual(
    codexVersion, claudeVersion,
    `Codex plugin.json version (${codexVersion}) has drifted from Claude plugin.json (${claudeVersion}) — ` +
    'the Codex manifest froze for 10 releases once (CLAUDE.md "Codex manifest bump"); bump both together.'
  );
});

test('manifest-drift: every platform-neutral Claude hook has a Codex hooks.json entry (or a reasoned allowlist entry)', () => {
  const claudeHooks = hookFilesByEvent(readJson(CLAUDE_HOOKS_JSON).hooks);
  const codexHooks = hookFilesByEvent(readJson(CODEX_HOOKS_JSON).hooks);

  const allowSet = new Set(CLAUDE_ONLY_ALLOWLIST.map((a) => a.event + '::' + a.file));
  const undocumentedDrift = [];

  for (const [event, files] of Object.entries(claudeHooks)) {
    const codexFiles = codexHooks[event] || new Set();
    for (const file of files) {
      if (codexFiles.has(file)) continue; // mirrored -> fine
      if (allowSet.has(event + '::' + file)) continue; // explicit, reasoned exception -> fine
      undocumentedDrift.push(`${event}::${file}`);
    }
  }

  assert.deepStrictEqual(
    undocumentedDrift, [],
    'Hook(s) present in plugins/anti-hall/hooks/hooks.json but missing from ' +
    'plugins/anti-hall/codex/hooks/hooks.json with NO reasoned allowlist entry ' +
    '(add either a codex/hooks/hooks.json entry or a CLAUDE_ONLY_ALLOWLIST reason ' +
    'in this test file): ' + JSON.stringify(undocumentedDrift)
  );
});

test('manifest-drift: every allowlisted Claude-only hook is actually absent from Codex (no stale allowlist entries)', () => {
  const codexHooks = hookFilesByEvent(readJson(CODEX_HOOKS_JSON).hooks);
  const stale = CLAUDE_ONLY_ALLOWLIST.filter((a) => (codexHooks[a.event] || new Set()).has(a.file));
  assert.deepStrictEqual(
    stale, [],
    'CLAUDE_ONLY_ALLOWLIST entries that are now ALSO registered in codex/hooks/hooks.json ' +
    '(remove the stale allowlist entry): ' + JSON.stringify(stale)
  );
});

test('manifest-drift: every file referenced by either hooks.json exists on disk', () => {
  const missing = [];
  function checkHooksJson(hooksJsonPath, hooksDir, placeholderRe) {
    const parsed = readJson(hooksJsonPath);
    for (const groups of Object.values(parsed.hooks || {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
          const command = (h && h.command) || '';
          const m = command.match(/([A-Za-z0-9_.-]+\.js)"?\s*$/);
          if (!m) continue;
          const file = m[1];
          const abs = path.join(hooksDir, file);
          if (!fs.existsSync(abs)) missing.push(`${path.relative(REPO, hooksJsonPath)} -> ${file}`);
        }
      }
    }
  }
  checkHooksJson(CLAUDE_HOOKS_JSON, CLAUDE_HOOKS_DIR);
  checkHooksJson(CODEX_HOOKS_JSON, CODEX_HOOKS_DIR);
  assert.deepStrictEqual(missing, [], 'hooks.json references a hook file that does not exist on disk: ' + JSON.stringify(missing));
});

test('manifest-drift: install-codex.js ANTI_HALL_HOOKS references only files that exist on disk', () => {
  delete require.cache[require.resolve(path.join(ANTI_HALL, 'codex', 'install-codex.js'))];
  const { ANTI_HALL_HOOKS } = require(path.join(ANTI_HALL, 'codex', 'install-codex.js'));
  const missing = [];
  for (const [event, groups] of Object.entries(ANTI_HALL_HOOKS || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g && g.hooks) ? g.hooks : []) {
        const command = (h && h.command) || '';
        const m = command.match(/([A-Za-z0-9_.-]+\.js)"?\s*$/);
        if (!m) continue;
        // install-codex.js's HOOK_ROOT is always plugins/anti-hall/hooks (the
        // shared Claude hook files) — see this file's CODEX_HOOKS_DIR comment.
        const abs = path.join(CLAUDE_HOOKS_DIR, m[1]);
        if (!fs.existsSync(abs)) missing.push(`${event} -> ${m[1]}`);
      }
    }
  }
  assert.deepStrictEqual(missing, [], 'install-codex.js references a hook file that does not exist on disk: ' + JSON.stringify(missing));
});
