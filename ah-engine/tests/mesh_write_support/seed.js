'use strict';
// D45 stage 2 parity/concurrency fixture: builds a SCRATCH home with one project store written by Node's OWN store code
// (devswarm-store.js), registry rows for the Primary checkout and two children, some directs and broadcasts, and a
// sender alias for the child worktree. Prints {"repoKey", "primaryId", "childMeshId"} as JSON.
// usage: node seed.js <home> <repo-main-worktree> <child-worktree>
const path = require('path');
const fs = require('fs');
const plugin = path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall');
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const identity = require(path.join(plugin, 'companion', 'lib', 'identity.js'));
const [home, main, child] = process.argv.slice(2);
if (!home || home === require('os').userInfo().homedir) { process.stderr.write('refusing: seed needs a scratch home\n'); process.exit(2); }
const mc = identity.resolveContext(main, { memo: false });
const cc = identity.resolveContext(child, { memo: false });
const repoKey = mc.repoKey;
const primaryId = mc.meshId;
const childMeshId = cc.meshId;
const s = store.openStore({ home, hash: repoKey });
s.upsertRegistry({ id: primaryId, worktreePath: mc.worktreeRoot, sessionId: 'sess-primary', inboxPath: null, cursorPath: null, nudgeCommand: null });
s.upsertRegistry({ id: 'child-1', worktreePath: cc.worktreeRoot, sessionId: 'child-1', inboxPath: null, cursorPath: null, nudgeCommand: ['hivecontrol', 'x'] });
s.upsertRegistry({ id: 'child-2', worktreePath: path.join(home, 'gone-worktree'), sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
const t0 = 1790000000000;
let n = 0;
const put = (from, to, type, msg, extra) => {
  const f = Object.assign({ from, to: type === 'direct' ? to : null, type, message: msg, timestamp: t0 + (n++) * 1000, urgency: 'normal', needsReply: false }, extra || {});
  store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
};
put(primaryId, 'child-1', 'direct', 'first task');
put('child-1', primaryId, 'direct', 'a question', { needsReply: true });
put(primaryId, null, 'broadcast', 'hello all');
put('child-1', null, 'broadcast', 'child news\nline two');
put(primaryId, null, 'broadcast', 'third broadcast');
put(childMeshId, null, 'broadcast', 'sent under the child worktree label', { urgency: 'high' });
// summary inputs: questions under the child's meshId (attributed to child-1, collapsed per sender), consecutive identical
// heartbeats (working_on + a collapsed recent[] run), gates with HEAD setters, mail to a row whose worktree is gone
// (staleRegistryPartitions), an archived registry row, a heartbeat file with push state, a Jev-labelled question
put(childMeshId, primaryId, 'direct', 'mesh-id question one', { needsReply: true });
put(childMeshId, primaryId, 'direct', 'mesh-id question two', { needsReply: true, urgency: 'urgent' });
put('child-1', null, 'broadcast', 'working on it', { isHeartbeat: true, urgency: 'low' });
put('child-1', null, 'broadcast', 'working on it', { isHeartbeat: true, urgency: 'low' });
put(primaryId, 'child-2', 'direct', 'to the gone worktree');
put(primaryId, 'child-1', 'direct', 'is the build green?');
s.setGate({ workspaceId: 'child-1', name: 'done', value: true, setBy: 'devswarm-done@abc123', setAt: t0 });
s.setGate({ workspaceId: 'child-1', name: 'merged_verified', value: false, setBy: 'devswarm-merged@def456', setAt: t0 });
s.setGate({ workspaceId: 'child-1', name: 'tests_passed', value: true, setBy: 'x', setAt: t0 });
s.upsertRegistry({ id: 'child-3', worktreePath: path.join(home, 'archived-wt'), sessionId: 'sess-3', inboxPath: null, cursorPath: null, nudgeCommand: null });
s.setBroadcastCursor('child-1', 1);
s.close();
const dsr = path.join(home, '.anti-hall', 'devswarm');
fs.mkdirSync(path.join(dsr, 'archived'), { recursive: true });
fs.writeFileSync(path.join(dsr, 'archived', 'child-3.json'), JSON.stringify({ id: 'child-3' }));
fs.mkdirSync(path.join(dsr, 'heartbeats'), { recursive: true });
fs.writeFileSync(path.join(dsr, 'heartbeats', 'child-1.json'), JSON.stringify({ id: 'child-1', noUpstream: false, unpushed: 2 }));
const jevHash = require('crypto').createHash('sha256').update('is the build green?').digest('hex').slice(0, 32);
fs.mkdirSync(path.join(home, '.anti-hall', 'cache'), { recursive: true });
fs.writeFileSync(path.join(home, '.anti-hall', 'cache', 'jev-triage.json'), JSON.stringify({ [jevHash]: { kind: 'question-needs-answer' } }));
// the child worktree's label already maps to its registered id (so a child send needs no alias write)
const aliasFile = path.join(home, '.anti-hall', 'devswarm', 'sender-aliases.json');
fs.mkdirSync(path.dirname(aliasFile), { recursive: true });
fs.writeFileSync(aliasFile, JSON.stringify({ version: 1, aliases: { [childMeshId]: { to: 'child-1', worktree: cc.worktreeRoot, at: t0 } } }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ repoKey, primaryId, childMeshId }) + '\n');
