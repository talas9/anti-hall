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
//   (4) SAFETY LOCK: the safety keys are human-only — set/reset refuse them
//       (lib + CLI), a settings.json value cannot weaken them (the guard still
//       blocks), while /config (CLAUDE_PLUGIN_OPTION_*) and env still can.
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

test('SAFETY: settings.set / settings.reset refuse every locked key and write nothing', () => {
  const home = tmpHome();
  try {
    for (const k of LOCKED_KEYS) {
      const [sec, key] = split(k);
      const e = schema.findSetting(sec, key);
      const v = e.type === 'boolean' ? String(!e.default) : '**';
      const s = settings.set(sec, key, v, { home });
      assert.strictEqual(s.ok, false, k);
      assert.strictEqual(s.locked, true, k);
      assert.match(s.error, /safety guard — change it yourself in \/config \(anti-hall rows\)/);
      const r = settings.reset(sec, key, { home });
      assert.strictEqual(r.ok, false, k);
      assert.match(r.error, /safety guard — change it yourself in \/config \(anti-hall rows\)/);
    }
    assert.ok(!fs.existsSync(settings.path({ home })), 'a refused write must not create settings.json');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: the CLI `set` and `reset` refuse locked keys with the /config message (exit 1, text + --json)', () => {
  const home = tmpHome();
  try {
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    for (const k of LOCKED_KEYS) {
      for (const args of [['set', k, 'false'], ['reset', k], ['set', k, 'false', '--json']]) {
        const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
        assert.strictEqual(r.status, 1, args.join(' '));
        assert.match(r.stdout + r.stderr, /safety guard — change it yourself in \/config \(anti-hall rows\)/, args.join(' '));
      }
    }
    assert.ok(!fs.existsSync(path.join(home, '.anti-hall', 'settings.json')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: a hand-edited settings.json cannot weaken a locked key (get ignores it; source is not "file")', () => {
  const home = tmpHome();
  try {
    writeSettings(home, {
      safety: { gitGuard: false, commandGuard: false, editGuard: false, swarmGuard: false },
      guards: { editGuardAllow: '**', allowSubagentMailbox: true },
    });
    for (const k of ['safety.gitGuard', 'safety.commandGuard', 'safety.editGuard', 'safety.swarmGuard']) {
      const [sec, key] = split(k);
      assert.strictEqual(settings.get(sec, key, undefined, { home, env: {} }), true, k);
      assert.strictEqual(settings.enabled(sec, key, { home, env: {} }), true, k);
      assert.strictEqual(settings.source(sec, key, { home, env: {} }), 'default', k);
    }
    assert.strictEqual(settings.get('guards', 'editGuardAllow', undefined, { home, env: {} }), '');
    assert.strictEqual(settings.get('guards', 'allowSubagentMailbox', undefined, { home, env: {} }), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: settings.json may still TIGHTEN a locked key (arming guards.stashGuard keeps working)', () => {
  const home = tmpHome();
  try {
    writeSettings(home, { guards: { stashGuard: true } });
    assert.strictEqual(settings.get('guards', 'stashGuard', undefined, { home, env: {} }), true);
    assert.strictEqual(settings.source('guards', 'stashGuard', { home, env: {} }), 'file');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('SAFETY: /config (pluginConfigs in ~/.claude/settings.json) and env DO change a locked key', () => {
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

test('SAFETY: git-guard still blocks a force-push when settings.json says safety.gitGuard=false', () => {
  const h = makeHome();
  try {
    writeSettings(h.home, { safety: { gitGuard: false } });
    const r = testHook('git-guard.js', bashPayload('git push --force origin main'), { home: h.home });
    assert.ok(blocked(r), 'an agent-writable file must not disable git-guard; stdout=' + r.stdout);
  } finally { h.cleanup(); }
});

test('SAFETY: edit-guard still blocks when settings.json widens editGuardAllow or turns editGuard off', () => {
  const h = makeHome();
  try {
    writeSettings(h.home, { safety: { editGuard: false }, guards: { editGuardAllow: '**' } });
    const r = testHook('edit-guard.js', editPayload('Edit', { filePath: 'src/app.js' }), { home: h.home, env: COORD });
    assert.ok(blocked(r), 'stdout=' + r.stdout);
  } finally { h.cleanup(); }
});

test('SAFETY: command-guard core still blocks when settings.json says safety.commandGuard=false', () => {
  const h = makeHome();
  try {
    writeSettings(h.home, { safety: { commandGuard: false } });
    const r = testHook('command-guard.js', bashPayload('npm run build'), { home: h.home, env: COORD });
    assert.ok(blocked(r), 'stdout=' + r.stdout);
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
    assert.match(out, /gitGuard \(safety: \/config only\)/);
    assert.match(out, /## Not toggleable/);
    for (const n of schema.NOT_TOGGLEABLE) assert.ok(out.includes('`' + n.name + '`'), n.name);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
