'use strict';
// anti-hall :: devswarm-lifecycle — v0.108.0 workspace lifecycle on top of
// DevSwarm's native archive/delete (hivecontrol 2.5.3+).
//
// FEATURE 1 — AUTO-ARCHIVE done workspaces (supervisor sweep).
//   planAutoArchive() proves, per child builder, ALL of:
//     (a) done      — the mesh summary's archive_ready (the existing required
//                     gates: done,merged,tests_passed by default)
//     (b) merged    — `git merge-base --is-ancestor HEAD <source>` in the
//                     worktree (local ref, then origin/<source>), else the app
//                     DB pull_requests row for the branch has state=merged.
//                     NOT `hivecontrol workspace check-merge` — it is
//                     side-effecting (see devswarm-capabilities.js).
//     (c) clean     — `git status --porcelain` is empty
//     (d) no unread — zero unread TO the child and zero unread FROM it in any
//                     other partition of the project's mesh store
//     (e) not the Primary (builderType primary / primary-<hash> id)
//     (f) not being viewed — app DB builders.lastSelectedAt older than 10 min
//     (g) idle      — last heartbeat/transcript activity >= idleMin ago
//   Any fact that cannot be READ counts as not proven -> no archive.
//   Settings (<home>/.anti-hall/settings.json):
//     devswarm.autoArchive.mode        "on" (default, owner decision) | "dry-run" | "off"
//     devswarm.autoArchive.idleMin     30   (min 5)
//     devswarm.autoArchive.maxPerSweep 3    (1..20)
//   dry-run writes NOTHING and spawns nothing mutating: the plan rides the
//   supervisor's stdout line and `devswarm.js auto-archive`. "on" archives at
//   most maxPerSweep per sweep (facts re-gathered immediately before each
//   archive), logs <home>/.anti-hall/logs/devswarm-auto-archive.ndjson, and
//   sends the Primary one line with an undo hint. With "on" and the archive
//   verb available, the parent-inbox "archive-ready" nag is skipped for the
//   workspaces this sweep is about to archive (autoArchiveOwns).
//   On DevSwarm < 2.5.3 the archive verb is absent: "on" degrades to the
//   dry-run report with dormant: "requires DevSwarm >= 2.5.3".
//
// FEATURE 2 — PRUNE old archived workspaces (owner-approved only).
//   planPrune({olderThanDays}) lists app-archived, non-Primary builders with
//   evidence per row and stores the plan under a random nonce
//   (<home>/.anti-hall/devswarm/prune-plans/<nonce>.json). executePrune()
//   deletes ONLY when the ids exactly equal that plan's eligible ids, the plan
//   is <= 15 min old and unconsumed, and each row is re-verified (still
//   archived, not Primary, worktree clean) right before its delete.
//   CALLER GUARD (kept simple): executePrune refuses when
//   ANTIHALL_CALLER is set to anything but "interactive" — the supervisor sets
//   ANTIHALL_CALLER=supervisor — and it is referenced from exactly ONE place,
//   the `prune-archived --confirm-ids` dispatch in scripts/devswarm.js
//   (asserted by tests/hygiene/devswarm-lifecycle-no-auto-delete.test.js). The
//   skill flow gates that call behind AskUserQuestion with the exact list.
//   Each deletion is logged to <home>/.anti-hall/logs/devswarm-prune.ndjson and
//   tombstoned in anti-hall (pruned/<id>.json + the existing descriptor
//   archive); no anti-hall store rows are deleted.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const caps = require('./devswarm-capabilities.js');

const VIEWED_GRACE_MS = 10 * 60 * 1000;
const PLAN_TTL_MS = 15 * 60 * 1000;
const GIT_TIMEOUT_MS = 10000;
const HC_TIMEOUT_MS = 60000;
const SIZE_WALK_CAP = 200000;
const DEFAULT_SETTINGS = Object.freeze({ mode: 'on', idleMin: 30, maxPerSweep: 3 });
const UNDO_HINT = 'undo: unarchive it from the archived workspaces list in the DevSwarm app';

function devswarmDir(home) { return path.join(home, '.anti-hall', 'devswarm'); }
function logsDir(home) { return path.join(home, '.anti-hall', 'logs'); }

// ---------- settings ----------
// devswarm.autoArchive.{mode,idleMin,maxPerSweep} via the unified settings
// store (hooks/lib/settings.js: env > settings.json > /config > default;
// numbers clamp to the schema bounds). `override` (tests/CLI) wins.
function readSettings(home, override, env) {
  const settings = require('../../hooks/lib/settings.js');
  const opts = { home, env: env || process.env };
  const a = Object.assign({
    mode: settings.get('devswarm', 'autoArchive.mode', DEFAULT_SETTINGS.mode, opts),
    idleMin: settings.get('devswarm', 'autoArchive.idleMin', DEFAULT_SETTINGS.idleMin, opts),
    maxPerSweep: settings.get('devswarm', 'autoArchive.maxPerSweep', DEFAULT_SETTINGS.maxPerSweep, opts),
  }, override || {});
  const mode = ['on', 'off', 'dry-run'].includes(a.mode) ? a.mode : DEFAULT_SETTINGS.mode;
  const idle = Number(a.idleMin);
  const max = Number(a.maxPerSweep);
  return {
    mode,
    idleMin: Number.isFinite(idle) && idle >= 5 ? Math.floor(idle) : DEFAULT_SETTINGS.idleMin,
    maxPerSweep: Number.isFinite(max) && max >= 1 ? Math.min(20, Math.floor(max)) : DEFAULT_SETTINGS.maxPerSweep,
  };
}

// ---------- default fact sources (all read-only) ----------
function normPath(p) {
  if (typeof p !== 'string' || !p) return null;
  try { return fs.realpathSync(path.resolve(p)); } catch (_) { return path.resolve(p); }
}

function appDbRows(o) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (_) { return null; }
  const file = require('./devswarm-app-db.js').appDbPath({ env: o.env, home: o.home });
  if (!file) return null;
  try { if (!fs.statSync(file).isFile()) return null; } catch (_) { return null; }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const cols = new Set(db.prepare('PRAGMA table_info(builders)').all().map((c) => String(c.name)));
    const want = ['id', 'repositoryId', 'branchName', 'sourceBranch', 'worktreePath', 'builderType', 'isActive',
      'isHidden', 'lastSelectedAt', 'label', 'pullRequestId'];
    if (!cols.has('id') || !cols.has('isActive')) return null;
    const sel = want.filter((c) => cols.has(c));
    const builders = db.prepare('SELECT ' + sel.join(', ') + ' FROM builders').all().map((r) => Object.assign({}, r));
    let prs = [];
    const prCols = new Set(db.prepare('PRAGMA table_info(pull_requests)').all().map((c) => String(c.name)));
    if (prCols.has('branchName') && prCols.has('state')) {
      const ps = ['id', 'repositoryId', 'branchName', 'state', 'targetBranch'].filter((c) => prCols.has(c));
      prs = db.prepare('SELECT ' + ps.join(', ') + ' FROM pull_requests').all().map((r) => Object.assign({}, r));
    }
    return { builders, prs, hasLastSelected: cols.has('lastSelectedAt'), hasBuilderType: cols.has('builderType') };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

function defaultGit(cwd, args) {
  try {
    // GIT_OPTIONAL_LOCKS=0: `git status` must not refresh (write) the index of
    // a checkout we only inspect.
    const env = Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' });
    const r = spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env });
    if (r.error || r.signal) return { ok: false, status: null, out: '' };
    return { ok: r.status === 0, status: r.status, out: String(r.stdout || '') };
  } catch (_) { return { ok: false, status: null, out: '' }; }
}

function defaultRepoKey(worktree) {
  try { return require('./devswarm-repokey.js').repoKeyForWorktree(worktree) || null; } catch (_) { return null; }
}

function defaultSummary(home, repoKey) {
  try { return require('./devswarm-store.js').readSummaryForHash(home, repoKey); } catch (_) { return null; }
}

// unread rows FROM any of `ids` still unread in another partition. null = unknown.
function defaultUnreadFrom(home, repoKey, ids, summary) {
  const store = require('./devswarm-store.js');
  let total = 0;
  const others = Object.values((summary && summary.workspaces) || {}).filter((w) => w && !ids.includes(String(w.id)) && Number(w.unread) > 0);
  if (!others.length) return 0;
  try { if (!fs.existsSync(store.storeDirForHash(home, repoKey))) return null; } catch (_) { return null; }
  let s = null;
  try {
    s = store.openStore({ home, hash: repoKey, readOnly: true });
    for (const w of others) {
      const rows = s.listMessages(w.id, { sinceCursor: Number(w.cursor) || 0 }) || [];
      for (const r of rows) if (r && r.sender != null && ids.includes(String(r.sender))) total++;
    }
    return total;
  } catch (_) {
    return null;
  } finally { try { if (s) s.close(); } catch (_) {} }
}

function defaultActivityTs(desc, home) {
  try { return require('./liveness.js').readActivityTs(desc, home).ts; } catch (_) { return null; }
}

function defaultDescriptors(home) {
  try { return require('../devswarm-supervisor.js').readDescriptors(home); } catch (_) { return []; }
}

function resolveDeps(o) {
  const d = o.deps || {};
  return {
    appDb: d.appDb || (() => appDbRows(o)),
    git: d.git || defaultGit,
    repoKey: d.repoKey || defaultRepoKey,
    summary: d.summary || defaultSummary,
    unreadFrom: d.unreadFrom || defaultUnreadFrom,
    activityTs: d.activityTs || defaultActivityTs,
    descriptors: d.descriptors || defaultDescriptors,
    run: d.run || ((spec) => caps.gatedRun(require('./devswarm-pull.js').defaultRun)(spec)),
    can: d.can || ((name) => caps.can(name, { env: o.env, home: o.home })),
    notifyPrimary: d.notifyPrimary || defaultNotifyPrimary,
  };
}

// ---------- shared fact helpers ----------
function isPrimaryBuilder(b, ids) {
  if (b && String(b.builderType || '').toLowerCase() === 'primary') return true;
  return (ids || []).some((id) => /^primary-/.test(String(id)));
}

function mergedFact(b, db, deps) {
  const wt = b.worktreePath;
  const src = b.sourceBranch ? String(b.sourceBranch) : null;
  if (wt && src && fs.existsSync(wt)) {
    for (const ref of [src, 'origin/' + src]) {
      const v = deps.git(wt, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
      if (!v.ok) continue;
      const r = deps.git(wt, ['merge-base', '--is-ancestor', 'HEAD', ref]);
      if (r.status === 0) return { merged: true, via: 'git:' + ref };
      if (r.status === 1) break; // resolved: not an ancestor — try the PR fallback
    }
  }
  const pr = (db.prs || []).find((p) => (b.pullRequestId && p.id === b.pullRequestId)
    || (p.branchName === b.branchName && (!p.repositoryId || !b.repositoryId || p.repositoryId === b.repositoryId)));
  if (pr && String(pr.state || '').toLowerCase() === 'merged') return { merged: true, via: 'pr' };
  return { merged: false, via: pr ? 'pr:' + String(pr.state || '').toLowerCase() : 'unproven' };
}

function cleanFact(wt, deps) {
  if (!wt || !fs.existsSync(wt)) return { clean: null, reason: 'worktree-missing' };
  const r = deps.git(wt, ['status', '--porcelain']);
  if (!r.ok) return { clean: null, reason: 'git-status-failed' };
  return { clean: r.out.trim() === '', reason: r.out.trim() ? 'uncommitted-changes' : null };
}

// unreadFact(ids, repoKey) -> { toChild, fromChild } (null = unknown)
function unreadFact(home, repoKey, ids, deps) {
  if (!repoKey) return { toChild: null, fromChild: null };
  const summary = deps.summary(home, repoKey);
  if (!summary || !summary.workspaces) return { toChild: null, fromChild: null, summary: null };
  let toChild = 0;
  let known = false;
  for (const id of ids) {
    const w = summary.workspaces[id];
    if (!w) continue;
    known = true;
    toChild += (Number(w.unread) || 0) + (Number(w.broadcastUnread) || 0);
  }
  const fromChild = deps.unreadFrom(home, repoKey, ids, summary);
  return { toChild: known ? toChild : null, fromChild, summary };
}

// ---------- FEATURE 1: auto-archive ----------
// gatherCandidates -> [{ builder, descriptors, ids }] for ACTIVE non-archived
// builders that anti-hall tracks (a registered descriptor by id or worktree).
function gatherCandidates(o, deps, db) {
  const descs = deps.descriptors(o.home) || [];
  const byId = new Map();
  for (const b of db.builders) {
    if (Number(b.isActive) !== 1) continue;
    byId.set(String(b.id), { builder: b, descriptors: [] });
  }
  const byWt = new Map();
  for (const c of byId.values()) { const k = normPath(c.builder.worktreePath); if (k) byWt.set(k, c); }
  for (const d of descs) {
    const c = byId.get(String(d.id)) || byWt.get(normPath(d.worktreePath));
    if (c) c.descriptors.push(d);
  }
  return [...byId.values()].filter((c) => c.descriptors.length > 0)
    .map((c) => Object.assign(c, { ids: [...new Set([String(c.builder.id)].concat(c.descriptors.map((d) => String(d.id))))] }));
}

// evaluateCandidate -> { id, label, branch, eligible, blockers:[{gate, detail}], soft }
function evaluateCandidate(c, o, deps, db, settings, now) {
  const b = c.builder;
  const blockers = [];
  const facts = {};
  if (isPrimaryBuilder(b, c.ids)) blockers.push({ gate: 'e-primary', detail: 'Primary workspace' });
  const repoKey = deps.repoKey(b.worktreePath || c.descriptors[0].worktreePath);
  const un = unreadFact(o.home, repoKey, c.ids, deps);
  const done = !!(un.summary && c.ids.some((id) => un.summary.workspaces[id] && un.summary.workspaces[id].archive_ready === true));
  facts.done = done;
  if (!done) blockers.push({ gate: 'a-done', detail: un.summary ? 'finish gates not all set' : 'no mesh summary' });
  const m = mergedFact(b, db, deps);
  facts.merged = m;
  if (!m.merged) blockers.push({ gate: 'b-merged', detail: m.via });
  const cl = cleanFact(b.worktreePath, deps);
  facts.clean = cl.clean;
  if (cl.clean !== true) blockers.push({ gate: 'c-clean', detail: cl.reason });
  facts.unread = { toChild: un.toChild, fromChild: un.fromChild };
  if (un.toChild !== 0 || un.fromChild !== 0) {
    blockers.push({ gate: 'd-unread', detail: 'to=' + un.toChild + ' from=' + un.fromChild });
  }
  if (!db.hasLastSelected) {
    blockers.push({ gate: 'f-viewed', detail: 'lastSelectedAt unavailable' });
  } else if (b.lastSelectedAt) {
    const t = Date.parse(b.lastSelectedAt);
    if (!Number.isFinite(t) || now - t < VIEWED_GRACE_MS) blockers.push({ gate: 'f-viewed', detail: 'selected ' + (Number.isFinite(t) ? Math.round((now - t) / 60000) + 'm ago' : 'at unknown time') });
  }
  let act = null;
  for (const d of c.descriptors) {
    const t = deps.activityTs(d, o.home);
    if (Number.isFinite(t) && (act === null || t > act)) act = t;
  }
  facts.idleMin = act === null ? null : Math.floor((now - act) / 60000);
  if (act === null || now - act < settings.idleMin * 60000) {
    blockers.push({ gate: 'g-idle', detail: act === null ? 'no activity signal' : 'active ' + facts.idleMin + 'm ago' });
  }
  const soft = blockers.length > 0 && blockers.every((x) => x.gate === 'g-idle' || x.gate === 'f-viewed');
  return {
    id: String(b.id), label: b.label || null, branch: b.branchName || null, repositoryId: b.repositoryId || null,
    worktreePath: b.worktreePath || null, repoKey, eligible: blockers.length === 0, soft, blockers, facts,
  };
}

// planAutoArchive(opts) -> { ok, mode, settings, capability, candidates, toArchive, dormant? }
// PURE READ: never writes, never spawns anything but git reads + --help probes.
function planAutoArchive(opts) {
  const o = Object.assign({ home: os.homedir(), env: process.env }, opts || {});
  const deps = resolveDeps(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const settings = o.settings || readSettings(o.home, null, o.env);
  const db = deps.appDb();
  if (!db) {
    return { ok: false, reason: 'app-db-unavailable', mode: settings.mode, settings, capability: { ok: false, reason: 'not probed', version: null }, candidates: [], toArchive: [] };
  }
  const capability = deps.can('workspace.archive');
  const out = { ok: true, mode: settings.mode, settings, capability: { ok: !!capability.ok, reason: capability.reason || null, version: capability.version || null }, candidates: [], toArchive: [] };
  if (!capability.ok) out.dormant = capability.reason === 'hivecontrol-absent' ? 'DevSwarm not installed' : String(capability.reason);
  for (const c of gatherCandidates(o, deps, db)) {
    try { out.candidates.push(evaluateCandidate(c, o, deps, db, settings, now)); } catch (_) { /* fail closed: not listed */ }
  }
  out.toArchive = out.candidates.filter((c) => c.eligible).slice(0, settings.maxPerSweep).map((c) => c.id);
  return out;
}

function appendNdjson(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (_) {}
}

// verbArgv(verb, detail, target) -> ['workspace', verb, <id>] | null.
// DevSwarm 2.5.3 `archive|delete [idOrBranch]` DEFAULT TO THE CURRENT
// WORKSPACE when the argument is omitted, have no --yes flag and never
// prompt. So the explicit workspace UUID is ALWAYS passed (never a branch —
// ids are unambiguous) regardless of what the parsed help shows, and no
// target id means no call at all (null): an argument-less archive/delete
// would act on whatever workspace the command runs in.
function verbArgv(verb, detail, target) {
  const id = target && typeof target.id === 'string' ? target.id.trim() : '';
  if (!id || id.startsWith('-')) return null;
  return ['workspace', verb, id];
}

function primaryWorktreeFor(db, repositoryId) {
  const p = (db.builders || []).find((b) => String(b.builderType || '').toLowerCase() === 'primary'
    && (!repositoryId || b.repositoryId === repositoryId) && b.worktreePath && fs.existsSync(b.worktreePath));
  return p ? p.worktreePath : null;
}

// defaultNotifyPrimary(home, candidate, text) — one line into the Primary's
// mesh partition via THE partition door (scripts/devswarm.js appendIntoPartition).
function defaultNotifyPrimary(home, cand, text, o) {
  try {
    // THE identity resolver (companion/lib/identity.js): the Primary's mesh id
    // is the main worktree's, identical for every worktree of the project.
    const idc = require('./identity.js').resolveContext(cand.worktreePath);
    const parentId = idc && idc.primaryMeshId;
    if (!parentId || !cand.repoKey) return 'no-primary';
    const store = require('./devswarm-store.js');
    const s = store.openStore({ home, hash: cand.repoKey, env: o && o.env });
    try {
      const dw = require('../../scripts/devswarm.js');
      const row = { workspaceId: parentId, ts: Date.now(), hash: 'auto-archive:' + cand.id, body: text };
      const st = dw.appendIntoPartition(s, home, parentId, [row], { via: 'message' }).status;
      if (st === 'ok') { try { store.deriveSummary(s, { home, env: o && o.env }); } catch (_) {} }
      return st;
    } finally { s.close(); }
  } catch (_) { return 'error'; }
}

// autoArchiveSweep(opts) — the supervisor hook. dry-run/off/dormant: returns the
// plan and writes NOTHING. on: archives toArchive (re-verified), logs, reports.
function autoArchiveSweep(opts) {
  const o = Object.assign({ home: os.homedir(), env: process.env }, opts || {});
  const settings = o.settings || readSettings(o.home, null, o.env);
  if (settings.mode === 'off') return { mode: 'off', archived: [] };
  const plan = planAutoArchive(Object.assign({}, o, { settings }));
  const summary = {
    mode: settings.mode, dormant: plan.dormant || null, candidates: plan.candidates.length,
    wouldArchive: plan.toArchive, archived: [], failed: [],
  };
  if (settings.mode !== 'on' || !plan.capability.ok || !plan.ok) return summary;
  const deps = resolveDeps(o);
  const cap = deps.can('workspace.archive');
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const db = deps.appDb();
  for (const id of plan.toArchive) {
    // Re-gather every fact immediately before acting (the plan may be seconds old).
    const again = planAutoArchive(Object.assign({}, o, { settings, now: Number.isFinite(o.now) ? o.now : Date.now() }));
    const cand = again.candidates.find((c) => c.id === id);
    if (!cand || !cand.eligible) { summary.failed.push({ id, reason: 'no-longer-eligible' }); continue; }
    const argv = verbArgv('archive', cap.detail, cand);
    if (!argv) { summary.failed.push({ id, reason: 'no-workspace-id' }); continue; }
    const cwd = (db && primaryWorktreeFor(db, cand.repositoryId)) || cand.worktreePath;
    const res = deps.run({ args: argv, env: o.env, cwd, timeout: HC_TIMEOUT_MS });
    const rec = { ts: new Date(now).toISOString(), action: 'auto-archive', id, branch: cand.branch, label: cand.label, argv, ok: !!(res && res.ok), error: res && !res.ok ? String(res.error || '') : null };
    appendNdjson(path.join(logsDir(o.home), 'devswarm-auto-archive.ndjson'), rec);
    if (!res || !res.ok) { summary.failed.push({ id, reason: rec.error }); continue; }
    summary.archived.push(id);
    const name = cand.label || cand.branch || id;
    const text = 'auto-archived "' + name + '" (' + id + ') — done, merged (' + cand.facts.merged.via + '), clean, no unread, idle '
      + cand.facts.idleMin + 'm. ' + UNDO_HINT + '.';
    deps.notifyPrimary(o.home, cand, text, o);
  }
  // Which done workspaces the sweep now owns (eligible, or only waiting on
  // idle/viewed) — the parent-inbox nag skips exactly these (mode on only).
  const owned = plan.candidates.filter((c) => c.eligible || c.soft).map((c) => c.id);
  try {
    const p = path.join(devswarmDir(o.home), 'auto-archive-state.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', JSON.stringify({ at: now, owned }));
    fs.renameSync(p + '.tmp', p);
  } catch (_) {}
  return summary;
}

// autoArchiveOwns(home, id, opts) -> bool. True only when mode is "on", the
// archive verb is available, and the last sweep (<= 1 h ago) owns this id.
function autoArchiveOwns(home, id, opts) {
  try {
    const o = opts || {};
    if (readSettings(home).mode !== 'on') return false;
    const st = JSON.parse(fs.readFileSync(path.join(devswarmDir(home), 'auto-archive-state.json'), 'utf8'));
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    if (!st || !Array.isArray(st.owned) || !(now - Number(st.at) < 60 * 60 * 1000)) return false;
    if (!st.owned.includes(String(id))) return false;
    return caps.can('workspace.archive', { home, env: o.env || process.env }).ok === true;
  } catch (_) { return false; }
}

// ---------- FEATURE 2: prune archived ----------
function dirSize(root) {
  let bytes = 0;
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      if (++n > SIZE_WALK_CAP) return { bytes, capped: true };
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { bytes += fs.lstatSync(p).size; } catch (_) {} }
    }
  }
  return { bytes, capped: false };
}

// archivedSince(home, id) -> { ts, source } | null. Conservative (never older
// than the truth): our own auto-archive log, else the anti-hall archived
// marker's ctime (link/write time — at or after the archive).
function archivedSince(home, id) {
  let best = null;
  try {
    const lines = fs.readFileSync(path.join(logsDir(home), 'devswarm-auto-archive.ndjson'), 'utf8').split('\n');
    for (const l of lines) {
      if (!l) continue;
      try { const r = JSON.parse(l); if (r.id === id && r.ok) best = { ts: Date.parse(r.ts), source: 'auto-archive-log' }; } catch (_) {}
    }
  } catch (_) {}
  if (best && Number.isFinite(best.ts)) return best;
  try {
    const st = fs.statSync(path.join(devswarmDir(home), 'archived', id + '.json'));
    return { ts: st.ctimeMs, source: 'archived-marker' };
  } catch (_) { return null; }
}

function prunePlansDir(home) { return path.join(devswarmDir(home), 'prune-plans'); }

// evaluateArchived(b) -> row with evidence + blockers
function evaluateArchived(b, o, deps, db, now, olderThanDays) {
  const id = String(b.id);
  const blockers = [];
  const since = archivedSince(o.home, id);
  const ageDays = since && Number.isFinite(since.ts) ? Math.floor((now - since.ts) / 86400000) : null;
  if (ageDays === null) blockers.push('archive-age-unknown');
  else if (ageDays < olderThanDays) blockers.push('younger-than-' + olderThanDays + 'd');
  if (isPrimaryBuilder(b, [id])) blockers.push('primary');
  const m = mergedFact(b, db, deps);
  if (!m.merged) blockers.push('not-merged(' + m.via + ')');
  const cl = cleanFact(b.worktreePath, deps);
  if (cl.clean !== true) blockers.push(cl.reason || 'unclean');
  const repoKey = b.worktreePath ? deps.repoKey(b.worktreePath) : null;
  const un = repoKey ? unreadFact(o.home, repoKey, [id], deps) : { toChild: null, fromChild: null };
  if (un.toChild || un.fromChild) blockers.push('unread');
  const size = b.worktreePath && fs.existsSync(b.worktreePath) ? (o.sizeOf || dirSize)(b.worktreePath) : null;
  return {
    id, label: b.label || null, branch: b.branchName || null, repositoryId: b.repositoryId || null,
    worktreePath: b.worktreePath || null,
    archivedSince: since && Number.isFinite(since.ts) ? new Date(since.ts).toISOString() : null,
    archivedSinceSource: since ? since.source : null, ageDays,
    merged: m.merged, mergedVia: m.via, uncommitted: cl.clean === null ? null : !cl.clean,
    unread: { toChild: un.toChild, fromChild: un.fromChild },
    worktreeBytes: size ? size.bytes : null, worktreeBytesCapped: size ? size.capped : null,
    eligible: blockers.length === 0, blockers,
  };
}

// planPrune({ olderThanDays }) -> { ok, nonce, expiresAt, rows, eligibleIds, capability }
// DRY RUN: the only write is the plan file itself.
function planPrune(opts) {
  const o = Object.assign({ home: os.homedir(), env: process.env }, opts || {});
  const deps = resolveDeps(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const olderThanDays = Number(o.olderThanDays);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) return { ok: false, error: '--older-than <days> is required (a number >= 0)' };
  const capability = deps.can('workspace.delete');
  const db = deps.appDb();
  if (!db) return { ok: false, error: 'DevSwarm app database unavailable' };
  const rows = [];
  for (const b of db.builders) {
    if (!(Number(b.isActive) === 0 && Number(b.isHidden) === 1)) continue; // archived only
    try { rows.push(evaluateArchived(b, o, deps, db, now, olderThanDays)); } catch (_) {}
  }
  const eligibleIds = rows.filter((r) => r.eligible).map((r) => r.id).sort();
  const nonce = crypto.randomBytes(8).toString('hex');
  const plan = { nonce, createdAt: now, expiresAt: now + PLAN_TTL_MS, olderThanDays, eligibleIds, rows };
  try {
    fs.mkdirSync(prunePlansDir(o.home), { recursive: true });
    fs.writeFileSync(path.join(prunePlansDir(o.home), nonce + '.json'), JSON.stringify(plan, null, 2));
  } catch (e) { return { ok: false, error: 'could not store the plan: ' + String((e && e.message) || e) }; }
  return {
    ok: true, dryRun: true, nonce, expiresAt: new Date(plan.expiresAt).toISOString(), olderThanDays, rows, eligibleIds,
    capability: { ok: !!capability.ok, reason: capability.reason || null, version: capability.version || null },
    dormant: capability.ok ? null : (capability.reason === 'hivecontrol-absent' ? 'DevSwarm not installed' : String(capability.reason)),
    next: eligibleIds.length
      ? 'ask the owner to approve EXACTLY these ids, then: devswarm.js prune-archived --confirm-ids ' + eligibleIds.join(',') + ' --plan ' + nonce
      : 'nothing eligible',
  };
}

function assertInteractiveCaller(env) {
  const c = env && env.ANTIHALL_CALLER;
  if (c && c !== 'interactive') {
    throw new Error('prune-archived deletion refused: caller "' + c + '" is automated (only an owner-approved interactive run may delete)');
  }
}

// executePrune({ ids, nonce }) — deletes ONLY an owner-approved, fresh, exact plan.
function executePrune(opts) {
  const o = Object.assign({ home: os.homedir(), env: process.env }, opts || {});
  assertInteractiveCaller(o.env);
  const deps = resolveDeps(o);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const logFile = path.join(logsDir(o.home), 'devswarm-prune.ndjson');
  const ids = [...new Set((o.ids || []).map(String).filter(Boolean))].sort();
  if (!o.nonce || !/^[0-9a-f]{16}$/.test(String(o.nonce))) return { ok: false, error: '--confirm-ids requires --plan <nonce> from a prune-archived dry run' };
  const planPath = path.join(prunePlansDir(o.home), String(o.nonce) + '.json');
  let plan;
  try { plan = JSON.parse(fs.readFileSync(planPath, 'utf8')); } catch (_) { return { ok: false, error: 'unknown plan nonce ' + o.nonce }; }
  if (plan.consumedAt) return { ok: false, error: 'plan ' + o.nonce + ' was already used' };
  if (!(now <= plan.expiresAt && now >= plan.createdAt)) return { ok: false, error: 'plan ' + o.nonce + ' expired (plans are valid 15 min) — re-run the dry run' };
  const planned = (plan.eligibleIds || []).slice().sort();
  if (!ids.length || ids.length !== planned.length || ids.some((x, i) => x !== planned[i])) {
    return { ok: false, error: '--confirm-ids must exactly match the plan\'s eligible ids: ' + planned.join(',') };
  }
  const cap = deps.can('workspace.delete');
  if (!cap.ok) return { ok: false, error: 'deletion unavailable: ' + (cap.reason === 'hivecontrol-absent' ? 'DevSwarm not installed' : cap.reason), dormant: true };
  try {
    plan.consumedAt = now;
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  } catch (e) { return { ok: false, error: 'could not mark the plan consumed: ' + String((e && e.message) || e) }; }
  const db = deps.appDb();
  if (!db) return { ok: false, error: 'DevSwarm app database unavailable' };
  const results = [];
  for (const id of ids) {
    const b = db.builders.find((x) => String(x.id) === id);
    const rec = { ts: new Date(now).toISOString(), action: 'prune-delete', plan: plan.nonce, id, branch: b ? b.branchName : null };
    // Re-verify ourselves — never rely on the CLI's own guards alone.
    let refuse = null;
    if (!b) refuse = 'builder-not-found';
    else if (!(Number(b.isActive) === 0 && Number(b.isHidden) === 1)) refuse = 'no-longer-archived';
    else if (isPrimaryBuilder(b, [id])) refuse = 'primary';
    else {
      const cl = cleanFact(b.worktreePath, deps);
      if (cl.clean !== true) refuse = cl.reason || 'unclean';
    }
    if (refuse) {
      appendNdjson(logFile, Object.assign(rec, { ok: false, refused: refuse }));
      results.push({ id, ok: false, refused: refuse });
      continue;
    }
    const argv = verbArgv('delete', cap.detail, { id, branch: b.branchName });
    if (!argv) { results.push({ id, ok: false, refused: 'no-workspace-id' }); continue; }
    const cwd = primaryWorktreeFor(db, b.repositoryId) || o.cwd || process.cwd();
    const res = deps.run({ args: argv, env: o.env, cwd, timeout: HC_TIMEOUT_MS });
    const ok = !!(res && res.ok);
    appendNdjson(logFile, Object.assign(rec, { argv, ok, error: ok ? null : String((res && res.error) || '') }));
    if (!ok) { results.push({ id, ok: false, error: String((res && res.error) || '') }); continue; }
    const tomb = tombstone(o, id, b, plan.nonce, now);
    results.push({ id, ok: true, tombstone: tomb });
  }
  return { ok: results.every((r) => r.ok), plan: plan.nonce, results, log: logFile };
}

// tombstone — anti-hall side only; NEVER deletes store rows or files.
function tombstone(o, id, b, nonce, now) {
  const out = { marker: false, descriptorArchived: null };
  try {
    const dir = path.join(devswarmDir(o.home), 'pruned');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, prunedAt: now, plan: nonce, branch: b.branchName || null, worktreePath: b.worktreePath || null }));
    out.marker = true;
  } catch (_) {}
  if (typeof o.archiveDescriptor === 'function' && fs.existsSync(path.join(devswarmDir(o.home), 'workspaces', id + '.json'))) {
    try { const r = o.archiveDescriptor(id); out.descriptorArchived = !!(r && r.ok); } catch (_) { out.descriptorArchived = false; }
  }
  return out;
}

module.exports = {
  DEFAULT_SETTINGS, VIEWED_GRACE_MS, PLAN_TTL_MS, UNDO_HINT,
  readSettings, planAutoArchive, autoArchiveSweep, autoArchiveOwns,
  planPrune, executePrune, assertInteractiveCaller, archivedSince, verbArgv,
  notifyPrimary: defaultNotifyPrimary,
};
