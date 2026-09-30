'use strict';
// anti-hall :: devswarm-plan — the per-workspace step plan behind DevSwarm
// supervision (plan tracking, P1) and the straying state the supervisor
// sweep keeps next to it (P2).
//
// FILE: ~/.anti-hall/devswarm/plans/<key>.json
//   { v, key, id, worktreePath, source, created_at, base,
//     steps: [{ n, text, status: todo|doing|done|blocked, ts, started_at }],
//     scope_globs: [], extras: [{ glob, note, ts }],
//     step_ts, activity_ts, activity_sigs, current, warned_at, warned_step,
//     summaries: [{ ts, text, stepped }] }
//
// KEY: the worktree-derived mesh id (identity.js resolveContext meshId), because `spawn` knows the new worktree path but not
// the child's own builder id (the child registers under that id later). The
// child, the supervisor and the Primary's hooks all know the worktree path,
// so they all resolve the SAME file. `plan set <id>` without a resolvable
// worktree falls back to the id itself.
//
// ADDITIVE CONTRACT: a workspace with no plan file behaves exactly as it did
// before this module existed. Every reader returns null on a missing or
// unreadable file and never throws.

const fs = require('fs');
const path = require('path');
const { isSafeId, devswarmRoot } = require('./liveness.js');

const STEP_STATUSES = ['doing', 'done', 'blocked'];
const MAX_STEPS = 50;
const MAX_STEP_TEXT = 200;
const MAX_SCOPE_GLOBS = 20;
const MAX_EXTRAS = 50;
const MAX_NOTE = 300;
const SUMMARY_KEEP = 3;
const ACTIVITY_KEEP = 5;

function plansDir(home) { return path.join(devswarmRoot(home), 'plans'); }
function strayDir(home) { return path.join(devswarmRoot(home), 'stray'); }

function planPath(home, key) {
  if (!isSafeId(key)) throw new Error('unsafe plan key: ' + JSON.stringify(key));
  return path.join(plansDir(home), String(key) + '.json');
}
function strayPath(home, key) {
  if (!isSafeId(key)) throw new Error('unsafe plan key: ' + JSON.stringify(key));
  return path.join(strayDir(home), String(key) + '.json');
}

// planKeyForWorktree(wt) -> the worktree's mesh id (identity.js, the one
// location resolver), or null (a path that does not exist has no mesh id).
function planKeyForWorktree(wt) {
  if (typeof wt !== 'string' || !wt) return null;
  try {
    const k = require('./identity.js').resolveContext(wt).meshId;
    return isSafeId(k) ? k : null;
  } catch (_) { return null; }
}

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}

let tmpCounter = 0;
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.' + (tmpCounter++) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// findPlan(home, {id, worktreePath}) -> { key, plan } | null. The worktree key
// wins (that is what spawn writes); the bare id is the fallback.
function findPlan(home, ref) {
  const r = ref || {};
  const keys = [];
  const wk = planKeyForWorktree(r.worktreePath);
  if (wk) keys.push(wk);
  if (isSafeId(r.id) && !keys.includes(String(r.id))) keys.push(String(r.id));
  for (const key of keys) {
    let plan = null;
    try { plan = readJson(planPath(home, key)); } catch (_) { plan = null; }
    if (plan && Array.isArray(plan.steps)) return { key, plan };
  }
  return null;
}

// LOCKED WRITES (0.117.0). Every plan writer (the child's heartbeat --step,
// scope add, plan set and done; the Primary's correct and respawn; the
// supervisor's Jev step map) goes through updatePlan: a read-modify-write
// under the plan's own lock (companion/lib/lock.js, the one lock primitive).
// Before this, a sweep write landing between a heartbeat's read and its
// rename was silently dropped. The lock is held for one read and one rename;
// a holder older than PLAN_LOCK_STALE_MS (a crashed writer) is reclaimed.
const PLAN_LOCK_WAIT_MS = 5000;
const PLAN_LOCK_STALE_MS = 30000;
function planLockPath(home, key) { return planPath(home, key) + '.lock'; }

// updatePlan(home, key, mutate) -> { ok:true, plan, changed } | { ok:false,
// lockBusy:true }. mutate(current plan | null) returns the plan to write, or
// null/undefined/false to write nothing. mutate runs under the lock with the
// FRESH on-disk plan, so its changes are applied to the latest state.
function updatePlan(home, key, mutate) {
  const p = planPath(home, key);
  return require('./lock.js').withLock(planLockPath(home, key), {
    waitMs: PLAN_LOCK_WAIT_MS, maxTries: Infinity, stepMs: 10, jitterMs: 10,
    stealDead: true, staleMs: PLAN_LOCK_STALE_MS, liveStaleMs: PLAN_LOCK_STALE_MS,
  }, () => {
    const cur = readJson(p);
    const plan = cur && Array.isArray(cur.steps) ? cur : null;
    const next = mutate(plan);
    if (!next) return { ok: true, plan, changed: false };
    writeJsonAtomic(p, next);
    return { ok: true, plan: next, changed: true };
  });
}

// savePlan(home, key, plan) — a whole-plan write under the same lock. For test
// fixtures only: production code uses updatePlan (tests/scripts/
// devswarm-plan-lock.test.js ratchets that).
function savePlan(home, key, plan) {
  const r = updatePlan(home, key, () => plan);
  if (!r || !r.ok) throw new Error('plan lock busy: ' + key);
}

// parseSteps(text) -> [stepText]. The first numbered list in the text whose
// items run 1, 2, 3 … (forms "1." "1)" "1:" and "Step 1:"). Fewer than two
// items is not a plan. A later list that restarts at 1 ends the first one.
function parseSteps(text) {
  const out = [];
  let expect = 1;
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?(?:step\s+)?(\d{1,3})[.):]\s+(\S.*)$/i.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    const body = m[2].trim().slice(0, MAX_STEP_TEXT);
    if (n === expect) { out.push(body); expect++; if (out.length >= MAX_STEPS) break; continue; }
    if (n === 1) {
      if (out.length >= 2) break;
      out.length = 0; out.push(body); expect = 2;
    }
  }
  return out.length >= 2 ? out : [];
}

// parseScope(text) -> [glob]. One "Scope: a/**, b/*.js" line in a brief.
function parseScope(text) {
  const m = /^\s*scope\s*:\s*(.+)$/im.exec(String(text == null ? '' : text));
  return m ? splitGlobs(m[1]) : [];
}
function splitGlobs(raw) {
  const out = [];
  for (const part of String(raw == null ? '' : raw).split(/[,\s]+/)) {
    const t = part.trim().replace(/^`|`$/g, '');
    if (t && t.length <= 200 && !out.includes(t)) out.push(t);
    if (out.length >= MAX_SCOPE_GLOBS) break;
  }
  return out;
}

function newPlan({ key, id, worktreePath, steps, scope, base, source, now }) {
  return {
    v: 1,
    key,
    id: id || null,
    worktreePath: worktreePath || null,
    source: source || 'plan-set',
    created_at: now,
    base: base || null,
    steps: (steps || []).slice(0, MAX_STEPS).map((text, i) => ({
      n: i + 1, text: String(text).slice(0, MAX_STEP_TEXT), status: 'todo', ts: null, started_at: null,
    })),
    scope_globs: (scope || []).slice(0, MAX_SCOPE_GLOBS),
    extras: [],
    step_ts: null,
    current: null,
    warned_at: null,
    warned_step: null,
    summaries: [],
  };
}

// replaceSteps(plan, steps, scope, now) -> changed. `plan set` on an existing
// plan: an identical step list and scope is a no-op (idempotent); a new list
// keeps the status of steps whose text is unchanged at the same number.
function replaceSteps(plan, steps, scope, now) {
  const same = plan.steps.length === steps.length && plan.steps.every((s, i) => s.text === steps[i]);
  const scopeSame = scope === null || JSON.stringify(plan.scope_globs || []) === JSON.stringify(scope);
  if (same && scopeSame) return false;
  if (!same) {
    const old = plan.steps;
    plan.steps = steps.slice(0, MAX_STEPS).map((text, i) => {
      const prev = old[i] && old[i].text === text ? old[i] : null;
      return prev ? prev : { n: i + 1, text: String(text).slice(0, MAX_STEP_TEXT), status: 'todo', ts: null, started_at: null };
    });
    plan.replaced_at = now;
    delete plan.done_reported_at;
  }
  if (scope !== null) plan.scope_globs = scope.slice(0, MAX_SCOPE_GLOBS);
  return true;
}

// applyStep(plan, n, status, now) -> { changed } | { error }. Re-reporting the
// status a step already has changes nothing (idempotent).
function applyStep(plan, n, status, now) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > plan.steps.length) {
    return { error: '--step must be an integer from 1 to ' + plan.steps.length };
  }
  if (!STEP_STATUSES.includes(status)) return { error: '--status must be one of ' + STEP_STATUSES.join('|') };
  const step = plan.steps[num - 1];
  if (step.status === status) return { changed: false };
  step.status = status;
  step.ts = now;
  if (!Number.isFinite(step.started_at)) step.started_at = now;
  plan.step_ts = now;
  plan.current = num;
  // A new step report is new work: it lifts the done-report hold (supervision
  // and the roster label resume).
  delete plan.done_reported_at;
  return { changed: true };
}

// currentStep(plan) -> the step being worked on, MONOTONIC in the reported
// progress: steps at or below the highest `done` step are never current again
// (a stale `doing`/`blocked` left on an earlier step must not pull the display
// back, e.g. 6/6 -> 3/6). Among later steps: the most recently touched
// doing/blocked one, else the first not done; null when nothing is left.
// `plan set` (replaceSteps) is the explicit reset.
function currentStep(plan) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
  let maxDone = 0;
  for (const s of plan.steps) if (s.status === 'done' && s.n > maxDone) maxDone = s.n;
  const open = plan.steps.filter((s) => s.n > maxDone && s.status !== 'done');
  let best = null;
  for (const s of open) {
    if (s.status !== 'doing' && s.status !== 'blocked') continue;
    if (!best || (s.ts || 0) >= (best.ts || 0)) best = s;
  }
  return best || open[0] || null;
}

function stepsDone(plan) {
  return plan && Array.isArray(plan.steps) ? plan.steps.filter((s) => s.status === 'done').length : 0;
}

// addExtra(plan, glob, note, now) -> changed. Same glob + same note = no-op.
function addExtra(plan, glob, note, now) {
  if (!Array.isArray(plan.extras)) plan.extras = [];
  const n = String(note == null ? '' : note).slice(0, MAX_NOTE);
  const existing = plan.extras.find((e) => e.glob === glob);
  if (existing) {
    if (existing.note === n) return false;
    existing.note = n; existing.ts = now;
    return true;
  }
  if (plan.extras.length >= MAX_EXTRAS) return false;
  plan.extras.push({ glob, note: n, ts: now });
  return true;
}

function recordSummary(plan, text, stepped, now) {
  if (!Array.isArray(plan.summaries)) plan.summaries = [];
  plan.summaries.push({ ts: now, text: String(text).slice(0, 200), stepped: !!stepped });
  if (plan.summaries.length > SUMMARY_KEEP) plan.summaries = plan.summaries.slice(-SUMMARY_KEEP);
  noteActivity(plan, text, now);
}

// noteActivity(plan, text, now) -> refreshed. Genuine child activity (a
// heartbeat --summary, a mesh broadcast/direct the child sent) refreshes
// `activity_ts`, which the stall clock and the finish label read alongside
// step_ts. Text already seen among the last ACTIVITY_KEEP signatures
// (case/whitespace-normalised) does NOT refresh: a child repeating itself is
// the looping case the stall/devswarmLoop path must still see.
function noteActivity(plan, text, now) {
  const sig = require('crypto').createHash('sha1')
    .update(String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
  const seen = Array.isArray(plan.activity_sigs) ? plan.activity_sigs : [];
  if (seen.includes(sig)) return false;
  plan.activity_sigs = seen.concat(sig).slice(-ACTIVITY_KEEP);
  plan.activity_ts = now;
  return true;
}

// lastProgressTs(plan) -> the later of the last step change and the last
// fresh-text activity, or null when neither happened.
function lastProgressTs(plan) {
  const a = Number.isFinite(plan.step_ts) ? plan.step_ts : -Infinity;
  const b = Number.isFinite(plan.activity_ts) ? plan.activity_ts : -Infinity;
  const m = Math.max(a, b);
  return Number.isFinite(m) ? m : null;
}

// dur(ms) -> '42m' | '5h' | '3d'.
function dur(ms) {
  const m = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// finishLabel(plan, now) -> 'step 3/7 · 42m · progress 18m ago'. The middle
// value is the time on the current step (since it started, or since the
// plan was written if it has not started); the last is the time since the
// child last reported a step change. `inferred` (a Jev devswarmStepMap answer
// promoted to "on") is shown as `~N` and only when no step was ever reported.
function finishLabel(plan, now) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
  const total = plan.steps.length;
  const lastTs = lastProgressTs(plan);
  const progress = lastTs !== null ? 'progress ' + dur(now - lastTs) + ' ago' : 'no progress yet';
  const cur = currentStep(plan);
  if (!cur) {
    return 'steps ' + total + '/' + total + ' done · '
      + (Number.isFinite(plan.done_reported_at) ? 'done-reported, awaiting Primary' : progress);
  }
  const inferred = !Number.isFinite(plan.step_ts) && Number.isInteger(plan.inferred_step)
    && plan.inferred_step >= 1 && plan.inferred_step <= total;
  const num = inferred ? '~' + plan.inferred_step : String(cur.n);
  const since = Number.isFinite(cur.started_at) ? cur.started_at : plan.created_at;
  if (Number.isFinite(plan.done_reported_at)) {
    return 'step ' + num + '/' + total + ' · done-reported ' + dur(now - plan.done_reported_at) + ' ago, awaiting Primary';
  }
  return 'step ' + num + '/' + total + (cur.status === 'blocked' ? ' blocked' : '')
    + ' · ' + dur(now - since) + ' · ' + progress;
}

function readStray(home, key) {
  try { return readJson(strayPath(home, key)); } catch (_) { return null; }
}
function saveStray(home, key, state) { writeJsonAtomic(strayPath(home, key), state); }

// listStray(home) -> [{ key, state }] for every stray-state file (fail-open).
function listStray(home) {
  let names = [];
  try { names = fs.readdirSync(strayDir(home)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    const key = n.slice(0, -5);
    if (!isSafeId(key)) continue;
    const state = readStray(home, key);
    if (state) out.push({ key, state });
  }
  return out;
}

// Settings (all fail-open to the schema default).
function setting(key, dflt, opts) {
  try {
    const o = opts || {};
    return require('../../hooks/lib/settings.js').get('devswarm', key, dflt, { env: o.env || process.env, home: o.home });
  } catch (_) { return dflt; }
}
function planTrackingEnabled(opts) { return setting('planTracking', true, opts) !== false; }
function planRequired(opts) { return setting('planRequired', false, opts) === true; }
function stepStallMs(opts) {
  const v = Number(setting('stepStallMin', 30, opts));
  return (Number.isFinite(v) && v >= 1 ? v : 30) * 60000;
}
function strayWarnMax(opts) {
  const v = Number(setting('strayWarnMax', 2, opts));
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2;
}

module.exports = {
  STEP_STATUSES, plansDir, strayDir, planPath, strayPath, planKeyForWorktree,
  findPlan, savePlan, updatePlan, planLockPath, parseSteps, parseScope, splitGlobs, newPlan, replaceSteps, applyStep,
  currentStep, stepsDone, addExtra, recordSummary, noteActivity, lastProgressTs, dur, finishLabel,
  readStray, saveStray, listStray,
  planTrackingEnabled, planRequired, stepStallMs, strayWarnMax,
};
