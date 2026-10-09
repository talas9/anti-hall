'use strict';
// anti-hall :: devswarm-supervision-jev — the two Jev integrations behind
// DevSwarm straying supervision that still live in Node (Meeseeks P2).
// devswarmWaitKind, devswarmLoop and devswarmStepMap moved to the engine
// (zero-new-Node): its `jev_sweep` job gathers their facts (plan, transcript,
// git, CI, mesh) and puts them through the evidence gate (`ah-engine jev
// sweep`, engine/defaults/jev_sweep.toml + jev_evidence.toml). Called ONLY from the supervisor
// sweep (companion/lib/devswarm-supervision.js evaluateChild), never from a
// per-turn hook. Both default to "on" = RECOMMENDATION (owner, 0.117.0):
// Jev's verdict + confidence ride on the straying warning ("Jev: off-brief
// (0.88)") in the Primary's STRAYING line and the roster; the Primary makes
// the final call. Jev never suppresses a deterministic warning, never blocks,
// never kills. "shadow" = asked and logged, nothing shown; "off" = not asked.
//
//   devswarmOnBrief         over `off-scope`: is this work off the brief?
//   devswarmExtraSanctioned over `off-scope`: did the user ask for this extra work?
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
// confidence, supports}]). Otherwise (off, shadow, no answer yet, low confidence, any error) the
// deterministic signals stand unchanged. Inputs are capped and scrubbed.
// Mode "off" (the whole of Jev disabled included) costs one config read: no
// log row, no spawn, no state write.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const planLib = require('./devswarm-plan.js');
const metrics = require('./devswarm-supervision-metrics.js');
const { devswarmRoot, isSafeId } = require('./liveness.js');

const IDS = ['devswarmOnBrief', 'devswarmExtraSanctioned'];
const CAPS = { devswarmOnBrief: 1500, devswarmExtraSanctioned: 1000 };
// Design thresholds; the configured jev.confidenceThreshold (default 0.85) is
// the floor for the three that the design pins at "the existing threshold".
const MIN_THRESHOLD = { devswarmExtraSanctioned: 0.9 };
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

    if (c.dirty) writeState(ctx.home, ctx.key, c.jevState);
  } catch (_) { return ctx.signals; }
  return signals;
}

module.exports = { IDS, jevAdjust, consult, gitRecent, recentUserPrompts, statePath };
