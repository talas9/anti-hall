'use strict';
// devswarm.dispatchTierText + the no-workspace-repo suppression: the DevSwarm PRIMARY
// dispatch-tier text injected by task-tracker.js, verify-first.js and
// verify-first-orch.js goes through ONE gate (hooks/lib/primary-tier.js). It must be
// present for a Primary in an ordinary repo, and absent (output == the non-DevSwarm
// baseline) when the setting is off or the repo's CLAUDE.md/AGENTS.md forbids
// workspaces for real work.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-x', ANTIHALL_EMIT_DEDUPE: '0' };
const BASE_ENV = { ANTIHALL_EMIT_DEDUPE: '0' };
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-x', DEVSWARM_SOURCE_BRANCH: 'feature/y', ANTIHALL_EMIT_DEDUPE: '0' };

function mkCwd(doctrine) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-ptt-'));
  if (doctrine) fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# Rules\n- **NO WORKSPACES FOR REAL WORK.** Use subagents.\n');
  return d;
}
const ctx = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';

const HOOKS = [
  { hook: 'task-tracker.js', marker: 'task-tracker: Primary dispatch tier', payload: (cwd) => ({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd }) },
  { hook: 'verify-first.js', marker: 'DEVSWARM PRIMARY: the workspace is your TOP fan-out tier', payload: (cwd) => ({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'do a thing', cwd }) },
  { hook: 'verify-first-orch.js', marker: 'W. DEVSWARM PRIMARY', payload: (cwd) => ({ hook_event_name: 'SessionStart', source: 'startup', session_id: 't', cwd }) },
];

function run(hook, payload, env, settings) {
  const h = makeHome();
  try {
    if (settings) fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify(settings));
    return testHook(hook, payload, { home: h.home, env, expectJson: true });
  } finally { h.cleanup(); }
}

for (const { hook, marker, payload } of HOOKS) {
  test(`${hook}: Primary in an ordinary repo gets the tier text`, () => {
    assert.ok(ctx(run(hook, payload(mkCwd(false)), PRIMARY_ENV)).includes(marker));
  });
  test(`${hook}: no-workspace repo -> text suppressed, output == non-DevSwarm baseline`, () => {
    const cwd = mkCwd(true);
    const c = ctx(run(hook, payload(cwd), PRIMARY_ENV));
    assert.ok(!c.includes(marker), 'tier text must be absent');
    assert.strictEqual(c, ctx(run(hook, payload(cwd), BASE_ENV)));
  });
  test(`${hook}: devswarm.dispatchTierText off (file and env) -> text suppressed`, () => {
    const cwd = mkCwd(false);
    assert.ok(!ctx(run(hook, payload(cwd), PRIMARY_ENV, { devswarm: { dispatchTierText: false } })).includes(marker));
    assert.ok(!ctx(run(hook, payload(cwd), Object.assign({ ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT: '0' }, PRIMARY_ENV))).includes(marker));
  });
  test(`${hook}: a child workspace never gets it`, () => {
    assert.ok(!ctx(run(hook, payload(mkCwd(false)), CHILD_ENV)).includes(marker));
  });
}

test('schema / manifest parity for devswarm.dispatchTierText', () => {
  const plugin = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
  const e = require(path.join(plugin, 'hooks', 'lib', 'settings-schema.js')).findSetting('devswarm', 'dispatchTierText');
  assert.ok(e);
  assert.strictEqual(e.default, true);
  assert.strictEqual(e.env, 'ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT');
  const m = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepStrictEqual([e.pluginOption, e.advanced], [undefined, true]);
  assert.strictEqual(m.userConfig.devswarm_dispatch_tier_text, undefined, 'no manifest row');
});
