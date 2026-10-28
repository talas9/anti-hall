// The DevSwarm mesh data API of the check scripts (D88): thin shapes over the raw `ahHost` mesh primitives (src/script/host_mesh.rs).
// They carry no rule. An answer the engine cannot give exactly is `{unsure: true}` in the host; here it is counted (native_unable at
// mesh:<call>) and becomes the call's stated stand-in, never a throw and never a hand-back to Node. Every stand-in leans the way the
// callers' block decisions lean: an unreadable count is unknown (`known: false`, which the gates block on), an unreadable partition or
// own reader is stale, a session of unknown liveness is alive, a project that cannot be resolved has no key. A stand-in object carries
// `unsure: true` so a caller that must not read it as an answer can tell.
'use strict';
function meshNeed(name, r, standIn) {
  var v = JSON.parse(r);
  if (v === null || v.unsure) { ah.unable('mesh:' + name); return standIn; }
  return v;
}
ah.mesh = {
  // {top, own, key}: the work tree around `cwd`, this Primary's partition id and its project key (each null when there is none).
  ident: function (cwd) { return meshNeed('ident', ahHost.meshIdent(cwd), { top: null, own: null, key: null, unsure: true }); },
  // The project key of a work tree (null when it has none).
  repoKey: function (wt) { return ah.mesh.repoKeyDetail(wt).key; },
  // {key, unsure}: `unsure` is true when the key is a stand-in (null) for a project the host could not resolve.
  repoKeyDetail: function (wt) { return meshNeed('repo_key', ahHost.meshRepoKey(wt), { key: null, unsure: true }); },
  // The canonical mesh id of a work tree (null when it has none).
  canonicalId: function (wt) { return meshNeed('canonical_id', ahHost.meshCanonicalId(wt), { id: null, unsure: true }).id; },
  // The project an id is registered under, from its descriptor.
  registeredKey: function (desc, id) { return meshNeed('registered_key', ahHost.meshRegisteredKey(JSON.stringify(desc), id), { key: null, unsure: true }).key; },
  // {state: 'none'} (no store file) or {state: 'ok', count}.
  messageCount: function (key, id) { return meshNeed('message_count', ahHost.meshMessageCount(key, id), { state: 'none', unsure: true }); },
  // {state: 'none'} or {state: 'ok', storeOnly: [row], age}: the store rows no inbox line covers, the age in ms of the oldest unread row (null: none).
  union: function (key, id, inbox, cursor, own, now) { return meshNeed('store_union', ahHost.meshUnion(key, id, inbox, cursor, !!own, now), { state: 'unsure', unsure: true }); },
  // This hook's own reader on a partition: {reader: false} (no reader key), {reader: true, state: 'none'} (no store) or
  // {reader: true, state: 'ok', own} (own: its store row's value, null when it has none); with `count` and a row, also unread, total.
  ownReader: function (key, id, inbox, cursor, count, now) { return meshNeed('own_reader', ahHost.meshOwnReader(key, id, inbox, cursor, !!count, now), { reader: true, state: 'unsure', own: null, unsure: true }); },
  // The reader nonce of the hook that sent the request (deriveReaderNonce), null for a headless caller.
  readerNonce: function () { return meshNeed('reader_nonce', ahHost.meshReaderNonce(), { nonce: null, unsure: true }).nonce; },
  // A child's own unread mail (openStoreForUnread + countFor with its own reader, else readUnread): {state: 'nd', unread, known}
  // (no key or no store) or {state: 'ok', unread, known, age}.
  countFor: function (key, id, inbox, cursor, now) { return meshNeed('count_for', ahHost.meshCountFor(key, id, inbox, cursor, now), { state: 'nd', unread: 0, known: false, unsure: true }); },
  // The project key of the checkout around `cwd` (resolveContext(cwd, {missingPath: 'ancestor'}).repoKey), null when none.
  contextKey: function (cwd) { return meshNeed('context_key', ahHost.meshContextKey(cwd), { key: null, unsure: true }).key; },
  // {verdict: true | false | null, cache}: the app database's archive verdict; with `cache` a cache write is owed (performCache).
  appArchived: function (id, wt, cache) { return meshNeed('app_archived', ahHost.meshAppArchived(id, wt, !!cache), { verdict: null, cache: null, unsure: true }); },
  // Perform every cache write this call's lookups owe.
  performCache: function () { ahHost.meshPerformCache(); },
  sessionAlive: function (session) { return meshNeed('session_alive', ahHost.meshSessionAlive(session), { alive: true, unsure: true }).alive; },
  // {none: true} (no transcript to read) or {busy, waiting, question}.
  // The Primary seat of the checkout around `cwd` for `session` (companion/lib/primary-seat.js seatVerdict): {state: 'n/a' | 'none' | 'own' |
  // 'adopt' | 'conflict' | 'unknown', id, worktree, holder, handover: {path, sessionId, mtimeMs} | null, stale: {sessionId, activeUntilMs} | null,
  // reason, descriptorPath, evidence}. Read-only.
  seat: function (cwd, session, now) { return meshNeed('seat', ahHost.meshSeat(cwd, session, now), { state: 'unknown', reason: 'unsure', unsure: true }); },
  // `adoptPrimarySeat`: {verdict, adopted}: the seat taken over from a closed holder, or registered for the first time when `real` (a real
  // DevSwarm session). Writes the Primary's descriptor and registry row: call `ah.commit()` first.
  adoptSeat: function (cwd, session, now, real) {
    return meshNeed('adopt_seat', ahHost.meshAdoptSeat(cwd, session, now, !!real), { verdict: { state: 'unknown', reason: 'unsure' }, adopted: false, unsure: true });
  },
  childBusy: function (id, wt, session, now, freshMs) { return meshNeed('child_busy', ahHost.meshChildBusy(id, wt, session, now, freshMs), { none: true, unsure: true }); },
};
// Whether the setting described by defaults entry `key` has a value anywhere in its chain (environment, plugin option, settings file).
ah.settings.touched = function (key) { return ahHost.settingTouched(key); };
