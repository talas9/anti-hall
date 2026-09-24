'use strict';
// anti-hall :: devswarm-app-db — READ-ONLY snapshot of the DevSwarm desktop
// app's own database (v0.107.1 archive state; v0.108.0 full snapshot).
//
// WHY: archive detection used to be "by absence" from `hivecontrol workspace
// list all` (devswarm-archived-cache.js). Measured against a current app build,
// that command returns EVERY builder, archived ones included, with no state
// field — so an archived workspace is never absent and never detected. The
// app's database is the ground truth; an archived builder is
// `isActive = 0 AND isHidden = 1`.
//
// v0.108.0 reads ONE snapshot per process (short cache) of the tables below,
// joined per workspace, and every surface (parent-inbox, roster, identity,
// doctor, the supervisor sync) reads that one snapshot.
//
// FIELD SEMANTICS — proven on a live DB (read-only) and against the app's own
// source (2.5.2) before any decision uses them; the rest are INFORMATIONAL only
// (docs/KB-devswarm-app-db.md):
//   PROVEN  builders.isActive/isHidden   archive = isHidden 1 + isActive 0; close =
//           isActive 0 only (NOT archived); pre-2.3.0 rows carry isActive 0 as
//           "unknown" — hence archived requires isHidden 1. Delete removes the row.
//   PROVEN  builders.label                == hivecontrol `label` (the UI title)
//   PROVEN  builders.rank                 sidebar order within a repo (0 = top)
//   PROVEN  builders.lastSelectedAt       UI focus: stamped on every active-tab change
//   PROVEN  builder_terminals.ai_session_config.sessionId = the live Claude session
//           id (rewritten on /clear, /compact fork when the app's hook reports).
//           Used ONE-WAY: a session id found here runs on that worktree (129/130
//           transcripts' cwd == worktreePath); absence proves nothing.
//   PROVEN  initialPrompt / DeliveredAt / WithheldAt: delivery clears the prompt and
//           stamps DeliveredAt in one write; WithheldAt + prompt = withheld, retried
//           on the next healthy resume. Rows older than the first recorded delivery
//           (pre-2.5.2) are never judged.
//   PROVEN  pull_requests.state / checkStatus (Title Case; 6/6 state and 2/2
//           'Failed' match GitHub; polled every 60 s)
//   INFO    panelStatus (pending = no PTY yet), lastViewedAt (terminal tab
//           switch), lastAccessed (bumped by background writes — NOT focus),
//           isPinned, terminal scrollback mtime/size
//   UNUSED  transcriptByteOffset/LineCount (0 on every live row: ingestion is the
//           app's cloud-analytics pipeline), builder_terminal_transcripts,
//           builder_transcript_prompts (payload bodies), workspace_messages.message
//           (bodies) and .status, pull_requests.title/authorLogin.
//
// CONTRACT
//   - READ-ONLY: node:sqlite `readOnly: true`, a few SELECTs, closed. Never
//     writes, never spawns. Credential tables are never named here. Message
//     bodies and brief text are never selected (only presence/length).
//   - FAIL-OPEN: no node:sqlite, no file, no `builders` table or no id/isActive
//     column -> null ("no opinion"). Any OTHER missing column or table is read
//     as null and listed in `snapshot.missing` ("table.column") so doctor can
//     warn "DevSwarm app schema changed". Nothing here throws.
//   - PATH: ANTIHALL_DEVSWARM_APP_DB overrides (a file path, or `off` to
//     disable). Otherwise the app's per-OS data dir under the CALLER's home:
//       darwin  <home>/Library/Application Support/DevSwarm/devswarm.db
//       linux   $XDG_CONFIG_HOME|<home>/.config /DevSwarm/devswarm.db
//     No home -> null (never falls through to the real user's home).
//   - CACHE: one read per process per APP_DB_CACHE_MS (default 10 s).

const fs = require('fs');
const path = require('path');

// Capability gate (DevSwarm version + runtime detection). Every table and column
// read below asks can('appdb.<table>') / can('appdb.<table>.<column>'); a gated
// read degrades exactly like a missing column (fail-open, listed in `gated`).
let caps = null;
try { caps = require('./devswarm-capabilities.js'); } catch (_) { caps = null; }
function capOk(name, env) {
  if (!caps || typeof caps.can !== 'function') return true;
  try { const r = caps.can(name, { env }); return !!(r && r.ok); } catch (_) { return false; }
}

const DEFAULT_CACHE_MS = 10 * 1000;
const BRIEF_DELIVERY_GRACE_MS = 3 * 60 * 1000;
let memo = null; // { file, at, snap }

// SCHEMA — every column this module reads. Pinned by tests: a fixture carrying
// exactly these columns must produce `missing: []`.
const SCHEMA = {
  builders: ['id', 'repositoryId', 'sourceBranch', 'branchName', 'worktreePath', 'terminalId', 'label', 'createdAt',
    'lastAccessed', 'rank', 'isHidden', 'pullRequestId', 'builderType', 'isPinned', 'isActive', 'lastSelectedAt'],
  builder_terminals: ['id', 'builderId', 'terminalId', 'terminalType', 'aiAgent', 'ai_session_config', 'isActive',
    'panelStatus', 'createdAt', 'lastViewedAt', 'initialPrompt', 'initialPromptDeliveredAt', 'initialPromptWithheldAt'],
  pull_requests: ['id', 'repositoryId', 'branchName', 'number', 'state', 'isDraft', 'url', 'checkStatus', 'reviewStatus', 'lastSyncedAt'],
  repositories: ['id', 'path', 'name', 'defaultBaseBranch'],
  workspace_messages: ['repositoryId', 'toBranch', 'createdAt'],
};
// Columns whose absence makes the snapshot meaningless -> null.
const CORE = { builders: ['id', 'isActive'] };

function appDbPath(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const override = env && typeof env.ANTIHALL_DEVSWARM_APP_DB === 'string' ? env.ANTIHALL_DEVSWARM_APP_DB.trim() : '';
  if (override) return override.toLowerCase() === 'off' ? null : override;
  if (!o.home) return null;
  const platform = o.platform || process.platform;
  if (platform === 'darwin') return path.join(String(o.home), 'Library', 'Application Support', 'DevSwarm', 'devswarm.db');
  if (platform === 'linux') {
    const base = env && env.XDG_CONFIG_HOME ? String(env.XDG_CONFIG_HOME) : path.join(String(o.home), '.config');
    return path.join(base, 'DevSwarm', 'devswarm.db');
  }
  return null;
}

function normPath(p) {
  if (typeof p !== 'string' || !p) return null;
  let r;
  try { r = path.resolve(p); } catch (_) { return p; }
  try { return fs.realpathSync(r); } catch (_) { return r; }
}

function tsMs(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// tableColumns(db, table) -> Set | null (table absent).
function tableColumns(db, table) {
  try {
    const rows = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (!rows.length) return null;
    return new Set(rows.map((c) => String(c.name)));
  } catch (_) { return null; }
}

// selectPresent(db, table, missing, gated, env) -> rows[] with every SCHEMA column
// as a key (null when absent or capability-gated). `initialPrompt` is read as
// presence + length only.
function selectPresent(db, table, missing, gated, env) {
  if (!capOk('appdb.' + table, env)) { gated.push('appdb.' + table); return []; }
  const cols = tableColumns(db, table);
  if (!cols) { missing.push(table + ' (table)'); return []; }
  const exprs = [];
  const nulls = [];
  for (const c of SCHEMA[table]) {
    if (!cols.has(c)) { missing.push(table + '.' + c); nulls.push(c); continue; }
    if (!capOk('appdb.' + table + '.' + c, env)) { gated.push('appdb.' + table + '.' + c); nulls.push(c); continue; }
    if (c === 'initialPrompt') exprs.push('length(initialPrompt) AS initialPromptLen');
    else exprs.push('"' + c + '"');
  }
  if (!exprs.length) return [];
  const rows = db.prepare('SELECT ' + exprs.join(', ') + ' FROM ' + table).all();
  for (const r of rows) for (const c of nulls) r[c === 'initialPrompt' ? 'initialPromptLen' : c] = null;
  return rows;
}

function parseSessionId(raw) {
  if (raw == null) return null;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : null;
  } catch (_) { return null; }
}

// appVersion(dbFile) -> 'DevSwarm@x.y.z' | null, from the app's own crash-report
// session file next to the DB (sentry/session.json `release`). Fail-open.
function appVersion(dbFile) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(dbFile), 'sentry', 'session.json'), 'utf8'));
    return j && typeof j.release === 'string' ? j.release : null;
  } catch (_) { return null; }
}

// scrollbackStat(dbFile, terminalId) -> { mtimeMs, size } | null. The app keeps a
// raw PTY log per open terminal at terminal-scrollback/<terminalId with . -> _>.log.
// Only its mtime/size are read — NEVER its content (raw shell output).
function scrollbackStat(dbFile, terminalId) {
  if (typeof terminalId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(terminalId)) return null;
  try {
    const st = fs.statSync(path.join(path.dirname(dbFile), 'terminal-scrollback', terminalId.replace(/\./g, '_') + '.log'));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (_) { return null; }
}

// readSnapshot(file, opts) -> snapshot | null. See CONTRACT above. opts.env feeds
// the capability gate.
function readSnapshot(file, opts) {
  const env = (opts && opts.env) || process.env;
  if (!capOk('appdb', env)) return null;
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (_) { return null; }
  try { if (!fs.statSync(file).isFile()) return null; } catch (_) { return null; }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const bcols = tableColumns(db, 'builders');
    if (!bcols) return null;
    for (const c of CORE.builders) if (!bcols.has(c) || !capOk('appdb.builders.' + c, env)) return null;
    const missing = [];
    const gated = [];
    const builders = selectPresent(db, 'builders', missing, gated, env);
    const terminals = selectPresent(db, 'builder_terminals', missing, gated, env);
    const prs = selectPresent(db, 'pull_requests', missing, gated, env);
    const repos = selectPresent(db, 'repositories', missing, gated, env);
    // workspace_messages is only schema-checked here (counts are a separate read).
    const wm = tableColumns(db, 'workspace_messages');
    if (!wm) missing.push('workspace_messages (table)');
    else for (const c of SCHEMA.workspace_messages) if (!wm.has(c)) missing.push('workspace_messages.' + c);

    const repoById = new Map();
    const repositories = repos.filter((r) => r && r.id != null).map((r) => {
      const v = { id: String(r.id), path: normPath(r.path), name: r.name == null ? null : String(r.name), defaultBaseBranch: r.defaultBaseBranch == null ? null : String(r.defaultBaseBranch) };
      repoById.set(v.id, v);
      return v;
    });
    const prById = new Map();
    const prByBranch = new Map();
    for (const p of prs) {
      if (!p || p.id == null) continue;
      const v = {
        id: String(p.id), number: p.number == null ? null : Number(p.number), state: p.state == null ? null : String(p.state),
        isDraft: p.isDraft == null ? null : Number(p.isDraft) === 1, url: p.url == null ? null : String(p.url),
        checkStatus: p.checkStatus == null ? null : String(p.checkStatus), reviewStatus: p.reviewStatus == null ? null : String(p.reviewStatus),
        lastSyncedAt: tsMs(p.lastSyncedAt),
      };
      prById.set(v.id, v);
      if (p.repositoryId != null && p.branchName != null) prByBranch.set(String(p.repositoryId) + '\u0000' + String(p.branchName), v);
    }
    // Earliest recorded delivery: before it the app did not record delivery at all.
    let deliveryTrackedSince = null;
    const termsByBuilder = new Map();
    for (const t of terminals) {
      if (!t || t.builderId == null) continue;
      const d = tsMs(t.initialPromptDeliveredAt);
      if (d != null && (deliveryTrackedSince == null || d < deliveryTrackedSince)) deliveryTrackedSince = d;
      const v = {
        id: t.id == null ? null : String(t.id), terminalId: t.terminalId == null ? null : String(t.terminalId),
        terminalType: t.terminalType == null ? null : String(t.terminalType), aiAgent: t.aiAgent == null ? null : String(t.aiAgent),
        sessionId: parseSessionId(t.ai_session_config), isActive: t.isActive == null ? null : Number(t.isActive) === 1,
        panelStatus: t.panelStatus == null ? null : String(t.panelStatus), createdAt: tsMs(t.createdAt), lastViewedAt: tsMs(t.lastViewedAt),
        briefPending: t.initialPromptLen != null && Number(t.initialPromptLen) > 0, briefLen: t.initialPromptLen == null ? null : Number(t.initialPromptLen),
        deliveredAt: d, withheldAt: tsMs(t.initialPromptWithheldAt),
      };
      const k = String(t.builderId);
      if (!termsByBuilder.has(k)) termsByBuilder.set(k, []);
      termsByBuilder.get(k).push(v);
    }
    const hasHidden = bcols.has('isHidden') && capOk('appdb.builders.isHidden', env);
    const workspaces = [];
    for (const b of builders) {
      if (!b || b.id == null) continue;
      const id = String(b.id);
      const active = Number(b.isActive) === 1;
      const archived = Number(b.isActive) === 0 && (!hasHidden || Number(b.isHidden) === 1);
      const repo = b.repositoryId != null ? repoById.get(String(b.repositoryId)) : null;
      const pr = (b.pullRequestId != null && prById.get(String(b.pullRequestId)))
        || (b.repositoryId != null && b.branchName != null && prByBranch.get(String(b.repositoryId) + '\u0000' + String(b.branchName))) || null;
      const terms = termsByBuilder.get(id) || [];
      const aiActive = terms.find((t) => t.terminalType === 'ai' && t.isActive === true) || null;
      workspaces.push({
        id, repositoryId: b.repositoryId == null ? null : String(b.repositoryId),
        repoPath: repo ? repo.path : null, repoName: repo ? repo.name : null,
        label: b.label == null ? null : String(b.label), branchName: b.branchName == null ? null : String(b.branchName),
        sourceBranch: b.sourceBranch == null ? null : String(b.sourceBranch), worktreePath: normPath(b.worktreePath),
        builderType: b.builderType == null ? null : String(b.builderType),
        rank: b.rank == null ? null : Number(b.rank), isPinned: b.isPinned == null ? null : Number(b.isPinned) === 1,
        isHidden: b.isHidden == null ? null : Number(b.isHidden) === 1, active, archived,
        createdAt: tsMs(b.createdAt), lastAccessed: tsMs(b.lastAccessed), lastSelectedAt: tsMs(b.lastSelectedAt),
        pullRequest: pr, terminals: terms,
        sessionId: aiActive ? aiActive.sessionId : null,
        scrollback: active && aiActive && capOk('appfs.terminal-scrollback', env) ? scrollbackStat(file, aiActive.terminalId) : null,
      });
    }
    return {
      ok: true, file, appVersion: capOk('appfs.sentry-session', env) ? appVersion(file) : null, missing, gated, deliveryTrackedSince,
      repositories, workspaces,
    };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

function cacheTtl(env) {
  const raw = Number(env && env.ANTIHALL_DEVSWARM_APP_DB_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_MS;
}

// snapshot(opts) -> snapshot | null (cached per process). opts.fresh bypasses the cache.
function snapshot(opts) {
  const o = opts || {};
  const file = appDbPath(o);
  if (!file) return null;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const ttl = cacheTtl(o.env || process.env);
  if (!o.fresh && memo && memo.file === file && now - memo.at >= 0 && now - memo.at < ttl) return memo.snap;
  const snap = readSnapshot(file, { env: o.env || process.env });
  memo = { file, at: now, snap };
  return snap;
}

// builderStates(opts) -> Map(id -> { archived, active, worktreePath }) | null.
function builderStates(opts) {
  const snap = snapshot(opts);
  if (!snap) return null;
  const map = new Map();
  for (const w of snap.workspaces) map.set(w.id, { active: w.active, archived: w.archived, worktreePath: w.worktreePath });
  return map;
}

// appArchivedVerdict({ home, env, id, worktreePath, now }) -> true | false | null.
//   by id: the app's own record decides (archived -> true, otherwise false);
//   else by worktree: any ACTIVE builder on that worktree -> false; only
//   archived builders there -> true (a twin row sharing an archived worktree);
//   no record either way -> null (no opinion).
function appArchivedVerdict(opts) {
  const o = opts || {};
  try {
    const map = builderStates(o);
    if (!map) return null;
    const id = o.id != null ? String(o.id) : '';
    if (id && map.has(id)) return map.get(id).archived;
    const wt = normPath(o.worktreePath);
    if (!wt) return null;
    let sawArchived = false;
    for (const b of map.values()) {
      if (b.worktreePath !== wt) continue;
      if (b.active || !b.archived) return false;
      sawArchived = true;
    }
    return sawArchived ? true : null;
  } catch (_) { return null; }
}

// workspaceFor(snap, { id, worktreePath }) -> workspace | null. By id first; else
// the ACTIVE builder on that worktree (never an archived twin).
function workspaceFor(snap, q) {
  if (!snap || !q) return null;
  const id = q.id != null ? String(q.id) : '';
  if (id) { const w = snap.workspaces.find((x) => x.id === id); if (w) return w; }
  const wt = normPath(q.worktreePath);
  if (!wt) return null;
  return snap.workspaces.find((x) => x.active && x.worktreePath === wt) || null;
}

// sessionOwner(snap, sessionId) -> { builderId, worktreePath, builderType, repositoryId,
// active, terminalActive } | null. One-way (see header): a hit is authoritative for
// WHICH worktree the session belongs to; a miss proves nothing.
function sessionOwner(snap, sessionId) {
  if (!snap || typeof sessionId !== 'string' || !sessionId) return null;
  for (const w of snap.workspaces) {
    for (const t of w.terminals) {
      if (t.sessionId === sessionId) {
        return { builderId: w.id, worktreePath: w.worktreePath, builderType: w.builderType, repositoryId: w.repositoryId, active: w.active, terminalActive: t.isActive === true };
      }
    }
  }
  return null;
}

// sessionMap(snap) -> { [sessionId]: { builderId, worktreePath, builderType, active, terminalActive } }.
function sessionMap(snap) {
  const out = {};
  if (!snap) return out;
  for (const w of snap.workspaces) {
    for (const t of w.terminals) {
      if (!t.sessionId || t.terminalType !== 'ai') continue;
      out[t.sessionId] = { builderId: w.id, worktreePath: w.worktreePath, builderType: w.builderType, active: w.active, terminalActive: t.isActive === true };
    }
  }
  return out;
}

// briefDelivery(snap, ws, now) -> null | { status: 'pending'|'not-delivered'|'withheld', ageMs }.
// Judges only ai terminals created after the app began recording delivery.
function briefDelivery(snap, ws, now) {
  if (!snap || !ws || !ws.active) return null;
  const since = snap.deliveryTrackedSince;
  const t = Number.isFinite(now) ? now : Date.now();
  for (const term of ws.terminals) {
    if (term.terminalType !== 'ai') continue;
    const ageMs = term.createdAt != null ? t - term.createdAt : null;
    if (!term.briefPending || term.deliveredAt != null) continue;
    if (term.withheldAt != null) return { status: 'withheld', ageMs };
    if (since == null || term.createdAt == null || term.createdAt < since) continue;
    return { status: ageMs != null && ageMs >= BRIEF_DELIVERY_GRACE_MS ? 'not-delivered' : 'pending', ageMs };
  }
  return null;
}

// finishSignal(ws) -> string | null. The app's pull-request record for this
// workspace, e.g. "PR #12 merged" / "PR #12 merged, checks failed". Extra signal
// only — never overrides the explicit completion gates.
function finishSignal(ws) {
  const pr = ws && ws.pullRequest;
  if (!pr || !pr.state) return null;
  let s = 'PR' + (pr.number != null ? ' #' + pr.number : '') + ' ' + pr.state + (pr.isDraft ? ' (draft)' : '');
  if (pr.checkStatus && /fail/i.test(pr.checkStatus)) s += ', checks failed';
  return s;
}

// lastSelected(snap, repositoryId) -> { id, at } | null: the builder the owner
// most recently selected in the app (optionally within one repository).
function lastSelected(snap, repositoryId) {
  if (!snap) return null;
  let best = null;
  for (const w of snap.workspaces) {
    if (repositoryId && w.repositoryId !== repositoryId) continue;
    if (w.lastSelectedAt != null && (!best || w.lastSelectedAt > best.at)) best = { id: w.id, at: w.lastSelectedAt };
  }
  return best;
}

// focusedWorkspaceId(snap, now, windowMs) -> id | null. The builder the owner
// has on screen in the app: the GLOBAL max lastSelectedAt (stamped on every
// active-tab change), and only while that selection is recent (default 2 min —
// a stale selection may mean the owner left the app).
const FOCUS_WINDOW_MS = 2 * 60 * 1000;
function focusedWorkspaceId(snap, now, windowMs) {
  const best = lastSelected(snap, null);
  if (!best) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  const w = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : FOCUS_WINDOW_MS;
  return t - best.at >= 0 && t - best.at <= w ? best.id : null;
}

// repositoryForWorktree(snap, worktreePath) -> repository | null: the repo whose
// path is the worktree, or which owns a builder on that worktree.
function repositoryForWorktree(snap, worktreePath) {
  if (!snap) return null;
  const wt = normPath(worktreePath);
  if (!wt) return null;
  const direct = snap.repositories.find((r) => r.path === wt);
  if (direct) return direct;
  const w = snap.workspaces.find((x) => x.worktreePath === wt && x.repositoryId);
  return w ? (snap.repositories.find((r) => r.id === w.repositoryId) || { id: w.repositoryId, path: null, name: null }) : null;
}

// messageTimestamps(opts) -> Map(repositoryId -> [{ toBranch, createdAtMs }]) | null.
// Counts/ids only: selects repositoryId, toBranch, createdAt — never `message`.
// opts.sinceMs / opts.untilMs bound the window (createdAt is ISO text).
function messageTimestamps(opts) {
  const o = opts || {};
  const file = appDbPath(o);
  if (!file) return null;
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (_) { return null; }
  let db = null;
  try {
    if (!fs.statSync(file).isFile()) return null;
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const env = o.env || process.env;
    if (!capOk('appdb', env) || !capOk('appdb.workspace_messages', env)) return null;
    const cols = tableColumns(db, 'workspace_messages');
    if (!cols || !SCHEMA.workspace_messages.every((c) => cols.has(c) && capOk('appdb.workspace_messages.' + c, env))) return null;
    const since = new Date(Number.isFinite(o.sinceMs) ? o.sinceMs : 0).toISOString();
    const until = new Date(Number.isFinite(o.untilMs) ? o.untilMs : Date.now()).toISOString();
    const rows = db.prepare('SELECT repositoryId, toBranch, createdAt FROM workspace_messages WHERE createdAt >= ? AND createdAt < ?').all(since, until);
    const out = new Map();
    for (const r of rows) {
      const k = r.repositoryId == null ? '' : String(r.repositoryId);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ toBranch: r.toBranch == null ? null : String(r.toBranch), createdAtMs: tsMs(r.createdAt) });
    }
    return out;
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

// scheduledForDeletion(home) -> string[] | null: entry NAMES under the app's
// ~/.devswarm/scheduled-for-deletion/ (report only, never acted on).
function scheduledForDeletion(home, env) {
  if (!home || !capOk('appfs.scheduled-for-deletion', env || process.env)) return null;
  try { return fs.readdirSync(path.join(String(home), '.devswarm', 'scheduled-for-deletion')).filter((n) => !n.startsWith('.')); } catch (_) { return null; }
}

function resetCache() { memo = null; }

module.exports = {
  appDbPath, readSnapshot, snapshot, builderStates, appArchivedVerdict, workspaceFor, sessionOwner, sessionMap,
  briefDelivery, finishSignal, lastSelected, focusedWorkspaceId, repositoryForWorktree, messageTimestamps, scheduledForDeletion,
  resetCache, SCHEMA, DEFAULT_CACHE_MS, BRIEF_DELIVERY_GRACE_MS, FOCUS_WINDOW_MS,
};
