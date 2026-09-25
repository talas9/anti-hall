'use strict';
// settings-switches.test.js — 0.108.4 "every feature is controllable from
// settings". Proves, for the switches added in 0.108.4:
//   (1) DRIFT: every hook registered in the Claude AND Codex hooks.json is
//       either mapped to a settings switch (and its source actually calls that
//       switch) or listed in schema.NOT_TOGGLEABLE with a reason.
//   (2) DEFAULTS: every new switch defaults to the current behaviour (on /
//       'strict'), and enabled() on an empty home is true for all of them.
//   (3) BEHAVIOUR: a hook that fires with the default settings goes silent
//       (exit 0, no stdout, no side effect) with its switch off — each case
//       runs the SAME fixture both ways, so "off" is never a vacuous pass.
//   (4) CONFIRMATION GATE (0.108.4, revised): the safety keys read through the
//       normal precedence chain like any other setting; set/reset need
//       --confirmed (lib + CLI) for the risky direction (reset: judged on the
//       effective value AFTER the override is removed) or nothing changes and a one-line factual
//       warning (built from safetyNote) is returned instead.
// Every spawn uses an isolated HOME (tests/helpers/spawn-hook.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { testHook, bashPayload, editPayload } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');
const { writeSettings, switchOff } = require('../helpers/settings-switch.js');

const REPO = path.join(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugins', 'anti-hall');
const schema = require(path.join(PLUGIN, 'hooks', 'lib', 'settings-schema.js'));
const settings = require(path.join(PLUGIN, 'hooks', 'lib', 'settings.js'));
const CLI = path.join(PLUGIN, 'scripts', 'settings.js');

// hook file -> the setting that switches it off. Hooks whose switch predates
// 0.108.4 are included so the drift check covers every registered hook.
const SWITCHES = {
  'git-guard.js': 'safety.gitGuard',
  'command-guard.js': 'safety.commandGuard',
  'edit-guard.js': 'safety.editGuard',
  'swarm-guard.js': 'safety.swarmGuard',
  'verify-first.js': 'context.verifyFirstTurn',
  'verify-first-full.js': 'context.verifyFirstSession',
  'verify-first-orch.js': 'context.verifyFirstOrchestration',
  'verify-first-subagent.js': 'context.verifyFirstSubagent',
  'task-tracker.js': 'context.taskTracker',
  'handover-resume.js': 'context.handoverResume',
  'defect-nudge.js': 'context.defectNudge',
  'repair-on-reload.js': 'maintenance.repairOnReload',
  'progress-prune.js': 'maintenance.progressPrune',
  'precompact-snapshot.js': 'maintenance.precompactSnapshot',
  'task-lifecycle-log.js': 'maintenance.taskLifecycleLog',
  'session-end-mcp-reaper.js': 'maintenance.sessionEndReaper',
  'model-routing-guard.js': 'guards.modelRouting',
  'api-guard.js': 'guards.apiGuard',
  'speculation-guard.js': 'guards.speculationGuard',
  'claim-ledger.js': 'guards.claimLedger',
  'task-guard.js': 'guards.taskGuard',
  'tasklist-guard.js': 'guards.tasklistGuard',
  'scan-throttle.js': 'guards.scanThrottle',
  'devswarm-parent-gate.js': 'devswarm.parentGate',
  'devswarm-child-gate.js': 'devswarm.childGate',
  'devswarm-parent-inbox.js': 'devswarm.parentInbox',
  'devswarm-child-turn.js': 'devswarm.childTurn',
  'devswarm-child-role.js': 'devswarm.childRole',
  'devswarm-child-drain.js': 'devswarm.childDrain',
  'devswarm-parent-reply-tracker.js': 'devswarm.parentReplyTracker',
  'devswarm-comms-guard.js': 'devswarm.commsGuard',
  'inbox-read-guard.js': 'devswarm.inboxReadGuard',
  // pre-0.108.4 switches
  'output-verify-guard.js': 'guards.outputVerifyGuard',
  'failure-root-cause-nudge.js': 'guards.failureRootCauseNudge',
  'repo-self-drift.js': 'guards.repoSelfDrift',
  'merge-gate.js': 'guards.mergeGate',
  'ship-it-guard.js': 'guards.shipitGate',
  'codex-nudge.js': 'codexNudge.enabled',
  'version-alert.js': 'versionAlerts.antiHall',
  'claude-cli-version.js': 'versionAlerts.claudeCli',
  'devswarm-version.js': 'versionAlerts.devswarm',
  'auto-handover.js': 'autoHandover.enabled',
  'auto-handover-pause-nag.js': 'autoHandover.enabled',
  'limit-conserve-inject.js': 'limitConserve.mode',
  'speculation-judge.js': 'jev.semanticJudge',
  'jev-weekly-scorecard.js': 'jev.weeklyNotice',
};
// Non-hook features with a 0.108.4 switch (file -> key).
const COMPANION_SWITCHES = {
  'companion/lib/devswarm-wake-watch.js': 'devswarm.wakeWatch',
  'companion/devswarm-supervisor.js': 'devswarm.appSync',
  'scripts/devswarm.js': 'devswarm.screenshotSync',
};
const NEW_KEYS = [
  'safety.gitGuard', 'safety.commandGuard', 'safety.editGuard', 'safety.swarmGuard',
  'context.verifyFirstSession', 'context.verifyFirstOrchestration', 'context.verifyFirstTurn', 'context.verifyFirstSubagent',
  'context.taskTracker', 'context.handoverResume', 'context.defectNudge',
  'maintenance.repairOnReload', 'maintenance.progressPrune', 'maintenance.precompactSnapshot', 'maintenance.taskLifecycleLog', 'maintenance.sessionEndReaper',
  'guards.apiGuard', 'guards.speculationGuard', 'guards.claimLedger', 'guards.taskGuard', 'guards.tasklistGuard', 'guards.scanThrottle',
  'devswarm.parentGate', 'devswarm.childGate', 'devswarm.parentInbox', 'devswarm.childTurn', 'devswarm.childRole', 'devswarm.childDrain',
  'devswarm.parentReplyTracker', 'devswarm.commsGuard', 'devswarm.inboxReadGuard', 'devswarm.wakeWatch', 'devswarm.appSync', 'devswarm.screenshotSync',
];
const LOCKED_KEYS = [
  'safety.gitGuard', 'safety.commandGuard', 'safety.editGuard', 'safety.swarmGuard',
  'guards.stashGuard', 'guards.editGuardAllow', 'guards.allowSubagentMailbox',
];

// Exact warning text per key (owner-specified wording, 2026-09-25 revision):
// the template states the CONSEQUENCE of the risky change, not a generic
// "it is a safety guard" line, and 'guards.editGuardAllow' names the actual
// path(s) being added (here: 'foo', the value RISKY_VALUE_OF uses below).
const EXPECTED_WARNING = {
  'safety.gitGuard': 'Turning off git-guard means force-pushes and AI credit lines in commits will no longer be stopped. Ask the user to confirm, then re-run with --confirmed.',
  'safety.commandGuard': 'Turning off command-guard means heavy commands (builds, tests, deploys, pushes) will run directly in the main session instead of being handed to a helper. Ask the user to confirm, then re-run with --confirmed.',
  'safety.editGuard': 'Turning off edit-guard means edits to protected files like plugin config and secrets will no longer be stopped. Ask the user to confirm, then re-run with --confirmed.',
  'safety.swarmGuard': 'Turning off swarm-guard means nothing will stop runaway agent spawning that can overload the machine. Ask the user to confirm, then re-run with --confirmed.',
  'guards.stashGuard': 'Turning off stash-guard means git stash commands that can silently drop uncommitted work will no longer be blocked. Ask the user to confirm, then re-run with --confirmed.',
  'guards.editGuardAllow': 'Adding foo to edit-guard\'s allow list means those files can be edited without edit-guard\'s protection. Ask the user to confirm, then re-run with --confirmed.',
  'guards.allowSubagentMailbox': 'Turning on allow-subagent-mailbox means subagents can read/ack the Primary\'s mailbox, which is normally blocked. Ask the user to confirm, then re-run with --confirmed.',
};
// riskyValueFor/safeValueFor: the value in each direction, per entry.safetyDirection
// ('off' risky=false/safe=true; 'on' risky=true/safe=false; 'add' risky='foo'/safe='').
function riskyValueFor(e) {
  const dir = e.safetyDirection || 'off';
  if (dir === 'on') return true;
  if (dir === 'add') return 'foo';
  return false;
}
function safeValueFor(e) {
  const dir = e.safetyDirection || 'off';
  if (dir === 'on') return false;
  if (dir === 'add') return '';
  return true;
}

function split(k) { const i = k.indexOf('.'); return [k.slice(0, i), k.slice(i + 1)]; }
function hookScripts(rel) {
  const j = JSON.parse(fs.readFileSync(path.join(PLUGIN, rel), 'utf8'));
  const out = new Set();
  for (const groups of Object.values(j.hooks || {})) for (const g of groups) for (const h of g.hooks || []) {
    const m = String(h.command || '').match(/hooks\/([\w.-]+\.js)/);
    if (m) out.add(m[1]);
  }
  return out;
}
function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-switch-')); }

// ---------------------------------------------------------------- (1) drift
test('DRIFT: every Claude + Codex registered hook has a switch or a NOT_TOGGLEABLE reason', () => {
  const all = new Set([...hookScripts('hooks/hooks.json'), ...hookScripts('codex/hooks/hooks.json')]);
  const notToggleable = new Set(schema.NOT_TOGGLEABLE.map((n) => n.name + '.js'));
  const missing = [...all].filter((h) => !SWITCHES[h] && !notToggleable.has(h));
  assert.deepStrictEqual(missing, [], 'add a settings switch (or a NOT_TOGGLEABLE reason) for: ' + missing.join(', '));
  for (const n of schema.NOT_TOGGLEABLE) assert.ok(n.reason && n.reason.length > 20, n.name + ' needs a real reason');
});

test('DRIFT: each mapped switch exists in the schema and each 0.108.4 hook source actually reads it', () => {
  for (const [file, k] of Object.entries(SWITCHES)) {
    const [sec, key] = split(k);
    assert.ok(schema.findSetting(sec, key), k + ' (for ' + file + ') missing from the schema');
    if (!NEW_KEYS.includes(k) && k !== 'guards.modelRouting') continue;
    const src = fs.readFileSync(path.join(PLUGIN, 'hooks', file), 'utf8');
    assert.ok(src.includes("'" + sec + "', '" + key + "'"), file + ' never reads its switch ' + k);
  }
  for (const [file, k] of Object.entries(COMPANION_SWITCHES)) {
    const [sec, key] = split(k);
    const src = fs.readFileSync(path.join(PLUGIN, file), 'utf8');
    assert.ok(src.includes("'" + sec + "', '" + key + "'"), file + ' never reads its switch ' + k);
  }
});

// ------------------------------------------------------------- (2) defaults
test('DEFAULTS: every 0.108.4 switch defaults to current behaviour; enabled() is true on an empty home', () => {
  const home = tmpHome();
  try {
    for (const k of NEW_KEYS) {
      const [sec, key] = split(k);
      const e = schema.findSetting(sec, key);
      assert.strictEqual(e.type, 'boolean', k);
      assert.strictEqual(e.default, true, k + ' must default on');
      assert.ok(e.pluginOption, k + ' needs a /config row');
      assert.strictEqual(settings.enabled(sec, key, { home, env: {} }), true, k);
    }
    const mr = schema.findSetting('guards', 'modelRouting');
    assert.deepStrictEqual([mr.type, mr.default, mr.env], ['enum', 'strict', 'ANTIHALL_MODEL_ROUTING']);
    assert.strictEqual(settings.get('guards', 'modelRouting', undefined, { home, env: {} }), 'strict');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('DEFAULTS: pre-existing env kill switches still work through the schema', () => {
  const home = tmpHome();
  try {
    const off = (sec, key, env) => settings.enabled(sec, key, { home, env });
    assert.strictEqual(off('maintenance', 'repairOnReload', { ANTIHALL_REPAIR_ON_RELOAD: 'off' }), false);
    assert.strictEqual(off('guards', 'scanThrottle', { ANTI_HALL_SCAN_THROTTLE: '0' }), false);
    assert.strictEqual(off('maintenance', 'sessionEndReaper', { ANTI_HALL_SESSION_END_REAPER: '0' }), false);
    assert.strictEqual(off('devswarm', 'appSync', { ANTIHALL_DEVSWARM_APP_SYNC: '0' }), false);
    assert.strictEqual(settings.get('guards', 'modelRouting', undefined, { home, env: { ANTIHALL_MODEL_ROUTING: 'advisory' } }), 'advisory');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ (3) behaviour
// Each case: the fixture fires with default settings (on) and is silent with
// the switch off in settings.json. `fired(r, ctx)` decides "it did its job".
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const ctxOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const blocked = (r) => r.status === 2 || !!(r.json && r.json.decision === 'block');
const injected = (r) => ctxOf(r).length > 0;

const CASES = [
  { hook: 'verify-first.js', key: 'context.verifyFirstTurn', payload: () => ({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'do a thing', cwd: '/tmp/x' }), fired: injected },
  { hook: 'verify-first-full.js', key: 'context.verifyFirstSession', payload: () => ({ hook_event_name: 'SessionStart', session_id: 't', source: 'startup', cwd: '/tmp/x' }), fired: injected },
  { hook: 'verify-first-orch.js', key: 'context.verifyFirstOrchestration', payload: () => ({ hook_event_name: 'SessionStart', session_id: 't', source: 'startup', cwd: '/tmp/x' }), fired: injected },
  { hook: 'verify-first-subagent.js', key: 'context.verifyFirstSubagent', payload: () => ({ hook_event_name: 'SubagentStart', session_id: 't', agent_id: 'a1', agent_type: 'general-purpose', cwd: '/tmp/x' }), fired: injected },
  { hook: 'task-tracker.js', key: 'context.taskTracker', payload: () => ({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'do a thing', cwd: '/tmp/x' }), fired: injected },
  {
    hook: 'handover-resume.js', key: 'context.handoverResume',
    setup: (h) => { const cwd = path.join(h.home, 'proj'); fs.mkdirSync(cwd, { recursive: true }); return { cwd }; },
    payload: (s) => ({ hook_event_name: 'SessionStart', session_id: 's1', transcript_path: '/tmp/whatever.jsonl', cwd: s.cwd, source: 'compact' }),
    fired: injected,
  },
  {
    hook: 'speculation-guard.js', key: 'guards.speculationGuard',
    setup: (h) => ({ tp: h.writeTranscript([assistantMessage('I made the change.'), assistantMessage('This should be fine now.')]) }),
    payload: (s) => ({ hook_event_name: 'Stop', transcript_path: s.tp, session_id: 't' }),
    fired: blocked,
  },
  {
    hook: 'task-guard.js', key: 'guards.taskGuard',
    setup: (h) => ({ tp: h.writeTranscript([{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [{ id: '1', content: 'wire up the parser', status: 'in_progress' }, { id: '2', content: 'write the docs', status: 'pending' }] } }] } }]) }),
    payload: (s) => ({ hook_event_name: 'Stop', transcript_path: s.tp, session_id: 't' }),
    fired: blocked,
  },
  {
    hook: 'tasklist-guard.js', key: 'guards.tasklistGuard',
    setup: (h) => ({ tp: h.writeTranscript([0, 1, 2, 3].map((i) => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'toolu_e' + i, input: { file_path: '/x/f' + i } }] } }))) }),
    payload: (s, h) => ({ hook_event_name: 'Stop', transcript_path: s.tp, cwd: h.home, session_id: 't' }),
    fired: blocked,
  },
  {
    hook: 'precompact-snapshot.js', key: 'maintenance.precompactSnapshot',
    setup: (h) => {
      const cwd = path.join(h.home, 'repo');
      fs.mkdirSync(cwd, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
      return { cwd, tp: h.writeTranscript([{ type: 'user', message: { role: 'user', content: 'keep this rule' } }]) };
    },
    payload: (s) => ({ hook_event_name: 'PreCompact', session_id: 'sess-1', transcript_path: s.tp, cwd: s.cwd, trigger: 'auto', custom_instructions: null }),
    fired: (r, s) => fs.existsSync(path.join(s.cwd, '.anti-hall', 'handovers')),
  },
  {
    hook: 'defect-nudge.js', key: 'context.defectNudge',
    setup: (h) => { const cwd = path.join(h.home, 'proj'); fs.mkdirSync(cwd, { recursive: true }); return { cwd }; },
    payload: (s) => ({ hook_event_name: 'SessionStart', session_id: 't', cwd: s.cwd, source: 'startup' }),
    // It prints only when there is something to report, but it always arms
    // its once-a-day stamp when it runs — that stamp is the proof it ran.
    fired: (r, s, h) => fs.existsSync(require(path.join(PLUGIN, 'hooks', 'lib', 'defect-store.js')).nudgeStampFile(h.home)),
  },
  {
    hook: 'claim-ledger.js', key: 'guards.claimLedger',
    setup: (h) => ({ tp: h.writeTranscript([
      { type: 'user', message: { role: 'user', content: 'status?' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git status' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'On branch main' }] } },
      assistantMessage('You are on task 3 of your queue.'),
    ]) }),
    payload: (s) => ({ hook_event_name: 'Stop', transcript_path: s.tp, session_id: 't' }),
    fired: (r, s, h) => fs.existsSync(path.join(h.antiHall, 'claim-ledger', 't.jsonl')),
  },
  {
    hook: 'api-guard.js', key: 'guards.apiGuard',
    payload: () => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/x.js', content: "const fs = require('fs');\nfs.quantumReadEverything('/x');\n" }, session_id: 't', cwd: process.cwd() }),
    fired: blocked,
  },
  {
    hook: 'model-routing-guard.js', key: 'guards.modelRouting', offValue: 'off',
    payload: () => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'run the build and run the tests, then git push' }, session_id: 't', cwd: process.cwd() }),
    fired: blocked,
  },
  {
    hook: 'scan-throttle.js', key: 'guards.scanThrottle', env: { ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' },
    payload: () => bashPayload('reindex-repo --full'),
    fired: (r) => !!(r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.updatedInput),
    platforms: ['darwin', 'linux'],
  },
  {
    hook: 'task-lifecycle-log.js', key: 'maintenance.taskLifecycleLog',
    setup: (h) => { const cwd = path.join(h.home, 'proj'); fs.mkdirSync(cwd, { recursive: true }); return { cwd }; },
    payload: (s) => ({ hook_event_name: 'TaskCreated', session_id: 'sessA', cwd: s.cwd, task_id: 'task-1', task_subject: 'Do the thing' }),
    fired: (r, s) => fs.existsSync(path.join(s.cwd, '.anti-hall', 'history')),
  },
  {
    hook: 'progress-prune.js', key: 'maintenance.progressPrune',
    setup: (h) => {
      const cwd = path.join(h.home, 'proj');
      const p = path.join(cwd, '.anti-hall', 'progress', '2000-01-02', 'sess-old.md');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '# progress\n- done: old work\n');
      const sec = (Date.now() - 7 * 3600 * 1000) / 1000; fs.utimesSync(p, sec, sec);
      return { cwd, p };
    },
    payload: (s) => ({ hook_event_name: 'SessionStart', session_id: 'now', cwd: s.cwd, source: 'startup' }),
    fired: (r, s) => !fs.existsSync(s.p),
  },
  // Safety guards: a settings.json value does NOT disable them (see (4)), so
  // their "off" case uses /config (CLAUDE_PLUGIN_OPTION_*), the human's path.
  { hook: 'git-guard.js', key: 'safety.gitGuard', viaConfig: 'SAFETY_GIT_GUARD', payload: () => bashPayload('git push --force origin main'), fired: blocked },
  { hook: 'command-guard.js', key: 'safety.commandGuard', viaConfig: 'SAFETY_COMMAND_GUARD', env: COORD, payload: () => bashPayload('npm run build'), fired: blocked },
  { hook: 'edit-guard.js', key: 'safety.editGuard', viaConfig: 'SAFETY_EDIT_GUARD', env: COORD, payload: () => editPayload('Edit', { filePath: 'src/app.js' }), fired: blocked },
  {
    hook: 'swarm-guard.js', key: 'safety.swarmGuard', viaConfig: 'SAFETY_SWARM_GUARD',
    setup: (h) => { const now = Date.now(); fs.writeFileSync(path.join(h.antiHall, 'swarm-spawns.log'), Array.from({ length: 20 }, () => String(now - 1000)).join('\n') + '\n'); return {}; },
    payload: () => ({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'x', prompt: 'y' }, session_id: 't' }),
    fired: blocked,
  },
];

for (const c of CASES) {
  const skip = c.platforms && !c.platforms.includes(process.platform);
  test('SWITCH ' + c.key + ': ' + c.hook + ' fires by default and goes silent when off', { skip }, () => {
    const [sec, key] = split(c.key);
    for (const mode of ['on', 'off']) {
      const h = makeHome();
      try {
        const s = c.setup ? c.setup(h) : {};
        const env = Object.assign({}, c.env || {});
        if (mode === 'off') {
          if (c.viaConfig) env['CLAUDE_PLUGIN_OPTION_' + c.viaConfig] = 'false';
          else writeSettings(h.home, { [sec]: { [key]: c.offValue !== undefined ? c.offValue : false } });
        }
        const r = testHook(c.hook, c.payload(s, h), { home: h.home, env });
        if (mode === 'on') {
          assert.ok(c.fired(r, s, h), c.hook + ' did not fire with default settings (fixture is vacuous); status=' + r.status + ' stdout=' + r.stdout.slice(0, 300) + ' stderr=' + r.stderr.slice(0, 300));
        } else {
          assert.strictEqual(r.status, 0, c.hook + ' off must exit 0; stderr=' + r.stderr);
          assert.strictEqual(r.stdout.trim(), '', c.hook + ' off must print nothing');
          assert.ok(!c.fired(r, s, h), c.hook + ' still did its job with ' + c.key + ' off');
        }
      } finally { h.cleanup(); }
    }
  });
}

test('SWITCH guards.modelRouting=advisory (settings.json) downgrades the block to an advisory', () => {
  const h = makeHome();
  try {
    writeSettings(h.home, { guards: { modelRouting: 'advisory' } });
    const r = testHook('model-routing-guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'fetch and grep and tail the logs, run the build' }, session_id: 't', cwd: process.cwd() }, { home: h.home });
    assert.strictEqual(r.status, 0, r.stdout);
    assert.ok(ctxOf(r).length > 0, 'advisory text expected');
  } finally { h.cleanup(); }
});

test('SWITCH maintenance.sessionEndReaper: off returns before reading the SessionEnd payload', () => {
  const h = makeHome();
  try {
    const mod = path.join(PLUGIN, 'hooks', 'session-end-mcp-reaper.js');
    const code = 'let read=false; const o={ logDir: process.argv[2], get stdinRaw(){ read=true; return "not json"; } };'
      + ' require(' + JSON.stringify(mod) + ').main(o); process.stdout.write(String(read));';
    const env = { PATH: process.env.PATH, HOME: h.home, ANTIHALL_TEST_ISOLATION: '1' };
    const on = spawnSync(process.execPath, ['-e', code, path.join(h.home, 'logs')], { env, encoding: 'utf8' });
    assert.strictEqual(on.stdout, 'true', 'default on: the reaper reads its payload; stderr=' + on.stderr);
    switchOff(h.home, 'maintenance', 'sessionEndReaper');
    const off = spawnSync(process.execPath, ['-e', code, path.join(h.home, 'logs')], { env, encoding: 'utf8' });
    assert.strictEqual(off.stdout, 'false', 'off: returns before touching the payload');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------- (4) safety lock
test('SAFETY: every locked key is exactly the expected set and is a /config row', () => {
  const locked = schema.allSettings().filter((s) => s.locked).map((s) => s.section + '.' + s.key).sort();
  assert.deepStrictEqual(locked, [...LOCKED_KEYS].sort());
  const uc = require(path.join(PLUGIN, '.claude-plugin', 'plugin.json')).userConfig;
  for (const k of LOCKED_KEYS) {
    const [sec, key] = split(k);
    const e = schema.findSetting(sec, key);
    assert.ok(e.pluginOption && uc[e.pluginOption], k + ' must be a /config row so the human can change it natively');
    assert.ok(e.env, k + ' must keep an env override (Codex has no /config)');
  }
});

test('SAFETY: the exact warning text (owner-specified wording) for every locked key, in the risky direction only', () => {
  for (const k of LOCKED_KEYS) {
    const [sec, key] = split(k);
    const e = schema.findSetting(sec, key);
    const warning = settings.safetyWarning(e, riskyValueFor(e), e.default);
    assert.strictEqual(warning, EXPECTED_WARNING[k], k);
  }
});

test('SAFETY: settings.set needs --confirmed ONLY for the risky direction; the safe direction (re-arming a guard, narrowing an allow-list, turning a bypass off) needs no confirmation', () => {
  const home = tmpHome();
  try {
    for (const k of LOCKED_KEYS) {
      const [sec, key] = split(k);
      const e = schema.findSetting(sec, key);
      const risky = riskyValueFor(e);
      const safe = safeValueFor(e);

      // risky direction, unconfirmed: blocked, exact warning text, nothing written
      const blocked = settings.set(sec, key, risky, { home });
      assert.strictEqual(blocked.ok, false, k);
      assert.strictEqual(blocked.needsConfirmation, true, k);
      assert.strictEqual(blocked.warning, EXPECTED_WARNING[k], k);

      // safe direction, unconfirmed: applies immediately, no warning
      const safeSet = settings.set(sec, key, safe, { home });
      assert.strictEqual(safeSet.ok, true, k + ': ' + JSON.stringify(safeSet));
      assert.strictEqual(safeSet.needsConfirmation, undefined, k);
      assert.strictEqual(settings.get(sec, key, undefined, { home, env: {} }), safe === '' ? '' : safe, k);

      // risky direction, confirmed: applies
      const riskySet = settings.set(sec, key, risky, { home, confirmed: true });
      assert.strictEqual(riskySet.ok, true, k + ': ' + JSON.stringify(riskySet));
      assert.strictEqual(settings.get(sec, key, undefined, { home, env: {} }), risky, k);

      // reset back to a safe (or unchanged) default needs no confirmation
      const r = settings.reset(sec, key, { home });
      assert.strictEqual(r.ok, true, k);
      assert.strictEqual(r.needsConfirmation, undefined, k);
      assert.strictEqual(settings.source(sec, key, { home, env: {} }), 'default', k + ': reset must clear the override');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: reset is gated on the effective value AFTER removal — resetting a human-armed guards.stashGuard (default off) needs --confirmed; resetting a disarmed guard back to its safe default does not', () => {
  const home = tmpHome();
  try {
    const opts = { home, env: {} };
    // armed by a human -> reset would fall back to default false (disarm)
    assert.strictEqual(settings.set('guards', 'stashGuard', true, opts).ok, true);
    const blocked = settings.reset('guards', 'stashGuard', opts);
    assert.strictEqual(blocked.ok, false, JSON.stringify(blocked));
    assert.strictEqual(blocked.needsConfirmation, true);
    assert.strictEqual(blocked.warning, EXPECTED_WARNING['guards.stashGuard']);
    assert.strictEqual(settings.get('guards', 'stashGuard', undefined, opts), true, 'nothing written');
    assert.strictEqual(settings.source('guards', 'stashGuard', opts), 'file');

    const confirmed = settings.reset('guards', 'stashGuard', Object.assign({ confirmed: true }, opts));
    assert.strictEqual(confirmed.ok, true, JSON.stringify(confirmed));
    assert.strictEqual(settings.source('guards', 'stashGuard', opts), 'default');

    // disarmed gitGuard -> reset restores default true (safe): no confirmation
    assert.strictEqual(settings.set('safety', 'gitGuard', false, Object.assign({ confirmed: true }, opts)).ok, true);
    const safe = settings.reset('safety', 'gitGuard', opts);
    assert.strictEqual(safe.ok, true, JSON.stringify(safe));
    assert.strictEqual(settings.get('safety', 'gitGuard', undefined, opts), true);

    // an allow-list reset only removes tokens -> safe
    assert.strictEqual(settings.set('guards', 'editGuardAllow', 'src/**', Object.assign({ confirmed: true }, opts)).ok, true);
    assert.strictEqual(settings.reset('guards', 'editGuardAllow', opts).ok, true);

    // CLI: same gate, exit 1 + warning without --confirmed
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    assert.strictEqual(settings.set('guards', 'stashGuard', true, opts).ok, true);
    const cli = spawnSync(process.execPath, [CLI, 'reset', 'guards.stashGuard', '--json'], { env, encoding: 'utf8' });
    assert.strictEqual(cli.status, 1, cli.stdout + cli.stderr);
    assert.deepStrictEqual(JSON.parse(cli.stdout), { ok: false, needsConfirmation: true, warning: EXPECTED_WARNING['guards.stashGuard'] });
    const cliOk = spawnSync(process.execPath, [CLI, 'reset', 'guards.stashGuard', '--confirmed', '--json'], { env, encoding: 'utf8' });
    assert.strictEqual(cliOk.status, 0, cliOk.stdout + cliOk.stderr);
    assert.strictEqual(JSON.parse(cliOk.stdout).value, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: reset()\'s confirmation gate reads settings.json INSIDE the lock (rc-v0.108.4.2 review, P2) — a writer that arms the guard between an old-style pre-lock check and the delete must not let the disarm slip through unconfirmed', () => {
  const home = tmpHome();
  try {
    const opts = { home, env: {} };
    const file = settings.path(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Start with NO override — guards.stashGuard resolves to its safe
    // default (false). A stale PRE-LOCK read (the old, buggy shape) would
    // see this and wrongly decide "nothing armed, no confirmation needed".
    fs.writeFileSync(file, JSON.stringify({}) + '\n', 'utf8');

    const realReadFileSync = fs.readFileSync;
    // Capture the pre-race snapshot BEFORE any interception — this is what
    // the very first physical read of settings.json must return, so the
    // race is genuinely "read started before the concurrent write landed",
    // not "write, then read the fresh result back" (which would not
    // distinguish the buggy pre-lock-check shape from the fixed one, since
    // both would just see the armed guard immediately).
    const staleSnapshot = realReadFileSync.call(fs, file, 'utf8');
    let armed = false;
    fs.readFileSync = (p, ...rest) => {
      if (p === file && !armed) {
        armed = true;
        // Simulate a concurrent writer (another session/CLI invocation)
        // arming the guard right as this reset() call's first read begins —
        // but that in-flight read still returns the stale (pre-write) bytes
        // it already started with; every read AFTER this one sees the armed
        // guard.
        fs.writeFileSync(file, JSON.stringify({ guards: { stashGuard: true } }) + '\n', 'utf8');
        return staleSnapshot;
      }
      return realReadFileSync.call(fs, p, ...rest);
    };
    let result;
    try {
      result = settings.reset('guards', 'stashGuard', opts);
    } finally {
      fs.readFileSync = realReadFileSync;
    }

    // The fix: every read of settings.json for this call happens INSIDE
    // withSettingsLock, so the confirmation decision and the delete see the
    // SAME (already-armed-by-the-concurrent-writer) snapshot — reset()
    // correctly requires confirmation instead of silently disarming it.
    assert.strictEqual(result.ok, false, JSON.stringify(result));
    assert.strictEqual(result.needsConfirmation, true, JSON.stringify(result));
    assert.strictEqual(result.warning, EXPECTED_WARNING['guards.stashGuard']);
    assert.strictEqual(settings.get('guards', 'stashGuard', undefined, opts), true, 'the concurrently-armed guard must still be set — nothing was deleted');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: guards.editGuardAllow is risky only when ADDING a path not already present; removal-only and no-op changes need no confirmation', () => {
  const home = tmpHome();
  try {
    // starting from empty: adding is risky
    const add1 = settings.set('guards', 'editGuardAllow', 'src/**', { home });
    assert.strictEqual(add1.ok, false);
    assert.match(add1.warning, /^Adding src\/\*\* to edit-guard's allow list means /);

    const add1Confirmed = settings.set('guards', 'editGuardAllow', 'src/**', { home, confirmed: true });
    assert.strictEqual(add1Confirmed.ok, true);

    // widening an existing list (adding a second path) is risky again
    const add2 = settings.set('guards', 'editGuardAllow', 'src/**,dist/**', { home });
    assert.strictEqual(add2.ok, false);
    assert.match(add2.warning, /^Adding dist\/\*\* to edit-guard's allow list means /, 'only the NEW token is named');

    // re-setting to the SAME value adds nothing -> safe, no confirmation
    const same = settings.set('guards', 'editGuardAllow', 'src/**', { home });
    assert.strictEqual(same.ok, true, JSON.stringify(same));

    // narrowing (removing a path) is safe, no confirmation
    settings.set('guards', 'editGuardAllow', 'src/**,dist/**', { home, confirmed: true });
    const narrow = settings.set('guards', 'editGuardAllow', 'src/**', { home });
    assert.strictEqual(narrow.ok, true, JSON.stringify(narrow));

    // clearing entirely is safe, no confirmation
    const clear = settings.set('guards', 'editGuardAllow', '', { home });
    assert.strictEqual(clear.ok, true, JSON.stringify(clear));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: the CLI `set` needs --confirmed for the risky direction (exit 1, warning text + --json); the safe direction and a reset back to a safe default never do', () => {
  const home = tmpHome();
  try {
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    for (const k of LOCKED_KEYS) {
      const [sec, key] = split(k);
      const e = schema.findSetting(sec, key);
      const risky = String(riskyValueFor(e));
      const safe = String(safeValueFor(e));

      const noConfirm = spawnSync(process.execPath, [CLI, 'set', k, risky], { env, encoding: 'utf8' });
      assert.strictEqual(noConfirm.status, 1, k);
      assert.strictEqual(noConfirm.stdout.trim(), EXPECTED_WARNING[k], k);

      const noConfirmJson = spawnSync(process.execPath, [CLI, 'set', k, risky, '--json'], { env, encoding: 'utf8' });
      assert.strictEqual(noConfirmJson.status, 1, k);
      assert.deepStrictEqual(JSON.parse(noConfirmJson.stdout), { ok: false, needsConfirmation: true, warning: EXPECTED_WARNING[k] }, k);

      const safeApply = spawnSync(process.execPath, [CLI, 'set', k, safe, '--json'], { env, encoding: 'utf8' });
      assert.strictEqual(safeApply.status, 0, k + ' (safe direction, no --confirmed): ' + safeApply.stdout + safeApply.stderr);

      const confirmed = spawnSync(process.execPath, [CLI, 'set', k, risky, '--confirmed', '--json'], { env, encoding: 'utf8' });
      assert.strictEqual(confirmed.status, 0, k + ': ' + confirmed.stdout + confirmed.stderr);
      const expected = e.type === 'boolean' ? riskyValueFor(e) : risky;
      assert.strictEqual(JSON.parse(confirmed.stdout).value, expected, k);

      const reset = spawnSync(process.execPath, [CLI, 'reset', k], { env, encoding: 'utf8' });
      assert.strictEqual(reset.status, 0, k + ' (reset to a safe default needs no --confirmed): ' + reset.stdout + reset.stderr);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: normal precedence is restored — a hand-edited settings.json DOES take effect for a locked key (the confirmation gate, not an ignore rule, is the protection)', () => {
  const home = tmpHome();
  try {
    writeSettings(home, {
      safety: { gitGuard: false, commandGuard: false, editGuard: false, swarmGuard: false },
      guards: { editGuardAllow: '**', allowSubagentMailbox: true },
    });
    for (const k of ['safety.gitGuard', 'safety.commandGuard', 'safety.editGuard', 'safety.swarmGuard']) {
      const [sec, key] = split(k);
      assert.strictEqual(settings.get(sec, key, undefined, { home, env: {} }), false, k);
      assert.strictEqual(settings.enabled(sec, key, { home, env: {} }), false, k);
      assert.strictEqual(settings.source(sec, key, { home, env: {} }), 'file', k);
    }
    assert.strictEqual(settings.get('guards', 'editGuardAllow', undefined, { home, env: {} }), '**');
    assert.strictEqual(settings.get('guards', 'allowSubagentMailbox', undefined, { home, env: {} }), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: /config (pluginConfigs in ~/.claude/settings.json) and env still change a locked key', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ pluginConfigs: { 'anti-hall': { options: { safety_git_guard: false } } } }));
    assert.strictEqual(settings.get('safety', 'gitGuard', undefined, { home, env: {} }), false);
    assert.strictEqual(settings.source('safety', 'gitGuard', { home, env: {} }), 'plugin-option');
    assert.strictEqual(settings.get('safety', 'swarmGuard', undefined, { home, env: { ANTIHALL_SWARM_GUARD: '0' } }), false);
    assert.strictEqual(settings.source('safety', 'swarmGuard', { home, env: { ANTIHALL_SWARM_GUARD: '0' } }), 'env');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: git-guard still blocks a force-push by default (no settings.json override)', () => {
  const h = makeHome();
  try {
    const r = testHook('git-guard.js', bashPayload('git push --force origin main'), { home: h.home });
    assert.ok(blocked(r), 'stdout=' + r.stdout);
  } finally { h.cleanup(); }
});

test('SAFETY: git-guard goes silent once settings.json turns it off through the confirmed CLI path', () => {
  const h = makeHome();
  try {
    const env = { PATH: process.env.PATH, HOME: h.home, USERPROFILE: h.home };
    const r = spawnSync(process.execPath, [CLI, 'set', 'safety.gitGuard', 'false', '--confirmed'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const hookRun = testHook('git-guard.js', bashPayload('git push --force origin main'), { home: h.home });
    assert.strictEqual(hookRun.status, 0, 'confirmed off must actually silence the guard; stdout=' + hookRun.stdout);
  } finally { h.cleanup(); }
});

test('SAFETY: skip.json is unchanged — "all" still does NOT skip git-guard, a named skip does', () => {
  const h = makeHome();
  try {
    h.writeSkip({ all: Date.now() + 60000 });
    assert.ok(blocked(testHook('git-guard.js', bashPayload('git push --force origin main'), { home: h.home })));
    h.writeSkip({ 'git-guard': Date.now() + 60000 });
    assert.strictEqual(testHook('git-guard.js', bashPayload('git push --force origin main'), { home: h.home }).status, 0);
  } finally { h.cleanup(); }
});

test('show: lists the safety section, marks locked rows, and prints the NOT_TOGGLEABLE list', () => {
  const home = tmpHome();
  try {
    const out = execFileSync(process.execPath, [CLI, 'show'], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    for (const sec of schema.SECTIONS) assert.ok(out.includes('## ' + sec.label), 'show is missing section ' + sec.label);
    assert.match(out, /gitGuard \(safety: needs --confirmed\)/);
    assert.match(out, /## Not toggleable/);
    for (const n of schema.NOT_TOGGLEABLE) assert.ok(out.includes('`' + n.name + '`'), n.name);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
