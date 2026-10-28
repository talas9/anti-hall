'use strict';
// anti-hall :: idle-agents — agents that FINISHED but were never stopped/closed,
// read from this session's transcript. Used by hooks/idle-agent-sweep.js.
//
// Claude (named in-process teammates): lib/agent-scan.js replays each
// teammate's spawn / send / idle_notification / TaskStop events; a teammate
// whose newest event is an idle_notification with idleReason "available" or
// "failed", with no later SendMessage to it and no TaskStop, is finished-not-
// stopped (scan.finishedTeammates). It keeps its process and context alive
// until TaskStop. Background agents are not listed: their "completed"
// notification already ended them.
//
// Codex (multi_agent_v1 tools, rollout transcript): spawn_agent's output carries
// {"agent_id"}; wait_agent's output carries {"status":{"<id>":{"completed"|
// "errored": ...}}}; close_agent {"target"} closes it; send_input / resume_agent
// naming it re-tasks it. A finished agent left open holds a thread slot (field:
// "collab spawn failed: agent thread limit reached"). The newer "collaboration"
// tool set (spawn_agent -> task_name, wait_agent without ids) has no close tool,
// so there is nothing to recommend there and nothing is listed.

const CODEX_FINISHED_KEYS = ['completed', 'errored'];
const CODEX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJson(s) {
  if (typeof s !== 'string') return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
}

// Agent ids named by a Codex agent-tool call's arguments (target / targets / id / agent_id).
function codexArgIds(args) {
  const out = [];
  if (!args) return out;
  for (const k of ['target', 'id', 'agent_id']) if (typeof args[k] === 'string') out.push(args[k]);
  if (Array.isArray(args.targets)) for (const t of args.targets) if (typeof t === 'string') out.push(t);
  return out;
}

// codexFinished(lines) -> Map<agentId, {idleSinceMs, nickname}>
function codexFinished(lines) {
  const calls = new Map(); // call_id -> { name, args }
  const agents = new Map(); // id -> { state: 'busy'|'finished'|'closed', idleSinceMs, nickname }
  for (const raw of lines) {
    if (raw.indexOf('_agent') === -1 && raw.indexOf('send_input') === -1 && raw.indexOf('function_call_output') === -1) continue;
    const e = parseJson(raw);
    const p = e && e.payload;
    if (!p || typeof p !== 'object') continue;
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (p.type === 'function_call' && typeof p.call_id === 'string') {
      const name = String(p.name || '');
      if (!/^(spawn_agent|wait_agent|close_agent|send_input|resume_agent)$/.test(name)) continue;
      const args = parseJson(p.arguments);
      calls.set(p.call_id, { name, args });
      // close / re-task act at call time (the output is not needed).
      for (const id of codexArgIds(args)) {
        const a = agents.get(id);
        if (!a) continue;
        if (name === 'close_agent') a.state = 'closed';
        else if (name === 'send_input' || name === 'resume_agent') a.state = 'busy';
      }
      continue;
    }
    if (p.type !== 'function_call_output' || !calls.has(p.call_id)) continue;
    const call = calls.get(p.call_id);
    const out = parseJson(typeof p.output === 'string' ? p.output : '');
    if (!out) continue;
    if (call.name === 'spawn_agent' && typeof out.agent_id === 'string' && CODEX_ID_RE.test(out.agent_id)) {
      agents.set(out.agent_id, { state: 'busy', idleSinceMs: NaN, nickname: typeof out.nickname === 'string' ? out.nickname : '' });
    } else if (call.name === 'wait_agent' && out.status && typeof out.status === 'object') {
      for (const [id, st] of Object.entries(out.status)) {
        const a = agents.get(id);
        if (!a || a.state !== 'busy' || !st || typeof st !== 'object') continue;
        if (CODEX_FINISHED_KEYS.some((k) => Object.prototype.hasOwnProperty.call(st, k)) && Number.isFinite(ts)) {
          a.state = 'finished';
          a.idleSinceMs = ts;
        }
      }
    }
  }
  const res = new Map();
  for (const [id, a] of agents) if (a.state === 'finished') res.set(id, { idleSinceMs: a.idleSinceMs, nickname: a.nickname });
  return res;
}

// finishedAgents(transcriptPath, lines, opts) -> { codex: bool, agents: [{ id, label, idleSinceMs }] } | null
// Sorted oldest idle first. null when the transcript is unreadable.
function finishedAgents(transcriptPath, lines, opts) {
  const codex = !!(opts && opts.codex);
  if (!Array.isArray(lines)) return null;
  const agents = [];
  if (codex) {
    for (const [id, a] of codexFinished(lines)) agents.push({ id, label: a.nickname ? a.nickname + ' (' + id + ')' : id, idleSinceMs: a.idleSinceMs });
  } else {
    const scan = require('./agent-scan.js').scanTranscript(transcriptPath, lines, opts);
    if (!scan) return null;
    for (const [name, f] of scan.finishedTeammates || []) agents.push({ id: name, label: name, idleSinceMs: f.idleSinceMs });
  }
  agents.sort((a, b) => a.idleSinceMs - b.idleSinceMs);
  return { codex, agents };
}

// shouldFire(agents, nowMs, { count, minutes }) -> bool: >= count idle, or any idle >= minutes.
function shouldFire(agents, nowMs, th) {
  if (!agents.length) return false;
  if (agents.length >= th.count) return true;
  return agents.some((a) => nowMs - a.idleSinceMs >= th.minutes * 60000);
}

const MAX_NAMED = 10;

function oneLine(s, max) {
  let o = String(s).replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + '…';
  return o;
}

// message(result, nowMs) -> the advisory text.
function message(result, nowMs) {
  const list = result.agents;
  const shown = list.slice(0, MAX_NAMED).map((a) => oneLine(a.label, 60) + ' (' + Math.max(0, Math.floor((nowMs - a.idleSinceMs) / 60000)) + 'm)');
  const more = list.length > MAX_NAMED ? ', and ' + (list.length - MAX_NAMED) + ' more' : '';
  const first = list[0].id;
  const call = result.codex
    ? 'close_agent {"target":"' + first + '"}'
    : 'TaskStop {"task_id":"' + first + '"}';
  return require('./block-message.js').message({
    kind: 'tip',
    guard: 'idle-agents',
    what: list.length + ' finished agent' + (list.length === 1 ? ' is' : 's are') + ' idle and not ' + (result.codex ? 'closed' : 'stopped') + ': ' + shown.join(', ') + more + '.',
    why: (result.codex ? 'an open agent holds a thread slot' : 'each one keeps its process and context alive') + ' until it is ' + (result.codex ? 'closed' : 'stopped') + '.',
    instead: 'if you have no more work for them, ' + (result.codex ? 'close' : 'stop') + ' each one, e.g. ' + call + ' (one call per agent). Keep any you will re-task.',
  });
}

module.exports = { finishedAgents, codexFinished, shouldFire, message, MAX_NAMED };
