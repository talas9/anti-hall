'use strict';
// Seeds an isolated HOME for the parent-gate parity cases with Node's own identity helpers and store writer.
// usage: node pgate_seed.js <home> <cwd> <mode>
//   ids : print {"key","own"} (the repo key of <cwd> and this Primary's partition id), write nothing
//   own : also write this Primary's own descriptor (no inbox), its summary entry and a store with its registry row
// PG_SUMMARY=question|unread puts a pending question / own unread into the summary entry.
const path = require('path');
const fs = require('fs');
const lib = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'anti-hall', 'companion');
const repokey = require(path.join(lib, 'lib', 'devswarm-repokey.js'));
const inst = require(path.join(lib, 'install-devswarm-ingest.js'));
const identity = require(path.join(lib, 'lib', 'identity.js'));
const [home, cwd, mode] = process.argv.slice(2);
const key = repokey.repoKeyForWorktree(cwd);
const top = identity.resolveContext(cwd, { home, missingPath: 'ancestor' }).worktreeRoot;
const own = inst.primaryWorkspaceId(top);
if (mode === 'own') {
  const store = require(path.join(lib, 'lib', 'devswarm-store.js'));
  const dir = path.join(home, '.anti-hall', 'devswarm');
  const cursorPath = path.join(dir, 'cursors', own + '.json');
  const desc = { id: own, worktreePath: cwd, sessionId: 'sess-own', cursorPath, repoId: 'r1', inboxPath: null, nudgeCommand: null, repoKey: key, ownerKey: key };
  fs.mkdirSync(path.join(dir, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspaces', own + '.json'), JSON.stringify(desc));
  const s = store.openStore({ home, workspaceId: own, hash: key });
  s.upsertRegistry({ id: own, worktreePath: cwd, sessionId: 'sess-own', inboxPath: null, cursorPath, nudgeCommand: null });
  s.close();
  const entry = { id: own, worktreePath: cwd, sessionId: 'sess-own', unread: 0, pendingQuestions: [] };
  if (process.env.PG_SUMMARY === 'question') entry.pendingQuestions = [{ from: 'c-9', ts: 1 }];
  if (process.env.PG_SUMMARY === 'unread') entry.unread = 2;
  fs.mkdirSync(path.join(dir, 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'summaries', key + '.json'), JSON.stringify({ generatedAt: 1, workspaces: { [own]: entry }, recent: [], archivedRegistryRows: [] }));
}
process.stdout.write(JSON.stringify({ key, own }));
