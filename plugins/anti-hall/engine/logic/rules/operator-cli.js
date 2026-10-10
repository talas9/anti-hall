// rules = "operator-cli": the rules of the verbs `ah-engine auto-handover-config`, `dispatch-report` and `finding-dedup`, the ports of
// scripts/auto-handover-config.js, scripts/dispatch-report.js and scripts/finding-dedup.js (with the summaries of hooks/lib/
// auto-handover-config.js, dispatch-demand.js, dispatch-tier.js and coordinator-work.js). The command reads the files, the settings
// and the Jev answers and asks this script, through the script host (JSON in, JSON out), for the words and the decisions: argument
// parsing, validation, the summaries and the rendering, the candidate pairs and their grouping. Every threshold, text and name
// comes in as `input.cfg` from engine/defaults/operator_cli.toml (and the owner's overrides). Files come in as text and are parsed
// here, so a JSON member keeps the order the file has. Editable like every other script of the plugin.
'use strict';

function opT(C, key, vars) {
  var s = C[key];
  if (typeof s !== 'string') return '';
  return s.replace(/\{(\w+)\}/g, function (m, k) { return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; });
}
function opPct(C, x) { return x == null ? C.dr_na : (Math.round(x * 1000) / 10) + '%'; }

// ---- auto-handover-config -------------------------------------------------------------------------------------------------

function ahcValid(C, n) { return Number.isInteger(n) && n >= C.ahc_pct_min && n <= C.ahc_pct_max; }
function ahcPositive(n) { return Number.isInteger(n) && n > 0; }

function ahcCsv(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(/[,:]/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// `resolveEffective({})`: `input.values` are the settings as the store answers them (environment tier included).
function ahcEffective(C, input) {
  var v = input.values;
  var envRaw = input.envPct;
  var hasEnv = envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== '';
  if (hasEnv && parseInt(envRaw, 10) === 0) {
    return { enabled: false, pct: 0, maxTokens: 0, nag: false, nagStepPct: C.ahc_default_nag_step_pct, nagQuietMin: C.ahc_default_nag_quiet_min,
      gateNewWork: false, gateBudgetPct: C.ahc_default_gate_budget_pct, decisivePrompt: false, gateHousekeepingMarkers: [], source: 'env' };
  }
  if (!v.enabled) {
    return { enabled: false, pct: 0, maxTokens: 0, nag: false, nagStepPct: v.nagStepPct, nagQuietMin: v.nagQuietMin, gateNewWork: false,
      gateBudgetPct: v.gateBudgetPct, decisivePrompt: false, gateHousekeepingMarkers: [], source: 'file' };
  }
  var source = 'default';
  if (hasEnv && ahcValid(C, parseInt(envRaw, 10))) source = 'env';
  else if (Object.prototype.hasOwnProperty.call(JSON.parse(input.rawText), 'pct')) source = 'file';
  return { enabled: true, pct: v.pct, maxTokens: Math.floor(v.maxTokens), nag: v.nag, nagStepPct: v.nagStepPct, nagQuietMin: v.nagQuietMin,
    gateNewWork: v.gateNewWork, gateBudgetPct: v.gateBudgetPct, decisivePrompt: v.decisivePrompt,
    gateHousekeepingMarkers: ahcCsv(v.gateHousekeepingMarkers), source: source };
}

// -> {out: [lines], err: [lines], exit, writes: [{key, value}]}: the writes are the settings that changed, in order.
function ahConfigRun(input) {
  var C = input.cfg;
  var out = [], err = [], exit = 0, writes = [];
  var argv = input.argv;
  var fail = function (msg) { err.push(C.ahc_fail_prefix + msg); exit = 1; };
  var write = function (mutate) {
    var current = {};
    Object.keys(input.values).forEach(function (k) { current[k] = input.values[k]; });
    var next = mutate(Object.assign({}, current)) || current;
    Object.keys(next).forEach(function (k) { if (next[k] !== current[k]) writes.push({ key: k, value: next[k] }); });
  };
  var verb = argv[0];
  if (verb === 'get') {
    var effective = ahcEffective(C, input);
    if (argv.indexOf('--json') >= 0) {
      out.push(JSON.stringify({ raw: JSON.parse(input.rawText), effective: effective }));
    } else {
      out.push(opT(C, 'ahc_get_enabled', { value: effective.enabled }));
      out.push(opT(C, 'ahc_get_pct', { value: effective.pct, source: effective.source }));
      out.push(opT(C, 'ahc_get_max_tokens', { value: effective.maxTokens, off: effective.maxTokens === 0 ? C.ahc_get_max_tokens_off : '' }));
      out.push(opT(C, 'ahc_get_nag', { value: effective.nag }));
      out.push(opT(C, 'ahc_get_nag_step', { value: effective.nagStepPct }));
      out.push(opT(C, 'ahc_get_nag_quiet', { value: effective.nagQuietMin }));
      out.push(opT(C, 'ahc_get_gate_new_work', { value: effective.gateNewWork }));
      out.push(opT(C, 'ahc_get_gate_budget', { value: effective.gateBudgetPct }));
    }
  } else if (verb === 'set') {
    var n = parseInt(argv[1], 10);
    if (!ahcValid(C, n)) fail(opT(C, 'ahc_set_invalid', { arg: argv[1] }));
    else {
      write(function (c) { c.pct = n; c.enabled = true; return c; });
      out.push(opT(C, 'ahc_set_ok', { n: n }));
    }
  } else if (verb === 'off') {
    write(function (c) { c.enabled = false; return c; });
    out.push(C.ahc_off_ok);
  } else if (verb === 'on') {
    write(function (c) { c.enabled = true; if (!ahcValid(C, c.pct)) c.pct = C.ahc_default_pct; return c; });
    out.push(C.ahc_on_ok);
  } else if (verb === 'nag') {
    var nv = argv[1];
    if (nv !== 'on' && nv !== 'off') fail(C.ahc_nag_usage);
    else {
      write(function (c) { c.nag = nv === 'on'; return c; });
      out.push(opT(C, 'ahc_nag_ok', { value: nv }));
    }
  } else if (verb === 'nag-step') {
    var s = parseInt(argv[1], 10);
    if (!ahcPositive(s)) fail(opT(C, 'ahc_nag_step_invalid', { arg: argv[1] }));
    else {
      write(function (c) { c.nagStepPct = s; return c; });
      out.push(opT(C, 'ahc_nag_step_ok', { n: s }));
    }
  } else if (verb === 'nag-quiet') {
    var q = parseInt(argv[1], 10);
    if (!ahcPositive(q)) fail(opT(C, 'ahc_nag_quiet_invalid', { arg: argv[1] }));
    else {
      write(function (c) { c.nagQuietMin = q; return c; });
      out.push(opT(C, 'ahc_nag_quiet_ok', { n: q }));
    }
  } else if (verb === 'max-tokens') {
    var m = parseInt(argv[1], 10);
    if (!(Number.isInteger(m) && m >= 0) || String(m) !== String(argv[1]).trim()) fail(opT(C, 'ahc_max_tokens_invalid', { arg: argv[1] }));
    else {
      write(function (c) { c.maxTokens = m; return c; });
      out.push(m === 0 ? C.ahc_max_tokens_off_ok : opT(C, 'ahc_max_tokens_ok', { n: m }));
    }
  } else {
    err.push(C.ahc_usage);
    exit = 1;
  }
  return { out: out, err: err, exit: exit, writes: writes };
}

// ---- dispatch-report ------------------------------------------------------------------------------------------------------

function drParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}
function drFinite(v) { return typeof v === 'number' && isFinite(v); }

// dispatch-demand.js `summary`
function drDemand(text) {
  var m = drParse(text);
  if (!m || typeof m !== 'object') m = {};
  ['demandsShown', 'demandsFollowed', 'demandsIgnored', 'idleNeglectBlocks'].forEach(function (k) {
    if (!drFinite(m[k]) || m[k] < 0) m[k] = 0;
  });
  var scored = m.demandsFollowed + m.demandsIgnored;
  return { demandsShown: m.demandsShown, demandsFollowed: m.demandsFollowed, demandsIgnored: m.demandsIgnored,
    complianceRate: scored ? m.demandsFollowed / scored : null, idleNeglectBlocks: m.idleNeglectBlocks };
}

// dispatch-tier.js `summary`: the "tier" block of the same file
function drTier(text) {
  var t = {};
  try { t = (JSON.parse(text).tier) || {}; } catch (e) { t = {}; }
  var n = function (k) { return Number.isFinite(t[k]) ? t[k] : 0; };
  var labelled = n('followed') + n('overridden');
  return { verdicts: { workspace: n('verdict.workspace'), workflow: n('verdict.workflow'), subagent: n('verdict.subagent') },
    followed: n('followed'), overridden: n('overridden'), followRate: labelled ? n('followed') / labelled : null,
    subagentOneLane: n('subagentOneLane'), subagentEscalated: n('subagentEscalated'),
    workflowFannedOut: n('workflowFannedOut'), workflowNoFanout: n('workflowNoFanout') };
}

var DR_COUNTERS = ['calls', 'work', 'blocks', 'skippedWouldBlock'];

// coordinator-work.js `normalize` (the session file)
function drNormalizeSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var s = { version: typeof raw.version === 'string' && raw.version ? raw.version : 'unknown', calls: 0, work: 0, blocks: 0, skippedWouldBlock: 0 };
  DR_COUNTERS.forEach(function (k) { if (Number.isFinite(raw[k]) && raw[k] >= 0) s[k] = raw[k]; });
  return s;
}

// coordinator-work.js `normalizeMetrics`
function drNormalizeMetrics(raw) {
  var m = { v: 1, nudges: 0, blocks: 0, byVersion: {} };
  if (raw && typeof raw === 'object') {
    ['nudges', 'blocks', 'maxSessionBlocks'].forEach(function (k) { if (Number.isFinite(raw[k]) && raw[k] >= 0) m[k] = raw[k]; });
    if (raw.byVersion && typeof raw.byVersion === 'object') {
      Object.keys(raw.byVersion).forEach(function (v) {
        var e = raw.byVersion[v];
        if (!e || typeof e !== 'object') return;
        var o = { sessions: 0, calls: 0, work: 0, blocks: 0, skippedWouldBlock: 0 };
        Object.keys(o).forEach(function (k) { if (Number.isFinite(e[k]) && e[k] >= 0) o[k] = e[k]; });
        m.byVersion[v] = o;
      });
    }
  }
  return m;
}

// coordinator-work.js `summary`: the folded metrics merged with the live session files (calls > 0)
function drCoordinator(metricsText, sessionTexts) {
  var out = { nudges: 0, blocks: 0, skippedWouldBlock: 0, sessionsWithSkippedWouldBlock: 0, versions: {}, blocksPerSession: { mean: null, max: 0 } };
  var share = function (num, den) { return den > 0 ? num / den : null; };
  var m = drNormalizeMetrics(drParse(metricsText));
  out.nudges = m.nudges;
  out.blocks = m.blocks;
  var acc = {};
  var add = function (v, e) {
    var a = acc[v] || (acc[v] = { sessions: 0, calls: 0, work: 0, blocks: 0 });
    a.sessions += e.sessions;
    a.calls += e.calls;
    a.work += e.work;
    a.blocks += e.blocks;
    out.skippedWouldBlock += e.skippedWouldBlock;
  };
  Object.keys(m.byVersion).forEach(function (v) { add(v, m.byVersion[v]); });
  var max = m.maxSessionBlocks || 0;
  sessionTexts.forEach(function (t) {
    var s = drNormalizeSession(drParse(t));
    if (!s || !(s.calls > 0)) return;
    add(s.version || 'unknown', { sessions: 1, calls: s.calls, work: s.work, blocks: s.blocks, skippedWouldBlock: s.skippedWouldBlock });
    if (s.skippedWouldBlock > 0) out.sessionsWithSkippedWouldBlock++;
    max = Math.max(max, s.blocks);
  });
  var sessions = 0, blocks = 0;
  Object.keys(acc).forEach(function (v) {
    var a = acc[v];
    sessions += a.sessions;
    blocks += a.blocks;
    out.versions[v] = { sessions: a.sessions, calls: a.calls, work: a.work, blocks: a.blocks,
      postedShare: share(a.work, a.calls), attemptedShare: share(a.work + a.blocks, a.calls + a.blocks) };
  });
  out.blocksPerSession = { mean: sessions > 0 ? blocks / sessions : null, max: max };
  return out;
}

// -> {text}: input {json, demandText, metricsText, sessionTexts}
function dispatchReportRun(input) {
  var C = input.cfg;
  var r = { dispatchDemand: drDemand(input.demandText), dispatchTier: drTier(input.demandText),
    coordinatorWork: drCoordinator(input.metricsText, input.sessionTexts) };
  if (input.json) return { text: JSON.stringify(r, null, 2) + '\n' };
  var d = r.dispatchDemand, t = r.dispatchTier, c = r.coordinatorWork;
  var lines = [
    C.dr_title,
    opT(C, 'dr_demand', { shown: d.demandsShown, followed: d.demandsFollowed, ignored: d.demandsIgnored, compliance: opPct(C, d.complianceRate) }),
    opT(C, 'dr_idle', { blocks: d.idleNeglectBlocks }),
    opT(C, 'dr_tier_a', { workspace: t.verdicts.workspace, workflow: t.verdicts.workflow, subagent: t.verdicts.subagent }),
    opT(C, 'dr_tier_b', { followed: t.followed, overridden: t.overridden, rate: opPct(C, t.followRate), one_lane: t.subagentOneLane,
      escalated: t.subagentEscalated, fanned_out: t.workflowFannedOut, no_fanout: t.workflowNoFanout }),
  ];
  var bps = c.blocksPerSession || {};
  var mean = bps.mean == null ? C.dr_na : String(Math.round(bps.mean * 100) / 100);
  lines.push(opT(C, 'dr_cw', { nudges: c.nudges, blocks: c.blocks, mean: mean, max: bps.max || 0, skipped: c.skippedWouldBlock,
    sessions: c.sessionsWithSkippedWouldBlock }));
  Object.keys(c.versions || {}).forEach(function (v) {
    var e = c.versions[v];
    lines.push(opT(C, 'dr_cw_version', { version: v, sessions: e.sessions, share: opPct(C, e.postedShare), attempted: opPct(C, e.attemptedShare) }));
  });
  lines.push(C.dr_cw_baseline, C.dr_cw_delivery, C.dr_cw_gaps);
  return { text: lines.join('\n') + '\n' };
}

// ---- finding-dedup --------------------------------------------------------------------------------------------------------

function fdLoad(text) {
  try {
    var parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(function (f) { return f && typeof f === 'object' && f.id != null; }) : [];
  } catch (e) {
    return [];
  }
}
function fdKey(f) { return String(f.id) + '\u0000' + (f.round != null ? String(f.round) : ''); }
function fdUnique(findings) {
  var seen = {}, out = [];
  findings.forEach(function (f) {
    var k = fdKey(f);
    if (Object.prototype.hasOwnProperty.call(seen, k)) return;
    seen[k] = true;
    out.push(f);
  });
  return out;
}
function fdPairs(C, list) {
  var pairs = [];
  for (var i = 0; i < list.length; i++) {
    for (var j = i + 1; j < list.length; j++) {
      var a = list[i], b = list[j];
      if (fdKey(a) === fdKey(b)) continue;
      var sameFile = typeof a.file === 'string' && a.file && a.file === b.file && Number.isFinite(a.line) && Number.isFinite(b.line) &&
        Math.abs(a.line - b.line) <= C.fd_line_window;
      var sameIdAcrossRounds = a.id != null && a.id === b.id && a.round !== b.round;
      if (sameFile || sameIdAcrossRounds) pairs.push([a, b]);
    }
  }
  return pairs;
}
function fdDescribe(C, f) {
  var loc = (typeof f.file === 'string' && f.file ? f.file : C.fd_unknown_file) + (Number.isFinite(f.line) ? ':' + f.line : '');
  var round = f.round != null ? ' round ' + f.round : '';
  var severity = f.severity ? ' [' + f.severity + ']' : '';
  var text = typeof f.text === 'string' ? f.text : '';
  return loc + round + severity + ': ' + text;
}
function fdCapped(C, text) { var l = fdUnique(fdLoad(text)); return { list: l, pairs: fdPairs(C, l).slice(0, C.fd_max_pairs) }; }

// -> {asks: [{state, cacheKey}]}: what to ask Jev, one entry per candidate pair
function findingDedupPlan(input) {
  var C = input.cfg;
  var p = fdCapped(C, input.text);
  return { asks: p.pairs.map(function (pr) {
    var state = opT(C, 'fd_state', { a: fdDescribe(C, pr[0]), b: fdDescribe(C, pr[1]) });
    return { state: state, cacheKey: [fdKey(pr[0]), fdKey(pr[1]), state].join('\u0001') };
  }) };
}

function fdGroups(edges, allIds) {
  var parent = new Map();
  allIds.forEach(function (id) { parent.set(id, id); });
  var find = function (x) {
    var root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    var cur = x;
    while (parent.get(cur) !== root) { var nx = parent.get(cur); parent.set(cur, root); cur = nx; }
    return root;
  };
  edges.forEach(function (e) { var ra = find(e.a), rb = find(e.b); if (ra !== rb) parent.set(ra, rb); });
  var byRoot = new Map();
  allIds.forEach(function (id) {
    var root = find(id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(id);
  });
  var groups = [];
  byRoot.forEach(function (ids) {
    if (ids.length < 2) return;
    var set = new Set(ids);
    var pairs = edges.filter(function (e) { return set.has(e.a) && set.has(e.b); }).map(function (e) { return { a: e.a, b: e.b, confidence: e.confidence }; });
    groups.push({ ids: ids, pairs: pairs });
  });
  return groups;
}

// input {text, modeOff, answers: [{final, confidence} | null, one per pair]} -> {out, err}
function findingDedupFinish(input) {
  var C = input.cfg;
  if (input.modeOff) return { out: JSON.stringify({ groups: [] }) + '\n', err: [] };
  var p = fdCapped(C, input.text);
  var idCount = new Map();
  p.list.forEach(function (f) { idCount.set(String(f.id), (idCount.get(String(f.id)) || 0) + 1); });
  var label = function (f) {
    return idCount.get(String(f.id)) > 1 ? opT(C, 'fd_round_suffix', { id: String(f.id), round: f.round != null ? String(f.round) : C.fd_no_round }) : f.id;
  };
  var edges = [];
  p.pairs.forEach(function (pr, i) {
    var r = input.answers[i];
    if (r && r.final === true && Number.isFinite(r.confidence) && r.confidence >= C.fd_confidence_floor_pct / 100) {
      edges.push({ a: label(pr[0]), b: label(pr[1]), confidence: r.confidence });
    }
  });
  var groups = fdGroups(edges, p.list.map(label));
  var err = [];
  groups.forEach(function (g) {
    g.pairs.forEach(function (pr) { err.push(opT(C, 'fd_dup_line', { a: pr.a, b: pr.b, confidence: pr.confidence.toFixed(2) })); });
  });
  return { out: JSON.stringify({ groups: groups }) + '\n', err: err };
}
