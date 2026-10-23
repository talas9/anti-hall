// check = "devswarm-act" (the DevSwarm action layer, src/dsact). Pure DECISION logic: given the facts the engine just read from live
// state, say whether an action may run, why not, its idempotency key and its argv. It spawns nothing and reads nothing; the engine
// re-gathers the facts right before it acts and calls this again. Mirrors companion/lib/devswarm-lifecycle.js (evaluateCandidate,
// evaluateArchived, executePrune), companion/lib/recovery.js (pokeOrEscalate), scripts/devswarm-lib/archive.js (appBuilderGate) and
// scripts/devswarm-lib/spawn.js (create, merge). The answer travels as the `out` text of an `exact` verdict (JSON).
// Keys: devswarm_act.toml.
'use strict';

function dsFill(tpl, vars) {
  var out = [];
  for (var i = 0; i < tpl.length; i++) {
    var t = tpl[i];
    for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) t = t.split('{' + k + '}').join(String(vars[k]));
    out.push(t);
  }
  return out;
}

function dsHas(list, x) { return Array.isArray(list) && list.indexOf(x) >= 0; }
function dsStr(v) { return v === null || v === undefined ? '' : String(v); }
function dsTrim(v) { return dsStr(v).trim(); }

function dsBlock(gate, detail) { return { gate: gate, detail: detail }; }

// Gates a-h of lifecycle.js evaluateCandidate, in Node's order, from facts the engine derived with the same rules.
function dsAutoArchive(p) {
  var f = p.facts || {}, s = p.settings || {}, now = p.now, b = [];
  var id = dsStr(f.id);
  if (f.isPrimary !== false) b.push(dsBlock('e-primary', 'Primary workspace'));
  var done = f.done || {};
  if (done.done !== true) {
    var d = done.via === 'stale-head'
      ? 'done reported at ' + dsStr(done.doneHead).slice(0, 12) + ' but HEAD is now ' + (f.head ? dsStr(f.head).slice(0, 12) : 'unresolvable') + ' — run done again'
      : (f.hasSummary === false ? 'no mesh summary' : 'no done-report (done gate unset) and finish gates not all set');
    b.push(dsBlock('a-done', d));
  }
  var m = f.merged || {};
  if (m.merged !== true) b.push(dsBlock('b-merged', dsStr(m.via)));
  if (f.clean !== true) b.push(dsBlock('c-clean', dsStr(f.cleanReason)));
  var un = f.unread || {};
  if (un.toChild !== 0 || un.fromChild !== 0) {
    b.push(dsBlock('d-unread', 'to_direct=' + un.toDirect + ' to_broadcast=' + un.toBroadcast + ' from=' + un.fromChild));
  }
  if (f.hasLastSelected !== true) {
    b.push(dsBlock('f-viewed', 'lastSelectedAt unavailable'));
  } else if (f.lastSelectedAt !== null && f.lastSelectedAt !== undefined) {
    var t = f.lastSelectedAt;
    if (typeof t !== 'number' || t !== t || now - t < s.viewedGraceMs) {
      b.push(dsBlock('f-viewed', 'selected ' + (typeof t === 'number' && t === t ? Math.round((now - t) / 60000) + 'm ago' : 'at unknown time')));
    }
  }
  var idle = f.idle || {};
  var idleMin = (typeof idle.ts === 'number') ? Math.floor((now - idle.ts) / 60000) : null;
  if (idle.pendingBackground) b.push(dsBlock('g-idle', 'background work the child launched (agent/Bash) has not reported completion'));
  else if (idle.openRealTurn) b.push(dsBlock('g-idle', 'an AI turn doing real work is still open'));
  else if (typeof idle.ts !== 'number' || now - idle.ts < s.idleMin * 60000) {
    b.push(dsBlock('g-idle', typeof idle.ts !== 'number' ? 'no activity signal' : 'active ' + idleMin + 'm ago' + (idle.via === 'real-work' ? ' (real work)' : '')));
  }
  var key = 'auto-archive:' + id + ':' + dsStr(f.head);
  if (f.head && dsHas(p.ledgerKeys, key)) {
    b.push(dsBlock('h-rearchive', 'auto-archived at ' + dsStr(f.head).slice(0, 12) + ' and unarchived since — never re-archived at the same HEAD; a new done at a new HEAD re-enables'));
  }
  var soft = b.length > 0 && b.every(function (x) { return x.gate === 'g-idle' || x.gate === 'f-viewed'; });
  var out = { eligible: b.length === 0, soft: soft, blockers: b, key: key, idleMin: idleMin };
  var idOk = id !== '' && id.charAt(0) !== '-';
  if (!idOk) { out.eligible = false; out.blockers.push(dsBlock('no-workspace-id', 'no explicit workspace id')); }
  if (out.eligible) {
    out.argv = dsFill(ah.cfg('devswarm_act.argv_archive'), { id: id });
    out.cwd = f.primaryCwd || f.worktreePath || null;
    out.verb = 'archive';
    out.notice = 'auto-archived "' + (f.label || f.branch || id) + '" (' + id + ') — done, merged (' + dsStr(m.via) + '), clean, no unread, idle '
      + idleMin + 'm. ' + ah.cfg('devswarm_act.undo_hint') + '.';
  }
  return out;
}

// scripts/devswarm-lib/archive.js appBuilderGate + hcArchiveCall.
function dsArchive(p) {
  var f = p.facts || {}, r = p.request || {}, id = dsTrim(r.id), b = [];
  if (id === '' || id.charAt(0) === '-') b.push(dsBlock('no-workspace-id', 'refusing to call hivecontrol with an empty ref'));
  else if (/^primary-/i.test(id)) b.push(dsBlock('label-id', 'primary-<hash> label id is never passed to hivecontrol'));
  else if (f.appReadable !== true) b.push(dsBlock('app-db', 'app DB unreadable — cannot confirm the builder'));
  else if (f.found !== true) b.push(dsBlock('no-builder', 'no app builder with this exact id'));
  else {
    var bt = dsTrim(f.builderType).toLowerCase();
    if (bt === '') b.push(dsBlock('builder-type', 'app builderType unknown'));
    else if (bt === 'primary') b.push(dsBlock('primary', 'primary builder'));
    else if (f.archived === true) b.push(dsBlock('already-archived', 'app builder is already archived'));
  }
  if (dsTrim(r.request) === '') b.push(dsBlock('no-request-id', 'an owner request carries its own id'));
  var out = { eligible: b.length === 0, blockers: b, key: 'archive:' + id + ':' + dsTrim(r.request) };
  if (out.eligible) { out.argv = dsFill(ah.cfg('devswarm_act.argv_archive'), { id: id }); out.cwd = f.cwd || null; out.verb = 'archive'; }
  return out;
}

// scripts/devswarm-lib/spawn.js cmdSpawn.
function dsCreate(p) {
  var f = p.facts || {}, r = p.request || {}, b = [];
  var rest = Array.isArray(r.rest) ? r.rest : [];
  var branch = dsTrim(rest[0]);
  if (branch === '') b.push(dsBlock('no-branch', 'spawn requires a branch name'));
  if (f.sourceCheck && f.sourceCheck.refuse === true) b.push(dsBlock('source-check', dsStr(f.sourceCheck.error)));
  if (dsTrim(r.request) === '') b.push(dsBlock('no-request-id', 'an owner request carries its own id'));
  var out = { eligible: b.length === 0, blockers: b, key: 'create:' + branch + ':' + dsTrim(r.request) };
  if (out.eligible) {
    var strip = ah.cfg('devswarm_act.create_strip');
    out.argv = ah.cfg('devswarm_act.argv_create').concat(rest.filter(function (a) { return !dsHas(strip, a); }));
    out.cwd = r.cwd || null;
    out.verb = 'create';
    out.title = r.title ? dsFill(ah.cfg('devswarm_act.argv_title'), { branch: branch, title: r.title }) : null;
  }
  return out;
}

// scripts/devswarm-lib/spawn.js cmdMergeVerb: check-merge first (informational), then merge-into-source with the owner's arguments.
function dsMerge(p) {
  var r = p.request || {}, b = [];
  if (dsTrim(r.request) === '') b.push(dsBlock('no-request-id', 'an owner request carries its own id'));
  if (dsTrim(r.cwd) === '') b.push(dsBlock('no-cwd', 'a merge runs in the workspace being merged'));
  var out = { eligible: b.length === 0, blockers: b, key: 'merge:' + dsTrim(r.cwd) + ':' + dsTrim(r.request) };
  if (out.eligible) {
    out.argv = ah.cfg('devswarm_act.argv_merge').concat(Array.isArray(r.rest) ? r.rest : []);
    out.pre = ah.cfg('devswarm_act.argv_check_merge');
    out.cwd = r.cwd;
    out.verb = 'merge-into-source';
  }
  return out;
}

// lifecycle.js executePrune: the per-row re-verification right before a delete. The plan, its nonce, its age and the id match are
// checked by the engine; this is the live-state half.
function dsDelete(p) {
  var f = p.facts || {}, r = p.request || {}, id = dsTrim(r.id), b = [];
  if (id === '' || id.charAt(0) === '-') b.push(dsBlock('no-workspace-id', 'no explicit workspace id'));
  else if (f.appReadable !== true) b.push(dsBlock('app-db', 'DevSwarm app database unavailable'));
  else if (f.found !== true) b.push(dsBlock('builder-not-found', 'builder-not-found'));
  else if (f.archived !== true) b.push(dsBlock('no-longer-archived', 'no-longer-archived'));
  else if (f.isPrimary !== false) b.push(dsBlock('primary', 'primary'));
  else if (f.clean !== true) b.push(dsBlock('unclean', dsStr(f.cleanReason) || 'unclean'));
  var out = { eligible: b.length === 0, blockers: b, key: 'delete:' + id + ':' + dsTrim(r.nonce) };
  if (out.eligible) { out.argv = dsFill(ah.cfg('devswarm_act.argv_delete'), { id: id }); out.cwd = f.primaryCwd || r.cwd || null; out.verb = 'delete'; }
  return out;
}

// recovery.js pokeOrEscalate: poke while attempts remain and the cooldown has passed, otherwise escalate once (terminal).
function dsPokeOrEscalate(p) {
  var f = p.facts || {}, s = p.settings || {}, now = p.now, id = dsStr(f.id), b = [];
  if (id === '') b.push(dsBlock('no-workspace-id', 'no workspace id'));
  if (f.status !== 'stale' && f.status !== 'escalated') b.push(dsBlock('not-stale', dsStr(f.status)));
  var attempts = typeof f.nudgeAttempts === 'number' ? f.nudgeAttempts : 0;
  var cooled = typeof f.nudgedAt !== 'number' || (now - f.nudgedAt) >= s.nudgeCooldownSec * 1000;
  var canPoke = Array.isArray(f.nudgeArgv) && f.nudgeArgv.length > 0 && attempts < s.nudgeMaxAttempts && cooled;
  var out = { eligible: false, blockers: b };
  if (b.length) return out;
  if (f.status === 'stale' && canPoke) {
    out.eligible = true; out.kind = 'poke'; out.key = 'poke:' + id + ':' + (attempts + 1); out.argv = f.nudgeArgv; out.verb = 'poke';
    out.attempt = attempts + 1;
  } else if (f.status === 'stale') {
    out.eligible = true; out.kind = 'escalate'; out.key = 'escalate:' + id;
    out.argv = Array.isArray(f.escalateArgv) && f.escalateArgv.length ? f.escalateArgv : null; out.verb = 'escalate';
  } else {
    out.blockers.push(dsBlock('already-escalated', 'escalated is terminal'));
  }
  return out;
}

// Feature 2: the "done but open" nag. Pure decision from the facts the engine just read plus the nag state it keeps. A workspace is
// done when everything in settings.doneRequires holds, it is clean, has no unread mail and is past idleMin. The first nag at a HEAD is
// the edge; later ones are digests every nagEveryMs. The auto-archive owner (p.owned) is never nagged: it will archive the workspace.
function dsNag(p) {
  var f = p.facts || {}, s = p.settings || {}, n = p.nag || {}, now = p.now, b = [];
  var id = dsStr(f.id);
  if (f.lifecycle !== 'active') b.push(dsBlock('not-active', dsStr(f.lifecycle)));
  if (p.owned === true) b.push(dsBlock('auto-archive-owns', 'auto-archive will archive it'));
  var req = s.doneRequires || [];
  if (dsHas(req, 'merged') && !(f.merged && f.merged.merged === true)) b.push(dsBlock('merged', dsStr((f.merged || {}).via)));
  if (dsHas(req, 'pushed') && f.pushed !== true) b.push(dsBlock('pushed', 'branch not pushed'));
  if (dsHas(req, 'validated') && !(f.done && f.done.done === true)) b.push(dsBlock('validated', 'no done report bound to HEAD'));
  if (f.clean !== true) b.push(dsBlock('clean', dsStr(f.cleanReason)));
  var un = f.unread || {};
  if (un.toChild !== 0 || un.fromChild !== 0) b.push(dsBlock('unread', 'to_direct=' + un.toDirect + ' to_broadcast=' + un.toBroadcast + ' from=' + un.fromChild));
  var idle = f.idle || {};
  var idleMin = (typeof idle.ts === 'number') ? Math.floor((now - idle.ts) / 60000) : null;
  if (idle.pendingBackground || idle.openRealTurn || typeof idle.ts !== 'number' || now - idle.ts < s.idleMin * 60000) b.push(dsBlock('idle', 'not idle'));
  var out = { eligible: false, blockers: b, id: id, head: f.head || null };
  if (b.length > 0 || id === '') return out;
  var edge = n.lastHead !== f.head;
  if (!edge && !(typeof n.lastNagMs === 'number' && now - n.lastNagMs >= s.nagEveryMs)) { out.blockers.push(dsBlock('cadence', 'not due')); return out; }
  var bucket = edge ? 'edge' : String(Math.floor(now / s.nagEveryMs));
  out.edge = edge;
  out.key = 'nag:' + id + ':' + dsStr(f.head) + ':' + bucket;
  if ((n.hourCount || 0) >= s.nagHourlyCap) { out.blockers.push(dsBlock('hourly-cap', n.hourCount + ' nags in the last hour')); return out; }
  out.eligible = true;
  var vars = { label: f.label || f.branch || id, id: id, via: dsStr((f.merged || {}).via), idle: idleMin, hint: dsFill([ah.cfg('devswarm_act.nag_hint')], { id: id })[0] };
  out.text = dsFill([ah.cfg(edge ? 'devswarm_act.nag_edge_text' : 'devswarm_act.nag_digest_text')], vars)[0];
  return out;
}

function decide(p, opts, event) {
  var kind = p && p.kind, res;
  if (kind === 'auto-archive') res = dsAutoArchive(p);
  else if (kind === 'archive') res = dsArchive(p);
  else if (kind === 'create') res = dsCreate(p);
  else if (kind === 'merge') res = dsMerge(p);
  else if (kind === 'delete') res = dsDelete(p);
  else if (kind === 'nag') res = dsNag(p);
  else if (kind === 'poke' || kind === 'escalate' || kind === 'poke-or-escalate') res = dsPokeOrEscalate(p);
  else res = { eligible: false, blockers: [dsBlock('unknown-kind', dsStr(kind))] };
  return { exact: { code: 0, out: JSON.stringify(res), err: '' } };
}
