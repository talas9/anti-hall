'use strict';
// Fixture DevSwarm app DB for tests (v0.108.0). Built in a tmpdir with
// node:sqlite — never a copy of a real app DB. `SCHEMA_SQL` carries exactly the
// columns companion/lib/devswarm-app-db.js pins (SCHEMA), so a fixture built
// from it must read back with `missing: []`; `opts.drop` removes columns to
// exercise the fail-open path.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COLS = {
  builders: 'id TEXT PRIMARY KEY, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT',
  builder_terminals: 'id TEXT PRIMARY KEY, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT',
  pull_requests: 'id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT',
  repositories: 'id TEXT PRIMARY KEY, path TEXT, name TEXT, defaultBaseBranch TEXT',
  workspace_messages: 'id TEXT PRIMARY KEY, repositoryId TEXT, fromBranch TEXT, toBranch TEXT, message TEXT, status TEXT, createdAt TEXT',
};

function colsFor(table, drop) {
  const d = new Set((drop || []).filter((x) => x.startsWith(table + '.')).map((x) => x.slice(table.length + 1)));
  return COLS[table].split(', ').filter((c) => !d.has(c.split(' ')[0])).join(', ');
}

// buildAppDb(opts) -> { base, home, env, dbFile, repoPath, wt: {a,b,arch}, iso(ms) }.
//   opts.drop: ['builders.label', 'pull_requests (table)', ...]
//   opts.now:  reference clock (default Date.now())
function buildAppDb(opts) {
  const o = opts || {};
  const sqlite = require('node:sqlite');
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-appdb-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const repoPath = path.join(base, 'repo'); fs.mkdirSync(repoPath);
  const wt = { a: path.join(base, 'wt-a'), b: path.join(base, 'wt-b'), arch: path.join(base, 'wt-arch') };
  for (const p of Object.values(wt)) fs.mkdirSync(p);
  const appDir = path.join(base, 'app'); fs.mkdirSync(appDir);
  const dbFile = path.join(appDir, 'devswarm.db');
  const db = new sqlite.DatabaseSync(dbFile);
  const drop = o.drop || [];
  for (const t of Object.keys(COLS)) {
    if (drop.includes(t + ' (table)')) continue;
    db.exec('CREATE TABLE ' + t + ' (' + colsFor(t, drop) + ')');
  }
  const ins = (t, row) => {
    const cols = new Set(colsFor(t, drop).split(', ').map((c) => c.split(' ')[0]));
    const keys = Object.keys(row).filter((k) => cols.has(k));
    if (!keys.length) return;
    try { db.prepare('INSERT INTO ' + t + ' (' + keys.join(', ') + ') VALUES (' + keys.map(() => '?').join(', ') + ')').run(...keys.map((k) => row[k])); } catch (_) { /* dropped table */ }
  };
  ins('repositories', { id: 'repo-1', path: repoPath, name: 'repo', defaultBaseBranch: 'main' });
  ins('builders', { id: 'b-primary', repositoryId: 'repo-1', branchName: 'main', worktreePath: repoPath, terminalId: '0.p1', label: 'Primary Workspace', createdAt: iso(now - 864e5), lastAccessed: iso(now), rank: 0, isHidden: 0, builderType: 'primary', isPinned: 0, isActive: 1, lastSelectedAt: iso(now - 60e3) });
  ins('builders', { id: 'b-a', repositoryId: 'repo-1', sourceBranch: 'main', branchName: 'feat/a', worktreePath: wt.a, terminalId: '0.ta', label: 'Alpha task with a long full title that is well past sixty characters in length', createdAt: iso(now - 3600e3), lastAccessed: iso(now), rank: 2, isHidden: 0, pullRequestId: 'pr-a', builderType: 'standard', isPinned: 1, isActive: 1, lastSelectedAt: iso(now - 600e3) });
  ins('builders', { id: 'b-b', repositoryId: 'repo-1', sourceBranch: 'main', branchName: 'feat/b', worktreePath: wt.b, terminalId: '0.tb', label: 'Bravo task', createdAt: iso(now - 600e3), lastAccessed: iso(now), rank: 1, isHidden: 0, builderType: 'standard', isPinned: 0, isActive: 1, lastSelectedAt: null });
  ins('builders', { id: 'b-arch', repositoryId: 'repo-1', sourceBranch: 'main', branchName: 'feat/old', worktreePath: wt.arch, terminalId: '0.tx', label: 'Old task', createdAt: iso(now - 30 * 864e5), lastAccessed: iso(now - 20 * 864e5), rank: 9, isHidden: 1, builderType: 'standard', isPinned: 0, isActive: 0 });
  const sc = (sid) => JSON.stringify({ agent: 'claude', version: 1, sessionId: sid });
  ins('builder_terminals', { id: 't-p', builderId: 'b-primary', terminalId: '0.p1', terminalType: 'ai', aiAgent: 'claude', ai_session_config: sc('sess-primary'), isActive: 1, panelStatus: 'resumable', createdAt: iso(now - 864e5), lastViewedAt: iso(now - 864e5), initialPromptDeliveredAt: iso(now - 864e5 + 10e3) });
  ins('builder_terminals', { id: 't-p-old', builderId: 'b-primary', terminalId: '0.p0', terminalType: 'ai', aiAgent: 'claude', ai_session_config: sc('sess-primary-old'), isActive: 0, panelStatus: 'resumable', createdAt: iso(now - 2 * 864e5) });
  // b-a: delivered brief (prompt cleared, DeliveredAt stamped).
  ins('builder_terminals', { id: 't-a', builderId: 'b-a', terminalId: '0.ta', terminalType: 'ai', aiAgent: 'claude', ai_session_config: sc('sess-a'), isActive: 1, panelStatus: 'pending', createdAt: iso(now - 3600e3), lastViewedAt: iso(now - 3600e3), initialPrompt: null, initialPromptDeliveredAt: iso(now - 3600e3 + 12e3) });
  // b-b: brief still pending 10 min after spawn -> not-delivered.
  ins('builder_terminals', { id: 't-b', builderId: 'b-b', terminalId: '0.tb', terminalType: 'ai', aiAgent: 'claude', ai_session_config: sc('sess-b'), isActive: 1, panelStatus: 'pending', createdAt: iso(now - 600e3), lastViewedAt: iso(0), initialPrompt: 'SECRET-BRIEF-TEXT do the bravo thing' });
  ins('builder_terminals', { id: 't-x', builderId: 'b-arch', terminalId: '0.tx', terminalType: 'ai', aiAgent: 'claude', ai_session_config: sc('sess-arch'), isActive: 0, panelStatus: 'new', createdAt: iso(now - 30 * 864e5) });
  ins('pull_requests', { id: 'pr-a', repositoryId: 'repo-1', branchName: 'feat/a', number: 12, state: 'merged', isDraft: 0, url: 'https://example.invalid/pr/12', checkStatus: 'Failed', reviewStatus: 'None', lastSyncedAt: iso(now - 60e3) });
  const msg = (id, toBranch, ms) => ins('workspace_messages', { id, repositoryId: 'repo-1', fromBranch: 'feat/a', toBranch, message: 'SECRET-BODY-' + id, status: 'unread', createdAt: iso(ms) });
  msg('m1', 'main', now - 3 * 3600e3);
  msg('m2', 'main', now - 2 * 3600e3);
  msg('m3', 'feat/b', now - 3600e3);
  msg('m4', 'main', now - 30e3); // in flight (inside the settle window)
  db.close();
  fs.mkdirSync(path.join(appDir, 'sentry'));
  fs.writeFileSync(path.join(appDir, 'sentry', 'session.json'), JSON.stringify({ release: 'DevSwarm@9.9.9', sid: 'x' }));
  fs.mkdirSync(path.join(appDir, 'terminal-scrollback'));
  fs.writeFileSync(path.join(appDir, 'terminal-scrollback', '0_ta.log'), 'x'.repeat(10));
  const env = { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
  return { base, home, env, dbFile, repoPath, wt, now, iso };
}

function rmFixture(f) { try { fs.rmSync(f.base, { recursive: true, force: true }); } catch (_) {} }

module.exports = { buildAppDb, rmFixture, COLS };
