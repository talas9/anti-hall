'use strict';
// anti-hall :: devswarm-supervision-metrics — effectiveness metrics for
// DevSwarm supervision (plan tracking + straying warnings + corrections).
//
// LOG: ~/.anti-hall/logs/devswarm-supervision.ndjson, one line per event:
//   {ts, type, id, ...}
// with type one of:
//   plan                 a step plan was written (source spawn|plan-set)
//   step                 a child reported a step status change
//   warn                 a straying warning was issued (signal, step, repeat)
//   correction           the Primary sent a correction (`devswarm.js correct`)
//   correction-followed  step progress arrived within stepStallMin of a correction
//   extra                the child tagged user-requested extra work (`scope add`)
//   done                 a child with a plan reported done (durationMs, stepsDone, stepsPlanned)
//   tokens               a child's step-progress period closed (tokens = weighted
//                        tokens spent between two step changes; stepsDone)
//   jev                  a supervision Jev answer was first read from the cache
//                        (integration, mode, agree = matches the deterministic result)
// ROLLUPS: ~/.anti-hall/logs/devswarm-supervision-daily/<YYYY-MM-DD>.json, written
// just before a rotation (1 MB, 5 generations); `devswarm.js supervision-report`
// reads raw rows first, rollups for older days.
// No message bodies and no prompt text are ever written here.
//
// Every write is best-effort and never throws. The file home comes from the
// caller's `home`, resolved through test-home-guard so a test run can never
// write into the real home.

const fs = require('fs');
const path = require('path');

const LOG_MAX_BYTES = 1024 * 1024;
const ROTATED_FILES = 5;

function homeDir(home) {
  try { return require('./test-home-guard.js').resolveHome(typeof home === 'string' && home ? home : null); }
  catch (_) { return home || require('os').homedir(); }
}
function logPath(home) { return path.join(homeDir(home), '.anti-hall', 'logs', 'devswarm-supervision.ndjson'); }

function rotateIfNeeded(p, home) {
  try {
    const st = fs.statSync(p);
    if (st.size <= LOG_MAX_BYTES) return;
    try { module.exports.writeDailyRollups(home); } catch (_) { /* before the oldest generation is replaced */ }
    const ja = require('../../hooks/lib/jev-assist.js');
    ja.shiftRotated(p, ROTATED_FILES);
  } catch (_) { /* nothing to rotate yet */ }
}

// record(home, type, fields) — append one event line. Never throws.
function record(home, type, fields) {
  try {
    const p = logPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfNeeded(p, home);
    const now = fields && Number.isFinite(fields.now) ? fields.now : Date.now();
    const row = Object.assign({ ts: new Date(now).toISOString(), type }, fields || {});
    delete row.now;
    fs.appendFileSync(p, JSON.stringify(row) + '\n');
  } catch (_) { /* best-effort */ }
}

function dailyDir(home) { return path.join(homeDir(home), '.anti-hall', 'logs', 'devswarm-supervision-daily'); }

function emptyRollup(day) {
  return { v: 1, day, plans: 0, steps: 0, warnings: {}, repeats: 0, corrections: 0, correctionsFollowed: 0,
    extras: 0, done: 0, durationsMs: [], stepsDone: 0, stepsPlanned: 0, jev: {},
    tokenPeriods: [], tokensByWorkspace: {}, doneTokens: [], burnCorrections: 0, burnFollowed: 0 };
}

const JEV_COUNTERS = ['n', 'agree', 'followed', 'overridden', 'progressWhenSupported', 'progressWhenNotSupported'];
function jevGroup(d, integration) {
  const k = integration || 'unknown';
  if (!d.jev[k]) { d.jev[k] = { byMode: {} }; for (const c of JEV_COUNTERS) d.jev[k][c] = 0; }
  return d.jev[k];
}

// buildDailyRollups(rows) -> Map<'YYYY-MM-DD', rollup> (UTC days).
function buildDailyRollups(rows) {
  const days = new Map();
  for (const r of rows) {
    const t = r && typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(t)) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, emptyRollup(day));
    const d = days.get(day);
    switch (r.type) {
      case 'plan': d.plans++; break;
      case 'step': d.steps++; break;
      case 'warn':
        d.warnings[r.signal || 'unknown'] = (d.warnings[r.signal || 'unknown'] || 0) + 1;
        if (r.repeat) d.repeats++;
        break;
      case 'correction':
        d.corrections++;
        if (Array.isArray(r.signals) && r.signals.includes('burn')) d.burnCorrections++;
        for (const n of (Array.isArray(r.jev) ? r.jev : [])) jevGroup(d, n.integration)[n.supports ? 'followed' : 'overridden']++;
        break;
      case 'correction-followed':
        d.correctionsFollowed++;
        if (Array.isArray(r.signals) && r.signals.includes('burn')) d.burnFollowed++;
        for (const n of (Array.isArray(r.jev) ? r.jev : [])) jevGroup(d, n.integration)[n.supports ? 'progressWhenSupported' : 'progressWhenNotSupported']++;
        break;
      case 'tokens':
        if (Number.isFinite(r.tokens)) {
          d.tokenPeriods.push(r.tokens);
          const id = String(r.id || 'unknown');
          d.tokensByWorkspace[id] = (d.tokensByWorkspace[id] || 0) + r.tokens;
        }
        break;
      case 'extra': d.extras++; break;
      case 'done':
        d.done++;
        if (Number.isFinite(r.durationMs)) d.durationsMs.push(r.durationMs);
        if (Number.isFinite(r.stepsDone)) d.stepsDone += r.stepsDone;
        if (Number.isFinite(r.stepsPlanned)) d.stepsPlanned += r.stepsPlanned;
        if (Number.isFinite(r.tokensTotal) && Number.isFinite(r.stepsDone) && r.stepsDone > 0) d.doneTokens.push(Math.round(r.tokensTotal / r.stepsDone));
        break;
      case 'jev': {
        const g = jevGroup(d, r.integration);
        g.n++;
        if (r.agree === true) g.agree++;
        g.byMode[r.mode || 'unknown'] = (g.byMode[r.mode || 'unknown'] || 0) + 1;
        break;
      }
      default: break;
    }
  }
  return days;
}

function retainedRows(home) {
  const ja = require('../../hooks/lib/jev-assist.js');
  return ja.readNdjsonFiles(ja.retainedLogFiles(logPath(home)));
}

// writeDailyRollups(home) -> files written. Called just before a rotation
// replaces the oldest generation. A day is (re)written when all of its rows
// are still on disk, or when it has no rollup yet. Never throws.
function writeDailyRollups(home) {
  let written = 0;
  try {
    const rows = retainedRows(home);
    let oldest = Infinity;
    for (const r of rows) { const t = Date.parse(r && r.ts); if (Number.isFinite(t) && t < oldest) oldest = t; }
    const dir = dailyDir(home);
    fs.mkdirSync(dir, { recursive: true });
    for (const [day, rollup] of buildDailyRollups(rows)) {
      const file = path.join(dir, day + '.json');
      const complete = Date.parse(day + 'T00:00:00Z') >= oldest;
      if (!complete && fs.existsSync(file)) continue;
      const tmp = file + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(Object.assign({ complete }, rollup)));
      fs.renameSync(tmp, file);
      written++;
    }
  } catch (_) { /* best-effort */ }
  return written;
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

// report(home, {days, now}) -> the aggregate over the last N UTC days (default
// 7). Raw rows win for days still on disk; older days come from the daily
// rollups. Read-only.
function report(home, opts) {
  const o = opts || {};
  const days = Number.isFinite(o.days) && o.days >= 1 ? Math.floor(o.days) : 7;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const since = new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10);
  const byDay = new Map();
  try {
    for (const n of fs.readdirSync(dailyDir(home))) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n);
      if (!m || m[1] < since) continue;
      try { byDay.set(m[1], JSON.parse(fs.readFileSync(path.join(dailyDir(home), n), 'utf8'))); } catch (_) { /* skip */ }
    }
  } catch (_) { /* no rollups yet */ }
  for (const [day, r] of buildDailyRollups(retainedRows(home))) if (day >= since) byDay.set(day, r);
  const t = emptyRollup(null);
  for (const r of byDay.values()) {
    t.plans += r.plans || 0; t.steps += r.steps || 0; t.repeats += r.repeats || 0;
    t.corrections += r.corrections || 0; t.correctionsFollowed += r.correctionsFollowed || 0;
    t.extras += r.extras || 0; t.done += r.done || 0; t.stepsDone += r.stepsDone || 0; t.stepsPlanned += r.stepsPlanned || 0;
    if (Array.isArray(r.durationsMs)) t.durationsMs.push(...r.durationsMs);
    if (Array.isArray(r.tokenPeriods)) t.tokenPeriods.push(...r.tokenPeriods);
    if (Array.isArray(r.doneTokens)) t.doneTokens.push(...r.doneTokens);
    t.burnCorrections += r.burnCorrections || 0; t.burnFollowed += r.burnFollowed || 0;
    for (const [k, n] of Object.entries(r.tokensByWorkspace || {})) t.tokensByWorkspace[k] = (t.tokensByWorkspace[k] || 0) + n;
    for (const [k, n] of Object.entries(r.warnings || {})) t.warnings[k] = (t.warnings[k] || 0) + n;
    for (const [k, g] of Object.entries(r.jev || {})) {
      const a = jevGroup(t, k);
      for (const c of JEV_COUNTERS) a[c] += g[c] || 0;
      for (const [m, n] of Object.entries(g.byMode || {})) a.byMode[m] = (a.byMode[m] || 0) + n;
    }
  }
  const warnTotal = Object.values(t.warnings).reduce((a, b) => a + b, 0);
  return {
    ok: true, action: 'supervision-report', days, since, daysWithData: byDay.size,
    plans: t.plans, stepUpdates: t.steps,
    warnings: { total: warnTotal, bySignal: t.warnings, repeats: t.repeats },
    corrections: { sent: t.corrections, followedByProgress: t.correctionsFollowed,
      followRate: t.corrections ? Math.round((t.correctionsFollowed / t.corrections) * 100) / 100 : null },
    extrasTagged: t.extras,
    tokens: {
      total: t.tokenPeriods.reduce((a, b) => a + b, 0), byWorkspace: t.tokensByWorkspace,
      stepPeriods: t.tokenPeriods.length, medianPerStepPeriod: median(t.tokenPeriods),
      medianPerCompletedStep: median(t.doneTokens),
      burn: { warnings: t.warnings.burn || 0, corrections: t.burnCorrections, followedByProgress: t.burnFollowed,
        correctedRate: t.burnCorrections ? Math.round((t.burnFollowed / t.burnCorrections) * 100) / 100 : null },
    },
    done: { n: t.done, medianDurationMs: median(t.durationsMs), stepsDone: t.stepsDone, stepsPlanned: t.stepsPlanned },
    jev: Object.fromEntries(Object.entries(t.jev).map(([k, g]) => [k, Object.assign({}, g, {
      agreeRate: g.n ? Math.round((g.agree / g.n) * 100) / 100 : null,
      followRate: (g.followed + g.overridden) ? Math.round((g.followed / (g.followed + g.overridden)) * 100) / 100 : null,
    })])),
  };
}

// formatReport(r) -> human-readable text for `devswarm.js supervision-report`.
function formatReport(r) {
  const dur = (ms) => (ms == null ? '—' : require('./devswarm-plan.js').dur(ms));
  const tok = (n) => (n == null ? '—' : require('./devswarm-token-usage.js').fmt(n));
  const sig = Object.entries(r.warnings.bySignal).map(([k, n]) => k + ' ' + n).join(', ') || 'none';
  const lines = [
    'DevSwarm supervision — last ' + r.days + ' day(s) (since ' + r.since + ', ' + r.daysWithData + ' with data)',
    '  plans written:        ' + r.plans + ' (step updates ' + r.stepUpdates + ')',
    '  straying warnings:    ' + r.warnings.total + ' (' + sig + '; repeats ' + r.warnings.repeats + ')',
    '  corrections:          ' + r.corrections.sent + ' sent, ' + r.corrections.followedByProgress + ' followed by step progress'
      + (r.corrections.followRate == null ? '' : ' (' + Math.round(r.corrections.followRate * 100) + '%)'),
    '  extras tagged:        ' + r.extrasTagged,
    '  tokens (weighted):    ' + tok(r.tokens.total) + ' over ' + r.tokens.stepPeriods + ' step period(s); median per step period '
      + tok(r.tokens.medianPerStepPeriod) + ', per completed step ' + tok(r.tokens.medianPerCompletedStep),
    '  token burn:           ' + r.tokens.burn.warnings + ' warning(s), ' + r.tokens.burn.corrections + ' correction(s), '
      + r.tokens.burn.followedByProgress + ' followed by progress'
      + (r.tokens.burn.correctedRate == null ? '' : ' (' + Math.round(r.tokens.burn.correctedRate * 100) + '%)'),
    '  done with a plan:     ' + r.done.n + ' (median time-to-done ' + dur(r.done.medianDurationMs) + ', steps ' + r.done.stepsDone + '/' + r.done.stepsPlanned + ')',
  ];
  const ws = Object.entries(r.tokens.byWorkspace).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (ws.length) lines.push('  top workspaces:       ' + ws.map(([id, n]) => id + ' ' + tok(n)).join(', '));
  const jev = Object.entries(r.jev);
  if (!jev.length) lines.push('  Jev: no answers yet');
  for (const [k, g] of jev) {
    lines.push('  Jev ' + k + ': ' + g.agree + '/' + g.n + ' agree with the deterministic result'
      + (g.agreeRate == null ? '' : ' (' + Math.round(g.agreeRate * 100) + '%)')
      + ' [' + Object.entries(g.byMode).map(([m, n]) => m + ' ' + n).join(', ') + ']'
      + '; Primary followed ' + g.followed + ' / overrode ' + g.overridden
      + '; progress after correction ' + g.progressWhenSupported + ' when Jev backed the warning, ' + g.progressWhenNotSupported + ' when not');
  }
  return lines.join('\n');
}

// doctorLine(home, now) -> one-line 7-day summary, or null when no log exists.
function doctorLine(home, now) {
  try {
    if (!fs.existsSync(logPath(home))) return null;
    const r = report(home, { days: 7, now });
    return 'supervision (7d): ' + r.warnings.total + ' straying warning(s), ' + r.corrections.sent + ' correction(s) ('
      + r.corrections.followedByProgress + ' followed by progress), ' + r.extrasTagged + ' extra(s) tagged, '
      + r.done.n + ' plan(s) done, ' + require('./devswarm-token-usage.js').fmt(r.tokens.total) + ' tokens over closed steps — `devswarm.js supervision-report`';
  } catch (_) { return null; }
}

module.exports = { logPath, dailyDir, record, buildDailyRollups, writeDailyRollups, report, formatReport, doctorLine, LOG_MAX_BYTES, ROTATED_FILES };
