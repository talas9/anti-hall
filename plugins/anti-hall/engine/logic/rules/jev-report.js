// rules = "jev-report": the rules of `ah-engine jev-report`, the port of scripts/jev-report.js (the Jev report of the /anti-hall:jev
// skill). The command (src/jev/report) reads the files and the settings and asks this script, through `script::call_fn`
// (JSON in, JSON out), for the words: it parses the arguments, aggregates the decision, triage and outcome rows per integration,
// gives the KEEP / REVIEW / REMOVE verdict and renders the text or JSON report. Every threshold, list and word comes in as
// `input.cfg` from engine/defaults/jev_report.toml (and the owner's overrides), so this file holds only the logic.
// Editable like every other script of the plugin.
'use strict';

var JR_C = null; // the thresholds of this call (jev_report.thresholds)
var JR_T = null; // the texts of this call (jev_report.texts)
var JR_OUT = [];
var JR_ERR = [];
var JR_EXIT = 0;

function jrT(key, vars) {
  var s = JR_T[key];
  if (typeof s !== 'string') return '';
  return s.replace(/\{(\w+)\}/g, function (m, k) { return vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; });
}
function jrLog(line) { JR_OUT.push(line + '\n'); }
function jrEprint(line) { JR_ERR.push(line + '\n'); }
function jrRaw(s) { JR_OUT.push(s); }

function jrBadOutcome(s) { return new RegExp(JR_C.bad_outcome_re, 'i').test(s); }
function jrIsHttpFailure(reason) {
  return typeof reason === 'string' && (reason.indexOf(JR_C.http_failure_prefix) === 0 || JR_C.failure_reasons.indexOf(reason) >= 0);
}

// ---- ndjson ---------------------------------------------------------------------------------------------------------------

// The rows of the texts of files (oldest first); a blank or corrupt line is skipped (readNdjsonFiles).
function jrParseNdjson(texts) {
  var rows = [], i, lines, j, t;
  for (i = 0; i < texts.length; i++) {
    lines = String(texts[i]).split('\n');
    for (j = 0; j < lines.length; j++) {
      t = lines[j].trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch (e) { /* corrupt line */ }
    }
  }
  return rows;
}

function jrLatestHumanLabelByHash(labelRows) {
  var map = new Map();
  labelRows.forEach(function (row) {
    if (!row || row.source !== 'human' || !row.h || (row.label !== 'tp' && row.label !== 'fp')) return;
    map.set(row.h, row.label);
  });
  return map;
}

// The latest stored snippet for `hash` over the texts of the audit log (backup first, then the live file), or null.
function jrAuditSnippet(texts, hash) {
  var latest = null, i, lines, j, t, row;
  for (i = 0; i < texts.length; i++) {
    lines = String(texts[i]).split('\n');
    for (j = 0; j < lines.length; j++) {
      t = lines[j].trim();
      if (!t) continue;
      try { row = JSON.parse(t); if (row && row.h === hash) latest = row; } catch (e) { /* corrupt line */ }
    }
  }
  return latest ? latest.snippet : null;
}

function jrPercentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  var idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

function jrParseIsoMs(s) {
  var t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function jrPct(n) { return n === null || n === undefined ? 'n/a' : (n * 100).toFixed(1) + '%'; }

// ---- arguments ------------------------------------------------------------------------------------------------------------

function jrParseArgs(argv) {
  var opts = { days: null, json: false, window: null, since: null, until: null };
  var i, raw, parts, s, e, name;
  for (i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') opts.days = Number(argv[++i]);
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--home') opts.home = argv[++i];
    else if (argv[i] === '--window') opts.window = argv[++i];
    else if (argv[i] === '--by') opts.by = argv[++i];
    else if (argv[i] === '--project') opts.project = argv[++i];
    else if (argv[i] === '--weekly') opts.weekly = true;
    else if (argv[i] === '--since') opts.since = jrParseIsoMs(argv[++i]);
    else if (argv[i] === '--until') opts.until = jrParseIsoMs(argv[++i]);
    else if (argv[i] === '--exclude-window') {
      raw = argv[++i];
      parts = typeof raw === 'string' ? raw.split('..') : [];
      if (parts.length === 2) {
        s = jrParseIsoMs(parts[0]);
        e = jrParseIsoMs(parts[1]);
        if (s !== null && e !== null) {
          if (!opts.excludeWindows) opts.excludeWindows = [];
          opts.excludeWindows.push([Math.min(s, e), Math.max(s, e)]);
        }
      }
    } else if (argv[i] === '--exclude-project') {
      name = argv[++i];
      if (typeof name === 'string' && name) {
        if (!opts.excludeProjects) opts.excludeProjects = [];
        opts.excludeProjects.push(name);
      }
    }
  }
  return opts;
}

// What the command has to read: the sub-command, the `--home` value and the shape of the report.
function jrPlan(argv) {
  if (argv[0] === 'label') {
    var hasVerdict = argv[2] === 'tp' || argv[2] === 'fp';
    var lo = jrParseArgs(argv.slice(hasVerdict ? 3 : 2));
    return { cmd: 'label', home: lo.home === undefined ? null : lo.home };
  }
  if (argv[0] === 'prune-audit') {
    var po = jrParseArgs(argv.slice(1));
    return { cmd: 'prune-audit', home: po.home === undefined ? null : po.home };
  }
  var o = jrParseArgs(argv);
  var grouped = o.by === 'project' || o.by === 'session';
  return { cmd: 'report', home: o.home === undefined ? null : o.home, weekly: !!o.weekly, grouped: !o.weekly && grouped, json: o.json };
}

// ---- filters --------------------------------------------------------------------------------------------------------------

function jrGroupKeyOf(row, by) {
  if (by === 'session') return (row && row.sessionId) || 'unknown';
  return (row && row.project) || 'unknown';
}

function jrFilterByTimeWindow(rows, opts) {
  var hasProjectExcl = Array.isArray(opts.excludeProjects) && opts.excludeProjects.length > 0;
  if (opts.since === null && opts.until === null && (!opts.excludeWindows || opts.excludeWindows.length === 0) && !hasProjectExcl) {
    return rows;
  }
  return rows.filter(function (row) {
    if (hasProjectExcl && opts.excludeProjects.indexOf(jrGroupKeyOf(row, 'project')) >= 0) return false;
    var ts = row && row.ts ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(ts)) return true;
    if (opts.since !== null && ts < opts.since) return false;
    if (opts.until !== null && ts > opts.until) return false;
    if (opts.excludeWindows) {
      for (var k = 0; k < opts.excludeWindows.length; k++) {
        if (ts >= opts.excludeWindows[k][0] && ts <= opts.excludeWindows[k][1]) return false;
      }
    }
    return true;
  });
}

function jrDescribeWindow(opts, rawCount, filteredCount) {
  var o = {
    since: opts.since !== null ? new Date(opts.since).toISOString() : null,
    until: opts.until !== null ? new Date(opts.until).toISOString() : null,
    excludeWindows: (opts.excludeWindows || []).map(function (w) { return [new Date(w[0]).toISOString(), new Date(w[1]).toISOString()]; }),
  };
  if (Array.isArray(opts.excludeProjects) && opts.excludeProjects.length) o.excludeProjects = opts.excludeProjects.slice();
  o.rowsTotal = rawCount;
  o.rowsInWindow = filteredCount;
  o.rowsExcluded = rawCount - filteredCount;
  return o;
}

function jrPrintWindow(w) {
  var since = w.since || jrT('window_log_start');
  var until = w.until || jrT('window_log_end');
  var excl = w.excludeWindows.length ? w.excludeWindows.map(function (p) { return p[0] + '..' + p[1]; }).join(', ') : jrT('window_none');
  jrLog(jrT('window_line', {
    since: since, until: until, excl: excl,
    exclProject: w.excludeProjects ? jrT('window_exclude_project', { names: w.excludeProjects.join(',') }) : '',
    inWindow: w.rowsInWindow, total: w.rowsTotal, excluded: w.rowsExcluded,
  }));
}

function jrGroupRowsBy(rows, by) {
  var groups = new Map();
  rows.forEach(function (row) {
    if (!row || typeof row !== 'object') return;
    var key = jrGroupKeyOf(row, by);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

// ---- rollups, triage answers ----------------------------------------------------------------------------------------------

function jrBuildRollupHistory(rollups, opts) {
  var now = Number.isFinite(opts.now) ? opts.now : Date.now();
  var cutoff = Number.isFinite(opts.days) ? now - opts.days * JR_C.day_ms : null;
  var oldest = Number.isFinite(opts.oldestRawTs) ? opts.oldestRawTs : Infinity;
  var used = [];
  var byId = new Map();
  (rollups || []).forEach(function (r) {
    var start = Date.parse(r.day + 'T00:00:00Z');
    if (!Number.isFinite(start)) return;
    var end = start + JR_C.day_ms;
    if (end > oldest) return;
    if (cutoff !== null && end <= cutoff) return;
    used.push(r.day);
    r.groups.forEach(function (g) {
      if (!g || !g.id) return;
      if (!byId.has(g.id)) byId.set(g.id, { id: g.id, days: new Set(), calls: 0, fresh: 0, changed: 0, timeouts: 0, failures: 0, costUsd: null, p50s: [], p95Ms: null });
      var b = byId.get(g.id);
      b.days.add(r.day);
      b.calls += g.n || 0;
      b.fresh += g.fresh || 0;
      b.changed += g.changed || 0;
      b.timeouts += g.timeouts || 0;
      b.failures += g.failures || 0;
      if (Number.isFinite(g.costUsd)) b.costUsd = (b.costUsd || 0) + g.costUsd;
      if (Number.isFinite(g.p50Ms)) b.p50s.push(g.p50Ms);
      if (Number.isFinite(g.p95Ms)) b.p95Ms = Math.max(b.p95Ms || 0, g.p95Ms);
    });
  });
  var integrations = Array.from(byId.values()).map(function (b) {
    return {
      id: b.id, days: b.days.size, calls: b.calls, fresh: b.fresh, changed: b.changed,
      timeouts: b.timeouts, failures: b.failures,
      costUsd: b.costUsd === null ? null : Math.round(b.costUsd * 1e6) / 1e6,
      p50Ms: jrPercentile(b.p50s.sort(function (x, y) { return x - y; }), JR_C.p50), p95Ms: b.p95Ms,
    };
  }).sort(function (a, b) { return b.calls - a.calls; });
  return { days: used, integrations: integrations };
}

function jrPrintRollupHistory(h) {
  if (!h || !h.days.length) return;
  jrLog(jrT('rollup_title', { first: h.days[0], last: h.days[h.days.length - 1], n: h.days.length }));
  jrLog(jrT('rollup_header'));
  h.integrations.forEach(function (r) {
    var cost = r.costUsd === null ? jrT('na') : '$' + r.costUsd.toFixed(4);
    jrLog('  ' + r.id.padEnd(22) + String(r.days).padStart(6) + String(r.calls).padStart(8) +
      String(r.fresh).padStart(8) + String(r.changed).padStart(9) + String(r.timeouts).padStart(10) +
      cost.padStart(10) + String(r.p50Ms == null ? '-' : r.p50Ms).padStart(6) + String(r.p95Ms == null ? '-' : r.p95Ms).padStart(7));
  });
  jrLog(jrT('rollup_footnote'));
}

function jrBuildTriageAnswerReport(triageRows) {
  var buckets = { urgent: [], normal: [] };
  triageRows.forEach(function (row) {
    if (!row || row.type !== 'answered' || !Number.isFinite(row.latencyMs)) return;
    buckets[row.urgency === 'urgent' ? 'urgent' : 'normal'].push(row.latencyMs);
  });
  var summarize = function (arr) {
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return { n: sorted.length, p50: jrPercentile(sorted, JR_C.p50), p95: jrPercentile(sorted, JR_C.p95) };
  };
  return { urgent: summarize(buckets.urgent), normal: summarize(buckets.normal) };
}

// ---- the report -----------------------------------------------------------------------------------------------------------

function jrBuildHeadline(r, windowLabel) {
  var tpTotal = r.humanTP + r.autoTP;
  var tpPart = jrT('headline_tp', { total: tpTotal, human: r.humanTP, auto: r.autoTP });
  var costPart = r.costPerTp == null ? jrT('headline_cost_na') : jrT('headline_cost', { cost: r.costPerTp.toFixed(4) });
  var p50Part = r.p50 == null ? jrT('headline_p50_na') : jrT('headline_p50', { ms: r.p50 });
  var changedPart = r.isLabelOnly
    ? jrT('headline_label_only', { n: r.labelDistinctDecisions, window: windowLabel })
    : jrT('headline_changed', { n: r.changedUnique, window: windowLabel });
  return jrT('headline', { id: r.id, changed: changedPart, tp: tpPart, cost: costPart, p50: p50Part, suggestion: r.suggestion });
}

function jrBuildTransportBreakdown(rows, triageRows, cutoff) {
  var acc = new Map();
  var slot = function (row) {
    var key = (row.transport === 'vercel' || row.transport === 'typesafe') ? row.transport : 'unrecorded';
    if (!acc.has(key)) acc.set(key, { transport: key, calls: 0, errors: 0, fellBack: 0, ms: [] });
    return acc.get(key);
  };
  var inWindow = function (row) {
    var ts = row.ts ? Date.parse(row.ts) : NaN;
    return cutoff === null || cutoff === undefined || !Number.isFinite(ts) || ts >= cutoff;
  };
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (!row || typeof row !== 'object' || row.type || !row.id || !inWindow(row)) return;
    var evaluated = row.backend === 'jev' || (row.backend === 'baseline-only' && row.reason);
    if (!evaluated) return;
    var a = slot(row);
    a.calls++;
    if (row.backend === 'jev') { if (Number.isFinite(row.ms)) a.ms.push(row.ms); } else a.errors++;
    if (row.fellBack === true) a.fellBack++;
  });
  (Array.isArray(triageRows) ? triageRows : []).forEach(function (row) {
    if (!row || typeof row.hash !== 'string' || row.type === 'answered' || !inWindow(row)) return;
    if (row.backend !== 'jev' && row.backend !== 'jev+haiku') return;
    var a = slot(row);
    a.calls++;
    if (row.backend === 'jev' && Number.isFinite(row.ms)) a.ms.push(row.ms);
    if (row.fellBack === true) a.fellBack++;
  });
  return Array.from(acc.values()).map(function (a) {
    return {
      transport: a.transport, calls: a.calls, errors: a.errors, fellBack: a.fellBack,
      avgMs: a.ms.length ? Math.round(a.ms.reduce(function (x, y) { return x + y; }, 0) / a.ms.length) : null,
    };
  }).sort(function (x, y) { return y.calls - x.calls || x.transport.localeCompare(y.transport); });
}

function jrBuildReport(rows, opts) {
  var now = opts.now;
  var cutoff = Number.isFinite(opts.days) ? now - opts.days * JR_C.day_ms : null;

  var byId = new Map();
  var outcomesByHash = new Map();
  var outcomesBySource = new Map();

  var triageDecisionRows = (Array.isArray(opts.triageRows) ? opts.triageRows : [])
    .filter(function (r) { return r && typeof r.hash === 'string' && r.type !== 'answered'; })
    .map(function (r) {
      return {
        id: 'triage',
        h: r.hash,
        ts: r.ts,
        backend: (r.backend === 'jev' || r.backend === 'cache') ? r.backend : 'baseline-only',
        ms: r.ms,
        jev: (typeof r.kind === 'string' && r.kind) ? r.kind : null,
        mode: 'on',
      };
    });

  rows.concat(triageDecisionRows).forEach(function (row) {
    if (!row || typeof row !== 'object') return;
    var ts = row.ts ? Date.parse(row.ts) : NaN;
    if (cutoff !== null && Number.isFinite(ts) && ts < cutoff) return;

    if (row.type === 'outcome') {
      if (!row.h) return;
      var arr = outcomesByHash.get(row.h) || [];
      arr.push(row.outcome);
      outcomesByHash.set(row.h, arr);
      if (row.id && row.source) {
        if (!outcomesBySource.has(row.id)) outcomesBySource.set(row.id, {});
        var bySrc = outcomesBySource.get(row.id);
        if (!bySrc[row.source]) bySrc[row.source] = { good: 0, known: 0 };
        bySrc[row.source].known++;
        if (!jrBadOutcome(String(row.outcome))) bySrc[row.source].good++;
      }
      return;
    }

    if (!row.id) return;
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id, calls: 0, jevAnswered: 0, cacheHits: 0,
        excludedNoCompare: 0,
        changedHashByFresh: new Map(),
        failures: 0, latencies: [],
        labelCounts: new Map(), labeled: 0,
        labelHashesAll: new Set(), labelHashesFresh: new Set(),
        labelWouldChangeHashesFresh: new Set(),
        agreeHashesFresh: new Map(),
        realCostSum: 0, realCostKnown: false,
        timeouts: 0, fallbackCount: 0, overOneSecFresh: 0,
      });
    }
    var bucket = byId.get(row.id);
    bucket.calls++;
    if (row.backend === 'jev' || row.backend === 'cache') bucket.jevAnswered++;
    if (row.backend === 'cache') bucket.cacheHits++;
    if (row.backend === 'baseline-only' && jrIsHttpFailure(row.reason)) bucket.failures++;
    if (row.reason === 'timeout') bucket.timeouts++;
    if (row.backend === 'baseline-only' && row.mode === 'on') bucket.fallbackCount++;
    if (row.backend !== 'cache' && Number.isFinite(row.ms) && row.ms > JR_C.over_ms) bucket.overOneSecFresh++;
    if (Number.isFinite(row.costUsd)) {
      bucket.realCostSum += row.costUsd;
      bucket.realCostKnown = true;
    }
    if (typeof row.jev === 'boolean' && typeof row.compare === 'boolean') {
      if (row.h && row.backend !== 'cache') {
        bucket.agreeHashesFresh.set(row.h, row.jev === row.compare);
      }
    } else if (typeof row.jev === 'boolean' && (row.backend === 'jev' || row.backend === 'cache')) {
      bucket.excludedNoCompare++;
    }
    if (typeof row.jev === 'string') {
      bucket.labeled++;
      bucket.labelCounts.set(row.jev, (bucket.labelCounts.get(row.jev) || 0) + 1);
      if (row.h) {
        bucket.labelHashesAll.add(row.h);
        if (row.backend !== 'cache') bucket.labelHashesFresh.add(row.h);
      }
    }
    var isLabelOnlyRow = typeof row.jev === 'string';
    var rawDirection = row.mode === 'on' ? row.changed : row.wouldChange;
    var labelDirection = row.mode === 'on' ? (row.changed || row.wouldChange) : row.wouldChange;
    var effectiveDirection = isLabelOnlyRow ? null : rawDirection;
    if (row.h && effectiveDirection && row.backend !== 'cache') {
      bucket.changedHashByFresh.set(row.h, effectiveDirection);
    }
    if (row.h && labelDirection && !effectiveDirection && row.backend !== 'cache') {
      bucket.labelWouldChangeHashesFresh.add(row.h);
    }
    if (Number.isFinite(row.ms)) bucket.latencies.push(row.ms);
  });

  var integrations = [];
  Array.from(byId.values()).forEach(function (bucket) {
    var changed = { added: 0, relaxed: 0, changed: 0 };
    bucket.changedHashByFresh.forEach(function (direction) {
      if (direction === 'added') changed.added++;
      else if (direction === 'relaxed') changed.relaxed++;
      else if (direction === 'changed') changed.changed++;
    });
    var totalChangedUnique = bucket.changedHashByFresh.size;
    var freshCalls = bucket.calls - bucket.cacheHits;
    var changedRate = freshCalls > 0 ? totalChangedUnique / freshCalls : 0;
    var agreeTotal = bucket.agreeHashesFresh.size;
    var agree = Array.from(bucket.agreeHashesFresh.values()).filter(Boolean).length;
    var agreementPct = agreeTotal > 0 ? agree / agreeTotal : null;

    var precisionHashes = Array.from(bucket.changedHashByFresh.keys()).concat(Array.from(bucket.labelWouldChangeHashesFresh));

    var good = 0; var known = 0;
    precisionHashes.forEach(function (h) {
      var outcomes = outcomesByHash.get(h);
      if (!outcomes || outcomes.length === 0) return;
      outcomes.forEach(function (o) {
        known++;
        if (!jrBadOutcome(String(o))) good++;
      });
    });
    var goodOutcomeRate = known > 0 ? good / known : null;

    var humanTP = 0; var humanFP = 0; var autoTP = 0; var autoFP = 0;
    var humanLabelByHash = opts.humanLabelByHash || new Map();
    precisionHashes.forEach(function (h) {
      var human = humanLabelByHash.get(h);
      if (human === 'tp') { humanTP++; return; }
      if (human === 'fp') { humanFP++; return; }
      var outcomes = outcomesByHash.get(h);
      if (!outcomes || outcomes.length === 0) return;
      var anyBad = outcomes.some(function (o) { return jrBadOutcome(String(o)); });
      if (anyBad) autoFP++; else autoTP++;
    });
    var tpTotal = humanTP + autoTP;

    var bySource = outcomesBySource.get(bucket.id) || {};
    var outcomeRateBySource = {};
    Object.keys(bySource).forEach(function (src) {
      var s = bySource[src];
      outcomeRateBySource[src] = s.known > 0 ? s.good / s.known : null;
    });

    var sorted = bucket.latencies.slice().sort(function (a, b) { return a - b; });
    var p50 = jrPercentile(sorted, JR_C.p50);
    var p95 = jrPercentile(sorted, JR_C.p95);
    var failureRate = bucket.calls > 0 ? bucket.failures / bucket.calls : 0;
    var budgetMs = opts.budgetMsById && opts.budgetMsById[bucket.id];

    var labeledSample = humanTP + humanFP + autoTP + autoFP;
    var lowYieldNote = changedRate < JR_C.low_yield_changed_rate ? jrT('low_yield_note', { rate: jrPct(changedRate), pct: JR_C.low_yield_pct }) : null;

    var isLabelOnly = bucket.labeled > 0 && known === 0 && labeledSample === 0;
    var labelOnlyNote = isLabelOnly
      ? jrT('label_only_note', { all: bucket.labelHashesAll.size, fresh: bucket.labelHashesFresh.size })
      : null;

    var isChoiceIntegration = bucket.labeled > 0;
    var labelWouldChangeRate = freshCalls > 0 ? bucket.labelWouldChangeHashesFresh.size / freshCalls : 0;
    var keepYieldRate = isChoiceIntegration ? labelWouldChangeRate : changedRate;

    var suggestion;
    if (bucket.calls < JR_C.min_calls) {
      suggestion = jrT('verdict_not_enough', { calls: bucket.calls, min: JR_C.min_calls });
    } else if (isLabelOnly) {
      suggestion = jrT('verdict_label_only');
    } else if (labeledSample < JR_C.min_labeled) {
      suggestion = jrT('verdict_needs_labels', { n: labeledSample, min: JR_C.min_labeled });
    } else if (
      bucket.calls >= JR_C.remove_min_calls &&
      ((goodOutcomeRate !== null && goodOutcomeRate < JR_C.remove_good_outcome_rate) ||
        failureRate > JR_C.remove_failure_rate)
    ) {
      suggestion = jrT('verdict_remove');
    } else if (
      keepYieldRate >= JR_C.keep_changed_rate &&
      goodOutcomeRate !== null && goodOutcomeRate >= JR_C.keep_good_outcome_rate
    ) {
      suggestion = jrT('verdict_keep');
    } else if (Number.isFinite(budgetMs) && Number.isFinite(p95) && p95 > budgetMs) {
      suggestion = jrT('verdict_latency');
    } else {
      suggestion = lowYieldNote ? jrT('verdict_review_note', { note: lowYieldNote }) : jrT('verdict_review');
    }

    var topLabel = null; var labelPct = null;
    var labelDistribution = {};
    if (bucket.labeled > 0) {
      bucket.labelCounts.forEach(function (n, label) {
        labelDistribution[label] = n / bucket.labeled;
        if (topLabel === null || n > bucket.labelCounts.get(topLabel)) topLabel = label;
      });
      labelPct = bucket.labelCounts.get(topLabel) / bucket.labeled;
    }

    var integrationRow = {
      id: bucket.id,
      calls: bucket.calls,
      freshCalls: freshCalls,
      cachedCalls: bucket.cacheHits,
      jevAnsweredPct: bucket.calls > 0 ? bucket.jevAnswered / bucket.calls : 0,
      cacheHits: bucket.cacheHits,
      agreementPct: agreementPct,
      agreeTotal: agreeTotal,
      excludedNoCompare: bucket.excludedNoCompare,
      topLabel: topLabel,
      labelPct: labelPct,
      labelDistribution: labelDistribution,
      changed: changed,
      changedUnique: totalChangedUnique,
      changedRate: changedRate,
      isLabelOnly: isLabelOnly,
      labelOnlyNote: labelOnlyNote,
      labelDistinctDecisions: bucket.labelHashesAll.size,
      labelDistinctFresh: bucket.labelHashesFresh.size,
      labelWouldChangeUnique: bucket.labelWouldChangeHashesFresh.size,
      goodOutcomeRate: goodOutcomeRate,
      knownOutcomes: known,
      outcomeRateBySource: outcomeRateBySource,
      failureRate: failureRate,
      p50: p50,
      p95: p95,
      costEstimate: Number.isFinite(opts.costPerCall) ? freshCalls * opts.costPerCall : null,
      realCostTotal: bucket.realCostKnown ? bucket.realCostSum : null,
      realCostPerCall: (bucket.realCostKnown && freshCalls > 0) ? bucket.realCostSum / freshCalls : null,
      realCostPerChangedDecision: (bucket.realCostKnown && totalChangedUnique > 0) ? bucket.realCostSum / totalChangedUnique : null,
      humanTP: humanTP, humanFP: humanFP, autoTP: autoTP, autoFP: autoFP,
      changedPer100: freshCalls > 0 ? (totalChangedUnique / freshCalls) * 100 : 0,
      tpPer100Human: freshCalls > 0 ? (humanTP / freshCalls) * 100 : 0,
      tpPer100Auto: freshCalls > 0 ? (autoTP / freshCalls) * 100 : 0,
      costPerTp: (bucket.realCostKnown && tpTotal > 0) ? bucket.realCostSum / tpTotal : null,
      pctCallsOver1s: freshCalls > 0 ? bucket.overOneSecFresh / freshCalls : null,
      timeouts: bucket.timeouts,
      fallbackCount: bucket.fallbackCount,
      suggestion: suggestion,
    };
    integrationRow.headline = jrBuildHeadline(integrationRow, opts.windowLabel || 'window');
    integrations.push(integrationRow);
  });

  integrations.sort(function (a, b) { return b.calls - a.calls; });
  var triageAnswers = jrBuildTriageAnswerReport(opts.triageRows || []);
  return {
    generatedAt: new Date(now).toISOString(),
    costPerCallKnown: Number.isFinite(opts.costPerCall),
    integrations: integrations,
    triageAnswers: triageAnswers,
    transports: jrBuildTransportBreakdown(rows, opts.triageRows, cutoff),
  };
}

function jrBuildCostWindows(rows, opts) {
  var out = {};
  opts.windows.forEach(function (pair) {
    out[pair[0]] = jrBuildReport(rows, {
      now: opts.now, days: pair[1], costPerCall: opts.costPerCall,
      humanLabelByHash: opts.humanLabelByHash, windowLabel: pair[0],
    });
  });
  return out;
}

// ---- budget, credit ---------------------------------------------------------------------------------------------------------

function jrComputeBudgetStatus(rows, budget, now) {
  if (!budget || budget.mode !== 'watch') return null;
  var sumWindow = function (days) {
    var cutoff = now - days * JR_C.day_ms;
    var sum = 0;
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || row.type === 'outcome') return;
      var ts = row.ts ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) return;
      if (Number.isFinite(row.costUsd)) sum += row.costUsd;
    });
    return sum;
  };
  var status = {};
  var spent;
  if (Number.isFinite(budget.usdPerDay)) {
    spent = sumWindow(1);
    status['24h'] = { spentUsd: spent, budgetUsd: budget.usdPerDay, exceeded: spent > budget.usdPerDay };
  } else {
    status['24h'] = null;
  }
  if (Number.isFinite(budget.usdPerWeek)) {
    spent = sumWindow(7);
    status['7d'] = { spentUsd: spent, budgetUsd: budget.usdPerWeek, exceeded: spent > budget.usdPerWeek };
  } else {
    status['7d'] = null;
  }
  return status;
}

// Whether today's low-credit warning is new; `state` is the parsed budget state and is updated in place when it fires.
function jrMaybeWarnLowCredit(budget, credit, state, now) {
  if (!budget || budget.mode !== 'watch' || !Number.isFinite(budget.minCreditUsd)) return null;
  if (!credit || !credit.ok || !Number.isFinite(credit.balanceUsd)) return null;
  var belowThreshold = credit.balanceUsd < budget.minCreditUsd;
  var result = { belowThreshold: belowThreshold, warnedNow: false, balanceUsd: credit.balanceUsd, minCreditUsd: budget.minCreditUsd };
  if (!belowThreshold) return result;
  var today = new Date(now).toISOString().slice(0, 10);
  if (state.creditWarnedDate !== today) {
    state.creditWarnedDate = today;
    result.warnedNow = true;
  }
  return result;
}

// ---- triggers ---------------------------------------------------------------------------------------------------------------

function jrTriggerRows(judgeTexts, supTexts) {
  var out = [];
  try {
    jrParseNdjson(judgeTexts).forEach(function (r) {
      if (r && r.event === 'trigger' && r.id) out.push({ ts: r.ts, id: r.id, outcome: r.outcome, reason: r.reason });
    });
    jrParseNdjson(supTexts).forEach(function (r) {
      if (r && r.type === 'jev-trigger' && r.integration) out.push({ ts: r.ts, id: r.integration, outcome: r.outcome, reason: r.reason });
    });
  } catch (e) { /* fail-open: no trigger section */ }
  return out;
}

function jrBuildTriggerCounts(rows) {
  var out = {};
  (rows || []).forEach(function (r) {
    var g = out[r.id] || (out[r.id] = { seen: 0, skipped: 0, skippedReasons: {} });
    if (r.outcome === 'seen') g.seen++;
    else if (r.outcome === 'skipped') {
      g.skipped++;
      var k = r.reason || 'unknown';
      g.skippedReasons[k] = (g.skippedReasons[k] || 0) + 1;
    }
  });
  return out;
}

// ---- rendering ------------------------------------------------------------------------------------------------------------

function jrPrintTransports(report) {
  var t = report.transports || [];
  if (!t.length) return;
  jrLog(jrT('transports_title'));
  t.forEach(function (r) {
    var label = r.transport === 'unrecorded' ? jrT('transports_unrecorded') : r.transport;
    jrLog(jrT('transports_line', {
      label: label, calls: r.calls, errors: r.errors, avg: r.avgMs === null ? jrT('na') : r.avgMs + 'ms', fellBack: r.fellBack,
    }));
  });
}

function jrWeeklyReason(r) {
  if (r.suggestion.indexOf(jrT('verdict_review')) === 0) {
    var m = /\((.+)\)$/.exec(r.suggestion);
    return m ? m[1] : jrT('weekly_reason_no_data');
  }
  if (r.suggestion === jrT('verdict_keep')) {
    return jrT('weekly_reason_keep', { changed: jrPct(r.changedRate), good: jrPct(r.goodOutcomeRate), calls: r.calls });
  }
  if (r.suggestion === jrT('verdict_remove')) {
    var reasons = [];
    if (r.goodOutcomeRate !== null && r.goodOutcomeRate < JR_C.remove_good_outcome_rate) reasons.push(jrT('weekly_reason_good', { rate: jrPct(r.goodOutcomeRate), pct: JR_C.remove_good_outcome_pct }));
    if (r.failureRate > JR_C.remove_failure_rate) reasons.push(jrT('weekly_reason_failure', { rate: jrPct(r.failureRate), pct: JR_C.remove_failure_pct }));
    return reasons.length ? reasons.join(', ') : jrT('weekly_reason_calls', { calls: r.calls });
  }
  return r.suggestion;
}

function jrBuildWeeklyScorecard(rows, opts) {
  var report = jrBuildReport(rows, { now: opts.now, days: JR_C.weekly_days, costPerCall: opts.costPerCall, humanLabelByHash: opts.humanLabelByHash, windowLabel: '7d' });
  var integrations = report.integrations.map(function (r) {
    return { id: r.id, calls: r.calls, suggestion: r.suggestion, reason: jrWeeklyReason(r), mode: opts.modes[r.id] };
  });
  return { generatedAt: report.generatedAt, integrations: integrations, transports: report.transports };
}

function jrPrintWeekly(sc) {
  jrLog(jrT('weekly_title', { at: sc.generatedAt }));
  if (sc.integrations.length === 0) {
    jrLog(jrT('weekly_none'));
    return;
  }
  sc.integrations.forEach(function (r) {
    jrLog(jrT('weekly_line', { id: r.id, mode: r.mode, suggestion: r.suggestion, reason: r.reason, calls: r.calls }));
  });
  jrPrintTransports(sc);
}

function jrPrintTable(report) {
  jrLog(jrT('report_title', { at: report.generatedAt }));
  if (report.integrations.length === 0) {
    jrLog(jrT('report_none'));
    return;
  }
  var header = JR_T.table_header;
  var na = jrT('na');
  var rows = report.integrations.map(function (r) {
    return [
      r.id, r.calls + ' (' + r.freshCalls + '/' + r.cachedCalls + ')', jrPct(r.jevAnsweredPct),
      r.agreementPct == null
        ? (r.excludedNoCompare > 0 ? jrT('agree_no_signal') : na)
        : jrPct(r.agreementPct) + ' (n=' + r.agreeTotal + ')',
      r.topLabel != null ? jrPct(r.labelPct) + ' (' + r.topLabel + ')' : na,
      String(r.changed.added), String(r.changed.relaxed),
      r.isLabelOnly ? jrT('changed_label_only', { n: r.labelDistinctDecisions }) : jrPct(r.changedRate),
      jrPct(r.goodOutcomeRate),
      jrPct(r.outcomeRateBySource.jev) + '/' + jrPct(r.outcomeRateBySource.regex),
      r.p50 == null ? na : String(r.p50), r.p95 == null ? na : String(r.p95),
      r.costEstimate == null ? na : '$' + r.costEstimate.toFixed(4), r.suggestion,
    ];
  });
  var widths = header.map(function (h, i) { return Math.max.apply(null, [h.length].concat(rows.map(function (r) { return r[i].length; }))); });
  var line = function (cols) { return cols.map(function (c, i) { return c.padEnd(widths[i]); }).join('  '); };
  jrLog(line(header));
  jrLog(widths.map(function (w) { return '-'.repeat(w); }).join('  '));
  rows.forEach(function (r) { jrLog(line(r)); });
  var labelOnlyRows = report.integrations.filter(function (r) { return r.isLabelOnly; });
  if (labelOnlyRows.length > 0) {
    jrLog(jrT('label_only_title'));
    labelOnlyRows.forEach(function (r) { jrLog(jrT('label_only_line', { id: r.id, note: r.labelOnlyNote })); });
  }
  if (!report.costPerCallKnown) jrLog(jrT('cost_unset'));

  var ta = report.triageAnswers;
  if (ta && (ta.urgent.n > 0 || ta.normal.n > 0)) {
    jrLog(jrT('triage_title'));
    jrLog(jrT('triage_urgent', { n: ta.urgent.n, p50: ta.urgent.p50 == null ? na : ta.urgent.p50, p95: ta.urgent.p95 == null ? na : ta.urgent.p95 }));
    jrLog(jrT('triage_normal', { n: ta.normal.n, p50: ta.normal.p50 == null ? na : ta.normal.p50, p95: ta.normal.p95 == null ? na : ta.normal.p95 }));
  }
}

function jrPrintCostWindows(costWindows) {
  var labels = Object.keys(costWindows);
  if (labels.length === 0) return;
  jrLog(jrT('cost_title'));
  labels.forEach(function (label) {
    var report = costWindows[label];
    var known = report.integrations.filter(function (r) { return r.realCostTotal !== null; });
    if (known.length === 0) {
      jrLog(jrT('cost_none', { label: label }));
      return;
    }
    jrLog(jrT('cost_label', { label: label }));
    known.forEach(function (r) {
      var perCall = r.realCostPerCall == null ? jrT('na') : jrT('cost_per_call', { v: r.realCostPerCall.toFixed(4) });
      var perChanged = r.realCostPerChangedDecision == null ? jrT('na') : jrT('cost_per_changed', { v: r.realCostPerChangedDecision.toFixed(4) });
      jrLog(jrT('cost_line', { id: r.id, calls: r.freshCalls, total: r.realCostTotal.toFixed(4), perCall: perCall, perChanged: perChanged }));
    });
  });
}

function jrPrintRealCostSummary(report) {
  var known = report.integrations.filter(function (r) { return r.realCostTotal !== null; });
  if (known.length === 0) return;
  var total = 0;
  known.forEach(function (r) { total += r.realCostTotal; });
  jrLog(jrT('group_cost_total', { total: total.toFixed(4) }));
  known.forEach(function (r) {
    var perCall = r.realCostPerCall == null ? jrT('na') : jrT('cost_per_call', { v: r.realCostPerCall.toFixed(4) });
    jrLog(jrT('group_cost_line', { id: r.id, calls: r.freshCalls, total: r.realCostTotal.toFixed(4), perCall: perCall }));
  });
}

function jrPrintBudgetStatus(status) {
  if (!status) return;
  var lines = [];
  ['24h', '7d'].forEach(function (label) {
    var s = status[label];
    if (!s) return;
    lines.push(jrT('budget_line', {
      label: label, spent: s.spentUsd.toFixed(4), budget: s.budgetUsd.toFixed(2), flag: s.exceeded ? jrT('budget_exceeded') : jrT('budget_ok'),
    }));
  });
  if (lines.length === 0) return;
  jrLog(jrT('budget_title'));
  lines.forEach(function (l) { jrLog(l); });
}

function jrPrintCredit(credit, lowCredit) {
  if (!credit) return;
  if (!credit.ok) {
    if (credit.reason === 'no-key') { jrLog(jrT('credit_no_key', { notice: JR_T.no_key_notice })); return; }
    if (credit.reason === 'disabled') return;
    if (credit.reason === 'unsupported-transport') {
      jrLog(jrT('credit_unsupported', { transport: credit.transport || jrT('credit_this_transport') }));
      return;
    }
    jrLog(jrT('credit_failed', { reason: credit.reason }));
    return;
  }
  jrLog(jrT('credit_balance', { balance: credit.balanceUsd.toFixed(2), cached: credit.cached ? jrT('credit_cached') : '' }));
  if (lowCredit && lowCredit.belowThreshold) jrLog(jrT('credit_low', { min: lowCredit.minCreditUsd.toFixed(2) }));
}

function jrPrintTriggers(triggers, report) {
  var ids = Object.keys(triggers || {}).sort();
  if (ids.length === 0) return;
  jrLog(jrT('triggers_title'));
  ids.forEach(function (id) {
    var g = triggers[id];
    var row = report && Array.isArray(report.integrations) ? report.integrations.find(function (r) { return r.id === id; }) : null;
    var calls = row ? row.calls : 0;
    var why = g.skipped ? jrT('triggers_skipped', {
      n: g.skipped, reasons: Object.entries(g.skippedReasons).map(function (e) { return jrT('triggers_reason', { reason: e[0], n: e[1] }); }).join(', '),
    }) : '';
    jrLog(jrT('triggers_line', { id: id, seen: g.seen, why: why, calls: calls, zero: calls === 0 ? jrT('triggers_zero') : '' }));
  });
}

function jrPrintHeadlines(report) {
  if (report.integrations.length === 0) return;
  jrLog(jrT('headlines_title'));
  report.integrations.forEach(function (r) { jrLog('  ' + r.headline); });
}

// ---- the two small commands -------------------------------------------------------------------------------------------------

function jrCmdLabel(argv, input) {
  var hash = argv[1];
  var hasVerdict = argv[2] === 'tp' || argv[2] === 'fp';
  var label = hasVerdict ? argv[2] : undefined;
  var res = { appendLabel: null };
  if (!hash) {
    jrEprint(jrT('label_usage_any'));
    JR_EXIT = 1;
    return res;
  }
  if (label !== undefined && label !== 'tp' && label !== 'fp') {
    jrEprint(jrT('label_usage_verdict'));
    JR_EXIT = 1;
    return res;
  }
  if (label === undefined) {
    var existing = jrLatestHumanLabelByHash(jrParseNdjson(input.labels)).get(hash);
    jrLog(hash + ': ' + (existing ? jrT('label_has', { label: existing }) : jrT('label_none')));
  } else {
    res.appendLabel = JSON.stringify({ ts: new Date(input.now).toISOString(), h: hash, label: label, source: 'human' }) + '\n';
    jrLog(jrT('label_done', { hash: hash, label: label }));
  }
  var snippet = jrAuditSnippet(input.audit, hash);
  jrLog(snippet ? jrT('label_snippet', { snippet: snippet }) : jrT('label_snippet_none'));
  return res;
}

function jrCmdPrune(argv, input) {
  var opts = jrParseArgs(argv.slice(1));
  var days = opts.days;
  var res = { audit: null };
  if (!Number.isFinite(days) || days <= 0) {
    jrEprint(jrT('prune_usage'));
    JR_EXIT = 1;
    return res;
  }
  var cutoff = input.now - days * JR_C.day_ms;
  var kept = 0; var removed = 0;
  var lines = [];
  input.audit.forEach(function (text) {
    String(text).split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      try {
        var row = JSON.parse(t);
        var ts = row && row.ts ? Date.parse(row.ts) : NaN;
        if (Number.isFinite(ts) && ts < cutoff) { removed++; return; }
        lines.push(t);
        kept++;
      } catch (e) { removed++; }
    });
  });
  res.audit = { lines: lines };
  jrLog(jrT('prune_done', { kept: kept, removed: removed, days: days }));
  return res;
}

// ---- the entry points -------------------------------------------------------------------------------------------------------

function jrBegin(input) {
  JR_C = input.cfg.thresholds;
  JR_T = input.cfg.texts;
  // decimal numbers ship as strings
  ['remove_good_outcome_rate', 'remove_failure_rate', 'keep_changed_rate', 'keep_good_outcome_rate', 'low_yield_changed_rate', 'p50', 'p95'].forEach(function (k) { JR_C[k] = Number(JR_C[k]); });
  JR_OUT = [];
  JR_ERR = [];
  JR_EXIT = 0;
}

function jrDone(extra) {
  var r = extra || {};
  r.out = JR_OUT.join('');
  r.err = JR_ERR.join('');
  r.exit = JR_EXIT;
  return r;
}

// `argv` -> what the command must read (see jrPlan).
function jevReportPlan(input) {
  return jrPlan(input.argv);
}

// One run of the command over the data it read. Returns {out, err, exit, ...effects}: appendLabel (a line to append to the labels
// file), audit ({lines}: the audit log's new content, no lines = remove it), budgetState (the budget state file's new text),
// needModes (weekly only: the integration ids whose mode the command must resolve, then call again with `modes`).
function jevReportRun(input) {
  jrBegin(input);
  var argv = input.argv;
  var now = input.now;

  if (argv[0] === 'label') return jrDone(jrCmdLabel(argv, input));
  if (argv[0] === 'prune-audit') return jrDone(jrCmdPrune(argv, input));

  var opts = jrParseArgs(argv);
  var rows = jrParseNdjson(input.assist);
  var oldestRawTs = Infinity;
  rows.forEach(function (r) {
    var t = r && typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (Number.isFinite(t) && t < oldestRawTs) oldestRawTs = t;
  });
  var rollups = [];
  input.rollups.forEach(function (f) {
    try {
      var r = JSON.parse(f);
      if (r && typeof r.day === 'string' && Array.isArray(r.groups)) rollups.push(r);
    } catch (e) { /* skip */ }
  });
  var rollupHistory = jrBuildRollupHistory(rollups, { days: opts.days, oldestRawTs: oldestRawTs, now: now });
  var triageRows = jrParseNdjson(input.triage);
  var costPerCall = null;
  var jevJson = {};
  if (input.jevJson !== null) {
    try {
      var parsed = JSON.parse(input.jevJson);
      costPerCall = (parsed && Number.isFinite(parsed.costPerCall)) ? parsed.costPerCall : null;
      jevJson = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) { costPerCall = null; jevJson = {}; }
  }
  var humanLabelByHash = jrLatestHumanLabelByHash(jrParseNdjson(input.labels));

  var rowsBeforeWindow = rows.length;
  rows = jrFilterByTimeWindow(rows, opts);
  triageRows = jrFilterByTimeWindow(triageRows, opts);
  var windowInfo = jrDescribeWindow(opts, rowsBeforeWindow, rows.length);

  if (opts.project) {
    rows = rows.filter(function (r) { return jrGroupKeyOf(r, 'project') === opts.project; });
    triageRows = triageRows.filter(function (r) { return jrGroupKeyOf(r, 'project') === opts.project; });
  }

  if (opts.weekly) {
    var modes = input.modes;
    if (modes === null) {
      var ids = jrBuildReport(rows, { now: now, days: JR_C.weekly_days, costPerCall: costPerCall, humanLabelByHash: humanLabelByHash, windowLabel: '7d' })
        .integrations.map(function (r) { return r.id; });
      return jrDone({ needModes: ids, jevCfg: jevJson });
    }
    var scorecard = jrBuildWeeklyScorecard(rows, { now: now, costPerCall: costPerCall, humanLabelByHash: humanLabelByHash, modes: modes });
    if (opts.json) jrRaw(JSON.stringify(scorecard, null, 2) + '\n');
    else jrPrintWeekly(scorecard);
    return jrDone();
  }

  if (opts.by === 'project' || opts.by === 'session') {
    var groups = jrGroupRowsBy(rows, opts.by);
    var triageGroups = jrGroupRowsBy(triageRows, opts.by);
    var byGroup = {};
    groups.forEach(function (groupRows, key) {
      byGroup[key] = jrBuildReport(groupRows, {
        now: now, days: opts.days, costPerCall: costPerCall, triageRows: triageGroups.get(key) || [], humanLabelByHash: humanLabelByHash, windowLabel: 'window',
      });
    });
    if (opts.json) {
      jrRaw(JSON.stringify({ by: opts.by, window: windowInfo, groups: byGroup }, null, 2) + '\n');
    } else {
      jrPrintWindow(windowInfo);
      groups.forEach(function (groupRows, key) {
        jrLog(jrT('group_title', { by: opts.by, key: key, n: groupRows.length }));
        jrPrintTable(byGroup[key]);
        jrPrintHeadlines(byGroup[key]);
        jrPrintTransports(byGroup[key]);
        jrPrintRealCostSummary(byGroup[key]);
      });
    }
    return jrDone();
  }

  var report = jrBuildReport(rows, { now: now, days: opts.days, costPerCall: costPerCall, triageRows: triageRows, humanLabelByHash: humanLabelByHash, windowLabel: 'window' });
  var trigOpts = {};
  Object.keys(opts).forEach(function (k) { trigOpts[k] = opts[k]; });
  trigOpts.excludeProjects = null;
  var triggers = jrBuildTriggerCounts(jrFilterByTimeWindow(jrTriggerRows(input.judge, input.supervision), trigOpts));

  var windows = [];
  if (opts.window) {
    windows.push([opts.window, Object.prototype.hasOwnProperty.call(JR_C.windows, opts.window) && JR_C.windows[opts.window] != null ? JR_C.windows[opts.window] : Number(opts.window)]);
  } else {
    Object.keys(JR_C.windows).forEach(function (k) { windows.push([k, JR_C.windows[k]]); });
  }
  var costWindows = jrBuildCostWindows(rows, { now: now, costPerCall: costPerCall, windows: windows, humanLabelByHash: humanLabelByHash });
  var budget = { mode: input.budget.mode, usdPerDay: input.budget.usdPerDay, usdPerWeek: input.budget.usdPerWeek, minCreditUsd: input.budget.minCreditUsd };
  var budgetStatus = jrComputeBudgetStatus(rows, budget, now);

  var credit = null; var lowCredit = null; var effects = {};
  try {
    credit = JSON.parse(input.credit);
    var state = {};
    try { var ps = JSON.parse(input.budgetState); state = (ps && typeof ps === 'object') ? ps : {}; } catch (e2) { state = {}; }
    var before = state.creditWarnedDate;
    lowCredit = jrMaybeWarnLowCredit(budget, credit, state, now);
    if (state.creditWarnedDate !== before) effects.budgetState = JSON.stringify(state);
  } catch (e) {
    credit = { ok: false, reason: 'error' };
  }

  if (opts.json) {
    var full = Object.assign({}, report, { window: windowInfo, costWindows: costWindows, budget: budget, budgetStatus: budgetStatus, credit: credit, lowCredit: lowCredit, rollupHistory: rollupHistory, triggers: triggers });
    jrRaw(JSON.stringify(full, null, 2) + '\n');
  } else {
    jrPrintWindow(windowInfo);
    jrPrintTable(report);
    jrPrintHeadlines(report);
    jrPrintTransports(report);
    jrPrintTriggers(triggers, report);
    jrPrintRollupHistory(rollupHistory);
    jrPrintCostWindows(costWindows);
    jrPrintBudgetStatus(budgetStatus);
    jrPrintCredit(credit, lowCredit);
  }
  return jrDone(effects);
}

// The cached credit balance when it is still fresh: the cache entry's result with `cached: true`, as JSON text (key order kept),
// else null. `input` = {cacheText, now, ttl}.
function jevReportCredit(input) {
  var cached = null;
  try {
    var p = JSON.parse(input.cacheText);
    cached = (p && typeof p === 'object') ? p : null;
  } catch (e) { cached = null; }
  if (cached && cached.vendor === 'vercel' && cached.result && Number.isFinite(cached.fetchedAt) && (input.now - cached.fetchedAt) < input.ttl) {
    return { hit: JSON.stringify(Object.assign({}, cached.result, { cached: true })) };
  }
  return { hit: null };
}
