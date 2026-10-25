// rules = "rules/coordinator-work-baseline" (the verb `ah-engine coordinator-work-baseline`, the port of scripts/coordinator-work-baseline.js):
// replay a session transcript's main-thread Bash calls through the coordinator-work classifier and window and say what the guard would
// have done: a "before" number for a session that ran without it. The command reads the transcript and asks this script, through the
// script host (JSON in, JSON out), to build the calls, classify them and run the window; it builds on command.js (the classifier,
// `classifyBashWork`) and coordinator-work-guard.js (the window steps and its configuration): script.includes. Every default comes from
// engine/defaults (small_guards.toml coordinator_work.*, operator_cli.toml opcli.cwb_*).
'use strict';

function cwbShare(num, den) { return den > 0 ? num / den : null; }

// the rows of the transcript: input.lines is [[lineNumber, text], ...] (the lines that can hold a Bash tool use or its result)
function cwbRows(input) {
  var rows = [], byId = new Map();
  input.lines.forEach(function (ln) {
    if (ln[0] < input.fromLine) return;
    var e;
    try { e = JSON.parse(ln[1]); } catch (err) { return; }
    if (!e || e.isSidechain === true) return;
    var content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    if (e.type === 'assistant') {
      content.forEach(function (b) {
        if (!b || b.type !== 'tool_use' || b.name !== 'Bash' || !b.input || typeof b.input.command !== 'string') return;
        var row = { n: rows.length + 1, ts: e.timestamp, command: b.input.command, cwd: input.cwd || e.cwd || input.processCwd, posted: true };
        rows.push(row);
        if (b.id) byId.set(b.id, row);
      });
    } else if (e.type === 'user') {
      content.forEach(function (b) {
        if (b && b.type === 'tool_result' && byId.has(b.tool_use_id)) byId.get(b.tool_use_id).posted = !b.is_error;
      });
    }
  });
  return rows;
}

// classify one command the way the guard does; null when only the hook process could answer (counted by the caller)
function cwbClassify(command, cwd, start) {
  cmdBegin({});
  var verdict = null;
  try {
    verdict = classifyBashWork(command, { cwd: cwd, session_id: 'replay' }, { sessionStartTs: start });
  } catch (e) {
    if (!cmdFatal(e)) throw e;
    verdict = null;
  }
  if (cmdEnd()) verdict = null;
  return verdict;
}

// coordinator-work.js `replay`
function cwbReplay(rows, cfg, unclassified) {
  var start = rows.length ? Date.parse(rows[0].ts) : Date.now();
  var labeled = rows.map(function (r, i) {
    var c = cwbClassify(r.command, r.cwd, start);
    if (c === null) unclassified.count++;
    return { n: r.n !== undefined ? r.n : i + 1, now: Date.parse(r.ts), posted: r.posted !== false, work: !!(c && c.work), blockable: !!(c && c.blockable) };
  });
  var rec = cwEmptyState('replay');
  labeled.forEach(function (l) { if (l.posted) cwStepPost(rec, { now: l.now, work: l.work }, cfg); });
  var enf = cwEmptyState('replay');
  var crossings = [], blocks = [];
  labeled.forEach(function (l) {
    if (cwCheckPre(enf, { now: l.now, work: l.work, blockable: l.blockable }, cfg).wouldBlock) { blocks.push(l.n); return; }
    if (!l.posted) return;
    if (cwStepPost(enf, { now: l.now, work: l.work }, cfg).crossing) crossings.push(l.n);
  });
  return { calls: rec.calls, work: rec.work, share: cwbShare(rec.work, rec.calls),
    attemptedShare: cwbShare(enf.work + blocks.length, enf.calls + blocks.length), wouldNudge: crossings.length, wouldBlock: blocks.length };
}

// -> {out, unclassified}: input {lines, fromLine, cwd, processCwd, json, cfg}
function cwbRun(input) {
  var C = input.cfg;
  var rows = cwbRows(input);
  var cfg = cwConfig();
  if (!cfg.tMs) {
    cfg = { tMs: ah.cfg('coordinator_work.window_default') * 60000, nudgeAt: ah.cfg('coordinator_work.nudge_default'),
      blockAt: ah.cfg('coordinator_work.block_default'), cap: ah.cfg('coordinator_work.cap_default') };
  }
  var unclassified = { count: 0 };
  var r = cwbReplay(rows, cfg, unclassified);
  var pct = function (x) { return x == null ? C.dr_na : (Math.round(x * 1000) / 10) + '%'; };
  var out = input.json
    ? JSON.stringify({ calls: r.calls, work: r.work, share: r.share, attemptedShare: r.attemptedShare, wouldNudge: r.wouldNudge, wouldBlock: r.wouldBlock })
    : C.cwb_line.replace('{calls}', r.calls).replace('{work}', r.work).replace('{share}', pct(r.share)).replace('{attempted}', pct(r.attemptedShare))
        .replace('{nudge}', r.wouldNudge).replace('{block}', r.wouldBlock);
  return { out: out + '\n', unclassified: unclassified.count };
}
