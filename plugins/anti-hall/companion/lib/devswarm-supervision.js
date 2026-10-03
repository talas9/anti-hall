'use strict';
// anti-hall :: devswarm-supervision — straying detection for child workspaces
// that have a step plan (Meeseeks P2). Called once per child from the
// supervisor sweep, after its liveness verdict is written.
//
// THREE DETERMINISTIC SIGNALS (a child without a plan gets none of them):
//   stall     — busy (verdict alive) but no step progress for
//               devswarm.stepStallMin minutes (default 30), measured from the
//               latest of the last step change, the last child activity with
//               NEW text (heartbeat --summary / a send; an identical repeat
//               does not count, so a looping child still stalls) and the last
//               correction.
//   off-scope — `ready-check --allow <scope ∪ extras>` over the child's commits
//               since its fork point finds files outside the plan's scope
//               globs. Only when the plan has scope globs.
//   idle      — the existing liveness verdict is stale/nudged/escalated.
//   burn      — the child's own transcript shows more than
//               devswarm.burnTokensWarn weighted tokens (default 2M; cache
//               reads weighted by devswarm.burnCacheReadPct, 10%) since its
//               last step progress (companion/lib/devswarm-token-usage.js).
//
// WARN EXACTLY ONCE: each signal episode has a stable key (signal + step + the
// progress/verdict timestamp or the off-scope file set). A key warns once; a
// new episode of the same signal on the same step (after progress or a
// correction) warns again, up to devswarm.strayWarnMax per signal per step
// (default 2; 0 turns warnings off). The state lives in
// ~/.anti-hall/devswarm/stray/<planKey>.json, which the parent Stop gate reads
// to print ONE capped advisory `DEVSWARM STRAYING` line.
//
// ADVISORY ONLY: nothing here messages the child, blocks the Primary, or kills
// anything. The correction is a Primary-run verb (`devswarm.js correct <id>`).
// Fail-open everywhere: an error for one child never affects the sweep.

const crypto = require('crypto');
const planLib = require('./devswarm-plan.js');
const metrics = require('./devswarm-supervision-metrics.js');
const tokenUsage = require('./devswarm-token-usage.js');

const MAX_FILES_SHOWN = 5;

function shortHash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10); }

// offScopeFiles(plan, worktreePath, deps) -> { files, head } | null (unknown).
// Reuses scripts/devswarm.js's read-only `ready-check` (lazy require — the CLI
// module is only loaded for a child that actually has scope globs).
function offScopeFiles(plan, worktreePath, deps) {
  if (!Array.isArray(plan.scope_globs) || !plan.scope_globs.length || !worktreePath) return null;
  const allow = plan.scope_globs.concat((plan.extras || []).map((e) => e.glob)).join(',');
  const base = plan.base || 'origin/HEAD';
  const readyCheck = deps.readyCheck || ((cwd, b, a) => {
    const cli = require('../../scripts/devswarm.js');
    return cli.cmdReadyCheck('HEAD', { base: [b], allow: [a] }, { cwd });
  });
  const r = readyCheck(worktreePath, base, allow);
  if (!r || r.ok === false || (Array.isArray(r.reasons) && r.reasons.includes('diff-unknown'))) return null;
  return { files: Array.isArray(r.outside_allowed) ? r.outside_allowed : [] };
}

// deterministicSignals(plan, verdict, ctx) -> [{signal, step, key, reason, files?}]
function deterministicSignals(plan, verdict, ctx) {
  const { now, stallMs, worktreePath, deps, usage, burnWarn, dormant } = ctx;
  const cur = planLib.currentStep(plan);
  if (!cur) return [];
  const out = [];
  // A child whose latest report is a done-report (`devswarm.js done`) is
  // awaiting its parent, not stalled: no idle/stall/burn signals until a new
  // step report lifts plan.done_reported_at (planLib.applyStep).
  // A DORMANT workspace (session not alive: no live process, activity past the
  // window — liveness.js rowLivenessState) is surfaced as `dormant` in the
  // roster; flagging it as stalled/idle/burning too is contradictory noise, so
  // those three signals are suppressed (off-scope is about files, kept).
  const awaitingParent = Number.isFinite(plan.done_reported_at) || dormant === true;
  const status = verdict && verdict.status;
  const lastProgress = Math.max(
    Number.isFinite(plan.step_ts) ? plan.step_ts : (Number.isFinite(plan.created_at) ? plan.created_at : now),
    Number.isFinite(plan.activity_ts) ? plan.activity_ts : 0,
    Number.isFinite(plan.warned_at) ? plan.warned_at : 0,
  );
  if (awaitingParent) {
    // no liveness/progress signals for a done child
  } else if (status === 'stale' || status === 'nudged' || status === 'escalated') {
    const since = Number.isFinite(verdict.staleSince) ? verdict.staleSince : lastProgress;
    out.push({ signal: 'idle', step: cur.n, key: 'idle:' + cur.n + ':' + since, reason: 'idle ' + planLib.dur(now - since) });
  } else if (status === 'alive' && now - lastProgress >= stallMs) {
    out.push({ signal: 'stall', step: cur.n, key: 'stall:' + cur.n + ':' + lastProgress, reason: 'no step progress ' + planLib.dur(now - lastProgress) });
  }
  if (!awaitingParent && usage && burnWarn > 0 && usage.sinceStep >= burnWarn) {
    out.push({ signal: 'burn', step: cur.n, key: 'burn:' + cur.n + ':' + usage.markTs,
      reason: 'used ' + tokenUsage.fmt(usage.sinceStep) + ' tokens since step ' + cur.n + ' last moved' });
  }
  let off = null;
  try { off = offScopeFiles(plan, worktreePath, deps); } catch (_) { off = null; }
  if (off && off.files.length) {
    const files = off.files.slice().sort();
    out.push({
      signal: 'off-scope', step: cur.n, key: 'off-scope:' + cur.n + ':' + shortHash(files.join('\n')),
      reason: 'off-scope ' + files.slice(0, MAX_FILES_SHOWN).join(', ') + (files.length > MAX_FILES_SHOWN ? ' (+' + (files.length - MAX_FILES_SHOWN) + ' more)' : ''),
      files: files.slice(0, 50),
    });
  }
  return out;
}

// evaluateChild(d, verdict, opts) -> { key, signals, issued } | null.
// d = descriptor {id, worktreePath}. opts = {home, env, now, deps}.
function evaluateChild(d, verdict, opts) {
  const o = opts || {};
  const home = o.home;
  const env = o.env || process.env;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const deps = o.deps || {};
  const sOpts = { env, home };
  if (!planLib.planTrackingEnabled(sOpts)) return null;
  const warnMax = planLib.strayWarnMax(sOpts);
  const found = planLib.findPlan(home, { id: d.id, worktreePath: d.worktreePath });
  if (!found || !found.plan.steps.length) return null;
  const plan = found.plan;
  const stallMs = planLib.stepStallMs(sOpts);

  // Token burn: incremental read of the child's own transcript (fail-open).
  const markTs = Number.isFinite(plan.step_ts) ? plan.step_ts : plan.created_at;
  const usage = (deps.tokenUsage || tokenUsage.update)(home, found.key, d, markTs, { cacheReadWeight: tokenUsage.cacheReadWeight(sOpts) });
  if (usage && usage.closed && usage.closed.tokens > 0) {
    metrics.record(home, 'tokens', { now, id: d.id, key: found.key, tokens: usage.closed.tokens, stepsDone: planLib.stepsDone(plan) });
  }
  // Same rule the roster label uses (one derivation, so they cannot disagree).
  let dormant = false;
  try {
    const livenessOf = deps.rowLivenessState || require('./liveness.js').rowLivenessState;
    dormant = livenessOf({ id: d.id, worktreePath: d.worktreePath || plan.worktreePath, sessionId: d.sessionId }, home,
      { now, env, lastOutboundTs: verdict && verdict.lastOutboundTs }) === 'dormant';
  } catch (_) { dormant = false; }
  let signals = deterministicSignals(plan, verdict, { now, stallMs, worktreePath: d.worktreePath || plan.worktreePath, deps,
    usage, dormant, burnWarn: tokenUsage.burnTokensWarn(sOpts) });
  // Jev integrations (companion/lib/devswarm-supervision-jev.js, all default
  // shadow) may drop a deterministic signal or add one — only when promoted
  // to "on". Never anything else. deps.jevAdjust = false skips them (tests).
  if (deps.jevAdjust !== false) {
    const adjust = typeof deps.jevAdjust === 'function' ? deps.jevAdjust : require('./devswarm-supervision-jev.js').jevAdjust;
    try { signals = adjust({ d, key: found.key, plan, verdict, signals, now, stallMs, home, env, usage, deps: deps.jev || {} }) || signals; } catch (_) { /* fail-open */ }
  }

  const prev = planLib.readStray(home, found.key) || {};
  const state = {
    v: 1, key: found.key, id: d.id, worktreePath: d.worktreePath || plan.worktreePath || null,
    warned: prev.warned && typeof prev.warned === 'object' ? prev.warned : {},
    perStep: prev.perStep && typeof prev.perStep === 'object' ? prev.perStep : {},
    active: [],
    updated_at: now,
  };
  const issued = [];
  for (const s of signals) {
    let w = state.warned[s.key];
    if (!w && warnMax > 0) {
      const capKey = s.signal + ':' + s.step;
      const n = state.perStep[capKey] || 0;
      if (n < warnMax) {
        w = { at: now, n: n + 1, signal: s.signal, step: s.step };
        state.warned[s.key] = w;
        state.perStep[capKey] = n + 1;
        issued.push(Object.assign({ repeat: n > 0 }, s));
      }
    }
    if (w) state.active.push({ key: s.key, signal: s.signal, step: s.step, reason: s.reason, files: s.files, at: w.at, n: w.n, jev: s.jev });
  }
  // Keep the warned map bounded (oldest dropped first).
  const keys = Object.keys(state.warned);
  if (keys.length > 100) {
    keys.sort((a, b) => (state.warned[a].at || 0) - (state.warned[b].at || 0));
    for (const k of keys.slice(0, keys.length - 100)) delete state.warned[k];
  }
  try { planLib.saveStray(home, found.key, state); } catch (_) { /* fail-open */ }
  for (const s of issued) {
    metrics.record(home, 'warn', { now, id: d.id, key: found.key, signal: s.signal, step: s.step, repeat: s.repeat });
    try {
      // Stable alert kind; the child id rides in details, never in the kind.
      require('./anti-hall-log.js').logEvent('devswarm-supervisor', 'straying', 'warn', 'DEVSWARM STRAYING',
        { kind: 'devswarm-straying', details: { id: d.id, signal: s.signal, step: s.step, reason: s.reason } });
    } catch (_) { /* best-effort */ }
  }
  return { key: found.key, signals, issued, usage };
}

// correctionText(id, plan, stray, now) -> the correction message a Primary
// sends with `devswarm.js correct <id>`.
function correctionText(id, plan, stray, now) {
  const cur = planLib.currentStep(plan);
  const n = cur ? cur.n : plan.steps.length;
  const text = cur ? cur.text : 'final report';
  const reasons = (stray && Array.isArray(stray.active) ? stray.active : []).map((a) => a.reason).filter(Boolean);
  if (!reasons.length) {
    const since = Number.isFinite(plan.step_ts) ? plan.step_ts : plan.created_at;
    reasons.push('no progress ' + planLib.dur(now - since));
  }
  return 'step ' + n + ' \'' + text + '\': ' + reasons.join(' / ') + '. Return to step ' + n
    + ' or reply BLOCKED <why>. If the user asked you for this extra work, record it with '
    + '`devswarm.js scope add ' + id + ' --glob \'<glob>\' --note \'<what they asked>\'`.';
}

// jevText(notes) -> ' (Jev: off-brief 0.88)' — Jev's recommendation, or ''.
function jevText(notes) {
  if (!Array.isArray(notes) || !notes.length) return '';
  return ' (Jev: ' + notes.map((n) => n.verdict + ' ' + Number(n.confidence).toFixed(2)).join('; ') + ')';
}

// strayingLine(entries, nameOf) -> 'DEVSWARM STRAYING: <title>: <reason>; …' (capped).
const LINE_MAX_ENTRIES = 3;
function strayingLine(entries, nameOf) {
  const parts = entries.slice(0, LINE_MAX_ENTRIES).map((e) => {
    const title = (nameOf && nameOf(e.id)) || e.id;
    return title + ': step ' + e.step + ' ' + e.reason + jevText(e.jev);
  });
  const more = entries.length > LINE_MAX_ENTRIES ? ' (+' + (entries.length - LINE_MAX_ENTRIES) + ' more)' : '';
  return 'DEVSWARM STRAYING: ' + parts.join('; ') + more
    + ' — advisory (Jev notes are recommendations; your call); `devswarm.js correct <id>` sends the correction.';
}

module.exports = { evaluateChild, deterministicSignals, offScopeFiles, correctionText, strayingLine, jevText, LINE_MAX_ENTRIES };
