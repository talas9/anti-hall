'use strict';
// guards.sharedTreeAgentNote: swarm-guard adds an ADVISORY (never a block) when a
// write-capable spawn without isolation:"worktree" starts while another
// write-capable agent is still running in the same working tree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'anti-hall');

function launch(tuid, agentId, input) {
  const text = 'Async agent launched successfully. (This tool result is internal metadata.)\n'
    + 'agentId: ' + agentId + " (internal ID - do not mention to user. Use SendMessage with to: '" + agentId + "')\n"
    + 'The agent is working in the background. You will be notified automatically when it completes.\n'
    + 'output_file: /tmp/none/' + agentId + '.output\n';
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: tuid, name: 'Agent', input }] } },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: tuid, type: 'tool_result', content: [{ type: 'text', text }] }] } },
  ];
}
const done = (agentId) => ({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>' + agentId + '</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>' });
const W1 = { description: 'writer one', prompt: 'x', subagent_type: 'general-purpose' };
const W2 = { description: 'writer two', prompt: 'x', subagent_type: 'oh-my-claudecode:executor' };
const A1 = 'a1a1a1a1a1a1a1a1a', A2 = 'b2b2b2b2b2b2b2b2b';

function run(entries, input, opts) {
  const h = makeHome();
  try {
    if (opts && opts.settings) fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify(opts.settings));
    let tp = path.join(h.home, 'missing.jsonl');
    if (entries) { tp = path.join(h.home, 't.jsonl'); fs.writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); }
    let cwd = h.home;
    if (opts && opts.doc) { cwd = path.join(h.home, 'repo'); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), opts.doc); }
    const r = testHook('swarm-guard.js', {
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input, session_id: 't', transcript_path: tp, cwd,
    }, { home: h.home });
    assert.strictEqual(r.status, 0, 'never blocks: ' + r.stdout);
    assert.ok(!(r.json && 'decision' in r.json), 'no decision field');
    return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  } finally { h.cleanup(); }
}
const two = () => [...launch('t1', A1, W1), ...launch('t2', A2, W2)];
const NEW = { description: 'third writer', prompt: 'x', subagent_type: 'general-purpose' };

test('two running write agents + new write spawn without isolation -> note offering worktree, serialize, scratch clones', () => {
  const n = run(two(), NEW);
  assert.match(n, /isolation:"worktree"/);
  assert.match(n, /serialize/);
  assert.match(n, /scratch clone/);
});

test('one running write agent is enough', () => {
  assert.match(run(launch('t1', A1, W1), NEW), /shared-tree:/);
});

test('new spawn with isolation:"worktree" -> silent', () => {
  assert.strictEqual(run(two(), { ...NEW, isolation: 'worktree' }), '');
});

test('read-only spawn (Explore, or a tool list without Edit/Write) -> silent', () => {
  assert.strictEqual(run(two(), { ...NEW, subagent_type: 'Explore' }), '');
  assert.strictEqual(run(two(), { ...NEW, tools: ['Read', 'Grep'] }), '');
});

test('other agent finished -> silent', () => {
  assert.strictEqual(run([...two(), done(A1), done(A2)], NEW), '');
});

test('other running agents read-only or isolated -> silent', () => {
  assert.strictEqual(run(launch('t1', A1, { ...W1, subagent_type: 'Explore' }), NEW), '');
  assert.strictEqual(run(launch('t1', A1, { ...W1, isolation: 'worktree' }), NEW), '');
});

test('unknown state (no transcript, or other agent spawn input not visible) -> silent', () => {
  assert.strictEqual(run(null, NEW), '');
  const noInput = launch('t1', A1, W1).map((e) => JSON.stringify(e)).filter((l) => l.indexOf('"tool_use"') === -1 || l.indexOf('tool_result') !== -1).map((l) => JSON.parse(l));
  assert.strictEqual(run(noInput, NEW), '');
});

test('setting off -> silent', () => {
  assert.strictEqual(run(two(), NEW, { settings: { guards: { sharedTreeAgentNote: false } } }), '');
});

test('repo that says no worktrees -> wording without worktree', () => {
  const n = run(two(), NEW, { doc: '- No worktrees, no branches: all work on main.\n' });
  assert.match(n, /scratch clone/);
  assert.match(n, /serialize/i);
  assert.ok(!/worktree/i.test(n), n);
});

test('schema: settings file + env only, no manifest row', () => {
  const e = require(path.join(PLUGIN, 'hooks', 'lib', 'settings-schema.js')).findSetting('guards', 'sharedTreeAgentNote');
  assert.ok(e);
  assert.strictEqual(e.default, true);
  assert.strictEqual(e.env, 'ANTIHALL_SHARED_TREE_AGENT_NOTE');
  assert.strictEqual(e.pluginOption, undefined);
  assert.strictEqual(e.advanced, true);
  const m = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(m.userConfig.guards_shared_tree_agent_note, undefined);
});
