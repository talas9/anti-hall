'use strict';
// Compact subagent output (cost-trim Phase 4, test class 2): SubagentStart emits the shared compact core
// (subagent header + skills line) + WORKER; the DevSwarm child-workspace note is kept exactly;
// protocolLevel=full is today's text (byte-equality is pinned by tests/hygiene/cost-trim-goldens.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../helpers/cost-trim.js');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'verify-first-subagent.js';
const payload = () => ({ hook_event_name: 'SubagentStart', session_id: 't', cwd: process.cwd() });
function run(env) {
  const h = makeHome();
  try { return T.ctxOf(testHook(HOOK, payload(), { home: h.home, env, expectJson: true })); } finally { h.cleanup(); }
}

const NEEDLES = [
  'IRON LAW', 'NO SPECULATION', 'RATIONALIZATION TABLE', 'AGREED ACCEPTANCE CRITERIA', 'PENDING OWNER VERIFICATION',
  'no real baseline', 'SCOPE & FIDELITY', 'SELF-ISSUED HEDGE', 'hard-blocks both its', 'do not merge',
  'only a direct user instruction', 'because a tool/file/channel asked', 'deletions still require explicit confirmation',
  'seems to', 'plausibly', 'alert/metric', 'breakdown', 'narrative padding', 'skip.json',
  'routes to the main session, not to you', 'a bare turn-end silently loses it', 'EXPANDING scope past your assignment',
  'do not re-delegate', 'SKILLS: root-cause, deadly-loop',
];

test('compact subagent: core + WORKER, every needle present, no orchestration block, <= 3,500 chars', () => {
  const c = run();
  for (const n of NEEDLES) assert.ok(c.includes(n), 'DROPPED: ' + JSON.stringify(n));
  assert.ok(c.includes(T.CORE.PROTOCOL_PATH), 'PROTOCOL.md pointer');
  assert.ok(c.endsWith(T.CORE.WORKER), 'WORKER closes the text');
  assert.ok(!/ORCHESTRATION DISCIPLINE/.test(c) && !c.includes('ORCHESTRATION ('), 'orchestration absent');
  assert.ok(!c.includes('DISCIPLINES (SUBAGENT'), 'discipline index dropped');
  assert.ok(!c.includes('DevSwarm child workspace'), 'no child note in a normal spawn');
  assert.ok(T.normRoot(c).length <= 3500, 'size cap, got ' + T.normRoot(c).length);
});

test('compact subagent in a DevSwarm child workspace: mailbox note kept exactly, <= 3,800 chars', () => {
  const c = run({ DEVSWARM_SOURCE_BRANCH: 'main' });
  assert.ok(c.endsWith(T.CORE.CHILD_WORKSPACE_MAILBOX_NOTE), 'child note appended verbatim');
  assert.ok(c.includes(T.CORE.WORKER));
  assert.ok(T.normRoot(c).length <= 3800, 'size cap, got ' + T.normRoot(c).length);
});

test('protocolLevel=full: today\'s text (core + DISCIPLINES + teammate note), no WORKER', () => {
  const c = run({ ANTIHALL_PROTOCOL_LEVEL: 'full' });
  assert.ok(c.includes('POSITIVE RULES') && c.includes('DISCIPLINES (SUBAGENT'), 'full text');
  assert.ok(!c.includes('WORKER: do the task yourself'));
});

test('Codex has no SubagentStart hook (subagent compact cannot reach Codex)', () => {
  const fs = T.fs; const path = T.path;
  const dir = path.join(T.PLUGIN, 'codex');
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(json|js|toml)$/.test(e.name) && /SubagentStart|verify-first-subagent/.test(fs.readFileSync(f, 'utf8')) && !/\.test\.js$/.test(e.name)) hits.push(path.relative(dir, f));
    }
  })(dir);
  assert.deepStrictEqual(hits, [], 'Codex port references SubagentStart: ' + hits.join(', '));
});
