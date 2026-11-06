// Node twin of the engine's blob_tests (#438): rows that only replay an API request (api-request-blob and kin) are not the
// conversation, so the task model never reads them. Run directly: node tests/node/task-blobrows.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = process.env.AH_NODE_HOOKS || path.join(__dirname, '..', '..', 'plugins', 'anti-hall-node', 'hooks');
const TS = require(path.join(HOOKS, 'lib', 'task-state.js'));

const call = (id, name, input) => ({ type: 'assistant', message: { id: 'm-' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const blob = (type, rows) => ({ type, message: { messages: rows.map((r) => r.message) } });
const tail = (rows) => ({ data: rows.map((r) => JSON.stringify(r)).join('\n') + '\n', truncated: false });
const ids = (rows) => Array.from(TS.reconstructTasks(tail(rows)).taskMap.keys());
const replay = () => [call('toolu_a', 'TaskCreate', { subject: 'ghost a' }), call('toolu_b', 'TaskCreate', { subject: 'ghost b' })];

test('which rows are the conversation', () => {
  assert.ok(TS.isConversationRow({ type: 'user' }) && TS.isConversationRow({ type: 'assistant' }));
  assert.ok(TS.isConversationRow({ message: {} }), 'no type: legacy shape is read');
  for (const k of ['api-request-blob', 'api-request', 'api-request-shape']) assert.ok(!TS.isConversationRow({ type: k }), k);
});

test('reconstructTasks: replayed creates make no ghosts, a real unresolved create stays once', () => {
  for (const k of ['api-request-blob', 'api-request', 'api-request-shape']) assert.deepStrictEqual(ids([blob(k, replay())]), [], k);
  const real = [call('toolu_r', 'TaskCreate', { subject: 'real' }), result('toolu_r', 'Task #1 created successfully: real')];
  assert.deepStrictEqual(ids([...real, blob('api-request-blob', replay().concat(real[0]))]), ['1']);
  const un = call('toolu_u', 'TaskCreate', { subject: 'unresolved' });
  assert.deepStrictEqual(ids([un, blob('api-request-blob', [un])]), ['toolu_u']);
});

function runHook(file, transcriptRows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah438n-'));
  fs.mkdirSync(path.join(dir, 'home', '.anti-hall'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'proj', '.git'), { recursive: true });
  const t = path.join(dir, 't.jsonl');
  fs.writeFileSync(t, transcriptRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 's438', cwd: path.join(dir, 'proj'), transcript_path: t });
  const r = spawnSync('node', [path.join(HOOKS, file)], { input: payload, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.join(dir, 'home') } });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('task-guard Stop: replayed creates in a blob row do not block, the same creates in conversation rows do', () => {
  const ghosts = [1, 2, 3, 4].map((i) => call('toolu_g' + i, 'TaskCreate', { subject: 'ghost ' + i }));
  const end = { type: 'assistant', message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
  const quiet = runHook('task-guard.js', [blob('api-request-blob', ghosts), end]);
  assert.ok(!/"decision"\s*:\s*"block"/.test(quiet.stdout), quiet.stdout + quiet.stderr);
  const loud = runHook('task-guard.js', [...ghosts, end]);
  assert.ok(/"decision"\s*:\s*"block"/.test(loud.stdout), 'control: the same creates as conversation rows block: ' + loud.stdout + loud.stderr);
});
