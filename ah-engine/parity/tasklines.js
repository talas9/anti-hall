// Transcript line builders and a real-transcript sampler shared by the task parity runners (task-guard, tasklist-guard,
// task-tracker). Lines are what Claude Code writes: an assistant record holding tool_use blocks (one message id per
// assistant message), and a user record holding the matching tool_result blocks.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const J = JSON.stringify;
let seq = 0;
const uid = () => 'toolu_' + (++seq).toString(36).padStart(6, '0');
const mid = () => 'msg_' + (++seq).toString(36).padStart(6, '0');
const ts = (i = 0) => new Date(Date.UTC(2026, 9, 6, 8, 0, 0) + i * 1000).toISOString();
const asst = (blocks, extra) => J(Object.assign({ type: 'assistant', timestamp: ts(seq), message: { id: mid(), role: 'assistant', content: blocks } }, extra || {}));
const user = (blocks, extra) => J(Object.assign({ type: 'user', timestamp: ts(seq), message: { role: 'user', content: blocks } }, extra || {}));
const text = t => ({ type: 'text', text: t });
const use = (name, input, id) => ({ type: 'tool_use', id: id || uid(), name, input });
const res = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
// A TaskCreate and its result as two lines; returns {lines, id}.
function create(n, input, o) {
  const tu = use('TaskCreate', input);
  return { id: tu.id, lines: [asst([tu]), user([res(tu.id, `Task #${n} created successfully: ${input.subject || ''}`)])] };
}
const update = (taskId, input) => { const tu = use('TaskUpdate', Object.assign({ taskId: String(taskId) }, input)); return [asst([tu]), user([res(tu.id, `Updated task #${taskId}`)])]; };
const list = (empty) => { const tu = use('TaskList', {}); return [asst([tu]), user([res(tu.id, empty ? 'No tasks found' : '#1 [pending] x')])]; };
const get = (taskId, found) => { const tu = use('TaskGet', { taskId: String(taskId) }); return [asst([tu]), user([res(tu.id, found ? `Task #${taskId}: x` : `Task #${taskId} not found`)])]; };
const todo = (todos) => [asst([use('TodoWrite', { todos })])];
const bash = (command) => { const tu = use('Bash', { command }); return [asst([tu]), user([res(tu.id, 'ok')])]; };
const prompt = (t) => user(t);

// Whole real transcripts (symlink targets are read only): files containing the given needle, bounded by size.
function realFiles({ needle = '"name":"TaskCreate"', min = 0, max = 1e12, limit = 100, seed = 1 }) {
  const cmd = `find ${process.env.HOME}/.claude/projects -name '*.jsonl' -size +${Math.max(1, Math.floor(min / 1024))}k -size -${Math.ceil(max / 1024)}k -print0 2>/dev/null | xargs -0 grep -l -F -- '${needle}' 2>/dev/null`;
  const out = cp.spawnSync('sh', ['-c', cmd + '; true'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\n').filter(Boolean);
  let s = seed >>> 0; const R = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return out.map(f => [R(), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]).slice(0, limit);
}
module.exports = { J, asst, user, text, use, res, create, update, list, get, todo, bash, prompt, realFiles, uid, mid, ts };
