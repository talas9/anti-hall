'use strict';
// anti-hall :: dispatch-demand — "is there dispatchable work nobody is on?"
//
// Shared by task-tracker (UserPromptSubmit: the per-turn DISPATCH NOW line) and
// task-guard (Stop: IDLE NEGLECT). Replaces the old blanket rule "any fresh
// ~/.anti-hall/agents/*.json heartbeat => suppress". That heartbeat
// (phase-tracker's recent-spawn.json) is ONE machine-global file refreshed by
// ANY Agent spawn in ANY session/project for 20 minutes, so a single spawn —
// here or in a parallel session — silenced the demand for every pending task.
//
// Coverage is now per task, from THIS session's transcript only
// (lib/agent-scan.js runningAgents: launched, not yet terminal):
//   - a running agent whose description names "#<id>" covers that task;
//   - a running agent naming no known task id is UNMAPPED: it is assumed to be
//     on an uncovered in_progress task first, else on at most one pending task.
// The demand fires when
//   uncovered actionable tasks > unmapped running agents  AND  running < cap
// which degrades to "pending > running && running < min(cap, pending)" when no
// agent can be mapped to a task.
//
// Metrics (~/.anti-hall/dispatch-demand-metrics.json, small counters only):
//   demandsShown       per-turn DISPATCH NOW lines emitted
//   demandsFollowed    of those, turns where an Agent/Workflow spawn followed
//                      within the SAME turn (resolved at the next prompt)
//   demandsIgnored     turns that ended with no spawn after the demand
//   idleNeglectBlocks  task-guard IDLE NEGLECT Stop blocks
// Fail-open everywhere: any error -> no metric, never a thrown hook.

const fs = require('fs');
const os = require('os');
const path = require('path');

const METRICS_FILE = 'dispatch-demand-metrics.json';
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function defaultCap() {
  let cores = 4;
  try { cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 4; } catch (_) {}
  return Math.max(1, Math.min(16, cores - 2));
}

// configuredCap() — guards.maxParallelDispatch (0 = unset -> the dynamic
// defaultCap() above). Some owners deliberately run ONE implementation agent
// per workspace at a time; setting this to 1 makes the dispatch demand (and
// task-guard IDLE NEGLECT, which shares this same evaluate()) ask for the
// NEXT task only once nothing is running — running.length < cap already
// implements that once cap itself is 1, with no fake blockedBy needed.
function configuredCap() {
  try {
    const v = require('./settings.js').get('guards', 'maxParallelDispatch', 0);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch (_) { /* fall through */ }
  return defaultCap();
}

function enabled() {
  try { return require('./settings.js').get('guards', 'dispatchDemand', true) !== false; } catch (_) { return true; }
}

// taskRefs(text) -> Set of numeric ids referenced as "#<n>" in text.
function taskRefs(text) {
  const out = new Set();
  if (typeof text !== 'string') return out;
  for (const m of text.matchAll(/#(\d+)\b/g)) out.add(m[1]);
  return out;
}

// evaluate({ actionable, knownIds, inProgressIds, running, cap }) ->
//   { fire, dispatch: [task], covered: [id], unmapped, running, cap }
// running: [{ description }] from agent-scan.runningAgents (null => treated as []).
function evaluate(opts) {
  const actionable = (opts && opts.actionable) || [];
  const running = (opts && Array.isArray(opts.running)) ? opts.running : [];
  const cap = (opts && Number.isFinite(opts.cap) && opts.cap > 0) ? opts.cap : configuredCap();
  const known = new Set(((opts && opts.knownIds) || actionable.map((t) => t.id)).map(String));
  const covered = new Set();
  let unmapped = 0;
  for (const a of running) {
    const refs = [...taskRefs(a && a.description)].filter((id) => known.has(id));
    if (refs.length === 0) unmapped++;
    for (const id of refs) covered.add(id);
  }
  // An agent that names no task is most likely on an in_progress task (that is
  // what "in_progress" means): unmapped agents first absorb uncovered
  // in_progress tasks, and only the remainder is assumed to be on pending work.
  const inProgress = ((opts && opts.inProgressIds) || []).map(String).filter((id) => !covered.has(id)).length;
  const onPending = Math.max(0, unmapped - inProgress);
  const dispatch = actionable.filter((t) => !covered.has(String(t.id)));
  const fire = dispatch.length > 0 && dispatch.length > onPending && running.length < cap;
  return { fire, dispatch, covered: [...covered], unmapped, running: running.length, cap };
}

function oneLine(s, max) {
  if (typeof s !== 'string') return '';
  let o = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + '…';
  return o;
}

// label(task) -> '#7 "mcp-reaper matcher misses…"' (numeric ids get a '#';
// the subject is control-stripped, a leading "P1:"-style priority tag dropped,
// and JSON-quoted so task text stays an inert string in injected context).
function label(t, max) {
  const id = String(t.id);
  const subj = oneLine(String(t.content || t.subject || id).replace(/^\s*P\d\s*[:\-—]\s*/i, ''), max || 40);
  const quoted = JSON.stringify(subj || id);
  if (!/^\d+$/.test(id)) return quoted;
  return subj && subj !== id ? '#' + id + ' ' + quoted : '#' + id;
}

// demandLine(result, { annotate }) -> the one-line per-turn demand.
// annotate(task) -> optional suffix string (e.g. a Jev tier recommendation).
function demandLine(res, opts) {
  const annotate = opts && typeof opts.annotate === 'function' ? opts.annotate : null;
  const shown = res.dispatch.slice(0, 12).map((t) => {
    let s = label(t);
    if (annotate) { try { const a = annotate(t); if (a) s += ' ' + a; } catch (_) {} }
    return s;
  });
  const more = res.dispatch.length > 12 ? ', +' + (res.dispatch.length - 12) + ' more' : '';
  return 'DISPATCH NOW in parallel — one background agent EACH, this turn (' +
    res.running + ' running, cap ' + res.cap + '): ' + shown.join(', ') + more +
    '. Pending, unblocked, unowned, and no in-flight agent names them. Hold one only if it ' +
    'truly needs the user (then mark it metadata.blockedOn:\'owner\').';
}

// ---- metrics ---------------------------------------------------------------

function metricsPath(home) {
  return path.join(require('../../companion/lib/test-home-guard.js').resolveHome(home, process.env), '.anti-hall', METRICS_FILE);
}

function readMetrics(home) {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(metricsPath(home), 'utf8')); } catch (_) { m = null; }
  if (!m || typeof m !== 'object') m = {};
  for (const k of ['demandsShown', 'demandsFollowed', 'demandsIgnored', 'idleNeglectBlocks']) {
    if (!Number.isFinite(m[k]) || m[k] < 0) m[k] = 0;
  }
  if (!m.pending || typeof m.pending !== 'object') m.pending = {};
  return m;
}

function writeMetrics(home, m) {
  try {
    const p = metricsPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) { /* fail-open */ }
}

function sessionKey(sid) {
  return String(sid || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

// spawnedSince(transcriptPath, sinceMs) -> true when an Agent / Task / Workflow
// tool_use with a timestamp >= sinceMs is in the transcript tail.
function spawnedSince(transcriptPath, sinceMs) {
  let lines;
  try { lines = require('./transcript-tail.js').readTail(transcriptPath); } catch (_) { lines = null; }
  if (!lines) return false;
  for (const raw of lines) {
    if (raw.indexOf('"tool_use"') === -1) continue;
    if (!/"name":\s*"(Agent|Task|Workflow)"/.test(raw)) continue;
    let e;
    try { e = JSON.parse(raw); } catch (_) { continue; }
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const c = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    if (c.some((b) => b && b.type === 'tool_use' && /^(Agent|Task|Workflow)$/.test(b.name || ''))) return true;
  }
  return false;
}

// resolvePending — called at the START of the next turn (UserPromptSubmit):
// the previous turn's demand is scored followed/ignored exactly once.
function resolvePending(opts) {
  if (!opts || !opts.home) return;
  try {
    const m = readMetrics(opts.home);
    const key = sessionKey(opts.sessionId);
    const now = opts.now || Date.now();
    let dirty = false;
    for (const [k, v] of Object.entries(m.pending)) {
      if (!v || !Number.isFinite(v.ts) || now - v.ts > PENDING_TTL_MS) { delete m.pending[k]; dirty = true; }
    }
    const p = m.pending[key];
    if (p && opts.transcriptPath) {
      if (spawnedSince(opts.transcriptPath, p.ts)) m.demandsFollowed++;
      else m.demandsIgnored++;
      delete m.pending[key];
      dirty = true;
    }
    if (dirty) writeMetrics(opts.home, m);
  } catch (_) { /* fail-open */ }
}

function recordDemand(opts) {
  if (!opts || !opts.home) return;
  try {
    const m = readMetrics(opts.home);
    m.demandsShown++;
    m.pending[sessionKey(opts.sessionId)] = { ts: opts.now || Date.now(), n: opts.count || 0 };
    writeMetrics(opts.home, m);
  } catch (_) { /* fail-open */ }
}

function recordIdleNeglect(opts) {
  if (!opts || !opts.home) return;
  try {
    const m = readMetrics(opts && opts.home);
    m.idleNeglectBlocks++;
    writeMetrics(opts && opts.home, m);
  } catch (_) { /* fail-open */ }
}

// summary(home) -> { demandsShown, demandsFollowed, demandsIgnored, complianceRate, idleNeglectBlocks }
function summary(home) {
  const m = readMetrics(home);
  const scored = m.demandsFollowed + m.demandsIgnored;
  return {
    demandsShown: m.demandsShown,
    demandsFollowed: m.demandsFollowed,
    demandsIgnored: m.demandsIgnored,
    complianceRate: scored ? m.demandsFollowed / scored : null,
    idleNeglectBlocks: m.idleNeglectBlocks,
  };
}

module.exports = {
  evaluate, demandLine, label, taskRefs, defaultCap, configuredCap, enabled,
  resolvePending, recordDemand, recordIdleNeglect, summary, readMetrics, metricsPath, spawnedSince,
};

// ---- shared task classification helpers -------------------------------------

// OWNER-BLOCKED marker (moved here from task-guard so task-tracker's per-turn
// demand and task-guard's IDLE NEGLECT agree): metadata.blockedOn / blockedOn
// === owner|user|human|external, or an "OWNER:" / "OWNER DECISION" subject
// prefix => not dispatchable. Setting guards.taskGuardOwnerBlockedMarker
// (default on; fail-open to honoring the marker).
const OWNER_BLOCKED_VALUES = new Set(['owner', 'user', 'human', 'external']);
const OWNER_SUBJECT_RE = /^\s*owner(:|\s+decision\b)/i;
function isOwnerBlocked(t) {
  try {
    if (!require('./settings.js').enabled('guards', 'taskGuardOwnerBlockedMarker')) return false;
  } catch (_) { /* fail open -> marker still honored */ }
  const bo = t && typeof t.blockedOn === 'string' ? t.blockedOn.trim().toLowerCase() : '';
  if (OWNER_BLOCKED_VALUES.has(bo)) return true;
  const subject = (t && (t.content || t.subject)) || '';
  return typeof subject === 'string' && OWNER_SUBJECT_RE.test(subject);
}

// blockedByAfterUpdate(existing, inp) — TaskUpdate carries EITHER a full
// `blockedBy` replacement OR the harness's incremental `addBlockedBy` (the
// shape real transcripts use: {"taskId":"5","addBlockedBy":["4"]}). Missing
// both => keep the existing list.
function blockedByAfterUpdate(existing, inp, norm) {
  let out = inp.blockedBy !== undefined ? norm(inp.blockedBy) : (existing || []).slice();
  if (inp.addBlockedBy !== undefined) {
    for (const id of norm(inp.addBlockedBy)) if (!out.includes(id)) out.push(id);
  }
  return out;
}

module.exports.isOwnerBlocked = isOwnerBlocked;
module.exports.blockedByAfterUpdate = blockedByAfterUpdate;

// maxNumericKey(map) -> the highest all-digit key (0 if none). Used by the
// task parsers' list-epoch detection ("Task #1 created" after #50 existed).
function maxNumericKey(map) {
  let max = 0;
  for (const k of map.keys()) if (/^\d+$/.test(String(k))) max = Math.max(max, Number(k));
  return max;
}
module.exports.maxNumericKey = maxNumericKey;

// isTaskListEmptyText(text) / isTaskNotFoundText(text) -> true when a
// tool_result string is direct evidence that the harness's OWN task store no
// longer matches whatever this hook reconstructed from the transcript — i.e.
// a TASK-LIST EPOCH boundary (restart, or a usage-limit resume that reset the
// native task list back to "no tasks" / renumbered ids from 1). Two anchored
// shapes, mirroring the "Task #N created successfully" match this file's
// callers already parse:
//   - TaskList             -> "No tasks found"   (the store is empty NOW)
//   - TaskGet / TaskUpdate -> "Task not found"    (an id we hold is stale)
// Anchored at the start of the result text (after optional whitespace) so an
// unrelated tool result that merely CONTAINS the phrase mid-sentence never
// false-positives. Field: after a restart/resume the harness's task list
// resets and ids restart at 1, but task-guard/task-tracker kept reporting
// "Open tasks remain … id 3" from the PREVIOUS process's ids still sitting in
// the scan window with no new "Task #N created" to trigger the existing
// id-restart reset.
//
// deadly-loop round-1 finding (2): text content alone is NOT proof of which
// tool produced it — a Bash command that happens to print "No tasks found",
// or a TaskGet call for a mistyped id, must not wipe the WHOLE reconstructed
// task map (silencing IDLE NEGLECT for every other still-open task). Callers
// MUST pair these text checks with the tool_use_id -> tool name they
// reconstructed from the transcript's own assistant tool_use entries:
// isTaskListEmptyText only after confirming the result's tool_use_id names a
// TaskList call; isTaskNotFoundText only after confirming TaskGet/TaskUpdate
// — and even then a "Task not found" only drops that ONE id, never the
// whole map (see task-guard.js parseTasksFromFile).
function isTaskListEmptyText(text) {
  return typeof text === 'string' && /^\s*No\s+tasks\s+found\b/i.test(text);
}
function isTaskNotFoundText(text) {
  return typeof text === 'string' && /^\s*Task\s*(?:#\S+)?\s*not\s+found\b/i.test(text);
}
module.exports.isTaskListEmptyText = isTaskListEmptyText;
module.exports.isTaskNotFoundText = isTaskNotFoundText;
