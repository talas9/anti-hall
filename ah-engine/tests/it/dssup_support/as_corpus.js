'use strict';
// Golden corpus of the app sync: a realistic DevSwarm desktop-app database (repositories, builders in every state, terminals,
// pull requests, workspace messages), real git repositories with linked worktrees, anti-hall's descriptors / archived markers /
// names cache / earlier app-state, message stores that hold some of the app's messages, session transcripts, scheduled deletions.
//   usage: node as_corpus.js <home> <seed> <nowMs> <scale: small|big>   -> prints {db, repos, builders}
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const plugin = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall');
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(plugin, 'companion', 'lib', 'devswarm-repokey.js'));
const { DatabaseSync } = require('node:sqlite');
const [home, seedArg, nowArg, scale] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: needs a scratch home\n'); process.exit(2); }
const NOW = Number(nowArg);
const BIG = scale === 'big';
let s = Number(seedArg) >>> 0;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hex = (n) => { let o = ''; for (let i = 0; i < n; i++) o += '0123456789abcdef'[ri(0, 15)]; return o; };
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const git = (cwd, ...a) => cp.execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...a], { cwd, stdio: 'pipe' });
const ds = path.join(home, '.anti-hall', 'devswarm');
const appdir = path.join(home, 'appdata', 'DevSwarm');
mk(appdir);
const dbFile = path.join(appdir, 'devswarm.db');

// ---- real git repositories with linked worktrees ----
const repos = [];
const nRepos = BIG ? 3 : 2;
for (let r = 0; r < nRepos; r++) {
  const dir = path.join(home, 'code', `repo${r}`);
  mk(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  repos.push({ id: uuid(), dir, name: `repo${r}`, key: repokey.repoKeyForWorktree(fs.realpathSync(dir)), wts: [] });
}
const nWt = BIG ? 14 : 7;
for (const rp of repos) {
  for (let w = 0; w < nWt; w++) {
    const branch = pick(['feat', 'fix', 'chore']) + '/' + hex(5) + (rnd() < 0.1 ? '/nested' : '');
    const wt = path.join(home, 'code', 'wts', `${rp.name}-w${w}`);
    mk(path.dirname(wt));
    git(rp.dir, 'worktree', 'add', '-q', '-b', branch, wt);
    rp.wts.push({ dir: wt, branch });
  }
}

// ---- the app database ----
const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE repositories (id TEXT PRIMARY KEY, path TEXT, name TEXT, defaultBaseBranch TEXT);
CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
CREATE TABLE pull_requests (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
CREATE TABLE workspace_messages (repositoryId TEXT, toBranch TEXT, createdAt TEXT, message TEXT);`);
const ins = (t, o) => db.prepare(`INSERT INTO ${t} (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`).run(...Object.values(o));
const builders = [];
const sessions = [];
for (const rp of repos) {
  ins('repositories', { id: rp.id, path: rp.dir, name: rp.name, defaultBaseBranch: 'main' });
  ins('builders', { id: uuid(), repositoryId: rp.id, sourceBranch: 'main', branchName: 'main', worktreePath: rp.dir, terminalId: 'p.' + hex(6), label: 'Primary', createdAt: iso(NOW - 90 * DAY), lastAccessed: iso(NOW - 3600e3), rank: 0, isHidden: 0, pullRequestId: null, builderType: 'primary', isPinned: 1, isActive: 1, lastSelectedAt: iso(NOW - 30e3) });
  rp.wts.forEach((w, i) => {
    const state = pick(['active', 'active', 'active', 'archived', 'closed']);
    const id = i % 5 === 3 ? `ws-${hex(6)}` : uuid();
    const prId = rnd() < 0.5 ? uuid() : null;
    const label = rnd() < 0.2 ? w.branch : pick(['Fix the gate', 'Build é日本', 'Review "quoted"', 'Refactor store', 'Ship it']) + ' ' + hex(3);
    const b = { id, repositoryId: rp.id, sourceBranch: 'main', branchName: w.branch, worktreePath: w.dir, terminalId: 't.' + hex(6), label, createdAt: iso(NOW - ri(1, 80) * DAY), lastAccessed: rnd() < 0.2 ? null : iso(NOW - ri(1, 5000) * 60e3), rank: rnd() < 0.15 ? null : ri(1, 30), isHidden: state === 'archived' ? 1 : 0, pullRequestId: prId, builderType: 'standard', isPinned: rnd() < 0.2 ? 1 : 0, isActive: state === 'active' ? 1 : 0, lastSelectedAt: rnd() < 0.3 ? iso(NOW - ri(1, 400) * 60e3) : null };
    ins('builders', b);
    builders.push(Object.assign({ state, repo: rp, wt: w }, b));
    if (prId) ins('pull_requests', { id: prId, repositoryId: rp.id, branchName: w.branch, number: ri(1, 900), state: pick(['open', 'merged', 'closed']), isDraft: ri(0, 1), url: 'https://example.invalid/pr', checkStatus: pick(['Success', 'Failure', 'Pending', null]), reviewStatus: 'none', lastSyncedAt: iso(NOW - ri(1, 3000) * 60e3) });
    // terminals
    for (let t = 0; t < ri(0, 3); t++) {
      const sid = rnd() < 0.85 ? uuid() : null;
      const created = NOW - ri(1, 5000) * 60e3;
      ins('builder_terminals', { id: uuid(), builderId: id, terminalId: `${id.slice(0, 8)}.${t}`, terminalType: rnd() < 0.85 ? 'ai' : 'shell', aiAgent: 'claude', ai_session_config: sid ? JSON.stringify({ sessionId: sid, model: 'x' }) : pick([null, 'not json', '{}']), isActive: rnd() < 0.8 ? 1 : 0, panelStatus: pick(['idle', 'busy', null]), createdAt: iso(created), lastViewedAt: iso(created + 1000), initialPrompt: rnd() < 0.5 ? 'do the thing é' : null, initialPromptDeliveredAt: rnd() < 0.5 ? iso(created + 2000) : null, initialPromptWithheldAt: rnd() < 0.1 ? iso(created + 3000) : null });
      if (sid && state === 'active') sessions.push({ sid, wt: w.dir });
    }
    if (state === 'active') {
      try { mk(path.join(appdir, 'terminal-scrollback')); fs.writeFileSync(path.join(appdir, 'terminal-scrollback', `${id.slice(0, 8)}_0.log`), 'x'.repeat(ri(1, 50))); } catch (_) { /* optional */ }
    }
  });
}
// deliveries tracked since some time
// messages: some matched by the stores below, some for archived targets, some old
const msgs = [];
for (const rp of repos) {
  const live = builders.filter((b) => b.repo === rp && b.state === 'active').map((b) => b.branchName);
  const dead = builders.filter((b) => b.repo === rp && b.state !== 'active').map((b) => b.branchName);
  for (let i = 0; i < ri(5, BIG ? 120 : 30); i++) {
    const age = ri(1, 30 * 24 * 60) * 60e3 + ri(0, 59999);
    const m = { repositoryId: rp.id, toBranch: rnd() < 0.7 && live.length ? pick(live) : (dead.length ? pick(dead) : 'gone/x'), createdAt: iso(NOW - age), message: 'secret body ' + i };
    ins('workspace_messages', m);
    msgs.push({ rp, ts: NOW - age, branch: m.toBranch });
  }
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
// the app's own files beside the database
mk(path.join(appdir, 'sentry'));
fs.writeFileSync(path.join(appdir, 'sentry', 'session.json'), JSON.stringify({ release: 'DevSwarm@2.5.9' }));
mk(path.join(home, '.devswarm', 'scheduled-for-deletion'));
for (let i = 0; i < ri(0, 3); i++) fs.writeFileSync(path.join(home, '.devswarm', 'scheduled-for-deletion', i === 0 ? '.hidden' : `ws-${hex(4)}`), '');

// ---- anti-hall's own state ----
for (const d of ['workspaces', 'archived', 'names', 'cache']) mk(path.join(ds, d));
const writeJ = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const desc = (b) => ({ id: b.id, worktreePath: b.worktreePath, sessionId: 's-' + b.id.slice(0, 6), ownerKey: b.repo.key, repoKey: b.repo.key, registeredAt: NOW - 10 * DAY });
let nDesc = 0;
let forcedRetire = false;
for (const b of builders) {
  const r = rnd();
  if (r < 0.75) { writeJ(path.join(ds, 'workspaces', b.id + '.json'), desc(b)); nDesc++; }
  if (b.state === 'active') {
    const q = rnd();
    if (q < 0.3 || (!forcedRetire && b === builders.find((x) => x.state === 'active'))) { forcedRetire = true; // an app-sourced marker, old: the app shows it open -> retire (restore) candidate
      writeJ(path.join(ds, 'archived', b.id + '.json'), Object.assign(desc(b), { archivedBy: pick(['devswarm-app', 'devswarm-ui-sync', 'devswarm-app-deleted']), archivedAt: NOW - ri(11, 600) * 60e3 }));
      if (rnd() < 0.5) try { fs.unlinkSync(path.join(ds, 'workspaces', b.id + '.json')); } catch (_) { /* absent */ }
    } else if (q < 0.4) { // too young to retire
      writeJ(path.join(ds, 'archived', b.id + '.json'), Object.assign(desc(b), { archivedBy: 'devswarm-app', archivedAt: NOW - ri(1, 9) * 60e3 }));
    } else if (q < 0.5) { // anti-hall's own archive: held, reported
      writeJ(path.join(ds, 'archived', b.id + '.json'), Object.assign(desc(b), { archivedAt: NOW - 5 * DAY }));
    } else if (q < 0.55) { // a marker of a reused id on another worktree
      writeJ(path.join(ds, 'archived', b.id + '.json'), Object.assign(desc(b), { worktreePath: '/elsewhere/not-this', archivedBy: 'devswarm-app', archivedAt: NOW - 3 * DAY }));
    }
  }
  if (rnd() < 0.5) writeJ(path.join(ds, 'names', b.id + '.json'), { name: rnd() < 0.5 ? b.label : 'stale name ' + hex(3), updatedAt: NOW - DAY });
}
// descriptors the app never heard of, and a deleted-in-app builder (a UUID id with no row and no active builder on its worktree)
writeJ(path.join(ds, 'workspaces', uuid() + '.json'), { id: 'x', worktreePath: '/gone/worktree', ownerKey: repos[0].key });
{ const id = uuid(); writeJ(path.join(ds, 'workspaces', id + '.json'), { id, worktreePath: '/gone/other', ownerKey: repos[0].key, sessionId: 's-del' }); }
writeJ(path.join(ds, 'workspaces', 'slug-workspace.json'), { id: 'slug-workspace', worktreePath: '/gone/slug', ownerKey: repos[0].key });
// two descriptors on the SAME worktree as an archived builder (a twin row)
const arch = builders.find((b) => b.state === 'archived');
if (arch) writeJ(path.join(ds, 'workspaces', 'twin-of-archived.json'), { id: 'twin-of-archived', worktreePath: arch.worktreePath, ownerKey: arch.repo.key });
fs.writeFileSync(path.join(ds, 'workspaces', 'torn.json'), '{"id": "torn", ');
fs.writeFileSync(path.join(ds, 'workspaces', 'array.json'), '[1,2]');
// the message stores: each repo's store holds some of the app's messages, ingested with native: hashes
for (const rp of repos) {
  const st = store.openStore({ home, hash: rp.key });
  const mine = msgs.filter((m) => m.rp === rp);
  let first = true;
  for (const m of mine) {
    if (rnd() < 0.55) continue;
    if (first && rnd() < 0.5) { first = false; continue; }
    st.appendMeshRow({ workspaceId: 'ws-ingest', ts: m.ts, hash: 'native:' + hex(16), body: 'x', sender: 'app', recipient: 'ws-ingest', mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: false });
  }
  st.close();
}
// transcripts of some sessions (their first recorded cwd)
const enc = (p) => String(p).replace(/[/\\:.]/g, '-');
for (const x of sessions) {
  if (rnd() < 0.6) {
    const dir = path.join(home, '.claude', 'projects', enc(x.wt));
    mk(dir);
    fs.writeFileSync(path.join(dir, x.sid + '.jsonl'), JSON.stringify({ type: 'user', cwd: rnd() < 0.85 ? x.wt : '/other/place', message: 'é' }) + '\n');
  }
}
// an earlier app-state: gaps fresh in some corpora, stale in others
if (rnd() < 0.5) writeJ(path.join(ds, 'app-state.json'), { v: 1, at: NOW - 60e3, ok: true, gaps: { at: NOW - 60e3, repos: [{ repositoryId: 'old', name: 'old', repoKey: null, app: 1, matched: 0, archivedTarget: 0, preIngest: 0, gap: 3, byBranch: {} }] } });
else if (rnd() < 0.5) writeJ(path.join(ds, 'app-state.json'), { v: 1, at: NOW - 3600e3, ok: true, gaps: { at: NOW - 3600e3, repos: [] } });
process.stdout.write(JSON.stringify({ db: dbFile, repos: repos.length, builders: builders.length, descriptors: nDesc }));
