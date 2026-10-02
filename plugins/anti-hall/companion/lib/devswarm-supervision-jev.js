'use strict';
// anti-hall :: devswarm-supervision-jev — the five Jev integrations behind
// DevSwarm straying supervision (Meeseeks P2). Called ONLY from the supervisor
// sweep (companion/lib/devswarm-supervision.js evaluateChild), never from a
// per-turn hook. All five default to "on" = RECOMMENDATION (owner, 0.117.0):
// Jev's verdict + confidence ride on the straying warning ("Jev: off-brief
// (0.88)") in the Primary's STRAYING line and the roster; the Primary makes
// the final call. Jev never suppresses a deterministic warning, never blocks,
// never kills. "shadow" = asked and logged, nothing shown; "off" = not asked.
//
//   devswarmOnBrief         over `off-scope`: is this work off the brief?
//   devswarmExtraSanctioned over `off-scope`: did the user ask for this extra work?
//   devswarmWaitKind        over `idle`/`stall`: stuck, or waiting on CI/owner/peer?
//   devswarmLoop            over `burn`/`stall` (or its own advisory `loop`): looping?
//                           (asked when the step is older than 2x stepStallMin or
//                           a `burn` warning fired; the burn figure is an input)
//   devswarmStepMap         advisory: which step does a summary without --step describe?
//
// CADENCE (same idea as supervisorBlockerLabel): a question is asked with
// jevAssist.askDetached (zero latency, the worker logs to jev-assist.ndjson and
// fills the shared cache) only when its deterministic precondition holds, and
// only once per input hash per devswarm.supervisorBlockerLabelReaskSec. The
// NEXT sweep reads the answer from the cache. A cached answer is counted once
// per hash in the supervision metrics (`jev` event: agree / disagree with the
// deterministic result) — that is the shadow-agreement measure.
//
// EFFECT: mode "on" AND the cached answer clears its threshold -> a
// recommendation note on the signal (sig.jev = [{integration, verdict,
// confidence, supports}]). devswarmLoop with no warning to annotate adds its
// own advisory `loop` signal; devswarmStepMap fills an inferred `~N` step.
// Otherwise (off, shadow, no answer yet, low confidence, any error) the
// deterministic signals stand unchanged. Inputs are capped and scrubbed.
// Mode "off" (the whole of Jev disabled included) costs one config read: no
// log row, no spawn, no state write.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const planLib = require('./devswarm-plan.js');
const metrics = require('./devswarm-supervision-metrics.js');
const { devswarmRoot, isSafeId } = require('./liveness.js');

const IDS = ['devswarmOnBrief', 'devswarmExtraSanctioned', 'devswarmWaitKind', 'devswarmLoop', 'devswarmStepMap'];
const CAPS = { devswarmOnBrief: 1500, devswarmExtraSanctioned: 1000, devswarmWaitKind: 800, devswarmLoop: 1200, devswarmStepMap: 1000 };
// Design thresholds; the configured jev.confidenceThreshold (default 0.85) is
// the floor for the three that the design pins at "the existing threshold".
const MIN_THRESHOLD = { devswarmLoop: 0.9, devswarmExtraSanctioned: 0.9 };
const STEPMAP_THRESHOLD = 0.8;
const DEFAULT_REASK_MS = 6 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 3000;

function jevAssist() { return require('../../hooks/lib/jev-assist.js'); }
function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function statePath(home, key) { return path.join(devswarmRoot(home), 'supervision-jev', key + '.json'); }
function readState(home, key) {
  try { const v = JSON.parse(fs.readFileSync(statePath(home, key), 'utf8')); return v && typeof v === 'object' ? v : {}; }
  catch (_) { return {}; }
}
function writeState(home, key, st) {
  try {
    const p = statePath(home, key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, p);
  } catch (_) { /* best-effort */ }
}

function reaskMs(env, home) {
  try {
    const sec = require('../../hooks/lib/settings.js').get('devswarm', 'supervisorBlockerLabelReaskSec', DEFAULT_REASK_MS / 1000, { env: env || process.env, home });
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_REASK_MS;
  } catch (_) { return DEFAULT_REASK_MS; }
}

function readCacheEntry(h, hash) {
  try {
    const c = JSON.parse(fs.readFileSync(jevAssist().cachePath(h), 'utf8'));
    const e = c && c[hash];
    return e && typeof e === 'object' ? e : null;
  } catch (_) { return null; }
}

// gitRecent(wt) -> { subjects: [≤5], churn: [{file, n}] } from the last 10
// commits. Read-only; any failure -> empty.
function gitRecent(wt) {
  const out = { subjects: [], churn: [] };
  if (!wt) return out;
  try {
    const r = cp.spawnSync('git', ['-C', wt, 'log', '-10', '--format=%x01%s', '--name-only'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    if (r.status !== 0 || !r.stdout) return out;
    const counts = {};
    for (const block of r.stdout.split('\x01').slice(1)) {
      const lines = block.split('\n');
      if (out.subjects.length < 5) out.subjects.push(lines[0]);
      for (const f of lines.slice(1)) if (f.trim()) counts[f.trim()] = (counts[f.trim()] || 0) + 1;
    }
    out.churn = Object.keys(counts).filter((f) => counts[f] >= 3).sort((a, b) => counts[b] - counts[a]).slice(0, 8).map((f) => ({ file: f, n: counts[f] }));
  } catch (_) { /* empty */ }
  return out;
}

// recentUserPrompts(home, d) -> the child's last ≤3 user-typed prompts (tail
// of its own transcript, bounded read), scrubbed. [] when unknown.
function recentUserPrompts(home, d) {
  if (!d || typeof d.sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(d.sessionId) || !d.worktreePath) return [];
  let fd = null;
  try {
    const { projectDirFor } = require('./target-session.js');
    const file = path.join(projectDirFor(d.worktreePath, home), d.sessionId + '.jsonl');
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const prompts = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"user"')) continue;
      let j; try { j = JSON.parse(line); } catch (_) { continue; }
      if (!j || j.type !== 'user' || j.isMeta || !j.message) continue;
      const c = j.message.content;
      const text = typeof c === 'string' ? c
        : (Array.isArray(c) && c.every((x) => x && x.type === 'text') ? c.map((x) => x.text).join('\n') : '');
      if (text && !/^<(command|local-command|task-notification|system-reminder)/.test(text.trim())) prompts.push(text);
    }
    return prompts.slice(-3).map((t) => jevAssist().scrubSecrets(cap(t, 400)));
  } catch (_) { return []; }
  finally { try { if (fd != null) fs.closeSync(fd); } catch (_) {} }
}

// consult(c, spec) -> { mode, answer, confidence } (a cached answer) |
// { mode, pending: true } | null (mode off / nothing to ask). Asks detached
// at most once per input hash per re-ask window; records one `jev` metrics
// event per newly-seen cached answer.
function consult(c, spec) {
  const ja = jevAssist();
  const state = cap(ja.scrubSecrets(spec.state), CAPS[spec.id]);
  // The cache/dedupe key uses spec.stable (no elapsed-time text) when given,
  // so a question is not re-asked every sweep just because "45m" became "46m".
  const cacheKey = c.key + '\u0001' + spec.id + '\u0001' + (spec.stable != null ? String(spec.stable) : state);
  const p = ja.prepare({ id: spec.id, home: c.home, trust: spec.trust, baseline: spec.baseline, cacheKey, state });
  if (p.skip) return null;
  const st = c.jevState[spec.id] || {};
  c.jevState[spec.id] = st;
  const hit = readCacheEntry(p.h, p.hash);
  if (hit) {
    const conf = Number.isFinite(hit.confidence) ? hit.confidence : 0;
    if (st.resolved !== p.hash) {
      st.resolved = p.hash;
      c.dirty = true;
      metrics.record(c.home, 'jev', { now: c.now, id: c.d.id, key: c.key, integration: spec.id, mode: p.mode,
        agree: spec.agree(hit.answer), confidence: conf });
    }
    return { mode: p.mode, answer: hit.answer, confidence: conf, threshold: p.threshold };
  }
  if (st.hash === p.hash && c.now - (st.askedAt || 0) < c.reaskMs) return { mode: p.mode, pending: true };
  const ask = c.deps.askDetached || ja.askDetached;
  ask({ id: spec.id, question: spec.question, state, trust: spec.trust, baseline: spec.baseline, cacheKey, home: c.home });
  st.hash = p.hash; st.askedAt = c.now;
  c.dirty = true;
  return { mode: p.mode, pending: true };
}

// trigger(c, id, tkey, outcome, reason) — "measure everything": records that an
// integration's TRIGGER occurred ('seen') or that it occurred but nothing was
// asked ('skipped' + reason), once per distinct (integration, outcome, trigger
// key) so a signal that persists across sweeps counts once. Zero-call
// integrations otherwise leave no trace of whether their trigger ever fired.
// One `jev-trigger` event in the supervision metrics log; fail-open.
function trigger(c, id, tkey, outcome, reason) {
  try {
    const st = c.jevState[id] || {};
    c.jevState[id] = st;
    const mark = outcome + ':' + tkey;
    if ((st.trigSeen || {})[mark]) return;
    st.trigSeen = Object.assign({}, st.trigSeen);
    // bounded: keep only the most recent marks
    const keys = Object.keys(st.trigSeen);
    if (keys.length >= 20) delete st.trigSeen[keys[0]];
    st.trigSeen[mark] = 1;
    c.dirty = true;
    const f = { now: c.now, id: c.d && c.d.id, key: c.key, integration: id, outcome };
    if (reason) f.reason = reason;
    metrics.record(c.home, 'jev-trigger', f);
  } catch (_) { /* best-effort */ }
}

function effective(r, threshold) {
  return !!(r && r.mode === 'on' && !r.pending && r.confidence >= threshold);
}

// note(signal, integration, r, verdict, supports) — attach a Jev
// recommendation to a signal (never removes it). `supports` = Jev agrees the
// warning is real; the Primary makes the final call.
function note(sig, integration, r, verdict, supports) {
  sig.jev = (Array.isArray(sig.jev) ? sig.jev : []).concat([{ integration, verdict, confidence: Math.round(r.confidence * 100) / 100, supports }]);
}

// jevAdjust(ctx) -> signals (possibly adjusted). ctx = {d, key, plan, verdict,
// signals, now, stallMs, home, env, usage, deps}. Never throws.
function jevAdjust(ctx) {
  let signals = ctx.signals;
  try {
    signals = signals.map((x) => Object.assign({}, x));
    const plan = ctx.plan;
    const cur = planLib.currentStep(plan);
    if (!cur || !isSafeId(ctx.key)) return signals;
    const c = {
      d: ctx.d, key: ctx.key, home: ctx.home, now: ctx.now, deps: ctx.deps || {},
      reaskMs: reaskMs(ctx.env, ctx.home), jevState: readState(ctx.home, ctx.key), dirty: false,
    };
    const summaries = (Array.isArray(plan.summaries) ? plan.summaries : []).map((s) => s.text).filter(Boolean);
    const stepLine = 'latest touched step ' + cur.n + ' (' + planLib.stepsDone(plan) + '/' + plan.steps.length + ' done): ' + cur.text + (cur.status === 'blocked' ? ' (blocked)' : '');
    const git = (c.deps.gitRecent || gitRecent)(ctx.d.worktreePath || plan.worktreePath);
    const has = (sig) => signals.some((s) => s.signal === sig);

    const off = signals.find((s) => s.signal === 'off-scope');
    if (off) {
      const files = (off.files || []).slice(0, 20).join(', ');
      const tkey = String(off.key || off.step || 'off-scope');
      trigger(c, 'devswarmOnBrief', tkey, 'seen');
      trigger(c, 'devswarmExtraSanctioned', tkey, 'seen');
      const onBrief = consult(c, {
        id: 'devswarmOnBrief', trust: 'relax-block', baseline: true,
        question: { type: 'noul', instructions: 'A child workspace was given a step plan and a file scope. Is the work described below OFF its brief (not needed for any of its steps)?',
          criteria: { true: 'off the brief', false: 'on the brief (needed for its steps)' } },
        state: stepLine + '\nscope: ' + (plan.scope_globs || []).join(', ') + '\nrecent summaries: ' + summaries.join(' | ')
          + '\nrecent commits: ' + git.subjects.join(' | ') + '\nfiles outside scope: ' + files,
        agree: (a) => a === true,
      });
      const extra = consult(c, {
        id: 'devswarmExtraSanctioned', trust: 'relax-block', baseline: true,
        question: { type: 'noul', instructions: 'A child workspace changed files outside its assigned scope. Given the user prompts it received, is this extra work UNSANCTIONED (the user did not ask for it)?',
          criteria: { true: 'unsanctioned: the user did not ask for it', false: 'the user asked for this work' } },
        state: 'user prompts: ' + (c.deps.recentUserPrompts || recentUserPrompts)(ctx.home, ctx.d).join(' | ') + '\nfiles outside scope: ' + files,
        agree: (a) => a === true,
      });
      if (!onBrief) trigger(c, 'devswarmOnBrief', tkey, 'skipped', 'mode-off-or-jev-disabled');
      if (!extra) trigger(c, 'devswarmExtraSanctioned', tkey, 'skipped', 'mode-off-or-jev-disabled');
      const offSig = signals.find((s) => s.signal === 'off-scope');
      if (effective(onBrief, onBrief && onBrief.threshold) && typeof onBrief.answer === 'boolean') {
        note(offSig, 'devswarmOnBrief', onBrief, onBrief.answer ? 'off-brief' : 'on-brief', onBrief.answer);
      }
      if (effective(extra, Math.max(extra ? extra.threshold : 1, MIN_THRESHOLD.devswarmExtraSanctioned)) && typeof extra.answer === 'boolean') {
        note(offSig, 'devswarmExtraSanctioned', extra, extra.answer ? 'not requested by the user' : 'the user asked for this', extra.answer);
      }
    }

    if (has('idle') || has('stall')) {
      const wait = consult(c, {
        id: 'devswarmWaitKind', trust: 'relax-block', baseline: true,
        question: { type: 'noul', instructions: 'A child workspace has shown no step progress for a while. Is it genuinely STUCK, rather than legitimately waiting on CI, the owner or a peer?',
          criteria: { true: 'stuck', false: 'legitimately waiting on CI, the owner or a peer' } },
        state: stepLine + '\nlast summary: ' + (summaries[summaries.length - 1] || '(none)')
          + '\nsignals: ' + signals.filter((s) => s.signal === 'idle' || s.signal === 'stall').map((s) => s.reason).join('; '),
        stable: stepLine + '\u0001' + (summaries[summaries.length - 1] || '') + '\u0001'
          + signals.filter((s) => s.signal === 'idle' || s.signal === 'stall').map((s) => s.key).join(','),
        agree: (a) => a === true,
      });
      if (effective(wait, wait && wait.threshold) && typeof wait.answer === 'boolean') {
        for (const sg of signals) if (sg.signal === 'idle' || sg.signal === 'stall') note(sg, 'devswarmWaitKind', wait, wait.answer ? 'stuck' : 'waiting on CI/owner/peer, not stuck', wait.answer);
      }
    }

    const since = Number.isFinite(cur.started_at) ? cur.started_at : plan.created_at;
    if ((ctx.verdict && ctx.verdict.status === 'alive' && Number.isFinite(since) && ctx.now - since > 2 * ctx.stallMs) || has('burn')) {
      const loop = consult(c, {
        id: 'devswarmLoop', trust: 'add-block', baseline: false,
        question: { type: 'noul', instructions: 'Is this child workspace LOOPING: repeating the same work without getting closer to finishing its current step?',
          criteria: { true: 'looping', false: 'making real progress' } },
        state: stepLine + '\ntime on step: ' + planLib.dur(ctx.now - since)
          + (ctx.usage ? '\ntokens since the step last moved: ' + require('./devswarm-token-usage.js').fmt(ctx.usage.sinceStep) : '')
          + '\nrecent summaries: ' + summaries.join(' | ')
          + '\nfiles changed in 3+ of the last 10 commits: ' + git.churn.map((x) => x.file + ' x' + x.n).join(', '),
        stable: stepLine + '\u0001' + since + '\u0001' + summaries.join('|') + '\u0001' + git.churn.map((x) => x.file + x.n).join(','),
        agree: (a) => a === false,
      });
      if (effective(loop, Math.max(loop ? loop.threshold : 1, MIN_THRESHOLD.devswarmLoop)) && typeof loop.answer === 'boolean') {
        const host = signals.find((s) => s.signal === 'burn') || signals.find((s) => s.signal === 'stall');
        if (host) note(host, 'devswarmLoop', loop, loop.answer ? 'looping' : 'not looping', loop.answer);
        else if (loop.answer === true && !has('loop')) {
          // No deterministic warning to annotate: Jev's own advisory `loop`
          // recommendation (capped like every other signal).
          const sg = { signal: 'loop', step: cur.n, key: 'loop:' + cur.n + ':' + since, reason: 'Jev thinks it is looping on the step (' + planLib.dur(ctx.now - since) + ')' };
          note(sg, 'devswarmLoop', loop, 'looping', true);
          signals = signals.concat([sg]);
        }
      }
    }

    const last = Array.isArray(plan.summaries) && plan.summaries.length ? plan.summaries[plan.summaries.length - 1] : null;
    if (last && last.stepped === false && plan.steps.length <= 30) {
      const criteria = {};
      for (const s of plan.steps) criteria[String(s.n)] = cap(s.text, 60);
      criteria.unknown = 'none of these steps';
      const map = consult(c, {
        id: 'devswarmStepMap', trust: 'advisory', baseline: null,
        question: { type: 'choice', instructions: 'Which numbered step of the plan does this progress summary describe?', criteria },
        state: 'summary: ' + last.text,
        agree: (a) => String(a) === String(cur.n),
      });
      const n = map && Number(map.answer);
      if (effective(map, STEPMAP_THRESHOLD) && Number.isInteger(n) && n >= 1 && n <= plan.steps.length && plan.inferred_step !== n) {
        // Never overrides the child's own report: finishLabel shows ~N only
        // while no step was ever reported. Written under the plan lock on the
        // fresh plan, so a concurrent heartbeat --step is never lost.
        planLib.updatePlan(ctx.home, ctx.key, (fresh) => {
          if (!fresh || fresh.inferred_step === n) return null;
          fresh.inferred_step = n;
          return fresh;
        });
      }
    }

    if (c.dirty) writeState(ctx.home, ctx.key, c.jevState);
  } catch (_) { return ctx.signals; }
  return signals;
}

module.exports = { IDS, jevAdjust, consult, gitRecent, recentUserPrompts, statePath };
