'use strict';
// Jev dispatchTier — advisory workspace / workflow / subagent recommendation on
// task-tracker's DISPATCH NOW line (hooks/lib/dispatch-tier.js), plus the
// PostToolUse TaskCreate/TaskUpdate trigger (hooks/dispatch-tier.js).
// Verdicts come from the jev-assist cache (seeded here), so no test touches
// the network except the PostToolUse one, which uses a local mock server.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { buildIdentityFixtures } = require('../helpers/git-fixtures.js');
const dispatchTier = require('../../plugins/anti-hall/hooks/lib/dispatch-tier.js');

const TRACKER = 'task-tracker.js';
const HOOK = 'dispatch-tier.js';
const NO_DEDUPE = { ANTIHALL_EMIT_DEDUPE: '0' };
const JEV = require('../../plugins/anti-hall/hooks/lib/jev-assist.js');

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
function taskCreate(tu, subject, ts) {
  return { type: 'assistant', timestamp: ts || iso(30), message: { role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'TaskCreate', input: { subject } }] } };
}
function taskCreated(tu, n, subject, ts) {
  return { type: 'user', timestamp: ts || iso(30), message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result', content: 'Task #' + n + ' created successfully: ' + subject }] } };
}
function toolUse(name, input, ts) {
  return { type: 'assistant', timestamp: ts || new Date(Date.now() + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + name + Math.random().toString(16).slice(2), name, input }] } };
}
function tasks(subjects) {
  const out = [];
  subjects.forEach((s, i) => { out.push(taskCreate('toolu_c' + (i + 1), s)); out.push(taskCreated('toolu_c' + (i + 1), i + 1, s)); });
  return out;
}

// seed(home, {subject: [tier, conf]}) -> writes jev.json (enabled) + cache verdicts.
function seed(h, verdicts, jevJson) {
  h.writeState('jev.json', Object.assign({ enabled: true }, jevJson || {}));
  const cache = {};
  let seq = 1;
  for (const [text, [answer, confidence]] of Object.entries(verdicts)) {
    const hash = JEV.prepare({ id: 'dispatchTier', home: h.home, trust: 'advisory', baseline: null, cacheKey: text, state: text }).hash;
    cache[hash] = { answer, confidence, _seq: seq++ };
  }
  fs.mkdirSync(path.join(h.antiHall, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(h.antiHall, 'cache', 'jev-assist.json'), JSON.stringify(cache));
}
function neutralCwd() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-dt-cwd-')); }
function payload(tp, cwd) { return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'go', cwd, transcript_path: tp }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function metrics(h) { try { return JSON.parse(fs.readFileSync(path.join(h.antiHall, 'dispatch-demand-metrics.json'), 'utf8')); } catch (_) { return {}; } }
function jevRows(h) {
  try { return fs.readFileSync(path.join(h.antiHall, 'logs', 'jev-assist.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
}

test('ON-ADVISORY (default): DISPATCH NOW line annotates each task with tier + confidence and "final call is yours"', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    seed(h, { 'mcp-reaper matcher': ['subagent', 0.91], 'meeseeks supervision': ['workflow', 0.83] });
    const tp = h.writeTranscript(tasks(['mcp-reaper matcher', 'meeseeks supervision']));
    const c = ctx(testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE }));
    assert.match(c, /#1 "mcp-reaper matcher" → subagent \(0\.91\)/, c);
    assert.match(c, /#2 "meeseeks supervision" → workflow \(0\.83\)/, c);
    assert.match(c, /Jev recommendation — final call is yours\./, c);
    assert.strictEqual(metrics(h).tier['verdict.subagent'], 1);
    assert.strictEqual(metrics(h).tier['verdict.workflow'], 1);
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('SHADOW: verdict is recorded but nothing is shown', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    seed(h, { 'alpha task': ['subagent', 0.9] }, { integrations: { dispatchTier: 'shadow' } });
    const tp = h.writeTranscript(tasks(['alpha task']));
    const c = ctx(testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE }));
    assert.match(c, /DISPATCH NOW in parallel/, c);
    assert.doesNotMatch(c, /→|Jev recommendation/, c);
    assert.strictEqual(metrics(h).tier['verdict.subagent'], 1, 'shadow still logs the verdict');
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('JEV ERROR / no verdict: no annotation and the injected text equals the Jev-off text', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    const tp = h.writeTranscript(tasks(['alpha task']));
    const off = ctx(testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE }));
    h.writeState('jev.json', { enabled: true });
    // Unreachable endpoint: the detached request fails; the line is unchanged.
    const env = Object.assign({ CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: 'http://127.0.0.1:9/none' }, NO_DEDUPE);
    const on = ctx(testHook(TRACKER, payload(tp, cwd), { home: h.home, env }));
    const line = (s) => s.slice(s.indexOf('DISPATCH NOW'));
    assert.doesNotMatch(on, /→|Jev recommendation/, on);
    assert.strictEqual(line(on), line(off));
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('REPO OVERRIDE: CLAUDE.md "no workspaces for real work" turns a workspace verdict into subagent (logged)', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '- **NO WORKSPACES FOR REAL WORK** in this repo.\n');
    fs.mkdirSync(path.join(cwd, '.git'));
    seed(h, { 'big feature': ['workspace', 0.95] });
    const tp = h.writeTranscript(tasks(['big feature']));
    const c = ctx(testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE }));
    assert.match(c, /#1 "big feature" → subagent \(0\.95\)/, c);
    assert.doesNotMatch(c, /→ workspace/, c);
    assert.ok(jevRows(h).some((r) => r.type === 'outcome' && r.id === 'dispatchTier' && r.outcome === 'repo-override-subagent'));
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

// deadly-loop round-1 finding (4): noWorkspaceRepo's own hand-rolled `.git`
// walk stopped at a SUBMODULE's own `.git` FILE, so it never reached the
// superproject's CLAUDE.md doctrine. Fixed by routing through
// companion/lib/identity.js#resolveContext's worktreeRoot (the same
// canonical, submodule-aware resolver every other caller uses).
test('noWorkspaceRepo: cwd inside a submodule reaches the SUPERPROJECT CLAUDE.md doctrine, not just the submodule\'s own', () => {
  const fx = buildIdentityFixtures();
  try {
    fs.writeFileSync(path.join(fx.main, 'CLAUDE.md'), '- **NO WORKSPACES FOR REAL WORK** in this repo.\n');
    assert.strictEqual(dispatchTier.noWorkspaceRepo(fx.cwds['main/libs/sub'], fx.home), true,
      'a submodule cwd must still see the superproject doctrine');
    assert.strictEqual(dispatchTier.noWorkspaceRepo(fx.main, fx.home), true);
  } finally { fx.cleanup(); }
});

test('REPO OVERRIDE via setting jev.dispatchTierNoWorkspaceRepos="*"', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    seed(h, { 'big feature': ['workspace', 0.95] });
    const tp = h.writeTranscript(tasks(['big feature']));
    const env = Object.assign({ ANTIHALL_JEV_DISPATCH_TIER_NO_WORKSPACE_REPOS: '*' }, NO_DEDUPE);
    assert.match(ctx(testHook(TRACKER, payload(tp, cwd), { home: h.home, env })), /→ subagent \(0\.95\)/);
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('OVERRIDDEN: the Primary dispatches a subagent-tier task via a Workflow -> logged "overridden"', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    seed(h, { 'alpha task': ['subagent', 0.9] });
    const tp = h.writeTranscript(tasks(['alpha task']));
    testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE });
    fs.appendFileSync(tp, JSON.stringify(toolUse('Workflow', { script: 'fan out #1 over files' })) + '\n');
    testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE });
    assert.strictEqual(metrics(h).tier.overridden, 1, JSON.stringify(metrics(h)));
    const outs = jevRows(h).filter((r) => r.type === 'outcome' && r.id === 'dispatchTier').map((r) => r.outcome);
    assert.ok(outs.includes('overridden') && outs.includes('dispatched-workflow'), outs.join(','));
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('FOLLOWED + ONE-LANE: one Agent names #1, the task completes -> followed, one-lane', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    seed(h, { 'alpha task': ['subagent', 0.9] });
    const tp = h.writeTranscript(tasks(['alpha task']));
    testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE });
    fs.appendFileSync(tp, JSON.stringify(toolUse('Agent', { description: 'Lane #1 alpha', prompt: 'x' })) + '\n' +
      JSON.stringify(toolUse('TaskUpdate', { taskId: '1', status: 'completed' })) + '\n');
    testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE });
    const t = metrics(h).tier;
    assert.strictEqual(t.followed, 1, JSON.stringify(t));
    assert.strictEqual(t.subagentOneLane, 1, JSON.stringify(t));
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('WORKFLOW FAN-OUT: a workflow-tier task dispatched as 3 agents -> overridden (not a Workflow) but fanned-out', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    seed(h, { 'sweep everything': ['workflow', 0.88] });
    const tp = h.writeTranscript(tasks(['sweep everything']));
    testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE });
    const spawns = [1, 2, 3].map((i) => JSON.stringify(toolUse('Agent', { description: 'shard ' + i + ' of #1', prompt: 'x' }))).join('\n');
    fs.appendFileSync(tp, spawns + '\n');
    testHook(TRACKER, payload(tp, cwd), { home: h.home, env: NO_DEDUPE });
    const t = metrics(h).tier;
    assert.strictEqual(t.overridden, 1, 'dispatched as agents, not a Workflow: ' + JSON.stringify(t));
    assert.strictEqual(t.workflowFannedOut, 1, JSON.stringify(t));
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('POSTTOOLUSE TaskCreate: asks Jev once (detached) and caches the verdict by text hash', async () => {
  const h = makeHome(); const cwd = neutralCwd();
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { calls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ answers: { decision: { choice: 'subagent', confidence: 0.9 } } })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    h.writeState('jev.json', { enabled: true });
    const env = { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/mock' };
    const p = { hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'fix the matcher', description: 'one scoped fix' }, session_id: 't', cwd };
    const r = testHook(HOOK, p, { home: h.home, env });
    assert.strictEqual(r.status, 0);
    let row = null;
    for (let i = 0; i < 60 && !row; i++) {
      row = jevRows(h).find((x) => x.id === 'dispatchTier' && x.backend === 'jev');
      if (!row) await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(row, 'detached worker must log a dispatchTier decision row');
    assert.strictEqual(row.jev, 'subagent');
    // Same text again -> cached -> no second network call.
    testHook(HOOK, p, { home: h.home, env });
    await new Promise((res) => setTimeout(res, 300));
    assert.strictEqual(calls, 1);
    // OWNER-blocked task is never classified.
    testHook(HOOK, Object.assign({}, p, { tool_input: { subject: 'OWNER: decide pricing' } }), { home: h.home, env });
    await new Promise((res) => setTimeout(res, 300));
    assert.strictEqual(calls, 1);
  } finally { server.close(); h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('JEV OFF (no jev.json): PostToolUse makes no call and logs nothing', () => {
  const h = makeHome(); const cwd = neutralCwd();
  try {
    const p = { hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'x' }, session_id: 't', cwd };
    assert.strictEqual(testHook(HOOK, p, { home: h.home }).status, 0);
    assert.strictEqual(jevRows(h).length, 0);
  } finally { h.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
