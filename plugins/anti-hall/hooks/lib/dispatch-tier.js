'use strict';
// anti-hall :: dispatch-tier — Jev integration `dispatchTier`: an ADVISORY
// recommendation of HOW each dispatchable task should be dispatched.
//
//   workspace  multi-step feature/fix/deploy that owns a branch + its own review
//              (a DevSwarm child workspace: `devswarm.js spawn`)
//   workflow   breadth-first / parallelisable: 3+ independent or nested spawns,
//              or a review fan-out (doctrine rule M: ONE deterministic Workflow)
//   subagent   a lookup, one scoped fix, a single command, a review pass
//
// It NEVER blocks, forces or overrides anything. In mode `on` (the default for
// this integration) task-tracker's DISPATCH NOW line annotates each task with
// "→ <tier> (<conf>)" plus "Jev recommendation — final call is yours"; in
// `shadow` it only logs; `off` (or Jev disabled / any error) = no annotation and
// the injected doctrine text is byte-for-byte unchanged.
//
// WHEN JEV IS ASKED: only when a task's TEXT changes — PostToolUse on
// TaskCreate/TaskUpdate (hooks/dispatch-tier.js) and, as a catch-up, the first
// turn a dispatchable task's text-hash has no cached verdict. Never per turn:
// the jev-assist cache is keyed by the text hash and a per-hash "requested"
// marker stops a repeat while the detached call is in flight. Input = subject +
// description, capped at 600 chars. askDetached only (zero hook latency).
//
// REPO OVERRIDE: a repo whose CLAUDE.md / AGENTS.md says "no workspaces for
// real work" (or that is listed in jev.dispatchTierNoWorkspaceRepos) never gets
// a `workspace` recommendation: Jev's `workspace` verdict is shown as
// `subagent` and logged as overridden-by-repo.
//
// MEASUREMENT (logged to jev-assist.ndjson via recordOutcome, keyed by the
// verdict hash, and counted in ~/.anti-hall/dispatch-demand-metrics.json `tier`):
//   verdict.<tier>          one per distinct task text classified
//   followed / overridden   the ACTUAL dispatch (Agent -> subagent, Workflow ->
//                           workflow, `devswarm.js spawn` -> workspace) of a task
//                           that had a recommendation, vs that recommendation
//   subagentOneLane / subagentEscalated
//                           subagent-tier tasks dispatched to an agent: completed
//                           by exactly one agent, or needed more agents / a
//                           workflow / a workspace
//   workflowFannedOut / workflowNoFanout
//                           workflow-tier tasks: dispatched via a Workflow or 3+
//                           agents, vs completed with fewer

const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = 'dispatchTier';
const TIERS = ['workspace', 'workflow', 'subagent'];
const TEXT_CAP = 600;
const QUESTION = {
  type: 'choice',
  instructions: 'Classify how an orchestrating agent should dispatch this task.',
  criteria: {
    workspace: 'a large multi-step feature, migration or release spanning several files or components over a long stretch of work, that needs its own branch and its own review (a separate child workspace). NOT a bug fix, UI text or copy change, or any task confined to one file or one component',
    workflow: 'breadth-first or parallelisable work: 3 or more clearly independent or nested agent spawns, or a review fan-out over many targets, best lifted into one deterministic workflow. NOT a single-file or single-component change, however important its priority label',
    subagent: 'the DEFAULT when unsure: a lookup, a bug fix, a UI text or copy change, any change confined to one file or one component, a single command, or a single review pass that one background agent can finish. A priority label (P0, P1, P2) says nothing about size',
  },
};
const STATE_FILE = 'dispatch-tier-state.json';
const REQUEST_TTL_MS = 10 * 60 * 1000;
// A workspace/workflow verdict below this confidence is shown as `subagent`
// (the cheapest tier; the advisory only speaks when it is reasonably sure).
// Measured 2026-10-03 over 377 real workspace/workflow verdicts: 244 sat below 0.6.
const CONF_FLOOR = 0.6;
const NO_WS_RE = /no\s+workspaces?\s+for\s+real\s+work/i;

function jev() { return require('./jev-assist.js'); }

function homeOf(home) {
  if (home) return home;
  return require('../../companion/lib/test-home-guard.js').resolveHome();
}

// mode(home) -> 'on' | 'shadow' | 'off'. Any error -> 'off' (fail-open: no annotation).
function mode(home) {
  try {
    const j = jev();
    const h = homeOf(home);
    return j.getMode(ID, j.readJevJson(h), h);
  } catch (_) { return 'off'; }
}

function taskText(t) {
  const subj = String((t && (t.content || t.subject)) || '');
  const desc = String((t && t.description) || '');
  return (desc && desc !== subj ? subj + '\n' + desc : subj).slice(0, TEXT_CAP);
}

function hashFor(text, home) {
  return jev().prepare({ id: ID, home, trust: 'advisory', baseline: null, cacheKey: text, state: text }).hash;
}

function readCacheEntry(home, h) {
  try {
    const c = JSON.parse(fs.readFileSync(jev().cachePath(home), 'utf8'));
    return c && c[h] ? c[h] : null;
  } catch (_) { return null; }
}

// ---- repo override ----------------------------------------------------------

function settingsGet(key, dflt, home) {
  try { return require('./settings.js').get('jev', key, dflt, home ? { home } : undefined); } catch (_) { return dflt; }
}

// noWorkspaceRepo(cwd, home) -> true when workspaces are off-limits for this repo.
function noWorkspaceRepo(cwd, home) {
  const dir0 = path.resolve(cwd || process.cwd());
  try {
    const raw = settingsGet('dispatchTierNoWorkspaceRepos', '', home);
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (list.includes('*')) return true;
    for (const e of list) {
      if (path.isAbsolute(e) ? (dir0 === e || dir0.startsWith(e + path.sep)) : dir0.split(path.sep).includes(e)) return true;
    }
  } catch (_) { /* fall through to detection */ }
  if (settingsGet('dispatchTierDetectNoWorkspaces', true, home) === false) return false;
  return repoDocsMatch(dir0, home, NO_WS_RE);
}

// repoDocsMatch(dir0, home, re) -> true when a CLAUDE.md / AGENTS.md between dir0 and
// the repo root matches `re` (the shared walk behind noWorkspaceRepo).
function repoDocsMatch(dir0, home, re) {
  // Walk up (bounded) to the repo root, reading CLAUDE.md / AGENTS.md at each
  // level for a rule matching `re`. The repo root is the OUTERMOST
  // superproject (companion/lib/identity.js#resolveContext's worktreeRoot),
  // not just the nearest `.git` entry — deadly-loop round-1 finding (4): a
  // hand-rolled `fs.existsSync(path.join(dir, '.git'))` walk stopped at a
  // SUBMODULE's own `.git` FILE, so it never climbed to the superproject
  // whose CLAUDE.md actually carries the repo's "no workspaces" doctrine.
  let root = null;
  try {
    root = require('../../companion/lib/identity.js').resolveContext(dir0, { home, missingPath: 'ancestor' }).worktreeRoot || null;
  } catch (_) { root = null; }
  let dir = dir0;
  for (let i = 0; i < 8; i++) {
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      try {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        if (re.test(txt)) return true;
      } catch (_) { /* absent */ }
    }
    if (root && dir === root) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

// verdict(task, {home, cwd}) -> { tier, raw, conf, h, repoOverride } | null (no cached verdict).
function verdict(task, opts) {
  try {
    const home = homeOf(opts && opts.home);
    const text = taskText(task);
    if (!text) return null;
    const h = hashFor(text, home);
    const e = readCacheEntry(home, h);
    if (!e || !TIERS.includes(e.answer)) return null;
    let tier = e.answer;
    let repoOverride = false;
    if (tier === 'workspace' && noWorkspaceRepo(opts && opts.cwd, home)) { tier = 'subagent'; repoOverride = true; }
    const conf = Number.isFinite(e.confidence) ? e.confidence : null;
    const lowConf = tier !== 'subagent' && conf !== null && conf < CONF_FLOOR;
    if (lowConf) tier = 'subagent';
    return { tier, raw: e.answer, conf, h, repoOverride, lowConf };
  } catch (_) { return null; }
}

// ---- state (requested markers + per-task recommendation tracking) ----------

function statePath(home) { return path.join(home, '.anti-hall', STATE_FILE); }
function readState(home) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(statePath(home), 'utf8')); } catch (_) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (!s.requested || typeof s.requested !== 'object') s.requested = {};
  if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {};
  return s;
}
function writeState(home, s) {
  try {
    const p = statePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Bound: at most 50 sessions (oldest-touched first out), 500 requested.
    const sids = Object.keys(s.sessions);
    if (sids.length > 50) {
      sids.sort((a, b) => ((s.sessions[a] && s.sessions[a].t) || 0) - ((s.sessions[b] && s.sessions[b].t) || 0));
      for (const k of sids.slice(0, sids.length - 50)) delete s.sessions[k];
    }
    const now = Date.now();
    for (const [k, v] of Object.entries(s.requested)) if (!Number.isFinite(v) || now - v > REQUEST_TTL_MS) delete s.requested[k];
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) { /* fail-open */ }
}

// request(task, {home, sessionId, cwd, transcriptPath}) — ask Jev (detached) iff
// the integration is not off, the task text has no cached verdict, and no
// request for the same text is already in flight. Never throws, never waits.
function request(task, opts) {
  try {
    const home = homeOf(opts && opts.home);
    if (mode(home) === 'off') return false;
    const text = taskText(task);
    if (!text) return false;
    const h = hashFor(text, home);
    if (readCacheEntry(home, h)) return false;
    const st = readState(home);
    const at = st.requested[h];
    if (Number.isFinite(at) && Date.now() - at < REQUEST_TTL_MS) return false;
    st.requested[h] = Date.now();
    writeState(home, st);
    jev().askDetached({
      id: ID, question: QUESTION, state: text, cacheKey: text, trust: 'advisory', baseline: null,
      home, sessionId: opts && opts.sessionId ? String(opts.sessionId) : undefined,
      turnRef: opts && opts.transcriptPath ? jev().turnRefFromTranscript(opts.transcriptPath) : undefined,
    });
    return true;
  } catch (_) { return false; }
}

function fmtConf(c) { return Number.isFinite(c) ? ' (' + (Math.round(c * 100) / 100).toFixed(2) + ')' : ''; }

// annotator({home, cwd, sessionId, transcriptPath}) -> { annotate(task) -> string, footer() -> string }
// Records each shown/logged recommendation for outcome tracking. In shadow the
// annotation is always '' (logged only). Any error -> ''.
function annotator(opts) {
  const home = (() => { try { return homeOf(opts && opts.home); } catch (_) { return null; } })();
  const m = home ? mode(home) : 'off';
  let shown = 0;
  const recs = [];
  return {
    annotate(task) {
      if (!home || m === 'off') return '';
      const v = verdict(task, { home, cwd: opts && opts.cwd });
      if (!v) { request(task, opts); return ''; }
      recs.push({ id: String(task.id), h: v.h, tier: v.tier, raw: v.raw, conf: v.conf, repoOverride: v.repoOverride, lowConf: v.lowConf });
      if (m !== 'on') return '';
      shown++;
      return '→ ' + v.tier + fmtConf(v.conf);
    },
    footer() { return shown > 0 ? 'Jev recommendation — final call is yours.' : ''; },
    commit() { if (home && recs.length) remember(home, opts && opts.sessionId, recs, m); },
  };
}

function metricsTier(home, fn) {
  try {
    const dd = require('./dispatch-demand.js');
    const p = dd.metricsPath(home);
    let mm = null;
    try { mm = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { mm = null; }
    if (!mm || typeof mm !== 'object') mm = {};
    if (!mm.tier || typeof mm.tier !== 'object') mm.tier = {};
    fn(mm.tier);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.t.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mm), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) { /* fail-open */ }
}
function bump(t, k) { t[k] = (Number.isFinite(t[k]) ? t[k] : 0) + 1; }

// remember — first sighting of a (task id, text hash) recommendation in a
// session: count the verdict once and start tracking its outcome.
function remember(home, sessionId, recs, m) {
  const st = readState(home);
  const sid = String(sessionId || 'unknown');
  const sess = st.sessions[sid] || (st.sessions[sid] = { t: 0, tasks: {} });
  sess.t = Date.now();
  const fresh = [];
  for (const r of recs) {
    const cur = sess.tasks[r.id];
    if (cur && cur.h === r.h) continue;
    sess.tasks[r.id] = { h: r.h, tier: r.tier, raw: r.raw, conf: r.conf, mode: m, repoOverride: !!r.repoOverride, lowConf: !!r.lowConf };
    fresh.push(r);
  }
  writeState(home, st);
  if (fresh.length) {
    metricsTier(home, (t) => { for (const r of fresh) bump(t, 'verdict.' + r.tier); });
    for (const r of fresh) {
      if (r.repoOverride) {
        try { jev().recordOutcome({ id: ID, h: r.h, outcome: 'repo-override-subagent', home }); } catch (_) {}
      } else if (r.lowConf) {
        try { jev().recordOutcome({ id: ID, h: r.h, outcome: 'low-confidence-subagent', home }); } catch (_) {}
      }
    }
  }
}

// dispatchEvidence(lines, id) -> { agents, workflow, workspace } counts of
// spawns that name "#<id>" (Agent description, Workflow input, a Bash
// `devswarm.js spawn` command).
function dispatchEvidence(lines, id) {
  const out = { agents: 0, workflow: 0, workspace: 0 };
  const re = new RegExp('#' + id + '(?!\\d)');
  for (const raw of lines || []) {
    if (raw.indexOf('"tool_use"') === -1 || raw.indexOf('#' + id) === -1) continue;
    let e;
    try { e = JSON.parse(raw); } catch (_) { continue; }
    const c = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      const inp = b.input || {};
      if ((b.name === 'Agent' || b.name === 'Task') && re.test(String(inp.description || ''))) out.agents++;
      else if (b.name === 'Workflow' && re.test(JSON.stringify(inp))) out.workflow++;
      else if (b.name === 'Bash' && /devswarm(\.js)?\s+spawn\b/.test(String(inp.command || '')) && re.test(String(inp.command || ''))) out.workspace++;
    }
  }
  return out;
}

// trackOutcomes({home, sessionId, lines, taskMap}) — label each tracked
// recommendation once with the actual dispatch, and once with its result.
function trackOutcomes(opts) {
  try {
    const home = homeOf(opts && opts.home);
    const st = readState(home);
    const sess = st.sessions[String((opts && opts.sessionId) || 'unknown')];
    if (!sess || !sess.tasks) return;
    let dirty = false;
    const counters = [];
    const outcomes = [];
    for (const [id, rec] of Object.entries(sess.tasks)) {
      if (rec.dispatch && rec.result) continue;
      const ev = dispatchEvidence(opts.lines, id);
      const actual = ev.workspace ? 'workspace' : ev.workflow ? 'workflow' : ev.agents ? 'subagent' : null;
      if (!rec.dispatch && actual) {
        rec.dispatch = actual;
        const how = actual === rec.tier ? 'followed' : 'overridden';
        counters.push(how);
        outcomes.push({ h: rec.h, outcome: 'dispatched-' + actual });
        outcomes.push({ h: rec.h, outcome: how });
        dirty = true;
      }
      const task = opts.taskMap && opts.taskMap.get ? opts.taskMap.get(id) : null;
      const done = task && /^(completed|done)$/i.test(String(task.status || ''));
      if (rec.dispatch && !rec.result) {
        if (rec.tier === 'subagent' && rec.dispatch === 'subagent' && (done || ev.agents > 1 || ev.workflow || ev.workspace)) {
          rec.result = (ev.agents <= 1 && !ev.workflow && !ev.workspace) ? 'one-lane' : 'escalated';
          counters.push(rec.result === 'one-lane' ? 'subagentOneLane' : 'subagentEscalated');
        } else if (rec.tier === 'workflow' && (ev.workflow || ev.agents >= 3 || done)) {
          rec.result = (ev.workflow || ev.agents >= 3) ? 'fanned-out' : 'no-fanout';
          counters.push(rec.result === 'fanned-out' ? 'workflowFannedOut' : 'workflowNoFanout');
        } else if (rec.tier === 'workspace' || rec.dispatch !== rec.tier) {
          rec.result = 'n/a';
        }
        if (rec.result && rec.result !== 'n/a') outcomes.push({ h: rec.h, outcome: rec.result });
        if (rec.result) dirty = true;
      }
    }
    if (!dirty) return;
    sess.t = Date.now();
    writeState(home, st);
    if (counters.length) metricsTier(home, (t) => { for (const k of counters) bump(t, k); });
    for (const o of outcomes) {
      try { jev().recordOutcome({ id: ID, h: o.h, outcome: o.outcome, home }); } catch (_) {}
    }
  } catch (_) { /* fail-open */ }
}

function summary(home) {
  let t = {};
  try { t = (JSON.parse(fs.readFileSync(require('./dispatch-demand.js').metricsPath(home), 'utf8')).tier) || {}; } catch (_) { t = {}; }
  const n = (k) => (Number.isFinite(t[k]) ? t[k] : 0);
  const labelled = n('followed') + n('overridden');
  return {
    verdicts: { workspace: n('verdict.workspace'), workflow: n('verdict.workflow'), subagent: n('verdict.subagent') },
    followed: n('followed'),
    overridden: n('overridden'),
    followRate: labelled ? n('followed') / labelled : null,
    subagentOneLane: n('subagentOneLane'),
    subagentEscalated: n('subagentEscalated'),
    workflowFannedOut: n('workflowFannedOut'),
    workflowNoFanout: n('workflowNoFanout'),
  };
}

module.exports = {
  ID, QUESTION, TIERS, CONF_FLOOR, TEXT_CAP, taskText, mode, verdict, request, annotator,
  noWorkspaceRepo, repoDocsMatch, dispatchEvidence, trackOutcomes, summary, hashFor, statePath,
};
