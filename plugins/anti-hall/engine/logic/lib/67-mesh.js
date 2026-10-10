// The DevSwarm mesh data API of the check scripts (D88): thin shapes over the raw `ahHost` mesh primitives (src/script/host_mesh.rs).
// They carry no rule. Every answer the engine cannot give exactly is `{unsure: true}` in the host; here it becomes a throw of the
// `meshDefer` token, which a script's entry catches and turns into a deferral to the Node hook (D11).
'use strict';
var meshDefer = { meshDefer: true };
function meshNeed(r) {
  var v = JSON.parse(r);
  if (v === null || v.unsure) throw meshDefer;
  return v;
}
ah.mesh = {
  // {top, own, key}: the work tree around `cwd`, this Primary's partition id and its project key (each null when there is none).
  ident: function (cwd) { return meshNeed(ahHost.meshIdent(cwd)); },
  // The project key of a work tree (null when it has none).
  repoKey: function (wt) { return meshNeed(ahHost.meshRepoKey(wt)).key; },
  // The canonical mesh id of a work tree (null when it has none).
  canonicalId: function (wt) { return meshNeed(ahHost.meshCanonicalId(wt)).id; },
  // The project an id is registered under, from its descriptor.
  registeredKey: function (desc, id) { return meshNeed(ahHost.meshRegisteredKey(JSON.stringify(desc), id)).key; },
  // {state: 'none'} (no store file) or {state: 'ok', count}.
  messageCount: function (key, id) { return meshNeed(ahHost.meshMessageCount(key, id)); },
  // {state: 'none'} or {state: 'ok', storeOnly: [row], age}: the store rows no inbox line covers, the age in ms of the oldest unread row (null: none).
  union: function (key, id, inbox, cursor, own, now) { return meshNeed(ahHost.meshUnion(key, id, inbox, cursor, !!own, now)); },
  // {verdict: true | false | null, cache}: the app database's archive verdict; with `cache` a cache write is owed (performCache).
  appArchived: function (id, wt, cache) { return meshNeed(ahHost.meshAppArchived(id, wt, !!cache)); },
  // Perform every cache write this call's lookups owe.
  performCache: function () { ahHost.meshPerformCache(); },
  sessionAlive: function (session) { return meshNeed(ahHost.meshSessionAlive(session)).alive; },
  // {none: true} (no transcript to read) or {busy, waiting, question}.
  childBusy: function (id, wt, session, now, freshMs) { return meshNeed(ahHost.meshChildBusy(id, wt, session, now, freshMs)); },
};
// Whether the setting described by defaults entry `key` has a value anywhere in its chain (environment, plugin option, settings file).
ah.settings.touched = function (key) { return ahHost.settingTouched(key); };
